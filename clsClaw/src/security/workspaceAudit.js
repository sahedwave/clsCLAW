'use strict';

const fs = require('fs');
const path = require('path');
const {
  readIdentityFiles,
  readRedLinePatterns,
  ensureIdentityFiles,
} = require('../workspaceIdentity');

function makeFinding(id, severity, title, detail, fix = '') {
  return { id, severity, title, detail, fix };
}

function auditWorkspace({ projectRoot, sandboxInfo, providerStatus = {}, automations = [] }) {
  const findings = [];
  const identityFiles = readIdentityFiles(projectRoot, { includeContent: false });
  const missingIdentity = identityFiles.filter((file) => !file.exists);
  const redLines = readRedLinePatterns(projectRoot);
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const gitignoreContent = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';

  if (missingIdentity.length > 0) {
    findings.push(makeFinding(
      'identity-missing',
      'warn',
      'Missing workspace identity files',
      `Missing: ${missingIdentity.map((file) => file.name).join(', ')}`,
      'Create the missing identity files so cLoSe has durable product behavior and guard rails.',
    ));
  }

  if (redLines.length === 0) {
    findings.push(makeFinding(
      'red-lines-missing',
      'high',
      'No enforced red lines',
      'AGENTS.md does not define any RED_LINE patterns, so the sandbox only uses built-in command blocks.',
      'Add RED_LINE entries to AGENTS.md for commands you never want agents to attempt.',
    ));
  }

  if (!gitignoreContent.includes('.closeclaw-worktrees/')) {
    findings.push(makeFinding(
      'gitignore-worktrees',
      'warn',
      'Worktree ignore rule missing',
      '.gitignore does not include .closeclaw-worktrees/, which can leak temporary branches and generated files.',
      'Add .closeclaw-worktrees/ to .gitignore.',
    ));
  }

  if (!gitignoreContent.includes('data/')) {
    findings.push(makeFinding(
      'gitignore-data',
      'warn',
      'Runtime data ignore rule missing',
      '.gitignore does not include data/, which can lead to local state or provider config being committed.',
      'Add data/ to .gitignore if this workspace stores runtime state there.',
    ));
  }

  if (!sandboxInfo || sandboxInfo.mode !== 'docker') {
    findings.push(makeFinding(
      'sandbox-restricted',
      'high',
      'Full container isolation not active',
      'The workspace is running in restricted mode instead of Docker isolation.',
      'Enable Docker so command execution is isolated from the host filesystem and network by default.',
    ));
  }

  if (!providerStatus.llmConfigured) {
    findings.push(makeFinding(
      'provider-missing',
      'warn',
      'No LLM provider configured',
      'Chat and build flows cannot run reliably without at least one configured model provider.',
      'Configure Anthropic, OpenAI, or Ollama in Settings.',
    ));
  }

  if ((automations || []).length > 0 && redLines.length === 0) {
    findings.push(makeFinding(
      'automation-without-redlines',
      'high',
      'Automations enabled without custom red lines',
      'Scheduled jobs exist, but the workspace has no project-specific RED_LINE patterns.',
      'Add RED_LINE rules before relying on unattended automation.',
    ));
  }

  const severityWeight = { info: 0, warn: 1, high: 2, critical: 3 };
  const score = Math.max(0, 100 - findings.reduce((sum, finding) => sum + (severityWeight[finding.severity] || 0) * 8, 0));

  return {
    score,
    status: findings.some((finding) => ['critical', 'high'].includes(finding.severity))
      ? 'warn'
      : findings.length > 0 ? 'review' : 'ok',
    summary: findings.length
      ? `${findings.length} security/configuration issue(s) found`
      : 'Workspace security posture looks good',
    redLines,
    identity: identityFiles.map((file) => ({ name: file.name, exists: file.exists })),
    findings,
  };
}

function applyAuditFixes(projectRoot) {
  const created = ensureIdentityFiles(projectRoot);
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const additions = [];
  let agentsUpdated = false;

  if (fs.existsSync(agentsPath) && readRedLinePatterns(projectRoot).length === 0) {
    const current = fs.readFileSync(agentsPath, 'utf-8').trimEnd();
    const block = [
      '',
      '## Red lines',
      '',
      'RED_LINE: rm -rf',
      'RED_LINE: curl | sh',
      'RED_LINE: wget | sh',
      'RED_LINE: sudo',
      'RED_LINE: chmod 777',
      '',
    ].join('\n');
    fs.writeFileSync(agentsPath, `${current}${block}`, 'utf-8');
    agentsUpdated = true;
  }

  if (!existing.includes('.closeclaw-worktrees/')) additions.push('.closeclaw-worktrees/');
  if (!existing.includes('data/')) additions.push('data/');

  if (additions.length > 0) {
    const next = `${existing.trimEnd()}\n${additions.join('\n')}\n`.replace(/^\n/, '');
    fs.writeFileSync(gitignorePath, next, 'utf-8');
  }

  return { createdFiles: created, gitignoreUpdated: additions, agentsUpdated };
}

module.exports = {
  auditWorkspace,
  applyAuditFixes,
};
