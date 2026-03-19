/**
 * agentManager.js — Agent lifecycle management
 *
 * Manages Worker Threads for agent execution.
 * Routes messages from workers to:
 *   - ApprovalQueue (file proposals)
 *   - PermissionGate (command proposals)
 *   - WebSocket broadcast (status updates)
 */

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
    this._memoryStore = null;   // injected after construction
  }

  /** Wire in the memory store after construction */
  setMemoryStore(ms) { this._memoryStore = ms; }

  /**
   * Launch a new agent. If at max concurrency, queues it.
   */
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
    };

    this._agents.set(agentId, record);
    this.emit('agent:created', record);

    const running = [...this._agents.values()].filter(a => a.status === 'running').length;

    if (running >= MAX_CONCURRENT_AGENTS) {
      this._queue.push({
        agentId, task, agentName: name, projectRoot, apiKey, contextFiles,
        worktreePath, role, memory, behavioralConstraints,
      });
      record.status = 'queued';
      this.emit('agent:queued', record);
      return record;
    }

    this._startWorker(agentId, {
      task, agentName: name, projectRoot, apiKey, contextFiles,
      worktreePath, role, memory, behavioralConstraints,
    });
    return record;
  }

  _startWorker(
    agentId,
    { task, agentName, projectRoot, apiKey, contextFiles, worktreePath, role = 'default', memory = '', behavioralConstraints = [] },
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
      },
    });

    record.worker   = worker;
    record.status   = 'running';
    record._projectRoot  = projectRoot;   // real project root for safety checks
    record._execRoot     = execRoot;      // where this agent actually writes
    this.emit('agent:started', record);

    // Pass BOTH roots to the message handler so it can route correctly
    worker.on('message', (msg) => this._handleWorkerMessage(msg, projectRoot, execRoot));

    worker.on('error', (err) => {
      record.status = 'error';
      record.error = err.message;
      record.endTime = Date.now();
      record.worker = null;
      this.emit('agent:error', { ...record, error: err.message });
      this._drainQueue(projectRoot, apiKey);
    });

    worker.on('exit', (code) => {
      if (record.status === 'running') {
        record.status = code === 0 ? 'done' : 'error';
      }
      record.endTime = Date.now();
      record.worker = null;
      this.emit('agent:exit', record);
      this._drainQueue(projectRoot, apiKey);
    });
  }

  _handleWorkerMessage(msg, projectRoot, execRoot) {
    const record = this._agents.get(msg.agentId);
    if (!record) return;

    // execRoot is the directory this agent actually operates in
    // (worktree path when isolated, projectRoot otherwise).
    // We stored it on the record in _startWorker — use that as ground truth.
    const agentExecRoot = record._execRoot || execRoot || projectRoot;

    switch (msg.type) {
      case 'log':
        record.logs.push({ msg: msg.msg, level: msg.level, time: msg.time });
        this.emit('agent:log', { agentId: msg.agentId, msg: msg.msg, level: msg.level });
        break;

      case 'token':
        // Streaming token from agent — broadcast so UI can show live typing
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

      case 'propose_file': {
        // The worker already resolved filePath relative to execRoot (its projectRoot).
        // We must NOT re-resolve against projectRoot here — that was the original bug.
        // msg.filePath is already the correct absolute path inside the worktree (or project).
        const filePath = msg.filePath;

        this._approvalQueue.propose({
          filePath,
          newContent: msg.content,
          agentId: msg.agentId,
          agentName: record.name,
          description: `${record.name}: write ${msg.relativePath}`,
          // projectRoot for this proposal = the exec root of this agent
          // so that applyDiff writes to the right place (worktree or project)
          projectRoot: agentExecRoot,
          // Also track the real project root for UI display
          realProjectRoot: projectRoot,
          worktreePath: record.worktreePath || null,
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
        // Route to permission gate — does NOT execute
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
        // Agent is reporting things it learned — persist to memory store
        if (this._memoryStore) {
          for (const d of (msg.decisions || [])) {
            this._memoryStore.recordDecision({
              decision:    d,
              reasoning:   '',
              agentName:   record.name,
              projectRoot: record._projectRoot || null,
            });
          }
          // File summaries: we have the path + a short summary string.
          // updateFileSummary() expects the actual file content to summarise.
          // Instead use recordTask so the info is stored searchably.
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
      // Use the queued item's own projectRoot and apiKey if present,
      // falling back to the caller's values only as a last resort.
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
      this.emit('agent:cancelled', record);
    }
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
      projectRoot,
      apiKey,
      contextFiles: [],
      worktreePath: record.worktreePath,
      behavioralConstraints: [],
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
