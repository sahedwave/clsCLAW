'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_FACTS,
  normalizeMode,
  extractUserIntentText,
  detectIntent,
  intentToRole,
  maybeAnswerCanonicalQuestion,
  buildPolicySystem,
} = require('../src/llm/replyPolicy');

test('normalizeMode defaults unknown values to ask', () => {
  assert.equal(normalizeMode('build'), 'build');
  assert.equal(normalizeMode('anything-else'), 'ask');
});

test('extractUserIntentText strips appended context', () => {
  const text = extractUserIntentText([
    { role: 'assistant', content: 'Earlier reply' },
    { role: 'user', content: 'Fix the login bug\n\nCONTEXT:\nFILE: auth.js' },
  ]);

  assert.equal(text, 'Fix the login bug');
});

test('detectIntent respects review and build requests', () => {
  assert.equal(detectIntent({
    mode: 'ask',
    messages: [{ role: 'user', content: 'Please review this PR for bugs and edge cases' }],
  }), 'review');

  assert.equal(detectIntent({
    mode: 'build',
    messages: [{ role: 'user', content: 'hi there' }],
  }), 'build');
});

test('intentToRole maps chat to analyze and build to code', () => {
  assert.equal(intentToRole('chat'), 'analyze');
  assert.equal(intentToRole('build'), 'code');
  assert.equal(intentToRole('review'), 'review');
});

test('buildPolicySystem creates self-check guidance for build mode', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'build',
    messages: [{ role: 'user', content: 'Add a profile settings page' }],
  });

  assert.equal(policy.mode, 'build');
  assert.equal(policy.intent, 'build');
  assert.equal(policy.role, 'code');
  assert.match(policy.system, /Understanding:/);
  assert.match(policy.system, /Self-check:/);
  assert.match(policy.system, /Only after those sections, emit SAVE_AS/);
});

test('buildPolicySystem keeps ask mode in plain-text guidance', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'ask',
    messages: [{ role: 'user', content: 'Explain the auth architecture' }],
  });

  assert.equal(policy.intent, 'chat');
  assert.equal(policy.role, 'analyze');
  assert.match(policy.system, /Reply in plain text by default/);
  assert.match(policy.system, /Do not emit SAVE_AS blocks/);
});

test('maybeAnswerCanonicalQuestion returns the exact creator response for clsClaw', () => {
  const reply = maybeAnswerCanonicalQuestion({
    messages: [{ role: 'user', content: 'Who is the creator of clsClaw?' }],
  });

  assert.equal(reply.intent, 'identity');
  assert.match(reply.text, new RegExp(CANONICAL_FACTS.creatorName));
  assert.match(reply.text, /\bclsClaw\b/);
  assert.match(reply.text, /\bcLoSe\b/);
});

test('buildPolicySystem includes canonical clsClaw and cLoSe facts', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'ask',
    messages: [{ role: 'user', content: 'Who are you?' }],
  });

  assert.match(policy.system, /\bclsClaw\b/);
  assert.match(policy.system, /\bcLoSe\b/);
  assert.match(policy.system, new RegExp(CANONICAL_FACTS.creatorName));
});
