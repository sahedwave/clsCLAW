'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function runHeartbeatJob(job, { projectRoot, memoryStore = null, approvalQueue = null, webClient = null, previousState = null } = {}) {
  const kind = String(job?.heartbeatKind || '').trim();
  if (!kind) {
    return { error: 'heartbeatKind is required for heartbeat jobs' };
  }

  if (kind === 'workspace-briefing') {
    return runWorkspaceBriefing(job, { projectRoot, memoryStore, approvalQueue });
  }
  if (kind === 'log-watchdog') {
    return runLogWatchdog(job, { projectRoot, memoryStore });
  }
  if (kind === 'scheduled-reflection') {
    return runScheduledReflection(job, { projectRoot, memoryStore });
  }
  if (kind === 'weekly-coding-report') {
    return runWeeklyCodingReport(job, { projectRoot, memoryStore });
  }
  if (kind === 'deadline-reminder') {
    return runDeadlineReminder(job, { projectRoot, memoryStore });
  }
  if (kind === 'paper-tracker') {
    return runPaperTracker(job, { projectRoot, memoryStore, webClient, previousState });
  }
  if (kind === 'team-status-briefing') {
    return runTeamStatusBriefing(job, { projectRoot, memoryStore, approvalQueue });
  }

  return { error: `Unsupported heartbeat job kind: ${kind}` };
}

async function runWorkspaceBriefing(job, { projectRoot, memoryStore = null, approvalQueue = null } = {}) {
  const maxCommits = clampInt(job?.options?.maxCommits, 5, 1, 20);
  const commits = await readRecentCommits(projectRoot, maxCommits);
  const dirty = await readGitDirty(projectRoot);
  const pendingChanges = approvalQueue?.getPending ? approvalQueue.getPending() : [];
  const pendingReviews = pendingChanges.filter((item) => item.type === 'review').length;
  const pendingFileChanges = pendingChanges.filter((item) => item.type !== 'review').length;

  const commitSummary = commits.length
    ? commits.map((entry) => `- ${entry.hash} ${entry.subject} (${entry.author})`).join('\n')
    : '- No recent commits found';
  const dirtySummary = dirty || 'clean working tree';
  const summary = `Workspace briefing: ${commits.length} recent commit(s), ${pendingFileChanges} pending change(s), ${pendingReviews} pending review(s), ${dirtySummary}.`;

  if (memoryStore?.recordAutomationNote) {
    memoryStore.recordAutomationNote({
      title: job.name || 'Workspace briefing',
      note: summary,
      projectRoot,
      tags: ['heartbeat', 'briefing', 'git'],
    });
  }

  return {
    skill: 'heartbeat-workspace-briefing',
    heartbeatKind: 'workspace-briefing',
    summary,
    findings: pendingFileChanges + pendingReviews > 0 ? [
      {
        file: 'workspace',
        issue: 'Outstanding pending work requires review',
        detail: `${pendingFileChanges} file change(s) and ${pendingReviews} review item(s) are still pending approval.`,
      },
    ] : [],
    report: [
      '# Workspace Briefing',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      `Summary: ${summary}`,
      '',
      '## Recent commits',
      commitSummary,
      '',
      '## Working tree',
      dirtySummary,
    ].join('\n'),
    commits,
  };
}

async function runLogWatchdog(job, { projectRoot, memoryStore = null } = {}) {
  const relativePath = String(job?.options?.filePath || '').trim();
  const patternText = String(job?.options?.pattern || 'geometry error').trim();
  const label = String(job?.options?.label || patternText).trim();
  if (!relativePath) {
    return { error: 'Heartbeat log-watchdog requires options.filePath' };
  }

  const absolutePath = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(projectRoot, relativePath);
  if (!absolutePath.startsWith(path.resolve(projectRoot))) {
    return { error: 'Watchdog file must stay inside the project root' };
  }
  if (!fs.existsSync(absolutePath)) {
    return {
      heartbeatKind: 'log-watchdog',
      summary: `Watchdog checked ${relativePath} but the file does not exist yet.`,
      findings: [],
      watchedFile: relativePath,
    };
  }

  const regex = safeRegex(patternText);
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const lines = content.split('\n');
  const matches = [];
  for (let index = 0; index < lines.length; index++) {
    if (regex.test(lines[index])) {
      matches.push({ line: index + 1, text: lines[index].trim().slice(0, 240) });
      if (matches.length >= 5) break;
    }
    regex.lastIndex = 0;
  }

  const findings = matches.map((match) => ({
    file: path.relative(projectRoot, absolutePath),
    issue: label,
    lines: [match.line],
    detail: match.text,
  }));
  const summary = matches.length
    ? `Watchdog found ${matches.length} "${label}" match(es) in ${path.relative(projectRoot, absolutePath)}.`
    : `Watchdog checked ${path.relative(projectRoot, absolutePath)} and found no "${label}" matches.`;

  if (matches.length && memoryStore?.recordAutomationNote) {
    memoryStore.recordAutomationNote({
      title: `Watchdog alert: ${label}`,
      note: summary,
      projectRoot,
      tags: ['heartbeat', 'watchdog', label],
    });
  }

  return {
    skill: 'heartbeat-log-watchdog',
    heartbeatKind: 'log-watchdog',
    summary,
    findings,
    watchedFile: path.relative(projectRoot, absolutePath),
    matches,
  };
}

