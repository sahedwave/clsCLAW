'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeExecutionProfile,
  listExecutionProfiles,
} = require('../src/orchestration/executionProfiles');

test('normalizeExecutionProfile defaults unknown profiles to deliberate', () => {
  assert.equal(normalizeExecutionProfile('quick').id, 'quick');
  assert.equal(normalizeExecutionProfile('unknown-value').id, 'deliberate');
});

test('listExecutionProfiles exposes the supported execution presets', () => {
  assert.deepEqual(listExecutionProfiles().map((item) => item.id), [
    'quick',
    'deliberate',
    'execute',
    'parallel',
  ]);
});

test('execution profiles expose bounded autonomy budgets', () => {
  const quick = normalizeExecutionProfile('quick');
  const parallel = normalizeExecutionProfile('parallel');

  assert.equal(quick.autonomyBudget.maxToolSteps, 3);
  assert.equal(quick.autonomyBudget.maxWriteScope, 'single_file');
  assert.equal(parallel.autonomyBudget.maxWriteScope, 'bounded_multi_file');
});
