'use strict';

const { EventEmitter } = require('events');
const { composeFinalAnswer } = require('../llm/finalAnswerComposer');
const { classifyDeliberation } = require('./deliberationPolicy');
const { summarizeEvidenceBundle } = require('./evidenceBundle');
const { evaluateAutonomy } = require('./autonomyGovernor');
const { normalizeExecutionProfile } = require('./executionProfiles');

const MAX_STEPS = 6;
const MAX_TOOL_ERRORS = 2;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_PARALLEL_TOOLS = 3;
const PARALLEL_SAFE_TOOLS = new Set([
  'workspace_read_file',
  'workspace_list_files',
  'web_open',
  'connector_read_resource',
  'shell_inspect',
]);

class TurnOrchestrator extends EventEmitter {
  constructor({
    modelRouter,
    toolRuntime,
    traceStore,
    artifactStore = null,
  } = {}) {
    super();
    this._modelRouter = modelRouter;
    this._toolRuntime = toolRuntime;
    this._traceStore = traceStore;
    this._artifactStore = artifactStore;
  }

  async runTurn({
    providers,
    policy,
    messages = [],
    actor = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent = null,
    onToken = null,
    signal = null,
  } = {}) {
    const emit = (type, payload = {}) => {
      const event = { type, ...payload };
      this.emit(type, event);
      if (typeof onEvent === 'function') onEvent(event);
    };

    const lane = String(policy?.lane || inferLaneFromIntent(policy?.intent)).toLowerCase();
    if (lane !== 'operation') {
      return runLightweightTurn.call(this, {
        providers,
        policy: {
          ...policy,
          lane,
        },
        messages,
        actor,
        timeoutMs,
        onToken,
        signal,
        emit,
      });
    }

    const executionProfile = normalizeExecutionProfile(policy.executionProfile || policy.profile);
    const deliberation = classifyDeliberation({ policy, messages });
    const toolLoop = shouldUseToolLoop(policy, messages, deliberation);
    const turn = this._traceStore.createTurn({
      mode: policy.mode,
      profile: executionProfile.id,
      lane,
      intent: policy.intent,
      responseStyle: policy.responseStyle,
      role: policy.role,
      userText: policy.userText,
      toolLoop,
      summary: buildTurnSummary(policy),
      deliberation,
      ui: policy.ui,
      actor,
    });
    this._traceStore.updateDeliberation(turn.id, deliberation);
    emit('trace_start', {
      turnId: turn.id,
      toolLoop,
      lane,
      intent: policy.intent,
      responseStyle: policy.responseStyle || null,
      role: policy.role,
      mode: policy.mode,
      profile: executionProfile.id,
      ui: policy.ui || null,
    });
    emit('trace_deliberation', {
      turnId: turn.id,
      deliberation,
    });
    const syncGovernor = (pendingDecision = null) => {
      const trace = this._traceStore.getTurn(turn.id);
      const governorState = evaluateAutonomy({
        policy,
        deliberation,
        evidenceBundle: trace?.evidenceBundle || null,
        trace,
        pendingDecision,
      });
      this._traceStore.updateGovernor(turn.id, governorState);
      emit('trace_governor', {
        turnId: turn.id,
        governor: governorState,
      });
      return governorState;
    };
    let governor = syncGovernor();

    const deadline = Date.now() + timeoutMs;
    const maxSteps = Math.max(2, Number(executionProfile.maxSteps || MAX_STEPS));
    let toolErrors = 0;
    let usedTools = false;
    let finalAnswer = '';
    let finalProvider = null;
    let finalModel = null;
    let nextStepNumber = 1;
    let forcedInspectPasses = 0;
    let forcedVerifyPasses = 0;

    const updatePlanState = (patch = {}) => {
      const plan = this._traceStore.updatePlan(turn.id, patch);
      emit('trace_plan_state', {
        turnId: turn.id,
        plan,
      });
      return plan;
    };

    updatePlanState({
      phase: deliberation.initialPhase || (toolLoop ? 'planning' : 'direct_reply'),
      nextAction: toolLoop ? 'select initial tool strategy' : 'compose direct answer',
      totalUnits: toolLoop ? maxSteps : 1,
      completedUnits: 0,
      risk: deliberation.risk,
      evidenceDemand: deliberation.evidenceDemand,
      autonomyAllowance: deliberation.autonomyAllowance,
      executionProfile: executionProfile.id,
      approvalRequired: governor.shouldPauseForApproval,
    });
    this._traceStore.updateVerification(turn.id, {
      required: Boolean(deliberation.needsVerification),
      performed: false,
      status: deliberation.needsVerification ? 'pending' : 'not_required',
      notes: [],
    });

    try {
      if (deliberation.askUserFirst) {
        finalAnswer = buildClarifyingQuestion(policy, deliberation);
        finalProvider = 'policy';
        finalModel = 'deliberation';
        updatePlanState({
          phase: 'ask',
          nextAction: 'wait for user clarification',
          confidence: 0.35,
          completedUnits: 1,
        });
      } else if (!toolLoop) {
        const direct = await this._modelRouter.call({
          role: policy.role,
          system: policy.system,
          prompt: flattenMessages(messages),
          apiKey: providers,
          stream: Boolean(onToken),
          onToken,
          signal,
        });
        finalAnswer = composeFinalAnswer({
          text: direct.text || '',
          policy,
          usedTools: false,
        });
        finalProvider = direct.provider;
        finalModel = direct.model;
        updatePlanState({
          phase: 'responding',
          completedUnits: 1,
          nextAction: 'final answer ready',
          confidence: 0.92,
        });
        this._traceStore.updateVerification(turn.id, {
          performed: false,
          status: deliberation.needsVerification ? 'pending' : 'not_required',
        });
        governor = syncGovernor({ type: 'final' });
      } else {
        if (hasImageInputs(messages)) {
          usedTools = true;
          updatePlanState({
            phase: 'gathering_evidence',
            nextAction: 'inspect attached images',
          });
          nextStepNumber = await runToolStep({
            turnId: turn.id,
            toolName: 'vision_inspect',
            args: { prompt: policy.userText || 'Inspect the attached image and extract relevant details.' },
            reason: 'inspect attached visual evidence before planning the final answer',
            stepNumber: nextStepNumber,
            deadline,
            signal,
            traceStore: this._traceStore,
            toolRuntime: this._toolRuntime,
            providers,
            messages,
            emit,
            updatePlanState,
            totalUnits: maxSteps,
          });
        }

        for (let stepIndex = 0; stepIndex < maxSteps; stepIndex++) {
          assertNotCancelled(signal);
          if (Date.now() >= deadline) throw new Error('Turn orchestration timed out');

          updatePlanState({
            phase: 'planning',
            nextAction: `decide step ${nextStepNumber}`,
            completedUnits: Math.max(0, nextStepNumber - 1),
          });

          const directInspection = inferDirectWorkspaceInspection({
            policy,
            trace: this._traceStore.getTurn(turn.id),
            stepIndex,
          });
          if (directInspection) {
            governor = syncGovernor(directInspection);
            updatePlanState({
              lastDecision: { type: 'tool', tool: directInspection.tool },
              confidence: directInspection.confidence ?? 0.82,
              nextAction: describeDecision(directInspection),
              approvalRequired: governor.shouldPauseForApproval,
            });
            emit('tool_plan', {
              turnId: turn.id,
              step: nextStepNumber,
              plan: directInspection,
            });
            usedTools = true;
            nextStepNumber = await runToolStep({
              turnId: turn.id,
              toolName: directInspection.tool,
              args: directInspection.args,
              reason: directInspection.reason,
              stepNumber: nextStepNumber,
              deadline,
              signal,
              traceStore: this._traceStore,
              toolRuntime: this._toolRuntime,
              providers,
              messages,
              emit,
              updatePlanState,
              totalUnits: maxSteps,
            });
            continue;
          }

          const plannerResponse = await this._modelRouter.call({
            role: 'analyze',
            system: buildToolPlannerSystem({
              policy,
              deliberation,
              tools: this._toolRuntime.describe(),
              maxSteps,
              executionProfile,
              hasImages: hasImageInputs(messages),
            }),
            prompt: buildPlannerPrompt({
              messages,
              trace: this._traceStore.getTurn(turn.id),
              deliberation,
              remainingMs: Math.max(0, deadline - Date.now()),
            }),
            apiKey: providers,
            stream: false,
            signal,
          });

          const decision = parsePlannerDecision(plannerResponse.text);
          governor = syncGovernor(decision);
          updatePlanState({
            lastDecision: decision.type === 'final'
              ? { type: 'final' }
              : decision.type === 'batch'
                ? { type: 'batch', count: decision.items.length }
                : { type: 'tool', tool: decision.tool },
            confidence: decision.confidence ?? null,
            nextAction: describeDecision(decision),
            approvalRequired: governor.shouldPauseForApproval,
          });
          emit('tool_plan', {
            turnId: turn.id,
            step: nextStepNumber,
            plan: decision,
          });

          if (decision.type === 'final') {
            if (governor.phaseDirective === 'inspect_more' && forcedInspectPasses < 1) {
              forcedInspectPasses += 1;
              this._traceStore.appendStep(turn.id, {
                kind: 'governor',
                status: 'done',
                step: nextStepNumber,
                summary: 'autonomy governor requested one more inspection step before finalizing',
              });
              updatePlanState({
                phase: 'inspect',
                nextAction: 'gather one more evidence step before final answer',
              });
              continue;
            }
            if (governor.phaseDirective === 'verify' && forcedVerifyPasses < 1) {
              forcedVerifyPasses += 1;
              this._traceStore.appendStep(turn.id, {
                kind: 'governor',
                status: 'done',
                step: nextStepNumber,
                summary: 'autonomy governor requested one verification step before finalizing',
              });
              updatePlanState({
                phase: 'verify',
                nextAction: 'choose one focused verification step before final answer',
              });
              continue;
            }
            if (governor.phaseDirective === 'await_approval') {
              finalAnswer = buildApprovalPauseMessage(governor, policy);
              finalProvider = 'policy';
              finalModel = 'autonomy-governor';
              updatePlanState({
                phase: 'await_approval',
                nextAction: governor.approvalContext?.kind || 'wait for approval',
              });
              break;
            }
            finalAnswer = composeFinalAnswer({
              text: String(decision.answer || '').trim(),
              policy,
              usedTools,
            });
            finalProvider = plannerResponse.provider;
            finalModel = plannerResponse.model;
            updatePlanState({
              phase: 'responding',
              nextAction: 'planner decided to answer',
            });
            break;
          }
          if (decision.type === 'ask') {
            finalAnswer = String(decision.question || '').trim() || buildClarifyingQuestion(policy, deliberation);
            finalProvider = plannerResponse.provider;
            finalModel = plannerResponse.model;
            updatePlanState({
              phase: 'ask',
              nextAction: 'wait for user clarification',
            });
            break;
          }
          if (decision.type === 'await_approval') {
            finalAnswer = String(decision.message || '').trim() || buildApprovalPauseMessage(governor, policy);
            finalProvider = plannerResponse.provider;
            finalModel = plannerResponse.model;
            updatePlanState({
              phase: 'await_approval',
              nextAction: decision.approvalKind || governor.approvalContext?.kind || 'wait for approval',
            });
            break;
          }

          usedTools = true;
          try {
            const executionKind = decision.type === 'inspect' || decision.type === 'verify'
              ? decision.executionKind
              : decision.type;
            if (executionKind === 'batch') {
              nextStepNumber = await runToolBatch({
                turnId: turn.id,
                decision,
                stepNumber: nextStepNumber,
                deadline,
                signal,
                traceStore: this._traceStore,
                toolRuntime: this._toolRuntime,
                providers,
                messages,
                emit,
                updatePlanState,
                totalUnits: maxSteps,
              });
            } else {
              nextStepNumber = await runToolStep({
                turnId: turn.id,
                toolName: decision.tool,
                args: decision.args || {},
                reason: decision.reason || '',
                stepNumber: nextStepNumber,
                deadline,
                signal,
                traceStore: this._traceStore,
                toolRuntime: this._toolRuntime,
                providers,
                messages,
                emit,
                updatePlanState,
                totalUnits: maxSteps,
                phase: decision.type === 'verify' ? 'verify' : decision.type === 'inspect' ? 'inspect' : 'act',
              });
            }
            governor = syncGovernor(decision);
          } catch (err) {
            toolErrors++;
            updatePlanState({
              phase: 'recovering',
              failures: toolErrors,
              nextAction: 'recover from tool failure and re-plan',
            });
            if (toolErrors > MAX_TOOL_ERRORS) {
              throw new Error(`Tool loop stopped after repeated failures: ${err.message}`);
            }
          }
        }

        if (!finalAnswer) {
          governor = syncGovernor({ type: 'final' });
          updatePlanState({
            phase: 'responding',
            nextAction: 'synthesize answer from collected evidence',
            completedUnits: Math.max(0, nextStepNumber - 1),
            approvalRequired: governor.shouldPauseForApproval,
          });
          emit('tool_finalizing', {
            turnId: turn.id,
            toolsUsed: this._traceStore.getTurn(turn.id)?.steps?.filter((step) => step.kind === 'tool').length || 0,
          });
          const synth = await this._modelRouter.call({
            role: policy.role,
            system: buildSynthesisSystem(policy, deliberation),
            prompt: buildSynthesisPrompt({
              messages,
              trace: this._traceStore.getTurn(turn.id),
            }),
            apiKey: providers,
            stream: Boolean(onToken),
            onToken,
            signal,
          });
          finalAnswer = composeFinalAnswer({
            text: synth.text || '',
            policy,
            usedTools,
          });
          finalProvider = synth.provider;
          finalModel = synth.model;
        }
      }

      const artifactRecord = createTurnArtifact({
        artifactStore: this._artifactStore,
        turn: this._traceStore.getTurn(turn.id),
        policy,
        finalAnswer,
        usedTools,
      });
      if (artifactRecord) {
        this._traceStore.attachArtifact(turn.id, artifactRecord);
      }

      this._traceStore.finalizeTurn(turn.id, {
        status: 'done',
        final: {
          provider: finalProvider,
          model: finalModel,
          usedTools,
          answerPreview: String(finalAnswer || '').slice(0, 200),
          artifactId: artifactRecord?.id || null,
        },
      });
      emit('trace_done', {
        turnId: turn.id,
        lane,
        provider: finalProvider,
        model: finalModel,
        profile: executionProfile.id,
        intent: policy.intent,
        responseStyle: policy.responseStyle || null,
        ui: policy.ui || null,
        usedTools,
        deliberation: this._traceStore.getTurn(turn.id)?.deliberation || null,
        governor: this._traceStore.getTurn(turn.id)?.governor || null,
        plan: this._traceStore.getTurn(turn.id)?.plan || null,
        evidenceBundle: this._traceStore.getTurn(turn.id)?.evidenceBundle || null,
      });

      return {
        turnId: turn.id,
        text: finalAnswer,
        provider: finalProvider,
        model: finalModel,
        usedTools,
        lane,
        trace: this._traceStore.getTurn(turn.id),
      };
    } catch (err) {
      const status = signal?.aborted ? 'cancelled' : 'error';
      this._traceStore.finalizeTurn(turn.id, {
        status,
        error: err.message,
        final: {
          usedTools,
        },
      });
      emit('trace_error', {
        turnId: turn.id,
        error: err.message,
        cancelled: Boolean(signal?.aborted),
      });
      throw err;
    }
  }
}

