'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ImageStore, parseImageDataUrl } = require('../src/media/imageStore');

test('parseImageDataUrl validates supported image payloads', () => {
  const parsed = parseImageDataUrl('data:image/png;base64,AAAA');
  assert.equal(parsed.mimeType, 'image/png');
  assert.equal(Buffer.isBuffer(parsed.buffer), true);
});

test('image store saves and reloads uploaded image metadata and payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-images-'));
  const store = new ImageStore(dir);
  const saved = store.saveDataUrl({
    name: 'screen.png',
    dataUrl: 'data:image/png;base64,AAAA',
  });

  assert.equal(saved.name, 'screen.png');
  assert.match(saved.url, /^\/api\/uploads\//);

  const loaded = store.readAttachment(saved.id);
  assert.equal(loaded.mimeType, 'image/png');
  assert.equal(loaded.name, 'screen.png');
  assert.match(loaded.dataUrl, /^data:image\/png;base64,/);

  fs.rmSync(dir, { recursive: true, force: true });
});
