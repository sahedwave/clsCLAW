'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

class TunnelManager {
  constructor({ dataFile, spawnImpl = spawn, spawnSyncImpl = spawnSync } = {}) {
    this._dataFile = dataFile;
    this._spawn = spawnImpl;
    this._spawnSync = spawnSyncImpl;
    this._proc = null;
    this._state = this._loadState();
  }

  getStatus() {
    return {
      provider: this._state.provider || 'none',
      configuredPort: this._state.port || null,
      publicUrl: this._state.publicUrl || '',
      status: this._proc ? 'running' : (this._state.status || 'idle'),
      availableProviders: this.listProviders(),
      lastError: this._state.lastError || '',
      startedAt: this._state.startedAt || null,
    };
  }

  listProviders() {
    return ['cloudflared', 'ngrok'].map((provider) => ({
      id: provider,
      installed: this._binaryExists(provider),
    }));
  }

  configure({ provider = 'cloudflared', port = 3737, publicUrl = '' } = {}) {
    this._state = {
      ...this._state,
      provider: normalizeProvider(provider),
      port: Math.max(1, Number(port) || 3737),
      publicUrl: String(publicUrl || '').trim(),
      status: this._state.publicUrl ? 'configured' : 'idle',
    };
    this._saveState();
    return this.getStatus();
  }

  start({ provider = null, port = null } = {}) {
    const nextProvider = normalizeProvider(provider || this._state.provider || 'cloudflared');
    const nextPort = Math.max(1, Number(port || this._state.port || 3737));
    if (!this._binaryExists(nextProvider)) {
      throw new Error(`${nextProvider} is not installed on this machine`);
    }
    this.stop();
    const args = nextProvider === 'ngrok'
      ? ['http', String(nextPort), '--log', 'stdout']
      : ['tunnel', '--url', `http://127.0.0.1:${nextPort}`, '--no-autoupdate'];
    const proc = this._spawn(nextProvider, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._proc = proc;
    this._state = {
      ...this._state,
      provider: nextProvider,
      port: nextPort,
      status: 'starting',
      lastError: '',
      startedAt: Date.now(),
    };
    const handleOutput = (chunk) => {
      const text = String(chunk || '');
      const detected = detectPublicUrl(text);
      if (detected) {
        this._state.publicUrl = detected;
        this._state.status = 'running';
        this._saveState();
      }
    };
    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);
    proc.on('exit', (code) => {
      this._proc = null;
      this._state.status = code === 0 ? 'stopped' : 'error';
      if (code !== 0 && !this._state.lastError) this._state.lastError = `${nextProvider} exited with code ${code}`;
      this._saveState();
    });
    proc.on('error', (err) => {
      this._proc = null;
      this._state.status = 'error';
      this._state.lastError = err.message;
      this._saveState();
    });
    this._saveState();
    return this.getStatus();
  }

  stop() {
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch {}
      this._proc = null;
    }
    this._state.status = 'stopped';
    this._saveState();
    return this.getStatus();
  }

  _binaryExists(binary) {
    const result = this._spawnSync(binary, ['--version'], { stdio: 'ignore' });
    return !result.error;
  }

  _loadState() {
    try {
      fs.mkdirSync(path.dirname(this._dataFile), { recursive: true });
      if (!fs.existsSync(this._dataFile)) return {};
      const parsed = JSON.parse(fs.readFileSync(this._dataFile, 'utf-8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(this._dataFile), { recursive: true });
      fs.writeFileSync(this._dataFile, JSON.stringify(this._state, null, 2), 'utf-8');
    } catch {}
  }
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase() === 'ngrok' ? 'ngrok' : 'cloudflared';
}

function detectPublicUrl(text = '') {
  const match = String(text).match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"]*)?/i);
  return match ? match[0] : '';
}

module.exports = {
  TunnelManager,
  detectPublicUrl,
};
