'use strict';

const { randomUUID } = require('crypto');
const modelRouter = require('../llm/modelRouter');

const MAX_SWARM_AGENTS = 6;

class SwarmCoordinator {
  constructor({ agentManager, planModel = modelRouter } = {}) {
    this._agentManager = agentManager;
    this._planModel = planModel;
    this._sessions = new Map();
  }

  async preview({
    goal,
    projectRoot,
    apiKey,
    contextFiles = [],
    identityContext = '',
    maxAgents = 4,
    useWorktree = true,
  } = {}) {
    if (!goal || !String(goal).trim()) throw new Error('goal is required');
    const swarmPlan = await this._plan(goal, {
      apiKey,
      contextFiles,
      identityContext,
      maxAgents,
    });
    return {
      ok: true,
      goal: String(goal || '').trim(),
      summary: swarmPlan.summary,
      tasks: swarmPlan.tasks,
      maxAgents: Math.max(2, Math.min(MAX_SWARM_AGENTS, Number(maxAgents) || 4)),
      projectRoot: projectRoot || null,
    };
  }

  async launch({
    goal,
    projectRoot,
    apiKey,
    contextFiles = [],
    identityContext = '',
    maxAgents = 4,
    useWorktree = true,
  } = {}) {
    const preview = await this.preview({
      goal,
      projectRoot,
      apiKey,
      contextFiles,
      identityContext,
      maxAgents,
      useWorktree,
    });
    const swarmId = randomUUID();
    const launches = [];
    const session = {
      id: swarmId,
      goal: String(goal || '').trim(),
      summary: preview.summary,
      createdAt: Date.now(),
      maxAgents: preview.maxAgents,
      tasks: [],
    };
    for (const task of preview.tasks) {
      const agent = await this._agentManager.launch({
        task: task.prompt,
        agentName: task.name,
        projectRoot,
        apiKey,
        contextFiles,
        worktreePath: null,
        role: task.role,
        parentAgentId: null,
      });
      launches.push({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
      });
      session.tasks.push({
        id: randomUUID(),
        name: task.name,
        role: task.role,
        prompt: task.prompt,
        agentId: agent.id,
      });
    }
    this._sessions.set(swarmId, session);
    this._trimSessions();
    return {
      ok: true,
      swarmId,
      summary: preview.summary,
      tasks: preview.tasks,
      agents: launches,
      session: this.getSession(swarmId),
    };
  }

  listSessions(limit = 20) {
    return [...this._sessions.values()]
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .slice(0, Math.max(1, Number(limit) || 20))
      .map((session) => this.getSession(session.id))
      .filter(Boolean);
  }

  getSession(id) {
    const session = this._sessions.get(String(id || ''));
    if (!session) return null;
    const tasks = session.tasks.map((task) => {
      const agent = this._agentManager?.get?.(task.agentId) || null;
      return {
        ...task,
        status: agent?.status || 'unknown',
        provider: agent?.provider || null,
        model: agent?.model || null,
        error: agent?.error || null,
        reply: trimText(agent?.reply || '', 180),
        pendingInputs: agent?.pendingInputs?.length || agent?.pendingInputs || 0,
      };
    });
    const counts = summarizeTaskCounts(tasks);
    return {
      id: session.id,
      goal: session.goal,
      summary: session.summary,
      createdAt: session.createdAt,
      maxAgents: session.maxAgents,
      status: deriveSessionStatus(counts),
      counts,
      mergeSummary: buildMergeSummary(tasks, counts),
      tasks,
    };
  }

