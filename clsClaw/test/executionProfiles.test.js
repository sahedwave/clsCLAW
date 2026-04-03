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
