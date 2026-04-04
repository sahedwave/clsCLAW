'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCompanionFeed } = require('../src/remote/companionFeed');

test('companion feed merges notifications, approvals, artifacts, turns, and jobs', () => {
  const feed = buildCompanionFeed({
    notifications: [{ id: 'n1', jobName: 'Paper tracker', summary: '2 new papers', createdAt: 1000, acknowledgedAt: null, reviewIds: ['review-1'] }],
    artifacts: [{ id: 'a1', title: 'Weekly coding report', summary: 'Hot files', createdAt: 900, type: 'heartbeat:weekly-coding-report' }],
    pendingChanges: [{ id: 'c1', type: 'review', jobName: 'Review bundle', summary: 'Needs acknowledgment', proposedAt: 800, status: 'pending' }],
    recentTurns: [{ id: 't1', meta: { userText: 'Investigate auth bug', intent: 'build', profile: 'execute' }, plan: { phase: 'verify' }, governor: { evidenceStatus: 'grounded', shouldPauseForApproval: false }, final: { artifactId: 'a1' }, updatedAt: 700 }],
    jobs: [{ id: 'j1', name: 'Workspace briefing', type: 'heartbeat', heartbeatKind: 'workspace-briefing', enabled: true, createdAt: 600, lastRun: 500 }],
    limit: 10,
  });

  assert.equal(feed.summary.unreadNotifications, 1);
  assert.equal(feed.summary.pendingApprovals, 1);
  assert.equal(feed.items.length, 5);
  assert.equal(feed.items[0].kind, 'notification');
  assert.ok(feed.items.some((item) => item.kind === 'artifact'));
  assert.ok(feed.items.some((item) => item.kind === 'approval'));
  assert.ok(feed.items.some((item) => item.kind === 'turn'));
  assert.ok(feed.items.some((item) => item.kind === 'job'));
});
