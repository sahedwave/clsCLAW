'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID, createHmac, timingSafeEqual } = require('crypto');

class DelegationRegistry {
  constructor({ dataFile, fetchImpl = global.fetch } = {}) {
    this._dataFile = dataFile;
    this._fetch = fetchImpl;
    this._state = this._load();
  }

  listTargets() {
    return (this._state.targets || []).map(publicTarget);
  }

  createTarget(target = {}) {
    const normalized = normalizeTarget(target);
    if (!normalized.url) throw new Error('Target URL is required');
    if (!normalized.sharedSecret) throw new Error('Shared secret is required');
    this._state.targets.unshift(normalized);
    this._save();
    return publicTarget(normalized);
  }

  updateTarget(id, patch = {}) {
    const target = this._findTarget(id);
    if (!target) return null;
    Object.assign(target, normalizeTarget({ ...target, ...patch, id: target.id, createdAt: target.createdAt }, true));
    this._save();
    return publicTarget(target);
  }

  removeTarget(id) {
    const before = this._state.targets.length;
    this._state.targets = this._state.targets.filter((item) => item.id !== String(id || ''));
    if (this._state.targets.length === before) return { ok: false, error: 'Target not found' };
    this._save();
    return { ok: true };
  }

  listDispatches(limit = 20) {
    return (this._state.dispatches || []).slice(0, Math.max(1, Number(limit) || 20));
  }

  async pingTarget(id) {
    const target = this._findTarget(id);
    if (!target || target.enabled === false) throw new Error('Delegation target not available');
    if (!this._fetch) throw new Error('Fetch is not available for remote delegation');
    try {
      const response = await this._fetch(joinUrl(target.url, '/api/health'), { method: 'GET' });
      target.lastPingAt = Date.now();
      target.healthStatus = response.ok ? 'reachable' : 'degraded';
      target.lastPingError = response.ok ? '' : `HTTP ${response.status}`;
      this._save();
      return {
        ok: response.ok,
        status: target.healthStatus,
        lastPingAt: target.lastPingAt,
        error: target.lastPingError || null,
      };
    } catch (err) {
      target.lastPingAt = Date.now();
      target.healthStatus = 'unreachable';
      target.lastPingError = err.message;
      this._save();
      return {
        ok: false,
        status: target.healthStatus,
        lastPingAt: target.lastPingAt,
        error: err.message,
      };
    }
  }

