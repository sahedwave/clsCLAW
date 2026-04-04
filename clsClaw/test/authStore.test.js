'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AuthStore } = require('../src/auth/authStore');

test('auth store bootstraps admin users and sessions locally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-auth-'));
  try {
    const store = new AuthStore(dir);
    const admin = store.bootstrap({
      username: 'Shahed',
      password: 'supersecret',
      displayName: 'Md Shahed Rahman',
    });
    assert.equal(admin.username, 'shahed');
    const authed = store.authenticate('shahed', 'supersecret');
    assert.equal(authed.role, 'admin');
    const session = store.createSession(authed.id);
    const lookup = store.getUserForToken(session.token);
    assert.equal(lookup.user.username, 'shahed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth store can create additional local users', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-auth-'));
  try {
    const store = new AuthStore(dir);
    store.bootstrap({ username: 'admin', password: 'supersecret' });
    const user = store.createUser({ username: 'ally', password: 'anotherpass', role: 'member' });
    assert.equal(user.role, 'member');
    assert.equal(store.listUsers().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auth store can disable users and revoke their sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-auth-'));
  try {
    const store = new AuthStore(dir);
    store.bootstrap({ username: 'admin', password: 'supersecret' });
    const user = store.createUser({ username: 'ally', password: 'anotherpass', role: 'member' });
    const session = store.createSession(user.id);
    assert.equal(store.getUserForToken(session.token).user.username, 'ally');
    const updated = store.updateUser(user.id, { disabled: true });
    assert.equal(updated.disabled, true);
    assert.equal(store.getUserForToken(session.token), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
