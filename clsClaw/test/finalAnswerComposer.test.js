'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { composeFinalAnswer, stripBuildArtifacts } = require('../src/llm/finalAnswerComposer');

test('stripBuildArtifacts removes patch and run blocks from lightweight answers', () => {
  const input = [
    '*** Begin Patch',
    '*** Update File: index.html',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
    '',
    '# RUN: xdg-open https://www.google.com',
    '',
    'Google was founded by Larry Page and Sergey Brin.',
  ].join('\n');

  const cleaned = stripBuildArtifacts(input);
  assert.equal(cleaned, 'Google was founded by Larry Page and Sergey Brin.');
});

test('composeFinalAnswer strips build artifacts for plain conversational analysis replies', () => {
  const text = [
    '```patch',
    '*** Begin Patch',
    '*** Update File: index.html',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
    '```',
    '',
    'Google LLC is owned by Alphabet Inc. Its founders are Larry Page and Sergey Brin.',
  ].join('\n');

  const result = composeFinalAnswer({
    text,
    policy: {
      lane: 'plain_chat',
      intent: 'chat',
      responseStyle: 'plain',
      userText: 'who owns google',
    },
    usedTools: false,
  });

  assert.match(result, /Alphabet/);
  assert.doesNotMatch(result, /\*\*\* Begin Patch|```patch/i);
});

test('composeFinalAnswer preserves operational patch output', () => {
  const text = [
    '```patch',
    '*** Begin Patch',
    '*** Update File: index.html',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
    '```',
  ].join('\n');

  const result = composeFinalAnswer({
    text,
    policy: {
      lane: 'operation',
      intent: 'build',
      responseStyle: 'coding',
      userText: 'fix the file',
    },
    usedTools: true,
  });

  assert.match(result, /\*\*\* Begin Patch/);
});
