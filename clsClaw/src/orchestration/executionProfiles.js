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
