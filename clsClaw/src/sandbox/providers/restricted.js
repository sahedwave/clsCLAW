'use strict';

const { spawn } = require('child_process');
const path = require('path');

function spawnRestricted(command, projectRoot) {
  const absRoot = path.resolve(projectRoot);
  return spawn('sh', ['-c', command], {
    cwd: absRoot,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
      NODE_ENV: 'development',
      TMPDIR: absRoot + '/.tmp',
    },
  });
}

module.exports = {
  id: 'restricted',
  spawn: spawnRestricted,
};
