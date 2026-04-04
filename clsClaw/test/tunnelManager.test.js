'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { TunnelManager, detectPublicUrl } = require('../src/remote/tunnelManager');

test('detectPublicUrl extracts public tunnel URLs from process output', () => {
  assert.equal(detectPublicUrl('Visit https://demo.trycloudflare.com to inspect.'), 'https://demo.trycloudflare.com');
});

test('tunnel manager configures and starts with a detected public URL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-tunnel-'));
  try {
    const spawned = [];
    const manager = new TunnelManager({
      dataFile: path.join(dir, 'tunnel.json'),
      spawnSyncImpl(binary) {
        return { error: binary === 'cloudflared' ? null : new Error('missing') };
      },
      spawnImpl(binary, args) {
        spawned.push({ binary, args });
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.kill = () => proc.emit('exit', 0);
        setImmediate(() => proc.stdout.emit('data', 'Ready: https://demo.trycloudflare.com'));
        return proc;
      },
    });
    manager.configure({ provider: 'cloudflared', port: 4040 });
    const state = manager.start();
    assert.equal(state.provider, 'cloudflared');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const running = manager.getStatus();
    assert.equal(running.publicUrl, 'https://demo.trycloudflare.com');
    assert.equal(spawned[0].binary, 'cloudflared');
    manager.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
