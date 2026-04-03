'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ApprovalQueue = require('../src/diff/approvalQueue');

function makeQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-review-queue-'));
  return {
    dir,
    queue: new ApprovalQueue(dir),
  };
}

test('approval queue can annotate review items with GitHub review metadata', async () => {
  const { dir, queue } = makeQueue();
  try {
    const reviewId = await queue.proposeReview({
      jobId: 'job-1',
      jobName: 'Nightly review',
      skillId: 'review',
      runId: 'run-1',
      summary: 'Found review issues',
      projectRoot: dir,
      result: {
        findings: [
          { file: 'src/app.js', issue: 'Guard missing', lines: [12] },
        ],
      },
    });

    const updated = queue.updateReviewMetadata(reviewId, {
      githubReview: {
        owner: 'sahedwave',
        repo: 'clsCLAW',
        pullNumber: 42,
        commentCount: 1,
        state: 'COMMENTED',
      },
    });

    assert.equal(updated.ok, true);
    const stored = queue.getPendingById(reviewId);
    assert.equal(stored.githubReview.pullNumber, 42);
    assert.equal(stored.githubReview.commentCount, 1);
    assert.equal(Array.isArray(stored.inlineComments), true);
    assert.equal(stored.approvalContext.required, true);
    assert.equal(stored.reviewBundle.github.synced, true);
    assert.equal(stored.reviewBundle.counts.inlineComments >= 1, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('approval queue adds approval context to file proposals by default', async () => {
  const { dir, queue } = makeQueue();
  try {
    const filePath = path.join(dir, 'app.js');
    fs.writeFileSync(filePath, 'const x = 1;\n', 'utf-8');
    const pending = await queue.propose({
      filePath,
      newContent: 'const x = 2;\n',
      agentId: 'agent-1',
      agentName: 'clsClaw',
      description: 'Update app.js',
      projectRoot: dir,
    });
    assert.equal(Boolean(pending.approvalContext), true);
    assert.equal(pending.approvalContext.required, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
