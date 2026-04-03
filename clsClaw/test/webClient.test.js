'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WebClient,
  parseDuckDuckGoResults,
  extractReadableText,
  extractTitle,
  inferOfficialDocDomains,
} = require('../src/web/webClient');

test('parseDuckDuckGoResults extracts external URLs and titles', () => {
  const html = `
    <html><body>
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example Docs</a>
      <a class="result__a" href="https://react.dev/reference/react/useEffect">useEffect - React</a>
    </body></html>
  `;
  const results = parseDuckDuckGoResults(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://example.com/docs');
  assert.equal(results[1].domain, 'react.dev');
});

test('extractReadableText strips markup and preserves readable text', () => {
  const html = `
    <html>
      <head><title>Example Page</title><style>.a{}</style></head>
      <body><article><h1>Heading</h1><p>Hello <strong>world</strong>.</p></article></body>
    </html>
  `;
  assert.equal(extractTitle(html), 'Example Page');
  const text = extractReadableText(html);
  assert.match(text, /Heading/);
  assert.match(text, /Hello world/);
  assert.doesNotMatch(text, /<strong>/);
});

test('inferOfficialDocDomains recognizes common product doc sites', () => {
  const domains = inferOfficialDocDomains('Find the OpenAI embeddings docs and React hooks reference');
  assert.ok(domains.includes('platform.openai.com'));
  assert.ok(domains.includes('react.dev'));
});

test('web client search and open use the provided fetch implementation', async () => {
  const calls = [];
  const client = new WebClient({
    fetchImpl: async (url) => {
      calls.push(url);
      if (String(url).includes('duckduckgo.com')) {
        return {
          ok: true,
          url,
          headers: new Map([['content-type', 'text/html']]),
          text: async () => '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide">Guide</a>',
        };
      }
      return {
        ok: true,
        url: 'https://docs.example.com/guide',
        headers: new Map([['content-type', 'text/html']]),
        text: async () => '<html><head><title>Guide</title></head><body><p>Current guidance.</p></body></html>',
      };
    },
  });

  const search = await client.search('example docs');
  const opened = await client.open(search.results[0].url);

  assert.equal(search.results[0].url, 'https://docs.example.com/guide');
  assert.equal(opened.title, 'Guide');
  assert.match(opened.excerpt, /Current guidance/);
  assert.equal(calls.length, 2);
});
