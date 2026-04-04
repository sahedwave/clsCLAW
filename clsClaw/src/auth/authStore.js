'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes, randomUUID, scryptSync, timingSafeEqual } = require('crypto');

class AuthStore {
  constructor(dataDir) {
    this._dir = dataDir;
    this._usersFile = path.join(dataDir, 'users.json');
    this._sessionsFile = path.join(dataDir, 'sessions.json');
    this._users = [];
    this._sessions = [];
    fs.mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  isConfigured() {
    return this._users.length > 0;
  }

  listUsers() {
    return this._users.map((user) => publicUser(user));
  }

  listSessions() {
    this._sessions = this._sessions.filter((entry) => Number(entry.expiresAt || 0) > Date.now());
    this._save();
    return this._sessions.map((session) => publicSession(session));
  }

  bootstrap({ username, password, displayName = '', role = 'admin' } = {}) {
    if (this.isConfigured()) throw new Error('Auth is already configured');
    const user = this._createUserRecord({ username, password, displayName, role });
    this._users.push(user);
    this._save();
    return publicUser(user);
  }

  createUser({ username, password, displayName = '', role = 'member' } = {}) {
    const user = this._createUserRecord({ username, password, displayName, role });
    this._users.push(user);
    this._save();
    return publicUser(user);
  }

  updateUser(id, patch = {}) {
    const user = this._users.find((entry) => entry.id === String(id || ''));
    if (!user) return null;
    if (Object.prototype.hasOwnProperty.call(patch, 'displayName')) {
      user.displayName = String(patch.displayName || '').trim() || user.username;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'role')) {
      user.role = normalizeRole(patch.role);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'disabled')) {
      user.disabled = Boolean(patch.disabled);
      if (user.disabled) this.revokeSessionsForUser(user.id);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'password') && patch.password) {
      if (String(patch.password).length < 8) throw new Error('Password must be at least 8 characters');
      user.passwordHash = hashPassword(patch.password);
    }
    this._save();
    return publicUser(user);
  }

  deleteUser(id) {
    const key = String(id || '');
    const idx = this._users.findIndex((entry) => entry.id === key);
    if (idx < 0) return { ok: false, error: 'User not found' };
    const [user] = this._users.splice(idx, 1);
    this.revokeSessionsForUser(key);
    this._save();
    return { ok: true, user: publicUser(user) };
  }

  authenticate(username, password) {
    const normalized = normalizeUsername(username);
    const user = this._users.find((entry) => entry.username === normalized && entry.disabled !== true);
    if (!user) return null;
    if (!verifyPassword(password, user.passwordHash)) return null;
    user.lastLoginAt = Date.now();
    this._save();
    return publicUser(user);
  }

  createSession(userId, { ttlMs = 1000 * 60 * 60 * 24 * 14, label = '', device = '', userAgent = '', ip = '' } = {}) {
    const user = this._users.find((entry) => entry.id === userId && entry.disabled !== true);
    if (!user) throw new Error('User not found');
    const token = randomBytes(32).toString('hex');
    const session = {
      id: randomUUID(),
      token,
      userId,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      lastSeenAt: Date.now(),
      label: normalizeSessionLabel(label, user.displayName || user.username),
      device: normalizeDeviceLabel(device || inferDeviceFromUserAgent(userAgent)),
      userAgent: String(userAgent || '').slice(0, 240),
      ip: String(ip || '').trim().slice(0, 120),
    };
    this._sessions = this._sessions.filter((entry) => Number(entry.expiresAt || 0) > Date.now());
    this._sessions.push(session);
    this._save();
    return {
      token,
      session: publicSession(session),
      user: publicUser(user),
    };
  }

  updateSession(id, patch = {}) {
    const session = this._sessions.find((entry) => entry.id === String(id || ''));
    if (!session) return null;
    if (Object.prototype.hasOwnProperty.call(patch, 'label')) {
      session.label = normalizeSessionLabel(patch.label, session.label || 'Workspace session');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'device')) {
      session.device = normalizeDeviceLabel(patch.device || session.device);
    }
    this._save();
    return publicSession(session);
  }

  getUserForToken(token) {
    if (!token) return null;
    const session = this._sessions.find((entry) => entry.token === token);
    if (!session) return null;
    if (Number(session.expiresAt || 0) <= Date.now()) {
      this.revokeSession(token);
      return null;
    }
    session.lastSeenAt = Date.now();
    const user = this._users.find((entry) => entry.id === session.userId && entry.disabled !== true);
    if (!user) {
      this.revokeSession(token);
      return null;
    }
    this._save();
    return {
      user: publicUser(user),
      session: publicSession(session),
    };
  }

  revokeSession(token) {
    const before = this._sessions.length;
    this._sessions = this._sessions.filter((entry) => entry.token !== token);
    if (this._sessions.length !== before) this._save();
    return { ok: true };
  }

  revokeSessionById(id) {
    const before = this._sessions.length;
    this._sessions = this._sessions.filter((entry) => entry.id !== String(id || ''));
    if (this._sessions.length !== before) this._save();
    return { ok: true, revoked: before - this._sessions.length };
  }

  revokeSessionsForUser(userId) {
    const before = this._sessions.length;
    this._sessions = this._sessions.filter((entry) => entry.userId !== userId);
    if (this._sessions.length !== before) this._save();
    return { ok: true, revoked: before - this._sessions.length };
  }

  _createUserRecord({ username, password, displayName = '', role = 'member' } = {}) {
    const normalized = normalizeUsername(username);
    if (!normalized) throw new Error('Username required');
    if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
    if (this._users.some((entry) => entry.username === normalized)) throw new Error('Username already exists');
    return {
      id: randomUUID(),
      username: normalized,
      displayName: String(displayName || '').trim() || normalized,
      role: normalizeRole(role),
      passwordHash: hashPassword(password),
      createdAt: Date.now(),
      lastLoginAt: null,
      disabled: false,
    };
  }

  _load() {
    try {
      if (fs.existsSync(this._usersFile)) {
        const parsed = JSON.parse(fs.readFileSync(this._usersFile, 'utf-8'));
        if (Array.isArray(parsed)) this._users = parsed;
      }
    } catch {}
    try {
      if (fs.existsSync(this._sessionsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this._sessionsFile, 'utf-8'));
        if (Array.isArray(parsed)) this._sessions = parsed.filter((entry) => Number(entry.expiresAt || 0) > Date.now());
      }
    } catch {}
  }

  _save() {
    fs.mkdirSync(this._dir, { recursive: true });
    fs.writeFileSync(this._usersFile, JSON.stringify(this._users, null, 2), 'utf-8');
    fs.writeFileSync(this._sessionsFile, JSON.stringify(this._sessions, null, 2), 'utf-8');
  }
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, digest] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const actual = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    disabled: Boolean(user.disabled),
  };
}

