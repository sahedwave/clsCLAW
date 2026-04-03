'use strict';

const path = require('path');

const READ_ONLY_SHELL_PREFIXES = [
  'git status',
  'git diff --stat',
  'git log --oneline',
  'git branch --show-current',
  'ls',
  'find',
  'rg',
  'cat',
  'head',
  'tail',
  'wc',
];

class ToolRuntime {
  constructor({
    projectRootGetter,
    contextEngine,
    connectorManager,
    sandbox,
    webClient,
    visionAnalyzer,
  } = {}) {
    this._getProjectRoot = typeof projectRootGetter === 'function' ? projectRootGetter : () => process.cwd();
    this._contextEngine = contextEngine;
    this._connectorManager = connectorManager;
    this._sandbox = sandbox;
    this._webClient = webClient;
    this._visionAnalyzer = visionAnalyzer;
  }

  describe() {
    const connectors = this._connectorManager?.list?.() || [];
    return [
      {
        name: 'workspace_query_context',
        description: 'Search indexed workspace context for relevant files and code snippets.',
        args: { query: 'string', maxFiles: 'number (optional)' },
      },
      {
        name: 'workspace_list_files',
        description: 'List files or directories inside the current project root.',
        args: { dir: 'string (optional, relative path)' },
      },
      {
        name: 'workspace_read_file',
        description: 'Read a file from the current project root.',
        args: { path: 'string (relative path)' },
      },
      {
        name: 'connector_action',
        description: 'Run a typed connector action. Available connectors: ' + connectors.map((connector) =>
          `${connector.id}[${(connector.actions || []).map((action) => action.id).join(', ')}]`
        ).join(' ; '),
        args: { connectorId: 'string', actionId: 'string', args: 'object' },
      },
      {
        name: 'connector_list_resources',
        description: 'Discover structured connector resources, similar to an MCP resource catalog.',
        args: { connectorId: 'string', resourceId: 'string', args: 'object' },
      },
      {
        name: 'connector_read_resource',
        description: 'Read a structured connector resource by URI and return its content.',
        args: { connectorId: 'string', uri: 'string', args: 'object' },
      },
      {
        name: 'web_search',
        description: 'Search the web for current information. Use this before answering unstable factual questions.',
        args: { query: 'string', limit: 'number (optional)', domains: 'string[] (optional)' },
      },
      {
        name: 'web_open',
        description: 'Open a web page and extract readable text for evidence and citation.',
        args: { url: 'string' },
      },
      {
        name: 'docs_search',
        description: 'Search official documentation sites only.',
        args: { query: 'string', domains: 'string[]' },
      },
      {
        name: 'vision_inspect',
        description: 'Inspect attached images or screenshots and extract relevant visual evidence for the user request.',
        args: { prompt: 'string' },
      },
      {
        name: 'shell_inspect',
        description: 'Run a safe, read-only inspection command in the workspace. Allowed prefixes: ' + READ_ONLY_SHELL_PREFIXES.join(', '),
        args: { command: 'string' },
      },
    ];
  }

