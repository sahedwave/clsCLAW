'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ensureIdentityFiles,
  readIdentityFiles,
  readRedLinePatterns,
} = require('../src/workspaceIdentity');
const { auditWorkspace, applyAuditFixes } = require('../src/security/workspaceAudit');
const { assertCommandSafe } = require('../src/sandbox/sandbox');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-workspace-'));
}

function cleanup(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

test('ensureIdentityFiles bootstraps the clsClaw workspace identity set', () => {
  const workspace = makeWorkspace();

  try {
    const created = ensureIdentityFiles(workspace);
    const files = readIdentityFiles(workspace, { includeContent: true });

    assert.equal(created.length, 5);
    assert.equal(files.filter((file) => file.exists).length, 5);
    assert.match(files.find((file) => file.name === 'IDENTITY.md').content, /\bclsClaw\b/);
    assert.match(files.find((file) => file.name === 'IDENTITY.md').content, /\bcLoSe\b/);
    assert.match(files.find((file) => file.name === 'HEARTBEAT.md').content, /- \[ \]/);
  } finally {
    cleanup(workspace);
  }
});

test('applyAuditFixes adds missing red lines and safe ignore rules', () => {
  const workspace = makeWorkspace();

  try {
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# AGENTS\n\n## Guard rails\n\n- Be careful.\n', 'utf-8');
    fs.writeFileSync(path.join(workspace, '.gitignore'), 'node_modules/\n', 'utf-8');

    const before = auditWorkspace({
      projectRoot: workspace,
      sandboxInfo: { mode: 'restricted' },
      providerStatus: { llmConfigured: true },
      automations: [{ id: 'job-1' }],
    });

    assert.ok(before.findings.some((finding) => finding.id === 'red-lines-missing'));
    assert.ok(before.findings.some((finding) => finding.id === 'gitignore-worktrees'));

    const result = applyAuditFixes(workspace);
    const gitignore = fs.readFileSync(path.join(workspace, '.gitignore'), 'utf-8');
    const redLines = readRedLinePatterns(workspace);

    assert.equal(result.agentsUpdated, true);
    assert.ok(result.createdFiles.length >= 1);
    assert.match(gitignore, /\.closeclaw-worktrees\//);
    assert.match(gitignore, /data\//);
    assert.ok(redLines.includes('rm -rf'));
    assert.ok(redLines.includes('curl | sh'));
  } finally {
    cleanup(workspace);
  }
});

test('assertCommandSafe enforces project red lines from AGENTS.md', () => {
  const workspace = makeWorkspace();

  try {
    ensureIdentityFiles(workspace, ['AGENTS.md']);
    assert.equal(assertCommandSafe('npm test', workspace), true);

    fs.writeFileSync(
      path.join(workspace, 'AGENTS.md'),
      '# AGENTS\n\n## Red lines\n\nRED_LINE: npm publish\n',
      'utf-8',
    );

    assert.throws(
      () => assertCommandSafe('npm publish', workspace),
      /AGENTS\.md red line/,
    );
  } finally {
    cleanup(workspace);
  }
});
