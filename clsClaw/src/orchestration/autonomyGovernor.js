'use strict';

const { summarizeEvidenceBundle } = require('./evidenceBundle');
const { normalizeExecutionProfile } = require('./executionProfiles');

function evaluateAutonomy({
  policy = {},
  deliberation = {},
  evidenceBundle = null,
  trace = null,
  pendingDecision = null,
} = {}) {
  const risk = deliberation.risk || 'low';
  const ambiguity = deliberation.ambiguity || 'low';
  const evidenceDemand = deliberation.evidenceDemand || 'low';
  const autonomyAllowance = deliberation.autonomyAllowance || 'full';
  const executionProfile = deliberation.executionProfile || policy.executionProfile?.id || policy.profile || 'deliberate';
  const profile = normalizeExecutionProfile(executionProfile);
  const evidenceStatus = classifyEvidenceStatus(evidenceBundle);
  const evidenceSufficientNow = evidenceStatus === 'grounded' || evidenceStatus === 'strong';
  const evidenceCategoryCount = Object.values(evidenceBundle?.byCategory || {}).filter((count) => Number(count) > 0).length;
  const reasons = [...(deliberation.reasons || [])];
  const budgetStatus = evaluateBudget({
    profile,
    trace,
    deliberation,
  });

  if (deliberation.inspectFirst && evidenceStatus === 'none') {
    reasons.push('no grounded evidence has been collected yet');
  }

  if (deliberation.needsVerification && evidenceStatus !== 'none') {
    reasons.push('verification is expected before the answer should be treated as complete');
  }
  if (pendingDecision?.type === 'await_approval') {
    reasons.push('the next meaningful step was explicitly flagged for approval');
  }
  if (risk === 'high' && deliberation.approvalSensitive) {
    reasons.push('the task carries higher execution risk');
  }
  if (budgetStatus.exceeded) {
    reasons.push(budgetStatus.reason);
  }
  if (deliberation.externalActionRequested) {
    reasons.push('the request includes an external side effect');
  }
  if (deliberation.hostSensitiveAction) {
    reasons.push('the request may require host-level execution or network access');
  }

  const shouldAskUser = Boolean(deliberation.askUserFirst);
  const shouldInspectMore = Boolean(
    deliberation.inspectFirst
    && !evidenceSufficientNow
    && evidenceStatus === 'none'
  );
  const shouldVerifyBeforeFinal = Boolean(
    deliberation.needsVerification
    && evidenceStatus !== 'none'
    && pendingDecision?.type !== 'verify'
    && pendingDecision?.type !== 'await_approval'
    && pendingDecision?.type !== 'ask'
    && !(risk === 'low' && pendingDecision?.type === 'final' && (evidenceStatus === 'grounded' || evidenceStatus === 'strong'))
    && !(pendingDecision?.type === 'final' && evidenceCategoryCount >= 3 && evidenceStatus === 'strong')
  );
  const shouldPauseForApproval = Boolean(
    pendingDecision?.type === 'await_approval'
    || budgetStatus.exceeded
    || deliberation.externalActionRequested
    || deliberation.hostSensitiveAction
    || (deliberation.writeScope === 'repo_wide' && pendingDecision?.type !== 'ask')
    || (deliberation.approvalSensitive && risk === 'high' && pendingDecision?.type === 'final')
  );

  let phaseDirective = 'continue';
  if (shouldAskUser) phaseDirective = 'ask';
  else if (shouldPauseForApproval) phaseDirective = 'await_approval';
  else if (shouldInspectMore) phaseDirective = 'inspect_more';
  else if (shouldVerifyBeforeFinal) phaseDirective = 'verify';

  const allowAutonomousContinuation = phaseDirective === 'continue'
    || (phaseDirective === 'inspect_more' && autonomyAllowance === 'full' && evidenceCategoryCount >= 1);

  return {
    phaseDirective,
    allowAutonomousContinuation,
    shouldAskUser,
    shouldInspectMore,
    shouldVerifyBeforeFinal,
    shouldPauseForApproval,
    evidenceStatus,
    evidenceSummary: evidenceBundle?.summary || summarizeEvidenceBundle(evidenceBundle),
    evidenceCategoryCount,
    risk,
    ambiguity,
    evidenceDemand,
    autonomyAllowance,
    executionProfile,
    budget: budgetStatus,
    writeScope: deliberation.writeScope || 'single_file',
    pendingDecisionType: pendingDecision?.type || null,
    reasons: uniqueStrings(reasons),
    approvalContext: buildApprovalContext({
      policy,
      deliberation,
      evidenceBundle,
      trace,
      pendingDecision,
      evidenceStatus,
      reasons,
      budgetStatus,
    }),
  };
}

function buildApprovalContext({
  policy = {},
  deliberation = {},
  evidenceBundle = null,
  trace = null,
  pendingDecision = null,
  evidenceStatus = null,
  reasons = [],
  kind = null,
  budgetStatus = null,
} = {}) {
  const required = Boolean(
    pendingDecision?.type === 'await_approval'
    || deliberation.approvalSensitive
    || kind === 'file_change'
    || kind === 'review_acknowledgement'
  );
  if (!required) return null;

  const approvalKind = kind || pendingDecision?.approvalKind || inferApprovalKind(policy, deliberation);
  const verificationPlan = buildVerificationPlan(policy, deliberation, trace);
  const summary = buildApprovalSummary({
    policy,
    approvalKind,
    evidenceBundle,
    evidenceStatus,
    pendingDecision,
  });

  return {
    required: true,
    kind: approvalKind,
    summary,
    reasons: uniqueStrings(reasons).slice(0, 5),
    evidenceStatus: evidenceStatus || classifyEvidenceStatus(evidenceBundle),
    evidenceSummary: evidenceBundle?.summary || summarizeEvidenceBundle(evidenceBundle),
    verificationPlan,
    autonomyAllowance: deliberation.autonomyAllowance || 'full',
    risk: deliberation.risk || 'low',
    writeScope: deliberation.writeScope || 'single_file',
    nextStep: pendingDecision?.type || null,
    budget: budgetStatus,
    externalActionRequested: Boolean(deliberation.externalActionRequested),
    hostSensitiveAction: Boolean(deliberation.hostSensitiveAction),
  };
}

