

'use strict';

const { Worker } = require('worker_threads');
const { EventEmitter } = require('events');
const { randomUUID: uuid } = require('crypto');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'agentWorker.js');
const MAX_CONCURRENT_AGENTS = 7;

class AgentManager extends EventEmitter {
  constructor({ approvalQueue, permissionGate }) {
    super();
    this._agents = new Map();
    this._queue = [];
    this._approvalQueue = approvalQueue;
    this._permissionGate = permissionGate;
    this._memoryStore = null;   
  }

  
  setMemoryStore(ms) { this._memoryStore = ms; }

  
  async launch({
    task,
    agentName,
    projectRoot,
    apiKey,
    contextFiles = [],
    worktreePath = null,
    role = 'default',
    memory = '',
    behavioralConstraints = [],
    identityContext = '',
    parentAgentId = null,
  }) {
    const agentId = uuid();
    const name = agentName || `Agent-${agentId.slice(0, 6)}`;

    const record = {
      id: agentId,
      name,
      task,
      role,
      status: 'queued',
      startTime: Date.now(),
      endTime: null,
      logs: [],
      proposals: [],
      commands: [],
      worktreePath,
      worker: null,
      error: null,
      reply: null,
      provider: null,
      model: null,
      parentAgentId,
      children: [],
      pendingInputs: [],
      _projectRoot: projectRoot,
      _apiKey: apiKey,
      _contextFiles: contextFiles,
      _memory: memory,
      _behavioralConstraints: behavioralConstraints,
      _identityContext: identityContext,
    };

    this._agents.set(agentId, record);
    if (parentAgentId) {
      const parent = this._agents.get(parentAgentId);
      if (parent && !parent.children.includes(agentId)) parent.children.push(agentId);
    }
    this.emit('agent:created', record);

    const running = [...this._agents.values()].filter(a => a.status === 'running').length;

    if (running >= MAX_CONCURRENT_AGENTS) {
      this._queue.push({
        agentId, task, agentName: name, projectRoot, apiKey, contextFiles,
        worktreePath, role, memory, behavioralConstraints, identityContext, parentAgentId,
      });
      record.status = 'queued';
      this.emit('agent:queued', record);
      return record;
    }

    this._startWorker(agentId, {
      task, agentName: name, projectRoot, apiKey, contextFiles,
      worktreePath, role, memory, behavioralConstraints, identityContext,
    });
    return record;
  }

  _startWorker(
    agentId,
    { task, agentName, projectRoot, apiKey, contextFiles, worktreePath, role = 'default', memory = '', behavioralConstraints = [], identityContext = '' },
  ) {
    const record = this._agents.get(agentId);
    if (!record) return;

    const execRoot = worktreePath || projectRoot;

    const worker = new Worker(WORKER_PATH, {
      workerData: {
        agentId,
        agentName,
        task,
        projectRoot: execRoot,
        apiKey,
        contextFiles,
        role,
        memory,
        behavioralConstraints,
        identityContext,
      },
    });

    record.worker   = worker;
    record.status   = 'running';
    record.task     = task;
    record.role     = role;
    record.error    = null;
    record.endTime  = null;
    record._projectRoot  = projectRoot;   // real project root for safety checks
    record._execRoot     = execRoot;      // where this agent actually writes
    record._apiKey       = apiKey;
    record._contextFiles = contextFiles;
    record._memory       = memory;
    record._behavioralConstraints = behavioralConstraints;
    record._identityContext = identityContext;
    this.emit('agent:started', record);

    worker.on('message', (msg) => this._handleWorkerMessage(msg, projectRoot, execRoot));

    worker.on('error', (err) => {
      if (record.status === 'redirecting') return;
      record.status = 'error';
      record.error = err.message;
      record.endTime = Date.now();
      record.worker = null;
      this.emit('agent:error', { ...record, error: err.message });
      this._drainQueue(projectRoot, apiKey);
    });

    worker.on('exit', (code) => {
      if (record._redirectNext) {
        const nextConfig = record._redirectNext;
        record._redirectNext = null;
        record.worker = null;
        record.status = 'queued';
        record.logs.push({ msg: 'Interrupted and restarted with a new task', level: 'info', time: Date.now() });
        this.emit('agent:redirected', { agentId: record.id, task: nextConfig.task });
        this._startWorker(agentId, nextConfig);
        return;
      }
      if (record.status === 'running') {
        record.status = code === 0 ? 'done' : 'error';
      }
      record.endTime = Date.now();
      record.worker = null;
      this.emit('agent:exit', record);
      if (record.pendingInputs.length > 0 && !['cancelled', 'error'].includes(record.status)) {
        const nextInput = record.pendingInputs.shift();
        record.status = 'queued';
        this.emit('agent:input_started', { agentId: record.id, task: nextInput.task });
        this._startWorker(agentId, nextInput);
        return;
      }
      this._drainQueue(projectRoot, apiKey);
    });
  }

