

'use strict';

const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const { detectInstall } = require('./installGate');
const { readRedLinePatterns } = require('../workspaceIdentity');

const execAsync = promisify(exec);


const INSTALL_TIMEOUT_MS = 300000; 



const BLOCKED_COMMANDS = [
  'rm -rf /', 'rm -rf ~', 'mkfs', 'dd if=',
  'chmod 777 /', 'chown', 'sudo', 'su ',
  'curl | sh', 'wget | sh', 'bash <(',
  '> /etc', '> /usr', '> /bin', '> /sbin',
  '/etc/passwd', '/etc/shadow', 'ssh-keygen',
  'killall', 'shutdown', 'reboot', 'halt',
];

const ALLOWED_COMMANDS = [
  'node', 'npm', 'npx', 'python', 'python3', 'pip', 'pip3',
  'git', 'ls', 'cat', 'echo', 'mkdir', 'cp', 'mv', 'touch',
  'grep', 'find', 'sed', 'awk', 'wc', 'head', 'tail',
  'yarn', 'pnpm', 'tsc', 'eslint', 'prettier', 'jest',
  'mocha', 'pytest', 'go', 'cargo', 'make',
];

const HOST_ALLOWED_COMMANDS = [
  'curl', 'wget', 'open', 'xdg-open', 'osascript',
  'docker', 'docker-compose', 'gh',
];

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 500 * 1024; 
const HOST_EXECUTION_RULES = [
  {
    pattern: /\b(docker|docker-compose)\b/i,
    reason: 'Docker commands need host execution outside the sandbox container.',
  },
  {
    pattern: /\b(open|xdg-open|osascript)\b/i,
    reason: 'Desktop and GUI commands need host execution.',
  },
  {
    pattern: /\b(curl|wget)\b/i,
    reason: 'Network fetch commands need host execution with network access.',
  },
  {
    pattern: /\bgh\b/i,
    reason: 'GitHub CLI commands need host execution with local auth and network access.',
  },
];



let dockerAvailable = null;
let runscAvailable = null;
let dockerImage = 'node:20-alpine';

async function detectDocker() {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    await execAsync('docker info --format "{{.ServerVersion}}"', { timeout: 5000 });
    
    try {
      await execAsync(`docker image inspect ${dockerImage}`, { timeout: 3000 });
    } catch {
      console.log('[sandbox] Pulling Docker image:', dockerImage);
      await execAsync(`docker pull ${dockerImage}`, { timeout: 120000 });
    }
    dockerAvailable = true;
    console.log('[sandbox] Docker available — using container isolation');
  } catch {
    dockerAvailable = false;
    console.log('[sandbox] Docker not available — using restricted child_process mode');
  }
  return dockerAvailable;
}

async function detectRunsc() {
  if (runscAvailable !== null) return runscAvailable;
  try {
    await execAsync('runsc --version', { timeout: 5000 });
    runscAvailable = true;
  } catch {
    runscAvailable = false;
  }
  return runscAvailable;
}


function assertPathSafe(filePath, projectRoot) {
  if (!projectRoot) throw new Error('No project root set');
  const resolved = path.resolve(filePath);
  const root = path.resolve(projectRoot);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(
      `SECURITY: Path "${resolved}" is outside project root "${root}"`
    );
  }
  return resolved;
}

function assertCommandSafe(command, projectRoot = null, opts = {}) {
  const lower = command.toLowerCase().trim();

  for (const blocked of BLOCKED_COMMANDS) {
    if (lower.includes(blocked.toLowerCase())) {
      throw new Error(`BLOCKED: Command contains forbidden pattern: "${blocked}"`);
    }
  }

  if (projectRoot) {
    for (const redLine of readRedLinePatterns(projectRoot)) {
      if (lower.includes(redLine)) {
        throw new Error(`BLOCKED: Command matches AGENTS.md red line: "${redLine}"`);
      }
    }
  }

  const baseCmd = extractBaseCommand(lower);
  const executionMode = opts.executionMode === 'host' ? 'host' : 'sandbox';
  const allowedCommands = executionMode === 'host'
    ? [...ALLOWED_COMMANDS, ...HOST_ALLOWED_COMMANDS]
    : ALLOWED_COMMANDS;
  if (!allowedCommands.includes(baseCmd)) {
    throw new Error(
      `BLOCKED: Command "${baseCmd}" not in allowlist. ` +
      `Allowed: ${allowedCommands.join(', ')}`
    );
  }

  return true;
}