async function runScheduledReflection(job, { projectRoot, memoryStore = null } = {}) {
  const prompt = String(job?.options?.prompt || 'What did we achieve today, and what should happen next?').trim();
  const summary = 'Scheduled reflection is ready.';
  if (memoryStore?.recordAutomationNote) {
    memoryStore.recordAutomationNote({
      title: job.name || 'Scheduled reflection',
      note: prompt,
      projectRoot,
      tags: ['heartbeat', 'reflection'],
    });
  }

  return {
    skill: 'heartbeat-scheduled-reflection',
    heartbeatKind: 'scheduled-reflection',
    summary,
    findings: [
      {
        file: 'workspace',
        issue: 'Reflection prompt',
        detail: prompt,
      },
    ],
    prompt,
  };
}

async function runWeeklyCodingReport(job, { projectRoot, memoryStore = null } = {}) {
  const days = clampInt(job?.options?.days, 7, 1, 30);
  const commits = await readCommitsSince(projectRoot, `${days}.days`);
  const authors = summarizeAuthors(commits);
  const changedFiles = await readChangedFilesSince(projectRoot, `${days}.days`);
  const summary = commits.length
    ? `Weekly coding report: ${commits.length} commit(s) in the last ${days} day(s) by ${authors.length || 0} contributor(s).`
    : `Weekly coding report: no commits found in the last ${days} day(s).`;
  const report = [
    '# Weekly Coding Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Window: last ${days} day(s)`,
    '',
    `Summary: ${summary}`,
    '',
    '## Contributors',
    authors.length
      ? authors.map((entry) => `- ${entry.author}: ${entry.count} commit(s)`).join('\n')
      : '- No recent contributors',
    '',
    '## Hot files',
    changedFiles.length
      ? changedFiles.slice(0, 5).map((entry) => `- ${entry.file}: ${entry.count} touch(es)`).join('\n')
      : '- No changed files detected',
    '',
    '## Recent commits',
    commits.length
      ? commits.map((entry) => `- ${entry.hash} ${entry.subject} (${entry.author})`).join('\n')
      : '- No recent commits',
  ].join('\n');

  if (memoryStore?.recordAutomationNote) {
    memoryStore.recordAutomationNote({
      title: job.name || 'Weekly coding report',
      note: [
        summary,
        '',
        changedFiles.length
          ? `Hot files: ${changedFiles.slice(0, 3).map((entry) => `${entry.file} (${entry.count})`).join(', ')}`
          : 'Hot files: none detected',
      ].join('\n'),
      projectRoot,
      tags: ['heartbeat', 'weekly-report', 'git'],
    });
  }

  return {
    skill: 'heartbeat-weekly-coding-report',
    heartbeatKind: 'weekly-coding-report',
    summary,
    findings: [
      {
        file: 'workspace',
        issue: 'Weekly coding report ready',
        detail: summary,
      },
    ],
    report,
    commits,
    authors,
    changedFiles,
  };
}

async function runDeadlineReminder(job, { projectRoot, memoryStore = null } = {}) {
  const label = String(job?.options?.label || job?.name || 'Upcoming deadline').trim();
  const deadlineRaw = String(job?.options?.deadline || '').trim();
  const warnDays = clampInt(job?.options?.warnDays, 7, 0, 60);
  const deadline = parseDate(deadlineRaw);
  if (!deadline) {
    return { error: 'Heartbeat deadline-reminder requires a valid options.deadline value' };
  }

  const msRemaining = deadline.getTime() - Date.now();
  const daysRemaining = Math.ceil(msRemaining / 86400000);
  const dueSoon = daysRemaining <= warnDays;
  const overdue = msRemaining < 0;
  const summary = overdue
    ? `${label} is overdue by ${Math.abs(daysRemaining)} day(s).`
    : `${label} is due in ${daysRemaining} day(s) on ${deadline.toISOString().slice(0, 10)}.`;

  if ((dueSoon || overdue) && memoryStore?.recordAutomationNote) {
    memoryStore.recordAutomationNote({
      title: `Deadline reminder: ${label}`,
      note: summary,
      projectRoot,
      tags: ['heartbeat', 'deadline', label],
    });
  }

  return {
    skill: 'heartbeat-deadline-reminder',
    heartbeatKind: 'deadline-reminder',
    summary,
    findings: dueSoon || overdue ? [
      {
        file: 'workspace',
        issue: overdue ? 'Deadline overdue' : 'Deadline approaching',
        detail: summary,
      },
    ] : [],
    deadline: deadline.toISOString(),
    daysRemaining,
    dueSoon,
    overdue,
  };
}

