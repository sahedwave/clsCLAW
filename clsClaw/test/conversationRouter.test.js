'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { routeConversation } = require('../src/llm/conversationRouter');

function routeUserText(content, mode = 'ask') {
  return routeConversation({
    mode,
    messages: [{ role: 'user', content }],
  });
}

test('router keeps greetings in plain_chat lane', () => {
  const route = routeUserText('hi', 'build');
  assert.equal(route.lane, 'plain_chat');
  assert.equal(route.tools.allowTools, false);
  assert.equal(route.ui.showTrace, false);
});

test('router keeps factual prompts in plain_chat lane', () => {
  const route = routeUserText('who owns google');
  assert.equal(route.lane, 'plain_chat');
  assert.equal(route.intent, 'chat');
});

test('router keeps personal language prompts in plain_chat lane', () => {
  const route = routeUserText('do u know bangla');
  assert.equal(route.lane, 'plain_chat');
});

test('router keeps build-idea requests in brainstorm lane', () => {
  assert.equal(routeUserText('suggest me something to build', 'build').lane, 'brainstorm');
  assert.equal(routeUserText('if i ask u for ideas to build by coding can u suggest', 'build').lane, 'brainstorm');
});

test('router escalates only when the prompt truly asks for repo work', () => {
  const route = routeUserText('analyze this file and fix bugs');
  assert.equal(route.lane, 'operation');
  assert.equal(route.tools.allowToolLoop, true);
});
