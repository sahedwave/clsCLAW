'use strict';

const { structuredPatch } = require('./lineDiff');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const path = require('path');

const execAsync = promisify(exec);


let _versionStore = null;
function setVersionStore(vs) { _versionStore = vs; }

function computeStructuredDiff(oldContent, newContent, filename = '') {
  const result = structuredPatch(oldContent, newContent, filename);
  return {
    filename,
    hunks:   result.hunks,
    stats:   result.stats,
    identical: result.stats.added === 0 && result.stats.removed === 0,
  };
}

function diffFileVsProposed(filePath, newContent) {
  let oldContent = '';
  const exists = fs.existsSync(filePath);
  if (exists) {
    try { oldContent = fs.readFileSync(filePath, 'utf-8'); } catch { oldContent = ''; }
  }
  const result = computeStructuredDiff(oldContent, newContent, path.basename(filePath));
  result.isNewFile = !exists;
  result.filePath  = filePath;
  return result;
}

async function gitDiff(filePath, projectRoot) {
  try {
    const { stdout } = await execAsync(
      `git diff HEAD -- "${path.relative(projectRoot, filePath)}"`,
      { cwd: projectRoot, timeout: 5000 }
    );
    if (stdout.trim()) return { raw: stdout, source: 'git' };
  } catch {}
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  return { raw: content, source: 'fallback' };
}

async function applyDiff(filePath, newContent, projectRoot, { agentId, agentName, description, stats } = {}) {
  const resolved = path.resolve(filePath);

  if (_versionStore) {
    _versionStore.snapshotBefore(resolved, { agentId, agentName, description, stats });
  } else {

    if (fs.existsSync(resolved)) {
      fs.copyFileSync(resolved, resolved + '.closeclaw-bak.' + Date.now());
    }
  }

  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, newContent, 'utf-8');

  if (_versionStore) {
    _versionStore.snapshotContent(resolved, newContent, {
      agentId,
      agentName,
      description: description || `Wrote ${path.basename(resolved)}`,
      stats,
    });
  }

  try {
    await execAsync(
      `git add "${path.relative(projectRoot, resolved)}"`,
      { cwd: projectRoot, timeout: 5000 }
    );
  } catch {}

  return { ok: true, filePath: resolved };
}

module.exports = { computeStructuredDiff, diffFileVsProposed, gitDiff, applyDiff, setVersionStore };