async function runLightweightTurn({
  providers,
  policy,
  messages = [],
  actor = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onToken = null,
  signal = null,
  emit,
} = {}) {
  const executionProfile = normalizeExecutionProfile(policy.executionProfile || policy.profile);
  const lane = String(policy?.lane || inferLaneFromIntent(policy?.intent)).toLowerCase();
  const allowLightInspection = Boolean(policy?.tools?.allowLightInspection);
  const turn = this._traceStore.createTurn({
    mode: policy.mode,
    profile: executionProfile.id,
    lane,
    intent: policy.intent,
    responseStyle: policy.responseStyle,
    role: policy.role,
    userText: policy.userText,
    toolLoop: false,
    summary: buildTurnSummary(policy),
    ui: policy.ui,
    actor,
  });

  emit('trace_start', {
    turnId: turn.id,
    toolLoop: false,
    lane,
    intent: policy.intent,
    responseStyle: policy.responseStyle || null,
    role: policy.role,
    mode: policy.mode,
    profile: executionProfile.id,
    ui: policy.ui || null,
  });

  const updatePlanState = (patch = {}) => {
    const plan = this._traceStore.updatePlan(turn.id, patch);
    emit('trace_plan_state', {
      turnId: turn.id,
      plan,
    });
    return plan;
  };

  updatePlanState({
    phase: allowLightInspection ? 'inspect' : 'responding',
    nextAction: allowLightInspection ? 'decide whether one lightweight inspection is needed' : 'compose direct answer',
    totalUnits: allowLightInspection ? 2 : 1,
    completedUnits: 0,
    executionProfile: executionProfile.id,
  });

  let usedTools = false;
  let finalProvider = null;
  let finalModel = null;
  let finalAnswer = '';

  try {
    const inspectionDecision = inferLightweightInspection({
      policy,
      messages,
      trace: this._traceStore.getTurn(turn.id),
    });

    if (inspectionDecision) {
      usedTools = true;
      updatePlanState({
        phase: 'inspect',
        nextAction: inspectionDecision.reason,
      });
      emit('tool_plan', {
        turnId: turn.id,
        step: 1,
        plan: inspectionDecision,
      });
      await runToolStep({
        turnId: turn.id,
        toolName: inspectionDecision.tool,
        args: inspectionDecision.args,
        reason: inspectionDecision.reason,
        stepNumber: 1,
        deadline: Date.now() + timeoutMs,
        signal,
        traceStore: this._traceStore,
        toolRuntime: this._toolRuntime,
        providers,
        messages,
        emit,
        updatePlanState,
        totalUnits: 2,
        phase: 'inspect',
      });
    }

    const modelResponse = await this._modelRouter.call({
      role: policy.role,
      system: usedTools ? buildLightweightSynthesisSystem(policy) : policy.system,
      prompt: usedTools
        ? buildSynthesisPrompt({ messages, trace: this._traceStore.getTurn(turn.id) })
        : flattenMessages(messages),
      apiKey: providers,
      stream: Boolean(onToken),
      onToken,
      signal,
    });

    finalAnswer = composeFinalAnswer({
      text: modelResponse.text || '',
      policy,
      usedTools,
    });
    finalProvider = modelResponse.provider;
    finalModel = modelResponse.model;

    updatePlanState({
      phase: 'responding',
      completedUnits: usedTools ? 2 : 1,
      nextAction: 'final answer ready',
      confidence: usedTools ? 0.86 : 0.92,
    });

    const artifactRecord = createTurnArtifact({
      artifactStore: this._artifactStore,
      turn: this._traceStore.getTurn(turn.id),
      policy,
      finalAnswer,
      usedTools,
    });
    if (artifactRecord) {
      this._traceStore.attachArtifact(turn.id, artifactRecord);
    }

    this._traceStore.finalizeTurn(turn.id, {
      status: 'done',
      final: {
        provider: finalProvider,
        model: finalModel,
        usedTools,
        answerPreview: String(finalAnswer || '').slice(0, 200),
        artifactId: artifactRecord?.id || null,
      },
    });
    emit('trace_done', {
      turnId: turn.id,
      lane,
      provider: finalProvider,
      model: finalModel,
      profile: executionProfile.id,
      intent: policy.intent,
      responseStyle: policy.responseStyle || null,
      ui: policy.ui || null,
      usedTools,
      deliberation: null,
      governor: null,
      plan: this._traceStore.getTurn(turn.id)?.plan || null,
      evidenceBundle: this._traceStore.getTurn(turn.id)?.evidenceBundle || null,
    });

    return {
      turnId: turn.id,
      text: finalAnswer,
      provider: finalProvider,
      model: finalModel,
      usedTools,
      lane,
      trace: this._traceStore.getTurn(turn.id),
    };
  } catch (err) {
    const status = signal?.aborted ? 'cancelled' : 'error';
    this._traceStore.finalizeTurn(turn.id, {
      status,
      error: err.message,
      final: {
        usedTools,
      },
    });
    emit('trace_error', {
      turnId: turn.id,
      error: err.message,
      cancelled: Boolean(signal?.aborted),
    });
    throw err;
  }
}

