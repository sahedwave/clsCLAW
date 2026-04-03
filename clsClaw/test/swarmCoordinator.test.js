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
});
