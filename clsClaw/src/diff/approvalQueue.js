/**
 * approvalQueue.js — Pending change management with conflict detection
 *
 * When an agent proposes a file change:
 *   1. Change is stored as "pending" — NOT written to disk
 *   2. Conflict check: if another pending change targets the same
 *      resolved file path, both are flagged as CONFLICT status
 *      and neither can be approved until one is rejected.
 *   3. UI shows diff + approve/reject buttons
 *   4. Only on approve (when no conflict) → applyDiff() writes to disk
 *   5. On reject → change is discarded, original untouched
 */

'use strict';

const { EventEmitter } = require('events');
const { randomUUID: uuid } = require('crypto');
const path = require('path');
const fs = require('fs');
const { diffFileVsProposed, applyDiff } = require('../diff/diff');

class ApprovalQueue extends EventEmitter {
  constructor(dataDir) {
    super();
    this._pending = new Map();
    this._history = [];
    this._dataDir = dataDir;
    this._historyFile = path.join(dataDir, 'history.json');
    this._loadHistory();
  }

  // ── Propose ─────────────────────────────────────────────────────────────────

  async propose({ filePath, newContent, agentId, agentName, description, projectRoot, realProjectRoot, worktreePath }) {
    const id = uuid();

    // Resolve to absolute path so conflict detection works across
    // relative vs absolute proposals targeting the same real file.
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
      diff,
      status:      'pending',   // 'pending' | 'conflict'
      conflicts:   [],          // ids of other pending changes on the same file
      proposedAt:  Date.now(),
    };

    // ── Conflict detection ───────────────────────────────────────────────────
    // Scan all existing pending changes for the same resolved file path.
    const existingForFile = [...this._pending.values()].filter(
      c => c.filePath === resolvedPath
    );

    if (existingForFile.length > 0) {
      // Mark the new proposal as conflicted
      pending.status   = 'conflict';
      pending.conflicts = existingForFile.map(c => c.id);

      // Mark all existing proposals for this file as conflicted too
      for (const existing of existingForFile) {
        if (!existing.conflicts.includes(id)) {
          existing.conflicts.push(id);
        }
        if (existing.status === 'pending') {
          existing.status = 'conflict';
          // Re-emit so the UI updates the existing card
          this.emit('conflict_updated', this._stripContent(existing));
        }
      }
    }

    this._pending.set(id, pending);
    this.emit('proposed', this._stripContent(pending));
    return pending;
  }

  // ── Propose a review item (automation findings — no file write) ─────────────

  /**
   * Surface automation/skill findings as a reviewable item.
   * Unlike propose(), this does NOT involve a file diff — it's a
   * structured findings report the user can acknowledge or dismiss.
   * Returns the review item id.
   */
  async proposeReview({ jobId, jobName, skillId, runId, summary, result, projectRoot }) {
    const id = uuid();

    const review = {
      id,
      type:       'review',          // distinguishes from 'pending' file changes
      jobId,
      jobName,
      skillId,
      runId,
      summary,
      result,
      projectRoot,
      agentId:    'automation:' + jobId,
      agentName:  jobName + ' (auto)',
      status:     'pending',
      proposedAt: Date.now(),
      // Reviews have no diff — they have findings
      diff:       null,
      filePath:   null,
      newContent: null,
      conflicts:  [],
    };

    this._pending.set(id, review);
    this.emit('proposed', this._stripContent(review));
    return id;
  }

  async approve(changeId) {
    const change = this._pending.get(changeId);
    if (!change) return { ok: false, error: 'Change not found' };

    // Review items (automation findings) are acknowledged, not written to disk
    if (change.type === 'review') {
      change.status     = 'acknowledged';
      change.resolvedAt = Date.now();
      this._pending.delete(changeId);
      this._recordHistory(change);
      this.emit('approved', this._stripContent(change));
      return { ok: true, acknowledged: true };
    }

    // Block approval if conflict is unresolved
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
      this._pending.delete(changeId);
      this._cleanupConflictRefs(changeId);
      this._recordHistory(change);
      this.emit('approved', this._stripContent(change));
      return { ok: true, filePath: change.filePath, worktreePath: change.worktreePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ── Reject ──────────────────────────────────────────────────────────────────

  reject(changeId, reason = 'User rejected') {
    const change = this._pending.get(changeId);
    if (!change) return { ok: false, error: 'Change not found' };

    change.status     = 'rejected';
    change.reason     = reason;
    change.resolvedAt = Date.now();
    this._pending.delete(changeId);

    // Removing this change might resolve conflicts for others
    this._cleanupConflictRefs(changeId);

    this._recordHistory(change);
    this.emit('rejected', this._stripContent(change));
    return { ok: true };
  }

  // ── Edit + approve ───────────────────────────────────────────────────────────

  async editAndApprove(changeId, editedContent) {
    const change = this._pending.get(changeId);
    if (!change) return { ok: false, error: 'Change not found' };
    change.newContent = editedContent;
    change.diff       = diffFileVsProposed(change.filePath, editedContent);
    return this.approve(changeId);
  }

  // ── Conflict cleanup ─────────────────────────────────────────────────────────

  _cleanupConflictRefs(removedId) {
    // Remove the resolved/rejected id from all other pending changes' conflict lists.
    // If a change had only this one conflict, clear its conflict status.
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

  // ── Getters ──────────────────────────────────────────────────────────────────

  getPending() {
    return [...this._pending.values()].map(c => this._stripContent(c));
  }

  getPendingById(id) {
    return this._pending.get(id) || null;
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

  // ── Internals ─────────────────────────────────────────────────────────────────

  _stripContent(c) {
    const { newContent, ...rest } = c;
    return rest;
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
      worktreePath:   change.worktreePath,
      stats:          change.diff?.stats,
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
    } catch { /* non-fatal */ }
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
