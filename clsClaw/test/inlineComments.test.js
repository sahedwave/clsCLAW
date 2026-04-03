'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildInlineReviewData, reanchorInlineComments, toRanges } = require('../src/review/inlineComments');
const ApprovalQueue = require('../src/diff/approvalQueue');

test('toRanges groups contiguous finding lines into exact ranges', () => {
  assert.deepEqual(toRanges({ lines: [3, 4, 5, 9, 10] }), [
    { start: 3, end: 5 },
    { start: 9, end: 10 },
  ]);
});

test('buildInlineReviewData creates exact-line comments from findings', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-inline-'));
  const filePath = path.join(workspace, 'src.js');
  fs.writeFileSync(filePath, 'const a = 1;\nconst password = "x";\nconsole.log(a);\n', 'utf8');

  const result = buildInlineReviewData({
    projectRoot: workspace,
    result: {
      findings: [
        { file: 'src.js', issue: 'Hardcoded password', lines: [2], detail: 'Credentials should not be stored in source.' },
      ],
    },
  });

  assert.equal(result.inlineComments.length, 1);
  assert.equal(result.inlineComments[0].start, 2);
  assert.match(result.inlineComments[0].lineText, /password/);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('reanchorInlineComments marks shifted anchors when line moves', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-inline-'));
  const filePath = path.join(workspace, 'src.js');
  fs.writeFileSync(filePath, 'header();\nconst password = "x";\nfooter();\n', 'utf8');

  const comments = [{
    id: 'c1',
    absolutePath: filePath,
    file: 'src.js',
    start: 1,
    end: 1,
    lineText: 'const password = "x";',
    contextBefore: 'header();',
    contextAfter: 'footer();',
    body: 'bad',
    title: 'Hardcoded password',
  }];

  const anchored = reanchorInlineComments(comments, workspace);
  assert.equal(anchored[0].anchorStatus, 'shifted');
  assert.equal(anchored[0].currentStart, 2);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test('approval queue stores inline review comments for review items', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-inline-'));
  const historyDir = path.join(workspace, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src.js'), 'const token = "abc";\n', 'utf8');
  const queue = new ApprovalQueue(historyDir);

  const id = await queue.proposeReview({
    jobId: 'job-1',
    jobName: 'Security audit',
    skillId: 'security-audit',
    runId: 'run-1',
    summary: 'Found one issue',
    result: {
      findings: [{ file: 'src.js', issue: 'Hardcoded secret', lines: [1], detail: 'Move secrets out of source.' }],
    },
    projectRoot: workspace,
  });

  const change = queue.getPendingById(id);
  assert.equal(change.type, 'review');
  assert.equal(change.inlineComments.length, 1);
  assert.equal(change.inlineComments[0].currentStart, 1);

  fs.rmSync(workspace, { recursive: true, force: true });
});
