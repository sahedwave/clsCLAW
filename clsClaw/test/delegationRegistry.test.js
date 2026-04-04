'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DelegationRegistry, signDelegationBody } = require('../src/remote/delegationRegistry');

test('delegation registry stores targets and signs outbound dispatches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-delegation-'));
  try {
    const seen = [];
    const registry = new DelegationRegistry({
      dataFile: path.join(dir, 'delegation.json'),
      fetchImpl: async (url, options) => {
        seen.push({ url, options });
        return {
          ok: true,
          text: async () => JSON.stringify({ ok: true, accepted: true }),
        };
      },
    });
    const target = registry.createTarget({
      name: 'Remote A',
      url: 'https://remote.example.com',
      sharedSecret: 'secret-123',
    });
    const dispatch = await registry.dispatchTask(target.id, {
      goal: 'Review the settings workflow',
      role: 'review',
    });
    assert.equal(dispatch.status, 'accepted');
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/api\/delegation\/execute$/);
    assert.match(String(seen[0].options.headers['x-clsclaw-signature']), /^sha256=/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delegation registry verifies inbound signed requests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-delegation-'));
  try {
    const registry = new DelegationRegistry({
      dataFile: path.join(dir, 'delegation.json'),
      fetchImpl: async () => ({ ok: true, text: async () => '{}' }),
    });
    const target = registry.createTarget({
      name: 'Remote B',
      url: 'https://remote.example.com',
      sharedSecret: 'top-secret',
      keyId: 'demo-key',
    });
    const body = JSON.stringify({ goal: 'Build feature' });
    const verification = registry.verifyIncoming(body, target.keyId, signDelegationBody(body, 'top-secret'));
    assert.equal(verification.ok, true);
    assert.equal(verification.target.name, 'Remote B');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('delegation registry can ping a target and persist health metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-delegation-'));
  try {
    const registry = new DelegationRegistry({
      dataFile: path.join(dir, 'delegation.json'),
      fetchImpl: async (url) => ({
        ok: /\/api\/health$/.test(url),
        status: 200,
        text: async () => '{}',
      }),
    });
    const target = registry.createTarget({
      name: 'Remote C',
      url: 'https://remote.example.com',
      sharedSecret: 'top-secret',
    });
    const result = await registry.pingTarget(target.id);
    assert.equal(result.ok, true);
    const listed = registry.listTargets();
    assert.equal(listed[0].healthStatus, 'reachable');
    assert.equal(Boolean(listed[0].lastPingAt), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
