'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_FACTS,
  normalizeMode,
  extractUserIntentText,
  hasAttachedContext,
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

test('hasAttachedContext detects appended workspace context', () => {
  assert.equal(hasAttachedContext([{ role: 'user', content: 'Explain auth flow\n\nCONTEXT:\nFILE: auth.js' }]), true);
  assert.equal(hasAttachedContext([{ role: 'user', content: 'Explain auth flow' }]), false);
});

test('detectIntent preserves lightweight brainstorming and factual prompts', () => {
  assert.equal(detectIntent({
    mode: 'build',
    messages: [{ role: 'user', content: 'what can we build, suggest me a project idea' }],
  }), 'plan');

  assert.equal(detectIntent({
    mode: 'build',
    messages: [{ role: 'user', content: 'who owns google' }],
  }), 'chat');
});

test('intentToRole maps operation intents to specialized roles', () => {
  assert.equal(intentToRole('chat'), 'analyze');
  assert.equal(intentToRole('build'), 'code');
  assert.equal(intentToRole('review'), 'review');
  assert.equal(intentToRole('test'), 'test');
});

test('buildPolicySystem routes casual prompts into plain_chat lane', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'build',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(policy.lane, 'plain_chat');
  assert.equal(policy.responseStyle, 'casual');
  assert.equal(policy.tools.allowToolLoop, false);
  assert.equal(policy.ui.showMissionControl, false);
  assert.match(policy.system, /Resolved lane: plain_chat/);
  assert.match(policy.system, /No orchestration talk/);
});

test('buildPolicySystem routes idea prompts into brainstorm lane', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'build',
    messages: [{ role: 'user', content: 'if i ask u for ideas to build by coding,,,can u suggest' }],
  });

  assert.equal(policy.lane, 'brainstorm');
  assert.equal(policy.intent, 'plan');
  assert.equal(policy.tools.allowTools, false);
  assert.match(policy.system, /Resolved lane: brainstorm/);
});

test('buildPolicySystem routes explanatory technical prompts into analysis lane', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'ask',
    messages: [{ role: 'user', content: 'Explain the auth architecture' }],
  });

  assert.equal(policy.lane, 'analysis');
  assert.equal(policy.intent, 'analysis');
  assert.equal(policy.tools.allowToolLoop, false);
  assert.match(policy.system, /Resolved lane: analysis/);
  assert.match(policy.system, /Do not turn analysis into implementation/);
});

test('buildPolicySystem routes real fix requests into operation lane', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'ask',
    messages: [{ role: 'user', content: 'Analyze this file and fix bugs' }],
  });

  assert.equal(policy.lane, 'operation');
  assert.equal(policy.intent, 'build');
  assert.equal(policy.role, 'code');
  assert.equal(policy.tools.allowToolLoop, true);
  assert.equal(policy.ui.showMissionControl, true);
  assert.match(policy.system, /Resolved lane: operation/);
});

test('maybeAnswerCanonicalQuestion returns the exact creator response for clsClaw', () => {
  const reply = maybeAnswerCanonicalQuestion({
    messages: [{ role: 'user', content: 'Who is the creator of clsClaw?' }],
  });

  assert.equal(reply.intent, 'identity');
  assert.equal(reply.lane, 'plain_chat');
  assert.match(reply.text, new RegExp(CANONICAL_FACTS.creatorName));
  assert.match(reply.text, /\bclsClaw\b/);
});

test('buildPolicySystem includes canonical clsClaw facts', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'ask',
    messages: [{ role: 'user', content: 'Who are you?' }],
  });

  assert.match(policy.system, /\bclsClaw\b/);
  assert.match(policy.system, new RegExp(CANONICAL_FACTS.creatorName));
});
