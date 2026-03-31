/**
 * planner.js — Two-phase task planning
 *
 * Phase 1: Decompose goal into structured JSON task graph (no agents yet)
 * Phase 2: User approves plan → workers spawn per step, respecting dependsOn
 */
'use strict';

const { EventEmitter } = require('events');
const { randomUUID: uuid } = require('crypto');
const modelRouter = require('../llm/modelRouter');

const TYPE_TO_ROLE = {
  analyze: 'analyze', code: 'code', test: 'test',
  review:  'review',  docs: 'docs', default: 'code',
};

const TEST_LOOP_MAX_CYCLES = 3;

class Planner extends EventEmitter {
  constructor({ agentManager, memoryStore }) {
    super();
    this._agentManager = agentManager;
    this._memoryStore  = memoryStore;
    this._plans        = new Map();
  }

  async generatePlan({ goal, projectRoot, apiKey, contextFiles = [] }) {
    const memory = this._memoryStore
      ? this._memoryStore.query(goal, { projectRoot }) : '';

    const system = `You are a software project planner.
Break down the coding goal into 3-6 ordered steps.
Return ONLY valid JSON — no explanation, no markdown fences.

JSON format:
{
  "goal": "original goal",
  "steps": [
    { "id": 1, "type": "analyze", "description": "...", "dependsOn": [] },
    { "id": 2, "type": "code",    "description": "...", "dependsOn": [1] }
  ]
}

Types: analyze | code | test | review | docs
dependsOn: array of step ids that must complete first`;

    const ctxSection = contextFiles.length > 0
      ? '\n\nProject files:\n' + contextFiles
          .map(f => `${f.relativePath}: ${(f.symbols||[]).slice(0,5).join(', ')}`)
          .join('\n')
      : '';
    const memSection = memory ? '\n\nProject memory:\n' + memory : '';

    const { text } = await modelRouter.call({
      role: 'analyze',
      system,
      prompt: `Goal: ${goal}${ctxSection}${memSection}\n\nReturn JSON plan.`,
      apiKey,
      stream: false,
    });

    let planData;
    try {
      const raw = (text || '')
        .replace(/^```json?\s*/i,'').replace(/\s*```$/,'').trim();
      planData = JSON.parse(raw);
    } catch {
      throw new Error('Planner returned invalid JSON: ' + (text || '').slice(0, 200));
    }

    if (!Array.isArray(planData.steps) || !planData.steps.length)
      throw new Error('Planner returned no steps');

    const plan = {
      id:          uuid(),
      goal:        planData.goal || goal,
      status:      'pending',
      steps:       planData.steps.map(s => ({
        id:          s.id,
        type:        s.type || 'code',
        role:        TYPE_TO_ROLE[s.type] || TYPE_TO_ROLE.default,
        description: s.description,
        dependsOn:   Array.isArray(s.dependsOn) ? s.dependsOn : [],
        status:      'pending',
        agentId:     null,
        output:      null,
        loopState:   null,
      })),
      projectRoot, apiKey, contextFiles,
      createdAt: Date.now(), startedAt: null, completedAt: null,
    };

    this._plans.set(plan.id, plan);
    this.emit('plan:created', this._safe(plan));
    return plan;
  }

  async executePlan(planId) {
    const plan = this._plans.get(planId);
    if (!plan) throw new Error('Plan not found: ' + planId);
    if (plan.status === 'running') throw new Error('Plan already running');
    plan.status = 'running'; plan.startedAt = Date.now();
    this.emit('plan:started', this._safe(plan));
    await this._advance(plan);
    return this._safe(plan);
  }

  updatePlan(planId, updatedSteps) {
    const plan = this._plans.get(planId);
    if (!plan) throw new Error('Plan not found');
    if (plan.status !== 'pending') throw new Error('Can only edit pending plans');
    plan.steps = updatedSteps.map(s => ({
      ...s, role: TYPE_TO_ROLE[s.type] || TYPE_TO_ROLE.default,
      status: 'pending', agentId: null, output: null, loopState: null,
    }));
    this.emit('plan:updated', this._safe(plan));
    return this._safe(plan);
  }

