

'use strict';

const cron = require('./cronLite');
const { EventEmitter } = require('events');
const { randomUUID: uuid } = require('crypto');
const fs = require('fs');
const path = require('path');
const { runHeartbeatJob } = require('./heartbeatJobs');

class AutomationScheduler extends EventEmitter {
  constructor(dataDir, skillRegistry, approvalQueue = null) {
    super();
    this._jobs         = new Map();
    this._results      = [];
    this._notifications = [];
    this._dataDir      = dataDir;
    this._jobsFile     = path.join(dataDir, 'jobs.json');
    this._notificationsFile = path.join(dataDir, 'notifications.json');
    this._skillRegistry = skillRegistry;
    this._approvalQueue = approvalQueue;   
    this._memoryStore = null;
    this._webClient = null;
    this._artifactStore = null;
    this._cronHandles  = new Map();
    this._loadJobs();
  }

  
  setApprovalQueue(aq) { this._approvalQueue = aq; }
  setMemoryStore(ms) { this._memoryStore = ms; }
  setWebClient(client) { this._webClient = client; }
  setArtifactStore(store) { this._artifactStore = store; }

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
      heartbeatKind: opts.heartbeatKind || null,
      options:     opts.options && typeof opts.options === 'object' ? { ...opts.options } : null,
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
      } else if (job.type === 'heartbeat') {
        result = await runHeartbeatJob(job, {
          projectRoot: job.projectRoot,
          memoryStore: this._memoryStore,
          approvalQueue: this._approvalQueue,
          webClient: this._webClient,
          previousState: job.lastHeartbeatSnapshot || null,
        });
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

    if (!result.error && this._approvalQueue) {
      const reviewIds = await this._routeToApprovalQueue(job, result, record.id);
      record.reviewIds = reviewIds;
    }

    if (!result.error) {
      const snapshot = deriveHeartbeatSnapshot(job, result);
      if (snapshot) job.lastHeartbeatSnapshot = snapshot;
    }

    if (!result.error && this._artifactStore) {
      const artifact = createAutomationArtifact(job, record);
      if (artifact) {
        const saved = this._artifactStore.create({
          ...artifact,
          projectRoot: job.projectRoot,
        });
        record.artifactId = saved.id;
      }
    }

    this._results.unshift(record);
    if (this._results.length > 200) this._results.pop();
    const notification = this._createNotification(job, record);
    if (notification) {
      this._notifications.unshift(notification);
      if (this._notifications.length > 200) this._notifications = this._notifications.slice(0, 200);
      this.emit('notification:new', notification);
    }
    this._saveJobs();
    this.emit('job:done', record);
  }

  async _routeToApprovalQueue(job, result, runId) {
    const ids = [];
    const aq  = this._approvalQueue;


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
        } catch {}
      }
    }



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

  shutdown() {
    for (const handle of this._cronHandles.values()) {
      try { handle.destroy(); } catch {}
    }
    this._cronHandles.clear();
  }

  listJobs()             { return [...this._jobs.values()]; }
  listResults(n = 50)    { return this._results.slice(0, n); }
  listNotifications(n = 50) { return this._notifications.slice(0, n); }
  acknowledgeNotification(id) {
    const notification = this._notifications.find((item) => item.id === id);
    if (!notification) return { ok: false, error: 'Not found' };
    notification.acknowledgedAt = Date.now();
    this._saveNotifications();
    this.emit('notification:updated', notification);
    return { ok: true, notification };
  }
  promoteNotificationToMemory(id) {
    const notification = this._notifications.find((item) => item.id === id);
    if (!notification) return { ok: false, error: 'Not found' };
    if (!this._memoryStore?.recordAutomationNote) {
      return { ok: false, error: 'Memory store unavailable' };
    }
    const note = [
      notification.summary || notification.jobName || 'Automation update',
      '',
      ...(Array.isArray(notification.sources) ? notification.sources.slice(0, 3).map((source, index) =>
        `${index + 1}. ${source.title || source.url || source.source || 'source'} — ${source.url || source.source || ''}`
      ) : []),
    ].filter(Boolean).join('\n');
    this._memoryStore.recordAutomationNote({
      title: `Heartbeat inbox: ${notification.jobName || 'automation'}`,
      note,
      projectRoot: notification.projectRoot || null,
      tags: ['heartbeat', 'notification', notification.heartbeatKind || notification.status || 'automation'],
    });
    notification.promotedToMemoryAt = Date.now();
    this._saveNotifications();
    this.emit('notification:updated', notification);
    return { ok: true, notification };
  }
  getHeartbeatPresets() {
    return [
      {
        id: 'workspace-briefing',
        name: 'Workspace briefing',
        cronExpr: '0 9 * * *',
        options: { maxCommits: 5 },
        description: 'Summarize recent commits, dirty state, and pending review work.',
      },
      {
        id: 'log-watchdog',
        name: 'Simulation watchdog',
        cronExpr: '*/30 * * * *',
        options: { filePath: 'openmc.log', pattern: 'Geometry Error', label: 'Geometry Error' },
        description: 'Scan a project log for critical error patterns and surface reviewable alerts.',
      },
      {
        id: 'scheduled-reflection',
        name: 'Scheduled reflection',
        cronExpr: '0 22 * * *',
        options: { prompt: 'What did we achieve today, and what should we prioritize next?' },
        description: 'Create an end-of-day reflection prompt and store it in memory.',
      },
      {
        id: 'weekly-coding-report',
        name: 'Weekly coding report',
        cronExpr: '0 18 * * 0',
        options: { days: 7 },
        description: 'Summarize the last week of coding activity into a reviewable report.',
      },
      {
        id: 'deadline-reminder',
        name: 'Deadline reminder',
        cronExpr: '0 9 * * *',
        options: { label: 'Important deadline', deadline: '2026-12-31', warnDays: 7 },
        description: 'Remind you when a tracked deadline is approaching or overdue.',
      },
      {
        id: 'paper-tracker',
        name: 'Paper tracker',
        cronExpr: '0 8 * * *',
        options: { query: 'Small Modular Reactors', limit: 3 },
        description: 'Track new arXiv papers for a research topic and surface a reviewable briefing.',
      },
      {
        id: 'team-status-briefing',
        name: 'Team status briefing',
        cronExpr: '0 10 * * 1-5',
        options: { days: 3 },
        description: 'Summarize recent contributors, hot files, and pending queue work for a team-style briefing.',
      },
    ];
  }

  _saveJobs() {
    try {
      fs.writeFileSync(this._jobsFile, JSON.stringify([...this._jobs.values()]), 'utf-8');
    } catch {}
    this._saveNotifications();
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
    try {
      if (fs.existsSync(this._notificationsFile)) {
        const notifications = JSON.parse(fs.readFileSync(this._notificationsFile, 'utf-8'));
        if (Array.isArray(notifications)) this._notifications = notifications;
      }
    } catch {}
  }

  _saveNotifications() {
    try {
      fs.writeFileSync(this._notificationsFile, JSON.stringify(this._notifications), 'utf-8');
    } catch {}
  }

  _createNotification(job, record) {
    const result = record?.result || {};
    const findingsCount = Array.isArray(result.findings) ? result.findings.length : 0;
    const shouldNotify = job?.type === 'heartbeat' || record.status === 'error' || findingsCount > 0;
    if (!shouldNotify) return null;
    return {
      id: uuid(),
      jobId: record.jobId,
      runId: record.id,
      jobName: record.jobName,
      heartbeatKind: job?.heartbeatKind || null,
      status: record.status,
      summary: buildFindingsSummary(result),
      findingsCount,
      projectRoot: job?.projectRoot || null,
      sources: Array.isArray(result.sources)
        ? result.sources.slice(0, 5).map((source) => ({
          type: source.type || 'web',
          title: source.title || source.url || source.source || 'source',
          url: source.url || source.source || '',
          source: source.source || source.url || '',
          snippet: source.snippet || '',
        }))
        : [],
      highlights: Array.isArray(result.highlights)
        ? result.highlights.slice(0, 4).map((item) => String(item || '').trim()).filter(Boolean)
        : [],
      reviewIds: Array.isArray(record.reviewIds) ? [...record.reviewIds] : [],
      artifactId: record.artifactId || null,
      createdAt: record.ranAt || Date.now(),
      acknowledgedAt: null,
      promotedToMemoryAt: null,
    };
  }
}

