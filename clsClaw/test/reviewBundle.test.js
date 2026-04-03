'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReviewBundle } = require('../src/review/reviewBundle');

test('review bundle aggregates findings, anchors, evidence, and GitHub state', () => {
  const bundle = buildReviewBundle({
    summary: 'Nightly review',
    result: {
      findings: [{ file: 'src/app.js', issue: 'Guard missing', lines: [12] }],
      generalFindings: [{ file: 'src/config.js', title: 'Config drift' }],
      npmAudit: { vulnerabilities: { high: 1, moderate: 2 } },
      sources: [
        { type: 'web', title: 'OpenAI docs', url: 'https://platform.openai.com/docs', snippet: 'Docs snippet.' },
        { type: 'image', title: 'UI screenshot', citationId: 'V1', snippet: 'Error banner shown.' },
      ],
    },
    inlineComments: [
      { file: 'src/app.js', title: 'Guard missing', anchorStatus: 'exact', currentStart: 12 },
      { file: 'src/app.js', title: 'Null check', anchorStatus: 'shifted', currentStart: 18 },
    ],
    evidenceBundle: {
      summary: 'Evidence collected: 2 workspace',
      sources: [
        { key: 'workspace:src/app.js', category: 'workspace' },
        { key: 'workspace:src/config.js', category: 'workspace' },
        { key: 'web:https://platform.openai.com/docs', category: 'web', url: 'https://platform.openai.com/docs', title: 'OpenAI docs', snippet: 'Docs snippet.' },
        { key: 'image:screenshot', category: 'image', title: 'UI screenshot', snippet: 'Error banner shown.', citationId: 'V1' },
      ],
      byCategory: { workspace: 2, web: 1, image: 1 },
    },
    approvalContext: {
      kind: 'review_acknowledgement',
      risk: 'medium',
      evidenceStatus: 'grounded',
      verificationPlan: 'double-check the anchored comments before export',
    },
    githubReview: {
      owner: 'sahedwave',
      repo: 'clsCLAW',
      pullNumber: 7,
      commentCount: 2,
      url: 'https://github.com/sahedwave/clsCLAW/pull/7',
      state: 'COMMENT',
    },
  });

  assert.equal(bundle.counts.inlineComments, 2);
  assert.equal(bundle.counts.findings, 2);
  assert.equal(bundle.counts.vulnerabilities, 3);
  assert.equal(bundle.github.synced, true);
  assert.equal(bundle.affectedFiles.length, 2);
  assert.equal(bundle.evidence.groundingHighlights.length >= 3, true);
  assert.equal(bundle.evidence.topExternalSources.length, 1);
  assert.equal(bundle.evidence.topVisualEvidence.length, 1);
  assert.equal(bundle.visualDebug.confidence, 'grounded');
  assert.match(bundle.visualDebug.primaryIssue, /Error banner shown/i);
  assert.equal(bundle.fixSuggestions.length > 0, true);
  assert.match(bundle.fixSuggestions.map((item) => item.title).join('\n'), /Guard missing|Start from the visible issue/i);
  assert.match(bundle.verificationNotes.join('\n'), /anchored comments|Evidence collected/i);
});
