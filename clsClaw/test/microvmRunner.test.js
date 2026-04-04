'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../src/sandbox/microvmRunner');

test('parseCliArgs handles flags and values', () => {
  const parsed = runner.parseCliArgs(['--workspace', '/tmp/demo', '--command', 'echo ok', '--self-test']);
  assert.equal(parsed.workspace, '/tmp/demo');
  assert.equal(parsed.command, 'echo ok');
  assert.equal(parsed['self-test'], true);
});

test('resolveBackend prefers configured backends in priority order', () => {
  const env = {};
  const capabilities = {
    sandboxExec: true,
    lima: true,
    multipass: false,
  };
  assert.equal(runner.resolveBackend('auto', env, capabilities), 'lima');
  assert.equal(runner.resolveBackend('sandbox-exec', env, capabilities), 'sandbox-exec');
  assert.equal(runner.resolveBackend('multipass', env, capabilities), null);
});

test('buildSandboxProfile limits writes to workspace and tmpdir', () => {
  const profile = runner.buildSandboxProfile({
    workspace: '/tmp/workspace',
    tmpDir: '/tmp/tmpdir',
  });
  assert.match(profile, /deny default/);
  assert.match(profile, /subpath "\/tmp\/workspace"/);
  assert.match(profile, /subpath "\/tmp\/tmpdir"/);
});