  async dispatchTask(targetId, payload = {}) {
    const target = this._findTarget(targetId);
    if (!target || target.enabled === false) throw new Error('Delegation target not available');
    if (!target.sharedSecret) throw new Error('Delegation target is missing a shared secret');
    if (!this._fetch) throw new Error('Fetch is not available for remote delegation');
    const body = JSON.stringify({
      goal: String(payload.goal || '').trim(),
      role: String(payload.role || 'code').trim() || 'code',
      projectRoot: payload.projectRoot || null,
      requestedBy: payload.requestedBy || null,
      metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    });
    const signature = signDelegationBody(body, target.sharedSecret);
    const response = await this._fetch(joinUrl(target.url, '/api/delegation/execute'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-clsclaw-delegation-key': target.keyId,
        'x-clsclaw-signature': signature,
      },
      body,
    });
    const text = await response.text();
    let parsed = {};
    try { parsed = JSON.parse(text || '{}'); } catch {}
    const record = {
      id: randomUUID(),
      targetId: target.id,
      targetName: target.name,
      goal: JSON.parse(body).goal,
      role: JSON.parse(body).role,
      requestedBy: JSON.parse(body).requestedBy || null,
      createdAt: Date.now(),
      ok: response.ok,
      status: response.ok ? 'accepted' : 'error',
      response: parsed,
    };
    target.lastDispatchAt = record.createdAt;
    target.lastDispatchStatus = record.status;
    target.lastDispatchError = response.ok ? '' : (parsed.error || `HTTP ${response.status}`);
    target.healthStatus = response.ok ? 'reachable' : 'degraded';
    this._state.dispatches.unshift(record);
    this._state.dispatches = this._state.dispatches.slice(0, 100);
    this._save();
    if (!response.ok) throw new Error(parsed.error || `Delegation failed with ${response.status}`);
    return record;
  }

  verifyIncoming(rawBody, keyId, signature) {
    const target = (this._state.targets || []).find((item) => item.keyId === String(keyId || '') && item.enabled !== false);
    if (!target) return { ok: false, error: 'Delegation key not recognized' };
    if (!target.sharedSecret) return { ok: false, error: 'Delegation target is missing a shared secret' };
    const expected = signDelegationBody(rawBody, target.sharedSecret);
    const actual = String(signature || '');
    const left = Buffer.from(expected);
    const right = Buffer.from(actual);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return { ok: false, error: 'Delegation signature mismatch' };
    }
    return { ok: true, target: publicTarget(target) };
  }

  _findTarget(id) {
    return (this._state.targets || []).find((item) => item.id === String(id || '')) || null;
  }

  _load() {
    try {
      fs.mkdirSync(path.dirname(this._dataFile), { recursive: true });
      if (!fs.existsSync(this._dataFile)) return { targets: [], dispatches: [] };
      const parsed = JSON.parse(fs.readFileSync(this._dataFile, 'utf-8'));
      return {
        targets: Array.isArray(parsed.targets) ? parsed.targets : [],
        dispatches: Array.isArray(parsed.dispatches) ? parsed.dispatches : [],
      };
    } catch {
      return { targets: [], dispatches: [] };
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._dataFile), { recursive: true });
      fs.writeFileSync(this._dataFile, JSON.stringify(this._state, null, 2), 'utf-8');
    } catch {}
  }
}

function normalizeTarget(target = {}, keepMissing = false) {
  return {
    id: String(target.id || randomUUID()),
    name: String(target.name || 'Remote clsClaw').trim() || 'Remote clsClaw',
    url: String(target.url || '').trim().replace(/\/+$/, ''),
    keyId: String(target.keyId || `key-${randomUUID().slice(0, 8)}`),
    sharedSecret: keepMissing && !Object.prototype.hasOwnProperty.call(target, 'sharedSecret')
      ? target.sharedSecret
      : String(target.sharedSecret || '').trim(),
    enabled: target.enabled !== false,
    createdAt: Number(target.createdAt || Date.now()),
    lastDispatchAt: Number(target.lastDispatchAt || 0) || null,
    lastDispatchStatus: String(target.lastDispatchStatus || '').trim() || '',
    lastDispatchError: String(target.lastDispatchError || '').trim(),
    lastPingAt: Number(target.lastPingAt || 0) || null,
    healthStatus: String(target.healthStatus || '').trim() || '',
    lastPingError: String(target.lastPingError || '').trim(),
  };
}

function publicTarget(target) {
  return {
    id: target.id,
    name: target.name,
    url: target.url,
    keyId: target.keyId,
    enabled: target.enabled !== false,
    createdAt: target.createdAt,
    sharedSecretConfigured: Boolean(target.sharedSecret),
    lastDispatchAt: target.lastDispatchAt || null,
    lastDispatchStatus: target.lastDispatchStatus || null,
    lastDispatchError: target.lastDispatchError || '',
    lastPingAt: target.lastPingAt || null,
    healthStatus: target.healthStatus || null,
    lastPingError: target.lastPingError || '',
  };
}

function signDelegationBody(rawBody, sharedSecret) {
  return `sha256=${createHmac('sha256', String(sharedSecret || '')).update(String(rawBody || '')).digest('hex')}`;
}

function joinUrl(base, suffix) {
  return `${String(base || '').replace(/\/+$/, '')}${suffix}`;
}

module.exports = {
  DelegationRegistry,
  signDelegationBody,
};
