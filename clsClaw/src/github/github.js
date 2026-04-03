'use strict';

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const GH_API = 'https://api.github.com';
const REVIEW_ACCEPT = 'application/vnd.github+json';
const REACTION_ACCEPT = 'application/vnd.github.squirrel-girl-preview+json';

class GitHubClient {
  constructor(token, { fetchImpl = fetch } = {}) {
    this._token = token;
    this._fetch = fetchImpl;
  }

  _headers(accept = REVIEW_ACCEPT) {
    return {
      Authorization: `token ${this._token}`,
      Accept: accept,
      'Content-Type': 'application/json',
      'User-Agent': 'cLoSe',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async _request(endpoint, {
    method = 'GET',
    body = null,
    accept = REVIEW_ACCEPT,
    allowEmpty = false,
  } = {}) {
    const response = await this._fetch(GH_API + endpoint, {
      method,
      headers: this._headers(accept),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    }
    if (allowEmpty || response.status === 204) {
      return null;
    }
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async _get(endpoint, options = {}) {
    return this._request(endpoint, { ...options, method: 'GET' });
  }

  async _post(endpoint, body, options = {}) {
    return this._request(endpoint, { ...options, method: 'POST', body });
  }

  async _patch(endpoint, body, options = {}) {
    return this._request(endpoint, { ...options, method: 'PATCH', body });
  }

  async _paginate(endpoint, { perPage = 100, limit = Infinity } = {}) {
    const results = [];
    let page = 1;
    while (results.length < limit) {
      const joiner = endpoint.includes('?') ? '&' : '?';
      const pageData = await this._get(`${endpoint}${joiner}per_page=${perPage}&page=${page}`);
      if (!Array.isArray(pageData) || !pageData.length) break;
      results.push(...pageData);
      if (pageData.length < perPage) break;
      page += 1;
    }
    return results.slice(0, limit);
  }

  async getUser() {
    return this._get('/user');
  }

  async listRepos() {
    return this._get('/user/repos?sort=updated&per_page=30&type=all');
  }

  async getRepo(owner, repo) {
    return this._get(`/repos/${owner}/${repo}`);
  }

  async cloneRepo(cloneUrl, targetDir) {
    const authedUrl = cloneUrl.replace('https://', `https://${this._token}@`);
    try {
      const { stdout, stderr } = await execAsync(`git clone "${authedUrl}" "${targetDir}"`, { timeout: 120000 });
      return { ok: true, stdout, stderr, path: targetDir };
    } catch (err) {
      return { ok: false, error: err.message.replace(this._token, '[REDACTED]') };
    }
  }

  async listBranches(owner, repo) {
    return this._get(`/repos/${owner}/${repo}/branches`);
  }

  async createBranch(owner, repo, branchName, fromBranch = 'main') {
    const base = await this._get(`/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`);
    return this._post(`/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: base.object.sha,
    });
  }

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
    return this._paginate(`/repos/${owner}/${repo}/pulls/${number}/files`, { perPage: 100, limit: 500 });
  }

  async getPRDiff(owner, repo, number) {
    const response = await this._fetch(`${GH_API}/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { ...this._headers('application/vnd.github.v3.diff') },
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    return response.text();
  }

  async listPRReviews(owner, repo, pullNumber) {
    return this._paginate(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, { perPage: 100, limit: 300 });
  }

  async listPRReviewComments(owner, repo, pullNumber) {
    return this._paginate(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments`, { perPage: 100, limit: 500 });
  }

  async getPRReviewThreads(owner, repo, pullNumber) {
    const comments = await this.listPRReviewComments(owner, repo, pullNumber);
    const byId = new Map(comments.map((comment) => [comment.id, { ...comment, replies: [] }]));
    const roots = [];
    for (const comment of byId.values()) {
      if (comment.in_reply_to_id && byId.has(comment.in_reply_to_id)) {
        byId.get(comment.in_reply_to_id).replies.push(comment);
      } else {
        roots.push(comment);
      }
    }
    return roots.map((root) => ({
      id: root.id,
      path: root.path,
      line: root.line ?? root.original_line ?? null,
      side: root.side || null,
      commitId: root.commit_id || null,
      outdated: Boolean(root.position == null && root.original_position != null),
      root,
      replies: root.replies.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    }));
  }

  async addPRReviewComment({ owner, repo, pullNumber, body, commitId, path: filePath, line, side = 'RIGHT' }) {
    return this._post(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments`, {
      body,
      commit_id: commitId,
      path: filePath,
      line,
      side,
    });
  }

  async replyToReviewComment({ owner, repo, pullNumber, commentId, body }) {
    return this._post(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments/${commentId}/replies`, { body });
  }

  async updateReviewComment({ owner, repo, commentId, body }) {
    return this._patch(`/repos/${owner}/${repo}/pulls/comments/${commentId}`, { body });
  }

  async submitPRReview({ owner, repo, pullNumber, body, event = 'COMMENT', comments = [] }) {
    return this._post(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, { body, event, comments });
  }

  async mergePR({ owner, repo, pullNumber, mergeMethod = 'squash', commitTitle }) {
    return this._post(`/repos/${owner}/${repo}/pulls/${pullNumber}/merge`, {
      merge_method: mergeMethod,
      commit_title: commitTitle,
    });
  }

  async getPRReviewBundle(owner, repo, pullNumber) {
    const [pull, files, reviews, threads] = await Promise.all([
      this.getPR(owner, repo, pullNumber),
      this.getPRFiles(owner, repo, pullNumber),
      this.listPRReviews(owner, repo, pullNumber),
      this.getPRReviewThreads(owner, repo, pullNumber),
    ]);
    return { pull, files, reviews, threads };
  }

  async listIssues(owner, repo, state = 'open') {
    return this._get(`/repos/${owner}/${repo}/issues?state=${state}&per_page=20`);
  }

  async createIssue({ owner, repo, title, body, labels = [] }) {
    return this._post(`/repos/${owner}/${repo}/issues`, { title, body, labels });
  }

  async listIssueComments(owner, repo, issueNumber) {
    return this._paginate(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { perPage: 100, limit: 500 });
  }

  async addIssueComment({ owner, repo, issueNumber, body }) {
    return this._post(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
  }

  async updateIssueComment({ owner, repo, commentId, body }) {
    return this._patch(`/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
  }

  async listCommits(owner, repo, branch = 'main') {
    return this._get(`/repos/${owner}/${repo}/commits?sha=${branch}&per_page=20`);
  }

  async compareCommits(owner, repo, base, head) {
    return this._get(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  }

  async searchRepositories(query, { limit = 10 } = {}) {
    return this._get(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 50)}`);
  }

  async searchIssues(query, { limit = 10, sort = 'updated', order = 'desc' } = {}) {
    return this._get(`/search/issues?q=${encodeURIComponent(query)}&sort=${sort}&order=${order}&per_page=${Math.min(limit, 50)}`);
  }

  async addReaction({ owner, repo, target, targetId, content }) {
    const endpoint = reactionEndpoint({ owner, repo, target, targetId });
    return this._post(endpoint, { content }, { accept: REACTION_ACCEPT });
  }

  async listReactions({ owner, repo, target, targetId }) {
    const endpoint = reactionEndpoint({ owner, repo, target, targetId });
    return this._paginate(endpoint, { perPage: 100, limit: 200 });
  }

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
      const { stdout: commitOut } = await execAsync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: projectRoot,
        timeout: 10000,
      });
      const { stdout: pushOut } = await execAsync(`git push ${remote} ${branch}`, {
        cwd: projectRoot,
        timeout: 30000,
      });
      return { ok: true, commit: commitOut.trim(), push: pushOut.trim() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async registerWebhook({ owner, repo, url, events = ['push', 'pull_request'] }) {
    return this._post(`/repos/${owner}/${repo}/hooks`, {
      name: 'web',
      active: true,
      events,
      config: { url, content_type: 'json', insecure_ssl: '0' },
    });
  }

  async pollNewPRs(owner, repo, sinceTimestamp) {
    const prs = await this.listPRs(owner, repo);
    return prs.filter((pr) => new Date(pr.created_at).getTime() > sinceTimestamp);
  }
}

function reactionEndpoint({ owner, repo, target, targetId }) {
  switch (target) {
    case 'issue':
    case 'pull':
      return `/repos/${owner}/${repo}/issues/${targetId}/reactions`;
    case 'issue_comment':
      return `/repos/${owner}/${repo}/issues/comments/${targetId}/reactions`;
    case 'review_comment':
      return `/repos/${owner}/${repo}/pulls/comments/${targetId}/reactions`;
    default:
      throw new Error(`Unsupported reaction target: ${target}`);
  }
}

module.exports = GitHubClient;
