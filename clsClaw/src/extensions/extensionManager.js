'use strict';

const fs = require('fs');
const path = require('path');
const { runCommand } = require('../sandbox/sandbox');

const BUNDLED_PLUGINS = [
  {
    id: 'workspace-guardian',
    name: 'Workspace Guardian',
    icon: '🛡️',
    description: 'Security and hygiene sweeps for the current workspace.',
    source: 'bundled',
    type: 'plugin',
    skills: [
      {
        id: 'guardian-sweep',
        name: 'Guardian sweep',
        icon: '🛡️',
        category: 'inspect',
        description: 'Run security, dependency, and heartbeat checks together.',
        pipeline: ['security-audit', 'dependency-check', 'heartbeat-review'],
      },
    ],
  },
  {
    id: 'quality-lab',
    name: 'Quality Lab',
    icon: '🧪',
    description: 'Code quality and regression-oriented checks.',
    source: 'bundled',
    type: 'plugin',
    skills: [
      {
        id: 'quality-sweep',
        name: 'Quality sweep',
        icon: '🧪',
        category: 'inspect',
        description: 'Run lint, tests, and test-writing support as one package.',
        pipeline: ['lint', 'run-tests', 'write-tests'],
      },
    ],
  },
  {
    id: 'release-pilot',
    name: 'Release Pilot',
    icon: '🚀',
    description: 'Release readiness helpers and repo maintenance tools.',
    source: 'bundled',
    type: 'plugin',
    skills: [
      {
        id: 'release-readiness',
        name: 'Release readiness',
        icon: '🚀',
        category: 'inspect',
        description: 'Review git history, dependencies, and docs readiness together.',
        pipeline: ['git-log', 'dependency-check', 'generate-docs'],
      },
    ],
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizePluginId(value) {
  return String(value || '').trim().toLowerCase();
}

function validatePluginManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Plugin manifest must be an object');
  }
  const id = normalizePluginId(manifest.id);
  if (!id) throw new Error('Plugin manifest id is required');
  if (!manifest.name) throw new Error('Plugin manifest name is required');
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    throw new Error('Plugin manifest must include at least one skill');
  }

  const skills = manifest.skills.map((skill, index) => {
    if (!skill?.id) throw new Error(`Skill ${index + 1} is missing id`);
    if (!skill?.name) throw new Error(`Skill ${index + 1} is missing name`);
    const mode = skill.command ? 'command' : Array.isArray(skill.pipeline) ? 'pipeline' : null;
    if (!mode) {
      throw new Error(`Skill "${skill.id}" must define either command or pipeline`);
    }
    return {
      id: String(skill.id),
      name: String(skill.name),
      icon: String(skill.icon || '🧩'),
      category: String(skill.category || 'custom'),
      description: String(skill.description || ''),
      command: mode === 'command' ? String(skill.command) : null,
      pipeline: mode === 'pipeline' ? skill.pipeline.map((step) => String(step)) : null,
    };
  });

  return {
    id,
    name: String(manifest.name),
    icon: String(manifest.icon || '🧩'),
    description: String(manifest.description || ''),
    source: manifest.source || 'local',
    type: 'plugin',
    manifestPath: manifest.manifestPath || null,
    skills,
  };
}

