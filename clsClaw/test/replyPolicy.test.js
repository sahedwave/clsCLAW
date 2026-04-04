'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_FACTS,
  BUILD_REVIEW_SECTIONS,
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
  assert.equal(hasAttachedContext([
    { role: 'user', content: 'Explain auth flow\n\nCONTEXT:\nFILE: auth.js' },
  ]), true);

  assert.equal(hasAttachedContext([
    { role: 'user', content: 'Explain auth flow' },
  ]), false);
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

test('detectIntent routes repository deep dives to repo_analysis', () => {
  assert.equal(detectIntent({
    mode: 'ask',
    messages: [{ role: 'user', content: 'Do a surgical analysis of this repository and compare it to another GitHub repo' }],
  }), 'repo_analysis');
});

test('detectIntent respects slash workflow directives', () => {
  assert.equal(detectIntent({
    mode: 'ask',
    messages: [{ role: 'user', content: '/review inspect this change for bugs' }],
  }), 'review');

  assert.equal(detectIntent({
    mode: 'ask',
    messages: [{ role: 'user', content: '/fix tighten auth handling' }],
  }), 'build');

  assert.equal(detectIntent({
    mode: 'ask',
    messages: [{ role: 'user', content: '/swarm break this migration into specialist tasks' }],
  }), 'plan');
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
  for (const section of BUILD_REVIEW_SECTIONS) {
    assert.match(policy.system, new RegExp(`${section}:`));
  }
  assert.match(policy.system, /exact order/);
  assert.match(policy.system, /If you cannot confidently produce the full review contract, do not emit SAVE_AS or RUN blocks yet/);
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
  assert.match(policy.system, /Ask at most one clarifying question/);
});

test('buildPolicySystem propagates execution profile guidance', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'ask',
    profile: 'parallel',
    messages: [{ role: 'user', content: 'Analyze this repo and gather evidence first' }],
  });

  assert.equal(policy.profile, 'parallel');
  assert.equal(policy.executionProfile.id, 'parallel');
  assert.match(policy.system, /Execution profile:/);
  assert.match(policy.system, /Safe parallel reads preferred: yes/);
});

test('buildPolicySystem adds evidence-first rules for repo analysis', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'ask',
    messages: [{ role: 'user', content: 'Compare this repository to another GitHub repo with a surgical analysis' }],
  });

  assert.equal(policy.intent, 'repo_analysis');
  assert.equal(policy.role, 'analyze');
  assert.match(policy.system, /Verified, Inferred, Missing Evidence, Recommendation/);
  assert.match(policy.system, /Never present inference as fact/);
  assert.match(policy.system, /Prefer grounding your answer in workspace files/);
});

test('buildPolicySystem adds findings-first review guidance', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'ask',
    messages: [{ role: 'user', content: 'Review this change for bugs and regressions' }],
  });

  assert.equal(policy.intent, 'review');
  assert.equal(policy.role, 'review');
  assert.match(policy.system, /Start with Findings/);
  assert.match(policy.system, /If you do not find a real issue, say "No findings"/);
});

test('maybeAnswerCanonicalQuestion returns the exact creator response for clsClaw', () => {
  const reply = maybeAnswerCanonicalQuestion({
    messages: [{ role: 'user', content: 'Who is the creator of clsClaw?' }],
  });

  assert.equal(reply.intent, 'identity');
  assert.match(reply.text, new RegExp(CANONICAL_FACTS.creatorName));
  assert.match(reply.text, /\bclsClaw\b/);
  assert.match(reply.text, /\bclsClaw\b/);
});

test('buildPolicySystem includes canonical clsClaw facts', () => {
  const policy = buildPolicySystem({
    projectRoot: '/tmp/demo',
    mode: 'ask',
    messages: [{ role: 'user', content: 'Who are you?' }],
  });

  assert.match(policy.system, /\bclsClaw\b/);
  assert.match(policy.system, /\bclsClaw\b/);
  assert.match(policy.system, new RegExp(CANONICAL_FACTS.creatorName));
});