function classifyEvidenceStatus(bundle) {
  if (!bundle || !bundle.total) return 'none';
  const workspace = Number(bundle.byCategory?.workspace || 0);
  const web = Number(bundle.byCategory?.web || 0);
  const docs = Number(bundle.byCategory?.docs || 0);
  const image = Number(bundle.byCategory?.image || 0);
  const shell = Number(bundle.byCategory?.shell || 0);
  const github = Number(bundle.byCategory?.github || 0);
  const connector = Number(bundle.byCategory?.connector || 0);
  const score = workspace + shell + github + connector + (web * 2) + (docs * 2) + image;
  if (score >= 5) return 'strong';
  if (score >= 2) return 'grounded';
  return 'thin';
}

function inferApprovalKind(policy = {}, deliberation = {}) {
  if (deliberation.approvalSensitive && (policy.intent === 'build' || policy.mode === 'build')) {
    return 'code change';
  }
  if (policy.intent === 'review') return 'review acknowledgement';
  return 'risky action';
}

function buildVerificationPlan(policy = {}, deliberation = {}, trace = null) {
  const parts = [];
  if (deliberation.needsVerification) {
    parts.push('run one focused verification step before treating the result as complete');
  }
  if (trace?.evidenceBundle?.byCategory?.workspace) {
    parts.push('cross-check the touched files against the collected workspace evidence');
  }
  if (policy.intent === 'build' || policy.mode === 'build') {
    parts.push('review the patch or diff scope after approval');
  }
  if (deliberation.externalActionRequested) {
    parts.push('confirm the external side effect target before execution');
  }
  return parts.length ? parts.join('; ') : 'review the proposed action and verify the resulting scope after approval';
}

function buildApprovalSummary({ policy = {}, approvalKind, evidenceBundle = null, evidenceStatus = 'none', pendingDecision = null } = {}) {
  const task = String(policy.userText || '').trim() || 'this task';
  const nextStep = pendingDecision?.message ? String(pendingDecision.message).trim() : '';
  const prefix = nextStep || `The next step for "${task}" should wait for approval.`;
  const evidence = evidenceBundle?.summary || summarizeEvidenceBundle(evidenceBundle);
  return `${prefix} Current evidence is ${evidenceStatus}. ${evidence}`;
}

function evaluateBudget({ profile, trace = null, deliberation = {} } = {}) {
  const budget = profile?.autonomyBudget || {};
  const toolSteps = (trace?.steps || []).filter((step) => step.kind === 'tool_result' || step.kind === 'tool_error').length;
  const recoveryPasses = Number(trace?.plan?.failures || 0);
  const writeScope = deliberation.writeScope || 'single_file';
  const scopeRank = { single_file: 1, bounded_multi_file: 2, multi_file: 2, repo_wide: 3 };
  const maxScopeRank = scopeRank[budget.maxWriteScope || 'bounded_multi_file'] || 2;
  const currentScopeRank = scopeRank[writeScope] || 1;

  if (Number.isFinite(budget.maxToolSteps) && toolSteps >= budget.maxToolSteps) {
    return {
      exceeded: true,
      reason: `the ${profile.id} autonomy budget for tool steps has been reached`,
      toolSteps,
      maxToolSteps: budget.maxToolSteps,
      recoveryPasses,
      maxRecoveryPasses: budget.maxRecoveryPasses ?? 0,
      writeScope,
      maxWriteScope: budget.maxWriteScope || 'bounded_multi_file',
    };
  }
  if (Number.isFinite(budget.maxRecoveryPasses) && recoveryPasses > budget.maxRecoveryPasses) {
    return {
      exceeded: true,
      reason: `the ${profile.id} autonomy budget for recovery passes has been reached`,
      toolSteps,
      maxToolSteps: budget.maxToolSteps ?? null,
      recoveryPasses,
      maxRecoveryPasses: budget.maxRecoveryPasses,
      writeScope,
      maxWriteScope: budget.maxWriteScope || 'bounded_multi_file',
    };
  }
  if (currentScopeRank > maxScopeRank) {
    return {
      exceeded: true,
      reason: `the requested write scope exceeds the ${profile.id} profile budget`,
      toolSteps,
      maxToolSteps: budget.maxToolSteps ?? null,
      recoveryPasses,
      maxRecoveryPasses: budget.maxRecoveryPasses ?? 0,
      writeScope,
      maxWriteScope: budget.maxWriteScope || 'bounded_multi_file',
    };
  }
  return {
    exceeded: false,
    toolSteps,
    maxToolSteps: budget.maxToolSteps ?? null,
    recoveryPasses,
    maxRecoveryPasses: budget.maxRecoveryPasses ?? 0,
    writeScope,
    maxWriteScope: budget.maxWriteScope || 'bounded_multi_file',
  };
}

function uniqueStrings(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

module.exports = {
  evaluateAutonomy,
  buildApprovalContext,
  classifyEvidenceStatus,
};