function extractBaseCommand(command) {
  return String(command || '')
    .trim()
    .split(/\s+/)[0]
    .replace(/^.*\//, '')
    .toLowerCase();
}

function normalizeExecutionMode(mode) {
  return mode === 'host' ? 'host' : 'sandbox';
}

function collectEscalationReasons(command) {
  const reasons = [];
  for (const rule of HOST_EXECUTION_RULES) {
    if (rule.pattern.test(command)) reasons.push(rule.reason);
  }
  return [...new Set(reasons)];
}


async function runInDocker(command, projectRoot, { timeout = DEFAULT_TIMEOUT_MS, provider = 'docker' } = {}) {
  return collectProcessOutput(spawnInDocker(command, projectRoot, provider), { timeout, mode: provider });
}


async function runRestricted(command, projectRoot, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  assertCommandSafe(command, projectRoot, { executionMode: 'sandbox' });
  return collectProcessOutput(spawnRestricted(command, projectRoot), { timeout, mode: 'restricted' });
}

async function runHostEscalated(command, projectRoot, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  assertCommandSafe(command, projectRoot, { executionMode: 'host' });
  return collectProcessOutput(spawnHost(command, projectRoot), { timeout, mode: 'host' });
}

function spawnInDocker(command, projectRoot, provider = 'docker') {
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
    ...(provider === 'gvisor' ? ['--runtime=runsc'] : []),
    dockerImage,
    'sh', '-c', command,
  ];
  return spawn(dockerCmd[0], dockerCmd.slice(1), {
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
  });
}

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

function spawnHost(command, projectRoot) {
  const absRoot = path.resolve(projectRoot);
  return spawn('sh', ['-c', command], {
    cwd: absRoot,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'development',
      TMPDIR: process.env.TMPDIR || (absRoot + '/.tmp'),
    },
  });
}

function collectProcessOutput(proc, { timeout = DEFAULT_TIMEOUT_MS, mode = 'restricted' } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    proc.stdout.on('data', (d) => {
      stdout += d;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        proc.kill('SIGTERM');
        stdout += '\n[OUTPUT TRUNCATED — exceeded 500KB]';
      }
    });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 1,
        timedOut,
        mode,
      });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        timedOut: false,
        mode,
      });
    });
  });
}


