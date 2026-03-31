'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveKeys, routeProviders } = require('../src/llm/modelRouter');

test('resolveKeys supports multi-provider objects including local model settings', () => {
  const resolved = resolveKeys({
    anthropic: 'anthropic-key',
    openai: 'openai-key',
    ollamaUrl: 'http://127.0.0.1:11434/api/generate',
    ollamaModel: 'codellama:13b',
  });

  assert.equal(resolved.anthropic, 'anthropic-key');
  assert.equal(resolved.openai, 'openai-key');
  assert.equal(resolved.localUrl, 'http://127.0.0.1:11434/api/generate');
  assert.equal(resolved.localModel, 'codellama:13b');
  assert.equal(resolved.localConfigured, true);
});

test('resolveKeys does not enable Ollama fallback when no local config is provided', () => {
  const previousUrl = process.env.OLLAMA_URL;
  const previousModel = process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_URL;
  delete process.env.OLLAMA_MODEL;

  const resolved = resolveKeys({ openai: 'openai-key' });

  assert.equal(resolved.localConfigured, false);
  assert.equal(resolved.localUrl, '');
  assert.equal(resolved.localModel, '');

  if (previousUrl !== undefined) process.env.OLLAMA_URL = previousUrl;
  if (previousModel !== undefined) process.env.OLLAMA_MODEL = previousModel;
});

test('routeProviders keeps role-specific fallback order stable', () => {
  assert.deepEqual(routeProviders('docs'), ['local', 'openai', 'claude']);
  assert.deepEqual(routeProviders('test'), ['openai', 'claude']);
  assert.deepEqual(routeProviders('code'), ['claude', 'openai', 'local']);
});
