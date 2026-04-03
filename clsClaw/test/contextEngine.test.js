'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ContextEngine = require('../src/context/contextEngine');

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-context-'));
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'auth.js'), `
    export function validateToken(token) {
      return token && token.startsWith('bearer ');
    }
    export function authMiddleware(req, res, next) {
      return next();
    }
  `, 'utf-8');
  fs.writeFileSync(path.join(workspace, 'src', 'payments.js'), `
    export function chargeCard(card) {
      return card;
    }
  `, 'utf-8');
  return workspace;
}

test('context engine builds and queries semantic embeddings through the selected provider', async () => {
  const workspace = makeWorkspace();
  const indexDir = path.join(workspace, '.index');
  let embeddingCalls = 0;
  const engine = new ContextEngine(indexDir, {
    fetchImpl: async (url, opts) => {
      embeddingCalls++;
      const body = JSON.parse(opts.body);
      const inputs = body.input || [];
      return {
        ok: true,
        json: async () => ({
          data: inputs.map((text) => ({
            embedding: vectorFor(text),
          })),
        }),
        text: async () => '',
      };
    },
  });

  engine.setIndexDir(indexDir);
  const stats = await engine.buildIndex(workspace, {
    providerConfig: {
      openai: 'sk-openai',
      embeddingProvider: 'openai',
    },
    buildEmbeddings: true,
  });

  const query = await engine.query('validate token auth middleware', {
    providerConfig: {
      openai: 'sk-openai',
      embeddingProvider: 'openai',
    },
  });

  assert.equal(stats.embeddingProvider, 'openai');
  assert.equal(query.mode, 'hybrid');
  assert.equal(query.embeddingProvider, 'openai');
  assert.equal(query.files[0].relativePath, path.join('src', 'auth.js'));
  assert.ok(embeddingCalls >= 2);

  fs.rmSync(workspace, { recursive: true, force: true });
});

function vectorFor(text) {
  const source = String(text || '').toLowerCase();
  const auth = Number(source.includes('auth') || source.includes('token') || source.includes('validate'));
  const payment = Number(source.includes('payment') || source.includes('card') || source.includes('charge'));
  const generic = source.length % 7;
  return [auth + 0.1, payment + 0.1, generic / 10];
}