  _handleWorkerMessage(msg, projectRoot, execRoot) {
    const record = this._agents.get(msg.agentId);
    if (!record) return;



    const agentExecRoot = record._execRoot || execRoot || projectRoot;

    switch (msg.type) {
      case 'log':
        record.logs.push({ msg: msg.msg, level: msg.level, time: msg.time });
        this.emit('agent:log', { agentId: msg.agentId, msg: msg.msg, level: msg.level });
        break;

      case 'token':

        this.emit('agent:token', { agentId: msg.agentId, text: msg.text });
        break;

      case 'status':
        record.status = msg.status;
        if (msg.error) record.error = msg.error;
        if (msg.status === 'done' || msg.status === 'error') {
          record.endTime = Date.now();
        }
        this.emit('agent:status', record);
        break;

      case 'reply':
        record.reply = msg.text;
        this.emit('agent:reply', { agentId: msg.agentId, text: msg.text });
        break;

      case 'meta':
        record.provider = msg.provider || null;
        record.model = msg.model || null;
        this.emit('agent:meta', { agentId: msg.agentId, provider: record.provider, model: record.model });
        break;

      case 'propose_file': {



        const filePath = msg.filePath;

        this._approvalQueue.propose({
          filePath,
          newContent: msg.content,
          agentId: msg.agentId,
          agentName: record.name,
          description: `${record.name}: write ${msg.relativePath}`,


          projectRoot: agentExecRoot,

          realProjectRoot: projectRoot,
          worktreePath: record.worktreePath || null,
          approvalContext: msg.approvalContext || null,
        }).then(pending => {
          if (!pending.skipped) {
            record.proposals.push(pending.id);
            this.emit('agent:proposal', {
              agentId: msg.agentId,
              changeId: pending.id,
              filePath,
              worktreePath: record.worktreePath || null,
            });
          }
        }).catch(err => {
          record.logs.push({ msg: 'Proposal error: ' + err.message, level: 'error', time: Date.now() });
        });
        break;
      }

      case 'propose_command':

        this._permissionGate.request({
          type: 'exec',
          agentId: msg.agentId,
          description: `${record.name} wants to run: ${msg.command}`,
          payload: { command: msg.command },
        }).then(() => {
          record.commands.push({ command: msg.command, status: 'approved' });
          this.emit('agent:command_approved', { agentId: msg.agentId, command: msg.command });
        }).catch(err => {
          record.commands.push({ command: msg.command, status: 'rejected', reason: err.message });
          this.emit('agent:command_rejected', { agentId: msg.agentId, command: msg.command });
        });
        break;

      case 'memory':

        if (this._memoryStore) {
          for (const d of (msg.decisions || [])) {
            this._memoryStore.recordDecision({
              decision:    d,
              reasoning:   '',
              agentName:   record.name,
              projectRoot: record._projectRoot || null,
            });
          }



          for (const f of (msg.fileSummaries || [])) {
            this._memoryStore.recordTask({
              goal:       `Modified: ${f.filePath}`,
              outcome:    f.summary,
              agentNames: [record.name],
              projectRoot: record._projectRoot || null,
            });
          }
          if (msg.outcome) {
            this._memoryStore.recordTask({
              goal:       msg.outcome.task    || '',
              outcome:    msg.outcome.summary || '',
              agentNames: [record.name],
              projectRoot: record._projectRoot || null,
            });
          }
        }
        this.emit('agent:memory', { agentId: msg.agentId, memory: msg });
        break;
    }
  }

  _drainQueue(projectRoot, apiKey) {
    if (this._queue.length === 0) return;
    const running = [...this._agents.values()].filter(a => a.status === 'running').length;
    if (running >= MAX_CONCURRENT_AGENTS) return;
    const next = this._queue.shift();
    if (next) {


      this._startWorker(next.agentId, {
        ...next,
        projectRoot: next.projectRoot || projectRoot,
        apiKey: next.apiKey || apiKey,
      });
    }
  }

  cancel(agentId) {
    const record = this._agents.get(agentId);
    if (!record) return { ok: false, error: 'Agent not found' };
    if (record.worker) {
      record.worker.terminate();
      record.status = 'cancelled';
      record.endTime = Date.now();
      record.pendingInputs = [];
      record._redirectNext = null;
      this.emit('agent:cancelled', record);
    }
    return { ok: true };
  }

