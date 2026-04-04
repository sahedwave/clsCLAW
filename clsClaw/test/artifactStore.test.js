'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ArtifactStore } = require('../src/artifacts/artifactStore');

test('artifact store persists and reloads saved artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-artifacts-'));
  try {
    const store = new ArtifactStore(root);
    const artifact = store.create({
      type: 'heartbeat:weekly-coding-report',
      title: 'Weekly coding report',
      summary: 'Hot files and commit activity',
      content: '# Weekly coding report\n- src/server.js',
      projectRoot: '/tmp/demo',
      metadata: { highlights: ['src/server.js'] },
      createdBy: { username: 'shahed', role: 'admin' },
    });

    assert.ok(artifact.id);
    const listed = store.list();
    assert.equal(listed[0].id, artifact.id);

    const loaded = store.get(artifact.id);
    assert.equal(loaded.title, 'Weekly coding report');
    assert.equal(loaded.createdBy.username, 'shahed');
    assert.match(loaded.content, /src\/server\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('artifact store can update existing artifact metadata and summary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-artifacts-update-'));
  try {
    const store = new ArtifactStore(root);
    const artifact = store.create({
      type: 'turn-report',
      title: 'Turn report',
      summary: 'Initial',
      content: '{}',
    });

    const updated = store.update(artifact.id, {
      summary: 'Updated summary',
      metadata: { verificationStatus: 'passed' },
    });

    assert.equal(updated.summary, 'Updated summary');
    assert.equal(updated.metadata.verificationStatus, 'passed');
    assert.equal(store.get(artifact.id).summary, 'Updated summary');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
