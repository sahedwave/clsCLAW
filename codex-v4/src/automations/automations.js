/**
 * automations.js — Cron-based automation scheduler
 *
 * Real cron job scheduling.
 * Results that contain reviewable findings or file proposals
 * are routed to the approval queue instead of just being logged.
 *
 * Routing rules:
 *   - skill result with fileProposals → each file → approvalQueue.propose()
 *   - skill result with findings      → approvalQueue.proposeReview()
 *   - command result                  → log only (no approval queue)
 */

'use strict';

const cron = require('./cronLite');
const { EventEmitter } = require('events');
const { randomUUID: uuid } = require('crypto');
const fs = require('fs');
const path = require('path');

class AutomationScheduler extends EventEmitter {
  constructor(dataDir, skillRegistry, approvalQueue = null) {
    super();
    this._jobs         = new Map();
    this._results      = [];
    this._dataDir      = dataDir;
    this._jobsFile     = path.join(dataDir, 'jobs.json');
    this._skillRegistry = skillRegistry;
    this._approvalQueue = approvalQueue;   // injected after construction
    this._cronHandles  = new Map();
    this._loadJobs();
  }

  /** Wire in the approval queue after construction (avoids circular dep) */
  setApprovalQueue(aq) { this._approvalQueue = aq; }

  createJob(opts) {
    if (!cron.validate(opts.cronExpr)) {
      return { ok: false, error: `Invalid cron expression: "${opts.cronExpr}". Example: "0 9 * * *" = 9am daily` };
    }
    const id = uuid();
    const job = {
      id,
      name:        opts.name,
      cronExpr:    opts.cronExpr,
      type:        opts.type,
      skillId:     opts.skillId  || null,
      command:     opts.command  || null,
      projectRoot: opts.projectRoot,
      enabled:     true,
      createdAt:   Date.now(),
      lastRun:     null,
      runCount:    0,
    };
    this._jobs.set(id, job);
    this._scheduleJob(job);
    this._saveJobs();
    return { ok: true, job };
  }

  _scheduleJob(job) {
    if (!job.enabled) return;
    if (!cron.validate(job.cronExpr)) return;
    const task = cron.schedule(job.cronExpr, async () => {
      await this._runJob(job.id);
    }, { scheduled: true });
    this._cronHandles.set(job.id, task);
  }

  async _runJob(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return;

    job.lastRun = Date.now();
    job.runCount++;
    this.emit('job:started', job);

    let result;
    try {
      if (job.type === 'skill') {
        result = await this._skillRegistry.run(job.skillId, job.projectRoot);
      } else if (job.type === 'command') {
        const { runCommandApproved } = require('../sandbox/sandbox');
        result = await runCommandApproved(job.command, job.projectRoot);
      } else {
        result = { error: 'Unknown job type: ' + job.type };
      }
    } catch (err) {
      result = { error: err.message };
    }

    const record = {
      id:       uuid(),
      jobId,
      jobName:  job.name,
      skillId:  job.skillId,
      ranAt:    job.lastRun,
      result,
      status:   result.error ? 'error' : 'success',
      reviewIds: [],   // approval queue IDs created from this run
    };

    // ── Route to approval queue ───────────────────────────────────────────────
    if (!result.error && this._approvalQueue) {
      const reviewIds = await this._routeToApprovalQueue(job, result, record.id);
      record.reviewIds = reviewIds;
    }

    this._results.unshift(record);
    if (this._results.length > 200) this._results.pop();
    this._saveJobs();
    this.emit('job:done', record);
  }

  /**
   * Examine a skill result and push reviewable items to the approval queue.
   * Returns array of change/review IDs created.
   */
  async _routeToApprovalQueue(job, result, runId) {
    const ids = [];
    const aq  = this._approvalQueue;

    // ── 1. File proposals from skills that produce them ──────────────────────
    // Skills can return fileProposals: [{ filePath, content, description }]
    if (Array.isArray(result.fileProposals)) {
      for (const fp of result.fileProposals) {
        try {
          const pending = await aq.propose({
            filePath:    fp.filePath,
            newContent:  fp.content,
            agentId:     'automation:' + job.id,
            agentName:   job.name + ' (auto)',
            description: fp.description || `Automation: ${job.name}`,
            projectRoot: job.projectRoot,
          });
          if (!pending.skipped) ids.push(pending.id);
        } catch { /* non-fatal */ }
      }
    }

    // ── 2. Findings from inspection skills ───────────────────────────────────
    // Skills like security-audit, lint return `findings` arrays.
    // We surface these as a single review item in the approval queue.
    const findings = result.findings || result.results || result.stats;
    const hasFindings = (Array.isArray(result.findings) && result.findings.length > 0)
      || (result.npmAudit && result.npmAudit.vulnerabilities)
      || (typeof result.results === 'object' && Object.keys(result.results).length > 0);

    if (hasFindings && typeof aq.proposeReview === 'function') {
      const reviewId = await aq.proposeReview({
        jobId:      job.id,
        jobName:    job.name,
        skillId:    job.skillId,
        runId,
        summary:    buildFindingsSummary(result),
        result,
        projectRoot: job.projectRoot,
      });
      if (reviewId) ids.push(reviewId);
    }

    return ids;
  }

  async triggerNow(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return { ok: false, error: 'Job not found' };
    await this._runJob(jobId);
    return { ok: true };
  }

  enableJob(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return { ok: false, error: 'Not found' };
    job.enabled = true;
    this._scheduleJob(job);
    this._saveJobs();
    return { ok: true };
  }

  disableJob(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return { ok: false, error: 'Not found' };
    job.enabled = false;
    const handle = this._cronHandles.get(jobId);
    if (handle) { handle.destroy(); this._cronHandles.delete(jobId); }
    this._saveJobs();
    return { ok: true };
  }

  deleteJob(jobId) {
    const handle = this._cronHandles.get(jobId);
    if (handle) { handle.destroy(); this._cronHandles.delete(jobId); }
    this._jobs.delete(jobId);
    this._saveJobs();
    return { ok: true };
  }

  listJobs()             { return [...this._jobs.values()]; }
  listResults(n = 50)    { return this._results.slice(0, n); }

  _saveJobs() {
    try {
      fs.writeFileSync(this._jobsFile, JSON.stringify([...this._jobs.values()]), 'utf-8');
    } catch {}
  }

  _loadJobs() {
    try {
      if (fs.existsSync(this._jobsFile)) {
        const jobs = JSON.parse(fs.readFileSync(this._jobsFile, 'utf-8'));
        for (const job of jobs) {
          this._jobs.set(job.id, job);
          this._scheduleJob(job);
        }
      }
    } catch {}
  }
}

function buildFindingsSummary(result) {
  const parts = [];
  if (Array.isArray(result.findings) && result.findings.length > 0) {
    parts.push(`${result.findings.length} finding(s)`);
  }
  if (result.npmAudit?.vulnerabilities) {
    const v = result.npmAudit.vulnerabilities;
    const count = Object.values(v).reduce((s, n) => s + n, 0);
    if (count > 0) parts.push(`${count} npm vulnerability(ies)`);
  }
  if (result.command) parts.push(`command: ${result.command}`);
  return parts.join(' · ') || 'Skill completed';
}

module.exports = AutomationScheduler;
