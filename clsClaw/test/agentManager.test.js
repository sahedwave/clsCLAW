'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AgentManager = require('../src/agents/agentManager');

function makeManager() {
  return new AgentManager({
    approvalQueue: { propose: async () => ({ skipped: true }) },
    permissionGate: { request: async () => ({ ok: true }) },
  });
}

test('sendInput queues follow-up work for a running agent', () => {
  const manager = makeManager();
  const record = {
    id: 'a1',
    name: 'Agent',
    role: 'code',
    status: 'running',
    worker: { terminate() {} },
    worktreePath: null,
    pendingInputs: [],
    _projectRoot: '/tmp/demo',
    _apiKey: { openai: 'key' },
    _contextFiles: [],
    _memory: '',
    _behavioralConstraints: [],
    _identityContext: '',
  };
  manager._agents.set(record.id, record);

  const result = manager.sendInput(record.id, { task: 'follow up task', interrupt: false });

  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(record.pendingInputs.length, 1);
  assert.equal(record.pendingInputs[0].task, 'follow up task');
});

test('sendInput marks a running agent for interrupt-based redirect', () => {
  const manager = makeManager();
  let terminated = false;
  const record = {
    id: 'a1',
    name: 'Agent',
    role: 'analyze',
    status: 'running',
    worker: { terminate() { terminated = true; } },
    worktreePath: null,
    pendingInputs: [],
    _projectRoot: '/tmp/demo',
    _apiKey: { openai: 'key' },
    _contextFiles: [],
    _memory: '',
    _behavioralConstraints: [],
    _identityContext: '',
  };
  manager._agents.set(record.id, record);

  const result = manager.sendInput(record.id, { task: 'new urgent task', interrupt: true });

  assert.equal(result.ok, true);
  assert.equal(result.interrupted, true);
  assert.equal(terminated, true);
  assert.equal(record.status, 'redirecting');
  assert.equal(record._redirectNext.task, 'new urgent task');
});

test('waitFor resolves when tracked agents reach final states', async () => {
  const manager = makeManager();
  manager._agents.set('a1', { id: 'a1', status: 'running', error: null, provider: null, model: null, reply: '' });

  const waiting = manager.waitFor(['a1'], 5000);
  setTimeout(() => {
    const record = manager._agents.get('a1');
    record.status = 'done';
    record.reply = 'done';
    manager.emit('agent:status', record);
  }, 10);

  const result = await waiting;
  assert.equal(result.done, true);
  assert.equal(result.agents[0].status, 'done');
  assert.equal(result.agents[0].reply, 'done');
});
