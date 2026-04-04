'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TurnTraceStore = require('../src/orchestration/turnTraceStore');
const { TurnOrchestrator, shouldUseToolLoop, inferDirectWorkspaceInspection } = require('../src/orchestration/turnOrchestrator');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-turns-'));
  return {
    dir,
    store: new TurnTraceStore(dir),
  };
}

test('shouldUseToolLoop only enables the heavy loop for operation lane turns', () => {
  assert.equal(shouldUseToolLoop({ lane: 'operation', intent: 'build', userText: 'Fix the failing tests' }), true);
  assert.equal(shouldUseToolLoop({ lane: 'analysis', intent: 'analysis', userText: 'Explain the auth flow' }), false);
  assert.equal(shouldUseToolLoop({ lane: 'plain_chat', intent: 'chat', userText: 'hi' }), false);
  assert.equal(shouldUseToolLoop({ lane: 'brainstorm', intent: 'plan', userText: 'suggest me something to build' }), false);
});

test('analysis lane can gather one lightweight workspace query before answering', async () => {
  const { dir, store } = makeStore();
  let modelCalls = 0;
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        modelCalls += 1;
        return {
          text: 'The auth flow validates the token in src/auth.js before route handling.',
          provider: 'openai',
          model: 'gpt-test',
        };
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'workspace_query_context', description: 'query workspace', args: { query: 'string' } }];
      },
      async execute(tool, args) {
        assert.equal(tool, 'workspace_query_context');
        assert.match(args.query, /auth flow/i);
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

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      lane: 'analysis',
      mode: 'ask',
      intent: 'analysis',
      role: 'analyze',
      responseStyle: 'analysis',
      tools: { allowTools: true, allowLightInspection: true, allowToolLoop: false },
      ui: { showMissionControl: false },
      userText: 'Explain the auth flow',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'Explain the auth flow' }],
  });

  assert.equal(modelCalls, 1);
  assert.equal(result.usedTools, true);
  assert.equal(result.lane, 'analysis');
  assert.match(result.text, /auth flow/i);
  assert.ok(result.trace.evidence.some((evidence) => evidence.source === 'src/auth.js'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('analysis lane reads a specifically named file without entering the planner loop', async () => {
  const { dir, store } = makeStore();
  let modelCalls = 0;
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        modelCalls += 1;
        return { text: 'The file uses the wrong parabolic motion formula.', provider: 'openai', model: 'gpt-test' };
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'workspace_read_file', description: 'read file', args: { path: 'string' } }];
      },
      async execute(tool, args) {
        assert.equal(tool, 'workspace_read_file');
        assert.equal(args.path, 'wrong_parabolic_motion.m');
        return {
          ok: true,
          summary: `Read ${args.path}`,
          observation: { path: args.path, content: 'y = v0*t + 0.5*g*t^2' },
          evidence: [{ type: 'workspace', source: args.path, snippet: 'y = v0*t + 0.5*g*t^2' }],
        };
      },
    },
    traceStore: store,
  });

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      lane: 'analysis',
      mode: 'ask',
      intent: 'analysis',
      role: 'analyze',
      responseStyle: 'analysis',
      tools: { allowTools: true, allowLightInspection: true, allowToolLoop: false },
      ui: { showMissionControl: false },
      userText: 'wrong_parabolic_motion.m Analyze the file',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'wrong_parabolic_motion.m Analyze the file' }],
  });

  assert.equal(modelCalls, 1);
  assert.match(result.text, /parabolic motion formula/i);
  assert.ok(result.trace.steps.some((step) => step.tool === 'workspace_read_file'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('plain chat lane falls back to direct answer with no tool activity', async () => {
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
      lane: 'plain_chat',
      mode: 'ask',
      intent: 'chat',
      role: 'analyze',
      responseStyle: 'plain',
      tools: { allowTools: false, allowLightInspection: false, allowToolLoop: false },
      ui: { showMissionControl: false },
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

test('plain chat greetings are normalized into short natural replies', async () => {
  const { dir, store } = makeStore();
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        return { text: "Hello! It's nice to chat with you about your project. What's on your mind today?", provider: 'openai', model: 'gpt-test' };
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
      lane: 'plain_chat',
      mode: 'ask',
      intent: 'chat',
      responseStyle: 'casual',
      role: 'analyze',
      tools: { allowTools: false, allowLightInspection: false, allowToolLoop: false },
      ui: { showMissionControl: false },
      userText: 'hi',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.text, "Hey. I'm here and ready to help.");

  fs.rmSync(dir, { recursive: true, force: true });
});

test('brainstorm lane returns direct ideas without operational artifacts', async () => {
  const { dir, store } = makeStore();
  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        return { text: 'Sure. What kind of app would you like to build?', provider: 'openai', model: 'gpt-test' };
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
      lane: 'brainstorm',
      mode: 'ask',
      intent: 'plan',
      responseStyle: 'brainstorm',
      role: 'analyze',
      tools: { allowTools: false, allowLightInspection: false, allowToolLoop: false },
      ui: { showMissionControl: false },
      userText: 'suggest me what can we build for engineering students',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'suggest me what can we build for engineering students' }],
  });

  assert.match(result.text, /We could build one of these next:/);
  assert.doesNotMatch(result.text, /RUN:|SAVE_AS:|\*\*\* Begin Patch/i);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('inferDirectWorkspaceInspection ignores fake dotted fragments from quoted error text', () => {
  const decision = inferDirectWorkspaceInspection({
    policy: {
      lane: 'plain_chat',
      intent: 'chat',
      userText: 'why did u reply with "Error: File not found: /Users/VIP/Desktop/..u "',
      tools: { allowTools: false, allowLightInspection: false },
    },
    trace: { evidence: [] },
    stepIndex: 0,
  });

  assert.equal(decision, null);
});

test('operation lane can pause with a clarifying question before tool planning', async () => {
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
        throw new Error('should not execute tools for ask-first decision');
      },
    },
    traceStore: store,
  });

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      lane: 'operation',
      mode: 'build',
      intent: 'build',
      role: 'code',
      responseStyle: 'coding',
      tools: { allowTools: true, allowLightInspection: false, allowToolLoop: true },
      ui: { showMissionControl: true },
      userText: 'make it better somehow',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'make it better somehow' }],
  });

  assert.match(result.text, /important exact outcome|prioritize first/i);
  assert.equal(result.trace.deliberation.askUserFirst, true);
  assert.equal(plannerCalls, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('operation lane still uses the full planner and tool loop for repo work', async () => {
  const { dir, store } = makeStore();
  const modelResponses = [
    { text: '{"type":"tool","tool":"workspace_query_context","args":{"query":"fix auth bug","maxFiles":2},"reason":"inspect implementation"}', provider: 'openai', model: 'planner' },
    { text: '{"type":"final","answer":"I found the auth bug in src/auth.js and can now fix it safely."}', provider: 'openai', model: 'planner' },
  ];

  const orchestrator = new TurnOrchestrator({
    modelRouter: {
      async call() {
        return modelResponses.shift();
      },
    },
    toolRuntime: {
      describe() {
        return [{ name: 'workspace_query_context', description: 'query workspace', args: { query: 'string' } }];
      },
      async execute(tool, args) {
        assert.equal(tool, 'workspace_query_context');
        assert.equal(args.query, 'fix auth bug');
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

  const result = await orchestrator.runTurn({
    providers: { openai: 'test-key' },
    policy: {
      lane: 'operation',
      mode: 'build',
      intent: 'build',
      role: 'code',
      responseStyle: 'coding',
      tools: { allowTools: true, allowLightInspection: false, allowToolLoop: true },
      ui: { showMissionControl: true },
      userText: 'Fix the auth bug',
      system: 'policy system',
    },
    messages: [{ role: 'user', content: 'Fix the auth bug' }],
  });

  assert.equal(result.lane, 'operation');
  assert.equal(result.usedTools, true);
  assert.ok(result.trace.deliberation);
  assert.ok(result.trace.steps.some((step) => step.kind === 'tool_result'));
  assert.match(result.text, /auth bug/i);

  fs.rmSync(dir, { recursive: true, force: true });
});
