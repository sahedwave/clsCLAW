

'use strict';

const { EventEmitter } = require('events');
const { randomUUID: uuid } = require('crypto');

class PermissionGate extends EventEmitter {
  constructor() {
    super();
    
    this._pending = new Map();
    this._history = [];
    this._defaultTimeoutMs = 300000; 
  }

  
  async request(req) {
    if (req.autoApprove) {
      this._recordHistory({ ...req, status: 'auto-approved', time: Date.now() });
      return true;
    }

    const id = uuid();
    const permRequest = {
      id,
      type: req.type,
      agentId: req.agentId || 'manual',
      description: req.description,
      payload: req.payload || {},
      status: 'pending',
      time: Date.now(),
    };

    const promise = new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this._pending.delete(id);
        permRequest.status = 'timeout';
        this._recordHistory(permRequest);
        reject(new Error(`Permission request timed out after 5 minutes: ${req.description}`));
      }, this._defaultTimeoutMs);

      this._pending.set(id, {
        resolve,
        reject,
        request: permRequest,
        timeoutHandle,
      });
    });

    this.emit('pending', permRequest);

    return promise;
  }

  approve(requestId) {
    const entry = this._pending.get(requestId);
    if (!entry) return { ok: false, error: 'Request not found or already resolved' };

    clearTimeout(entry.timeoutHandle);
    entry.request.status = 'approved';
    entry.request.resolvedAt = Date.now();
    this._recordHistory(entry.request);
    this._pending.delete(requestId);
    this.emit('approved', entry.request);
    entry.resolve(true);
    return { ok: true };
  }

  reject(requestId, reason = 'User rejected') {
    const entry = this._pending.get(requestId);
    if (!entry) return { ok: false, error: 'Request not found or already resolved' };

    clearTimeout(entry.timeoutHandle);
    entry.request.status = 'rejected';
    entry.request.resolvedAt = Date.now();
    entry.request.reason = reason;
    this._recordHistory(entry.request);
    this._pending.delete(requestId);
    this.emit('rejected', entry.request);
    entry.reject(new Error(`Permission denied: ${reason}`));
    return { ok: true };
  }

  getPending() {
    return [...this._pending.values()].map(e => e.request);
  }

  getHistory(limit = 50) {
    return this._history.slice(-limit);
  }

  _recordHistory(entry) {
    this._history.push(entry);
    if (this._history.length > 500) this._history.shift();
  }
}

const gate = new PermissionGate();
module.exports = gate;