class ExtensionManager {
  constructor(dataDir) {
    this._dataDir = dataDir;
    this._stateFile = path.join(dataDir, 'extensions.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this._skillRegistry = null;
    this._state = this._loadState();
  }

  setSkillRegistry(skillRegistry) {
    this._skillRegistry = skillRegistry;
  }

  listCatalog() {
    const installed = new Set(this._state.installedBundled || []);
    const localIds = new Set((this._state.localPlugins || []).map((plugin) => plugin.id));
    const bundled = BUNDLED_PLUGINS.map((plugin) => ({
      ...clone(plugin),
      installed: installed.has(plugin.id),
    }));
    const local = (this._state.localPlugins || []).map((plugin) => ({
      ...clone(plugin),
      installed: localIds.has(plugin.id),
      source: plugin.source || 'local',
    }));
    return [...bundled, ...local];
  }

  listInstalledPlugins() {
    return this.listCatalog().filter((plugin) => plugin.installed);
  }

  listInstalledSkills() {
    return this.listInstalledPlugins().flatMap((plugin) =>
      plugin.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        icon: skill.icon || plugin.icon || '🧩',
        category: skill.category || 'plugin',
        description: skill.description || plugin.description,
        pluginId: plugin.id,
        pluginName: plugin.name,
        source: plugin.source,
        installSource: plugin.source,
      }))
    );
  }

  getSkill(skillId) {
    return this.listInstalledPlugins()
      .flatMap((plugin) => plugin.skills.map((skill) => ({ ...skill, pluginId: plugin.id, pluginName: plugin.name })))
      .find((skill) => skill.id === skillId) || null;
  }

  installBundled(pluginId) {
    const id = normalizePluginId(pluginId);
    const plugin = BUNDLED_PLUGINS.find((entry) => entry.id === id);
    if (!plugin) throw new Error(`Unknown plugin: ${pluginId}`);
    const installed = new Set(this._state.installedBundled || []);
    installed.add(id);
    this._state.installedBundled = [...installed];
    this._saveState();
    return { ok: true, plugin: this.listCatalog().find((entry) => entry.id === id) };
  }

  installLocalManifest(manifestPath, projectRoot) {
    if (!manifestPath) throw new Error('manifestPath required');
    const resolved = path.resolve(projectRoot, manifestPath);
    const root = path.resolve(projectRoot);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error('Plugin manifest must be inside the current project root');
    }
    const manifest = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    const normalized = validatePluginManifest({ ...manifest, manifestPath: resolved, source: 'local' });
    this._state.localPlugins = [
      ...(this._state.localPlugins || []).filter((plugin) => plugin.id !== normalized.id),
      normalized,
    ];
    this._saveState();
    return { ok: true, plugin: this.listCatalog().find((entry) => entry.id === normalized.id) };
  }

  uninstall(pluginId) {
    const id = normalizePluginId(pluginId);
    const bundled = new Set(this._state.installedBundled || []);
    const localPlugins = this._state.localPlugins || [];
    const hadBundled = bundled.delete(id);
    const nextLocal = localPlugins.filter((plugin) => plugin.id !== id);
    const hadLocal = nextLocal.length !== localPlugins.length;
    this._state.installedBundled = [...bundled];
    this._state.localPlugins = nextLocal;
    this._saveState();
    if (!hadBundled && !hadLocal) throw new Error(`Plugin not installed: ${pluginId}`);
    return { ok: true };
  }

  async runSkill(skillId, projectRoot) {
    const skill = this.getSkill(skillId);
    if (!skill) throw new Error(`Unknown installed plugin skill: ${skillId}`);
    const startedAt = Date.now();

    if (skill.command) {
      const result = await runCommand(skill.command, projectRoot, { timeout: 60000 });
      return {
        ok: true,
        skill: skill.id,
        pluginId: skill.pluginId,
        command: skill.command,
        ...result,
        durationMs: Date.now() - startedAt,
      };
    }

    const steps = [];
    const findings = [];
    const fileProposals = [];
    for (const stepId of skill.pipeline || []) {
      const stepResult = await this._skillRegistry.runCore(stepId, projectRoot);
      steps.push({ skillId: stepId, ok: stepResult.ok !== false, summary: stepResult.summary || stepResult.error || '' });
      if (Array.isArray(stepResult.findings)) findings.push(...stepResult.findings);
      if (Array.isArray(stepResult.fileProposals)) fileProposals.push(...stepResult.fileProposals);
    }

    return {
      ok: true,
      skill: skill.id,
      pluginId: skill.pluginId,
      steps,
      findings,
      fileProposals,
      summary: `${skill.name} ran ${steps.length} bundled step${steps.length === 1 ? '' : 's'}`,
      durationMs: Date.now() - startedAt,
    };
  }

  _loadState() {
    try {
      if (fs.existsSync(this._stateFile)) {
        return JSON.parse(fs.readFileSync(this._stateFile, 'utf-8'));
      }
    } catch {}
    return {
      installedBundled: ['workspace-guardian'],
      localPlugins: [],
    };
  }

  _saveState() {
    fs.writeFileSync(this._stateFile, JSON.stringify(this._state, null, 2), 'utf-8');
  }
}

module.exports = {
  ExtensionManager,
  BUNDLED_PLUGINS,
  validatePluginManifest,
};
