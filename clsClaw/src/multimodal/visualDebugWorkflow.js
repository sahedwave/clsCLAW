'use strict';

function buildVisualDebugWorkflow({
  evidenceBundle = null,
  affectedFiles = [],
  approvalContext = null,
  result = {},
} = {}) {
  const visualSources = collectVisualSources(result, evidenceBundle);
  if (!visualSources.length) return null;

  const docSources = collectDocSources(result, evidenceBundle);
  const relatedFiles = collectRelatedFiles(affectedFiles, evidenceBundle);
  const primaryVisual = visualSources[0];
  const confidence = docSources.length || relatedFiles.length ? 'grounded' : 'visual_only';
  const summaryParts = [
    `${visualSources.length} visual clue${visualSources.length === 1 ? '' : 's'}`,
    relatedFiles.length ? `${relatedFiles.length} related file${relatedFiles.length === 1 ? '' : 's'}` : null,
    docSources.length ? `${docSources.length} docs/web source${docSources.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean);

  return {
    summary: summaryParts.join(' · '),
    confidence,
    primaryIssue: firstSentence(primaryVisual.snippet) || primaryVisual.title || 'Visual issue captured.',
    visualSources: visualSources.slice(0, 3),
    relatedFiles: relatedFiles.slice(0, 4),
    docSources: docSources.slice(0, 3),
    nextSteps: buildNextSteps({ relatedFiles, docSources, approvalContext, confidence }),
  };
}

function collectVisualSources(result = {}, evidenceBundle = null) {
  const out = [];
  const seen = new Set();
  const add = (source) => {
    const key = String(source?.citationId || source?.title || source?.source || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      title: String(source?.title || source?.source || 'visual evidence').trim(),
      snippet: String(source?.snippet || source?.excerpt || '').trim(),
      citationId: source?.citationId || null,
      source: String(source?.source || source?.url || '').trim(),
    });
  };

  for (const source of Array.isArray(result?.sources) ? result.sources : []) {
    if (String(source?.type || source?.category || '') === 'image') add(source);
  }
  for (const source of Array.isArray(evidenceBundle?.sources) ? evidenceBundle.sources : []) {
    if (String(source?.category || source?.type || '') === 'image') add(source);
  }
  return out;
}

function collectDocSources(result = {}, evidenceBundle = null) {
  const out = [];
  const seen = new Set();
  const add = (source) => {
    const url = String(source?.url || source?.source || '').trim();
    if (!/^https?:/i.test(url) || seen.has(url)) return;
    seen.add(url);
    out.push({
      title: String(source?.title || url).trim(),
      url,
      domain: String(source?.domain || safeDomain(url)).trim(),
      snippet: String(source?.snippet || '').trim(),
      category: String(source?.category || source?.type || 'docs').trim(),
    });
  };

  for (const source of Array.isArray(result?.sources) ? result.sources : []) {
    const category = String(source?.type || source?.category || '');
    if (category === 'docs' || category === 'web') add(source);
  }
  for (const source of Array.isArray(evidenceBundle?.sources) ? evidenceBundle.sources : []) {
    const category = String(source?.category || source?.type || '');
    if (category === 'docs' || category === 'web') add(source);
  }
  return out;
}

function collectRelatedFiles(affectedFiles = [], evidenceBundle = null) {
  const out = [];
  const seen = new Set();
  const add = (file) => {
    const value = String(file || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({
      file: value,
      label: pathBaseName(value),
    });
  };

  for (const file of Array.isArray(affectedFiles) ? affectedFiles : []) {
    add(file?.file || file?.label);
  }
  for (const source of Array.isArray(evidenceBundle?.sources) ? evidenceBundle.sources : []) {
    if (String(source?.category || '') !== 'workspace') continue;
    add(source?.source || source?.title);
  }
  return out;
}

function buildNextSteps({ relatedFiles = [], docSources = [], approvalContext = null, confidence = 'visual_only' } = {}) {
  const steps = [];
  if (relatedFiles.length) {
    steps.push(`Inspect ${relatedFiles[0].label} first to connect the visible issue to the implementation.`);
  }
  if (docSources.length) {
    steps.push(`Compare the observed behavior against ${docSources[0].title}.`);
  }
  if (approvalContext?.verificationPlan) {
    steps.push(String(approvalContext.verificationPlan).trim());
  } else if (confidence === 'grounded') {
    steps.push('Verify the proposed fix against the screenshot and the grounded references before export.');
  } else {
    steps.push('Ground the screenshot with at least one relevant file or doc source before acting.');
  }
  return uniqueStrings(steps).slice(0, 4);
}

function firstSentence(text = '') {
  const value = String(text || '').trim();
  if (!value) return '';
  const match = value.match(/(.+?[.!?])(?:\s|$)/);
  return (match ? match[1] : value).slice(0, 220);
}

function pathBaseName(filePath = '') {
  const parts = String(filePath || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(filePath || '').trim();
}

function safeDomain(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
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
  buildVisualDebugWorkflow,
};
