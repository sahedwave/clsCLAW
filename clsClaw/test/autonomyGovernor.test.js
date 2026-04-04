'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateAutonomy, buildApprovalContext, classifyEvidenceStatus } = require('../src/orchestration/autonomyGovernor');
const { buildEvidenceBundle } = require('../src/orchestration/evidenceBundle');

test('autonomy governor asks for more inspection when evidence is absent on a grounding-heavy task', () => {
  const result = evaluateAutonomy({
    policy: { intent: 'repo_analysis', mode: 'ask', userText: 'explain the repo and verify the biggest risks' },
    deliberation: {
      inspectFirst: true,
      askUserFirst: false,
      approvalSensitive: false,
      needsVerification: false,
      evidenceSufficient: false,
      evidenceDemand: 'high',
      risk: 'medium',
      ambiguity: 'low',
      autonomyAllowance: 'bounded',
      reasons: ['grounding-heavy request'],
    },
    evidenceBundle: buildEvidenceBundle([]),
  });

  assert.equal(result.phaseDirective, 'inspect_more');
  assert.equal(result.allowAutonomousContinuation, false);
  assert.equal(result.evidenceStatus, 'none');
});

test('autonomy governor pauses for approval on risky evidence-backed build turns', () => {
  const result = evaluateAutonomy({
    policy: { intent: 'build', mode: 'build', userText: 'rewrite auth flow and run the migration' },
    deliberation: {
      inspectFirst: true,
      askUserFirst: false,
      approvalSensitive: true,
      needsVerification: true,
      evidenceSufficient: true,
      evidenceDemand: 'medium',
      risk: 'high',
      ambiguity: 'low',
      autonomyAllowance: 'bounded',
      reasons: ['execution or change requested'],
    },
    evidenceBundle: buildEvidenceBundle([
      { type: 'workspace', source: 'src/auth.js', title: 'auth', snippet: '...' },
      { type: 'shell', source: 'git diff --stat', title: 'scope', snippet: '...' },
    ]),
    pendingDecision: { type: 'final' },
  });

  assert.equal(result.phaseDirective, 'await_approval');
  assert.equal(result.shouldPauseForApproval, true);
  assert.equal(result.approvalContext.required, true);
});

test('approval context summarizes verification and evidence status', () => {
  const evidenceBundle = buildEvidenceBundle([
    { type: 'workspace', source: 'src/app.js', title: 'app', snippet: '...' },
  ]);
  const context = buildApprovalContext({
    kind: 'file_change',
    policy: { intent: 'build', mode: 'build', userText: 'update settings page' },
    deliberation: { approvalSensitive: true, needsVerification: true, autonomyAllowance: 'bounded', risk: 'medium' },
    evidenceBundle,
  });

  assert.equal(context.required, true);
  assert.equal(context.evidenceStatus, classifyEvidenceStatus(evidenceBundle));
  assert.match(context.verificationPlan, /verify|review/i);
});

test('autonomy governor avoids extra verify loop when strong multi-source evidence already exists', () => {
  const evidenceBundle = buildEvidenceBundle([
    { type: 'workspace', source: 'src/app.js', title: 'app', snippet: '...' },
    { type: 'docs_search', source: 'https://docs.example.com/modal', title: 'Modal docs', snippet: '...' },
    { type: 'web', source: 'https://example.com/issue', title: 'Issue thread', snippet: '...' },
  ]);
  const result = evaluateAutonomy({
    policy: { intent: 'build', mode: 'build', userText: 'tighten the modal closeout flow' },
    deliberation: {
      inspectFirst: true,
      askUserFirst: false,
      approvalSensitive: false,
      needsVerification: true,
      evidenceSufficient: true,
      evidenceDemand: 'medium',
      risk: 'low',
      ambiguity: 'low',
      autonomyAllowance: 'full',
      reasons: [],
    },
    evidenceBundle,
    pendingDecision: { type: 'final' },
  });

  assert.equal(result.shouldVerifyBeforeFinal, false);
  assert.equal(result.phaseDirective, 'continue');
});

test('autonomy governor pauses when the execution profile budget is exceeded', () => {
  const result = evaluateAutonomy({
    policy: { intent: 'build', mode: 'build', profile: 'quick', userText: 'refactor the entire project' },
    deliberation: {
      inspectFirst: true,
      askUserFirst: false,
      approvalSensitive: true,
      needsVerification: true,
      evidenceSufficient: true,
      evidenceDemand: 'medium',
      risk: 'medium',
      ambiguity: 'low',
      autonomyAllowance: 'bounded',
      executionProfile: 'quick',
      writeScope: 'repo_wide',
      reasons: [],
    },
    trace: {
      steps: [
        { kind: 'tool_result' },
        { kind: 'tool_result' },
        { kind: 'tool_result' },
      ],
      plan: { failures: 0 },
    },
    evidenceBundle: buildEvidenceBundle([
      { type: 'workspace', source: 'src/app.js', title: 'app', snippet: '...' },
    ]),
    pendingDecision: { type: 'final' },
  });

  assert.equal(result.phaseDirective, 'await_approval');
  assert.equal(result.budget.exceeded, true);
  assert.match(result.approvalContext.summary, /wait for approval/i);
});