function shouldUseToolLoop(policy, messages = []) {
  const deliberation = arguments[2] || null;
  if (String(policy?.lane || inferLaneFromIntent(policy?.intent)).toLowerCase() !== 'operation') {
    return false;
  }
  const text = String(policy?.userText || '').toLowerCase();
  const responseStyle = String(policy?.responseStyle || '');
  if (deliberation?.inspectFirst) return true;
  if (responseStyle === 'casual' || responseStyle === 'brainstorm') return false;
  if (deliberation?.needsVerification && ['build', 'review', 'test'].includes(policy?.intent)) return true;
  if (['repo_analysis', 'review', 'build', 'test', 'docs'].includes(policy?.intent)) return true;
  if (hasImageInputs(messages)) return true;
  if (/\b(latest|current|today|verify|check online|search|browse|docs)\b/.test(text)) return true;
  if (/\b(file|files|repo|repository|codebase|directory|project structure)\b/.test(text)) return true;
  return false;
}

function inferLightweightInspection({ policy, messages = [], trace = null } = {}) {
  if (!policy?.tools?.allowLightInspection && !policy?.tools?.allowTools) return null;
  if ((trace?.evidence || []).length) return null;
  if (hasImageInputs(messages)) {
    return {
      type: 'inspect',
      tool: 'vision_inspect',
      args: { prompt: policy.userText || 'Inspect the attached image and extract relevant details.' },
      reason: 'inspect attached visual evidence before answering',
      confidence: 0.8,
    };
  }
  const directFileRead = inferDirectWorkspaceInspection({ policy, trace, stepIndex: 0 });
  if (directFileRead) return directFileRead;
  if (String(policy?.lane || '') === 'analysis' && /\b(file|files|repo|repository|codebase|module|architecture|flow|component|function|class|hook|source|code)\b/i.test(String(policy?.userText || ''))) {
    return {
      type: 'inspect',
      tool: 'workspace_query_context',
      args: {
        query: String(policy.userText || '').slice(0, 300),
        maxFiles: 4,
      },
      reason: 'gather a small amount of relevant workspace context before answering',
      confidence: 0.72,
    };
  }
  return null;
}

