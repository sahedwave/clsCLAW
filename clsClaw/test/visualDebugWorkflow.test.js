'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildVisualDebugWorkflow } = require('../src/multimodal/visualDebugWorkflow');

test('visual debug workflow ties screenshot evidence to files and docs', () => {
  const workflow = buildVisualDebugWorkflow({
    affectedFiles: [{ file: 'src/components/LoginForm.jsx' }],
    approvalContext: {
      verificationPlan: 'Re-check the login modal after applying the fix.',
    },
    evidenceBundle: {
      sources: [
        {
          category: 'image',
          title: 'Login modal screenshot',
          citationId: 'V1',
          snippet: 'The submit button is clipped and overlaps the error banner.',
        },
        {
          category: 'workspace',
          source: 'src/components/LoginForm.jsx',
          title: 'src/components/LoginForm.jsx',
        },
        {
          category: 'docs',
          title: 'React dialog accessibility',
          url: 'https://react.dev/reference/react-dom/components/dialog',
          domain: 'react.dev',
        },
      ],
    },
  });

  assert.equal(workflow.confidence, 'grounded');
  assert.match(workflow.primaryIssue, /submit button is clipped/i);
  assert.equal(workflow.relatedFiles[0].file, 'src/components/LoginForm.jsx');
  assert.equal(workflow.docSources[0].domain, 'react.dev');
  assert.match(workflow.nextSteps.join('\n'), /login modal|dialog/i);
});
