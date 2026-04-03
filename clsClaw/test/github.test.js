'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const GitHubClient = require('../src/github/github');

function makeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      const next = responses.shift();
      if (!next) throw new Error(`Unexpected fetch: ${url}`);
      return {
        ok: next.ok !== false,
        status: next.status || 200,
        async text() {
          if (typeof next.body === 'string') return next.body;
          return JSON.stringify(next.body ?? null);
        },
      };
    },
  };
}

test('GitHub client paginates PR files and groups review threads', async () => {
  const { fetch } = makeFetch([
    { body: [{ filename: 'a.js' }, { filename: 'b.js' }] },
    {
      body: [
        { id: 10, path: 'src/a.js', line: 12, body: 'top-level issue', user: { login: 'rev' } },
        { id: 11, path: 'src/a.js', line: 12, body: 'reply', in_reply_to_id: 10, user: { login: 'author' } },
      ],
    },
  ]);
  const gh = new GitHubClient('gh-token', { fetchImpl: fetch });

  const files = await gh.getPRFiles('owner', 'repo', 3);
  const threads = await gh.getPRReviewThreads('owner', 'repo', 3);

  assert.equal(files.length, 2);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].path, 'src/a.js');
  assert.equal(threads[0].replies.length, 1);
});

test('GitHub client builds review bundle from pull, files, reviews, and threads', async () => {
  const { fetch } = makeFetch([
    { body: { number: 7, title: 'Fix auth' } },
    { body: [{ filename: 'src/auth.js' }] },
    { body: [{ id: 1, state: 'COMMENTED' }] },
    { body: [{ id: 20, path: 'src/auth.js', line: 5, body: 'needs guard' }] },
  ]);
  const gh = new GitHubClient('gh-token', { fetchImpl: fetch });

  const bundle = await gh.getPRReviewBundle('owner', 'repo', 7);
  assert.equal(bundle.pull.number, 7);
  assert.equal(bundle.files.length, 1);
  assert.equal(bundle.reviews.length, 1);
  assert.equal(bundle.threads.length, 1);
});

test('GitHub client supports compare, search, and reactions', async () => {
  const { calls, fetch } = makeFetch([
    { body: { status: 'ahead', files: [{ filename: 'x.js' }] } },
    { body: { items: [{ html_url: 'https://github.com/o/r/pull/1', title: 'PR title' }] } },
    { body: { content: '+1' } },
  ]);
  const gh = new GitHubClient('gh-token', { fetchImpl: fetch });

  const compare = await gh.compareCommits('owner', 'repo', 'main', 'feature');
  const search = await gh.searchIssues('repo:owner/repo is:pr bug');
  const reaction = await gh.addReaction({ owner: 'owner', repo: 'repo', target: 'review_comment', targetId: 99, content: '+1' });

  assert.equal(compare.status, 'ahead');
  assert.equal(search.items.length, 1);
  assert.equal(reaction.content, '+1');
  assert.match(calls[2].url, /\/pulls\/comments\/99\/reactions$/);
});
