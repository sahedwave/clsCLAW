'use strict';

const path = require('path');

class ConnectorManager {
  constructor({
    getProjectRoot,
    skillRegistry,
    automations,
    contextEngine,
    githubClientFactory,
    sandbox,
    webClient,
    githubTokenGetter = () => '',
    settingsGetter = () => ({}),
  } = {}) {
    this._getProjectRoot = typeof getProjectRoot === 'function' ? getProjectRoot : () => process.cwd();
    this._skillRegistry = skillRegistry;
    this._automations = automations;
    this._contextEngine = contextEngine;
    this._githubClientFactory = githubClientFactory;
    this._sandbox = sandbox;
    this._webClient = webClient;
    this._githubTokenGetter = githubTokenGetter;
    this._settingsGetter = typeof settingsGetter === 'function' ? settingsGetter : () => ({});
    this._connectors = new Map();
    this._registerBuiltIns();
  }

  register(definition) {
    if (!definition?.id) throw new Error('Connector id is required');
    if (typeof definition.run !== 'function') throw new Error(`Connector "${definition.id}" must define run()`);
    const normalized = {
      id: String(definition.id),
      name: String(definition.name || definition.id),
      icon: String(definition.icon || '🔌'),
      description: String(definition.description || ''),
      category: String(definition.category || 'workspace'),
      auth: definition.auth || null,
      trust: {
        level: String(definition.trust?.level || 'local'),
        verified: definition.trust?.verified !== false,
        requiresNetwork: Boolean(definition.trust?.requiresNetwork),
        requiresAuth: Boolean(definition.trust?.requiresAuth || definition.auth),
      },
      resources: Array.isArray(definition.resources) ? definition.resources.map((resource) => ({
        id: String(resource.id),
        name: String(resource.name || resource.id),
        description: String(resource.description || ''),
        inputs: Array.isArray(resource.inputs) ? resource.inputs.map((input) => ({
          id: String(input.id),
          label: String(input.label || input.id),
          type: String(input.type || 'text'),
          optional: Boolean(input.optional),
          placeholder: input.placeholder ? String(input.placeholder) : '',
          default: input.default,
          defaultFrom: input.defaultFrom || null,
        })) : [],
      })) : [],
      actions: Array.isArray(definition.actions) ? definition.actions.map((action) => ({
        id: String(action.id),
        name: String(action.name || action.id),
        description: String(action.description || ''),
        inputs: Array.isArray(action.inputs) ? action.inputs.map((input) => ({
          id: String(input.id),
          label: String(input.label || input.id),
          type: String(input.type || 'text'),
          optional: Boolean(input.optional),
          placeholder: input.placeholder ? String(input.placeholder) : '',
          default: input.default,
          defaultFrom: input.defaultFrom || null,
        })) : [],
      })) : [],
      listResources: typeof definition.listResources === 'function' ? definition.listResources : null,
      readResource: typeof definition.readResource === 'function' ? definition.readResource : null,
      run: definition.run,
    };
    this._connectors.set(normalized.id, normalized);
    return normalized;
  }

  list() {
    return [...this._connectors.values()].map((connector) => ({
      id: connector.id,
      name: connector.name,
      icon: connector.icon,
      description: connector.description,
      category: connector.category,
      auth: connector.auth,
      trust: connector.trust,
      resources: connector.resources.map((resource) => ({
        id: resource.id,
        name: resource.name,
        description: resource.description,
        inputs: resource.inputs,
      })),
      actions: connector.actions.map((action) => ({
        id: action.id,
        name: action.name,
        description: action.description,
        inputs: action.inputs,
      })),
    }));
  }

  async run(connectorId, actionId, args = {}) {
    const connector = this._connectors.get(String(connectorId || ''));
    if (!connector) throw new Error(`Unknown connector: ${connectorId}`);
    const action = connector.actions.find((entry) => entry.id === actionId);
    if (!action) throw new Error(`Unknown action "${actionId}" for connector "${connectorId}"`);
    return connector.run(actionId, args, this._context());
  }