function buildFindingsSummary(result) {
  const parts = [];
  if (result.summary) parts.push(String(result.summary).trim());
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

function deriveHeartbeatSnapshot(job, result) {
  if (job?.type !== 'heartbeat' || !result || typeof result !== 'object') return null;
  if (job.heartbeatKind === 'paper-tracker') {
    return {
      kind: 'paper-tracker',
      query: result.query || job?.options?.query || '',
      paperUrls: Array.isArray(result.papers) ? result.papers.map((paper) => paper.url).filter(Boolean).slice(0, 20) : [],
      updatedAt: Date.now(),
    };
  }
  return null;
}

function createAutomationArtifact(job, record) {
  const result = record?.result || {};
  if (record?.status === 'error') {
    return {
      type: 'automation-error',
      title: `${record.jobName || 'Automation'} error`,
      summary: buildFindingsSummary(result) || result.error || 'Automation failed.',
      content: String(result.error || buildFindingsSummary(result) || 'Automation failed.'),
      metadata: {
        jobId: record.jobId,
        status: record.status,
      },
    };
  }
  if (job?.type !== 'heartbeat') return null;
  return {
    type: `heartbeat:${job.heartbeatKind || 'automation'}`,
    title: record.jobName || 'Heartbeat artifact',
    summary: buildFindingsSummary(result),
    content: buildArtifactContent(job, result),
    metadata: {
      jobId: record.jobId,
      heartbeatKind: job.heartbeatKind || null,
      reviewIds: Array.isArray(record.reviewIds) ? [...record.reviewIds] : [],
      findingsCount: Array.isArray(result.findings) ? result.findings.length : 0,
      highlights: Array.isArray(result.highlights) ? result.highlights.slice(0, 6) : [],
    },
  };
}

function buildArtifactContent(job, result) {
  const lines = [];
  lines.push(`# ${job?.name || 'Automation artifact'}`);
  if (result?.summary) lines.push('', result.summary);
  if (Array.isArray(result?.highlights) && result.highlights.length) {
    lines.push('', '## Highlights');
    for (const item of result.highlights.slice(0, 8)) {
      lines.push(`- ${String(item || '').trim()}`);
    }
  }
  if (Array.isArray(result?.papers) && result.papers.length) {
    lines.push('', '## Papers');
    for (const paper of result.papers.slice(0, 8)) {
      lines.push(`- ${paper.title || paper.url || 'paper'}${paper.url ? ` — ${paper.url}` : ''}`);
    }
  }
  if (Array.isArray(result?.sources) && result.sources.length) {
    lines.push('', '## Sources');
    for (const source of result.sources.slice(0, 8)) {
      lines.push(`- ${source.title || source.url || source.source || 'source'}${source.url || source.source ? ` — ${source.url || source.source}` : ''}`);
    }
  }
  return lines.join('\n').trim() || buildFindingsSummary(result);
}

module.exports = AutomationScheduler;
