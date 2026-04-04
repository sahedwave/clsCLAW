'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = require('../src/sandbox/sandbox');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-sandbox-'));
}

function cleanup(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

test('assessCommand keeps normal reads inside the sandbox', async () => {
  sandbox.__setDockerAvailabilityForTests(false);
  const workspace = makeWorkspace();

  try {
    const assessment = await sandbox.assessCommand('ls', workspace);
    assert.equal(assessment.executionMode, 'sandbox');
    assert.equal(assessment.requiresEscalation, false);
    assert.equal(assessment.sandboxMode, 'restricted');
  } finally {
    cleanup(workspace);
    sandbox.__setDockerAvailabilityForTests(null);
  }
});

test('assessCommand marks network and desktop commands as host escalation', async () => {
  sandbox.__setDockerAvailabilityForTests(true);
  const workspace = makeWorkspace();

  try {
    const curlAssessment = await sandbox.assessCommand('curl https://example.com', workspace);
    assert.equal(curlAssessment.executionMode, 'host');
    assert.equal(curlAssessment.requiresEscalation, true);
    assert.match(curlAssessment.escalationReason, /network access/i);

    const openAssessment = await sandbox.assessCommand('open README.md', workspace);
    assert.equal(openAssessment.executionMode, 'host');
    assert.equal(openAssessment.requiresEscalation, true);
    assert.match(openAssessment.escalationReason, /desktop|gui/i);
  } finally {
    cleanup(workspace);
    sandbox.__setDockerAvailabilityForTests(null);
  }
});

test('assessCommand prefers gvisor when runsc and docker are available', async () => {
  sandbox.__setDockerAvailabilityForTests(true);
  sandbox.__setRunscAvailabilityForTests(true);
  const workspace = makeWorkspace();

  try {
    const assessment = await sandbox.assessCommand('ls', workspace, { providerPreference: 'gvisor' });
    assert.equal(assessment.sandboxMode, 'gvisor');
  } finally {
    cleanup(workspace);
    sandbox.__setDockerAvailabilityForTests(null);
    sandbox.__setRunscAvailabilityForTests(null);
  }
});

test('runCommandApproved executes explicitly approved host commands in host mode', async () => {
  sandbox.__setDockerAvailabilityForTests(true);
  const workspace = makeWorkspace();

  try {
    const result = await sandbox.runCommandApproved('echo host-ok', workspace, {
      executionMode: 'host',
      timeout: 2000,
    });

    assert.equal(result.mode, 'host');
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /host-ok/);
  } finally {
    cleanup(workspace);
    sandbox.__setDockerAvailabilityForTests(null);
  }
});