function safeWriteFile(filePath, content, projectRoot) {
  const safe = assertPathSafe(filePath, projectRoot);
  const dir = path.dirname(safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(safe, content, 'utf-8');
  return safe;
}

function safeReadFile(filePath, projectRoot) {
  const safe = assertPathSafe(filePath, projectRoot);
  if (!fs.existsSync(safe)) throw new Error('File not found: ' + safe);
  const stat = fs.statSync(safe);
  if (stat.size > 2 * 1024 * 1024) throw new Error('File too large (>2MB): ' + safe);
  return fs.readFileSync(safe, 'utf-8');
}

function safeDeleteFile(filePath, projectRoot) {
  const safe = assertPathSafe(filePath, projectRoot);

  if (fs.statSync(safe).isDirectory()) throw new Error('Use rmdir for directories, not delete');
  fs.unlinkSync(safe);
  return safe;
}

function __setDockerAvailabilityForTests(value) {
  dockerAvailable = value;
}

function __setRunscAvailabilityForTests(value) {
  runscAvailable = value;
}

async function runCommand(command, projectRoot, opts = {}) {
  const assessment = await assessCommand(command, projectRoot, opts);
  if (assessment.isInstall) {
    return {
      isInstall:      true,
      installRequest: assessment.installRequest,
      requiresEscalation: assessment.requiresEscalation,
      executionMode: assessment.executionMode,
      escalationReason: assessment.escalationReason,
      stdout:         '',
      stderr:         '',
      exitCode:       -1,
    };
  }

  if (assessment.requiresEscalation) {
    return {
      isInstall: false,
      requiresEscalation: true,
      executionMode: assessment.executionMode,
      escalationReason: assessment.escalationReason,
      stdout: '',
      stderr: '',
      exitCode: -1,
    };
  }

  return runCommandApproved(command, projectRoot, { ...opts, executionMode: 'sandbox' });
}

async function runCommandApproved(command, projectRoot, opts = {}) {
  const assessment = await assessCommand(command, projectRoot, opts);
  const executionMode = normalizeExecutionMode(opts.executionMode || assessment.executionMode);
  const timeout = assessment.isInstall ? INSTALL_TIMEOUT_MS : (opts.timeout || DEFAULT_TIMEOUT_MS);

  if (assessment.requiresEscalation && executionMode !== 'host') {
    throw new Error(`Command requires host escalation: ${assessment.escalationReason}`);
  }

  if (executionMode === 'host') {
    return runHostEscalated(command, projectRoot, { ...opts, timeout });
  }

  if (assessment.sandboxMode === 'gvisor' || assessment.sandboxMode === 'docker') {
    return runInDocker(command, projectRoot, { ...opts, timeout, provider: assessment.sandboxMode });
  }
  return runRestricted(command, projectRoot, { ...opts, timeout });
}

async function spawnCommandApproved(command, projectRoot, opts = {}) {
  const assessment = await assessCommand(command, projectRoot, opts);
  const executionMode = normalizeExecutionMode(opts.executionMode || assessment.executionMode);

  if (assessment.requiresEscalation && executionMode !== 'host') {
    throw new Error(`Command requires host escalation: ${assessment.escalationReason}`);
  }
  if (executionMode === 'host') {
    assertCommandSafe(command, projectRoot, { executionMode: 'host' });
    return { proc: spawnHost(command, projectRoot), mode: 'host', assessment };
  }

  if (assessment.sandboxMode === 'gvisor' || assessment.sandboxMode === 'docker') {
    assertCommandSafe(command, projectRoot, { executionMode: 'sandbox' });
    return { proc: spawnInDocker(command, projectRoot, assessment.sandboxMode), mode: assessment.sandboxMode, assessment };
  }
  assertCommandSafe(command, projectRoot, { executionMode: 'sandbox' });
  return { proc: spawnRestricted(command, projectRoot), mode: 'restricted', assessment };
}

async function assessCommand(command, projectRoot, opts = {}) {
  const normalized = String(command || '').trim();
  if (!normalized) throw new Error('Command required');

  const installRequest = detectInstall(normalized, projectRoot);
  assertCommandSafe(normalized, projectRoot, { executionMode: 'host' });
  const reasons = collectEscalationReasons(normalized);
  const sandboxMode = await chooseSandboxMode(opts.providerPreference || opts.sandboxProvider || process.env.CLSCLAW_SANDBOX_PROVIDER || 'auto');

  return {
    command: normalized,
    baseCommand: extractBaseCommand(normalized),
    sandboxMode,
    isInstall: Boolean(installRequest),
    installRequest: installRequest || null,
    requiresEscalation: reasons.length > 0,
    escalationReasons: reasons,
    escalationReason: reasons.join(' '),
    executionMode: reasons.length > 0 ? 'host' : 'sandbox',
    timeoutMs: installRequest ? INSTALL_TIMEOUT_MS : (opts.timeout || DEFAULT_TIMEOUT_MS),
  };
}

async function getSandboxInfo(preferredProvider = null) {
  const docker = await detectDocker();
  const runsc = docker ? await detectRunsc() : false;
  const preferred = preferredProvider || process.env.CLSCLAW_SANDBOX_PROVIDER || 'auto';
  const mode = await chooseSandboxMode(preferred);
  return {
    mode,
    dockerImage: docker ? dockerImage : null,
    blockedCommands: BLOCKED_COMMANDS.length,
    allowedCommands: ALLOWED_COMMANDS,
    hostAllowedCommands: HOST_ALLOWED_COMMANDS,
    supportsHostEscalation: true,
    defaultExecutionMode: 'sandbox',
    availableProviders: {
      restricted: true,
      docker,
      gvisor: docker && runsc,
    },
    preferredProvider: preferred,
    maxTimeoutMs: DEFAULT_TIMEOUT_MS,
    installTimeoutMs: INSTALL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  };
}

async function chooseSandboxMode(preferred = 'auto') {
  const normalized = String(preferred || 'auto').trim().toLowerCase();
  const docker = await detectDocker();
  const runsc = docker ? await detectRunsc() : false;
  if (normalized === 'gvisor' && docker && runsc) return 'gvisor';
  if (normalized === 'docker' && docker) return 'docker';
  if (normalized === 'restricted') return 'restricted';
  if (docker && runsc) return 'gvisor';
  if (docker) return 'docker';
  return 'restricted';
}

module.exports = {
  runCommand,
  runCommandApproved,
  spawnCommandApproved,
  assessCommand,
  detectInstall,
  safeWriteFile,
  safeReadFile,
  safeDeleteFile,
  assertPathSafe,
  assertCommandSafe,
  getSandboxInfo,
  detectDocker,
  detectRunsc,
  __setDockerAvailabilityForTests,
  __setRunscAvailabilityForTests,
};
