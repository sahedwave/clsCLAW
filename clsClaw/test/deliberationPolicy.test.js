'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyDeliberation } = require('../src/orchestration/deliberationPolicy');

test('deliberation policy prefers inspect-first for grounded repo analysis', () => {
  const result = classifyDeliberation({
    policy: {
      intent: 'repo_analysis',
      mode: 'ask',
      userText: 'Explain this repository and verify the current architecture.',
    },
    messages: [{ role: 'user', content: 'Explain this repository and verify the current architecture.' }],
  });

  assert.equal(result.inspectFirst, true);
  assert.equal(result.initialPhase, 'inspect');
  assert.equal(result.evidenceDemand, 'high');
});

test('deliberation policy flags risky build requests as approval sensitive and verification-heavy', () => {
  const result = classifyDeliberation({
    policy: {
      intent: 'build',
      mode: 'build',
      userText: 'Implement the refactor and run the migration.',
    },
    messages: [{ role: 'user', content: 'Implement the refactor and run the migration.' }],
  });

  assert.equal(result.approvalSensitive, true);
  assert.equal(result.needsVerification, true);
  assert.equal(result.risk, 'high');
});

test('deliberation policy asks first for highly ambiguous short build requests', () => {
  const result = classifyDeliberation({
    policy: {
      intent: 'build',
      mode: 'build',
      userText: 'make it better somehow',
    },
    messages: [{ role: 'user', content: 'make it better somehow' }],
  });

  assert.equal(result.askUserFirst, true);
  assert.equal(result.initialPhase, 'ask');
});

test('deliberation policy stays inspect-first instead of ask-first for concrete artifact requests', () => {
  const result = classifyDeliberation({
    policy: {
      intent: 'build',
      mode: 'build',
      userText: 'improve src/app.js modal closeout flow',
    },
    messages: [{ role: 'user', content: 'improve src/app.js modal closeout flow' }],
  });

  assert.equal(result.askUserFirst, false);
  assert.equal(result.inspectFirst, true);
});

test('deliberation policy records the selected execution profile', () => {
  const result = classifyDeliberation({
    policy: {
      intent: 'repo_analysis',
      mode: 'ask',
      profile: 'parallel',
      userText: 'Inspect this repository and compare the important subsystems',
    },
    messages: [{ role: 'user', content: 'Inspect this repository and compare the important subsystems' }],
  });

  assert.equal(result.executionProfile, 'parallel');
  assert.equal(result.inspectFirst, true);
});

test('deliberation policy treats external actions as approval-first and captures write scope', () => {
  const result = classifyDeliberation({
    policy: {
      intent: 'build',
      mode: 'build',
      userText: 'post the update to Discord and refactor multiple files',
    },
    messages: [{ role: 'user', content: 'post the update to Discord and refactor multiple files' }],
  });

  assert.equal(result.approvalSensitive, true);
  assert.equal(result.autonomyAllowance, 'approval_first');
  assert.equal(result.writeScope, 'multi_file');
  assert.equal(result.externalActionRequested, true);
});
