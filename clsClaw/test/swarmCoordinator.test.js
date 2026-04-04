'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SwarmCoordinator } = require('../src/agents/swarmCoordinator');

test('swarm coordinator falls back to a bounded default plan and launches agents', async () => {
  const launches = [];
  const agentManager = {
    async launch(config) {
      launches.push(config);
      return {
        id: `agent-${launches.length}`,
        name: config.agentName,
        role: config.role,
        status: 'queued',
      };
    },
    get(id) {
      return launches.find((entry, index) => `agent-${index + 1}` === id)
        ? { status: 'queued', reply: '', error: null }
        : null;
    },
  };

  const coordinator = new SwarmCoordinator({
    agentManager,
    planModel: {
      async call() {
        throw new Error('planner unavailable');
      },
    },
  });

  const result = await coordinator.launch({
    goal: 'Stabilize the settings modal and add verification',
    projectRoot: '/tmp/demo',
    apiKey: { openai: 'key' },
    maxAgents: 3,
  });

  assert.equal(result.ok, true);
  assert.equal(result.agents.length, 3);
  assert.equal(launches.length, 3);
  assert.match(result.summary, /Parallelize|bounded swarm/i);
  assert.deepEqual(launches.map((item) => item.role), ['analyze', 'code', 'test']);
  assert.ok(result.session);
  assert.equal(result.session.tasks.length, 3);
  const sessions = coordinator.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'queued');
});

test('swarm coordinator can preview a bounded swarm plan without launching agents', async () => {
  const coordinator = new SwarmCoordinator({
    agentManager: {
      async launch() {
        throw new Error('should not launch');
      },
      get() {
        return null;
      },
    },
    planModel: {
      async call() {
        return {
          text: JSON.stringify({
            summary: 'Split review and implementation',
            tasks: [
              { name: 'Analyzer', role: 'analyze', prompt: 'Inspect risks' },
              { name: 'Fixer', role: 'code', prompt: 'Implement the fix' },
            ],
          }),
        };
      },
    },
  });

  const preview = await coordinator.preview({
    goal: 'Fix the settings modal',
    projectRoot: '/tmp/demo',
    apiKey: { openai: 'key' },
    maxAgents: 4,
  });

  assert.equal(preview.ok, true);
  assert.equal(preview.tasks.length, 2);
  assert.equal(preview.summary, 'Split review and implementation');
});
