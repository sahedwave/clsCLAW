'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

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

function resolveAnthropicKey(preferred = '') {
  if (preferred) return preferred;
  const config = loadConfig();
  return config.anthropicKey || process.env.ANTHROPIC_API_KEY || '';
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  maskApiKey,
  resolveAnthropicKey,
};
