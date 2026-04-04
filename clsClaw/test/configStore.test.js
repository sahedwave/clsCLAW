'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const {
  CONFIG_PATH,
  saveConfig,
  resolveProviderConfig,
  getMaskedProviderConfig,
  getProviderStatus,
} = require('../src/configStore');

const originalConfig = fs.existsSync(CONFIG_PATH)
  ? fs.readFileSync(CONFIG_PATH, 'utf-8')
  : null;

function cleanupConfig() {
  if (originalConfig === null) {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    return;
  }
  fs.writeFileSync(CONFIG_PATH, originalConfig, 'utf-8');
}

test.beforeEach(() => {
  if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
});

test.after(cleanupConfig);

test('resolveProviderConfig merges stored values with request overrides', () => {
  saveConfig({
    anthropicKey: 'stored-anthropic',
    openaiKey: 'stored-openai',
    githubToken: 'ghp_stored',
    ollamaUrl: 'http://localhost:11434/api/generate',
    embeddingProvider: 'openai',
  });

  const resolved = resolveProviderConfig({
    openai: 'request-openai',
    ollamaModel: 'qwen2.5-coder:7b',
  });

  assert.equal(resolved.anthropic, 'stored-anthropic');
  assert.equal(resolved.openai, 'request-openai');
  assert.equal(resolved.githubToken, 'ghp_stored');
  assert.equal(resolved.ollamaUrl, 'http://localhost:11434/api/generate');
  assert.equal(resolved.ollamaModel, 'qwen2.5-coder:7b');
  assert.equal(resolved.embeddingProvider, 'openai');
});

test('resolveProviderConfig honors explicit empty values so keys can be cleared', () => {
  saveConfig({ anthropicKey: 'stored-anthropic' });

  const resolved = resolveProviderConfig({ anthropicKey: '' });

  assert.equal(resolved.anthropic, '');
});

test('masked provider config and status report configured providers', () => {
  saveConfig({
    openaiKey: 'sk-openai-1234',
    githubToken: 'ghp_secret_1234',
    slackWebhookUrl: 'https://hooks.slack.com/services/T000/B000/secret',
    githubWebhookSecret: 'github-secret-1234',
    ollamaEmbeddingModel: 'nomic-embed-text',
    embeddingProvider: 'openai',
  });

  const masked = getMaskedProviderConfig();
  const status = getProviderStatus();

  assert.match(masked.openaiKey, /^\*+1234$/);
  assert.match(masked.githubToken, /^\*+1234$/);
  assert.equal(masked.slackConfigured, true);
  assert.equal(masked.githubWebhookConfigured, true);
  assert.equal(masked.ollamaEmbeddingModel, 'nomic-embed-text');
  assert.equal(masked.embeddingProvider, 'openai');
  assert.equal(status.anthropicConfigured, false);
  assert.equal(status.openaiConfigured, true);
  assert.equal(status.githubConfigured, true);
  assert.equal(status.slackConfigured, true);
  assert.equal(status.githubWebhookConfigured, true);
  assert.equal(status.embeddingProvider, 'openai');
  assert.equal(status.llmConfigured, true);
});