  cancelPlan(planId) {
    const plan = this._plans.get(planId);
    if (!plan) return { ok: false, error: 'Plan not found' };
    for (const s of plan.steps) {
      if (s.agentId && s.status === 'running') {
        this._agentManager.cancel(s.agentId); s.status = 'skipped';
      } else if (s.status === 'pending') s.status = 'skipped';
    }
    plan.status = 'cancelled'; plan.completedAt = Date.now();
    this.emit('plan:cancelled', this._safe(plan));
    return { ok: true };
  }

  listPlans()      { return [...this._plans.values()].map(p => this._safe(p)); }
  getPlan(planId)  { const p = this._plans.get(planId); return p ? this._safe(p) : null; }

  async _advance(plan) {
    if (plan.status !== 'running') return;

    const doneIds  = new Set(plan.steps.filter(s => s.status === 'done').map(s => s.id));
    const hasError = plan.steps.some(s => s.status === 'error');
    const allDone  = plan.steps.every(s => ['done','skipped'].includes(s.status));

    if (allDone) {
      plan.status = 'done'; plan.completedAt = Date.now();
      if (this._memoryStore) {
        this._memoryStore.recordOutcome({
          task:    plan.goal,
          summary: `Completed ${plan.steps.length} steps`,
        });
      }
      this.emit('plan:done', this._safe(plan)); return;
    }

    if (hasError) {
      for (const s of plan.steps) { if (s.status === 'pending') s.status = 'skipped'; }
      plan.status = 'error'; plan.completedAt = Date.now();
      this.emit('plan:error', this._safe(plan)); return;
    }

    for (const step of plan.steps) {
      if (step.status !== 'pending') continue;
      if (!step.dependsOn.every(id => doneIds.has(id))) continue;

      const prevOut = plan.steps
        .filter(s => step.dependsOn.includes(s.id) && s.output)
        .map(s => `Step ${s.id} (${s.type}): ${s.output}`).join('\n');

      step.status = 'running';
      this.emit('plan:step_started', { planId: plan.id, stepId: step.id });

      try {
        const task = prevOut ? `${step.description}\n\nPrevious steps:\n${prevOut}` : step.description;
        const agent = await this._launchStepAgent(plan, step, {
          task,
          agentName: `Step ${step.id}: ${step.description.slice(0,30)}`,
        });
        step.agentId = agent.id;
        this._watch(plan, step, agent.id);
      } catch (err) {
        step.status = 'error'; step.output = err.message;
        this.emit('plan:step_error', { planId: plan.id, stepId: step.id, error: err.message });
        await this._advance(plan);
      }
    }
    this.emit('plan:updated', this._safe(plan));
  }

  async _launchStepAgent(plan, step, { task, agentName, roleOverride = null }) {
    return this._agentManager.launch({
      task,
      agentName,
      role: roleOverride || step.role,
      projectRoot: plan.projectRoot,
      apiKey: plan.apiKey,
      contextFiles: plan.contextFiles,
    });
  }

  async _runAgentAndWait(plan, step, { task, agentName, roleOverride = null }) {
    const agent = await this._launchStepAgent(plan, step, { task, agentName, roleOverride });

    return new Promise((resolve) => {
      const done = (d) => {
        const id = d.id || d.agent?.id;
        if (id !== agent.id) return;
        cleanup();
        const record = this._agentManager.get(agent.id);
        resolve({
          ok: true,
          id: agent.id,
          reply: record?.reply || '',
          error: record?.error || null,
          status: record?.status || 'done',
        });
      };
      const error = (d) => {
        const id = d.id || d.agent?.id;
        if (id !== agent.id) return;
        cleanup();
        const record = this._agentManager.get(agent.id);
        resolve({
          ok: false,
          id: agent.id,
          reply: record?.reply || '',
          error: d.agent?.error || d.error || record?.error || 'Agent error',
          status: 'error',
        });
      };
      const cleanup = () => {
        this._agentManager.off('agent:exit', done);
        this._agentManager.off('agent:done', done);
        this._agentManager.off('agent:error', error);
        this._agentManager.off('agent:cancelled', error);
      };
      this._agentManager.on('agent:exit', done);
      this._agentManager.on('agent:done', done);
      this._agentManager.on('agent:error', error);
      this._agentManager.on('agent:cancelled', error);
    });
  }

