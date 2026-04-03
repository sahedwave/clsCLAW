'use strict';

const { randomUUID } = require('crypto');
const modelRouter = require('../llm/modelRouter');

const MAX_SWARM_AGENTS = 6;

class SwarmCoordinator {
  constructor({ agentManager, planModel = modelRouter } = {}) {
    this._agentManager = agentManager;
    this._planModel = planModel;
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
    if (!goal || !String(goal).trim()) throw new Error('goal is required');
    const swarmPlan = await this._plan(goal, {
      apiKey,
      contextFiles,
      identityContext,
      maxAgents,
    });
    const swarmId = randomUUID();
    const launches = [];
    for (const task of swarmPlan.tasks) {
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
    }
    return {
      ok: true,
      swarmId,
      summary: swarmPlan.summary,
      tasks: swarmPlan.tasks,
      agents: launches,
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

module.exports = {
  SwarmCoordinator,
};
