'use strict';

function buildCompanionFeed({
  notifications = [],
  artifacts = [],
  pendingChanges = [],
  recentTurns = [],
  jobs = [],
  limit = 30,
} = {}) {
  const items = [
    ...buildNotificationItems(notifications),
    ...buildArtifactItems(artifacts),
    ...buildApprovalItems(pendingChanges),
    ...buildTurnItems(recentTurns),
    ...buildJobItems(jobs),
  ]
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, Math.max(1, Number(limit) || 30));

  return {
    summary: {
      unreadNotifications: notifications.filter((item) => !item.acknowledgedAt).length,
      pendingApprovals: pendingChanges.length,
      recentArtifacts: artifacts.length,
      scheduledJobs: jobs.length,
    },
    items,
  };
}

function buildNotificationItems(notifications = []) {
  return (Array.isArray(notifications) ? notifications : []).map((item) => ({
    id: `notification:${item.id}`,
    kind: 'notification',
    title: item.jobName || 'Heartbeat update',
    summary: item.summary || 'Heartbeat activity detected.',
    createdAt: item.createdAt || Date.now(),
    priority: item.acknowledgedAt ? 'normal' : 'high',
    action: item.reviewIds?.[0]
      ? { type: 'review', id: item.reviewIds[0] }
      : item.artifactId
        ? { type: 'artifact', id: item.artifactId }
        : null,
    actor: item.createdBy || null,
    tags: [item.heartbeatKind || 'heartbeat', item.status || 'success', actorLabel(item.createdBy)].filter(Boolean),
  }));
}

function buildArtifactItems(artifacts = []) {
  return (Array.isArray(artifacts) ? artifacts : []).map((artifact) => ({
    id: `artifact:${artifact.id}`,
    kind: 'artifact',
    title: artifact.title || 'Artifact',
    summary: artifact.summary || artifact.type || 'Saved artifact',
    createdAt: artifact.createdAt || Date.now(),
    priority: artifact.type === 'automation-error' ? 'high' : 'normal',
    action: { type: 'artifact', id: artifact.id },
    actor: artifact.createdBy || null,
    tags: [artifact.type || 'artifact', actorLabel(artifact.createdBy)].filter(Boolean),
  }));
}

function buildApprovalItems(pendingChanges = []) {
  return (Array.isArray(pendingChanges) ? pendingChanges : []).slice(0, 12).map((change) => ({
    id: `approval:${change.id}`,
    kind: 'approval',
    title: change.type === 'review'
      ? (change.jobName || 'Pending review')
      : (change.filePath || 'Pending change'),
    summary: change.description || change.summary || 'Approval required.',
    createdAt: change.proposedAt || Date.now(),
    priority: change.status === 'conflict' ? 'high' : 'normal',
    action: { type: 'approval', id: change.id },
    actor: change.proposedBy || change.resolvedBy || null,
    tags: [change.type || 'change', change.status || 'pending', actorLabel(change.proposedBy || change.resolvedBy)].filter(Boolean),
  }));
}

function buildTurnItems(recentTurns = []) {
  return (Array.isArray(recentTurns) ? recentTurns : []).slice(0, 8).map((turn) => ({
    id: `turn:${turn.id}`,
    kind: 'turn',
    title: turn.meta?.userText ? trimText(turn.meta.userText, 72) : 'Recent turn',
    summary: [
      turn.plan?.phase ? `phase=${turn.plan.phase}` : '',
      turn.governor?.evidenceStatus ? `evidence=${turn.governor.evidenceStatus}` : '',
      turn.final?.artifactId ? `artifact=${turn.final.artifactId}` : '',
    ].filter(Boolean).join(' · ') || 'Recent orchestration activity.',
    createdAt: turn.updatedAt || turn.createdAt || Date.now(),
    priority: turn.governor?.shouldPauseForApproval ? 'high' : 'normal',
    action: turn.final?.artifactId ? { type: 'artifact', id: turn.final.artifactId } : null,
    actor: turn.meta?.actor || null,
    tags: [turn.meta?.intent || 'turn', turn.meta?.profile || 'deliberate', actorLabel(turn.meta?.actor)].filter(Boolean),
  }));
}

function buildJobItems(jobs = []) {
  return (Array.isArray(jobs) ? jobs : []).slice(0, 8).map((job) => ({
    id: `job:${job.id}`,
    kind: 'job',
    title: job.name || 'Automation job',
    summary: `${job.type}${job.heartbeatKind ? `:${job.heartbeatKind}` : ''} · ${job.enabled ? 'enabled' : 'disabled'} · last ${job.lastRun ? timeAgoText(job.lastRun) : 'never run'}`,
    createdAt: job.lastRun || job.createdAt || Date.now(),
    priority: job.enabled ? 'normal' : 'low',
    action: { type: 'job', id: job.id },
    tags: [job.type || 'job', job.heartbeatKind || 'automation'].filter(Boolean),
  }));
}

function actorLabel(actor) {
  if (!actor || typeof actor !== 'object') return '';
  return actor.displayName || actor.username || '';
}

function trimText(text = '', max = 72) {
  const value = String(text || '').trim();
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function timeAgoText(ts) {
  const delta = Math.max(0, Date.now() - Number(ts || 0));
  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

module.exports = {
  buildCompanionFeed,
};
