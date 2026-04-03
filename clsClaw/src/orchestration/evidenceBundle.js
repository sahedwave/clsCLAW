'use strict';

function createEvidenceBundle() {
  return {
    total: 0,
    byCategory: {
      workspace: 0,
      shell: 0,
      web: 0,
      docs: 0,
      image: 0,
      connector: 0,
      github: 0,
      other: 0,
    },
    citations: [],
    sources: [],
    latestByCategory: {},
    summary: 'No evidence yet.',
  };
}

function buildEvidenceBundle(items = []) {
  const bundle = createEvidenceBundle();
  for (const item of Array.isArray(items) ? items : []) {
    appendEvidence(bundle, item);
  }
  bundle.summary = summarizeEvidenceBundle(bundle);
  return bundle;
}

function appendEvidence(bundle, evidence) {
  const target = bundle || createEvidenceBundle();
  const item = normalizeEvidence(evidence);
  target.total += 1;
  target.byCategory[item.category] = (target.byCategory[item.category] || 0) + 1;
  if (item.citationId) {
    target.citations.push({
      citationId: item.citationId,
      title: item.title,
      source: item.source,
      category: item.category,
    });
  }
  if (!target.sources.some((source) => source.key === item.key)) {
    target.sources.push({
      key: item.key,
      source: item.source,
      title: item.title,
      category: item.category,
      citationId: item.citationId || null,
      url: item.url || null,
      domain: item.domain || null,
      snippet: item.snippet || '',
      meta: item.meta || null,
    });
  }
  target.latestByCategory[item.category] = {
    source: item.source,
    title: item.title,
    citationId: item.citationId || null,
    url: item.url || null,
    domain: item.domain || null,
    snippet: item.snippet || '',
    meta: item.meta || null,
  };
  target.summary = summarizeEvidenceBundle(target);
  return target;
}

function summarizeEvidenceBundle(bundle) {
  if (!bundle || !bundle.total) return 'No evidence yet.';
  const parts = [];
  for (const [category, count] of Object.entries(bundle.byCategory || {})) {
    if (count > 0) parts.push(`${count} ${category}`);
  }
  if (!parts.length) return 'No evidence yet.';
  return `Evidence collected: ${parts.join(' · ')}`;
}

function normalizeEvidence(evidence = {}) {
  const category = classifyEvidenceCategory(evidence.type);
  const source = String(evidence.source || evidence.url || evidence.title || 'unknown');
  return {
    category,
    source,
    title: String(evidence.title || evidence.source || evidence.url || 'evidence'),
    citationId: evidence.citationId || null,
    url: String(evidence.url || evidence.source || ''),
    domain: String(evidence.domain || ''),
    snippet: String(evidence.snippet || evidence.excerpt || ''),
    meta: evidence.meta && typeof evidence.meta === 'object' ? { ...evidence.meta } : null,
    key: `${category}:${source}`,
  };
}

function classifyEvidenceCategory(type = '') {
  switch (String(type || '')) {
    case 'workspace':
      return 'workspace';
    case 'shell':
      return 'shell';
    case 'web':
    case 'web_search':
      return 'web';
    case 'docs_search':
      return 'docs';
    case 'image_analysis':
      return 'image';
    case 'connector':
    case 'connector_resource':
    case 'connector_resource_catalog':
      return 'connector';
    case 'github':
    case 'github_review':
    case 'github_pr':
      return 'github';
    default:
      return 'other';
  }
}

module.exports = {
  createEvidenceBundle,
  buildEvidenceBundle,
  appendEvidence,
  summarizeEvidenceBundle,
  classifyEvidenceCategory,
};