function buildToolPlannerSystem({ policy, deliberation, tools, maxSteps, executionProfile = null, hasImages = false }) {
  return [
    policy.system,
    `You are deciding the next best action in a bounded tool-use loop.
Available tools:
${tools.map((tool) => `- ${tool.name}: ${tool.description}\n  args: ${JSON.stringify(tool.args)}`).join('\n')}

Deliberation policy:
- Risk: ${deliberation?.risk || 'low'}
- Ambiguity: ${deliberation?.ambiguity || 'low'}
- Evidence demand: ${deliberation?.evidenceDemand || 'low'}
- Autonomy allowance: ${deliberation?.autonomyAllowance || 'full'}
- Execution profile: ${executionProfile?.id || deliberation?.executionProfile || policy?.executionProfile?.id || policy?.profile || 'deliberate'}
- Approval sensitive: ${deliberation?.approvalSensitive ? 'yes' : 'no'}
- Verification needed: ${deliberation?.needsVerification ? 'yes' : 'no'}

Rules:
- Output JSON only.
- Choose exactly one: inspect, act, verify, ask, await_approval, or final.
- Prefer tools before unsupported claims.
- Keep tool args small and precise.
- Use shell_inspect only for repository inspection commands.
- Use connector_action for typed connector calls instead of hallucinating app data.
- Use connector_list_resources to discover structured connector resources before reading them.
- Use connector_read_resource to read a specific connector resource URI once you know what you need.
- Use web_search before answering requests about current facts, recent changes, or internet-visible claims.
- Use web_open to inspect a promising URL and gather quoteable evidence.
- Use docs_search for official product or API documentation questions when domains are known.
- If the conversation includes image attachments and the answer depends on them, use vision_inspect before finalizing.
- Use inspect when you need more evidence before claiming or editing.
- Use verify when you need one more evidence step to confirm or de-risk the answer.
- Use ask only when a missing requirement blocks a correct answer after reasonable inspection.
- Use await_approval when the next meaningful step is risky enough that the user should explicitly confirm it.
- If enough evidence is already collected, return a final answer.
- If several independent read/check operations are needed and they are safe to run in parallel, you may return a batch${executionProfile?.allowParallel ? '' : ', but only when clearly necessary'}.
- Maximum remaining steps: ${maxSteps}.`,
    hasImages ? 'This turn includes one or more image attachments.' : '',
  ].join('\n\n');
}

