
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

['pending','history','index','jobs','versions','memory','turns','uploads'].forEach(d =>
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true })
);


const broadcaster   = require('./sse');
const sandbox       = require('./sandbox/sandbox');
const permGate      = require('./sandbox/permissions');
const ApprovalQueue = require('./diff/approvalQueue');
const AgentManager  = require('./agents/agentManager');
const Planner       = require('./agents/planner');
const { SwarmCoordinator } = require('./agents/swarmCoordinator');
const worktrees     = require('./worktrees/worktrees');
const ContextEngine = require('./context/contextEngine');
const SkillRegistry = require('./skills/skills');
const AutoScheduler = require('./automations/automations');
const GitHubClient  = require('./github/github');
const MemoryStore   = require('./memory/memoryStore');
const { diffFileVsProposed, setVersionStore } = require('./diff/diff');
const { materializePatchDocument } = require('./diff/patchProposal');
const { ExtensionManager } = require('./extensions/extensionManager');
const ConnectorManager = require('./connectors/connectorManager');
const { WebClient } = require('./web/webClient');
const { ImageStore } = require('./media/imageStore');
const { ArtifactStore } = require('./artifacts/artifactStore');
const TurnTraceStore = require('./orchestration/turnTraceStore');
const { ToolRuntime } = require('./orchestration/toolRuntime');
const { TurnOrchestrator } = require('./orchestration/turnOrchestrator');
const VersionStore  = require('./versions/versionStore');
const modelRouter   = require('./llm/modelRouter');
const {
  buildPolicySystem,
  maybeAnswerCanonicalQuestion,
  hasAttachedContext,
} = require('./llm/replyPolicy');
const {
  getIdentityTemplates,
  readIdentityFiles,
  ensureIdentityFiles,
  writeIdentityFile,
  readIdentityContext,
} = require('./workspaceIdentity');
const { auditWorkspace, applyAuditFixes } = require('./security/workspaceAudit');
const {
  loadConfig,
  saveConfig,
  maskApiKey,
  resolveProviderConfig,
  getMaskedProviderConfig,
  getProviderStatus,
} = require('./configStore');


const storedConfig = loadConfig();
let projectRoot = storedConfig.projectRoot || process.env.HOME || require('os').homedir();
let githubToken  = storedConfig.githubToken || process.env.GITHUB_TOKEN || '';
let providerConfig = resolveProviderConfig(storedConfig);
let lastSystemError = null;

const approvalQueue = new ApprovalQueue(path.join(DATA_DIR, 'history'));
const versionStore  = new VersionStore(path.join(DATA_DIR, 'versions'));
const skillRegistry = new SkillRegistry();
const extensionManager = new ExtensionManager(path.join(DATA_DIR, 'extensions'));
const memoryStore   = new MemoryStore(path.join(DATA_DIR, 'memory'));
const agentManager  = new AgentManager({ approvalQueue, permissionGate: permGate });
const planner       = new Planner({ agentManager, memoryStore });
const swarmCoordinator = new SwarmCoordinator({ agentManager });
skillRegistry.setExtensionManager(extensionManager);
extensionManager.setSkillRegistry(skillRegistry);
const contextEngine = new ContextEngine();
const automations   = new AutoScheduler(path.join(DATA_DIR, 'jobs'), skillRegistry);
const webClient = new WebClient();
const connectorManager = new ConnectorManager({
  getProjectRoot: () => projectRoot,
  skillRegistry,
  automations,
  contextEngine,
  githubClientFactory: (token) => new GitHubClient(token),
  sandbox,
  webClient,
  githubTokenGetter: () => githubToken,
});
const imageStore = new ImageStore(path.join(DATA_DIR, 'uploads'));
const artifactStore = new ArtifactStore(path.join(DATA_DIR, 'artifacts'));
const turnTraceStore = new TurnTraceStore(path.join(DATA_DIR, 'turns'));
const toolRuntime = new ToolRuntime({
  projectRootGetter: () => projectRoot,
  contextEngine,
  connectorManager,
  sandbox,
  webClient,
  visionAnalyzer: async ({ prompt, providers, messages, signal }) => modelRouter.call({
    role: 'analyze',
    system: [
      'You are analyzing one or more attached images or screenshots for a software engineering workflow.',
      'Describe only what is visibly supported by the image.',
      'If something is unclear, say so explicitly.',
      'Focus on UI states, errors, text shown, controls, layout, and details relevant to the user request.',
    ].join('\n'),
    messages: [
      ...messages,
      {
        role: 'user',
        content: [{ type: 'text', text: `Image analysis request:\n${prompt}` }],
      },
    ],
    apiKey: providers,
    stream: false,
    signal,
  }),
});
const turnOrchestrator = new TurnOrchestrator({
  modelRouter,
  toolRuntime,
  traceStore: turnTraceStore,
});

setVersionStore(versionStore);
automations.setApprovalQueue(approvalQueue);
automations.setMemoryStore(memoryStore);
automations.setWebClient(webClient);
automations.setArtifactStore(artifactStore);
contextEngine.setIndexDir(path.join(DATA_DIR, 'index'));
if (providerConfig.anthropic) contextEngine.setApiKey(providerConfig.anthropic);
contextEngine.setProviderConfig(providerConfig);
agentManager.setMemoryStore(memoryStore);

function bc(type, payload) { broadcaster.broadcast(type, payload); }
function setLastSystemError(message, meta = {}) {
  lastSystemError = {
    message: String(message || 'Unknown system error'),
    at: new Date().toISOString(),
    ...meta,
  };
}

function resolveModelProviders(preferred = null) {
  return resolveProviderConfig(preferred || providerConfig);
}

function createRequestController(req, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out')), timeoutMs);
  req.on('close', () => controller.abort(new Error('Client disconnected')));
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
    },
  };
}

function getWorkspaceIdentityPrompt() {
  const identity = readIdentityContext(projectRoot, { maxCharsPerFile: 1200 });
  return identity ? `Workspace identity:\n${identity}` : '';
}

function hasModelProvider(preferred = null) {
  const resolved = resolveModelProviders(preferred);
  return Boolean(resolved.anthropic || resolved.openai || resolved.ollamaUrl || resolved.ollamaModel);
}