  async _runSelfCorrectingTestLoop(plan, step, firstAttempt) {
    let cycle = 1;
    let lastAttempt = firstAttempt;
    const history = [];

    while (cycle <= TEST_LOOP_MAX_CYCLES) {
      const assessment = this._assessTestAttempt(lastAttempt);
      history.push({
        cycle,
        passed: assessment.passed,
        summary: assessment.summary,
      });

      if (assessment.passed) {
        return {
          ok: true,
          output: this._buildLoopSummary(lastAttempt.reply, history),
          loopState: { cyclesUsed: cycle, maxCycles: TEST_LOOP_MAX_CYCLES, history },
        };
      }

      if (cycle >= TEST_LOOP_MAX_CYCLES) {
        return {
          ok: false,
          error: this._buildLoopSummary(
            lastAttempt.reply,
            history,
            `Test retries exhausted after ${TEST_LOOP_MAX_CYCLES} cycle(s).`
          ),
          loopState: { cyclesUsed: cycle, maxCycles: TEST_LOOP_MAX_CYCLES, history },
        };
      }

      this.emit('plan:step_retry', {
        planId: plan.id,
        stepId: step.id,
        cycle,
        maxCycles: TEST_LOOP_MAX_CYCLES,
        failureSummary: assessment.summary,
      });

      const fixTask = [
        'A test execution attempt failed. Produce a focused code fix proposal.',
        `Original step goal: ${step.description}`,
        `Failure summary: ${assessment.summary}`,
        'Failure context from the failed test run:',
        lastAttempt.reply || '(no textual output)',
        '',
        'Rules:',
        '- Keep changes minimal and targeted to the failure.',
        '- Use SAVE_AS blocks so the approval workflow remains intact.',
      ].join('\n');

      const fixAttempt = await this._runAgentAndWait(plan, step, {
        roleOverride: 'coder',
        agentName: `Step ${step.id} fix cycle ${cycle}`,
        task: fixTask,
      });

      if (!fixAttempt.ok) {
        return {
          ok: false,
          error: `Fix cycle ${cycle} failed: ${fixAttempt.error || 'Agent error'}`,
          loopState: { cyclesUsed: cycle, maxCycles: TEST_LOOP_MAX_CYCLES, history },
        };
      }

      const rerunTask = [
        step.description,
        '',
        'Re-run the relevant tests after the latest fix. Report concrete pass/fail status.',
        'Most recent failure summary:',
        assessment.summary,
      ].join('\n');

      lastAttempt = await this._runAgentAndWait(plan, step, {
        roleOverride: 'tester',
        agentName: `Step ${step.id} test retry ${cycle + 1}`,
        task: rerunTask,
      });

      if (!lastAttempt.ok) {
        return {
          ok: false,
          error: `Test retry ${cycle + 1} failed to run: ${lastAttempt.error || 'Agent error'}`,
          loopState: { cyclesUsed: cycle + 1, maxCycles: TEST_LOOP_MAX_CYCLES, history },
        };
      }

      cycle += 1;
    }

    return {
      ok: false,
      error: `Unexpected loop termination for step ${step.id}`,
      loopState: { cyclesUsed: cycle, maxCycles: TEST_LOOP_MAX_CYCLES, history },
    };
  }

