

'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

async function isGitRepo(projectRoot) {
  try {
    await execAsync('git rev-parse --is-inside-work-tree', { cwd: projectRoot, timeout: 5000 });
    return true;
  } catch { return false; }
}

async function getCurrentBranch(projectRoot) {
  try {
    const { stdout } = await execAsync('git branch --show-current', { cwd: projectRoot, timeout: 5000 });
    return stdout.trim() || 'main';
  } catch { return 'main'; }
}


async function createWorktree(projectRoot, agentId, agentName) {
  if (!(await isGitRepo(projectRoot))) {
    return { ok: false, error: 'Project is not a git repository. Run `git init` first.' };
  }

  const safeName = agentName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30);
  const branchName = `clsclaw/agent-${safeName}-${agentId.slice(0, 8)}`;
  const worktreeDir = path.join(projectRoot, '.clsclaw-worktrees', agentId);

  try {

    const wtParent = path.join(projectRoot, '.clsclaw-worktrees');
    if (!fs.existsSync(wtParent)) fs.mkdirSync(wtParent, { recursive: true });

    const gitignore = path.join(projectRoot, '.gitignore');
    const ignoreEntry = '.clsclaw-worktrees/';
    if (fs.existsSync(gitignore)) {
      const content = fs.readFileSync(gitignore, 'utf-8');
      if (!content.includes(ignoreEntry)) {
        fs.appendFileSync(gitignore, '\n' + ignoreEntry + '\n');
      }
    } else {
      fs.writeFileSync(gitignore, ignoreEntry + '\n');
    }

    await execAsync(
      `git worktree add -b "${branchName}" "${worktreeDir}"`,
      { cwd: projectRoot, timeout: 15000 }
    );

    return {
      ok: true,
      worktreePath: worktreeDir,
      branchName,
      agentId,
    };
  } catch (err) {

    try { fs.rmSync(worktreeDir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: err.message };
  }
}

async function removeWorktree(projectRoot, worktreePath) {
  try {
    await execAsync(
      `git worktree remove --force "${worktreePath}"`,
      { cwd: projectRoot, timeout: 10000 }
    );
    return { ok: true };
  } catch (err) {

    try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch {}
    return { ok: false, error: err.message };
  }
}

async function listWorktrees(projectRoot) {
  try {
    const { stdout } = await execAsync('git worktree list --porcelain', { cwd: projectRoot, timeout: 5000 });
    const worktrees = [];
    const blocks = stdout.trim().split('\n\n');
    for (const block of blocks) {
      const lines = block.split('\n');
      const wt = {};
      for (const line of lines) {
        if (line.startsWith('worktree ')) wt.path = line.slice(9);
        if (line.startsWith('branch ')) wt.branch = line.slice(7);
        if (line === 'bare') wt.bare = true;
        if (line.startsWith('HEAD ')) wt.head = line.slice(5);
      }
      if (wt.path) worktrees.push(wt);
    }
    return { ok: true, worktrees };
  } catch (err) {
    return { ok: false, error: err.message, worktrees: [] };
  }
}

async function mergeWorktree(projectRoot, branchName, strategy = 'merge') {
  try {
    const mainBranch = await getCurrentBranch(projectRoot);
    let cmd;
    if (strategy === 'squash') {
      cmd = `git merge --squash "${branchName}" && git commit -m "Merge agent branch: ${branchName}"`;
    } else if (strategy === 'rebase') {
      cmd = `git rebase "${branchName}"`;
    } else {
      cmd = `git merge --no-ff "${branchName}" -m "Merge agent branch: ${branchName}"`;
    }

    const { stdout, stderr } = await execAsync(cmd, { cwd: projectRoot, timeout: 30000 });
    return { ok: true, stdout, stderr, mainBranch, branchName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getWorktreeDiff(projectRoot, branchName) {
  try {
    const mainBranch = await getCurrentBranch(projectRoot);
    const { stdout } = await execAsync(
      `git diff "${mainBranch}...${branchName}"`,
      { cwd: projectRoot, timeout: 10000 }
    );
    return { ok: true, diff: stdout };
  } catch (err) {
    return { ok: false, error: err.message, diff: '' };
  }
}

module.exports = {
  isGitRepo,
  createWorktree,
  removeWorktree,
  listWorktrees,
  mergeWorktree,
  getWorktreeDiff,
  getCurrentBranch,
};