async function probeOllama(localUrl) {
  const candidate = localUrl || process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
  try {
    const base = new URL(candidate);
    base.pathname = '/api/tags';
    base.search = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const response = await fetch(base, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

function flattenMessages(messages = []) {
  if (!Array.isArray(messages)) return '';
  return messages.map((msg) => {
    const role = msg?.role || 'user';
    const content = Array.isArray(msg?.content)
      ? msg.content.map((part) => part?.text || '').join('\n')
      : String(msg?.content || '');
    return `${role.toUpperCase()}:\n${content}`.trim();
  }).join('\n\n');
}

async function getAutoContextPrompt({ policy, messages = [], providers = {} } = {}) {
  if (!policy?.userText) return '';
  if (hasAttachedContext(messages)) return '';
  if (!contextEngine.getStats().indexed) return '';
  if (!['repo_analysis', 'review', 'build', 'test', 'docs', 'plan'].includes(policy.intent)) return '';

  try {
    const ctx = await contextEngine.query(policy.userText, {
      maxFiles: policy.intent === 'review' ? 10 : 8,
      maxTokens: policy.intent === 'build' ? 10000 : 8000,
      providerConfig: providers,
    });
    if (!ctx.files?.length) return '';
    return [
      'Auto-inspected workspace context:',
      `Mode: ${ctx.mode}`,
      ...ctx.files.map((file) => `FILE: ${file.relativePath} (score:${Math.round(file.score * 100) / 100})\n${file.content}`),
    ].join('\n\n');
  } catch {
    return '';
  }
}

async function resolveContextFilesForTask(contextQuery, providers, { maxFiles = 8, maxTokens = 10000 } = {}) {
  if (!contextQuery || !contextEngine.getStats().indexed) return [];
  const ctx = await contextEngine.query(contextQuery, {
    maxFiles,
    maxTokens,
    providerConfig: providers,
  });
  return ctx.files || [];
}

function buildExecPermissionRequest(command, assessment, { agentId = 'manual' } = {}) {
  const type = assessment.isInstall ? 'install' : 'exec';
  const description = assessment.isInstall
    ? `Package install: ${command}`
    : assessment.requiresEscalation
      ? `Run with host escalation: ${command}`
      : `Run: ${command}`;
  return {
    type,
    agentId,
    description,
    payload: {
      command,
      installRequest: assessment.installRequest || undefined,
      executionMode: assessment.executionMode,
      requiresEscalation: assessment.requiresEscalation,
      escalationReason: assessment.escalationReason || '',
      sandboxMode: assessment.sandboxMode,
      timeoutMs: assessment.timeoutMs,
    },
  };
}

async function ensureCommandPermission({ command, projectRoot, skipApproval, agentId = 'manual' } = {}) {
  const assessment = await sandbox.assessCommand(command, projectRoot);
  if (skipApproval && !assessment.requiresEscalation) {
    return assessment;
  }
  await permGate.request(buildExecPermissionRequest(command, assessment, { agentId }));
  return assessment;
}

permGate.on('pending',  r => bc('permission:pending',  { request: r }));
permGate.on('approved', r => bc('permission:approved', { request: r }));
permGate.on('rejected', r => bc('permission:rejected', { request: r }));

approvalQueue.on('proposed',          c => bc('change:proposed',          { change: strip(c) }));
approvalQueue.on('approved',          c => bc('change:approved',          { change: strip(c) }));
approvalQueue.on('rejected',          c => bc('change:rejected',          { change: strip(c) }));
approvalQueue.on('updated',           c => bc('change:updated',           { change: c }));
approvalQueue.on('conflict_updated',  c => bc('change:conflict_updated',  { change: c }));
approvalQueue.on('conflict_resolved', c => bc('change:conflict_resolved', { change: c }));

agentManager.on('agent:created',  a => bc('agent:created',  { agent: sa(a) }));
agentManager.on('agent:started',  a => bc('agent:started',  { agent: sa(a) }));
agentManager.on('agent:status',   a => bc('agent:status',   { agent: sa(a) }));
agentManager.on('agent:log',      d => bc('agent:log',      d));
agentManager.on('agent:token',    d => bc('agent:token',    d));   // streaming token
agentManager.on('agent:reply',    d => bc('agent:reply',    d));
agentManager.on('agent:decision', d => bc('agent:decision', d));
agentManager.on('agent:proposal', d => bc('agent:proposal', d));
agentManager.on('agent:meta',     d => bc('agent:meta',     d));
agentManager.on('agent:redirected', d => bc('agent:redirected', d));
agentManager.on('agent:input_queued', d => bc('agent:input_queued', d));
agentManager.on('agent:input_started', d => bc('agent:input_started', d));
agentManager.on('agent:failure_analysis', d => bc('agent:failure_analysis', d));
agentManager.on('agent:done',     a => bc('agent:done',     { agent: sa(a) }));
agentManager.on('agent:error',    a => bc('agent:error',    { agent: sa(a) }));
agentManager.on('agent:cancelled',a => bc('agent:cancelled',{ agent: sa(a) }));
agentManager.on('agent:closed',   d => bc('agent:closed',   d));

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
automations.on('notification:new', (n) => bc('notification:new', { notification: n }));
automations.on('notification:updated', (n) => bc('notification:updated', { notification: n }));

function strip(c) { const { newContent, ...r } = c; return r; }
function sa(a)    { const { worker, ...r } = a;      return r; }

const MIME = {
  '.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon',
};

async function router(req, res) {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method   = req.method.toUpperCase();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/api/events') {
    return broadcaster.middleware()(req, res);
  }

  if (!pathname.startsWith('/api/')) {
    const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      fs.createReadStream(filePath).pipe(res);
    } else {

      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    }
    return;
  }

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

async function handleAPI(pathname, method, body, q, res, req) {
  const is = (route, expectedMethod) => pathname === route && method === expectedMethod;
  const uploadMatch = pathname.match(/^\/api\/uploads\/([a-z0-9-]+)$/i);

  if (uploadMatch && method === 'GET') {
    try {
      const attachment = imageStore.readAttachment(uploadMatch[1]);
      res.writeHead(200, {
        'Content-Type': attachment.mimeType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(attachment.buffer);
      return;
    } catch (err) {
      return json(res, 404, { error: err.message });
    }
  }

  if (is('/api/config', 'GET')) {
    const sbInfo = await sandbox.getSandboxInfo();
    return json(res, 200, {
      projectRoot,
      sandboxInfo: sbInfo,
      version: '4.0.0',
      providers: {
        ...getMaskedProviderConfig(providerConfig),
        ...getProviderStatus(providerConfig),
      },
      githubConfigured: Boolean(githubToken),
    });
  }
  if (is('/api/config', 'POST')) {
    const {
      root,
      token,
      githubToken: nextGithubToken,
      apiKey,
      anthropicKey,
      openaiKey,
      ollamaUrl,
      ollamaModel,
      embeddingProvider,
    } = body;
    if (root) {
      if (!fs.existsSync(root)) return json(res, 400, { error: 'Path does not exist' });
      projectRoot = root;
    }
    const resolvedInput = {};
    if (Object.prototype.hasOwnProperty.call(body, 'anthropicKey')) resolvedInput.anthropicKey = anthropicKey;
    else if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) resolvedInput.anthropicKey = apiKey;
    if (Object.prototype.hasOwnProperty.call(body, 'openaiKey')) resolvedInput.openaiKey = openaiKey;
    if (Object.prototype.hasOwnProperty.call(body, 'githubToken')) resolvedInput.githubToken = nextGithubToken;
    else if (Object.prototype.hasOwnProperty.call(body, 'token')) resolvedInput.githubToken = token;
    if (Object.prototype.hasOwnProperty.call(body, 'ollamaUrl')) resolvedInput.ollamaUrl = ollamaUrl;
    if (Object.prototype.hasOwnProperty.call(body, 'ollamaModel')) resolvedInput.ollamaModel = ollamaModel;
    if (Object.prototype.hasOwnProperty.call(body, 'embeddingProvider')) resolvedInput.embeddingProvider = embeddingProvider;
    const resolvedProviders = resolveProviderConfig(resolvedInput);
    providerConfig = {
      ...providerConfig,
      ...resolvedProviders,
    };
    githubToken = resolvedProviders.githubToken;
    contextEngine.setProviderConfig(providerConfig);
    saveConfig({
      projectRoot,
      anthropicKey: providerConfig.anthropic,
      openaiKey: providerConfig.openai,
      githubToken,
      ollamaUrl: providerConfig.ollamaUrl,
      ollamaModel: providerConfig.ollamaModel,
      embeddingProvider: providerConfig.embeddingProvider,
    });
    return json(res, 200, {
      ok: true,
      projectRoot,
      providers: {
        ...getMaskedProviderConfig(providerConfig),
        ...getProviderStatus(providerConfig),
      },
      githubConfigured: Boolean(githubToken),
    });
  }

  if (is('/api/config/providers', 'GET')) {
    return json(res, 200, {
      providers: {
        ...getMaskedProviderConfig(providerConfig),
        ...getProviderStatus(providerConfig),
      },
      githubConfigured: Boolean(githubToken),
    });
  }
  if (is('/api/config/providers', 'POST')) {
    const payload = {};
    if (Object.prototype.hasOwnProperty.call(body, 'anthropicKey')) payload.anthropicKey = body.anthropicKey;
    if (Object.prototype.hasOwnProperty.call(body, 'openaiKey')) payload.openaiKey = body.openaiKey;
    if (Object.prototype.hasOwnProperty.call(body, 'githubToken')) payload.githubToken = body.githubToken;
    else if (Object.prototype.hasOwnProperty.call(body, 'token')) payload.githubToken = body.token;
    if (Object.prototype.hasOwnProperty.call(body, 'ollamaUrl')) payload.ollamaUrl = body.ollamaUrl;
    if (Object.prototype.hasOwnProperty.call(body, 'ollamaModel')) payload.ollamaModel = body.ollamaModel;
    if (Object.prototype.hasOwnProperty.call(body, 'embeddingProvider')) payload.embeddingProvider = body.embeddingProvider;
    providerConfig = resolveProviderConfig(payload);
    githubToken = providerConfig.githubToken;
    contextEngine.setProviderConfig(providerConfig);
    saveConfig({
      ...loadConfig(),
      anthropicKey: providerConfig.anthropic,
      openaiKey: providerConfig.openai,
      githubToken,
      ollamaUrl: providerConfig.ollamaUrl,
      ollamaModel: providerConfig.ollamaModel,
      embeddingProvider: providerConfig.embeddingProvider,
    });
    return json(res, 200, {
      ok: true,
      providers: {
        ...getMaskedProviderConfig(providerConfig),
        ...getProviderStatus(providerConfig),
      },
      githubConfigured: Boolean(githubToken),
    });
  }

  if (is('/api/config/api-key', 'GET')) {
    const cfg = providerConfig;
    return json(res, 200, {
      anthropicKey: maskApiKey(cfg.anthropic || ''),
      hasKey: !!cfg.anthropic,
    });
  }
  if (is('/api/config/api-key', 'POST')) {
    const anthropicKey = String(body.anthropicKey || '').trim();
    if (!anthropicKey) return json(res, 400, { error: 'anthropicKey required' });
    providerConfig = { ...providerConfig, anthropic: anthropicKey };
    contextEngine.setProviderConfig(providerConfig);
    saveConfig({ ...loadConfig(), anthropicKey });
    return json(res, 200, { ok: true, anthropicKey: maskApiKey(anthropicKey) });
  }

  if (is('/api/turns/recent', 'GET')) {
    return json(res, 200, turnTraceStore.listRecent(Number(q.limit) || 20));
  }
  const turnIdM = pathname.match(/^\/api\/turns\/([^/]+)$/);
  if (turnIdM && method === 'GET') {
    const turn = turnTraceStore.getTurn(turnIdM[1]);
    if (!turn) return json(res, 404, { error: 'Turn not found' });
    return json(res, 200, turn);
  }

  if (is('/api/health', 'GET')) {
    const sbInfo   = await sandbox.getSandboxInfo();
    const ctxStats = contextEngine.getStats();
    const agents   = agentManager.getAll();
    const pending  = approvalQueue.getPending();
    const perms    = permGate.getPending();
    const jobs     = automations.listJobs();
    const providerStatus = getProviderStatus(providerConfig);
    const ollamaReachable = await probeOllama(providerConfig.ollamaUrl);

    let gitOk = false;
    try {
      await new Promise((resolve, reject) => {
        require('child_process').exec('git --version', { timeout: 3000 }, (err) => err ? reject(err) : resolve());
      });
      gitOk = true;
    } catch {}

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
        embeddingProviderSelected: ctxStats.embeddingProviderSelected || 'auto',
        embeddingProviderActive: ctxStats.embeddingProviderActive || null,
        embeddingProviderModel: ctxStats.embeddingProviderModel || null,
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
        escalations: perms.filter(p => p.payload?.requiresEscalation).length,
      },
      automations: {
        jobs:    jobs.length,
        enabled: jobs.filter(j => j.enabled).length,
      },
      identity: {
        files: readIdentityFiles(projectRoot, { includeContent: false }).filter((file) => file.exists).length,
      },
      providers: {
        ...providerStatus,
        ollamaReachable,
      },
      llmReady: Boolean(providerStatus.anthropicConfigured || providerStatus.openaiConfigured || ollamaReachable),
      apiKeyLoaded: Boolean(providerStatus.anthropicConfigured || providerStatus.openaiConfigured),
      agentsRunning: agentManager.getRunningCount(),
      queueSize: agentManager.getQueueSize(),
      lastError: lastSystemError,
    };

    if (health.approvalQueue.conflicts > 0) health.status = 'warn';
    if (agents.filter(a => a.status === 'error').length > 0) health.status = 'warn';
    if (!health.llmReady) health.status = 'warn';

    return json(res, 200, health);
  }

  if (is('/api/sandbox/info', 'GET')) {
    return json(res, 200, await sandbox.getSandboxInfo());
  }
  if (is('/api/sandbox/assess', 'POST')) {
    try {
      return json(res, 200, await sandbox.assessCommand(body.command, projectRoot));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (is('/api/web/search', 'POST')) {
    try {
      return json(res, 200, await webClient.search(body.query, {
        limit: body.limit,
        domains: body.domains,
      }));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (is('/api/web/open', 'POST')) {
    try {
      return json(res, 200, await webClient.open(body.url));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (is('/api/web/docs', 'POST')) {
    try {
      return json(res, 200, await webClient.docs(body.query, {
        domains: body.domains,
        limit: body.limit,
      }));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (is('/api/uploads/image', 'POST')) {
    try {
      if (!body.dataUrl) return json(res, 400, { error: 'dataUrl required' });
      return json(res, 200, imageStore.saveDataUrl({
        dataUrl: body.dataUrl,
        name: body.name,
      }));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (is('/api/identity', 'GET')) {
    return json(res, 200, {
      templates: getIdentityTemplates(),
      files: readIdentityFiles(projectRoot, { includeContent: true }),
    });
  }
  if (is('/api/identity/bootstrap', 'POST')) {
    const names = Array.isArray(body.names) && body.names.length
      ? body.names.filter((name) => typeof name === 'string')
      : undefined;
    const created = ensureIdentityFiles(projectRoot, names);
    return json(res, 200, {
      ok: true,
      created,
      files: readIdentityFiles(projectRoot, { includeContent: true }),
    });
  }
  if (is('/api/identity/file', 'POST')) {
    if (!body.name) return json(res, 400, { error: 'name required' });
    writeIdentityFile(projectRoot, body.name, body.content || '');
    return json(res, 200, {
      ok: true,
      files: readIdentityFiles(projectRoot, { includeContent: true }),
    });
  }

  if (is('/api/security/audit', 'GET')) {
    return json(res, 200, auditWorkspace({
      projectRoot,
      sandboxInfo: await sandbox.getSandboxInfo(),
      providerStatus: getProviderStatus(providerConfig),
      automations: automations.listJobs(),
    }));
  }
  if (is('/api/security/audit/fix', 'POST')) {
    const result = applyAuditFixes(projectRoot);
    return json(res, 200, {
      ok: true,
      result,
      report: auditWorkspace({
        projectRoot,
        sandboxInfo: await sandbox.getSandboxInfo(),
        providerStatus: getProviderStatus(providerConfig),
        automations: automations.listJobs(),
      }),
    });
  }

  if (is('/api/heartbeat/setup', 'POST')) {
    ensureIdentityFiles(projectRoot, ['IDENTITY.md', 'USER.md', 'SOUL.md', 'AGENTS.md', 'HEARTBEAT.md']);
    const existing = automations.listJobs().find((job) => job.skillId === 'heartbeat-review');
    if (existing) return json(res, 200, { ok: true, created: false, job: existing });
    return json(res, 200, automations.createJob({
      name: 'Heartbeat review',
      cronExpr: body.cronExpr || '*/30 * * * *',
      type: 'skill',
      skillId: 'heartbeat-review',
      projectRoot,
    }));
  }
  if (is('/api/heartbeat/presets', 'GET')) {
    return json(res, 200, automations.getHeartbeatPresets());
  }
  if (is('/api/heartbeat/create', 'POST')) {
    const presetId = String(body.presetId || '').trim();
    const preset = automations.getHeartbeatPresets().find((item) => item.id === presetId);
    if (!preset) return json(res, 404, { error: 'Unknown heartbeat preset' });
    return json(res, 200, automations.createJob({
      name: body.name || preset.name,
      cronExpr: body.cronExpr || preset.cronExpr,
      type: 'heartbeat',
      heartbeatKind: preset.id,
      options: {
        ...(preset.options || {}),
        ...((body.options && typeof body.options === 'object') ? body.options : {}),
      },
      projectRoot,
    }));
  }

  if (is('/api/sandbox/install-check', 'POST')) {
    const installReq = sandbox.detectInstall(body.command || '');
    if (!installReq) return json(res, 200, { isInstall: false });
    return json(res, 200, { isInstall: true, installRequest: installReq });
  }

  if (is('/api/fs/list', 'GET')) {
    const dir = q.dir || projectRoot;
    try {
      sandbox.assertPathSafe(dir, projectRoot);
      const IGNORE = new Set(['node_modules','.git','__pycache__','.DS_Store','.clsclaw-worktrees']);
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

  if (is('/api/fs/read', 'GET')) {
    try {
      const content = sandbox.safeReadFile(q.path, projectRoot);
      return json(res, 200, { content, lines: content.split('\n').length, path: q.path });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (is('/api/fs/propose', 'POST')) {
    try {
      sandbox.assertPathSafe(body.filePath, projectRoot);
      const pending = await approvalQueue.propose({
        filePath: body.filePath, newContent: body.content,
        agentId: 'manual', agentName: 'You',
        description: body.description || `Edit ${path.basename(body.filePath)}`,
        projectRoot,
        approvalContext: body.approvalContext || null,
      });
      return json(res, 200, pending.skipped ? { skipped: true } : strip(pending));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (is('/api/fs/propose-patch', 'POST')) {
    try {
      if (!body.patchText) return json(res, 400, { error: 'patchText required' });
      const proposals = materializePatchDocument(body.patchText, projectRoot);
      const created = [];
      for (const proposal of proposals) {
        sandbox.assertPathSafe(proposal.filePath, projectRoot);
        const pending = await approvalQueue.propose({
          filePath: proposal.filePath,
          newContent: proposal.content,
          agentId: 'manual',
          agentName: 'You',
          description: `Patch ${path.basename(proposal.filePath)}`,
          projectRoot,
          approvalContext: body.approvalContext || null,
        });
        if (!pending.skipped) created.push(strip(pending));
      }
      return json(res, 200, { ok: true, changes: created });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (is('/api/fs/file', 'DELETE')) {
    try {
      await permGate.request({ type:'delete', agentId:'manual', description:`Delete: ${body.path}`, payload:{ filePath: body.path } });
      sandbox.safeDeleteFile(body.path, projectRoot);
      return json(res, 200, { ok: true });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  if (is('/api/changes/pending', 'GET')) {
    return json(res, 200, approvalQueue.getPending());
  }
  if (is('/api/changes/history', 'GET')) {
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
  const changeGithubReviewM = pathname.match(/^\/api\/changes\/([^/]+)\/github-review$/);
  if (changeGithubReviewM && method === 'POST') {
    try {
      const change = approvalQueue.getPendingById(changeGithubReviewM[1]);
      if (!change || change.type !== 'review') return json(res, 404, { error: 'Review item not found' });
      if (!body.owner || !body.repo || !body.pullNumber) {
        return json(res, 400, { error: 'owner, repo, and pullNumber are required' });
      }
      const selectedIds = Array.isArray(body.commentIds) && body.commentIds.length
        ? new Set(body.commentIds.map(String))
        : null;
      const comments = (change.inlineComments || [])
        .filter((comment) => !selectedIds || selectedIds.has(String(comment.id)))
        .filter((comment) => Number.isInteger(comment.currentStart))
        .map((comment) => ({
          path: comment.file,
          line: comment.currentStart,
          body: `${comment.title}\n\n${comment.body}`.trim(),
        }));
      if (!comments.length) {
        return json(res, 400, { error: 'No anchored inline comments available to send' });
      }
      const reviewResult = await ghClient().submitPRReview({
        owner: body.owner,
        repo: body.repo,
        pullNumber: body.pullNumber,
        body: body.body || change.summary || 'Inline review from clsClaw',
        event: body.event || 'COMMENT',
        comments,
      });
      approvalQueue.updateReviewMetadata(change.id, {
        githubReview: {
          owner: body.owner,
          repo: body.repo,
          pullNumber: body.pullNumber,
          event: body.event || 'COMMENT',
          commentCount: comments.length,
          reviewId: reviewResult?.id || null,
          state: reviewResult?.state || 'submitted',
          submittedAt: Date.now(),
          url: `https:
        },
      });
      return json(res, 200, reviewResult);
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  
  if (is('/api/diff/preview', 'POST')) {
    try {
      sandbox.assertPathSafe(body.filePath, projectRoot);
      return json(res, 200, diffFileVsProposed(body.filePath, body.newContent));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  
  if (is('/api/versions/files', 'GET')) {
    return json(res, 200, versionStore.getAllTrackedFiles());
  }
  if (is('/api/versions/file', 'GET')) {
    const fp = q.path;
    if (!fp) return json(res, 400, { error: 'path required' });
    try {
      sandbox.assertPathSafe(fp, projectRoot);
      return json(res, 200, versionStore.getVersions(fp));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (is('/api/versions/content', 'GET')) {
    const vid = q.versionId;
    if (!vid) return json(res, 400, { error: 'versionId required' });
    const content = versionStore.getContent(vid);
    if (content === null) return json(res, 404, { error: 'Version content not found' });
    return json(res, 200, { content });
  }
  if (is('/api/versions/restore', 'POST')) {
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
  if (is('/api/versions/diff', 'POST')) {
    
    const { versionId, compareToVersionId } = body;
    if (!versionId) return json(res, 400, { error: 'versionId required' });
    const contentA = versionStore.getContent(versionId);
    if (contentA === null) return json(res, 404, { error: 'Version not found' });
    let contentB;
    if (compareToVersionId) {
      contentB = versionStore.getContent(compareToVersionId);
      if (contentB === null) return json(res, 404, { error: 'compareToVersionId not found' });
    } else {
      
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

  
  if (is('/api/permissions/pending', 'GET')) {
    return json(res, 200, permGate.getPending());
  }
  if (is('/api/permissions/history', 'GET')) {
    return json(res, 200, permGate.getHistory(50));
  }
  const permM = pathname.match(/^\/api\/permissions\/([^/]+)\/(approve|reject)$/);
  if (permM) {
    const [, id, action] = permM;
    if (action === 'approve') return json(res, 200, permGate.approve(id));
    if (action === 'reject')  return json(res, 200, permGate.reject(id, body.reason));
  }

  
  if (is('/api/exec', 'POST')) {
    try {
      const { command, skipApproval } = body;
      const assessment = await ensureCommandPermission({ command, projectRoot, skipApproval });
      const result = await sandbox.runCommandApproved(command, projectRoot, {
        executionMode: assessment.executionMode,
        timeout: assessment.timeoutMs,
      });
      return json(res, 200, {
        ...result,
        executionMode: assessment.executionMode,
        requiresEscalation: assessment.requiresEscalation,
        escalationReason: assessment.escalationReason || '',
      });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }

  
  if (is('/api/agents', 'GET')) {
    return json(res, 200, agentManager.getAll());
  }
  if (is('/api/agents/wait', 'GET')) {
    const ids = String(q.ids || '').split(',').map((id) => id.trim()).filter(Boolean);
    const timeoutMs = Math.min(300000, Math.max(1000, Number(q.timeoutMs) || 30000));
    return json(res, 200, await agentManager.waitFor(ids, timeoutMs));
  }
  if (is('/api/agents', 'POST')) {
    const { task, agentName, useWorktree, contextQuery, apiKey, role, parentAgentId } = body;
    const resolvedProviders = resolveModelProviders(apiKey);
    if (!task) return json(res, 400, { error: 'task required' });
    let worktreePath = null;
    if (useWorktree) {
      const tmpId = require('crypto').randomBytes(4).toString('hex');
      const wt = await worktrees.createWorktree(projectRoot, tmpId, agentName || 'agent');
      if (wt.ok) worktreePath = wt.worktreePath;
      else console.warn('[server] Worktree failed:', wt.error);
    }
    const contextFiles = await resolveContextFilesForTask(contextQuery, resolvedProviders, {
      maxFiles: 8,
      maxTokens: 10000,
    });
    
    const memory = memoryStore.query(task, { projectRoot });
    const identityContext = getWorkspaceIdentityPrompt();
    const agent = await agentManager.launch({
      task, agentName, projectRoot, apiKey: resolvedProviders, contextFiles, worktreePath,
      role: role || 'code',
      memory,
      identityContext,
      parentAgentId: parentAgentId || null,
    });
    return json(res, 200, sa(agent));
  }
  if (is('/api/agents/orchestrate', 'POST')) {
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const resolvedProviders = resolveModelProviders(body.apiKey);
    if (!tasks.length) return json(res, 400, { error: 'tasks required' });
    const launched = [];
    for (const item of tasks) {
      if (!item?.task) continue;
      let worktreePath = null;
      if (item.useWorktree) {
        const tmpId = require('crypto').randomBytes(4).toString('hex');
        const wt = await worktrees.createWorktree(projectRoot, tmpId, item.agentName || 'agent');
        if (wt.ok) worktreePath = wt.worktreePath;
      }
      const contextFiles = await resolveContextFilesForTask(item.contextQuery || item.task, resolvedProviders, {
        maxFiles: 8,
        maxTokens: 10000,
      });
      const agent = await agentManager.launch({
        task: item.task,
        agentName: item.agentName,
        projectRoot,
        apiKey: resolvedProviders,
        contextFiles,
        worktreePath,
        role: item.role || 'code',
        memory: memoryStore.query(item.task, { projectRoot }),
        identityContext: getWorkspaceIdentityPrompt(),
        parentAgentId: item.parentAgentId || null,
      });
      launched.push(sa(agent));
    }
    if (body.wait) {
      const wait = await agentManager.waitFor(launched.map((agent) => agent.id), Math.min(300000, body.timeoutMs || 30000));
      return json(res, 200, { ok: true, agents: launched, wait });
    }
    return json(res, 200, { ok: true, agents: launched });
  }
  if (is('/api/swarm', 'POST')) {
    const { goal, maxAgents, apiKey } = body;
    const resolvedProviders = resolveModelProviders(apiKey);
    if (!goal) return json(res, 400, { error: 'goal required' });
    const contextFiles = await resolveContextFilesForTask(goal, resolvedProviders, {
      maxFiles: 8,
      maxTokens: 10000,
    });
    try {
      const result = await swarmCoordinator.launch({
        goal,
        projectRoot,
        apiKey: resolvedProviders,
        contextFiles,
        identityContext: getWorkspaceIdentityPrompt(),
        maxAgents,
      });
      return json(res, 200, result);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }
  const agentIdM = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentIdM) {
    const id = agentIdM[1];
    if (method === 'DELETE') return json(res, 200, agentManager.cancel(id));
  }
  const agentSpawnM = pathname.match(/^\/api\/agents\/([^/]+)\/spawn$/);
  if (agentSpawnM) {
    const parentAgentId = agentSpawnM[1];
    const resolvedProviders = resolveModelProviders(body.apiKey);
    if (!body.task) return json(res, 400, { error: 'task required' });
    let worktreePath = null;
    if (body.useWorktree) {
      const tmpId = require('crypto').randomBytes(4).toString('hex');
      const wt = await worktrees.createWorktree(projectRoot, tmpId, body.agentName || 'agent');
      if (wt.ok) worktreePath = wt.worktreePath;
    }
    const contextFiles = await resolveContextFilesForTask(body.contextQuery || body.task, resolvedProviders, {
      maxFiles: 8,
      maxTokens: 10000,
    });
    const child = await agentManager.launch({
      task: body.task,
      agentName: body.agentName,
      projectRoot,
      apiKey: resolvedProviders,
      contextFiles,
      worktreePath,
      role: body.role || 'code',
      memory: memoryStore.query(body.task, { projectRoot }),
      identityContext: getWorkspaceIdentityPrompt(),
      parentAgentId,
    });
    return json(res, 200, sa(child));
  }
  const agentInputM = pathname.match(/^\/api\/agents\/([^/]+)\/input$/);
  if (agentInputM) {
    const id = agentInputM[1];
    const resolvedProviders = resolveModelProviders(body.apiKey);
    const contextFiles = await resolveContextFilesForTask(body.contextQuery || body.task, resolvedProviders, {
      maxFiles: 8,
      maxTokens: 10000,
    });
    return json(res, 200, agentManager.sendInput(id, {
      task: body.task,
      apiKey: resolvedProviders,
      contextFiles,
      role: body.role,
      memory: body.task ? memoryStore.query(body.task, { projectRoot }) : undefined,
      identityContext: getWorkspaceIdentityPrompt(),
      interrupt: !!body.interrupt,
    }));
  }
  const agentCloseM = pathname.match(/^\/api\/agents\/([^/]+)\/close$/);
  if (agentCloseM) {
    return json(res, 200, agentManager.close(agentCloseM[1]));
  }
  const agentRetryM = pathname.match(/^\/api\/agents\/([^/]+)\/retry$/);
  if (agentRetryM) {
    return json(res, 200, agentManager.retry(agentRetryM[1], projectRoot, resolveModelProviders(body.apiKey)));
  }

  
  if (is('/api/plans', 'GET')) {
    return json(res, 200, planner.listPlans());
  }
  if (is('/api/plans', 'POST')) {
    
    const { goal, contextQuery, apiKey } = body;
    const resolvedProviders = resolveModelProviders(apiKey);
    if (!goal) return json(res, 400, { error: 'goal required' });
    try {
      let contextFiles = [];
      if (contextQuery && contextEngine.getStats().indexed) {
        const ctx = await contextEngine.query(contextQuery, {
          maxFiles: 6,
          maxTokens: 6000,
          providerConfig: resolvedProviders,
        });
        contextFiles = ctx.files || [];
      }
      const plan = await planner.generatePlan({
        goal,
        projectRoot,
        apiKey: resolvedProviders,
        contextFiles,
        identityContext: getWorkspaceIdentityPrompt(),
      });
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

  
  if (is('/api/memory/stats', 'GET')) {
    return json(res, 200, memoryStore.getStats());
  }
  if (is('/api/memory/relevant', 'POST')) {
    if (!body.query) return json(res, 400, { error: 'query required' });
    return json(res, 200, { memory: memoryStore.query(body.query) });
  }
  if (is('/api/memory/decision', 'POST')) {
    if (!body.text) return json(res, 400, { error: 'text required' });
    memoryStore.recordDecision({
      decision:   body.text,
      reasoning:  body.reasoning || '',
      agentName:  'manual',
      projectRoot,
    });
    return json(res, 200, { ok: true });
  }
  if (is('/api/memory/clear', 'POST')) {
    memoryStore.clear();
    return json(res, 200, { ok: true });
  }

  
  if (is('/api/worktrees', 'GET')) {
    return json(res, 200, await worktrees.listWorktrees(projectRoot));
  }
  if (is('/api/worktrees', 'DELETE')) {
    return json(res, 200, await worktrees.removeWorktree(projectRoot, body.worktreePath));
  }
  if (is('/api/worktrees/merge', 'POST')) {
    return json(res, 200, await worktrees.mergeWorktree(projectRoot, body.branchName, body.strategy));
  }
  if (is('/api/worktrees/diff', 'GET')) {
    return json(res, 200, await worktrees.getWorktreeDiff(projectRoot, q.branch));
  }

  
  if (is('/api/context/index', 'POST')) {
    try {
      const resolvedProviders = resolveModelProviders(body.apiKey);
      contextEngine.setProviderConfig(resolvedProviders);
      const stats = await contextEngine.buildIndex(projectRoot, {
        providerConfig: resolvedProviders,
        buildEmbeddings: !!resolvedProviders.openai || !!resolvedProviders.anthropic,
      });
      return json(res, 200, { ok: true, ...stats });
    } catch (err) { return json(res, 500, { error: err.message }); }
  }

  if (is('/api/context/stats', 'GET')) {
    return json(res, 200, contextEngine.getStats());
  }

  if (is('/api/context/query', 'POST')) {
    if (!body.query) return json(res, 400, { error: 'query required' });
    try {
      const result = await contextEngine.query(body.query, {
        maxFiles:  body.maxFiles  || 10,
        maxTokens: body.maxTokens || 12000,
        providerConfig: resolveModelProviders(body.apiKey),
      });
      return json(res, 200, result);
    } catch (err) { return json(res, 500, { error: err.message }); }
  }

  
  if (is('/api/context/reindex', 'POST')) {
    const resolvedProviders = resolveModelProviders(body.apiKey);
    if (!resolvedProviders.openai && !resolvedProviders.anthropic) {
      return json(res, 400, { error: 'An OpenAI or Anthropic embedding provider is required for reindex' });
    }
    try {
      const result = await contextEngine.reindex(resolvedProviders);
      return json(res, 200, result);
    } catch (err) { return json(res, 500, { error: err.message }); }
  }

  
  if (is('/api/chat', 'POST') || is('/api/claude', 'POST')) {
    const { apiKey, messages, system, mode, profile } = body;
    const requestCtl = createRequestController(req, 60000);
    try {
      const hydratedMessages = hydrateMessages(messages || []);
      const canonical = maybeAnswerCanonicalQuestion({ messages: hydratedMessages });
      if (canonical) {
        requestCtl.cleanup();
        return json(res, 200, {
          provider: 'policy',
          model: 'canonical-facts',
          role: canonical.role,
          intent: canonical.intent,
          mode: canonical.mode,
          profile: 'deliberate',
          content: [{ type: 'text', text: canonical.text }],
        });
      }
      const resolvedProviders = resolveModelProviders(apiKey);
      const policy = buildPolicySystem({
        projectRoot,
        messages: hydratedMessages,
        mode,
        profile,
        incomingSystem: [
          system || '',
          getWorkspaceIdentityPrompt(),
          await getAutoContextPrompt({ policy: buildPolicySystem({ projectRoot, messages: hydratedMessages, mode, profile }), messages: hydratedMessages, providers: resolvedProviders }),
        ].filter(Boolean).join('\n\n'),
      });
      const reply = await turnOrchestrator.runTurn({
        providers: resolvedProviders,
        policy,
        messages: hydratedMessages,
        signal: requestCtl.signal,
      });
      requestCtl.cleanup();
      return json(res, 200, {
        provider: reply.provider,
        model: reply.model,
        role: policy.role,
        intent: policy.intent,
        mode: policy.mode,
        profile: policy.profile,
        turnId: reply.turnId,
        trace: reply.trace,
        deliberation: reply.trace?.deliberation || null,
        governor: reply.trace?.governor || null,
        evidenceBundle: reply.trace?.evidenceBundle || null,
        sources: (reply.trace?.evidence || []).filter((evidence) => ['web', 'web_search', 'docs_search'].includes(evidence.type)),
        content: [{ type: 'text', text: reply.text }],
      });
    } catch (err) {
      requestCtl.cleanup();
      return json(res, 400, { error: err.message });
    }
  }

  
  if (is('/api/chat/stream', 'POST') || is('/api/claude/stream', 'POST')) {
    const { apiKey, messages, system, mode, profile } = body;
    const requestCtl = createRequestController(req, 120000);
    const hydratedMessages = hydrateMessages(messages || []);
    const canonical = maybeAnswerCanonicalQuestion({ messages: hydratedMessages });
    const resolvedProviders = resolveModelProviders(apiKey);
    const basePolicy = buildPolicySystem({ projectRoot, messages: hydratedMessages, mode, profile });
    const policy = buildPolicySystem({
      projectRoot,
      messages: hydratedMessages,
      mode,
      profile,
      incomingSystem: [
        system || '',
        getWorkspaceIdentityPrompt(),
        await getAutoContextPrompt({ policy: basePolicy, messages: hydratedMessages, providers: resolvedProviders }),
      ].filter(Boolean).join('\n\n'),
    });

    
    res.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (data) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    if (canonical) {
      sendEvent({
        type: 'meta',
        provider: 'policy',
        model: 'canonical-facts',
        role: canonical.role,
        intent: canonical.intent,
        mode: canonical.mode,
        profile: 'deliberate',
      });
      sendEvent({ type: 'token', text: canonical.text });
      sendEvent({ type: 'done', provider: 'policy', model: 'canonical-facts' });
      requestCtl.cleanup();
      res.end();
      return;
    }

    try {
      const reply = await turnOrchestrator.runTurn({
        providers: resolvedProviders,
        policy,
        messages: hydratedMessages,
        signal: requestCtl.signal,
        onToken: (text) => sendEvent({ type: 'token', text }),
        onEvent: (evt) => {
          sendEvent(evt);
          bc(`turn:${evt.type}`, evt);
        },
      });
      sendEvent({
        type: 'meta',
        provider: reply.provider,
        model: reply.model,
        role: policy.role,
        intent: policy.intent,
        mode: policy.mode,
        profile: policy.profile,
        turnId: reply.turnId,
        deliberation: reply.trace?.deliberation || null,
        governor: reply.trace?.governor || null,
      });
      sendEvent({ type: 'done', provider: reply.provider, model: reply.model });
      requestCtl.cleanup();
      res.end();
    } catch (err) {
      sendEvent({ type: 'error', error: err.message });
      requestCtl.cleanup();
      res.end();
    }
    return;
  }

  if (is('/api/exec/stream', 'POST')) {
    const { command, skipApproval } = body;
    let assessment;
    try {
      assessment = await ensureCommandPermission({ command, projectRoot, skipApproval });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }

    res.writeHead(200, {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache',
      'Connection':                  'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendLine = (text, stream = 'stdout') => {
      try { res.write(`data: ${JSON.stringify({ type: 'line', text, stream })}\n\n`); } catch {}
    };

    try {
      res.write(`data: ${JSON.stringify({
        type: 'execution_mode',
        mode: assessment.executionMode,
        requiresEscalation: assessment.requiresEscalation,
        reason: assessment.escalationReason || '',
      })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
      res.end();
      return;
    }

    let proc;
    let executionMode = assessment.executionMode;
    try {
      const spawned = await sandbox.spawnCommandApproved(command, projectRoot, {
        executionMode: assessment.executionMode,
        timeout: assessment.timeoutMs,
      });
      proc = spawned.proc;
      executionMode = spawned.mode || executionMode;
    } catch (err) {
      res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
      res.end();
      return;
    }

    proc.stdout.on('data', d => {
      d.toString('utf-8').split('\n').filter(Boolean).forEach(line => sendLine(line, 'stdout'));
    });
    proc.stderr.on('data', d => {
      d.toString('utf-8').split('\n').filter(Boolean).forEach(line => sendLine(line, 'stderr'));
    });
    proc.on('close', code => {
      try {
        res.write(`data: ${JSON.stringify({
          type: 'exit',
          code: code ?? 0,
          mode: executionMode,
          requiresEscalation: assessment.requiresEscalation,
        })}\n\n`);
        res.end();
      } catch {}
    });
    proc.on('error', err => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
        res.end();
      } catch {}
    });

    req.on('close', () => { try { proc.kill('SIGTERM'); } catch {} });
    return;
  }

  if (is('/api/system/stop', 'POST')) {
    const planResult = planner.stopAll('System stop endpoint invoked');
    const agentResult = agentManager.stopAll('System stop endpoint invoked');
    const payload = { ...planResult, ...agentResult };
    bc('system:stopped', payload);
    return json(res, 200, payload);
  }

  if (is('/api/skills', 'GET')) {
    return json(res, 200, skillRegistry.list());
  }
  if (is('/api/extensions/catalog', 'GET')) {
    return json(res, 200, extensionManager.listCatalog());
  }
  if (is('/api/extensions/installed', 'GET')) {
    return json(res, 200, extensionManager.listInstalledPlugins());
  }
  if (is('/api/extensions/install', 'POST')) {
    try {
      if (body.pluginId) return json(res, 200, extensionManager.installBundled(body.pluginId));
      if (body.manifestPath) return json(res, 200, extensionManager.installLocalManifest(body.manifestPath, projectRoot));
      return json(res, 400, { error: 'pluginId or manifestPath required' });
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (is('/api/extensions/uninstall', 'POST')) {
    try {
      if (!body.pluginId) return json(res, 400, { error: 'pluginId required' });
      return json(res, 200, extensionManager.uninstall(body.pluginId));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (is('/api/connectors', 'GET')) {
    return json(res, 200, connectorManager.list());
  }
  const connectorActionM = pathname.match(/^\/api\/connectors\/([^/]+)\/action$/);
  if (connectorActionM && method === 'POST') {
    try {
      return json(res, 200, await connectorManager.run(connectorActionM[1], body.actionId, body.args || {}));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (is('/api/resources/list', 'POST')) {
    try {
      if (!body.connectorId || !body.resourceId) return json(res, 400, { error: 'connectorId and resourceId are required' });
      return json(res, 200, await connectorManager.listResources(body.connectorId, body.resourceId, body.args || {}));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  if (is('/api/resources/read', 'POST')) {
    try {
      if (!body.connectorId || !body.uri) return json(res, 400, { error: 'connectorId and uri are required' });
      return json(res, 200, await connectorManager.readResource(body.connectorId, body.uri, body.args || {}));
    } catch (err) { return json(res, 400, { error: err.message }); }
  }
  const skillRunM = pathname.match(/^\/api\/skills\/([^/]+)\/run$/);
  if (skillRunM) {
    try {
      return json(res, 200, await skillRegistry.run(skillRunM[1], projectRoot));
    } catch (err) { return json(res, 500, { error: err.message }); }
  }

  if (is('/api/automations', 'GET')) {
    return json(res, 200, automations.listJobs());
  }
  if (is('/api/automations', 'POST')) {
    return json(res, 200, automations.createJob({ ...body, projectRoot }));
  }
  if (is('/api/automations/results', 'GET')) {
    return json(res, 200, automations.listResults());
  }
  if (is('/api/automations/notifications', 'GET')) {
    return json(res, 200, automations.listNotifications());
  }
  if (is('/api/artifacts', 'GET')) {
    return json(res, 200, artifactStore.list(Number(q.limit) || 40));
  }
  const artifactM = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
  if (artifactM && method === 'GET') {
    const artifact = artifactStore.get(artifactM[1]);
    if (!artifact) return json(res, 404, { error: 'Not found' });
    return json(res, 200, artifact);
  }
  const autoNotifAckM = pathname.match(/^\/api\/automations\/notifications\/([^/]+)\/ack$/);
  if (autoNotifAckM && method === 'POST') {
    const result = automations.acknowledgeNotification(autoNotifAckM[1]);
    return json(res, result.ok ? 200 : 404, result);
  }
  const autoNotifMemoryM = pathname.match(/^\/api\/automations\/notifications\/([^/]+)\/memory$/);
  if (autoNotifMemoryM && method === 'POST') {
    const result = automations.promoteNotificationToMemory(autoNotifMemoryM[1]);
    return json(res, result.ok ? 200 : 404, result);
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

  function ghClient() {
    const tok = body.token || githubToken;
    if (!tok) throw new Error('GitHub token required');
    return new GitHubClient(tok);
  }

  if (is('/api/github/user', 'POST')) {
    try { return json(res, 200, await ghClient().getUser()); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/repos', 'POST')) {
    try { return json(res, 200, await ghClient().listRepos()); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/clone', 'POST')) {
    try {
      const target = body.targetDir || projectRoot;
      sandbox.assertPathSafe(target, projectRoot);
      return json(res, 200, await ghClient().cloneRepo(body.url, target));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/status', 'POST')) {
    try { return json(res, 200, await ghClient().gitStatus(projectRoot)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/push', 'POST')) {
    try {
      await permGate.request({ type:'git', agentId:'manual', description:`git commit "${body.message}" && push`, payload: body });
      return json(res, 200, await ghClient().gitCommitAndPush({ ...body, projectRoot }));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/create', 'POST')) {
    try { return json(res, 200, await ghClient().createPR(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/list', 'POST')) {
    try { return json(res, 200, await ghClient().listPRs(body.owner, body.repo, body.state)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/files', 'POST')) {
    try { return json(res, 200, await ghClient().getPRFiles(body.owner, body.repo, body.number)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/reviews', 'POST')) {
    try { return json(res, 200, await ghClient().listPRReviews(body.owner, body.repo, body.pullNumber || body.number)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/threads', 'POST')) {
    try { return json(res, 200, await ghClient().getPRReviewThreads(body.owner, body.repo, body.pullNumber || body.number)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/bundle', 'POST')) {
    try { return json(res, 200, await ghClient().getPRReviewBundle(body.owner, body.repo, body.pullNumber || body.number)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/diff', 'POST')) {
    try { return json(res, 200, { diff: await ghClient().getPRDiff(body.owner, body.repo, body.number) }); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/comment', 'POST')) {
    try { return json(res, 200, await ghClient().addPRReviewComment(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/comment/reply', 'POST')) {
    try { return json(res, 200, await ghClient().replyToReviewComment(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/comment/update', 'POST')) {
    try { return json(res, 200, await ghClient().updateReviewComment(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/review', 'POST')) {
    try { return json(res, 200, await ghClient().submitPRReview(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/pr/merge', 'POST')) {
    try {
      await permGate.request({ type:'git', agentId:'manual', description:`Merge PR #${body.pullNumber}`, payload: body });
      return json(res, 200, await ghClient().mergePR(body));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/branches', 'POST')) {
    try { return json(res, 200, await ghClient().listBranches(body.owner, body.repo)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/issues', 'POST')) {
    try { return json(res, 200, await ghClient().listIssues(body.owner, body.repo, body.state)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/issue/comments', 'POST')) {
    try { return json(res, 200, await ghClient().listIssueComments(body.owner, body.repo, body.issueNumber)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/issue/comment', 'POST')) {
    try { return json(res, 200, await ghClient().addIssueComment(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/issue/comment/update', 'POST')) {
    try { return json(res, 200, await ghClient().updateIssueComment(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/compare', 'POST')) {
    try { return json(res, 200, await ghClient().compareCommits(body.owner, body.repo, body.base, body.head)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/search', 'POST')) {
    try {
      const type = String(body.type || 'issues');
      if (type === 'repos') return json(res, 200, await ghClient().searchRepositories(body.query, { limit: body.limit }));
      return json(res, 200, await ghClient().searchIssues(body.query, { limit: body.limit, sort: body.sort, order: body.order }));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/reactions', 'POST')) {
    try { return json(res, 200, await ghClient().addReaction(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (is('/api/github/reactions/list', 'POST')) {
    try { return json(res, 200, await ghClient().listReactions(body)); }
    catch (e) { return json(res, 400, { error: e.message }); }
  }

  json(res, 404, { error: `Not found: ${pathname}` });
}

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

function hydrateMessages(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message?.role || 'user',
    content: Array.isArray(message?.content)
      ? message.content.map((part) => hydrateMessagePart(part)).filter(Boolean)
      : String(message?.content || ''),
  }));
}

function hydrateMessagePart(part) {
  if (!part) return null;
  if (part.type === 'text') {
    return { type: 'text', text: String(part.text || '') };
  }
  if (part.type === 'image') {
    const attachment = imageStore.readAttachment(part.uploadId || part.id);
    return {
      type: 'image',
      uploadId: attachment.id,
      name: part.name || attachment.name,
      mimeType: attachment.mimeType,
      url: attachment.url,
      size: attachment.size,
      dataUrl: attachment.dataUrl,
    };
  }
  return null;
}

const server = http.createServer(router);

server.listen(PORT, async () => {
  const sbInfo = await sandbox.getSandboxInfo();
  console.log(`
╔══════════════════════════════════════════════════╗
║           clsClaw — Zero Dependencies            ║
╠══════════════════════════════════════════════════╣
║  URL:      http:
║  Project:  ${projectRoot.slice(0,38).padEnd(38)} ║
║  Sandbox:  ${sbInfo.mode.padEnd(38)} ║
║  Node:     ${process.version.padEnd(38)} ║
╚══════════════════════════════════════════════════╝
`);
  try { const { exec } = require('child_process'); exec(`open http:
  catch {}
});

server.on('error', err => console.error('Server error:', err.message));

process.on('uncaughtException', (err) => {
  setLastSystemError(err.message, { source: 'uncaughtException' });
  bc('system:error', { source: 'uncaughtException', error: err.message });
  console.error('[uncaughtException]', err);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  setLastSystemError(message, { source: 'unhandledRejection' });
  bc('system:error', { source: 'unhandledRejection', error: message });
  console.error('[unhandledRejection]', reason);
});