function buildPlannerPrompt({ messages, trace, deliberation, remainingMs }) {
  return [
    'Conversation:',
    flattenMessages(messages),
    '',
    'Current trace:',
    summarizeTrace(trace),
    '',
    'Deliberation summary:',
    JSON.stringify(deliberation || {}, null, 2),
    '',
    `Time remaining: ${remainingMs}ms`,
    '',
    'Return one JSON object only.',
    'Inspect choice format:',
    '{"type":"inspect","tool":"workspace_query_context","args":{"query":"...","maxFiles":4},"reason":"why inspection is needed","confidence":0.61}',
    'Inspect parallel batch format:',
    '{"type":"inspect","executionKind":"batch","reason":"several safe reads are needed","items":[{"tool":"workspace_read_file","args":{"path":"src/app.js"}},{"tool":"workspace_read_file","args":{"path":"src/auth.js"}}],"confidence":0.64}',
    'Verify format:',
    '{"type":"verify","tool":"shell_inspect","args":{"command":"git diff --stat"},"reason":"confirm the scope before finalizing","confidence":0.66}',
    'Ask format:',
    '{"type":"ask","question":"Which target file should I change first?","reason":"multiple valid targets remain"}',
    'Await approval format:',
    '{"type":"await_approval","message":"I have enough evidence to proceed, but the next step changes multiple files. Approve if you want me to continue.","approvalKind":"multi-file edit"}',
    'Backward-compatible tool format:',
    '{"type":"tool","tool":"workspace_query_context","args":{"query":"...","maxFiles":4},"reason":"why this tool is next"}',
    'Final answer format:',
    '{"type":"final","answer":"plain text answer grounded in the evidence so far","confidence":0.84}',
  ].join('\n');
}

function buildSynthesisSystem(policy, deliberation) {
  return [
    policy.system,
    'You are now synthesizing the final answer from tool observations and evidence.',
    'Do not invent evidence or citations.',
    'If evidence is incomplete, say what is still missing.',
    'If you used tool outputs, ground your answer in them explicitly.',
    deliberation?.needsVerification
      ? 'State what you verified, what is still unverified, and what approval or follow-up would be prudent.'
      : 'Keep the answer direct, but still separate facts from uncertainty when needed.',
  ].join('\n\n');
}

function buildSynthesisPrompt({ messages, trace }) {
  const evidence = (trace?.evidence || []).map((item) => ({
    citationId: item.citationId,
    type: item.type,
    title: item.title,
    source: item.source,
    snippet: item.snippet,
  }));
  return [
    'Conversation:',
    flattenMessages(messages),
    '',
    'Evidence bundle summary:',
    trace?.evidenceBundle?.summary || summarizeEvidenceBundle(trace?.evidenceBundle),
    '',
    'Tool trace and evidence:',
    JSON.stringify({
      steps: trace?.steps || [],
      deliberation: trace?.deliberation || null,
      governor: trace?.governor || null,
      plan: trace?.plan || null,
      evidenceBundle: trace?.evidenceBundle || null,
      evidence,
    }, null, 2),
    '',
    'Write the final user-facing answer now.',
    'If you rely on web or docs evidence, cite it inline using the provided citation ids like [S1] or [S2].',
    'Do not invent citations that are not present in the evidence list.',
  ].join('\n');
}