function publicSession(session) {
  if (!session) return null;
  const age = Math.max(0, Date.now() - Number(session.lastSeenAt || session.createdAt || 0));
  return {
    id: session.id,
    userId: session.userId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    label: session.label || 'Workspace session',
    device: session.device || '',
    presence: age < 1000 * 60 * 5 ? 'active' : age < 1000 * 60 * 30 ? 'idle' : 'away',
  };
}

function normalizeSessionLabel(value, fallback = 'Workspace session') {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return String(fallback || 'Workspace session');
  return normalized.slice(0, 80);
}

function normalizeDeviceLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function inferDeviceFromUserAgent(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return '';
  const platform = ua.includes('mac os') ? 'macOS' : ua.includes('windows') ? 'Windows' : ua.includes('linux') ? 'Linux' : ua.includes('iphone') || ua.includes('ios') ? 'iPhone' : ua.includes('android') ? 'Android' : '';
  const client = ua.includes('safari') && !ua.includes('chrome') ? 'Safari' : ua.includes('chrome') ? 'Chrome' : ua.includes('firefox') ? 'Firefox' : ua.includes('codex') ? 'Codex app' : ua.includes('mozilla') ? 'Browser' : '';
  return [platform, client].filter(Boolean).join(' · ');
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '');
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin' || role === 'member' || role === 'viewer') return role;
  return 'member';
}

module.exports = {
  AuthStore,
};
