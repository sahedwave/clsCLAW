'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createEvidenceBundle, appendEvidence } = require('./evidenceBundle');

class TurnTraceStore {
  constructor(dataDir, { maxTurns = 100 } = {}) {
    this._dataDir = dataDir;
    this._file = path.join(dataDir, 'turn-traces.json');
    this._maxTurns = maxTurns;
    fs.mkdirSync(dataDir, { recursive: true });
    this._turns = this._load();
  }

  createTurn(meta = {}) {
    const turn = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      meta: {
        mode: meta.mode || 'ask',
        profile: meta.profile || 'deliberate',
        lane: meta.lane || 'analysis',
        intent: meta.intent || 'chat',
        responseStyle: meta.responseStyle || null,
        role: meta.role || 'analyze',
        userText: String(meta.userText || ''),
        toolLoop: Boolean(meta.toolLoop),
        ui: meta.ui && typeof meta.ui === 'object' ? { ...meta.ui } : null,
        actor: meta.actor && typeof meta.actor === 'object' ? { ...meta.actor } : null,
      },
      deliberation: meta.deliberation || null,
      governor: meta.governor || null,
      plan: {
        summary: String(meta.summary || meta.userText || '').slice(0, 220),
        phase: meta.toolLoop ? 'planning' : 'direct_reply',
        nextAction: meta.toolLoop ? 'decide first tool' : 'reply directly',
        confidence: null,
        totalUnits: 0,
        completedUnits: 0,
        retries: 0,
        failures: 0,
        parallelBatches: 0,
        lastDecision: null,
        executionProfile: meta.profile || 'deliberate',
      },
      steps: [],
      evidence: [],
      evidenceBundle: createEvidenceBundle(),
      verification: {
        required: Boolean(meta.deliberation?.needsVerification),
        performed: false,
        status: meta.deliberation?.needsVerification ? 'pending' : 'not_required',
        notes: [],
      },
      artifacts: [],
      final: null,
      error: null,
    };
    this._turns.unshift(turn);
    this._truncate();
    this._save();
    return clone(turn);
  }

  appendStep(turnId, step) {
    const turn = this._find(turnId);
    if (!turn) return null;
    turn.steps.push({
      id: randomUUID(),
      at: new Date().toISOString(),
      ...step,
    });
    turn.updatedAt = new Date().toISOString();
    this._save();
    return clone(turn);
  }

  appendEvidence(turnId, evidence) {
    const turn = this._find(turnId);
    if (!turn) return null;
    const citationId = evidence?.citationId || `S${turn.evidence.length + 1}`;
    const appended = {
      id: randomUUID(),
      at: new Date().toISOString(),
      citationId,
      ...evidence,
    };
    turn.evidence.push(appended);
    turn.evidenceBundle = appendEvidence(turn.evidenceBundle || createEvidenceBundle(), appended);
    turn.updatedAt = new Date().toISOString();
    this._save();
    return clone(appended);
  }

  updateDeliberation(turnId, deliberation) {
    const turn = this._find(turnId);
    if (!turn) return null;
    turn.deliberation = deliberation ? { ...deliberation } : null;
    turn.updatedAt = new Date().toISOString();
    this._save();
    return clone(turn.deliberation);
  }

  updateGovernor(turnId, governor) {
    const turn = this._find(turnId);
    if (!turn) return null;
    turn.governor = governor ? { ...governor } : null;
    turn.updatedAt = new Date().toISOString();
    this._save();
    return clone(turn.governor);
  }

  updatePlan(turnId, patch = {}) {
    const turn = this._find(turnId);
    if (!turn) return null;
    turn.plan = {
      ...(turn.plan || {}),
      ...patch,
    };
    if (typeof patch.completedUnits === 'number' && patch.completedUnits < 0) {
      turn.plan.completedUnits = 0;
    }
    if (typeof patch.totalUnits === 'number' && patch.totalUnits < 0) {
      turn.plan.totalUnits = 0;
    }
    turn.updatedAt = new Date().toISOString();
    this._save();
    return clone(turn.plan);
  }

  updateVerification(turnId, patch = {}) {
    const turn = this._find(turnId);
    if (!turn) return null;
    turn.verification = {
      ...(turn.verification || {
        required: false,
        performed: false,
        status: 'not_required',
        notes: [],
      }),
      ...patch,
      notes: Array.isArray(patch.notes)
        ? patch.notes
        : Array.isArray(turn.verification?.notes)
          ? turn.verification.notes
          : [],
    };
    turn.updatedAt = new Date().toISOString();
    this._save();
    return clone(turn.verification);
  }

  attachArtifact(turnId, artifact) {
    const turn = this._find(turnId);
    if (!turn) return null;
    const record = artifact && typeof artifact === 'object' ? { ...artifact } : null;
    if (!record) return null;
    turn.artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
    turn.artifacts.push(record);
    turn.updatedAt = new Date().toISOString();
    this._save();
    return clone(turn.artifacts);
  }

  finalizeTurn(turnId, final) {
    const turn = this._find(turnId);
    if (!turn) return null;
    turn.status = final?.status || 'done';
    turn.final = final?.final || null;
    turn.error = final?.error || null;
    const preserveNextAction = turn.plan?.phase === 'await_approval' || turn.plan?.phase === 'ask';
    turn.plan = {
      ...(turn.plan || {}),
      phase: turn.status === 'done' ? 'complete' : turn.status,
      nextAction: final?.error
        ? 'review failure'
        : preserveNextAction
          ? turn.plan?.nextAction
          : 'finished',
    };
    turn.updatedAt = new Date().toISOString();
    this._save();
    return clone(turn);
  }

  getTurn(turnId) {
    const turn = this._find(turnId);
    return turn ? clone(turn) : null;
  }

  listRecent(limit = 20) {
    return this._turns.slice(0, limit).map(clone);
  }

  _find(turnId) {
    return this._turns.find((turn) => turn.id === turnId) || null;
  }

  _truncate() {
    if (this._turns.length > this._maxTurns) {
      this._turns.length = this._maxTurns;
    }
  }

  _load() {
    try {
      if (fs.existsSync(this._file)) {
        const parsed = JSON.parse(fs.readFileSync(this._file, 'utf-8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  }

  _save() {
    fs.writeFileSync(this._file, JSON.stringify(this._turns, null, 2), 'utf-8');
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = TurnTraceStore;