function summarizeTrace(trace) {
  if (!trace) return 'No trace yet.';
  const lines = [];
  if (trace.deliberation) {
    lines.push(`deliberation risk=${trace.deliberation.risk} ambiguity=${trace.deliberation.ambiguity} evidence=${trace.deliberation.evidenceDemand} autonomy=${trace.deliberation.autonomyAllowance}`);
  }
  if (trace.governor) {
    lines.push(`governor phase=${trace.governor.phaseDirective} evidenceStatus=${trace.governor.evidenceStatus} continue=${trace.governor.allowAutonomousContinuation}`);
  }
  if (trace.plan) {
    lines.push(`plan phase=${trace.plan.phase} next=${trace.plan.nextAction} completed=${trace.plan.completedUnits || 0}/${trace.plan.totalUnits || 0}`);
  }
  if (trace.verification) {
    lines.push(`verification status=${trace.verification.status} performed=${trace.verification.performed ? 'yes' : 'no'}`);
  }
  for (const step of trace.steps || []) {
    if (step.kind === 'tool') {
      lines.push(`planned tool ${step.tool} args=${JSON.stringify(step.args || {})} reason=${step.reason || ''}`);
    } else if (step.kind === 'tool_batch') {
      lines.push(`parallel batch ${step.batchId || ''} count=${step.count || 0} reason=${step.reason || ''}`);
    } else if (step.kind === 'tool_result') {
      lines.push(`result ${step.tool}: ${step.summary || ''}`);
    } else if (step.kind === 'tool_error') {
      lines.push(`error ${step.tool}: ${step.error || ''}`);
    }
  }
  for (const evidence of trace.evidence || []) {
    lines.push(`evidence ${evidence.type} ${evidence.source}: ${String(evidence.snippet || '').slice(0, 120)}`);
  }
  return lines.length ? lines.join('\n') : 'No tool activity yet.';
}

function createTurnArtifact({ artifactStore, turn, policy, finalAnswer, usedTools }) {
  if (!artifactStore || !turn) return null;
  const verification = turn.verification || null;
  const approval = turn.governor?.approvalContext || null;
  if (!(usedTools || approval || verification?.required)) return null;
  return artifactStore.create({
    type: 'turn-report',
    title: `Turn report · ${String(policy.intent || policy.mode || 'chat')}`,
    summary: [
      turn.governor?.evidenceStatus ? `evidence=${turn.governor.evidenceStatus}` : '',
      approval?.kind ? `approval=${approval.kind}` : '',
      verification?.status ? `verification=${verification.status}` : '',
      turn.plan?.phase ? `phase=${turn.plan.phase}` : '',
    ].filter(Boolean).join(' · '),
    metadata: {
      turnId: turn.id,
      intent: policy.intent || null,
      mode: policy.mode || null,
      profile: turn.meta?.profile || null,
      evidenceStatus: turn.governor?.evidenceStatus || null,
      verificationStatus: verification?.status || null,
      approvalRequired: Boolean(turn.governor?.shouldPauseForApproval),
    },
    createdBy: turn.meta?.actor || null,
    content: JSON.stringify({
      userText: turn.meta?.userText || '',
      finalAnswer: String(finalAnswer || ''),
      deliberation: turn.deliberation || null,
      governor: turn.governor || null,
      plan: turn.plan || null,
      verification: verification || null,
      evidenceBundle: turn.evidenceBundle || null,
      evidence: turn.evidence || [],
      steps: turn.steps || [],
    }, null, 2),
  });
}

function parsePlannerDecision(text) {
  const parsed = extractJsonObject(text);
  if (!parsed || typeof parsed !== 'object') {
    const fallback = String(text || '').trim();
    if (fallback) {
      return {
        type: 'final',
        answer: stripMarkdownFences(fallback),
        confidence: 0.42,
      };
    }
    return {
      type: 'final',
      answer: 'I could not get a structured planning response from the model. Please retry after checking the configured model provider, and make sure the workspace root is the containing folder for the file you want analyzed.',
      confidence: 0.12,
    };
  }
  if (parsed.type === 'final') {
    return {
      type: 'final',
      answer: String(parsed.answer || '').trim(),
      confidence: normalizeConfidence(parsed.confidence),
    };
  }
  if (parsed.type === 'ask') {
    return {
      type: 'ask',
      question: String(parsed.question || '').trim(),
      reason: String(parsed.reason || '').trim(),
      confidence: normalizeConfidence(parsed.confidence),
    };
  }
  if (parsed.type === 'await_approval') {
    return {
      type: 'await_approval',
      message: String(parsed.message || '').trim(),
      approvalKind: String(parsed.approvalKind || '').trim(),
      confidence: normalizeConfidence(parsed.confidence),
    };
  }
  if (parsed.type === 'inspect' || parsed.type === 'verify') {
    return normalizePhaseDecision(parsed);
  }
  if (parsed.type === 'batch') {
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if (!items.length) throw new Error('Planner batch must include items');
    if (items.length > MAX_PARALLEL_TOOLS) {
      throw new Error(`Planner batch exceeded max parallel tools (${MAX_PARALLEL_TOOLS})`);
    }
    const normalizedItems = items.map((item) => {
      const tool = String(item?.tool || '').trim();
      if (!PARALLEL_SAFE_TOOLS.has(tool)) {
        throw new Error(`Tool "${tool}" is not allowed in a parallel batch`);
      }
      return {
        tool,
        args: item?.args && typeof item.args === 'object' ? item.args : {},
        reason: String(item?.reason || '').trim(),
      };
    });
    return {
      type: 'batch',
      items: normalizedItems,
      reason: String(parsed.reason || '').trim(),
      confidence: normalizeConfidence(parsed.confidence),
    };
  }
  if (parsed.type === 'tool') {
    return {
      type: 'tool',
      tool: String(parsed.tool || '').trim(),
      args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {},
      reason: String(parsed.reason || '').trim(),
      confidence: normalizeConfidence(parsed.confidence),
    };
  }
  throw new Error('Planner JSON must use type="inspect", "verify", "ask", "await_approval", "tool", "batch", or "final"');
}

