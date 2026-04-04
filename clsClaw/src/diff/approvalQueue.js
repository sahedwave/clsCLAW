

'use strict';

const { EventEmitter } = require('events');
const { randomUUID: uuid } = require('crypto');
const path = require('path');
const fs = require('fs');
const { diffFileVsProposed, applyDiff } = require('../diff/diff');
const { buildInlineReviewData, reanchorInlineComments } = require('../review/inlineComments');
const { buildReviewBundle } = require('../review/reviewBundle');
const { buildEvidenceBundle } = require('../orchestration/evidenceBundle');
const { buildApprovalContext, classifyEvidenceStatus } = require('../orchestration/autonomyGovernor');

class ApprovalQueue extends EventEmitter {
  constructor(dataDir) {
    super();
    this._pending = new Map();
    this._history = [];
    this._dataDir = dataDir;
    this._historyFile = path.join(dataDir, 'history.json');
    this._loadHistory();
  }

  

  async propose({ filePath, newContent, agentId, agentName, description, projectRoot, realProjectRoot, worktreePath, evidenceBundle = null, approvalContext = null, actor = null }) {
    const id = uuid();

    
    
    const resolvedPath = path.resolve(filePath);

    const diff = diffFileVsProposed(resolvedPath, newContent);

    if (diff.identical) {
      return { skipped: true, reason: 'No changes detected', filePath: resolvedPath };
    }

    const pending = {
      id,
      filePath:        resolvedPath,
      newContent,
      agentId:         agentId    || 'manual',
      agentName:       agentName  || 'Manual',
      description:     description || `Modify ${path.basename(resolvedPath)}`,
      projectRoot:     projectRoot     || path.dirname(resolvedPath),
      realProjectRoot: realProjectRoot || projectRoot || path.dirname(resolvedPath),
      worktreePath:    worktreePath    || null,
      evidenceBundle:  evidenceBundle  || null,
      approvalContext: approvalContext || buildApprovalContext({
        kind: 'file_change',
        policy: { intent: 'build', mode: 'build', userText: description || `Modify ${path.basename(resolvedPath)}` },
        deliberation: {
          approvalSensitive: true,
          autonomyAllowance: 'bounded',
          risk: 'medium',
          needsVerification: true,
          writeScope: 'single_file',
        },
        evidenceBundle,
        evidenceStatus: classifyEvidenceStatus(evidenceBundle),
      }),
      diff,
      status:      'pending',   // 'pending' | 'conflict'
      conflicts:   [],          // ids of other pending changes on the same file
      proposedAt:  Date.now(),
      proposedBy:  actor && typeof actor === 'object' ? { ...actor } : null,
    };


    const existingForFile = [...this._pending.values()].filter(
      c => c.filePath === resolvedPath
    );

    if (existingForFile.length > 0) {

      pending.status   = 'conflict';
      pending.conflicts = existingForFile.map(c => c.id);

      for (const existing of existingForFile) {
        if (!existing.conflicts.includes(id)) {
          existing.conflicts.push(id);
        }
        if (existing.status === 'pending') {
          existing.status = 'conflict';

          this.emit('conflict_updated', this._stripContent(existing));
        }
      }
    }

    this._pending.set(id, pending);
    this.emit('proposed', this._stripContent(pending));
    return pending;
  }
  async proposeReview({ jobId, jobName, skillId, runId, summary, result, projectRoot, actor = null }) {
    const id = uuid();
    const reviewData = buildInlineReviewData({ result, projectRoot });
    const evidenceBundle = buildEvidenceBundle([
      ...(reviewData.inlineComments || []).map((comment) => ({
        type: 'workspace',
        source: comment.file || 'workspace',
        title: comment.title || comment.file || 'review finding',
        snippet: comment.body || '',
      })),
      ...((result?.findings || []).map((finding) => ({
        type: 'workspace',
        source: finding.file || 'workspace',
        title: finding.issue || finding.title || 'review finding',
        snippet: `${finding.issue || finding.title || ''}`,
      }))),
      ...((result?.sources || []).map((source) => ({
        type: source.type || 'web',
        source: source.source || source.url || 'external',
        title: source.title || source.url || 'external source',
        snippet: source.snippet || source.url || '',
      }))),
    ]);
    const approvalContext = buildApprovalContext({
      kind: 'review_acknowledgement',
      policy: { intent: 'review', mode: 'ask', userText: summary || jobName || 'review findings' },
      deliberation: {
        approvalSensitive: true,
        autonomyAllowance: 'bounded',
        risk: reviewData.inlineComments.length || (result?.findings || []).length ? 'medium' : 'low',
        needsVerification: false,
        writeScope: 'single_file',
      },
      evidenceBundle,
    });

    const review = {
      id,
      type:       'review',          // distinguishes from 'pending' file changes
      jobId,
      jobName,
      skillId,
      runId,
      summary,
      result: {
        ...result,
        generalFindings: reviewData.generalFindings,
      },
      inlineComments: reviewData.inlineComments,
      evidenceBundle,
      approvalContext,
      reviewBundle: buildReviewBundle({
        summary,
        result: {
          ...result,
          generalFindings: reviewData.generalFindings,
        },
        inlineComments: reviewData.inlineComments,
        evidenceBundle,
        approvalContext,
      }),
      projectRoot,
      agentId:    'automation:' + jobId,
      agentName:  jobName + ' (auto)',
      status:     'pending',
      proposedAt: Date.now(),
      proposedBy: actor && typeof actor === 'object' ? { ...actor } : null,

      diff:       null,
      filePath:   null,
      newContent: null,
      conflicts:  [],
    };

    this._pending.set(id, review);
    this.emit('proposed', this._stripContent(review));
    return id;
  }

