'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { McpRegistry } = require('../src/connectors/mcpRegistry');

test('mcp registry combines built-in connectors, plugins, and custom entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-mcp-registry-'));
  try {
    const registry = new McpRegistry({
      dataFile: path.join(root, 'registry.json'),
      connectorManager: {
        list() {
          return [
            {
              id: 'workspace',
              name: 'Workspace',
              description: 'Local files',
              icon: '📁',
              trust: { level: 'local', verified: true, requiresNetwork: false, requiresAuth: false },
              actions: [{ id: 'read-file' }],
              resources: [{ id: 'files' }],
            },
            {
              id: 'github',
              name: 'GitHub',
              description: 'Remote repo access',
              icon: '🐙',
              auth: { type: 'token' },
              trust: { level: 'networked', verified: true, requiresNetwork: true, requiresAuth: true },
              actions: [{ id: 'list-prs' }],
              resources: [],
            },
          ];
        },
      },
      extensionManager: {
        listCatalog() {
          return [{ id: 'plugin-a', name: 'Plugin A', installed: true, skills: [{ id: 'skill-a' }] }];
        },
      },
      githubTokenGetter: () => '',
    });

    registry.create({
      name: 'Filesystem MCP',
      transport: 'stdio',
      command: 'npx @modelcontextprotocol/server-filesystem',
      capabilities: ['resources', 'tools'],
    });

    const entries = registry.list();
    assert.ok(entries.some((entry) => entry.id === 'connector:workspace'));
    assert.ok(entries.some((entry) => entry.id === 'plugin:plugin-a'));
    const custom = entries.find((entry) => entry.source === 'custom');
    assert.equal(custom.health.status, 'configured');
    const github = entries.find((entry) => entry.id === 'connector:github');
    assert.equal(github.status, 'needs_auth');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
