'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ConnectorManager = require('../src/connectors/connectorManager');

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-connectors-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'main.js'), 'console.log("hello");\n', 'utf-8');
  return workspace;
}

function cleanup(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

function makeManager(workspace, overrides = {}) {
  return new ConnectorManager({
    getProjectRoot: () => workspace,
    skillRegistry: overrides.skillRegistry || {
      list: () => [{ id: 'security-audit', name: 'Security audit' }],
      run: async (skillId) => ({ ok: true, skill: skillId, summary: 'ran' }),
    },
    automations: overrides.automations || {
      listJobs: () => [{ id: 'job-1', name: 'Heartbeat review' }],
      listResults: (limit) => [{ id: 'result-1', limit }],
      triggerNow: async (jobId) => ({ ok: true, jobId }),
    },
    contextEngine: overrides.contextEngine || {
      query: async (query, opts) => ({
        mode: 'keyword',
        files: [{ relativePath: 'src/main.js', score: 0.9, content: `match:${query}:${opts.maxFiles}` }],
      }),
    },
    webClient: overrides.webClient || {
      docs: async (query, opts = {}) => ({
        query,
        results: [{
          url: 'https://example.com/docs',
          title: 'Example docs',
          snippet: `doc:${query}:${(opts.domains || []).join(',')}`,
          domain: 'example.com',
        }],
      }),
      open: async (url) => ({
        url,
        title: 'Example docs',
        text: 'Doc body',
        domain: 'example.com',
      }),
    },
    sandbox: overrides.sandbox || {
      assertPathSafe(target, root) {
        const resolved = path.resolve(target);
        const normalizedRoot = path.resolve(root);
        if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
          throw new Error('unsafe path');
        }
      },
      safeReadFile(target, root) {
        this.assertPathSafe(target, root);
        return fs.readFileSync(target, 'utf-8');
      },
    },
    githubClientFactory: overrides.githubClientFactory || (() => ({
      getUser: async () => ({ login: 'shahed' }),
      listRepos: async () => [{ name: 'clsCLAW' }],
      listPRs: async (owner, repo, state) => [{ number: 1, owner, repo, state }],
      listIssues: async (owner, repo) => [{ number: 2, owner, repo }],
      getPRReviewBundle: async (owner, repo, pullNumber) => ({ pull: { number: pullNumber, owner, repo }, files: [], reviews: [], threads: [] }),
      compareCommits: async (owner, repo, base, head) => ({ owner, repo, base, head, status: 'ahead' }),
      searchIssues: async (query) => ({ items: [{ title: query }] }),
      searchRepositories: async (query) => ({ items: [{ full_name: query }] }),
    })),
    githubTokenGetter: overrides.githubTokenGetter || (() => 'gh-test-token'),
  });
}

test('connector catalog exposes workspace, skills, automations, and github', () => {
  const workspace = makeWorkspace();
  try {
    const manager = makeManager(workspace);
    const connectors = manager.list();
    assert.deepEqual(connectors.map((connector) => connector.id), ['workspace', 'skills', 'automations', 'docs', 'github']);
    const github = connectors.find((connector) => connector.id === 'github');
    assert.equal(github.trust.requiresAuth, true);
    assert.equal(github.trust.requiresNetwork, true);
    const workspaceConnector = connectors.find((connector) => connector.id === 'workspace');
    assert.equal(workspaceConnector.trust.level, 'local');
  } finally {
    cleanup(workspace);
  }
});

test('workspace connector can list files and read a file inside the project', async () => {
  const workspace = makeWorkspace();
  try {
    const manager = makeManager(workspace);
    const listResult = await manager.run('workspace', 'list-files', { dir: 'src' });
    const readResult = await manager.run('workspace', 'read-file', { path: 'src/main.js' });

    assert.equal(listResult.ok, true);
    assert.ok(listResult.entries.find((entry) => entry.name === 'main.js'));
    assert.equal(readResult.path, 'src/main.js');
    assert.match(readResult.content, /console\.log/);
  } finally {
    cleanup(workspace);
  }
});

