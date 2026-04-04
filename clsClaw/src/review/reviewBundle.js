'use strict';

const { buildVisualDebugWorkflow } = require('../multimodal/visualDebugWorkflow');

function buildReviewBundle({
  summary = '',
  result = {},
  inlineComments = [],
  evidenceBundle = null,
  approvalContext = null,
  githubReview = null,
} = {}) {
  const generalFindings = Array.isArray(result?.generalFindings) ? result.generalFindings : [];
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const comments = Array.isArray(inlineComments) ? inlineComments : [];
  const affectedFiles = collectAffectedFiles({ generalFindings, findings, inlineComments: comments });
  const anchorCounts = summarizeAnchors(comments);
  const findingsTotal = generalFindings.length + findings.length;
  const verificationNotes = collectVerificationNotes({ result, approvalContext, evidenceBundle, comments });
  const vulnCount = computeVulnerabilityCount(result?.npmAudit?.vulnerabilities);
  const topExternalSources = collectExternalSources(result, evidenceBundle);
  const topVisualEvidence = collectVisualEvidence(result, evidenceBundle);
  const groundingHighlights = collectGroundingHighlights(evidenceBundle, topExternalSources, topVisualEvidence);
  const sourceReferences = buildSourceReferences({ affectedFiles, topExternalSources, topVisualEvidence, evidenceBundle });
  const visualDebug = buildVisualDebugWorkflow({
    result,
    evidenceBundle,
    affectedFiles,
    approvalContext,
  });

  return {
    summary: String(summary || 'Review ready').trim() || 'Review ready',
    counts: {
      inlineComments: comments.length,
      exactAnchors: anchorCounts.exact,
      shiftedAnchors: anchorCounts.shifted,
      staleAnchors: anchorCounts.stale,
      missingFiles: anchorCounts.missing_file,
      findings: findingsTotal,
      generalFindings: generalFindings.length,
      lineLinkedFindings: findings.length,
      affectedFiles: affectedFiles.length,
      vulnerabilities: vulnCount,
      evidenceSources: Number(evidenceBundle?.sources?.length || 0),
      externalSources: topExternalSources.length,
    },
    affectedFiles,
    evidence: {
      summary: evidenceBundle?.summary || 'No evidence yet.',
      sourceCount: Number(evidenceBundle?.sources?.length || 0),
      categories: { ...(evidenceBundle?.byCategory || {}) },
      groundingHighlights,
      topExternalSources,
      topVisualEvidence,
      sourceReferences,
    },
    github: {
      synced: Boolean(githubReview),
      status: githubReview?.state || (comments.length > 0 ? 'ready_to_export' : 'local_only'),
      owner: githubReview?.owner || null,
      repo: githubReview?.repo || null,
      pullNumber: githubReview?.pullNumber || null,
      commentCount: Number(githubReview?.commentCount || 0),
      url: githubReview?.url || null,
    },
    approval: approvalContext ? {
      kind: approvalContext.kind || null,
      risk: approvalContext.risk || null,
      evidenceStatus: approvalContext.evidenceStatus || null,
      verificationPlan: approvalContext.verificationPlan || '',
    } : null,
    verificationNotes,
    auditTrail: buildAuditTrail({ approvalContext, githubReview, visualDebug, verificationNotes }),
    visualDebug,
    fixSuggestions: buildFixSuggestions({
      generalFindings,
      findings,
      affectedFiles,
      approvalContext,
      visualDebug,
      topExternalSources,
    }),
  };
}

function buildSourceReferences({ affectedFiles = [], topExternalSources = [], topVisualEvidence = [], evidenceBundle = null } = {}) {
  const refs = [];
  for (const file of affectedFiles.slice(0, 5)) {
    refs.push({
      kind: 'workspace',
      label: file.file,
      detail: `${file.inlineComments} inline · ${file.findings} finding${file.findings === 1 ? '' : 's'}`,
    });
  }
  for (const source of topExternalSources.slice(0, 3)) {
    refs.push({
      kind: 'external',
      label: source.title,
      detail: source.url,
      url: source.url,
    });
  }
  for (const visual of topVisualEvidence.slice(0, 2)) {
    refs.push({
      kind: 'visual',
      label: visual.title,
      detail: visual.citationId || visual.snippet || 'visual evidence',
    });
  }
  if (!refs.length && evidenceBundle?.summary) {
    refs.push({
      kind: 'summary',
      label: 'evidence summary',
      detail: evidenceBundle.summary,
    });
  }
  return refs.slice(0, 8);
}

