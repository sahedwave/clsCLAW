'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SkillRegistry = require('../src/skills/skills');
const { ExtensionManager } = require('../src/extensions/extensionManager');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-ext-'));
}

function cleanup(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

test('bundled plugin install exposes plugin-backed skills through the registry', async () => {
  const workspace = makeWorkspace();

  try {
    const extensionsDir = path.join(workspace, 'data', 'extensions');
    const registry = new SkillRegistry();
    const manager = new ExtensionManager(extensionsDir);
    registry.setExtensionManager(manager);
    manager.setSkillRegistry(registry);

    manager.installBundled('quality-lab');
    const listed = registry.list();

    const pluginSkill = listed.find((skill) => skill.id === 'quality-sweep');
    assert.ok(pluginSkill);
    assert.equal(pluginSkill.pluginId, 'quality-lab');
  } finally {
    cleanup(workspace);
  }
});

test('local plugin manifest can be installed from inside the project root', () => {
  const workspace = makeWorkspace();

  try {
    const manifestPath = path.join(workspace, 'local-plugin.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      id: 'local-helper',
      name: 'Local Helper',
      description: 'A local plugin',
      skills: [
        {
          id: 'local-helper-run',
          name: 'Local helper run',
          category: 'custom',
          description: 'Run a local helper command',
          command: 'npm test',
        },
      ],
    }, null, 2), 'utf-8');

    const manager = new ExtensionManager(path.join(workspace, 'data', 'extensions'));
    const result = manager.installLocalManifest('local-plugin.json', workspace);
    const installed = manager.listInstalledPlugins();

    assert.equal(result.ok, true);
    assert.ok(installed.find((plugin) => plugin.id === 'local-helper'));
    assert.ok(manager.getSkill('local-helper-run'));
  } finally {
    cleanup(workspace);
  }
});

test('uninstall removes local plugin skills from the installed set', () => {
  const workspace = makeWorkspace();

  try {
    const manifestPath = path.join(workspace, 'local-plugin.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      id: 'local-helper',
      name: 'Local Helper',
      skills: [
        {
          id: 'local-helper-run',
          name: 'Local helper run',
          command: 'npm test',
        },
      ],
    }, null, 2), 'utf-8');

    const manager = new ExtensionManager(path.join(workspace, 'data', 'extensions'));
    manager.installLocalManifest('local-plugin.json', workspace);
    manager.uninstall('local-helper');

    assert.equal(manager.getSkill('local-helper-run'), null);
  } finally {
    cleanup(workspace);
  }
});
