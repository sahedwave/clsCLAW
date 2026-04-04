'use strict';

const path = require('path');
const { spawn } = require('child_process');

function runnerBinary() {
  return process.env.CLSCLAW_MICROVM_RUNNER || path.resolve(__dirname, '../../../bin/clsclaw-microvm-run');
}

function spawnMicrovm(command, projectRoot) {
  const absRoot = path.resolve(projectRoot);
  const binary = runnerBinary();
  return spawn(binary, ['--workspace', absRoot, '--command', command], {
    env: {
      ...process.env,
      CLSCLAW_PROJECT_ROOT: absRoot,
    },
  });
}

module.exports = {
  id: 'microvm',
  spawn: spawnMicrovm,
  runnerBinary,
};
