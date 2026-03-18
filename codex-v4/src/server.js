/**
 * server.js — Codex Local v4
 * Zero npm dependencies — pure Node.js built-ins only.
 * Requires Node.js 18+ (built-in fetch, crypto.randomUUID)
 */
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const PORT = 3737;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DATA_DIR   = path.join(__dirname, '..', 'data');

['pending','history','index','jobs','versions','memory'].forEach(d =>
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true })
);

// ── Subsystems ────────────────────────────────────────────────────────────────
const broadcaster   = require('./sse');
const sandbox       = require('./sandbox/sandbox');
const permGate      = require('./sandbox/permissions');
const ApprovalQueue = require('./diff/approvalQueue');
const AgentManager  = require('./agents/agentManager');
const Planner       = require('./agents/planner');
const worktrees     = require('./worktrees/worktrees');
const ContextEngine = require('./context/contextEngine');
const SkillRegistry = require('./skills/skills');
const AutoScheduler = require('./automations/automations');
const GitHubClient  = require('./github/github');
const MemoryStore   = require('./memory/memoryStore');
const { diffFileVsProposed, setVersionStore } = require('./diff/diff');
const VersionStore  = require('./versions/versionStore');

// ── App state ─────────────────────────────────────────────────────────────────
let projectRoot = process.env.HOME || require('os').homedir();
let githubToken  = '';

const approvalQueue = new ApprovalQueue(path.join(DATA_DIR, 'history'));
const versionStore  = new VersionStore(path.join(DATA_DIR, 'versions'));
const skillRegistry = new SkillRegistry();
const memoryStore   = new MemoryStore(path.join(DATA_DIR, 'memory'));
const agentManager  = new AgentManager({ approvalQueue, permissionGate: permGate });
const planner       = new Planner({ agentManager, memoryStore });
const contextEngine = new ContextEngine();
const automations   = new AutoScheduler(path.join(DATA_DIR, 'jobs'), skillRegistry);

// Wire cross-dependencies
setVersionStore(versionStore);
automations.setApprovalQueue(approvalQueue);
contextEngine.setIndexDir(path.join(DATA_DIR, 'index'));
agentManager.setMemoryStore(memoryStore);

// ── Wire events → SSE ─────────────────────────────────────────────────────────
function bc(type, payload) { broadcaster.broadcast(type, payload); }

permGate.on('pending',  r => bc('permission:pending',  { request: r }));
permGate.on('approved', r => bc('permission:approved', { request: r }));
permGate.on('rejected', r => bc('permission:rejected', { request: r }));

approvalQueue.on('proposed',          c => bc('change:proposed',          { change: strip(c) }));
approvalQueue.on('approved',          c => bc('change:approved',          { change: strip(c) }));
approvalQueue.on('rejected',          c => bc('change:rejected',          { change: strip(c) }));
approvalQueue.on('conflict_updated',  c => bc('change:conflict_updated',  { change: c }));
approvalQueue.on('conflict_resolved', c => bc('change:conflict_resolved', { change: c }));

agentManager.on('agent:created',  a => bc('agent:created',  { agent: sa(a) }));
agentManager.on('agent:started',  a => bc('agent:started',  { agent: sa(a) }));
agentManager.on('agent:status',   a => bc('agent:status',   { agent: sa(a) }));
agentManager.on('agent:log',      d => bc('agent:log',      d));
agentManager.on('agent:token',    d => bc('agent:token',    d));   // streaming token
agentManager.on('agent:reply',    d => bc('agent:reply',    d));
agentManager.on('agent:proposal', d => bc('agent:proposal', d));
agentManager.on('agent:done',     a => bc('agent:done',     { agent: sa(a) }));
agentManager.on('agent:error',    a => bc('agent:error',    { agent: sa(a) }));
agentManager.on('agent:cancelled',a => bc('agent:cancelled',{ agent: sa(a) }));

planner.on('plan:created',      p => bc('plan:created',      { plan: p }));
planner.on('plan:updated',      p => bc('plan:updated',      { plan: p }));
planner.on('plan:started',      p => bc('plan:started',      { plan: p }));
planner.on('plan:done',         p => bc('plan:done',         { plan: p }));
planner.on('plan:error',        p => bc('plan:error',        { plan: p }));
planner.on('plan:cancelled',    p => bc('plan:cancelled',    { plan: p }));
planner.on('plan:step_started', d => bc('plan:step_started', d));
planner.on('plan:step_done',    d => bc('plan:step_done',    d));
planner.on('plan:step_error',   d => bc('plan:step_error',   d));

