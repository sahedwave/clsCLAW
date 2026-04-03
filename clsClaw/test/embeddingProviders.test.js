'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveEmbeddingProvider,
  describeEmbeddingStatus,
  fetchEmbeddings,
} = require('../src/context/embeddingProviders');

test('resolveEmbeddingProvider honors explicit provider choice when credentials exist', () => {
  const provider = resolveEmbeddingProvider({
    openai: 'sk-openai',
    anthropic: 'sk-anthropic',
    embeddingProvider: 'anthropic',
  });

  assert.equal(provider.key, 'anthropic');
  assert.equal(provider.apiKey, 'sk-anthropic');
});

test('resolveEmbeddingProvider auto-selects OpenAI before Anthropic when both are configured', () => {
  const provider = resolveEmbeddingProvider({
    openai: 'sk-openai',
    anthropic: 'sk-anthropic',
    embeddingProvider: 'auto',
  });

  assert.equal(provider.key, 'openai');
});

test('describeEmbeddingStatus reports selected and active providers', () => {
  const status = describeEmbeddingStatus({
    anthropic: 'sk-anthropic',
    embeddingProvider: 'auto',
  });

  assert.equal(status.selected, 'auto');
  assert.equal(status.active, 'anthropic');
  assert.ok(status.available.includes('anthropic'));
});

test('fetchEmbeddings uses OpenAI response format when selected', async () => {
  const vectors = await fetchEmbeddings(['hello'], {
    key: 'openai',
    model: 'text-embedding-3-small',
    apiKey: 'sk-openai',
  }, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    }),
  });

  assert.deepEqual(vectors, [[0.1, 0.2, 0.3]]);
});
