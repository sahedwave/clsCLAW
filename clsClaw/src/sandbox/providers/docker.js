'use strict';

const { spawn } = require('child_process');
const path = require('path');

function spawnDocker(command, projectRoot, { dockerImage = 'node:20-alpine', runtime = null } = {}) {
  const absRoot = path.resolve(projectRoot);
  const dockerCmd = [
    'docker', 'run', '--rm',
    '--network=none',
    '--memory=512m',
    '--cpus=1',
    '--pids-limit=64',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '-v', `${absRoot}:/workspace:rw`,
    '-w', '/workspace',
    ...(runtime ? ['--runtime=' + runtime] : []),
    dockerImage,
    'sh', '-c', command,
  ];
  return spawn(dockerCmd[0], dockerCmd.slice(1), {
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
  });
}

module.exports = {
  id: 'docker',
  spawn: spawnDocker,
};
