'use strict';

const { normalizeExecutionProfile } = require('./executionProfiles');

function classifyDeliberation({ policy = {}, messages = [], trace = null } = {}) {
  const workflowDirective = extractWorkflowDirective(policy.userText || extractUserText(messages));
  const intent = String(policy.intent || 'chat');
  const mode = String(policy.mode || 'ask');
  const executionProfile = normalizeExecutionProfile(policy.executionProfile || policy.profile);
  const userText = String(stripWorkflowDirective(policy.userText || '')).trim();
  const text = userText.toLowerCase();
  const hasImages = containsImages(messages);
  const currentEvidenceCount = Array.isArray(trace?.evidence) ? trace.evidence.length : 0;
  const currentWorkspaceEvidence = countEvidenceTypes(trace?.evidence, ['workspace', 'shell', 'connector_resource']);
  const currentExternalEvidence = countEvidenceTypes(trace?.evidence, ['web', 'web_search', 'docs_search']);
  const hasAnyEvidence = currentEvidenceCount > 0;
  const hasGroundedEvidence = currentWorkspaceEvidence > 0 || currentExternalEvidence > 0;
  const mentionsConcreteArtifact = /\b(src\/|app\/|test\/|\.js\b|\.ts\b|\.tsx\b|\.py\b|readme|package\.json|memory\.md)\b/i.test(userText);

  const reasons = [];
  let riskScore = 0;
  let ambiguityScore = 0;
  let evidenceDemandScore = 0;
  let verificationNeed = 'low';
  let autonomyAllowance = 'full';
  const writeScope = estimateWriteScope(text);
  const externalActionRequested = /\b(email|calendar|telegram|discord|whatsapp|post|publish|deploy|upload|message|notify|submit|payment|checkout)\b/.test(text);
  const hostSensitiveAction = /\b(docker|curl|wget|open|osascript|xdg-open|browser|gh\b|ssh)\b/.test(text);

  if (['build', 'review', 'test'].includes(intent) || mode === 'build') {
    riskScore += 2;
    verificationNeed = intent === 'review' ? 'medium' : 'high';
    reasons.push('code-affecting request');
  }
  if (intent === 'repo_analysis' || intent === 'docs') {
    evidenceDemandScore += 2;
    reasons.push('grounding-heavy request');
  }
  if (/\b(latest|current|today|verify|search|browse|docs|official)\b/.test(text)) {
    evidenceDemandScore += 2;
    reasons.push('current or externally verifiable facts requested');
  }
  if (/\b(fix|implement|rewrite|refactor|delete|remove|install|upgrade|migrate)\b/.test(text)) {
    riskScore += 2;
    reasons.push('execution or change requested');
  }
  if (/\b(maybe|something|somehow|improve this|make it better|do it)\b/.test(text) && userText.length < 34) {
    ambiguityScore += 2;
    reasons.push('goal underspecified');
  }
  if (mentionsConcreteArtifact) {
    ambiguityScore = Math.max(0, ambiguityScore - 1);
    reasons.push('request names concrete project artifacts');
  }
  if (/\b(button|modal|api|endpoint|component|hook|test|docs|review|workflow|cron|job|prompt|closeout)\b/.test(text) && userText.length >= 16) {
    ambiguityScore = Math.max(0, ambiguityScore - 1);
  }
  if (/\b(review|audit|analyze|explain|summarize)\b/.test(text) && userText.length >= 20) {
    ambiguityScore = Math.max(0, ambiguityScore - 1);
  }
  if (hasImages) {
    evidenceDemandScore += 2;
    reasons.push('image evidence attached');
  }
  if (!userText) {
    ambiguityScore += 2;
    reasons.push('missing explicit user text');
  }
  if (hasGroundedEvidence) {
    ambiguityScore = Math.max(0, ambiguityScore - 1);
  }
  if (hasAnyEvidence && ['repo_analysis', 'review', 'docs'].includes(intent)) {
    evidenceDemandScore = Math.max(0, evidenceDemandScore - 1);
  }
  if (/\b(run|execute|ship|apply now)\b/.test(text)) {
    riskScore += 1;
    reasons.push('user asked for immediate execution');
  }
  if (externalActionRequested) {
    riskScore += 2;
    evidenceDemandScore += 1;
    reasons.push('external side effects requested');
  }
  if (hostSensitiveAction) {
    riskScore += 2;
    reasons.push('host or network sensitive action implied');
  }
  if (writeScope === 'repo_wide') {
    riskScore += 2;
    reasons.push('request implies broad write scope');
  } else if (writeScope === 'multi_file') {
    riskScore += 1;
    reasons.push('request implies multi-file changes');
  }

  if (['repo_analysis', 'review', 'build', 'test', 'docs', 'plan'].includes(intent) || hasImages) {
    evidenceDemandScore = Math.max(0, evidenceDemandScore + Number(executionProfile.inspectBias || 0));
  }
  if (Number(executionProfile.verificationBias || 0) > 0 && verificationNeed === 'low' && ['build', 'review', 'test', 'docs'].includes(intent)) {
    verificationNeed = 'medium';
  }
  if (Number(executionProfile.verificationBias || 0) < 0 && verificationNeed === 'medium' && riskScore < 3) {
    verificationNeed = 'low';
  }
  if (Number(executionProfile.askBias || 0) < 0 && ambiguityScore > 0 && userText.length >= 18) {
    ambiguityScore = Math.max(0, ambiguityScore - 1);
  }

  const inspectFirst = evidenceDemandScore > 0
    || ['repo_analysis', 'review', 'docs', 'plan'].includes(intent)
    || hasImages
    || (intent === 'build' && mentionsConcreteArtifact);
  const evidenceSufficient = inspectFirst
    ? (currentEvidenceCount > 0 && hasGroundedEvidence)
    : true;

  if (riskScore >= 3 || intent === 'review') {
    autonomyAllowance = 'bounded';
  }
  if (externalActionRequested || hostSensitiveAction || writeScope === 'repo_wide') {
    autonomyAllowance = 'approval_first';
  }
  if (ambiguityScore >= 2 && ['build', 'review', 'plan'].includes(intent)) {
    autonomyAllowance = 'clarify_if_blocked';
  }

  const approvalSensitive = riskScore >= 3 || /\b(delete|remove|install|upgrade|run)\b/.test(text) || mode === 'build' || externalActionRequested || hostSensitiveAction;
  const needsVerification = verificationNeed === 'high' || (verificationNeed === 'medium' && riskScore >= 2) || /\b(test|verify|check)\b/.test(text);
  const askUserFirst = ambiguityScore >= 2
    && !hasGroundedEvidence
    && !hasImages
    && userText.length < 40
    && ['build', 'review', 'plan'].includes(intent)
    && !/\b(file|line|review|docs|screenshot|issue|pr|test|component|function)\b/.test(text);

  return {
    intent,
    mode,
    inspectFirst,
    askUserFirst,
    approvalSensitive,
    needsVerification,
    evidenceSufficient,
    evidenceDemand: evidenceDemandScore >= 3 ? 'high' : evidenceDemandScore >= 1 ? 'medium' : 'low',
    risk: riskScore >= 4 ? 'high' : riskScore >= 2 ? 'medium' : 'low',
    ambiguity: ambiguityScore >= 3 ? 'high' : ambiguityScore >= 1 ? 'medium' : 'low',
    autonomyAllowance,
    executionProfile: executionProfile.id,
    autonomyBudget: executionProfile.autonomyBudget || null,
    workflowDirective,
    writeScope,
    externalActionRequested,
    hostSensitiveAction,
    initialPhase: askUserFirst
      ? 'ask'
      : inspectFirst && !evidenceSufficient
        ? 'inspect'
        : needsVerification && ['build', 'test', 'review'].includes(intent)
          ? 'verify'
          : 'final',
    reasons,
  };
}