  async listResources(connectorId, resourceId, args = {}) {
    const connector = this._connectors.get(String(connectorId || ''));
    if (!connector) throw new Error(`Unknown connector: ${connectorId}`);
    const resource = connector.resources.find((entry) => entry.id === resourceId);
    if (!resource) throw new Error(`Unknown resource "${resourceId}" for connector "${connectorId}"`);
    if (!connector.listResources) throw new Error(`Connector "${connectorId}" does not support resources`);
    const listed = await connector.listResources(resourceId, args, this._context());
    return {
      ok: true,
      connector: connectorId,
      resourceId,
      items: Array.isArray(listed) ? listed : [],
    };
  }

  async readResource(connectorId, uri, args = {}) {
    const connector = this._connectors.get(String(connectorId || ''));
    if (!connector) throw new Error(`Unknown connector: ${connectorId}`);
    if (!connector.readResource) throw new Error(`Connector "${connectorId}" does not support resource reads`);
    return connector.readResource(String(uri || ''), args, this._context());
  }

  _context() {
    return {
      projectRoot: this._getProjectRoot(),
      skillRegistry: this._skillRegistry,
      automations: this._automations,
      contextEngine: this._contextEngine,
      sandbox: this._sandbox,
      webClient: this._webClient,
      githubClientFactory: this._githubClientFactory,
      githubToken: this._githubTokenGetter(),
      settings: this._settingsGetter(),
    };
  }