  sendInput(agentId, {
    task,
    apiKey,
    contextFiles,
    role,
    memory,
    behavioralConstraints,
    identityContext,
    interrupt = false,
  }) {
    const record = this._agents.get(agentId);
    if (!record) return { ok: false, error: 'Agent not found' };
    if (!task) return { ok: false, error: 'task required' };

    const nextConfig = {
      task,
      agentName: record.name,
      projectRoot: record._projectRoot,
      apiKey: apiKey || record._apiKey,
      contextFiles: contextFiles || record._contextFiles || [],
      worktreePath: record.worktreePath,
      role: role || record.role || 'default',
      memory: typeof memory === 'string' ? memory : (record._memory || ''),
      behavioralConstraints: behavioralConstraints || record._behavioralConstraints || [],
      identityContext: typeof identityContext === 'string' ? identityContext : (record._identityContext || ''),
    };

    if (record.worker) {
      if (interrupt) {
        record.status = 'redirecting';
        record._redirectNext = nextConfig;
        record.worker.terminate();
        return { ok: true, interrupted: true, agentId };
      }
      record.pendingInputs.push(nextConfig);
      this.emit('agent:input_queued', { agentId, task, pendingInputs: record.pendingInputs.length });
      return { ok: true, queued: true, pendingInputs: record.pendingInputs.length };
    }

    record.status = 'queued';
    this._startWorker(agentId, nextConfig);
    return { ok: true, restarted: true, agentId };
  }

  waitFor(agentIds = [], timeoutMs = 30000) {
    const ids = Array.from(new Set((agentIds || []).filter(Boolean)));
    const isFinal = (status) => ['done', 'error', 'cancelled'].includes(status);
    const snapshot = () => ids.map((id) => this.get(id)).filter(Boolean).map((record) => ({
      id: record.id,
      status: record.status,
      error: record.error || null,
      provider: record.provider || null,
      model: record.model || null,
      reply: record.reply || '',
    }));

    if (ids.length === 0) return Promise.resolve({ ok: true, agents: [] });
    if (snapshot().every((agent) => isFinal(agent.status))) {
      return Promise.resolve({ ok: true, agents: snapshot(), done: true });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ ok: true, agents: snapshot(), done: false, timedOut: true });
      }, Math.max(1000, timeoutMs));

      const onEvent = () => {
        const agents = snapshot();
        if (agents.length === ids.length && agents.every((agent) => isFinal(agent.status))) {
          cleanup();
          resolve({ ok: true, agents, done: true });
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.off('agent:status', onEvent);
        this.off('agent:exit', onEvent);
        this.off('agent:error', onEvent);
        this.off('agent:cancelled', onEvent);
      };

      this.on('agent:status', onEvent);
      this.on('agent:exit', onEvent);
      this.on('agent:error', onEvent);
      this.on('agent:cancelled', onEvent);
    });
  }

  close(agentId) {
    const record = this._agents.get(agentId);
    if (!record) return { ok: false, error: 'Agent not found' };
    if (record.worker) return { ok: false, error: 'Cannot close a running agent' };
    if (record.parentAgentId) {
      const parent = this._agents.get(record.parentAgentId);
      if (parent) parent.children = parent.children.filter((id) => id !== agentId);
    }
    for (const childId of record.children || []) {
      const child = this._agents.get(childId);
      if (child) child.parentAgentId = null;
    }
    this._agents.delete(agentId);
    this.emit('agent:closed', { id: agentId });
    return { ok: true };
  }

  retry(agentId, projectRoot, apiKey) {
    const record = this._agents.get(agentId);
    if (!record) return { ok: false, error: 'Agent not found' };
    record.status = 'queued';
    record.logs = [];
    record.error = null;
    this._startWorker(agentId, {
      task: record.task,
      agentName: record.name,
      projectRoot: projectRoot || record._projectRoot,
      apiKey: apiKey || record._apiKey,
      contextFiles: record._contextFiles || [],
      worktreePath: record.worktreePath,
      role: record.role || 'default',
      memory: record._memory || '',
      behavioralConstraints: record._behavioralConstraints || [],
      identityContext: record._identityContext || '',
    });
    return { ok: true };
  }

  getAll() {
    return [...this._agents.values()].map(a => ({
      id: a.id,
      name: a.name,
      task: a.task,
      role: a.role || 'default',
      status: a.status,
      startTime: a.startTime,
      endTime: a.endTime,
      logs: a.logs.slice(-20),
      proposals: a.proposals,
      commands: a.commands,
      error: a.error,
      worktreePath: a.worktreePath,
      provider: a.provider || null,
      model: a.model || null,
      parentAgentId: a.parentAgentId || null,
      children: a.children || [],
      pendingInputs: a.pendingInputs?.length || 0,
    }));
  }

  get(agentId) {
    return this._agents.get(agentId) || null;
  }

  clear() {
    for (const [id, record] of this._agents) {
      if (record.worker) record.worker.terminate();
    }
    this._agents.clear();
    this._queue = [];
  }
}

module.exports = AgentManager;