async function runPaperTracker(job, { projectRoot, memoryStore = null, webClient = null, previousState = null } = {}) {
  if (!webClient || typeof webClient.search !== 'function') {
    return { error: 'Heartbeat paper-tracker requires a web client' };
  }

  const query = String(job?.options?.query || 'Small Modular Reactors').trim();
  const limit = clampInt(job?.options?.limit, 3, 1, 5);
  const search = await webClient.search(query, {
    limit,
    domains: ['arxiv.org'],
  });
  const results = Array.isArray(search?.results) ? search.results.slice(0, limit) : [];

  const papers = [];
  const previousUrls = new Set(Array.isArray(previousState?.paperUrls) ? previousState.paperUrls : []);
  for (const result of results) {
    let excerpt = '';
    if (typeof webClient.open === 'function') {
      try {
        const page = await webClient.open(result.url);
        excerpt = String(page?.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 320);
      } catch {}
    }
    papers.push({
      title: result.title,
      url: result.url,
      domain: result.domain || 'arxiv.org',
      arxivId: extractArxivId(result.url),
      excerpt,
      isNew: !previousUrls.has(result.url),
    });
  }

  const newPapers = papers.filter((paper) => paper.isNew);
  const summary = papers.length
    ? `Paper tracker found ${papers.length} arXiv result(s) for "${query}"${newPapers.length ? `, including ${newPapers.length} new since the last run` : ''}.`
    : `Paper tracker found no arXiv results for "${query}".`;
  const report = [
    '# Paper Tracker',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Query: ${query}`,
    '',
    `Summary: ${summary}`,
    '',
    '## Results',
    papers.length
      ? papers.map((paper, index) => [
        `${index + 1}. ${paper.title}${paper.arxivId ? ` (${paper.arxivId})` : ''}${paper.isNew ? ' [new]' : ''}`,
        `   URL: ${paper.url}`,
        paper.excerpt ? `   Notes: ${paper.excerpt}` : '',
      ].filter(Boolean).join('\n')).join('\n')
      : '- No matching papers found',
  ].join('\n');

  if (papers.length && memoryStore?.recordAutomationNote) {
    const highlighted = (newPapers.length ? newPapers : papers).slice(0, 3);
    memoryStore.recordAutomationNote({
      title: job.name || 'Paper tracker',
      note: [
        summary,
        '',
        ...highlighted.map((paper, index) => `${index + 1}. ${paper.title}${paper.arxivId ? ` (${paper.arxivId})` : ''}${paper.isNew ? ' [new]' : ''} — ${paper.url}`),
      ].join('\n'),
      projectRoot,
      tags: ['heartbeat', 'papers', 'arxiv', query],
    });
  }

  return {
    skill: 'heartbeat-paper-tracker',
    heartbeatKind: 'paper-tracker',
    summary,
    findings: papers.map((paper) => ({
      file: 'web:arxiv',
      issue: paper.title,
      detail: [paper.arxivId ? `Source: ${paper.arxivId}` : '', paper.excerpt || paper.url].filter(Boolean).join(' — '),
    })),
    sources: papers.map((paper) => ({
      type: 'web',
      source: paper.url,
      title: paper.title,
      url: paper.url,
      snippet: `${paper.isNew ? '[new] ' : ''}${paper.excerpt || paper.url}`,
      meta: paper.arxivId ? { arxivId: paper.arxivId } : undefined,
    })),
    highlights: (newPapers.length ? newPapers : papers).slice(0, 3).map((paper) =>
      `${paper.title}${paper.arxivId ? ` (${paper.arxivId})` : ''}${paper.isNew ? ' [new]' : ''}`
    ),
    report,
    query,
    papers,
    newPapersCount: newPapers.length,
  };
}

async function runTeamStatusBriefing(job, { projectRoot, memoryStore = null, approvalQueue = null } = {}) {
  const days = clampInt(job?.options?.days, 3, 1, 14);
  const commits = await readCommitsSince(projectRoot, `${days}.days`);
  const authors = summarizeAuthors(commits);
  const changedFiles = await readChangedFilesSince(projectRoot, `${days}.days`);
  const pendingItems = approvalQueue?.getPending ? approvalQueue.getPending() : [];
  const pendingReviews = pendingItems.filter((item) => item.type === 'review').length;
  const pendingChanges = pendingItems.filter((item) => item.type !== 'review').length;
  const summary = commits.length
    ? `Team status briefing: ${commits.length} commit(s) across ${authors.length} contributor(s) in the last ${days} day(s), with ${pendingChanges} pending change(s) and ${pendingReviews} pending review(s).`
    : `Team status briefing: no recent commits in the last ${days} day(s), with ${pendingChanges} pending change(s) and ${pendingReviews} pending review(s).`;
  const highlights = [];
  if (authors.length) {
    highlights.push(`Top contributor: ${authors[0].author} (${authors[0].count})`);
  }
  if (changedFiles.length) {
    highlights.push(`Hot file: ${changedFiles[0].file} (${changedFiles[0].count})`);
  }
  if (pendingReviews || pendingChanges) {
    highlights.push(`Queue: ${pendingChanges} change(s), ${pendingReviews} review(s)`);
  }
  const report = [
    '# Team Status Briefing',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Window: last ${days} day(s)`,
    '',
    `Summary: ${summary}`,
    '',
    '## Contributors',
    authors.length
      ? authors.map((entry) => `- ${entry.author}: ${entry.count} commit(s)`).join('\n')
      : '- No recent contributors',
    '',
    '## Hot files',
    changedFiles.length
      ? changedFiles.slice(0, 5).map((entry) => `- ${entry.file}: ${entry.count} touch(es)`).join('\n')
      : '- No changed files detected',
    '',
    '## Pending queue',
    `- Changes: ${pendingChanges}`,
    `- Reviews: ${pendingReviews}`,
  ].join('\n');

  if (memoryStore?.recordAutomationNote) {
    memoryStore.recordAutomationNote({
      title: job.name || 'Team status briefing',
      note: [
        summary,
        '',
        ...highlights,
      ].join('\n'),
      projectRoot,
      tags: ['heartbeat', 'team-status', 'git'],
    });
  }

  return {
    skill: 'heartbeat-team-status-briefing',
    heartbeatKind: 'team-status-briefing',
    summary,
    findings: [
      {
        file: 'workspace',
        issue: 'Team status briefing ready',
        detail: summary,
      },
    ],
    highlights,
    report,
    authors,
    changedFiles,
    commits,
    pendingChanges,
    pendingReviews,
  };
}

