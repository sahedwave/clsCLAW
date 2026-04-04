'use strict';

const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings';
const ANTHROPIC_EMBED_URL = 'https://api.anthropic.com/v1/embeddings';
const OLLAMA_EMBED_PATH = '/api/embeddings';

const PROVIDERS = {
  ollama: {
    key: 'ollama',
    label: 'Ollama',
    model: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
    requires: 'ollama',
  },
  openai: {
    key: 'openai',
    label: 'OpenAI',
    model: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
    requires: 'openai',
  },
  anthropic: {
    key: 'anthropic',
    label: 'Anthropic',
    model: process.env.ANTHROPIC_EMBED_MODEL || 'voyage-code-2',
    requires: 'anthropic',
  },
};

function normalizeEmbeddingPreference(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'auto') return 'auto';
  if (normalized === 'disabled' || normalized === 'off' || normalized === 'none') return 'disabled';
  if (normalized === 'ollama' || normalized === 'local') return 'ollama';
  if (normalized === 'openai') return 'openai';
  if (normalized === 'anthropic') return 'anthropic';
  return 'auto';
}

function resolveEmbeddingProvider(config = {}) {
  const preference = normalizeEmbeddingPreference(config.embeddingProvider);
  if (preference === 'disabled') return null;

  const available = [];
  if (config.ollamaUrl || config.ollamaModel || config.ollamaEmbeddingModel) available.push('ollama');
  if (config.openai) available.push('openai');
  if (config.anthropic) available.push('anthropic');

  if (preference !== 'auto') {
    if (!available.includes(preference)) return null;
    return {
      ...PROVIDERS[preference],
      apiKey: config[PROVIDERS[preference].requires],
      url: normalizeOllamaUrl(config.ollamaUrl),
      model: preference === 'ollama'
        ? String(config.ollamaEmbeddingModel || config.ollamaModel || PROVIDERS.ollama.model)
        : PROVIDERS[preference].model,
      preference,
    };
  }

  const chosen = available[0] || null;
  if (!chosen) return null;
  return {
    ...PROVIDERS[chosen],
    apiKey: config[PROVIDERS[chosen].requires],
    url: normalizeOllamaUrl(config.ollamaUrl),
    model: chosen === 'ollama'
      ? String(config.ollamaEmbeddingModel || config.ollamaModel || PROVIDERS.ollama.model)
      : PROVIDERS[chosen].model,
    preference: 'auto',
  };
}

function describeEmbeddingStatus(config = {}) {
  const preference = normalizeEmbeddingPreference(config.embeddingProvider);
  const active = resolveEmbeddingProvider(config);
  return {
    selected: preference,
    active: active?.key || null,
    activeModel: active?.model || null,
    available: Object.keys(PROVIDERS).filter((key) => (
      key === 'ollama'
        ? Boolean(config.ollamaUrl || config.ollamaModel || config.ollamaEmbeddingModel)
        : Boolean(config[PROVIDERS[key].requires])
    )),
    enabled: Boolean(active),
  };
}

async function fetchEmbeddings(texts, provider, { fetchImpl = fetch, signal = null } = {}) {
  if (!provider) throw new Error('Embedding provider is required');
  const items = Array.isArray(texts) ? texts : [];
  if (provider.key === 'openai') {
    return fetchOpenAIEmbeddings(items, provider, { fetchImpl, signal });
  }
  if (provider.key === 'anthropic') {
    return fetchAnthropicEmbeddings(items, provider, { fetchImpl, signal });
  }
  if (provider.key === 'ollama') {
    return fetchOllamaEmbeddings(items, provider, { fetchImpl, signal });
  }
  throw new Error(`Unsupported embedding provider: ${provider.key}`);
}

function normalizeOllamaUrl(value = '') {
  const raw = String(value || '').trim() || process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
  try {
    const parsed = new URL(raw);
    parsed.pathname = OLLAMA_EMBED_PATH;
    parsed.search = '';
    return parsed.toString();
  } catch {
    return `http://localhost:11434${OLLAMA_EMBED_PATH}`;
  }
}

async function fetchOpenAIEmbeddings(texts, provider, { fetchImpl, signal }) {
  const response = await fetchImpl(OPENAI_EMBED_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      input: texts,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI embeddings ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  return (data.data || []).map((item) => item.embedding);
}

async function fetchAnthropicEmbeddings(texts, provider, { fetchImpl, signal }) {
  const response = await fetchImpl(ANTHROPIC_EMBED_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: provider.model,
      input: texts,
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic embeddings ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  return (data.embeddings || []).map((item) => item.embedding);
}

async function fetchOllamaEmbeddings(texts, provider, { fetchImpl, signal }) {
  const vectors = [];
  for (const prompt of texts) {
    const response = await fetchImpl(provider.url || normalizeOllamaUrl(), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model || PROVIDERS.ollama.model,
        prompt,
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embeddings ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    const vector = Array.isArray(data.embedding) ? data.embedding : Array.isArray(data.embeddings) ? data.embeddings[0] : null;
    if (!Array.isArray(vector)) {
      throw new Error('Ollama embeddings response did not include an embedding vector');
    }
    vectors.push(vector);
  }
  return vectors;
}

module.exports = {
  PROVIDERS,
  normalizeEmbeddingPreference,
  resolveEmbeddingProvider,
  describeEmbeddingStatus,
  fetchEmbeddings,
};
