'use strict';

const dockerProvider = require('./docker');

function spawnGvisor(command, projectRoot, options = {}) {
  return dockerProvider.spawn(command, projectRoot, {
    ...options,
    runtime: 'runsc',
  });
}

module.exports = {
  id: 'gvisor',
  spawn: spawnGvisor,
};