function extractWorkflowDirective(text = '') {
  const raw = String(text || '').trim();
  const match = raw.match(/^\/([a-z][a-z0-9_-]*)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function stripWorkflowDirective(text = '') {
  return String(text || '').replace(/^\/[a-z][a-z0-9_-]*\b\s*/i, '');
}

function extractUserText(messages = []) {
  const lastUser = [...messages].reverse().find((msg) => msg?.role === 'user');
  if (!lastUser) return '';
  return Array.isArray(lastUser.content)
    ? lastUser.content.map((part) => part?.text || '').join('\n')
    : String(lastUser.content || '');
}

function estimateWriteScope(text = '') {
  if (/\b(repo-wide|whole repo|entire repo|all files|every file|entire project|across the project)\b/.test(text)) return 'repo_wide';
  if (/\b(multi-file|multiple files|several files|across files|across modules|refactor)\b/.test(text)) return 'multi_file';
  return 'single_file';
}

function countEvidenceTypes(items = [], types = []) {
  const typeSet = new Set(types);
  return (Array.isArray(items) ? items : []).filter((item) => typeSet.has(item?.type)).length;
}

function containsImages(messages = []) {
  return Array.isArray(messages) && messages.some((msg) =>
    Array.isArray(msg?.content) && msg.content.some((part) => part?.type === 'image')
  );
}

module.exports = {
  classifyDeliberation,
  extractWorkflowDirective,
  stripWorkflowDirective,
};
