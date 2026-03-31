/**
 * permissions.js — Permission gate system
 *
 * Every destructive or sensitive action goes through this gate.
 * Actions are queued as "pending permissions" — the UI must
 * explicitly approve them before execution proceeds.
 *
 * This is NOT fire-and-forget. Execution is BLOCKED until approved.
 */

'use strict';

const { EventEmitter } = require('events');
const { randomUUID: uuid } = require('crypto');

class PermissionGate extends EventEmitter {
  constructor() {
    super();
    // Map of requestId → { resolve, reject, request, timeout }
    this._pending = new Map();
    this._history = [];
    this._defaultTimeoutMs = 300000; // 5 min to approve/reject
  }

  /**
   * Request permission for an action.
   * Returns a Promise that resolves when approved, rejects when denied.
   *
   * @param {object} request
   * @param {string} request.type     - 'exec' | 'write' | 'delete' | 'install' | 'git'
   * @param {string} request.agentId  - which agent is requesting
   * @param {string} request.description - human-readable description
   * @param {object} request.payload  - { command?, filePath?, diff? }
   * @param {boolean} request.autoApprove - bypass gate (for low-risk reads)
   */
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

    // Emit so WebSocket can push to UI immediately
    this.emit('pending', permRequest);

    return promise;
  }

  /**
   * Called by UI when user clicks Approve
   */
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

  /**
   * Called by UI when user clicks Reject
   */
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

// Singleton — shared across all modules
const gate = new PermissionGate();
module.exports = gate;