automations.on('job:started', j => bc('job:started', { job: j }));
automations.on('job:done',    r => bc('job:done',     { result: r }));

function strip(c) { const { newContent, ...r } = c; return r; }
function sa(a)    { const { worker, ...r } = a;      return r; }

// ── Mime types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.json':'application/json','.png':'image/png','.ico':'image/x-icon',
};

// ── Router ────────────────────────────────────────────────────────────────────
async function router(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method   = req.method.toUpperCase();

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // SSE
  if (pathname === '/api/events') {
    return broadcaster.middleware()(req, res);
  }

  // Static files
  if (!pathname.startsWith('/api/')) {
    const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      // SPA fallback
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    }
    return;
  }

  // Parse JSON body
  let body = {};
  if (method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    body = await readBody(req);
  }

  const q = parsed.query;

  try {
    await handleAPI(pathname, method, body, q, res, req);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

// ── API handler ───────────────────────────────────────────────────────────────
async function handleAPI(pathname, method, body, q, res, req) {

  // ── Config
  if (match(pathname, '/api/config', 'GET')) {
    const sbInfo = await sandbox.getSandboxInfo();
    return json(res, 200, { projectRoot, sandboxInfo: sbInfo, version: '4.0.0' });
  }
  if (match(pathname, '/api/config', 'POST')) {
    const { root, token } = body;
    if (root) {
      if (!fs.existsSync(root)) return json(res, 400, { error: 'Path does not exist' });
      projectRoot = root;
    }
    if (token) githubToken = token;
    return json(res, 200, { ok: true, projectRoot });
  }

  // ── Health — full system status
  if (match(pathname, '/api/health', 'GET')) {
    const sbInfo   = await sandbox.getSandboxInfo();
    const ctxStats = contextEngine.getStats();
    const agents   = agentManager.getAll();
    const pending  = approvalQueue.getPending();
    const perms    = permGate.getPending();
    const jobs     = automations.listJobs();

    // Check git availability
    let gitOk = false;
    try {
      await new Promise((resolve, reject) => {
        require('child_process').exec('git --version', { timeout: 3000 }, (err) => err ? reject(err) : resolve());
      });
      gitOk = true;
    } catch {}

    // Check Docker
    const dockerOk = sbInfo.mode === 'docker';

    const health = {
      version:    '4.0.0',
      status:     'ok',
      timestamp:  new Date().toISOString(),
      projectRoot,
      sandbox: {
        mode:          sbInfo.mode,
        docker:        dockerOk,
        allowedCmds:   sbInfo.allowedCommands?.length || 0,
      },
      git: {
        available: gitOk,
      },
      context: {
        indexed:          ctxStats.indexed || false,
        files:            ctxStats.files   || 0,
        embeddingStatus:  ctxStats.embeddingStatus || 'disabled',
        embeddingChunks:  ctxStats.embeddingChunks || 0,
      },
      agents: {
        total:    agents.length,
        running:  agents.filter(a => a.status === 'running').length,
        queued:   agents.filter(a => a.status === 'queued').length,
        done:     agents.filter(a => a.status === 'done').length,
        error:    agents.filter(a => a.status === 'error').length,
      },
      approvalQueue: {
        pending:   pending.filter(c => c.type !== 'review').length,
        reviews:   pending.filter(c => c.type === 'review').length,
        conflicts: pending.filter(c => c.status === 'conflict').length,
      },
      permissions: {
        pending: perms.length,
        installs: perms.filter(p => p.type === 'install').length,
      },
      automations: {
        jobs:    jobs.length,
        enabled: jobs.filter(j => j.enabled).length,
      },
    };

    // Overall status degrades if there are unresolved conflicts or errors
    if (health.approvalQueue.conflicts > 0) health.status = 'warn';
    if (agents.filter(a => a.status === 'error').length > 0) health.status = 'warn';

    return json(res, 200, health);
  }

  // ── Sandbox info
  if (match(pathname, '/api/sandbox/info', 'GET')) {
    return json(res, 200, await sandbox.getSandboxInfo());
  }

  // Inspect what an install command would install — no execution, no gate
  if (match(pathname, '/api/sandbox/install-check', 'POST')) {
    const installReq = sandbox.detectInstall(body.command || '');
    if (!installReq) return json(res, 200, { isInstall: false });
    return json(res, 200, { isInstall: true, installRequest: installReq });
  }

  // ── File system
  if (match(pathname, '/api/fs/list', 'GET')) {
    const dir = q.dir || projectRoot;
    try {
      sandbox.assertPathSafe(dir, projectRoot);
      const IGNORE = new Set(['node_modules','.git','__pycache__','.DS_Store','.codex-worktrees']);
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => !IGNORE.has(e.name))
        .map(e => {
          const fp = path.join(dir, e.name);
          const isDir = e.isDirectory();
          let size = 0; try { if (!isDir) size = fs.statSync(fp).size; } catch {}
          return { name: e.name, type: isDir ? 'dir' : 'file', path: fp, ext: path.extname(e.name), size };
        })
        .sort((a,b) => a.type !== b.type ? (a.type==='dir'?-1:1) : a.name.localeCompare(b.name));
      return json(res, 200, { entries, cwd: dir, parent: path.dirname(dir) });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (match(pathname, '/api/fs/read', 'GET')) {
    try {
      const content = sandbox.safeReadFile(q.path, projectRoot);
      return json(res, 200, { content, lines: content.split('\n').length, path: q.path });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (match(pathname, '/api/fs/propose', 'POST')) {
    try {
      sandbox.assertPathSafe(body.filePath, projectRoot);
      const pending = await approvalQueue.propose({
        filePath: body.filePath, newContent: body.content,
        agentId: 'manual', agentName: 'You',
        description: body.description || `Edit ${path.basename(body.filePath)}`,
        projectRoot,
      });
      return json(res, 200, pending.skipped ? { skipped: true } : strip(pending));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (match(pathname, '/api/fs/file', 'DELETE')) {
    try {
      await permGate.request({ type:'delete', agentId:'manual', description:`Delete: ${body.path}`, payload:{ filePath: body.path } });
      sandbox.safeDeleteFile(body.path, projectRoot);
      return json(res, 200, { ok: true });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  // ── Approval queue
  if (match(pathname, '/api/changes/pending', 'GET')) {
    return json(res, 200, approvalQueue.getPending());
  }
  if (match(pathname, '/api/changes/history', 'GET')) {
    return json(res, 200, approvalQueue.getHistory(100));
  }
  const changeIdM = pathname.match(/^\/api\/changes\/([^/]+)$/);
  if (changeIdM) {
    const id = changeIdM[1];
    if (method === 'GET') {
      const c = approvalQueue.getPendingById(id);
      return c ? json(res, 200, c) : json(res, 404, { error: 'Not found' });
    }
  }
  const changeActionM = pathname.match(/^\/api\/changes\/([^/]+)\/(approve|reject|edit-approve)$/);
  if (changeActionM) {
    const [, id, action] = changeActionM;
    if (action === 'approve')      return json(res, 200, await approvalQueue.approve(id));
    if (action === 'reject')       return json(res, 200, approvalQueue.reject(id, body.reason));
    if (action === 'edit-approve') return json(res, 200, await approvalQueue.editAndApprove(id, body.content));
  }

  // ── Diff preview
  if (match(pathname, '/api/diff/preview', 'POST')) {
    try {
      sandbox.assertPathSafe(body.filePath, projectRoot);
      return json(res, 200, diffFileVsProposed(body.filePath, body.newContent));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  // ── Version history
  if (match(pathname, '/api/versions/files', 'GET')) {
    return json(res, 200, versionStore.getAllTrackedFiles());
  }
  if (match(pathname, '/api/versions/file', 'GET')) {
    const fp = query.path;
    if (!fp) return json(res, 400, { error: 'path required' });
    try {
      sandbox.assertPathSafe(fp, projectRoot);
      return json(res, 200, versionStore.getVersions(fp));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (match(pathname, '/api/versions/content', 'GET')) {
    const vid = query.versionId;
    if (!vid) return json(res, 400, { error: 'versionId required' });
    const content = versionStore.getContent(vid);
    if (content === null) return json(res, 404, { error: 'Version content not found' });
    return json(res, 200, { content });
  }
  if (match(pathname, '/api/versions/restore', 'POST')) {
    const { versionId } = body;
    if (!versionId) return json(res, 400, { error: 'versionId required' });
    try {
      const result = versionStore.restore(versionId, { agentId: 'manual', agentName: 'You' });
      if (result.ok) {
        bc('file:restored', { filePath: result.filePath, versionId });
      }
      return json(res, 200, result);
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (match(pathname, '/api/versions/diff', 'POST')) {
    // Diff between two version IDs, or a version vs current disk
    const { versionId, compareToVersionId } = body;
    if (!versionId) return json(res, 400, { error: 'versionId required' });
    const contentA = versionStore.getContent(versionId);
    if (contentA === null) return json(res, 404, { error: 'Version not found' });
    let contentB;
    if (compareToVersionId) {
      contentB = versionStore.getContent(compareToVersionId);
      if (contentB === null) return json(res, 404, { error: 'compareToVersionId not found' });
    } else {
      // Compare version vs current disk
      const versions = [...versionStore.getAllTrackedFiles()];
      let filePath = null;
      for (const tf of versions) {
        const fv = versionStore.getVersions(tf.filePath);
        if (fv.find(v => v.versionId === versionId)) { filePath = tf.filePath; break; }
      }
      if (!filePath) return json(res, 404, { error: 'Could not find file for version' });
      contentB = require('fs').existsSync(filePath)
        ? require('fs').readFileSync(filePath, 'utf-8')
        : '';
    }
    const { computeStructuredDiff } = require('./diff/diff');
    return json(res, 200, computeStructuredDiff(contentA, contentB, 'version diff'));
  }

  // ── Permissions
  if (match(pathname, '/api/permissions/pending', 'GET')) {
    return json(res, 200, permGate.getPending());
  }
  if (match(pathname, '/api/permissions/history', 'GET')) {
    return json(res, 200, permGate.getHistory(50));
  }
  const permM = pathname.match(/^\/api\/permissions\/([^/]+)\/(approve|reject)$/);
  if (permM) {
    const [, id, action] = permM;
    if (action === 'approve') return json(res, 200, permGate.approve(id));
    if (action === 'reject')  return json(res, 200, permGate.reject(id, body.reason));
  }

  // ── Exec (permission-gated)
  if (match(pathname, '/api/exec', 'POST')) {
    try {
      const { command, skipApproval } = body;

      if (!skipApproval) {
        // Run through sandbox first — detects installs before executing
        const precheck = await sandbox.runCommand(command, projectRoot);

        if (precheck.isInstall) {
          // Install detected — must go through install gate (separate permission type)
          await permGate.request({
            type:        'install',
            agentId:     'manual',
            description: `Package install: ${command}`,
            payload: {
              command,
              installRequest: precheck.installRequest,
            },
          });
          // Approved — now run for real using runCommandApproved
          return json(res, 200, await sandbox.runCommandApproved(command, projectRoot));
        }

        // Not an install — standard exec gate
        await permGate.request({
          type:        'exec',
          agentId:     'manual',
          description: `Run: ${command}`,
          payload:     { command },
        });
      }

      // skipApproval=true or non-install command approved above
      return json(res, 200, await sandbox.runCommandApproved(command, projectRoot));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  // ── Agents
  if (match(pathname, '/api/agents', 'GET')) {
    return json(res, 200, agentManager.getAll());
  }
  if (match(pathname, '/api/agents', 'POST')) {
    const { task, agentName, useWorktree, contextQuery, apiKey, role } = body;
    if (!task)   return json(res, 400, { error: 'task required' });
    if (!apiKey) return json(res, 400, { error: 'apiKey required' });
    let worktreePath = null;
    if (useWorktree) {
      const tmpId = require('crypto').randomBytes(4).toString('hex');
      const wt = await worktrees.createWorktree(projectRoot, tmpId, agentName || 'agent');
      if (wt.ok) worktreePath = wt.worktreePath;
      else console.warn('[server] Worktree failed:', wt.error);
    }
    let contextFiles = [];
    if (contextQuery && contextEngine.getStats().indexed) {
      const ctx = await contextEngine.query(contextQuery, { maxFiles: 8, maxTokens: 10000, apiKey });
      contextFiles = ctx.files || [];
    }
    // Inject relevant memory for this task
    const memory = memoryStore.query(task, { projectRoot });
    const agent = await agentManager.launch({
      task, agentName, projectRoot, apiKey, contextFiles, worktreePath,
      role: role || 'code',
      memory,
    });
    return json(res, 200, sa(agent));
  }
  const agentIdM = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentIdM) {
    const id = agentIdM[1];
    if (method === 'DELETE') return json(res, 200, agentManager.cancel(id));
  }
  const agentRetryM = pathname.match(/^\/api\/agents\/([^/]+)\/retry$/);
  if (agentRetryM) {
    return json(res, 200, agentManager.retry(agentRetryM[1], projectRoot, body.apiKey));
  }

  // ── Planner
  if (match(pathname, '/api/plans', 'GET')) {
    return json(res, 200, planner.listPlans());
  }
  if (match(pathname, '/api/plans', 'POST')) {
    // Phase 1: generate plan
    const { goal, contextQuery, apiKey } = body;
    if (!goal)   return json(res, 400, { error: 'goal required' });
    if (!apiKey) return json(res, 400, { error: 'apiKey required' });
    try {
      let contextFiles = [];
      if (contextQuery && contextEngine.getStats().indexed) {
        const ctx = await contextEngine.query(contextQuery, { maxFiles: 6, maxTokens: 6000, apiKey });
        contextFiles = ctx.files || [];
      }
      const plan = await planner.generatePlan({ goal, projectRoot, apiKey, contextFiles });
      return json(res, 200, plan);
    } catch (err) { return json(res, 500, { error: err.message }); }
  }
  const planIdM = pathname.match(/^\/api\/plans\/([^/]+)$/);
  if (planIdM) {
    const planId = planIdM[1];
    if (method === 'GET') {
      const p = planner.getPlan(planId);
      return p ? json(res, 200, p) : json(res, 404, { error: 'Plan not found' });
    }
    if (method === 'DELETE') {
      return json(res, 200, planner.cancelPlan(planId));
    }
  }
  const planActionM = pathname.match(/^\/api\/plans\/([^/]+)\/(execute|update)$/);
  if (planActionM) {
    const [, planId, action] = planActionM;
    if (action === 'execute') {
      try { return json(res, 200, await planner.executePlan(planId)); }
      catch (err) { return json(res, 400, { error: err.message }); }
    }
    if (action === 'update') {
      try { return json(res, 200, planner.updatePlan(planId, body.steps)); }
      catch (err) { return json(res, 400, { error: err.message }); }
    }
  }

  // ── Memory
  if (match(pathname, '/api/memory/stats', 'GET')) {
    return json(res, 200, memoryStore.getStats());
  }
  if (match(pathname, '/api/memory/relevant', 'POST')) {
    if (!body.query) return json(res, 400, { error: 'query required' });
    return json(res, 200, { memory: memoryStore.query(body.query) });
  }
  if (match(pathname, '/api/memory/decision', 'POST')) {
    if (!body.text) return json(res, 400, { error: 'text required' });
    memoryStore.recordDecision({
      decision:   body.text,
      reasoning:  body.reasoning || '',
      agentName:  'manual',
      projectRoot,
    });
    return json(res, 200, { ok: true });
  }
  if (match(pathname, '/api/memory/clear', 'POST')) {
    memoryStore.clear();
    return json(res, 200, { ok: true });
  }

  // ── Worktrees
  if (match(pathname, '/api/worktrees', 'GET')) {
    return json(res, 200, await worktrees.listWorktrees(projectRoot));
  }
  if (match(pathname, '/api/worktrees', 'DELETE')) {
    return json(res, 200, await worktrees.removeWorktree(projectRoot, body.worktreePath));
  }
  if (match(pathname, '/api/worktrees/merge', 'POST')) {
    return json(res, 200, await worktrees.mergeWorktree(projectRoot, body.branchName, body.strategy));
  }
  if (match(pathname, '/api/worktrees/diff', 'GET')) {
    return json(res, 200, await worktrees.getWorktreeDiff(projectRoot, q.branch));
  }

  // ── Context engine
  if (match(pathname, '/api/context/index', 'POST')) {
    try {
      const key = body.apiKey || '';
      if (key) contextEngine.setApiKey(key);
      // buildEmbeddings=true only when apiKey present — otherwise keyword-only
      const stats = await contextEngine.buildIndex(projectRoot, {
        apiKey:           key,
        buildEmbeddings:  !!key,
      });
      return json(res, 200, { ok: true, ...stats });
    } catch (err) { return json(res, 500, { error: err.message }); }
  }

  if (match(pathname, '/api/context/stats', 'GET')) {
    return json(res, 200, contextEngine.getStats());
  }

  if (match(pathname, '/api/context/query', 'POST')) {
    if (!body.query) return json(res, 400, { error: 'query required' });
    try {
      const result = await contextEngine.query(body.query, {
        maxFiles:  body.maxFiles  || 10,
        maxTokens: body.maxTokens || 12000,
        apiKey:    body.apiKey    || '',
      });
      return json(res, 200, result);
    } catch (err) { return json(res, 500, { error: err.message }); }
  }

  // Rebuild embeddings for already-indexed project (no file re-read needed)
  if (match(pathname, '/api/context/reindex', 'POST')) {
    const key = body.apiKey || '';
    if (!key) return json(res, 400, { error: 'apiKey required for embedding reindex' });
    try {
      const result = await contextEngine.reindex(key);
      return json(res, 200, result);
    } catch (err) { return json(res, 500, { error: err.message }); }
  }

  // ── Claude proxy
  if (match(pathname, '/api/claude', 'POST')) {
    const { apiKey, messages, system } = body;
    if (!apiKey) return json(res, 400, { error: 'apiKey required' });
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:8096, system, messages }),
      });
      return json(res, 200, await r.json());
    } catch (err) { return json(res, 500, { error: err.message }); }
  }

  // ── Claude streaming endpoint
  if (match(pathname, '/api/claude/stream', 'POST')) {
    const { apiKey, messages, system } = body;
    if (!apiKey) return json(res, 400, { error: 'apiKey required' });

    // Set up SSE headers for this individual response
    res.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (data) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    try {
      const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-20250514',
          max_tokens: 8096,
          stream:     true,
          system,
          messages,
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        sendEvent({ type: 'error', error: `API ${upstream.status}: ${errText}` });
        res.end();
        return;
      }

      // Parse the Anthropic SSE stream line by line
      const reader = upstream.body;
      let buffer = '';

      for await (const chunk of reader) {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              sendEvent({ type: 'token', text: evt.delta.text });
            } else if (evt.type === 'message_stop') {
              sendEvent({ type: 'done' });
            } else if (evt.type === 'error') {
              sendEvent({ type: 'error', error: evt.error?.message || 'Stream error' });
            }
          } catch { /* malformed line — skip */ }
        }
      }

      // Flush any remaining buffer
      if (buffer.startsWith('data: ')) {
        try {
          const evt = JSON.parse(buffer.slice(6).trim());
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            sendEvent({ type: 'token', text: evt.delta.text });
          }
        } catch {}
      }

      sendEvent({ type: 'done' });
      res.end();
    } catch (err) {
      sendEvent({ type: 'error', error: err.message });
      res.end();
    }
    return;
  }

  // ── Streaming exec endpoint — streams stdout/stderr line by line
  if (match(pathname, '/api/exec/stream', 'POST')) {
    const { command, skipApproval } = body;

    // Permission gate (same as /api/exec)
    if (!skipApproval) {
      try {
        const precheck = await sandbox.runCommand(command, projectRoot);
        if (precheck.isInstall) {
          await permGate.request({
            type: 'install', agentId: 'manual',
            description: `Package install: ${command}`,
            payload: { command, installRequest: precheck.installRequest },
          });
        } else {
          await permGate.request({
            type: 'exec', agentId: 'manual',
            description: `Run: ${command}`, payload: { command },
          });
        }
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendLine = (text, stream = 'stdout') => {
      try { res.write(`data: ${JSON.stringify({ type: 'line', text, stream })}\n\n`); } catch {}
    };

    const { spawn: spawnProc } = require('child_process');
    const { assertCommandSafe } = require('./sandbox/sandbox');

    try {
      assertCommandSafe(command);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
      res.end();
      return;
    }

    const proc = spawnProc('sh', ['-c', command], {
      cwd: path.resolve(projectRoot),
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
        NODE_ENV: 'development',
      },
      timeout: 30000,
    });

    proc.stdout.on('data', d => {
      d.toString('utf-8').split('\n').filter(Boolean).forEach(line => sendLine(line, 'stdout'));
    });
    proc.stderr.on('data', d => {
      d.toString('utf-8').split('\n').filter(Boolean).forEach(line => sendLine(line, 'stderr'));
    });
    proc.on('close', code => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'exit', code: code ?? 0 })}\n\n`);
        res.end();
      } catch {}
    });
    proc.on('error', err => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
        res.end();
      } catch {}
    });

    // If client disconnects, kill the process
    req.on('close', () => { try { proc.kill('SIGTERM'); } catch {} });
    return;
  }

  // ── Skills
  if (match(pathname, '/api/skills', 'GET')) {
    return json(res, 200, skillRegistry.list());
  }
  const skillRunM = pathname.match(/^\/api\/skills\/([^/]+)\/run$/);
  if (skillRunM) {
    try {
      return json(res, 200, await skillRegistry.run(skillRunM[1], projectRoot));
    } catch (err) { return json(res, 500, { error: err.message }); }
  }

  // ── Automations
  if (match(pathname, '/api/automations', 'GET')) {
    return json(res, 200, automations.listJobs());
  }
  if (match(pathname, '/api/automations', 'POST')) {
    return json(res, 200, automations.createJob({ ...body, projectRoot }));
  }
  if (match(pathname, '/api/automations/results', 'GET')) {
    return json(res, 200, automations.listResults());
  }
  const autoM = pathname.match(/^\/api\/automations\/([^/]+)$/);
  if (autoM) {
    if (method === 'DELETE') return json(res, 200, automations.deleteJob(autoM[1]));
  }
  const autoActionM = pathname.match(/^\/api\/automations\/([^/]+)\/(trigger|toggle)$/);
  if (autoActionM) {
    const [, id, action] = autoActionM;
    if (action === 'trigger') return json(res, 200, await automations.triggerNow(id));
    if (action === 'toggle') {
      const j = automations.listJobs().find(x => x.id === id);
      if (!j) return json(res, 404, { error: 'Not found' });
      return json(res, 200, j.enabled ? automations.disableJob(id) : automations.enableJob(id));
    }
  }

  // ── GitHub
  function ghClient() {
    const tok = body.token || githubToken;
    if (!tok) throw new Error('GitHub token required');
    return new GitHubClient(tok);
  }

  if (match(pathname, '/api/github/user', 'POST')) {
    try { return json(res, 200, await ghClient().getUser()); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/repos', 'POST')) {
    try { return json(res, 200, await ghClient().listRepos()); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/clone', 'POST')) {
    try {
      const target = body.targetDir || projectRoot;
      sandbox.assertPathSafe(target, projectRoot);
      return json(res, 200, await ghClient().cloneRepo(body.url, target));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/status', 'POST')) {
    try { return json(res, 200, await ghClient().gitStatus(projectRoot)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/push', 'POST')) {
    try {
      await permGate.request({ type:'git', agentId:'manual', description:`git commit "${body.message}" && push`, payload: body });
      return json(res, 200, await ghClient().gitCommitAndPush({ ...body, projectRoot }));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/pr/create', 'POST')) {
    try { return json(res, 200, await ghClient().createPR(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/pr/list', 'POST')) {
    try { return json(res, 200, await ghClient().listPRs(body.owner, body.repo, body.state)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/pr/diff', 'POST')) {
    try { return json(res, 200, { diff: await ghClient().getPRDiff(body.owner, body.repo, body.number) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/pr/review', 'POST')) {
    try { return json(res, 200, await ghClient().submitPRReview(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/pr/merge', 'POST')) {
    try {
      await permGate.request({ type:'git', agentId:'manual', description:`Merge PR #${body.pullNumber}`, payload: body });
      return json(res, 200, await ghClient().mergePR(body));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (match(pathname, '/api/github/branches', 'POST')) {
    try { return json(res, 200, await ghClient().listBranches(body.owner, body.repo)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }

  // 404
  json(res, 404, { error: `Not found: ${pathname}` });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function match(pathname, route, method_) { return pathname === route; }

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 20*1024*1024) req.destroy(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
const server = http.createServer(router);

server.listen(PORT, async () => {
  const sbInfo = await sandbox.getSandboxInfo();
  console.log(`
╔══════════════════════════════════════════════════╗
║        Codex Local v4 — Zero Dependencies        ║
╠══════════════════════════════════════════════════╣
║  URL:      http://localhost:${PORT}                 ║
║  Project:  ${projectRoot.slice(0,38).padEnd(38)} ║
║  Sandbox:  ${sbInfo.mode.padEnd(38)} ║
║  Node:     ${process.version.padEnd(38)} ║
╚══════════════════════════════════════════════════╝
`);
  try { const { exec } = require('child_process'); exec(`open http://localhost:${PORT} 2>/dev/null || xdg-open http://localhost:${PORT} 2>/dev/null || true`); }
  catch {}
});

server.on('error', err => console.error('Server error:', err.message));
