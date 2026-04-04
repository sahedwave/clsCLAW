'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstDefined(obj, keys = []) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  }
  return undefined;
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveConfig(nextConfig = {}) {
  const current = loadConfig();
  const merged = { ...current, ...nextConfig };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

function maskApiKey(key = '') {
  if (!key) return '';
  if (key.length <= 4) return '*'.repeat(key.length);
  return `${'*'.repeat(Math.max(0, key.length - 4))}${key.slice(-4)}`;
}

function maskUrlSecret(value = '') {
  const raw = normalizeString(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const maskedTail = parts.map((part, index) => (
      index < Math.max(0, parts.length - 1)
        ? part
        : `${'*'.repeat(Math.max(4, Math.min(12, part.length)))}`
    ));
    return `${parsed.origin}/${maskedTail.join('/')}`;
  } catch {
    return maskApiKey(raw);
  }
}

function resolveProviderConfig(preferred = {}) {
  const cfg = loadConfig();
  const input = typeof preferred === 'string' ? { anthropic: preferred } : (preferred || {});
  const preferredAnthropic = firstDefined(input, ['anthropic', 'anthropicKey', 'claude', 'apiKey']);
  const preferredOpenAI = firstDefined(input, ['openai', 'openaiKey']);
  const preferredGithub = firstDefined(input, ['githubToken', 'token']);
  const preferredLocalUrl = firstDefined(input, ['ollamaUrl', 'localUrl']);
  const preferredLocalModel = firstDefined(input, ['ollamaModel', 'localModel']);
  const preferredLocalEmbeddingModel = firstDefined(input, ['ollamaEmbeddingModel', 'localEmbeddingModel']);
  const preferredEmbeddingProvider = firstDefined(input, ['embeddingProvider', 'semanticProvider']);
  const preferredSlackWebhookUrl = firstDefined(input, ['slackWebhookUrl']);
  const preferredGithubWebhookSecret = firstDefined(input, ['githubWebhookSecret']);
  const preferredSandboxProvider = firstDefined(input, ['sandboxProvider']);

  return {
    anthropic: normalizeString(
      preferredAnthropic !== undefined ? preferredAnthropic :
      cfg.anthropicKey ||
      process.env.ANTHROPIC_API_KEY
    ),
    openai: normalizeString(
      preferredOpenAI !== undefined ? preferredOpenAI :
      cfg.openaiKey ||
      process.env.OPENAI_API_KEY
    ),
    githubToken: normalizeString(
      preferredGithub !== undefined ? preferredGithub :
      cfg.githubToken ||
      process.env.GITHUB_TOKEN
    ),
    ollamaUrl: normalizeString(
      preferredLocalUrl !== undefined ? preferredLocalUrl :
      cfg.ollamaUrl ||
      process.env.OLLAMA_URL
    ),
    ollamaModel: normalizeString(
      preferredLocalModel !== undefined ? preferredLocalModel :
      cfg.ollamaModel ||
      process.env.OLLAMA_MODEL
    ),
    ollamaEmbeddingModel: normalizeString(
      preferredLocalEmbeddingModel !== undefined ? preferredLocalEmbeddingModel :
      cfg.ollamaEmbeddingModel ||
      process.env.OLLAMA_EMBED_MODEL
    ),
    embeddingProvider: normalizeString(
      preferredEmbeddingProvider !== undefined ? preferredEmbeddingProvider :
      cfg.embeddingProvider ||
      process.env.EMBEDDING_PROVIDER ||
      'auto'
    ) || 'auto',
    slackWebhookUrl: normalizeString(
      preferredSlackWebhookUrl !== undefined ? preferredSlackWebhookUrl :
      cfg.slackWebhookUrl ||
      process.env.SLACK_WEBHOOK_URL
    ),
    githubWebhookSecret: normalizeString(
      preferredGithubWebhookSecret !== undefined ? preferredGithubWebhookSecret :
      cfg.githubWebhookSecret ||
      process.env.GITHUB_WEBHOOK_SECRET
    ),
    sandboxProvider: normalizeString(
      preferredSandboxProvider !== undefined ? preferredSandboxProvider :
      cfg.sandboxProvider ||
      process.env.CLSCLAW_SANDBOX_PROVIDER ||
      'auto'
    ) || 'auto',
  };
}

function getMaskedProviderConfig(preferred = {}) {
  const resolved = resolveProviderConfig(preferred);
  return {
    anthropicKey: maskApiKey(resolved.anthropic),
    openaiKey: maskApiKey(resolved.openai),
    githubToken: maskApiKey(resolved.githubToken),
    ollamaUrl: resolved.ollamaUrl,
    ollamaModel: resolved.ollamaModel,
    ollamaEmbeddingModel: resolved.ollamaEmbeddingModel,
    embeddingProvider: resolved.embeddingProvider || 'auto',
    slackWebhookUrl: maskUrlSecret(resolved.slackWebhookUrl),
    slackConfigured: Boolean(resolved.slackWebhookUrl),
    githubWebhookSecret: maskApiKey(resolved.githubWebhookSecret),
    githubWebhookConfigured: Boolean(resolved.githubWebhookSecret),
    sandboxProvider: resolved.sandboxProvider || 'auto',
  };
}

function getProviderStatus(preferred = {}) {
  const resolved = resolveProviderConfig(preferred);
  const localConfigured = Boolean(
    resolved.ollamaUrl ||
    resolved.ollamaModel ||
    resolved.ollamaEmbeddingModel ||
    process.env.OLLAMA_URL ||
    process.env.OLLAMA_MODEL ||
    process.env.OLLAMA_EMBED_MODEL
  );
  return {
    anthropicConfigured: Boolean(resolved.anthropic),
    openaiConfigured: Boolean(resolved.openai),
    githubConfigured: Boolean(resolved.githubToken),
    localConfigured,
    slackConfigured: Boolean(resolved.slackWebhookUrl),
    githubWebhookConfigured: Boolean(resolved.githubWebhookSecret),
    embeddingProvider: resolved.embeddingProvider || 'auto',
    sandboxProvider: resolved.sandboxProvider || 'auto',
    llmConfigured: Boolean(resolved.anthropic || resolved.openai || localConfigured),
  };
}

function resolveAnthropicKey(preferred = '') {
  return resolveProviderConfig(preferred).anthropic;
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  maskApiKey,
  resolveProviderConfig,
  getMaskedProviderConfig,
  getProviderStatus,
  resolveAnthropicKey,
};