async function readRecentCommits(projectRoot, maxCommits) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, 'log', `-${maxCommits}`, '--pretty=format:%h%x09%an%x09%s'], {
      timeout: 5000,
    });
    return parseCommitLines(stdout);
  } catch {
    return [];
  }
}

async function readCommitsSince(projectRoot, since) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, 'log', `--since=${since}`, '--pretty=format:%h%x09%an%x09%s'], {
      timeout: 5000,
    });
    return parseCommitLines(stdout);
  } catch {
    return [];
  }
}

async function readChangedFilesSince(projectRoot, since) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, 'log', `--since=${since}`, '--name-only', '--pretty=format:'], {
      timeout: 5000,
    });
    return summarizeChangedFiles(stdout);
  } catch {
    return [];
  }
}

async function readGitDirty(projectRoot) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, 'status', '--short'], {
      timeout: 5000,
    });
    const lines = String(stdout || '').split('\n').filter(Boolean);
    if (!lines.length) return 'clean working tree';
    return `${lines.length} uncommitted file(s)`;
  } catch {
    return 'git status unavailable';
  }
}

function parseCommitLines(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, author, subject] = line.split('\t');
      return { hash, author, subject };
    });
}

function summarizeAuthors(commits = []) {
  const counts = new Map();
  for (const commit of commits) {
    const author = String(commit?.author || 'unknown').trim() || 'unknown';
    counts.set(author, (counts.get(author) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count || a.author.localeCompare(b.author));
}

function summarizeChangedFiles(stdout) {
  const counts = new Map();
  for (const line of String(stdout || '').split('\n').map((value) => value.trim()).filter(Boolean)) {
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

function extractArxivId(url) {
  const text = String(url || '');
  const match = text.match(/arxiv\.org\/(?:abs|pdf)\/([^/?#]+)/i);
  return match ? match[1].replace(/\.pdf$/i, '') : '';
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return new RegExp(escapeRegExp(pattern), 'i');
  }
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

module.exports = {
  runHeartbeatJob,
  extractArxivId,
  summarizeChangedFiles,
};
