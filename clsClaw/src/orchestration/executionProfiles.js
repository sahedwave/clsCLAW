'use strict';

const EXECUTION_PROFILES = {
  quick: {
    id: 'quick',
    label: 'Quick',
    description: 'Favor direct answers and minimal inspection for obvious tasks.',
    inspectBias: -1,
    verificationBias: -1,
    approvalBias: 0,
    askBias: 0,
    maxSteps: 4,
    allowParallel: false,
    autonomyBudget: {
      maxToolSteps: 3,
      maxRecoveryPasses: 0,
      maxWriteScope: 'single_file',
    },
  },
  deliberate: {
    id: 'deliberate',
    label: 'Deliberate',
    description: 'Inspect first, explain clearly, and verify when the task is meaningful.',
    inspectBias: 1,
    verificationBias: 1,
    approvalBias: 0,
    askBias: 0,
    maxSteps: 7,
    allowParallel: false,
    autonomyBudget: {
      maxToolSteps: 5,
      maxRecoveryPasses: 1,
      maxWriteScope: 'bounded_multi_file',
    },
  },
  execute: {
    id: 'execute',
    label: 'Execute',
    description: 'Carry work through end-to-end while still pausing on risky actions.',
    inspectBias: 0,
    verificationBias: 1,
    approvalBias: -1,
    askBias: -1,
    maxSteps: 7,
    allowParallel: false,
    autonomyBudget: {
      maxToolSteps: 6,
      maxRecoveryPasses: 1,
      maxWriteScope: 'bounded_multi_file',
    },
  },
  parallel: {
    id: 'parallel',
    label: 'Parallel',
    description: 'Prefer safe parallel reads and broader evidence gathering before synthesis.',
    inspectBias: 1,
    verificationBias: 0,
    approvalBias: 0,
    askBias: 0,
    maxSteps: 8,
    allowParallel: true,
    autonomyBudget: {
      maxToolSteps: 6,
      maxRecoveryPasses: 1,
      maxWriteScope: 'bounded_multi_file',
    },
  },
};

function normalizeExecutionProfile(profile) {
  const key = String(profile || '').trim().toLowerCase();
  return EXECUTION_PROFILES[key] || EXECUTION_PROFILES.deliberate;
}

function listExecutionProfiles() {
  return Object.values(EXECUTION_PROFILES).map((profile) => ({ ...profile }));
}

module.exports = {
  EXECUTION_PROFILES,
  normalizeExecutionProfile,
  listExecutionProfiles,
};
