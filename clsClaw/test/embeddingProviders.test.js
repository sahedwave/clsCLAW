'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEmbeddingPreference,
  resolveEmbeddingProvider,
  fetchEmbeddings,
} = require('../src/context/embeddingProviders');

test('embedding provider normalization supports ollama/local', () => {
  assert.equal(normalizeEmbeddingPreference('ollama'), 'ollama');
  assert.equal(normalizeEmbeddingPreference('local'), 'ollama');
});

test('embedding provider resolution can choose ollama locally', () => {
  const provider = resolveEmbeddingProvider({
    ollamaUrl: 'http://localhost:11434/api/generate',
    ollamaEmbeddingModel: 'nomic-embed-text',
    embeddingProvider: 'ollama',
  });
  assert.equal(provider.key, 'ollama');
  assert.equal(provider.model, 'nomic-embed-text');
  assert.match(provider.url, /\/api\/embeddings$/);
});

test('ollama embedding fetch uses the local embeddings endpoint', async () => {
  const calls = [];
  const vectors = await fetchEmbeddings(['hello'], {
    key: 'ollama',
    url: 'http://localhost:11434/api/embeddings',
    model: 'nomic-embed-text',
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:11434/api/embeddings');
  assert.deepEqual(vectors, [[0.1, 0.2, 0.3]]);
});