  _assessTestAttempt(attempt) {
    if (!attempt || !attempt.ok) {
      return { passed: false, summary: attempt?.error || 'Test attempt failed to complete' };
    }

    const text = `${attempt.reply || ''}\n${attempt.error || ''}`.toLowerCase();
    const hasPassSignal = /\b(all\s+tests\s+passed|tests?\s+passed|0\s+failed|pass(?:ed)?\s*:\s*\d+)\b/.test(text);
    const hasFailSignal = /\b(fail(?:ed|ure)?|failing|errors?\b|traceback|assertion\s*error|exit\s*code\s*[:=]\s*[1-9])\b/.test(text);

    if (attempt.error) {
      return { passed: false, summary: attempt.error };
    }
    if (hasFailSignal && !hasPassSignal) {
      return { passed: false, summary: this._shortSummary(attempt.reply) || 'Test output indicates failures' };
    }
    if (hasPassSignal) {
      return { passed: true, summary: this._shortSummary(attempt.reply) || 'Tests passed' };
    }

    return {
      passed: false,
      summary: this._shortSummary(attempt.reply) || 'Could not verify a successful test run from output',
    };
  }

  _shortSummary(text = '') {
    return text.replace(/\s+/g, ' ').trim().slice(0, 220);
  }

  _buildLoopSummary(latestReply, history, tail = '') {
    const attempts = history.map(h => `cycle ${h.cycle}: ${h.passed ? 'pass' : 'fail'} (${h.summary})`).join('\n');
    const parts = [
      'Self-correcting test loop summary:',
      attempts || '(no attempts)',
      '',
      'Latest test output:',
      latestReply || '(no output)',
    ];
    if (tail) parts.push('', tail);
    return parts.join('\n').slice(0, 6000);
  }

  _watch(plan, step, agentId) {
    const done = async (d) => {
      const id = d.id || d.agent?.id;
      if (id !== agentId) return;
      cleanup();
      const a = this._agentManager.get(agentId);

      if (step.type === 'test') {
        const firstAttempt = {
          ok: true,
          id: agentId,
          reply: a?.reply || `Step ${step.id} completed`,
          error: a?.error || null,
          status: a?.status || 'done',
        };
        const loopResult = await this._runSelfCorrectingTestLoop(plan, step, firstAttempt);
        step.loopState = loopResult.loopState;

        if (loopResult.ok) {
          step.output = (loopResult.output || `Step ${step.id} completed`).slice(0, 3000);
          step.status = 'done';
          this.emit('plan:step_done', { planId: plan.id, stepId: step.id });
          await this._advance(plan);
          return;
        }

        step.status = 'error';
        step.output = (loopResult.error || 'Self-correcting test loop failed').slice(0, 3000);
        this.emit('plan:step_error', { planId: plan.id, stepId: step.id, error: step.output });
        await this._advance(plan);
        return;
      }

      step.output = (a?.reply || `Step ${step.id} completed`).slice(0, 300);
      step.status = 'done';
      this.emit('plan:step_done', { planId: plan.id, stepId: step.id });
      await this._advance(plan);
    };
    const error = async (d) => {
      const id = d.id || d.agent?.id;
      if (id !== agentId) return;
      cleanup();
      step.status = 'error';
      step.output = d.agent?.error || d.error || 'Agent error';
      this.emit('plan:step_error', { planId: plan.id, stepId: step.id, error: step.output });
      await this._advance(plan);
    };
    const cleanup = () => {
      this._agentManager.off('agent:exit',      done);
      this._agentManager.off('agent:done',      done);
      this._agentManager.off('agent:error',     error);
      this._agentManager.off('agent:cancelled', error);
    };
    this._agentManager.on('agent:exit',      done);
    this._agentManager.on('agent:done',      done);
    this._agentManager.on('agent:error',     error);
    this._agentManager.on('agent:cancelled', error);
  }

  _safe(plan) {
    const { apiKey, ...rest } = plan;
    return { ...rest, steps: rest.steps.map(s => ({ ...s })) };
  }
}

module.exports = Planner;