  async _plan(goal, { apiKey, contextFiles = [], identityContext = '', maxAgents = 4 } = {}) {
    const boundedMax = Math.max(2, Math.min(MAX_SWARM_AGENTS, Number(maxAgents) || 4));
    const contextSummary = Array.isArray(contextFiles) && contextFiles.length
      ? contextFiles.slice(0, 8).map((file) => file.relativePath).join(', ')
      : '';
    try {
      const { text } = await this._planModel.call({
        role: 'analyze',
        system: `You are a bounded swarm planner for a coding workstation.
Break a coding goal into 2-${boundedMax} parallelizable specialist tasks.
Return ONLY valid JSON.

JSON:
{
  "summary": "short summary",
  "tasks": [
    { "name": "Analyzer", "role": "analyze|code|test|review|docs", "prompt": "..." }
  ]
}

Rules:
- Prefer analysis, coding, testing, review, or docs roles only.
- Keep tasks meaningfully distinct.
- Do not create more than ${boundedMax} tasks.
- Tasks should be independently actionable by separate agents.
${identityContext ? `\nWorkspace identity:\n${identityContext}` : ''}`,
        prompt: `Goal: ${goal}${contextSummary ? `\nRelevant files: ${contextSummary}` : ''}`,
        apiKey,
        stream: false,
      });
      const raw = String(text || '').replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(raw);
      const tasks = normalizeTasks(parsed.tasks, boundedMax);
      if (tasks.length >= 2) {
        return {
          summary: String(parsed.summary || goal).slice(0, 200),
          tasks,
        };
      }
    } catch {}
    return fallbackPlan(goal, boundedMax);
  }

  _trimSessions() {
    const sessions = [...this._sessions.values()].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
    for (const session of sessions.slice(30)) {
      this._sessions.delete(session.id);
    }
  }
}

function normalizeTasks(tasks, maxAgents) {
  return (Array.isArray(tasks) ? tasks : [])
    .map((task, index) => ({
      name: String(task?.name || `Swarm ${index + 1}`).trim().slice(0, 64) || `Swarm ${index + 1}`,
      role: normalizeRole(task?.role),
      prompt: String(task?.prompt || '').trim(),
    }))
    .filter((task) => task.prompt)
    .slice(0, maxAgents);
}

function normalizeRole(role) {
  return ['analyze', 'code', 'test', 'review', 'docs'].includes(String(role || '').trim())
    ? String(role).trim()
    : 'analyze';
}

function fallbackPlan(goal, maxAgents) {
  const tasks = [
    {
      name: 'Analyzer',
      role: 'analyze',
      prompt: `Inspect the repository and identify the main code paths, risks, and files relevant to this goal:\n${goal}`,
    },
    {
      name: 'Implementer',
      role: 'code',
      prompt: `Prepare the implementation approach and concrete code changes needed for this goal:\n${goal}`,
    },
    {
      name: 'Verifier',
      role: 'test',
      prompt: `Define how to verify and review the result for this goal, including likely regressions and useful checks:\n${goal}`,
    },
    {
      name: 'Reviewer',
      role: 'review',
      prompt: `Review the likely solution shape for this goal and call out risks, missing tests, and exact-line concerns:\n${goal}`,
    },
  ].slice(0, Math.max(2, Math.min(maxAgents, 4)));

  return {
    summary: 'Parallelize analysis, implementation, verification, and review in a bounded swarm.',
    tasks,
  };
}

function summarizeTaskCounts(tasks = []) {
  return tasks.reduce((acc, task) => {
    const key = ['queued', 'running', 'done', 'error', 'cancelled'].includes(task.status) ? task.status : 'other';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, { queued: 0, running: 0, done: 0, error: 0, cancelled: 0, other: 0 });
}

function deriveSessionStatus(counts = {}) {
  if ((counts.running || 0) > 0) return 'running';
  if ((counts.error || 0) > 0) return 'attention';
  if ((counts.done || 0) > 0 && (counts.queued || 0) === 0) return 'complete';
  return 'queued';
}

function buildMergeSummary(tasks = [], counts = {}) {
  if ((counts.error || 0) > 0) {
    const failed = tasks.find((task) => task.error);
    return failed ? `Attention needed: ${failed.name} failed with ${trimText(failed.error, 80)}.` : 'One or more swarm tasks need attention.';
  }
  if ((counts.running || 0) > 0) {
    const running = tasks.find((task) => task.status === 'running');
    return running ? `${running.name} is still running while the rest of the swarm progresses.` : 'Swarm is actively working.';
  }
  const replies = tasks.map((task) => task.reply).filter(Boolean);
  if (replies.length) {
    return replies.slice(0, 2).join(' · ');
  }
  return 'Swarm session is ready for review.';
}

function trimText(text = '', max = 160) {
  const value = String(text || '').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

module.exports = {
  SwarmCoordinator,
};
