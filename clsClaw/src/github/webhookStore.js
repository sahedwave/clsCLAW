'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID, createHmac, timingSafeEqual } = require('crypto');

class GitHubWebhookStore {
  constructor(dataFile) {
    this._file = dataFile;
    this._events = [];
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    this._load();
  }

  ingest({ event, deliveryId, payload, action = '', repository = '', sender = '', artifactId = null } = {}) {
    const entry = {
      id: randomUUID(),
      deliveryId: String(deliveryId || randomUUID()),
      event: String(event || 'unknown'),
      action: String(action || ''),
      repository: String(repository || ''),
      sender: String(sender || ''),
      artifactId: artifactId ? String(artifactId) : null,
      summary: summarizeWebhook({ event, action, repository, sender, payload }),
      payload: payload && typeof payload === 'object' ? payload : {},
      receivedAt: Date.now(),
    };
    this._events.unshift(entry);
    this._events = this._events.slice(0, 200);
    this._save();
    return entry;
  }

  list(limit = 20) {
    return this._events.slice(0, Math.max(1, Number(limit) || 20));
  }

  get(id) {
    return this._events.find((entry) => entry.id === id || entry.deliveryId === id) || null;
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const parsed = JSON.parse(fs.readFileSync(this._file, 'utf-8'));
      if (Array.isArray(parsed)) this._events = parsed;
    } catch {
      this._events = [];
    }
  }

  _save() {
    fs.writeFileSync(this._file, JSON.stringify(this._events, null, 2), 'utf-8');
  }
}

function verifyGitHubSignature(rawBody, secret, signatureHeader) {
  const header = String(signatureHeader || '').trim();
  const key = String(secret || '').trim();
  if (!key) return { ok: false, reason: 'Webhook secret is not configured' };
  if (!header.startsWith('sha256=')) return { ok: false, reason: 'Missing sha256 signature' };
  const expected = Buffer.from(`sha256=${createHmac('sha256', key).update(rawBody).digest('hex')}`, 'utf-8');
  const received = Buffer.from(header, 'utf-8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'Signature mismatch' };
  }
  return { ok: true };
}

function summarizeWebhook({ event, action, repository, sender, payload } = {}) {
  const parts = [];
  if (event) parts.push(String(event));
  if (action) parts.push(String(action));
  if (repository) parts.push(`repo=${repository}`);
  if (sender) parts.push(`by=${sender}`);
  const issueTitle = payload?.issue?.title || payload?.pull_request?.title || payload?.comment?.body;
  if (issueTitle) parts.push(trimText(issueTitle, 96));
  return parts.join(' · ') || 'GitHub webhook received';
}

function trimText(text, max = 96) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

module.exports = {
  GitHubWebhookStore,
  verifyGitHubSignature,
};
