'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildEvidenceBundle, appendEvidence } = require('../src/orchestration/evidenceBundle');

test('evidence bundle groups heterogeneous evidence by category', () => {
  const bundle = buildEvidenceBundle([
    { type: 'workspace', source: 'src/app.js', title: 'src/app.js' },
    { type: 'web', source: 'https://example.com', title: 'Example', citationId: 'S1' },
    { type: 'image_analysis', source: 'screen.png', title: 'Screen' },
  ]);

  assert.equal(bundle.total, 3);
  assert.equal(bundle.byCategory.workspace, 1);
  assert.equal(bundle.byCategory.web, 1);
  assert.equal(bundle.byCategory.image, 1);
  assert.equal(bundle.citations[0].citationId, 'S1');
  assert.match(bundle.summary, /workspace/);
});

test('appendEvidence updates the bundle summary and source registry', () => {
  const bundle = buildEvidenceBundle([]);
  appendEvidence(bundle, { type: 'docs_search', source: 'https://docs.example.com', title: 'Docs', citationId: 'S2' });

  assert.equal(bundle.total, 1);
  assert.equal(bundle.byCategory.docs, 1);
  assert.equal(bundle.sources.length, 1);
  assert.match(bundle.summary, /docs/);
});