  async execute(toolName, args = {}, { timeoutMs = 15000, providers = null, messages = [], signal = null } = {}) {
    const projectRoot = this._getProjectRoot();
    switch (toolName) {
      case 'workspace_query_context':
        return this._queryContext(projectRoot, args);
      case 'workspace_list_files':
        return this._listFiles(projectRoot, args);
      case 'workspace_read_file':
        return this._readFile(projectRoot, args);
      case 'connector_action':
        return this._runConnector(projectRoot, args);
      case 'connector_list_resources':
        return this._listConnectorResources(args);
      case 'connector_read_resource':
        return this._readConnectorResource(args);
      case 'web_search':
        return this._webSearch(args, { timeoutMs });
      case 'web_open':
        return this._webOpen(args, { timeoutMs });
      case 'docs_search':
        return this._docsSearch(args, { timeoutMs });
      case 'vision_inspect':
        return this._visionInspect(args, { timeoutMs, providers, messages, signal });
      case 'shell_inspect':
        return this._shellInspect(projectRoot, args, { timeoutMs });
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async _queryContext(projectRoot, args) {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query is required');
    const result = await this._contextEngine.query(query, {
      maxFiles: clampInt(args.maxFiles, 1, 8, 4),
      maxTokens: 8000,
    });
    return {
      ok: true,
      tool: 'workspace_query_context',
      summary: result.files?.length
        ? `Found ${result.files.length} relevant file(s)`
        : (result.warning || 'No matching files found'),
      observation: {
        mode: result.mode || 'keyword',
        warning: result.warning || null,
        files: (result.files || []).map((file) => ({
          relativePath: file.relativePath,
          score: file.score,
          preview: String(file.content || '').slice(0, 2200),
        })),
      },
      evidence: (result.files || []).map((file) => ({
        type: 'workspace',
        source: file.relativePath,
        title: file.relativePath,
        snippet: String(file.content || '').slice(0, 800),
      })),
    };
  }

  async _listFiles(projectRoot, args) {
    const dir = resolveInsideProject(projectRoot, args.dir || '.');
    this._sandbox.assertPathSafe(dir, projectRoot);
    const entries = require('fs').readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !new Set(['node_modules', '.git', '.DS_Store', '.clsclaw-worktrees']).has(entry.name))
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        relativePath: path.relative(projectRoot, path.join(dir, entry.name)) || entry.name,
      }));
    return {
      ok: true,
      tool: 'workspace_list_files',
      summary: `Listed ${entries.length} workspace entr${entries.length === 1 ? 'y' : 'ies'}`,
      observation: {
        dir: path.relative(projectRoot, dir) || '.',
        entries,
      },
      evidence: [{
        type: 'workspace',
        source: path.relative(projectRoot, dir) || '.',
        title: `Directory listing: ${path.relative(projectRoot, dir) || '.'}`,
        snippet: entries.slice(0, 20).map((entry) => `${entry.type === 'dir' ? 'dir' : 'file'} ${entry.relativePath}`).join('\n'),
      }],
    };
  }

  async _readFile(projectRoot, args) {
    const filePath = resolveInsideProject(projectRoot, args.path);
    const content = this._sandbox.safeReadFile(filePath, projectRoot);
    const relativePath = path.relative(projectRoot, filePath);
    return {
      ok: true,
      tool: 'workspace_read_file',
      summary: `Read ${relativePath}`,
      observation: {
        path: relativePath,
        lines: content.split('\n').length,
        content: content.slice(0, 12000),
      },
      evidence: [{
        type: 'workspace',
        source: relativePath,
        title: relativePath,
        snippet: content.slice(0, 1200),
      }],
    };
  }

  async _runConnector(projectRoot, args) {
    if (!this._connectorManager) throw new Error('Connector manager unavailable');
    const connectorId = String(args.connectorId || '').trim();
    const actionId = String(args.actionId || '').trim();
    if (!connectorId || !actionId) throw new Error('connectorId and actionId are required');
    const result = await this._connectorManager.run(connectorId, actionId, args.args || {});
    return {
      ok: true,
      tool: 'connector_action',
      summary: `${connectorId}.${actionId} completed`,
      observation: {
        connectorId,
        actionId,
        result,
      },
      evidence: [{
        type: 'connector',
        source: `${connectorId}.${actionId}`,
        title: `${connectorId}.${actionId}`,
        snippet: JSON.stringify(result, null, 2).slice(0, 1200),
      }],
    };
  }

  async _listConnectorResources(args) {
    if (!this._connectorManager) throw new Error('Connector manager unavailable');
    const connectorId = String(args.connectorId || '').trim();
    const resourceId = String(args.resourceId || '').trim();
    if (!connectorId || !resourceId) throw new Error('connectorId and resourceId are required');
    const result = await this._connectorManager.listResources(connectorId, resourceId, args.args || {});
    return {
      ok: true,
      tool: 'connector_list_resources',
      summary: `${connectorId}.${resourceId} returned ${result.items.length} resource${result.items.length === 1 ? '' : 's'}`,
      observation: result,
      evidence: (result.items || []).slice(0, 8).map((item) => ({
        type: 'connector_resource_catalog',
        source: item.uri,
        title: item.title || item.uri,
        snippet: JSON.stringify(item.metadata || {}, null, 2).slice(0, 800),
      })),
    };
  }

  async _readConnectorResource(args) {
    if (!this._connectorManager) throw new Error('Connector manager unavailable');
    const connectorId = String(args.connectorId || '').trim();
    const uri = String(args.uri || '').trim();
    if (!connectorId || !uri) throw new Error('connectorId and uri are required');
    const resource = await this._connectorManager.readResource(connectorId, uri, args.args || {});
    return {
      ok: true,
      tool: 'connector_read_resource',
      summary: `Read resource ${uri}`,
      observation: {
        connectorId,
        uri,
        title: resource.title,
        mimeType: resource.mimeType,
        metadata: resource.metadata || null,
        content: String(resource.content || '').slice(0, 12000),
      },
      evidence: [{
        type: 'connector_resource',
        source: uri,
        title: resource.title || uri,
        snippet: String(resource.content || '').slice(0, 1200),
        metadata: resource.metadata || null,
      }],
    };
  }

  async _webSearch(args, { timeoutMs }) {
    if (!this._webClient) throw new Error('Web client unavailable');
    const result = await this._webClient.search(args.query, {
      limit: clampInt(args.limit, 1, 8, 5),
      domains: Array.isArray(args.domains) ? args.domains : [],
      timeoutMs,
    });
    return {
      ok: true,
      tool: 'web_search',
      summary: `Found ${result.results.length} web result${result.results.length === 1 ? '' : 's'} for "${result.query}"`,
      observation: {
        query: result.query,
        results: result.results,
      },
      evidence: result.results.map((entry) => ({
        type: 'web_search',
        source: entry.url,
        title: entry.title,
        url: entry.url,
        domain: entry.domain,
        snippet: entry.title,
      })),
    };
  }

  async _webOpen(args, { timeoutMs }) {
    if (!this._webClient) throw new Error('Web client unavailable');
    const result = await this._webClient.open(args.url, { timeoutMs });
    return {
      ok: true,
      tool: 'web_open',
      summary: `Opened ${result.finalUrl}`,
      observation: result,
      evidence: [{
        type: 'web',
        source: result.finalUrl,
        title: result.title,
        url: result.finalUrl,
        contentType: result.contentType,
        fetchedAt: result.fetchedAt,
        snippet: result.excerpt.slice(0, 1200),
      }],
    };
  }

  async _docsSearch(args, { timeoutMs }) {
    if (!this._webClient) throw new Error('Web client unavailable');
    const domains = Array.isArray(args.domains) ? args.domains : [];
    const result = await this._webClient.docs(args.query, {
      domains,
      limit: clampInt(args.limit, 1, 8, 5),
      timeoutMs,
    });
    return {
      ok: true,
      tool: 'docs_search',
      summary: `Found ${result.results.length} documentation result${result.results.length === 1 ? '' : 's'}`,
      observation: {
        query: result.query,
        domains,
        results: result.results,
      },
      evidence: result.results.map((entry) => ({
        type: 'docs_search',
        source: entry.url,
        title: entry.title,
        url: entry.url,
        domain: entry.domain,
        snippet: entry.title,
      })),
    };
  }

  async _visionInspect(args, { timeoutMs, providers, messages, signal }) {
    if (!this._visionAnalyzer) throw new Error('Vision analyzer unavailable');
    const imageParts = collectImageParts(messages);
    if (!imageParts.length) throw new Error('No image attachments available for inspection');
    const prompt = String(args.prompt || args.query || '').trim() || 'Describe the attached image and extract details relevant to the user request.';
    const result = await this._visionAnalyzer({
      prompt,
      providers,
      messages,
      timeoutMs,
      signal,
    });
    return {
      ok: true,
      tool: 'vision_inspect',
      summary: `Analyzed ${imageParts.length} image attachment${imageParts.length === 1 ? '' : 's'}`,
      observation: {
        prompt,
        provider: result.provider,
        model: result.model,
        imageCount: imageParts.length,
        text: result.text,
      },
      evidence: [{
        type: 'image_analysis',
        source: imageParts.map((part) => part.name || part.uploadId || 'attachment').join(', '),
        title: imageParts.length === 1
          ? `Image analysis: ${imageParts[0].name || 'attachment'}`
          : `Image analysis: ${imageParts.length} attachments`,
        snippet: String(result.text || '').slice(0, 1200),
        meta: {
          prompt,
          provider: result.provider || null,
          model: result.model || null,
          imageCount: imageParts.length,
          attachments: imageParts.map((part) => part.name || part.uploadId || 'attachment').slice(0, 4),
        },
      }],
    };
  }

  async _shellInspect(projectRoot, args, { timeoutMs }) {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('command is required');
    if (!READ_ONLY_SHELL_PREFIXES.some((prefix) => command.startsWith(prefix))) {
      throw new Error('shell_inspect only allows safe read-only inspection commands');
    }
    const result = await this._sandbox.runCommand(command, projectRoot, { timeout: timeoutMs });
    if (result.isInstall) {
      throw new Error('shell_inspect does not allow package installs');
    }
    return {
      ok: result.exitCode === 0,
      tool: 'shell_inspect',
      summary: result.exitCode === 0 ? `Shell inspect succeeded: ${command}` : `Shell inspect failed: ${command}`,
      observation: {
        command,
        exitCode: result.exitCode,
        stdout: String(result.stdout || '').slice(0, 8000),
        stderr: String(result.stderr || '').slice(0, 4000),
        mode: result.mode,
        timedOut: Boolean(result.timedOut),
      },
      evidence: [{
        type: 'shell',
        source: command,
        title: command,
        snippet: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 1200),
      }],
    };
  }
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function resolveInsideProject(projectRoot, target) {
  const root = path.resolve(projectRoot);
  const resolved = path.isAbsolute(String(target || ''))
    ? path.resolve(String(target))
    : path.resolve(root, String(target || '.'));
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error('Path must stay inside the current project root');
  }
  return resolved;
}

function collectImageParts(messages = []) {
  const items = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image') items.push(part);
    }
  }
  return items;
}

module.exports = {
  ToolRuntime,
  READ_ONLY_SHELL_PREFIXES,
};