function stripMarkdownFences(text) {
  return String(text || '')
    .replace(/^```[a-z0-9_-]*\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonObject(text) {
  const source = String(text || '').trim();
  const fenced = source.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  try {
    return JSON.parse(candidate);
  } catch {}

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    } catch {}
  }
  return null;
}

function inferDirectWorkspaceInspection({ policy, trace, stepIndex = 0 } = {}) {
  if (stepIndex !== 0) return null;
  if (!policy?.userText) return null;
  if ((trace?.evidence || []).length) return null;
  const lane = String(policy?.lane || inferLaneFromIntent(policy?.intent)).toLowerCase();
  if (!['analysis', 'operation'].includes(lane)) return null;
  if (!policy?.tools?.allowLightInspection && lane !== 'operation') return null;
  if (!shouldInspectReferencedPath(policy.userText, policy)) return null;
  const matchedPath = extractLikelyWorkspacePath(policy.userText);
  if (!matchedPath) return null;
  return {
    type: 'tool',
    tool: 'workspace_read_file',
    args: { path: matchedPath },
    reason: `read the specifically referenced file first: ${matchedPath}`,
    confidence: 0.86,
  };
}

function extractLikelyWorkspacePath(text) {
  const source = String(text || '');
  const match = source.match(/(?:^|[\s"'`])([A-Za-z0-9_./-]+\.[A-Za-z0-9_+-]{1,12})(?=$|[\s"'`:,;])/);
  if (!match) return '';
  const candidate = String(match[1] || '').trim();
  if (!candidate) return '';
  if (/^https?:\/\//i.test(candidate)) return '';
  if (candidate.startsWith('..')) return '';
  if (/\/\.\./.test(candidate)) return '';
  if (!/^[A-Za-z0-9_./-]+\.[A-Za-z0-9_+-]{1,12}$/.test(candidate)) return '';
  if (candidate.startsWith('/')) return candidate.slice(1);
  return candidate.replace(/^\.\/+/, '');
}

function shouldInspectReferencedPath(text, policy = {}) {
  const source = String(text || '').toLowerCase();
  if (String(policy?.lane || '').toLowerCase() === 'plain_chat' || String(policy?.lane || '').toLowerCase() === 'brainstorm') return false;
  if (policy?.intent === 'build' || policy?.intent === 'review') return true;
  return /\b(analy[sz]e|inspect|read|open|review|check|debug|fix|explain)\b/.test(source)
    || /\b(file|files|module|script|code|source)\b/.test(source);
}

function buildLightweightSynthesisSystem(policy) {
  return [
    policy.system,
    'You may have a small amount of directly gathered evidence for this non-operational turn.',
    'Use it only to support a clean answer-first reply.',
    'Do not switch into patch, run, approval, or closeout mode.',
  ].join('\n\n');
}

function inferLaneFromIntent(intent = '') {
  if (['review', 'build', 'test', 'docs'].includes(String(intent || '').toLowerCase())) return 'operation';
  return 'analysis';
}

function flattenMessages(messages = []) {
  return messages.map((msg) => {
    const role = msg?.role || 'user';
    const content = Array.isArray(msg?.content)
      ? msg.content.map((part) => {
          if (part?.type === 'image') return `[image: ${part.name || part.uploadId || 'attachment'}]`;
          return part?.text || '';
        }).join('\n')
      : String(msg?.content || '');
    return `${role.toUpperCase()}:\n${content}`.trim();
  }).join('\n\n');
}

function hasImageInputs(messages = []) {
  return Array.isArray(messages) && messages.some((msg) =>
    Array.isArray(msg?.content) && msg.content.some((part) => part?.type === 'image')
  );
}

async function runToolStep({
  turnId,
  toolName,
  args,
  reason,
  stepNumber,
  deadline,
  signal,
  traceStore,
  toolRuntime,
  providers,
  messages,
  emit,
  updatePlanState,
  totalUnits,
  phase = 'inspect',
}) {
  const startedAt = Date.now();
  traceStore.appendStep(turnId, {
    kind: 'tool',
    status: 'running',
    step: stepNumber,
    tool: toolName,
    args,
    reason,
  });
  emit('tool_start', {
    turnId,
    step: stepNumber,
    tool: toolName,
    args,
    reason,
  });

  try {
    updatePlanState?.({
      phase,
      nextAction: `run ${toolName}`,
    });
    const result = await toolRuntime.execute(toolName, args, {
      timeoutMs: Math.min(15000, Math.max(3000, deadline - Date.now())),
      providers,
      messages,
      signal,
    });
    traceStore.appendStep(turnId, {
      kind: 'tool_result',
      status: result.ok === false ? 'error' : 'done',
      step: stepNumber,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      summary: result.summary,
      observation: result.observation,
    });
    for (const evidence of result.evidence || []) {
      const appended = traceStore.appendEvidence(turnId, evidence);
      emit('evidence_added', {
        turnId,
        evidence: appended,
      });
    }
    emit('tool_result', {
      turnId,
      step: stepNumber,
      tool: toolName,
      ok: result.ok !== false,
      summary: result.summary,
      observation: result.observation,
    });
    updatePlanState?.({
      phase: phase === 'verify' ? 'verify' : 'gathering_evidence',
      completedUnits: Math.min(totalUnits || MAX_STEPS, stepNumber),
      nextAction: 'evaluate evidence and decide next step',
    });
    if (phase === 'verify') {
      traceStore.updateVerification(turnId, {
        performed: true,
        status: result.ok === false ? 'failed' : 'passed',
        notes: [String(result.summary || `Verification completed with ${toolName}`).trim()].filter(Boolean),
      });
    }
    return stepNumber + 1;
  } catch (err) {
    traceStore.appendStep(turnId, {
      kind: 'tool_error',
      status: 'error',
      step: stepNumber,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      error: err.message,
    });
    emit('tool_error', {
      turnId,
      step: stepNumber,
      tool: toolName,
      error: err.message,
    });
    updatePlanState?.({
      failures: (traceStore.getTurn(turnId)?.plan?.failures || 0) + 1,
      nextAction: `recover after ${toolName} failure`,
    });
    if (phase === 'verify') {
      traceStore.updateVerification(turnId, {
        performed: true,
        status: 'failed',
        notes: [String(err.message || `Verification failed in ${toolName}`).trim()].filter(Boolean),
      });
    }
    throw err;
  }
}

async function runToolBatch({
  turnId,
  decision,
  stepNumber,
  deadline,
  signal,
  traceStore,
  toolRuntime,
  providers,
  messages,
  emit,
  updatePlanState,
  totalUnits,
}) {
  const batchId = `batch-${stepNumber}`;
  const items = decision.items || [];
  traceStore.appendStep(turnId, {
    kind: 'tool_batch',
    status: 'running',
    batchId,
    step: stepNumber,
    count: items.length,
    reason: decision.reason || '',
    items,
  });
  emit('tool_batch_start', {
    turnId,
    step: stepNumber,
    batchId,
    count: items.length,
    items,
    reason: decision.reason || '',
  });
  updatePlanState?.({
    phase: 'parallel_reads',
    parallelBatches: (traceStore.getTurn(turnId)?.plan?.parallelBatches || 0) + 1,
    nextAction: `run ${items.length} parallel read${items.length === 1 ? '' : 's'}`,
  });

  const results = await Promise.allSettled(items.map((item, index) => runToolStep({
    turnId,
    toolName: item.tool,
    args: item.args || {},
    reason: item.reason || decision.reason || `parallel read ${index + 1}`,
    stepNumber: stepNumber + index,
    deadline,
    signal,
    traceStore,
    toolRuntime,
    providers,
    messages,
    emit,
    updatePlanState,
    totalUnits,
  })));

  const failed = results.filter((entry) => entry.status === 'rejected');
  traceStore.appendStep(turnId, {
    kind: 'tool_batch_result',
    status: failed.length ? 'error' : 'done',
    batchId,
    step: stepNumber,
    completed: results.length - failed.length,
    failed: failed.length,
  });
  emit('tool_batch_result', {
    turnId,
    step: stepNumber,
    batchId,
    completed: results.length - failed.length,
    failed: failed.length,
  });
  if (failed.length) {
    throw failed[0].reason;
  }
  updatePlanState?.({
    phase: 'gathering_evidence',
    completedUnits: Math.min(totalUnits || MAX_STEPS, stepNumber + items.length - 1),
    nextAction: 'parallel reads complete; re-plan from evidence',
  });
  return stepNumber + items.length;
}

function assertNotCancelled(signal) {
  if (signal?.aborted) {
    throw new Error('Turn cancelled');
  }
}

function buildTurnSummary(policy = {}) {
  return String(policy?.userText || '').replace(/\s+/g, ' ').trim().slice(0, 220) || 'turn';
}

function describeDecision(decision) {
  if (!decision) return 'decide next action';
  if (decision.type === 'final') return 'final answer ready';
  if (decision.type === 'ask') return 'clarify the missing requirement';
  if (decision.type === 'await_approval') return `wait for approval: ${decision.approvalKind || 'risky next step'}`;
  if (decision.type === 'inspect') return `inspect with ${decision.executionKind === 'batch' ? 'parallel reads' : decision.tool}`;
  if (decision.type === 'verify') return `verify with ${decision.executionKind === 'batch' ? 'parallel checks' : decision.tool}`;
  if (decision.type === 'batch') return `parallel batch of ${decision.items.length} safe read${decision.items.length === 1 ? '' : 's'}`;
  return `run ${decision.tool}`;
}

function normalizeConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

function normalizePhaseDecision(parsed) {
  const type = parsed.type === 'verify' ? 'verify' : 'inspect';
  const executionKind = parsed.executionKind === 'batch' || parsed.type === 'batch'
    ? 'batch'
    : 'tool';
  if (executionKind === 'batch') {
    const batch = parsePlannerDecision(JSON.stringify({
      type: 'batch',
      items: parsed.items,
      reason: parsed.reason,
      confidence: parsed.confidence,
    }));
    return {
      ...batch,
      type,
      executionKind: 'batch',
    };
  }
  return {
    type,
    executionKind: 'tool',
    tool: String(parsed.tool || '').trim(),
    args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {},
    reason: String(parsed.reason || '').trim(),
    confidence: normalizeConfidence(parsed.confidence),
  };
}

function buildClarifyingQuestion(policy, deliberation) {
  const base = String(policy?.userText || '').trim() || 'your request';
  if (deliberation?.risk === 'high' || deliberation?.ambiguity === 'high') {
    return `I want to make the right change for ${base}, but an important requirement is still unclear. Which specific target or outcome should I prioritize first?`;
  }
  return `Before I proceed, what is the most important exact outcome you want from: ${base}?`;
}

function buildApprovalPauseMessage(governor, policy) {
  if (governor?.approvalContext?.summary) return governor.approvalContext.summary;
  const base = String(policy?.userText || '').trim() || 'this task';
  return `I have enough context to continue with ${base}, but the next step should wait for your approval.`;
}

module.exports = {
  TurnOrchestrator,
  shouldUseToolLoop,
  parsePlannerDecision,
  inferDirectWorkspaceInspection,
  extractJsonObject,
};
