'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Planner = require('../src/agents/planner');
const modelRouter = require('../src/llm/modelRouter');

function makePlanner() {
  return new Planner({
    agentManager: {
      launch: async () => ({ id: 'agent-1' }),
      on() {},
      off() {},
      cancel() {},
      get() { return null; },
    },
    memoryStore: {
      query() { return ''; },
      recordOutcome() {},
    },
  });
}

test('generatePlan returns summary, success criteria, risk level, and progress metadata', async (t) => {
  const planner = makePlanner();
  const originalCall = modelRouter.call;
  t.after(() => { modelRouter.call = originalCall; });

  modelRouter.call = async () => ({
    text: JSON.stringify({
      goal: 'Add auth',
      summary: 'Ship authentication end to end',
      successCriteria: ['login works', 'protected routes enforce auth'],
      riskLevel: 'high',
      steps: [
        { id: 1, type: 'analyze', description: 'Inspect current auth surface', dependsOn: [] },
        { id: 2, type: 'code', description: 'Implement route protection', dependsOn: [1] },
      ],
    }),
  });

  const plan = await planner.generatePlan({
    goal: 'Add auth',
    projectRoot: '/tmp/demo',
    apiKey: { openai: 'key' },
  });

  assert.equal(plan.summary, 'Ship authentication end to end');
  assert.deepEqual(plan.successCriteria, ['login works', 'protected routes enforce auth']);
  assert.equal(plan.riskLevel, 'high');
  assert.equal(plan.progress.totalSteps, 2);
  assert.equal(plan.progress.pendingSteps, 2);
  assert.equal(plan.progress.percent, 0);
});
