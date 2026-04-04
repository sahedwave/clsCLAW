'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class McpRegistry {
  constructor({
    dataFile,
    connectorManager,
    extensionManager = null,
    githubTokenGetter = () => '',
  } = {}) {
    this._dataFile = dataFile;
    this._connectorManager = connectorManager;
    this._extensionManager = extensionManager;
    this._githubTokenGetter = githubTokenGetter;
    this._entries = this._loadEntries();
  }

  list() {
    return [
      ...this._builtInConnectorEntries(),
      ...this._pluginEntries(),
      ...this._customEntries(),
    ];
  }

  create(entry = {}) {
    const normalized = normalizeCustomEntry(entry);
    this._entries.set(normalized.id, normalized);
    this._saveEntries();
    return normalized;
  }

  update(id, patch = {}) {
    const current = this._entries.get(String(id || ''));
    if (!current) return null;
    const next = normalizeCustomEntry({
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
    });
    this._entries.set(current.id, next);
    this._saveEntries();
    return next;
  }

  remove(id) {
    const key = String(id || '');
    const current = this._entries.get(key);
    if (!current) return { ok: false, error: 'Registry entry not found' };
    this._entries.delete(key);
    this._saveEntries();
    return { ok: true, id: key };
  }

  _builtInConnectorEntries() {
    const connectors = Array.isArray(this._connectorManager?.list?.()) ? this._connectorManager.list() : [];
    return connectors.map((connector) => {
      const needsAuth = Boolean(connector?.trust?.requiresAuth);
      const githubReady = connector.id !== 'github' || Boolean(this._githubTokenGetter());
      return {
        id: `connector:${connector.id}`,
        source: 'builtin',
        kind: 'connector',
        name: connector.name,
        description: connector.description,
        icon: connector.icon || '🔌',
        capabilities: [
          ...(connector.actions || []).map((item) => `action:${item.id}`),
          ...(connector.resources || []).map((item) => `resource:${item.id}`),
        ],
        status: needsAuth ? (githubReady ? 'ready' : 'needs_auth') : 'ready',
        trust: {
          level: connector?.trust?.level || 'local',
          verified: connector?.trust?.verified !== false,
          requiresNetwork: Boolean(connector?.trust?.requiresNetwork),
          requiresAuth: needsAuth,
        },
        auth: needsAuth ? { type: connector.auth?.type || 'token', configured: githubReady } : null,
        health: {
          status: needsAuth ? (githubReady ? 'configured' : 'missing_auth') : 'available',
          detail: needsAuth
            ? (githubReady ? 'Authentication is configured for this connector.' : 'Authentication is required before use.')
            : 'Built-in connector is available locally.',
        },
        recommended: connector.id === 'workspace' || connector.id === 'docs' || connector.id === 'github',
        metadata: {
          connectorId: connector.id,
          category: connector.category || 'connector',
        },
      };
    });
  }

  _pluginEntries() {
    const catalog = Array.isArray(this._extensionManager?.listCatalog?.()) ? this._extensionManager.listCatalog() : [];
    return catalog.map((plugin) => ({
      id: `plugin:${plugin.id}`,
      source: 'builtin',
      kind: 'plugin',
      name: plugin.name || plugin.id,
      description: plugin.description || '',
      icon: plugin.icon || '🧩',
      capabilities: Array.isArray(plugin.skills) ? plugin.skills.map((skill) => `skill:${skill.id}`) : [],
      status: plugin.installed ? 'installed' : 'available',
      trust: {
        level: plugin.source === 'local' ? 'project_local' : 'bundled',
        verified: plugin.source !== 'local',
        requiresNetwork: false,
        requiresAuth: false,
      },
      auth: null,
      health: {
        status: plugin.installed ? 'installed' : 'available',
        detail: plugin.installed ? 'Plugin is installed and ready.' : 'Plugin is available to install.',
      },
      recommended: Boolean(plugin.installed),
      metadata: {
        pluginId: plugin.id,
        source: plugin.source || 'bundled',
      },
    }));
  }

  _customEntries() {
    return [...this._entries.values()].map((entry) => ({
      ...entry,
      health: deriveCustomHealth(entry),
    }));
  }

  _loadEntries() {
    const out = new Map();
    try {
      const dir = path.dirname(this._dataFile);
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this._dataFile)) return out;
      const parsed = JSON.parse(fs.readFileSync(this._dataFile, 'utf-8'));
      for (const item of Array.isArray(parsed) ? parsed : []) {
        const normalized = normalizeCustomEntry(item);
        out.set(normalized.id, normalized);
      }
    } catch {}
    return out;
  }

  _saveEntries() {
    try {
      fs.mkdirSync(path.dirname(this._dataFile), { recursive: true });
      fs.writeFileSync(this._dataFile, JSON.stringify([...this._entries.values()], null, 2), 'utf-8');
    } catch {}
  }
}

function normalizeCustomEntry(entry = {}) {
  const transport = ['stdio', 'http'].includes(String(entry.transport || '').trim()) ? String(entry.transport).trim() : 'stdio';
  const id = String(entry.id || `custom-${randomUUID()}`).trim();
  return {
    id,
    source: 'custom',
    kind: 'mcp_server',
    name: String(entry.name || 'Custom MCP').trim() || 'Custom MCP',
    description: String(entry.description || '').trim(),
    icon: String(entry.icon || '🛰️').trim() || '🛰️',
    transport,
    command: transport === 'stdio' ? String(entry.command || '').trim() : '',
    url: transport === 'http' ? String(entry.url || '').trim() : '',
    args: Array.isArray(entry.args) ? entry.args.map((arg) => String(arg)) : [],
    capabilities: Array.isArray(entry.capabilities) ? entry.capabilities.map((cap) => String(cap).trim()).filter(Boolean) : [],
    status: Boolean(entry.enabled !== false) ? 'configured' : 'disabled',
    trust: {
      level: String(entry.trust?.level || 'custom').trim() || 'custom',
      verified: Boolean(entry.trust?.verified),
      requiresNetwork: Boolean(entry.trust?.requiresNetwork || transport === 'http'),
      requiresAuth: Boolean(entry.trust?.requiresAuth),
    },
    auth: entry.auth ? {
      type: String(entry.auth.type || 'token'),
      configured: Boolean(entry.auth.configured),
      description: entry.auth.description ? String(entry.auth.description) : '',
    } : null,
    recommended: Boolean(entry.recommended),
    enabled: entry.enabled !== false,
    metadata: entry.metadata && typeof entry.metadata === 'object' ? { ...entry.metadata } : {},
    createdAt: Number(entry.createdAt || Date.now()),
  };
}

function deriveCustomHealth(entry) {
  if (!entry.enabled) {
    return { status: 'disabled', detail: 'Registry entry is saved but disabled.' };
  }
  if (entry.transport === 'http') {
    return entry.url
      ? { status: 'configured', detail: 'HTTP MCP endpoint is configured.' }
      : { status: 'incomplete', detail: 'HTTP transport requires a URL.' };
  }
  return entry.command
    ? { status: 'configured', detail: 'stdio MCP server command is configured.' }
    : { status: 'incomplete', detail: 'stdio transport requires a launch command.' };
}

module.exports = {
  McpRegistry,
};
