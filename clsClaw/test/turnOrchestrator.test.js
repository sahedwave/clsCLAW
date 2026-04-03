'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TurnTraceStore = require('../src/orchestration/turnTraceStore');
const { TurnOrchestrator, shouldUseToolLoop } = require('../src/orchestration/turnOrchestrator');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-turns-'));
  return {
    dir,
    store: new TurnTraceStore(dir),
  };
}

test('shouldUseToolLoop routes serious repo and build work through tools first', () => {
  assert.equal(shouldUseToolLoop({ intent: 'repo_analysis', userText: 'Explain this repo' }), true);
  assert.equal(shouldUseToolLoop({ intent: 'build', userText: 'Fix the failing tests' }), true);
  assert.equal(shouldUseToolLoop({ intent: 'chat', userText: 'say hello' }), false);
  assert.equal(shouldUseToolLoop(
    { intent: 'chat', userText: 'What does this screenshot show?' },
    [{ role: 'user', content: [{ type: 'text', text: 'What does this screenshot show?' }, { type: 'image', uploadId: 'img-1', name: 'screen.png' }] }],
  ), true);
});

test('turn orchestrator performs a tool step before synthesizing the final answer', async () => {
  const { dir, store } = makeStore();
  const calls = [];
  const modelResponses = [
    { text: '{"type":"tool","tool":"workspace_query_context","args":{"query":"auth flow","maxFiles":2},"reason":"inspect implementation"}', provider: 'openai', model: 'planner' },
    { text: '{"type":"final","answer":"The auth flow lives in src/auth.js and validates tokens before route handling."}', provider: 'openai', model: 'planner' },
  ];

  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call(input) {
        calls.push(input);
        return modelResponses.shift();
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'workspace_query_context', description: 'query workspace', args: { query: 'string' } }];
      },
      async execute(tool, args) {
        assert.equal(tool, 'workspace_query_context');
        assert.equal(args.query, 'auth flow');
        return {
          ok: true,
          summary: 'Found 1 relevant file',
          observation: { files: [{ relativePath: 'src/auth.js', preview: 'validateToken();' }] },
          evidence: [{ type: 'workspace', source: 'src/auth.js', snippet: 'validateToken();' }],
        };
      },
    },
    traceStore: store,
  });

  const events = [];
  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      mode: 'ask',
      intent: 'repo_analysis',
      role: 'analyze',
      userText: 'Explain the auth flow',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'Explain the auth flow' }],
    onEvent: (evt) => events.push(evt.type),
  });

  assert.match(result.text, /auth flow/i);
  assert.equal(result.usedTools, true);
  assert.ok(result.trace.steps.some((step) => step.kind === 'tool_result'));
  assert.ok(result.trace.evidence.some((evidence) => evidence.source === 'src/auth.js'));
  assert.equal(events[0], 'trace_start');
  assert.ok(events.includes('trace_plan_state'));
  assert.ok(events.includes('tool_plan'));
  assert.ok(events.includes('tool_start'));
  assert.equal(calls.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn orchestrator emits citation-labelled evidence for web-backed turns', async () => {
  const { dir, store } = makeStore();
  const modelResponses = [
    { text: '{"type":"tool","tool":"web_search","args":{"query":"latest clsClaw release","limit":1},"reason":"verify current release info"}', provider: 'openai', model: 'planner' },
    { text: '{"type":"final","answer":"The latest release was found on the official release page [S1]."}', provider: 'openai', model: 'planner' },
  ];

  const events = [];
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        return modelResponses.shift();
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'web_search', description: 'search web', args: { query: 'string' } }];
      },
      async execute() {
        return {
          ok: true,
          summary: 'Found release page',
          observation: { results: [{ url: 'https://example.com/releases', title: 'Release notes' }] },
          evidence: [{ type: 'web', source: 'https://example.com/releases', url: 'https://example.com/releases', title: 'Release notes', snippet: 'Release note body' }],
        };
      },
    },
    traceStore: store,
  });

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      mode: 'ask',
      intent: 'chat',
      role: 'analyze',
      userText: 'What is the latest clsClaw release?',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'What is the latest clsClaw release?' }],
    onEvent: (evt) => events.push(evt),
  });

  const evidenceEvent = events.find((evt) => evt.type === 'evidence_added');
  assert.equal(evidenceEvent.evidence.citationId, 'S1');
  assert.match(result.text, /\[S1\]/);
  assert.equal(result.trace.evidence[0].citationId, 'S1');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn orchestrator falls back to direct answer when tool loop is not required', async () => {
  const { dir, store } = makeStore();
  let streamed = '';
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call(input) {
        if (input.onToken) {
          input.onToken('hello');
          input.onToken(' world');
        }
        return { text: 'hello world', provider: 'openai', model: 'gpt-test' };
      },
    },
    toolRuntime: {
      describe() { return []; },
      async execute() { throw new Error('should not execute tools'); },
    },
    traceStore: store,
  });

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      mode: 'ask',
      intent: 'chat',
      role: 'analyze',
      userText: 'say hello',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'say hello' }],
    onToken: (token) => { streamed += token; },
  });

  assert.equal(result.text, 'hello world');
  assert.equal(result.usedTools, false);
  assert.equal(streamed, 'hello world');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn orchestrator inspects attached images before finalizing', async () => {
  const { dir, store } = makeStore();
  const planned = [];
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call(input) {
        planned.push(input);
        if (input.role === 'analyze') {
          return { text: '{"type":"final","answer":"The screenshot shows a failing permission request and a warning banner."}', provider: 'openai', model: 'planner' };
        }
        return { text: 'The screenshot shows a failing permission request and a warning banner.', provider: 'openai', model: 'vision' };
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'vision_inspect', description: 'inspect image', args: { prompt: 'string' } }];
      },
      async execute(tool, args) {
        assert.equal(tool, 'vision_inspect');
        assert.match(args.prompt, /screenshot/i);
        return {
          ok: true,
          summary: 'Analyzed 1 image attachment',
          observation: { text: 'warning banner' },
          evidence: [{ type: 'image_analysis', source: 'screen.png', snippet: 'warning banner' }],
        };
      },
    },
    traceStore: store,
  });

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      mode: 'ask',
      intent: 'chat',
      role: 'analyze',
      userText: 'What does this screenshot show?',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What does this screenshot show?' }, { type: 'image', uploadId: 'img-1', name: 'screen.png' }] }],
  });

  assert.match(result.text, /warning banner/i);
  assert.equal(result.usedTools, true);
  assert.ok(result.trace.evidence.some((evidence) => evidence.type === 'image_analysis'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn orchestrator can run a safe parallel read batch and track plan state', async () => {
  const { dir, store } = makeStore();
  const events = [];
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        return {
          text: JSON.stringify({
            type: 'batch',
            reason: 'compare two source files before answering',
            confidence: 0.7,
            items: [
              { tool: 'workspace_read_file', args: { path: 'src/a.js' } },
              { tool: 'workspace_read_file', args: { path: 'src/b.js' } },
            ],
          }),
          provider: 'openai',
          model: 'planner',
        };
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'workspace_read_file', description: 'read file', args: { path: 'string' } }];
      },
      async execute(tool, args) {
        return {
          ok: true,
          summary: `Read ${args.path}`,
          observation: { path: args.path, content: `// ${args.path}` },
          evidence: [{ type: 'workspace', source: args.path, snippet: `// ${args.path}` }],
        };
      },
    },
    traceStore: store,
  });

  const turnPromise = orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      mode: 'ask',
      intent: 'repo_analysis',
      role: 'analyze',
      userText: 'Compare the two files',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'Compare the two files' }],
    onEvent: (evt) => {
      events.push(evt);
      if (evt.type === 'tool_batch_result') {

        orchestrator._modelRouter.call = async () => ({
          text: '{"type":"final","answer":"Both files were read and compared."}',
          provider: 'openai',
          model: 'planner',
        });
      }
    },
  });

  const result = await turnPromise;
  assert.match(result.text, /compared/i);
  assert.ok(events.some((evt) => evt.type === 'tool_batch_start'));
  assert.ok(events.some((evt) => evt.type === 'trace_plan_state' && evt.plan?.phase === 'parallel_reads'));
  assert.equal(result.trace.plan.parallelBatches, 1);
  assert.equal(result.trace.evidence.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn orchestrator can pause with a clarifying question via phase-aware decision', async () => {
  const { dir, store } = makeStore();
  let plannerCalls = 0;
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        plannerCalls += 1;
        return {
          text: '{"type":"ask","question":"Which file should I change first?","reason":"multiple valid targets remain"}',
          provider: 'openai',
          model: 'planner',
        };
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'workspace_query_context', description: 'query workspace', args: { query: 'string' } }];
      },
      async execute() {
        throw new Error('should not execute tools for ask decision');
      },
    },
    traceStore: store,
  });

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      mode: 'build',
      intent: 'build',
      role: 'code',
      userText: 'make it better somehow',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'make it better somehow' }],
  });

  assert.match(result.text, /important exact outcome|prioritize first/i);
  assert.equal(result.trace.plan.phase, 'complete');
  assert.equal(result.trace.deliberation.askUserFirst, true);
  assert.equal(result.trace.governor.phaseDirective, 'ask');
  assert.equal(plannerCalls, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('turn orchestrator can stop at await_approval without executing risky next steps', async () => {
  const { dir, store } = makeStore();
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        return {
          text: '{"type":"await_approval","message":"I have enough evidence to continue, but the next step edits multiple files. Approve if you want me to proceed.","approvalKind":"multi-file edit"}',
          provider: 'openai',
          model: 'planner',
        };
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'workspace_query_context', description: 'query workspace', args: { query: 'string' } }];
      },
      async execute() {
        throw new Error('should not execute tools for await_approval decision');
      },
    },
    traceStore: store,
  });

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      mode: 'build',
      intent: 'build',
      role: 'code',
      userText: 'implement the refactor and run the migration',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'implement the refactor and run the migration' }],
  });

  assert.match(result.text, /Approve if you want me to proceed/i);
  assert.equal(result.trace.plan.nextAction, 'multi-file edit');
  assert.equal(result.trace.deliberation.approvalSensitive, true);
  assert.equal(result.trace.governor.phaseDirective, 'await_approval');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('autonomy governor can turn a risky finalization into an approval pause', async () => {
  const { dir, store } = makeStore();
  let calls = 0;
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        calls += 1;
        return {
          text: '{"type":"final","answer":"I will go ahead and rewrite the auth flow now.","confidence":0.9}',
          provider: 'openai',
          model: 'planner',
        };
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'workspace_query_context', description: 'query workspace', args: { query: 'string' } }];
      },
      async execute() {
        throw new Error('should not execute tools in this approval pause scenario');
      },
    },
    traceStore: store,
  });

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      mode: 'build',
      intent: 'build',
      role: 'code',
      userText: 'rewrite auth flow and run the migration',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'rewrite auth flow and run the migration' }],
  });

  assert.match(result.text, /wait for approval|approval/i);
  assert.equal(result.trace.governor.phaseDirective, 'await_approval');
  assert.equal(result.trace.plan.nextAction, 'code change');
  assert.ok(calls >= 1);

  fs.rmSync(dir, { recursive: true, force: true });
});
