'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AutomationScheduler = require('../src/automations/automations');
const ApprovalQueue = require('../src/diff/approvalQueue');
const MemoryStore = require('../src/memory/memoryStore');
const { ArtifactStore } = require('../src/artifacts/artifactStore');
const { extractArxivId, summarizeChangedFiles } = require('../src/automations/heartbeatJobs');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-heartbeat-'));
  const dataDir = path.join(root, 'data');
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'openmc.log'), 'starting\nGeometry Error: bad surface\n', 'utf-8');
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Demo\n', 'utf-8');
  return { root, dataDir, projectRoot };
}

test('heartbeat log watchdog creates a review item and records memory when a match is found', async () => {
  const { root, dataDir, projectRoot } = makeWorkspace();
  const approvalQueue = new ApprovalQueue(dataDir);
  const memoryStore = new MemoryStore(path.join(dataDir, 'memory'));
  const artifactStore = new ArtifactStore(path.join(dataDir, 'artifacts'));
  const scheduler = new AutomationScheduler(path.join(dataDir, 'jobs'), { run: async () => ({ ok: true }) }, approvalQueue);
  scheduler.setMemoryStore(memoryStore);
  scheduler.setArtifactStore(artifactStore);

  try {
    const created = scheduler.createJob({
      name: 'Simulation watchdog',
      cronExpr: '*/30 * * * *',
      type: 'heartbeat',
      heartbeatKind: 'log-watchdog',
      options: {
        filePath: 'openmc.log',
        pattern: 'Geometry Error',
        label: 'Geometry Error',
      },
      projectRoot,
    });

    assert.equal(created.ok, true);
    const triggered = await scheduler.triggerNow(created.job.id);
    assert.equal(triggered.ok, true);

    const pending = approvalQueue.getPending();
    const review = pending.find((item) => item.type === 'review');
    assert.ok(review);
    assert.match(review.summary, /Geometry Error|finding/i);

    const memory = memoryStore.query('Geometry Error watchdog', { projectRoot });
    assert.match(memory, /Geometry Error|watchdog/i);
  } finally {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('heartbeat presets expose briefing, watchdog, and reflection jobs', () => {
  const { root, dataDir } = makeWorkspace();
  const scheduler = new AutomationScheduler(path.join(dataDir, 'jobs'), { run: async () => ({ ok: true }) }, null);

  try {
    const presets = scheduler.getHeartbeatPresets();
    assert.deepEqual(presets.map((preset) => preset.id), [
      'workspace-briefing',
      'log-watchdog',
      'scheduled-reflection',
      'weekly-coding-report',
      'deadline-reminder',
      'paper-tracker',
      'team-status-briefing',
    ]);
  } finally {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('heartbeat weekly coding report records memory and produces a reviewable report', async () => {
  const { root, dataDir, projectRoot } = makeWorkspace();
  const approvalQueue = new ApprovalQueue(dataDir);
  const memoryStore = new MemoryStore(path.join(dataDir, 'memory'));
  const artifactStore = new ArtifactStore(path.join(dataDir, 'artifacts'));
  const scheduler = new AutomationScheduler(path.join(dataDir, 'jobs'), { run: async () => ({ ok: true }) }, approvalQueue);
  scheduler.setMemoryStore(memoryStore);
  scheduler.setArtifactStore(artifactStore);

  try {
    const created = scheduler.createJob({
      name: 'Weekly coding report',
      cronExpr: '0 18 * * 0',
      type: 'heartbeat',
      heartbeatKind: 'weekly-coding-report',
      options: { days: 7 },
      projectRoot,
    });

    assert.equal(created.ok, true);
    await scheduler.triggerNow(created.job.id);

    const review = approvalQueue.getPending().find((item) => item.type === 'review');
    assert.ok(review);
    assert.match(review.summary, /weekly coding report/i);

    const memory = memoryStore.query('weekly coding report', { projectRoot });
    assert.match(memory, /weekly coding report/i);
    const notification = scheduler.listNotifications(1)[0];
    assert.ok(notification.artifactId);
    assert.match(artifactStore.get(notification.artifactId).content, /Weekly coding report/i);
  } finally {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('heartbeat deadline reminder surfaces an approaching due date', async () => {
  const { root, dataDir, projectRoot } = makeWorkspace();
  const approvalQueue = new ApprovalQueue(dataDir);
  const memoryStore = new MemoryStore(path.join(dataDir, 'memory'));
  const scheduler = new AutomationScheduler(path.join(dataDir, 'jobs'), { run: async () => ({ ok: true }) }, approvalQueue);
  scheduler.setMemoryStore(memoryStore);

  try {
    const dueSoon = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const created = scheduler.createJob({
      name: 'Deadline reminder',
      cronExpr: '0 9 * * *',
      type: 'heartbeat',
      heartbeatKind: 'deadline-reminder',
      options: {
        label: 'NUS IRIS application',
        deadline: dueSoon,
        warnDays: 7,
      },
      projectRoot,
    });

    assert.equal(created.ok, true);
    await scheduler.triggerNow(created.job.id);

    const review = approvalQueue.getPending().find((item) => item.type === 'review');
    assert.ok(review);
    assert.match(review.summary, /NUS IRIS|due in|overdue|deadline/i);

    const memory = memoryStore.query('NUS IRIS deadline', { projectRoot });
    assert.match(memory, /NUS IRIS|deadline/i);
  } finally {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('heartbeat paper tracker records memory and produces a reviewable paper briefing', async () => {
  const { root, dataDir, projectRoot } = makeWorkspace();
  const approvalQueue = new ApprovalQueue(dataDir);
  const memoryStore = new MemoryStore(path.join(dataDir, 'memory'));
  const scheduler = new AutomationScheduler(path.join(dataDir, 'jobs'), { run: async () => ({ ok: true }) }, approvalQueue);
  scheduler.setMemoryStore(memoryStore);
  scheduler.setWebClient({
    async search(query, { limit }) {
      assert.equal(query, 'Small Modular Reactors');
      assert.equal(limit, 2);
      return {
        ok: true,
        query,
        results: [
          {
            title: 'A new SMR optimization study',
            url: 'https://arxiv.org/abs/1234.5678',
            domain: 'arxiv.org',
          },
          {
            title: 'Safety margins in modular reactor design',
            url: 'https://arxiv.org/abs/9999.0001',
            domain: 'arxiv.org',
          },
        ],
      };
    },
    async open(url) {
      return {
        ok: true,
        url,
        excerpt: url.includes('1234.5678')
          ? 'Optimization study abstract.'
          : 'Safety-margin abstract.',
      };
    },
  });

  try {
    const created = scheduler.createJob({
      name: 'Paper tracker',
      cronExpr: '0 8 * * *',
      type: 'heartbeat',
      heartbeatKind: 'paper-tracker',
      options: {
        query: 'Small Modular Reactors',
        limit: 2,
      },
      projectRoot,
    });

    assert.equal(created.ok, true);
    await scheduler.triggerNow(created.job.id);

    const review = approvalQueue.getPending().find((item) => item.type === 'review');
    assert.ok(review);
    assert.match(review.summary, /paper tracker|arxiv/i);
    assert.equal(review.evidenceBundle?.byCategory?.web > 0, true);

    const memory = memoryStore.query('Small Modular Reactors paper tracker', { projectRoot });
    assert.match(memory, /SMR optimization|1234\.5678|paper tracker|arxiv/i);
  } finally {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('heartbeat paper tracker highlights new papers relative to the previous run', async () => {
  const { root, dataDir, projectRoot } = makeWorkspace();
  const approvalQueue = new ApprovalQueue(dataDir);
  const memoryStore = new MemoryStore(path.join(dataDir, 'memory'));
  const scheduler = new AutomationScheduler(path.join(dataDir, 'jobs'), { run: async () => ({ ok: true }) }, approvalQueue);
  scheduler.setMemoryStore(memoryStore);
  let runCount = 0;
  scheduler.setWebClient({
    async search() {
      runCount += 1;
      if (runCount === 1) {
        return {
          ok: true,
          results: [
            { title: 'Known paper', url: 'https://arxiv.org/abs/1111.1111', domain: 'arxiv.org' },
          ],
        };
      }
      return {
        ok: true,
        results: [
          { title: 'Known paper', url: 'https://arxiv.org/abs/1111.1111', domain: 'arxiv.org' },
          { title: 'Fresh paper', url: 'https://arxiv.org/abs/2222.2222', domain: 'arxiv.org' },
        ],
      };
    },
    async open(url) {
      return { ok: true, url, excerpt: url.includes('2222.2222') ? 'Fresh abstract.' : 'Known abstract.' };
    },
  });

  try {
    const created = scheduler.createJob({
      name: 'Paper tracker',
      cronExpr: '0 8 * * *',
      type: 'heartbeat',
      heartbeatKind: 'paper-tracker',
      options: { query: 'Small Modular Reactors', limit: 3 },
      projectRoot,
    });
    assert.equal(created.ok, true);

    await scheduler.triggerNow(created.job.id);
    await scheduler.triggerNow(created.job.id);

    const results = scheduler.listResults(2);
    assert.equal(results[0].result.newPapersCount, 1);
    assert.match(results[0].result.summary, /new since the last run/i);
    assert.equal(results[0].result.papers.some((paper) => paper.title === 'Fresh paper' && paper.isNew), true);
  } finally {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extractArxivId parses abs and pdf arXiv links', () => {
  assert.equal(extractArxivId('https://arxiv.org/abs/1234.5678'), '1234.5678');
  assert.equal(extractArxivId('https://arxiv.org/pdf/9999.0001.pdf'), '9999.0001');
  assert.equal(extractArxivId('https://example.com/paper'), '');
});

test('summarizeChangedFiles ranks frequently touched files first', () => {
  const summary = summarizeChangedFiles([
    'src/a.js',
    '',
    'src/b.js',
    'src/a.js',
    'README.md',
    'src/a.js',
    'src/b.js',
  ].join('\n'));
  assert.deepEqual(summary.slice(0, 3), [
    { file: 'src/a.js', count: 3 },
    { file: 'src/b.js', count: 2 },
    { file: 'README.md', count: 1 },
  ]);
});

test('heartbeat jobs create ackable inbox notifications', async () => {
  const { root, dataDir, projectRoot } = makeWorkspace();
  const approvalQueue = new ApprovalQueue(dataDir);
  const memoryStore = new MemoryStore(path.join(dataDir, 'memory'));
  const scheduler = new AutomationScheduler(path.join(dataDir, 'jobs'), { run: async () => ({ ok: true }) }, approvalQueue);
  scheduler.setMemoryStore(memoryStore);

  try {
    const created = scheduler.createJob({
      name: 'Simulation watchdog',
      cronExpr: '*/30 * * * *',
      type: 'heartbeat',
      heartbeatKind: 'log-watchdog',
      options: {
        filePath: 'openmc.log',
        pattern: 'Geometry Error',
        label: 'Geometry Error',
      },
      projectRoot,
    });
    assert.equal(created.ok, true);
    await scheduler.triggerNow(created.job.id);

    const notifications = scheduler.listNotifications();
    assert.equal(notifications.length > 0, true);
    assert.equal(notifications[0].jobName, 'Simulation watchdog');
    assert.equal(notifications[0].acknowledgedAt, null);

    const acked = scheduler.acknowledgeNotification(notifications[0].id);
    assert.equal(acked.ok, true);
    assert.equal(typeof acked.notification.acknowledgedAt, 'number');
  } finally {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('heartbeat notifications keep sources and can be promoted to memory', async () => {
  const { root, dataDir, projectRoot } = makeWorkspace();
  const approvalQueue = new ApprovalQueue(dataDir);
  const memoryStore = new MemoryStore(path.join(dataDir, 'memory'));
  const scheduler = new AutomationScheduler(path.join(dataDir, 'jobs'), { run: async () => ({ ok: true }) }, approvalQueue);
  scheduler.setMemoryStore(memoryStore);
  scheduler.setWebClient({
    async search() {
      return {
        ok: true,
        results: [
          { title: 'Fresh paper', url: 'https://arxiv.org/abs/2222.2222', domain: 'arxiv.org' },
        ],
      };
    },
    async open(url) {
      return { ok: true, url, excerpt: 'Fresh abstract.' };
    },
  });

  try {
    const created = scheduler.createJob({
      name: 'Paper tracker',
      cronExpr: '0 8 * * *',
      type: 'heartbeat',
      heartbeatKind: 'paper-tracker',
      options: { query: 'Small Modular Reactors', limit: 1 },
      projectRoot,
    });
    assert.equal(created.ok, true);
    await scheduler.triggerNow(created.job.id);

    const notifications = scheduler.listNotifications();
    assert.equal(notifications.length > 0, true);
    assert.equal(notifications[0].sources.length, 1);
    assert.match(notifications[0].sources[0].url, /arxiv\.org/);

    const promoted = scheduler.promoteNotificationToMemory(notifications[0].id);
    assert.equal(promoted.ok, true);
    assert.equal(typeof promoted.notification.promotedToMemoryAt, 'number');

    const memory = memoryStore.query('Fresh paper arxiv', { projectRoot });
    assert.match(memory, /Fresh paper|arxiv\.org/);
  } finally {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('team status briefing creates a reviewable report with highlights', async () => {
  const { root, dataDir, projectRoot } = makeWorkspace();
  const approvalQueue = new ApprovalQueue(dataDir);
  const memoryStore = new MemoryStore(path.join(dataDir, 'memory'));
  const scheduler = new AutomationScheduler(path.join(dataDir, 'jobs'), { run: async () => ({ ok: true }) }, approvalQueue);
  scheduler.setMemoryStore(memoryStore);

  try {
    const created = scheduler.createJob({
      name: 'Team status briefing',
      cronExpr: '0 10 * * 1-5',
      type: 'heartbeat',
      heartbeatKind: 'team-status-briefing',
      options: { days: 3 },
      projectRoot,
    });
    assert.equal(created.ok, true);
    await scheduler.triggerNow(created.job.id);

    const review = approvalQueue.getPending().find((item) => item.type === 'review');
    assert.ok(review);
    assert.match(review.summary, /team status briefing/i);

    const notification = scheduler.listNotifications()[0];
    assert.equal(notification.heartbeatKind, 'team-status-briefing');
    assert.equal(Array.isArray(notification.highlights), true);

    const memory = memoryStore.query('team status briefing', { projectRoot });
    assert.match(memory, /team status briefing/i);
  } finally {
    scheduler.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
