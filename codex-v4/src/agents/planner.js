/**
 * planner.js — Two-phase task planning
 *
 * Phase 1: Decompose goal into structured JSON task graph (no agents yet)
 * Phase 2: User approves plan → workers spawn per step, respecting dependsOn
 */
'use strict';

const { EventEmitter } = require('events');
const { randomUUID: uuid } = require('crypto');

const TYPE_TO_ROLE = {
  analyze: 'analyzer', code: 'coder', test: 'tester',
  review:  'reviewer',  docs: 'coder', default: 'coder',
};

class Planner extends EventEmitter {
  constructor({ agentManager, memoryStore }) {
    super();
    this._agentManager = agentManager;
    this._memoryStore  = memoryStore;
    this._plans        = new Map();
  }

  async generatePlan({ goal, projectRoot, apiKey, contextFiles = [] }) {
    const memory = this._memoryStore
      ? this._memoryStore.query(goal, { projectRoot }) : '';

    const system = `You are a software project planner.
Break down the coding goal into 3-6 ordered steps.
Return ONLY valid JSON — no explanation, no markdown fences.

JSON format:
{
  "goal": "original goal",
  "steps": [
    { "id": 1, "type": "analyze", "description": "...", "dependsOn": [] },
    { "id": 2, "type": "code",    "description": "...", "dependsOn": [1] }
  ]
}

Types: analyze | code | test | review | docs
dependsOn: array of step ids that must complete first`;

    const ctxSection = contextFiles.length > 0
      ? '\n\nProject files:\n' + contextFiles
          .map(f => `${f.relativePath}: ${(f.symbols||[]).slice(0,5).join(', ')}`)
          .join('\n')
      : '';
    const memSection = memory ? '\n\nProject memory:\n' + memory : '';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 1024, system,
        messages: [{ role:'user', content:`Goal: ${goal}${ctxSection}${memSection}\n\nReturn JSON plan.` }],
      }),
    });

    if (!r.ok) throw new Error(`Planner API ${r.status}: ${await r.text()}`);

    const data = await r.json();
    let planData;
    try {
      const raw = (data.content?.[0]?.text || '')
        .replace(/^```json?\s*/i,'').replace(/\s*```$/,'').trim();
      planData = JSON.parse(raw);
    } catch {
      throw new Error('Planner returned invalid JSON: ' + (data.content?.[0]?.text||'').slice(0,200));
    }

    if (!Array.isArray(planData.steps) || !planData.steps.length)
      throw new Error('Planner returned no steps');

    const plan = {
      id:          uuid(),
      goal:        planData.goal || goal,
      status:      'pending',
      steps:       planData.steps.map(s => ({
        id:          s.id,
        type:        s.type || 'code',
        role:        TYPE_TO_ROLE[s.type] || TYPE_TO_ROLE.default,
        description: s.description,
        dependsOn:   Array.isArray(s.dependsOn) ? s.dependsOn : [],
        status:      'pending',
        agentId:     null,
        output:      null,
      })),
      projectRoot, apiKey, contextFiles,
      createdAt: Date.now(), startedAt: null, completedAt: null,
    };

    this._plans.set(plan.id, plan);
    this.emit('plan:created', this._safe(plan));
    return plan;
  }

  async executePlan(planId) {
    const plan = this._plans.get(planId);
    if (!plan) throw new Error('Plan not found: ' + planId);
    if (plan.status === 'running') throw new Error('Plan already running');
    plan.status = 'running'; plan.startedAt = Date.now();
    this.emit('plan:started', this._safe(plan));
    await this._advance(plan);
    return this._safe(plan);
  }

  updatePlan(planId, updatedSteps) {
    const plan = this._plans.get(planId);
    if (!plan) throw new Error('Plan not found');
    if (plan.status !== 'pending') throw new Error('Can only edit pending plans');
    plan.steps = updatedSteps.map(s => ({
      ...s, role: TYPE_TO_ROLE[s.type] || TYPE_TO_ROLE.default,
      status: 'pending', agentId: null, output: null,
    }));
    this.emit('plan:updated', this._safe(plan));
    return this._safe(plan);
  }

  cancelPlan(planId) {
    const plan = this._plans.get(planId);
    if (!plan) return { ok: false, error: 'Plan not found' };
    for (const s of plan.steps) {
      if (s.agentId && s.status === 'running') {
        this._agentManager.cancel(s.agentId); s.status = 'skipped';
      } else if (s.status === 'pending') s.status = 'skipped';
    }
    plan.status = 'cancelled'; plan.completedAt = Date.now();
    this.emit('plan:cancelled', this._safe(plan));
    return { ok: true };
  }

  listPlans()      { return [...this._plans.values()].map(p => this._safe(p)); }
  getPlan(planId)  { const p = this._plans.get(planId); return p ? this._safe(p) : null; }

  async _advance(plan) {
    if (plan.status !== 'running') return;

    const doneIds  = new Set(plan.steps.filter(s => s.status === 'done').map(s => s.id));
    const hasError = plan.steps.some(s => s.status === 'error');
    const allDone  = plan.steps.every(s => ['done','skipped'].includes(s.status));

    if (allDone) {
      plan.status = 'done'; plan.completedAt = Date.now();
      if (this._memoryStore) {
        this._memoryStore.recordOutcome({
          task:    plan.goal,
          summary: `Completed ${plan.steps.length} steps`,
        });
      }
      this.emit('plan:done', this._safe(plan)); return;
    }

    if (hasError) {
      for (const s of plan.steps) { if (s.status === 'pending') s.status = 'skipped'; }
      plan.status = 'error'; plan.completedAt = Date.now();
      this.emit('plan:error', this._safe(plan)); return;
    }

    for (const step of plan.steps) {
      if (step.status !== 'pending') continue;
      if (!step.dependsOn.every(id => doneIds.has(id))) continue;

      const prevOut = plan.steps
        .filter(s => step.dependsOn.includes(s.id) && s.output)
        .map(s => `Step ${s.id} (${s.type}): ${s.output}`).join('\n');

      step.status = 'running';
      this.emit('plan:step_started', { planId: plan.id, stepId: step.id });

      try {
        const agent = await this._agentManager.launch({
          task:         prevOut ? `${step.description}\n\nPrevious steps:\n${prevOut}` : step.description,
          agentName:    `Step ${step.id}: ${step.description.slice(0,30)}`,
          role:         step.role,
          projectRoot:  plan.projectRoot,
          apiKey:       plan.apiKey,
          contextFiles: plan.contextFiles,
        });
        step.agentId = agent.id;
        this._watch(plan, step, agent.id);
      } catch (err) {
        step.status = 'error'; step.output = err.message;
        this.emit('plan:step_error', { planId: plan.id, stepId: step.id, error: err.message });
        await this._advance(plan);
      }
    }
    this.emit('plan:updated', this._safe(plan));
  }

  _watch(plan, step, agentId) {
    const done = async (d) => {
      const id = d.id || d.agent?.id;
      if (id !== agentId) return;
      cleanup();
      const a = this._agentManager.get(agentId);
      step.output = (a?.reply || `Step ${step.id} completed`).slice(0, 300);
      step.status = 'done';
      this.emit('plan:step_done', { planId: plan.id, stepId: step.id });
      await this._advance(plan);
    };
    const error = async (d) => {
      const id = d.id || d.agent?.id;
      if (id !== agentId) return;
      cleanup();
      step.status = 'error';
      step.output = d.agent?.error || d.error || 'Agent error';
      this.emit('plan:step_error', { planId: plan.id, stepId: step.id, error: step.output });
      await this._advance(plan);
    };
    const cleanup = () => {
      this._agentManager.off('agent:exit',      done);
      this._agentManager.off('agent:done',      done);
      this._agentManager.off('agent:error',     error);
      this._agentManager.off('agent:cancelled', error);
    };
    this._agentManager.on('agent:exit',      done);
    this._agentManager.on('agent:done',      done);
    this._agentManager.on('agent:error',     error);
    this._agentManager.on('agent:cancelled', error);
  }

  _safe(plan) {
    const { apiKey, ...rest } = plan;
    return { ...rest, steps: rest.steps.map(s => ({ ...s })) };
  }
}

module.exports = Planner;