test('connector resources can be listed and read for workspace and docs', async () => {
  const workspace = makeWorkspace();
  try {
    const manager = makeManager(workspace);
    const listedWorkspace = await manager.listResources('workspace', 'files', { dir: 'src' });
    const readWorkspace = await manager.readResource('workspace', 'workspace://src/main.js');
    const listedDocs = await manager.listResources('docs', 'official-docs', { query: 'fetch api', domains: 'developer.mozilla.org' });
    const readDocs = await manager.readResource('docs', listedDocs.items[0].uri);

    assert.ok(listedWorkspace.items.some((item) => item.uri === 'workspace://src/main.js'));
    assert.match(readWorkspace.content, /console\.log/);
    assert.equal(listedDocs.items[0].metadata.domain, 'example.com');
    assert.equal(readDocs.connector, 'docs');
    assert.match(readDocs.content, /Doc body/);
  } finally {
    cleanup(workspace);
  }
});

test('skills connector delegates to the skill registry', async () => {
  const workspace = makeWorkspace();
  try {
    const seen = [];
    const manager = makeManager(workspace, {
      skillRegistry: {
        list: () => [{ id: 'quality-sweep', name: 'Quality sweep' }],
        run: async (skillId, projectRoot) => {
          seen.push({ skillId, projectRoot });
          return { ok: true, skill: skillId };
        },
      },
    });

    const result = await manager.run('skills', 'run-skill', { skillId: 'quality-sweep' });
    assert.equal(result.result.skill, 'quality-sweep');
    assert.deepEqual(seen, [{ skillId: 'quality-sweep', projectRoot: workspace }]);
  } finally {
    cleanup(workspace);
  }
});

test('automations connector can expose and trigger jobs', async () => {
  const workspace = makeWorkspace();
  try {
    const manager = makeManager(workspace);
    const jobs = await manager.run('automations', 'list-jobs');
    const triggered = await manager.run('automations', 'trigger-job', { jobId: 'job-1' });

    assert.equal(jobs.jobs.length, 1);
    assert.equal(triggered.result.jobId, 'job-1');
  } finally {
    cleanup(workspace);
  }
});

test('github connector requires a token and delegates actions to the github client', async () => {
  const workspace = makeWorkspace();
  try {
    const calls = [];
    const manager = makeManager(workspace, {
      githubTokenGetter: () => '',
      githubClientFactory: (token) => ({
        getUser: async () => {
          calls.push({ type: 'user', token });
          return { login: 'shahed' };
        },
        listRepos: async () => [],
        listPRs: async (owner, repo, state) => {
          calls.push({ type: 'prs', token, owner, repo, state });
          return [];
        },
        listIssues: async () => [],
        getPRReviewBundle: async (owner, repo, pullNumber) => {
          calls.push({ type: 'bundle', token, owner, repo, pullNumber });
          return { pull: { number: pullNumber }, files: [], reviews: [], threads: [] };
        },
        compareCommits: async (owner, repo, base, head) => {
          calls.push({ type: 'compare', token, owner, repo, base, head });
          return { status: 'ahead' };
        },
        searchIssues: async (query) => {
          calls.push({ type: 'search', token, query });
          return { items: [] };
        },
      }),
    });

    await assert.rejects(
      manager.run('github', 'user', {}),
      /GitHub token required/
    );

    await manager.run('github', 'list-prs', {
      token: 'gh-inline',
      owner: 'sahedwave',
      repo: 'clsCLAW',
      state: 'open',
    });

    await manager.run('github', 'pr-bundle', {
      token: 'gh-inline',
      owner: 'sahedwave',
      repo: 'clsCLAW',
      pullNumber: 4,
    });

    await manager.run('github', 'compare', {
      token: 'gh-inline',
      owner: 'sahedwave',
      repo: 'clsCLAW',
      base: 'main',
      head: 'feature',
    });

    await manager.run('github', 'search', {
      token: 'gh-inline',
      query: 'repo:sahedwave/clsCLAW is:pr bug',
    });

    assert.deepEqual(calls, [
      {
        type: 'prs',
        token: 'gh-inline',
        owner: 'sahedwave',
        repo: 'clsCLAW',
        state: 'open',
      },
      {
        type: 'bundle',
        token: 'gh-inline',
        owner: 'sahedwave',
        repo: 'clsCLAW',
        pullNumber: 4,
      },
      {
        type: 'compare',
        token: 'gh-inline',
        owner: 'sahedwave',
        repo: 'clsCLAW',
        base: 'main',
        head: 'feature',
      },
      {
        type: 'search',
        token: 'gh-inline',
        query: 'repo:sahedwave/clsCLAW is:pr bug',
      },
    ]);
  } finally {
    cleanup(workspace);
  }
});