  updateReviewMetadata(changeId, patch = {}) {
    const change = this._pending.get(changeId);
    if (!change || change.type !== 'review') {
      return { ok: false, error: 'Review item not found' };
    }
    Object.assign(change, patch);
    change.reviewBundle = buildReviewBundle({
      summary: change.summary,
      result: change.result,
      inlineComments: change.inlineComments,
      evidenceBundle: change.evidenceBundle,
      approvalContext: change.approvalContext,
      githubReview: change.githubReview,
    });
    change.updatedAt = Date.now();
    this.emit('updated', this._prepareChangeForRead(change));
    return { ok: true, change: this._prepareChangeForRead(change) };
  }

  async approve(changeId, actor = null) {
    const change = this._pending.get(changeId);
    if (!change) return { ok: false, error: 'Change not found' };

    if (change.type === 'review') {
      change.status     = 'acknowledged';
      change.resolvedAt = Date.now();
      change.resolvedBy = actor && typeof actor === 'object' ? { ...actor } : null;
      this._pending.delete(changeId);
      this._recordHistory(change);
      this.emit('approved', this._stripContent(change));
      return { ok: true, acknowledged: true };
    }

    const activeConflicts = change.conflicts.filter(id => this._pending.has(id));
    if (change.status === 'conflict' && activeConflicts.length > 0) {
      return {
        ok: false,
        error: `CONFLICT: ${activeConflicts.length} other pending change(s) target this file. ` +
               `Reject the conflicting change(s) first, then approve this one.`,
        conflicts: activeConflicts,
      };
    }

    try {
      await applyDiff(change.filePath, change.newContent, change.projectRoot, {
        agentId:     change.agentId,
        agentName:   change.agentName,
        description: change.description,
        stats:       change.diff?.stats,
      });
      change.status     = 'approved';
      change.resolvedAt = Date.now();
      change.resolvedBy = actor && typeof actor === 'object' ? { ...actor } : null;
      this._pending.delete(changeId);
      this._cleanupConflictRefs(changeId);
      this._recordHistory(change);
      this.emit('approved', this._stripContent(change));
      return { ok: true, filePath: change.filePath, worktreePath: change.worktreePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }


  reject(changeId, reason = 'User rejected', actor = null) {
    const change = this._pending.get(changeId);
    if (!change) return { ok: false, error: 'Change not found' };

    change.status     = 'rejected';
    change.reason     = reason;
    change.resolvedAt = Date.now();
    change.resolvedBy = actor && typeof actor === 'object' ? { ...actor } : null;
    this._pending.delete(changeId);

    this._cleanupConflictRefs(changeId);

    this._recordHistory(change);
    this.emit('rejected', this._stripContent(change));
    return { ok: true };
  }


  async editAndApprove(changeId, editedContent, actor = null) {
    const change = this._pending.get(changeId);
    if (!change) return { ok: false, error: 'Change not found' };
    change.newContent = editedContent;
    change.diff       = diffFileVsProposed(change.filePath, editedContent);
    return this.approve(changeId, actor);
  }


  _cleanupConflictRefs(removedId) {


    for (const [, change] of this._pending) {
      const idx = change.conflicts.indexOf(removedId);
      if (idx !== -1) {
        change.conflicts.splice(idx, 1);
        if (change.conflicts.length === 0 && change.status === 'conflict') {
          change.status = 'pending';
          this.emit('conflict_resolved', this._stripContent(change));
        }
      }
    }
  }


  getPending() {
    return [...this._pending.values()].map((change) => this._prepareChangeForRead(change));
  }

  getPendingById(id) {
    const change = this._pending.get(id) || null;
    return change ? this._prepareChangeForRead(change) : null;
  }

  getHistory(limit = 100) {
    return this._history.slice(-limit).reverse();
  }

  getFileHistory(filePath) {
    const resolved = path.resolve(filePath);
    return this._history
      .filter(h => h.filePath === resolved)
      .slice(-20)
      .reverse();
  }


  _stripContent(c) {
    const { newContent, ...rest } = c;
    return rest;
  }

  _prepareChangeForRead(change) {
    const base = this._stripContent(change);
    if (change.type !== 'review') return base;
    const inlineComments = reanchorInlineComments(change.inlineComments || [], change.projectRoot);
    return {
      ...base,
      inlineComments,
      reviewBundle: buildReviewBundle({
        summary: change.summary,
        result: change.result,
        inlineComments,
        evidenceBundle: change.evidenceBundle,
        approvalContext: change.approvalContext,
        githubReview: change.githubReview,
      }),
    };
  }

  _recordHistory(change) {
    this._history.push({
      id:             change.id,
      filePath:       change.filePath,
      agentId:        change.agentId,
      agentName:      change.agentName,
      description:    change.description,
      status:         change.status,
      reason:         change.reason,
      proposedAt:     change.proposedAt,
      resolvedAt:     change.resolvedAt,
      proposedBy:     change.proposedBy || null,
      resolvedBy:     change.resolvedBy || null,
      worktreePath:   change.worktreePath,
      stats:          change.diff?.stats,
      approvalContext: change.approvalContext || null,
      reviewBundle: change.reviewBundle || null,
    });
    if (this._history.length > 1000) this._history.shift();
    this._saveHistory();
  }

  _saveHistory() {
    try {
      fs.writeFileSync(
        this._historyFile,
        JSON.stringify(this._history.slice(-200)),
        'utf-8'
      );
    } catch {}
  }

  _loadHistory() {
    try {
      if (fs.existsSync(this._historyFile)) {
        this._history = JSON.parse(fs.readFileSync(this._historyFile, 'utf-8'));
      }
    } catch { this._history = []; }
  }
}

module.exports = ApprovalQueue;