function collectExternalSources(result = {}, evidenceBundle = null) {
  const out = [];
  const seen = new Set();
  const add = (source) => {
    const url = String(source?.url || source?.source || '').trim();
    if (!/^https?:/i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({
      title: String(source?.title || url).trim(),
      url,
      category: source?.type || source?.category || 'external',
    });
  };
  for (const source of Array.isArray(result?.sources) ? result.sources : []) add(source);
  for (const source of Array.isArray(evidenceBundle?.sources) ? evidenceBundle.sources : []) add(source);
  return out.slice(0, 5);
}

function collectVisualEvidence(result = {}, evidenceBundle = null) {
  const out = [];
  const seen = new Set();
  const add = (source) => {
    const key = String(source?.citationId || source?.title || source?.source || source?.url || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      title: String(source?.title || source?.source || 'visual evidence').trim(),
      snippet: String(source?.snippet || '').trim(),
      citationId: source?.citationId || null,
    });
  };
  for (const source of Array.isArray(result?.sources) ? result.sources : []) {
    if (String(source?.type || source?.category || '') === 'image') add(source);
  }
  for (const source of Array.isArray(evidenceBundle?.sources) ? evidenceBundle.sources : []) {
    if (String(source?.category || source?.type || '') === 'image') add(source);
  }
  return out.slice(0, 4);
}

function collectGroundingHighlights(evidenceBundle = null, topExternalSources = [], topVisualEvidence = []) {
  const highlights = [];
  const categories = evidenceBundle?.byCategory || {};
  if (Number(categories.workspace || 0) > 0) {
    highlights.push(`${categories.workspace} workspace reference${categories.workspace === 1 ? '' : 's'}`);
  }
  if (Number(categories.docs || 0) > 0) {
    highlights.push(`${categories.docs} docs source${categories.docs === 1 ? '' : 's'}`);
  }
  if (Number(categories.web || 0) > 0) {
    highlights.push(`${categories.web} web source${categories.web === 1 ? '' : 's'}`);
  }
  if (Number(categories.image || 0) > 0 || topVisualEvidence.length) {
    const count = Math.max(Number(categories.image || 0), topVisualEvidence.length);
    highlights.push(`${count} visual evidence item${count === 1 ? '' : 's'}`);
  }
  if (topExternalSources.length) {
    highlights.push(`top source: ${topExternalSources[0].title}`);
  }
  return highlights.slice(0, 5);
}

