'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveKeys, routeProviders, normalizeInputMessages, hasImageInputs } = require('../src/llm/modelRouter');

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

test('routeProviders prefers multimodal providers when images are attached', () => {
  assert.deepEqual(routeProviders('code', { hasImages: true }), ['openai', 'claude']);
  assert.deepEqual(routeProviders('analyze', { hasImages: true }), ['openai', 'claude']);
});

test('normalizeInputMessages preserves structured text and image parts', () => {
  const messages = normalizeInputMessages({
    system: 'system prompt',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this screenshot' },
        { type: 'image', dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png', name: 'screen.png' },
      ],
    }],
  });

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content[1].type, 'image');
  assert.equal(messages[1].content[1].name, 'screen.png');
  assert.equal(hasImageInputs(messages), true);
});
