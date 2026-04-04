'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHmac } = require('crypto');

const { GitHubWebhookStore, verifyGitHubSignature } = require('../src/github/webhookStore');

test('github webhook store records recent deliveries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-webhooks-'));
  try {
    const store = new GitHubWebhookStore(path.join(dir, 'webhooks.json'));
    const event = store.ingest({
      event: 'issues',
      deliveryId: 'delivery-1',
      action: 'opened',
      repository: 'sahedwave/clsCLAW',
      sender: 'shahedwave',
      artifactId: 'artifact-1',
      payload: { issue: { title: 'Bug report' } },
    });
    assert.equal(event.event, 'issues');
    assert.equal(event.artifactId, 'artifact-1');
    assert.equal(store.list(1)[0].deliveryId, 'delivery-1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook signature verification validates sha256 payloads', () => {
  const body = JSON.stringify({ action: 'opened' });
  const secret = 'top-secret';
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyGitHubSignature(body, secret, signature).ok, true);
  assert.equal(verifyGitHubSignature(body, secret, 'sha256=bad').ok, false);
});
