'use strict';

const fs = require('fs');
const path = require('path');

class CoordinationState {
  constructor(filePath) {
    this._filePath = filePath || null;
    this._state = { agents: {}, updatedAt: Date.now() };
    this._load();
  }

  _load() {
    if (!this._filePath || !fs.existsSync(this._filePath)) return;
    try {
      const raw = fs.readFileSync(this._filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.agents) {
        this._state = {
          agents: parsed.agents || {},
          updatedAt: parsed.updatedAt || Date.now(),
        };
      }
    } catch {}
  }

  _persist() {
    this._state.updatedAt = Date.now();
    if (!this._filePath) return;
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      fs.writeFileSync(this._filePath, JSON.stringify(this._state, null, 2), 'utf-8');
    } catch {}
  }

  registerAgent({ id, name, role, task, status, files = [] }) {
    this._state.agents[id] = {
      id,
      name,
      role: role || 'default',
      task: task || '',
      status: status || 'queued',
      files: Array.from(new Set(files)),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this._persist();
  }

  updateAgent(agentId, patch = {}) {
    const existing = this._state.agents[agentId];
    if (!existing) return;
    this._state.agents[agentId] = {
      ...existing,
      ...patch,
      files: patch.files ? Array.from(new Set(patch.files)) : existing.files,
      updatedAt: Date.now(),
    };
    this._persist();
  }

  addFile(agentId, relativePath) {
    const existing = this._state.agents[agentId];
    if (!existing || !relativePath) return;
    if (!existing.files.includes(relativePath)) {
      existing.files.push(relativePath);
      existing.updatedAt = Date.now();
      this._persist();
    }
  }

  releaseAgent(agentId) {
    if (!this._state.agents[agentId]) return;
    delete this._state.agents[agentId];
    this._persist();
  }

  getSnapshot() {
    return {
      updatedAt: this._state.updatedAt,
      agents: Object.values(this._state.agents).map(a => ({ ...a, files: [...(a.files || [])] })),
    };
  }

  getActiveAgentSummaries({ excludeAgentId = null } = {}) {
    return Object.values(this._state.agents)
      .filter(a => a.id !== excludeAgentId)
      .filter(a => ['queued', 'running'].includes(a.status))
      .map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        status: a.status,
        task: a.task,
        files: [...(a.files || [])],
      }));
  }

  getFileConflicts(relativePath, agentId) {
    if (!relativePath) return [];
    return this.getActiveAgentSummaries({ excludeAgentId: agentId })
      .filter(a => (a.files || []).includes(relativePath));
  }
}

module.exports = CoordinationState;
