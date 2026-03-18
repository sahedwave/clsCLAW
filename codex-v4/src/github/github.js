/**
 * github.js — Real GitHub API integration
 *
 * Uses GitHub REST API v3.
 * All operations are authenticated with a personal access token.
 * Webhook support requires a public URL — noted honestly below.
 */

'use strict';


const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);
const GH_API = 'https://api.github.com';

class GitHubClient {
  constructor(token) {
    this._token = token;
  }

  _headers() {
    return {
      'Authorization': `token ${this._token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'codex-local-v4',
    };
  }

  async _get(endpoint) {
    const r = await fetch(GH_API + endpoint, { headers: this._headers() });
    if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async _post(endpoint, body) {
    const r = await fetch(GH_API + endpoint, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
    return r.json();
  }

  async _patch(endpoint, body) {
    const r = await fetch(GH_API + endpoint, {
      method: 'PATCH',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
    return r.json();
  }

  // ── User ──────────────────────────────────────────────────────────────────

  async getUser() {
    return this._get('/user');
  }

  // ── Repos ─────────────────────────────────────────────────────────────────

  async listRepos() {
    return this._get('/user/repos?sort=updated&per_page=30&type=all');
  }

  async getRepo(owner, repo) {
    return this._get(`/repos/${owner}/${repo}`);
  }

  // ── Clone ─────────────────────────────────────────────────────────────────

  async cloneRepo(cloneUrl, targetDir) {
    // Inject token into URL for auth
    const authedUrl = cloneUrl.replace('https://', `https://${this._token}@`);
    try {
      const { stdout, stderr } = await execAsync(
        `git clone "${authedUrl}" "${targetDir}"`,
        { timeout: 120000 }
      );
      return { ok: true, stdout, stderr, path: targetDir };
    } catch (err) {
      return { ok: false, error: err.message.replace(this._token, '[REDACTED]') };
    }
  }

  // ── Branches ──────────────────────────────────────────────────────────────

  async listBranches(owner, repo) {
    return this._get(`/repos/${owner}/${repo}/branches`);
  }

  async createBranch(owner, repo, branchName, fromBranch = 'main') {
    // Get SHA of base branch
    const base = await this._get(`/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`);
    const sha = base.object.sha;
    return this._post(`/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha,
    });
  }

  // ── Pull Requests ─────────────────────────────────────────────────────────

  async createPR({ owner, repo, title, body, head, base = 'main', draft = false }) {
    return this._post(`/repos/${owner}/${repo}/pulls`, { title, body, head, base, draft });
  }

  async listPRs(owner, repo, state = 'open') {
    return this._get(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=20`);
  }

  async getPR(owner, repo, number) {
    return this._get(`/repos/${owner}/${repo}/pulls/${number}`);
  }

  async getPRFiles(owner, repo, number) {
    return this._get(`/repos/${owner}/${repo}/pulls/${number}/files`);
  }

  async getPRDiff(owner, repo, number) {
    // Request diff format
    const r = await fetch(`${GH_API}/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { ...this._headers(), 'Accept': 'application/vnd.github.v3.diff' },
    });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    return r.text();
  }

  async addPRReviewComment({ owner, repo, pullNumber, body, commitId, path: filePath, line }) {
    return this._post(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments`, {
      body, commit_id: commitId, path: filePath, line,
    });
  }

  async submitPRReview({ owner, repo, pullNumber, body, event = 'COMMENT' }) {
    // event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
    return this._post(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, { body, event });
  }

  async mergePR({ owner, repo, pullNumber, mergeMethod = 'squash', commitTitle }) {
    return this._post(`/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
      merge_method: mergeMethod,
      commit_title: commitTitle,
    });
  }

  // ── Issues ────────────────────────────────────────────────────────────────

  async listIssues(owner, repo) {
    return this._get(`/repos/${owner}/${repo}/issues?state=open&per_page=20`);
  }

  async createIssue({ owner, repo, title, body, labels = [] }) {
    return this._post(`/repos/${owner}/${repo}/issues`, { title, body, labels });
  }

  // ── Commits ───────────────────────────────────────────────────────────────

  async listCommits(owner, repo, branch = 'main') {
    return this._get(`/repos/${owner}/${repo}/commits?sha=${branch}&per_page=20`);
  }

  // ── Local git operations ──────────────────────────────────────────────────

  async gitStatus(projectRoot) {
    try {
      const { stdout } = await execAsync('git status --porcelain', { cwd: projectRoot, timeout: 5000 });
      const { stdout: branch } = await execAsync('git branch --show-current', { cwd: projectRoot, timeout: 5000 });
      const { stdout: log } = await execAsync('git log --oneline -10', { cwd: projectRoot, timeout: 5000 });
      return { ok: true, status: stdout.trim(), branch: branch.trim(), log: log.trim() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async gitCommitAndPush({ projectRoot, message, branch = 'HEAD', remote = 'origin' }) {
    try {
      await execAsync('git add -A', { cwd: projectRoot, timeout: 10000 });
      const { stdout: commitOut } = await execAsync(
        `git commit -m "${message.replace(/"/g, '\\"')}"`,
        { cwd: projectRoot, timeout: 10000 }
      );
      const { stdout: pushOut } = await execAsync(
        `git push ${remote} ${branch}`,
        { cwd: projectRoot, timeout: 30000 }
      );
      return { ok: true, commit: commitOut.trim(), push: pushOut.trim() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────
  // HONEST NOTE: Webhooks require a public URL (ngrok, a VPS, etc.).
  // The code below registers them correctly, but they will only fire
  // if your server is reachable from the internet.
  // For local-only use, poll-based alternatives are provided instead.

  async registerWebhook({ owner, repo, url, events = ['push', 'pull_request'] }) {
    return this._post(`/repos/${owner}/${repo}/hooks`, {
      name: 'web',
      active: true,
      events,
      config: { url, content_type: 'json', insecure_ssl: '0' },
    });
  }

  // Poll-based PR check (webhook alternative for local use)
  async pollNewPRs(owner, repo, sinceTimestamp) {
    const prs = await this.listPRs(owner, repo);
    return prs.filter(pr => new Date(pr.created_at).getTime() > sinceTimestamp);
  }
}

module.exports = GitHubClient;