function collectAffectedFiles({ generalFindings = [], findings = [], inlineComments = [] } = {}) {
  const map = new Map();
  const add = (file, kind, line = null) => {
    const key = String(file || '').trim();
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, {
        file: key,
        kinds: new Set(),
        inlineComments: 0,
        findings: 0,
        firstLine: Number.isInteger(line) ? line : null,
      });
    }
    const entry = map.get(key);
    entry.kinds.add(kind);
    if (kind === 'inline') entry.inlineComments += 1;
    if (kind === 'finding' || kind === 'general') entry.findings += 1;
    if (entry.firstLine === null && Number.isInteger(line)) entry.firstLine = line;
  };

  for (const comment of inlineComments) {
    add(comment.file, 'inline', comment.currentStart || comment.start || null);
  }
  for (const finding of findings) {
    const line = Array.isArray(finding.lines) && Number.isInteger(Number(finding.lines[0]))
      ? Number(finding.lines[0])
      : Number.isInteger(finding.line)
        ? Number(finding.line)
        : Number.isInteger(finding.start)
          ? Number(finding.start)
          : null;
    add(finding.file, 'finding', line);
  }
  for (const finding of generalFindings) {
    add(finding.file, 'general', null);
  }

  return [...map.values()]
    .map((entry) => ({
      file: entry.file,
      kinds: [...entry.kinds],
      inlineComments: entry.inlineComments,
      findings: entry.findings,
      firstLine: entry.firstLine,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function summarizeAnchors(comments = []) {
  return (Array.isArray(comments) ? comments : []).reduce((acc, comment) => {
    const key = comment?.anchorStatus || 'stale';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, { exact: 0, shifted: 0, stale: 0, missing_file: 0 });
}

function computeVulnerabilityCount(vulnerabilities = null) {
  if (!vulnerabilities || typeof vulnerabilities !== 'object') return 0;
  return Object.values(vulnerabilities).reduce((sum, value) => sum + Number(value || 0), 0);
}

function collectVerificationNotes({ result = {}, approvalContext = null, evidenceBundle = null, comments = [] } = {}) {
  const notes = [];
  if (approvalContext?.verificationPlan) notes.push(approvalContext.verificationPlan);
  if (result?.npmAudit?.vulnerabilities) {
    notes.push(`npm audit reported ${computeVulnerabilityCount(result.npmAudit.vulnerabilities)} vulnerability signal(s)`);
  }
  if (Array.isArray(result?.checks) && result.checks.length) {
    notes.push(...result.checks.slice(0, 4).map((check) => String(check).trim()).filter(Boolean));
  }
  if (comments.some((comment) => comment.anchorStatus === 'shifted' || comment.anchorStatus === 'stale')) {
    notes.push('Some inline comments required re-anchoring and should be double-checked before export.');
  }
  if (evidenceBundle?.summary && evidenceBundle.summary !== 'No evidence yet.') {
    notes.push(evidenceBundle.summary);
  }
  return uniqueStrings(notes).slice(0, 6);
}

function buildFixSuggestions({
  generalFindings = [],
  findings = [],
  affectedFiles = [],
  approvalContext = null,
  visualDebug = null,
  topExternalSources = [],
} = {}) {
  const suggestions = [];

  for (const finding of findings.slice(0, 4)) {
    const file = String(finding?.file || '').trim();
    const issue = String(finding?.issue || finding?.title || '').trim();
    if (!file && !issue) continue;
    const line = Array.isArray(finding?.lines) && finding.lines.length ? Number(finding.lines[0]) : null;
    suggestions.push({
      title: issue || `Investigate ${file || 'this finding'}`,
      detail: file
        ? `${file}${Number.isFinite(line) ? ` around line ${line}` : ''}`
        : 'Review the linked finding context.',
      kind: 'finding',
      confidence: visualDebug?.confidence === 'grounded' || topExternalSources.length ? 'grounded' : 'local',
    });
  }

  for (const finding of generalFindings.slice(0, 2)) {
    const title = String(finding?.title || finding?.issue || 'General finding').trim();
    const file = String(finding?.file || '').trim();
    suggestions.push({
      title,
      detail: file ? `Revisit ${file} and tighten the related behavior.` : 'Revisit the affected area before export.',
      kind: 'general',
      confidence: topExternalSources.length ? 'grounded' : 'local',
    });
  }

  if (visualDebug?.relatedFiles?.length) {
    suggestions.push({
      title: 'Start from the visible issue',
      detail: `Inspect ${visualDebug.relatedFiles[0].label} first, then confirm the fix against the screenshot.`,
      kind: 'visual',
      confidence: visualDebug.confidence || 'visual_only',
    });
  }

  if (approvalContext?.verificationPlan) {
    suggestions.push({
      title: 'Preserve the verification path',
      detail: String(approvalContext.verificationPlan).trim(),
      kind: 'verify',
      confidence: approvalContext.evidenceStatus || 'planned',
    });
  }

  if (!suggestions.length && affectedFiles.length) {
    suggestions.push({
      title: 'Inspect the primary affected file',
      detail: `Start with ${affectedFiles[0].file} and confirm the review findings before export.`,
      kind: 'workspace',
      confidence: 'local',
    });
  }

  return suggestions.slice(0, 5);
}

function buildAuditTrail({ approvalContext = null, githubReview = null, visualDebug = null, verificationNotes = [] } = {}) {
  const steps = [];
  if (approvalContext?.summary) {
    steps.push({ label: 'Approval', detail: approvalContext.summary });
  }
  if (visualDebug?.summary) {
    steps.push({ label: 'Visual grounding', detail: visualDebug.summary });
  }
  if (verificationNotes.length) {
    steps.push({ label: 'Verification', detail: verificationNotes[0] });
  }
  if (githubReview?.url) {
    steps.push({
      label: 'GitHub',
      detail: `${githubReview.owner}/${githubReview.repo}#${githubReview.pullNumber}`,
      url: githubReview.url,
    });
  }
  return steps;
}

function uniqueStrings(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

module.exports = {
  buildReviewBundle,
};