  _registerBuiltIns() {
    this.register({
      id: 'workspace',
      name: 'Workspace',
      icon: '📁',
      category: 'local',
      description: 'Inspect the current project tree, read files, and query indexed context.',
      trust: { level: 'local', verified: true, requiresNetwork: false, requiresAuth: false },
      actions: [
        {
          id: 'list-files',
          name: 'List files',
          description: 'List files in the current project or a subdirectory.',
          inputs: [
            { id: 'dir', label: 'Directory', optional: true, defaultFrom: 'projectRoot', placeholder: 'Leave blank for project root' },
          ],
        },
        {
          id: 'read-file',
          name: 'Read file',
          description: 'Read a file inside the current project root.',
          inputs: [
            { id: 'path', label: 'File path', placeholder: 'src/server.js' },
          ],
        },
        {
          id: 'query-context',
          name: 'Query context',
          description: 'Run semantic or keyword retrieval on the indexed workspace.',
          inputs: [
            { id: 'query', label: 'Query', placeholder: 'authentication middleware' },
            { id: 'maxFiles', label: 'Max files', type: 'number', optional: true, default: 5 },
          ],
        },
      ],
      run: async (actionId, args, ctx) => {
        if (actionId === 'list-files') {
          const targetDir = resolvePathInsideRoot(args.dir || ctx.projectRoot, ctx.projectRoot);
          ctx.sandbox.assertPathSafe(targetDir, ctx.projectRoot);
          const entries = require('fs').readdirSync(targetDir, { withFileTypes: true })
            .filter((entry) => !new Set(['node_modules', '.git', '.DS_Store', '.clsclaw-worktrees']).has(entry.name))
            .map((entry) => ({
              name: entry.name,
              type: entry.isDirectory() ? 'dir' : 'file',
              path: path.relative(ctx.projectRoot, path.join(targetDir, entry.name)) || entry.name,
            }));
          return {
            ok: true,
            connector: 'workspace',
            action: actionId,
            cwd: path.relative(ctx.projectRoot, targetDir) || '.',
            entries,
          };
        }

        if (actionId === 'read-file') {
          if (!args.path) throw new Error('path is required');
          const filePath = resolvePathInsideRoot(args.path, ctx.projectRoot);
          const content = ctx.sandbox.safeReadFile(filePath, ctx.projectRoot);
          return {
            ok: true,
            connector: 'workspace',
            action: actionId,
            path: path.relative(ctx.projectRoot, filePath),
            lines: content.split('\n').length,
            content,
          };
        }

        if (actionId === 'query-context') {
          if (!args.query) throw new Error('query is required');
          const result = await ctx.contextEngine.query(String(args.query), {
            maxFiles: Number(args.maxFiles) > 0 ? Number(args.maxFiles) : 5,
            maxTokens: 8000,
          });
          return {
            ok: true,
            connector: 'workspace',
            action: actionId,
            mode: result.mode || (result.warning ? 'none' : 'keyword'),
            files: (result.files || []).map((file) => ({
              relativePath: file.relativePath,
              score: file.score,
              preview: String(file.content || '').slice(0, 1200),
            })),
            warning: result.warning || null,
          };
        }

        throw new Error(`Unsupported workspace action: ${actionId}`);
      },
      resources: [
        {
          id: 'files',
          name: 'Files',
          description: 'Browse files inside the current project root and read them as workspace resources.',
          inputs: [
            { id: 'dir', label: 'Directory', optional: true, defaultFrom: 'projectRoot', placeholder: 'src' },
          ],
        },
      ],
      listResources: async (resourceId, args, ctx) => {
        if (resourceId !== 'files') throw new Error(`Unsupported workspace resource: ${resourceId}`);
        const targetDir = resolvePathInsideRoot(args.dir || ctx.projectRoot, ctx.projectRoot);
        ctx.sandbox.assertPathSafe(targetDir, ctx.projectRoot);
        return require('fs').readdirSync(targetDir, { withFileTypes: true })
          .filter((entry) => !new Set(['node_modules', '.git', '.DS_Store', '.clsclaw-worktrees']).has(entry.name))
          .map((entry) => {
            const relativePath = path.relative(ctx.projectRoot, path.join(targetDir, entry.name)) || entry.name;
            return {
              uri: `workspace://${relativePath}`,
              title: relativePath,
              description: entry.isDirectory() ? 'directory' : 'file',
              mimeType: entry.isDirectory() ? 'inode/directory' : guessMimeType(relativePath),
              metadata: {
                kind: entry.isDirectory() ? 'dir' : 'file',
                relativePath,
              },
            };
          });
      },
      readResource: async (uri, _args, ctx) => {
        const relativePath = uri.replace(/^workspace:\/\//, '');
        const filePath = resolvePathInsideRoot(relativePath, ctx.projectRoot);
        const stat = require('fs').statSync(filePath);
        if (stat.isDirectory()) {
          return {
            ok: true,
            connector: 'workspace',
            uri,
            title: relativePath,
            mimeType: 'inode/directory',
            content: require('fs').readdirSync(filePath).join('\n'),
            metadata: { relativePath, kind: 'dir' },
          };
        }
        const content = ctx.sandbox.safeReadFile(filePath, ctx.projectRoot);
        return {
          ok: true,
          connector: 'workspace',
          uri,
          title: relativePath,
          mimeType: guessMimeType(relativePath),
          content,
          metadata: { relativePath, kind: 'file', lines: content.split('\n').length },
        };
      },
    });

    this.register({
      id: 'skills',
      name: 'Skills',
      icon: '🎯',
      category: 'tooling',
      description: 'Discover installed skills and run them through one typed connector.',
      trust: { level: 'local', verified: true, requiresNetwork: false, requiresAuth: false },
      actions: [
        {
          id: 'list-skills',
          name: 'List skills',
          description: 'List core and plugin-backed skills available in this workspace.',
        },
        {
          id: 'run-skill',
          name: 'Run skill',
          description: 'Execute a single skill by id.',
          inputs: [
            { id: 'skillId', label: 'Skill id', placeholder: 'security-audit' },
          ],
        },
      ],
      run: async (actionId, args, ctx) => {
        if (actionId === 'list-skills') {
          return {
            ok: true,
            connector: 'skills',
            action: actionId,
            skills: ctx.skillRegistry.list(),
          };
        }
        if (actionId === 'run-skill') {
          if (!args.skillId) throw new Error('skillId is required');
          const result = await ctx.skillRegistry.run(String(args.skillId), ctx.projectRoot);
          return {
            ok: true,
            connector: 'skills',
            action: actionId,
            skillId: String(args.skillId),
            result,
          };
        }
        throw new Error(`Unsupported skills action: ${actionId}`);
      },
      resources: [
        {
          id: 'catalog',
          name: 'Skill catalog',
          description: 'Browse installed skills as structured resources.',
        },
      ],
      listResources: async (resourceId, _args, ctx) => {
        if (resourceId !== 'catalog') throw new Error(`Unsupported skills resource: ${resourceId}`);
        return ctx.skillRegistry.list().map((skill) => ({
          uri: `skill://${skill.id}`,
          title: skill.name,
          description: skill.description || skill.category || 'skill',
          mimeType: 'application/json',
          metadata: { skillId: skill.id, category: skill.category || null },
        }));
      },
      readResource: async (uri, _args, ctx) => {
        const skillId = uri.replace(/^skill:\/\//, '');
        const skill = ctx.skillRegistry.list().find((entry) => entry.id === skillId);
        if (!skill) throw new Error(`Unknown skill resource: ${uri}`);
        return {
          ok: true,
          connector: 'skills',
          uri,
          title: skill.name,
          mimeType: 'application/json',
          content: JSON.stringify(skill, null, 2),
          metadata: { skillId: skill.id },
        };
      },
    });

    this.register({
      id: 'automations',
      name: 'Automations',
      icon: '⏱',
      category: 'workflow',
      description: 'Inspect scheduled jobs, recent runs, and trigger approved recurring workflows.',
      trust: { level: 'local', verified: true, requiresNetwork: false, requiresAuth: false },
      actions: [
        {
          id: 'list-jobs',
          name: 'List jobs',
          description: 'Show currently configured automation jobs.',
        },
        {
          id: 'recent-results',
          name: 'Recent results',
          description: 'Show recent automation outputs.',
          inputs: [
            { id: 'limit', label: 'Limit', type: 'number', optional: true, default: 10 },
          ],
        },
        {
          id: 'trigger-job',
          name: 'Trigger job',
          description: 'Run one automation immediately.',
          inputs: [
            { id: 'jobId', label: 'Job id', placeholder: 'automation job id' },
          ],
        },
      ],
      run: async (actionId, args, ctx) => {
        if (actionId === 'list-jobs') {
          return {
            ok: true,
            connector: 'automations',
            action: actionId,
            jobs: ctx.automations.listJobs(),
          };
        }
        if (actionId === 'recent-results') {
          return {
            ok: true,
            connector: 'automations',
            action: actionId,
            results: ctx.automations.listResults(Number(args.limit) > 0 ? Number(args.limit) : 10),
          };
        }
        if (actionId === 'trigger-job') {
          if (!args.jobId) throw new Error('jobId is required');
          return {
            ok: true,
            connector: 'automations',
            action: actionId,
            result: await ctx.automations.triggerNow(String(args.jobId)),
          };
        }
        throw new Error(`Unsupported automations action: ${actionId}`);
      },
      resources: [
        {
          id: 'jobs',
          name: 'Automation jobs',
          description: 'Browse automation jobs and recent execution records as resources.',
        },
      ],
      listResources: async (resourceId, _args, ctx) => {
        if (resourceId !== 'jobs') throw new Error(`Unsupported automations resource: ${resourceId}`);
        return ctx.automations.listJobs().map((job) => ({
          uri: `automation://${job.id}`,
          title: job.name,
          description: job.type || 'automation',
          mimeType: 'application/json',
          metadata: { jobId: job.id, enabled: Boolean(job.enabled) },
        }));
      },
      readResource: async (uri, _args, ctx) => {
        const jobId = uri.replace(/^automation:\/\//, '');
        const job = ctx.automations.listJobs().find((entry) => entry.id === jobId);
        if (!job) throw new Error(`Unknown automation resource: ${uri}`);
        const results = ctx.automations.listResults(20).filter((entry) => entry.jobId === jobId);
        return {
          ok: true,
          connector: 'automations',
          uri,
          title: job.name,
          mimeType: 'application/json',
          content: JSON.stringify({ job, results }, null, 2),
          metadata: { jobId: job.id, resultCount: results.length },
        };
      },
    });

    this.register({
      id: 'docs',
      name: 'Docs',
      icon: '📚',
      category: 'external',
      description: 'Discover and read official documentation resources from the web.',
      trust: { level: 'networked', verified: true, requiresNetwork: true, requiresAuth: false },
      actions: [
        {
          id: 'search-docs',
          name: 'Search docs',
          description: 'Search official documentation sites.',
          inputs: [
            { id: 'query', label: 'Query', placeholder: 'React useEffect docs' },
            { id: 'domains', label: 'Domains (comma-separated)', optional: true, placeholder: 'react.dev,developer.mozilla.org' },
          ],
        },
      ],
      run: async (actionId, args, ctx) => {
        if (actionId !== 'search-docs') throw new Error(`Unsupported docs action: ${actionId}`);
        if (!ctx.webClient) throw new Error('Web client unavailable');
        if (!args.query) throw new Error('query is required');
        return {
          ok: true,
          connector: 'docs',
          action: actionId,
          result: await ctx.webClient.docs(String(args.query), {
            domains: parseCsvList(args.domains),
            limit: 8,
          }),
        };
      },
      resources: [
        {
          id: 'official-docs',
          name: 'Official docs',
          description: 'Browse official documentation pages by search query.',
          inputs: [
            { id: 'query', label: 'Query', placeholder: 'OpenAI responses API' },
            { id: 'domains', label: 'Domains (comma-separated)', optional: true, placeholder: 'platform.openai.com' },
          ],
        },
      ],
      listResources: async (resourceId, args, ctx) => {
        if (resourceId !== 'official-docs') throw new Error(`Unsupported docs resource: ${resourceId}`);
        if (!ctx.webClient) throw new Error('Web client unavailable');
        if (!args.query) throw new Error('query is required');
        const result = await ctx.webClient.docs(String(args.query), {
          domains: parseCsvList(args.domains),
          limit: 8,
        });
        return (result.results || []).map((item) => ({
          uri: `docs://${encodeURIComponent(item.url)}`,
          title: item.title || item.url,
          description: item.snippet || item.domain || 'official documentation',
          mimeType: 'text/html',
          metadata: { url: item.url, domain: item.domain || null },
        }));
      },
      readResource: async (uri, _args, ctx) => {
        if (!ctx.webClient) throw new Error('Web client unavailable');
        const url = decodeURIComponent(uri.replace(/^docs:\/\//, ''));
        const page = await ctx.webClient.open(url);
        return {
          ok: true,
          connector: 'docs',
          uri,
          title: page.title || url,
          mimeType: 'text/plain',
          content: page.text,
          metadata: { url, domain: page.domain || null },
        };
      },
    });

    this.register({
      id: 'slack',
      name: 'Slack',
      icon: '💬',
      category: 'connector',
      auth: { type: 'webhook', field: 'slackWebhookUrl', label: 'Slack webhook URL' },
      description: 'Send messages to a configured Slack incoming webhook.',
      trust: { level: 'connected', verified: true, requiresNetwork: true, requiresAuth: true },
      actions: [
        {
          id: 'send-message',
          name: 'Send message',
          description: 'Post a message to the configured Slack webhook.',
          inputs: [
            { id: 'text', label: 'Message', placeholder: 'clsClaw completed the review run.' },
            { id: 'username', label: 'Bot name', optional: true, placeholder: 'clsClaw' },
          ],
        },
      ],
      run: async (actionId, args, ctx) => {
        if (actionId !== 'send-message') throw new Error(`Unsupported slack action: ${actionId}`);
        const webhookUrl = String(ctx.settings?.slackWebhookUrl || '').trim();
        if (!webhookUrl) throw new Error('Slack webhook URL is not configured');
        if (!args.text) throw new Error('text is required');
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: String(args.text),
            username: String(args.username || 'clsClaw'),
          }),
        });
        if (!response.ok) {
          throw new Error(`Slack webhook ${response.status}: ${await response.text()}`);
        }
        return {
          ok: true,
          connector: 'slack',
          action: actionId,
          sent: true,
        };
      },
    });

    this.register({
      id: 'github',
      name: 'GitHub',
      icon: '🐙',
      category: 'connector',
      auth: { type: 'token', field: 'token', label: 'GitHub token' },
      description: 'Run typed GitHub account, repo, pull request, and issue actions through the same connector surface.',
      trust: { level: 'connected', verified: true, requiresNetwork: true, requiresAuth: true },
      actions: [
        {
          id: 'user',
          name: 'Current user',
          description: 'Verify the connected GitHub identity.',
          inputs: [
            { id: 'token', label: 'Token', optional: true, defaultFrom: 'ghToken' },
          ],
        },
        {
          id: 'list-repos',
          name: 'List repos',
          description: 'List recently updated repositories for the current user.',
          inputs: [
            { id: 'token', label: 'Token', optional: true, defaultFrom: 'ghToken' },
          ],
        },
        {
          id: 'list-prs',
          name: 'List PRs',
          description: 'List pull requests for a repository.',
          inputs: [
            { id: 'token', label: 'Token', optional: true, defaultFrom: 'ghToken' },
            { id: 'owner', label: 'Owner', placeholder: 'sahedwave' },
            { id: 'repo', label: 'Repo', placeholder: 'clsCLAW' },
            { id: 'state', label: 'State', optional: true, default: 'open' },
          ],
        },
        {
          id: 'list-issues',
          name: 'List issues',
          description: 'List open issues for a repository.',
          inputs: [
            { id: 'token', label: 'Token', optional: true, defaultFrom: 'ghToken' },
            { id: 'owner', label: 'Owner', placeholder: 'sahedwave' },
            { id: 'repo', label: 'Repo', placeholder: 'clsCLAW' },
          ],
        },
        {
          id: 'pr-bundle',
          name: 'PR review bundle',
          description: 'Load files, reviews, and grouped review threads for a pull request.',
          inputs: [
            { id: 'token', label: 'Token', optional: true, defaultFrom: 'ghToken' },
            { id: 'owner', label: 'Owner', placeholder: 'sahedwave' },
            { id: 'repo', label: 'Repo', placeholder: 'clsCLAW' },
            { id: 'pullNumber', label: 'PR number', placeholder: '1' },
          ],
        },
        {
          id: 'compare',
          name: 'Compare refs',
          description: 'Compare two refs or commits in a repository.',
          inputs: [
            { id: 'token', label: 'Token', optional: true, defaultFrom: 'ghToken' },
            { id: 'owner', label: 'Owner', placeholder: 'sahedwave' },
            { id: 'repo', label: 'Repo', placeholder: 'clsCLAW' },
            { id: 'base', label: 'Base ref', placeholder: 'main' },
            { id: 'head', label: 'Head ref', placeholder: 'feature-branch' },
          ],
        },
        {
          id: 'search',
          name: 'Search',
          description: 'Search repositories, pull requests, or issues on GitHub.',
          inputs: [
            { id: 'token', label: 'Token', optional: true, defaultFrom: 'ghToken' },
            { id: 'query', label: 'Query', placeholder: 'repo:sahedwave/clsCLAW is:pr bug' },
            { id: 'type', label: 'Type', optional: true, default: 'issues' },
          ],
        },
      ],
      run: async (actionId, args, ctx) => {
        const token = String(args.token || ctx.githubToken || '').trim();
        if (!token) throw new Error('GitHub token required');
        const gh = ctx.githubClientFactory(token);
        if (actionId === 'user') return { ok: true, connector: 'github', action: actionId, user: await gh.getUser() };
        if (actionId === 'list-repos') return { ok: true, connector: 'github', action: actionId, repos: await gh.listRepos() };
        if (actionId === 'list-prs') {
          if (!args.owner || !args.repo) throw new Error('owner and repo are required');
          return {
            ok: true,
            connector: 'github',
            action: actionId,
            prs: await gh.listPRs(String(args.owner), String(args.repo), String(args.state || 'open')),
          };
        }
        if (actionId === 'list-issues') {
          if (!args.owner || !args.repo) throw new Error('owner and repo are required');
          return {
            ok: true,
            connector: 'github',
            action: actionId,
            issues: await gh.listIssues(String(args.owner), String(args.repo)),
          };
        }
        if (actionId === 'pr-bundle') {
          if (!args.owner || !args.repo || !args.pullNumber) throw new Error('owner, repo, and pullNumber are required');
          return {
            ok: true,
            connector: 'github',
            action: actionId,
            bundle: await gh.getPRReviewBundle(String(args.owner), String(args.repo), Number(args.pullNumber)),
          };
        }
        if (actionId === 'compare') {
          if (!args.owner || !args.repo || !args.base || !args.head) throw new Error('owner, repo, base, and head are required');
          return {
            ok: true,
            connector: 'github',
            action: actionId,
            compare: await gh.compareCommits(String(args.owner), String(args.repo), String(args.base), String(args.head)),
          };
        }
        if (actionId === 'search') {
          if (!args.query) throw new Error('query is required');
          const type = String(args.type || 'issues');
          return {
            ok: true,
            connector: 'github',
            action: actionId,
            result: type === 'repos'
              ? await gh.searchRepositories(String(args.query))
              : await gh.searchIssues(String(args.query)),
          };
        }
        throw new Error(`Unsupported github action: ${actionId}`);
      },
      resources: [
        {
          id: 'pull-request',
          name: 'Pull request',
          description: 'Browse a pull request review bundle as a resource.',
          inputs: [
            { id: 'token', label: 'Token', optional: true, defaultFrom: 'ghToken' },
            { id: 'owner', label: 'Owner', placeholder: 'sahedwave' },
            { id: 'repo', label: 'Repo', placeholder: 'clsCLAW' },
            { id: 'pullNumber', label: 'PR number', placeholder: '1' },
          ],
        },
      ],
      listResources: async (resourceId, args, ctx) => {
        if (resourceId !== 'pull-request') throw new Error(`Unsupported github resource: ${resourceId}`);
        const token = String(args.token || ctx.githubToken || '').trim();
        if (!token) throw new Error('GitHub token required');
        if (!args.owner || !args.repo || !args.pullNumber) throw new Error('owner, repo, and pullNumber are required');
        const gh = ctx.githubClientFactory(token);
        const pr = await gh.getPR(String(args.owner), String(args.repo), Number(args.pullNumber));
        return [{
          uri: `github://pull/${args.owner}/${args.repo}/${args.pullNumber}`,
          title: `PR #${pr.number} ${pr.title}`,
          description: `${pr.state} · ${pr.user?.login || 'unknown'}`,
          mimeType: 'application/json',
          metadata: { owner: args.owner, repo: args.repo, pullNumber: Number(args.pullNumber) },
        }];
      },
      readResource: async (uri, args, ctx) => {
        const token = String(args.token || ctx.githubToken || '').trim();
        if (!token) throw new Error('GitHub token required');
        const gh = ctx.githubClientFactory(token);
        const match = uri.match(/^github:\/\/pull\/([^/]+)\/([^/]+)\/(\d+)$/);
        if (!match) throw new Error(`Unsupported github resource uri: ${uri}`);
        const [, owner, repo, pullNumber] = match;
        const bundle = await gh.getPRReviewBundle(owner, repo, Number(pullNumber));
        return {
          ok: true,
          connector: 'github',
          uri,
          title: `PR #${pullNumber} ${bundle.pull?.title || ''}`.trim(),
          mimeType: 'application/json',
          content: JSON.stringify(bundle, null, 2),
          metadata: { owner, repo, pullNumber: Number(pullNumber) },
        };
      },
    });
  }
}

function resolvePathInsideRoot(inputPath, projectRoot) {
  const root = path.resolve(projectRoot);
  const candidate = path.isAbsolute(String(inputPath || ''))
    ? path.resolve(String(inputPath))
    : path.resolve(root, String(inputPath || ''));
  if (!candidate.startsWith(root + path.sep) && candidate !== root) {
    throw new Error('Path must stay inside the current project root');
  }
  return candidate;
}

function guessMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.css', '.html'].includes(ext)) {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function parseCsvList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

module.exports = ConnectorManager;
