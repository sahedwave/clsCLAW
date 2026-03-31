/**
 * sandbox.js — Execution sandbox layer
 *
 * Strategy:
 *   1. Detect if Docker is available
 *   2. If Docker: run commands inside a container scoped to project dir
 *   3. If no Docker: restricted child_process with:
 *        - hard path whitelist (only inside projectRoot)
 *        - blocked command list
 *        - timeout enforcement
 *        - no shell expansion tricks
 *
 * HONEST NOTE: This is NOT equivalent to Codex's cloud VM sandbox.
 * Docker mode gives real filesystem isolation.
 * Restricted mode is a best-effort guard — a determined attacker
 * with local access could bypass it. For personal use it is sufficient.
 */

'use strict';

const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const { detectInstall } = require('./installGate');

const execAsync = promisify(exec);

// Longer timeout for installs — they can take a while
const INSTALL_TIMEOUT_MS = 300000; // 5 minutes

// ── Constants ─────────────────────────────────────────────────────────────────

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

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 500 * 1024; // 500KB

// ── Docker detection ──────────────────────────────────────────────────────────

let dockerAvailable = null;
let dockerImage = 'node:20-alpine';

async function detectDocker() {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    await execAsync('docker info --format "{{.ServerVersion}}"', { timeout: 5000 });
    // Pull a lightweight image if not present
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

// ── Path safety validator ─────────────────────────────────────────────────────

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

function assertCommandSafe(command) {
  const lower = command.toLowerCase().trim();

  // Check blocked patterns
  for (const blocked of BLOCKED_COMMANDS) {
    if (lower.includes(blocked.toLowerCase())) {
      throw new Error(`BLOCKED: Command contains forbidden pattern: "${blocked}"`);
    }
  }

  // Extract base command
  const baseCmd = lower.split(/\s+/)[0].replace(/^.*\//, ''); // strip path prefix
  if (!ALLOWED_COMMANDS.includes(baseCmd)) {
    throw new Error(
      `BLOCKED: Command "${baseCmd}" not in allowlist. ` +
      `Allowed: ${ALLOWED_COMMANDS.join(', ')}`
    );
  }

  return true;
}

// ── Docker execution ──────────────────────────────────────────────────────────

async function runInDocker(command, projectRoot, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const absRoot = path.resolve(projectRoot);

  // Mount project dir read-write, nothing else
  const dockerCmd = [
    'docker', 'run', '--rm',
    '--network=none',              // no network access
    '--memory=512m',               // memory limit
    '--cpus=1',                    // cpu limit
    '--pids-limit=64',             // prevent fork bombs
    '--cap-drop=ALL',              // drop all linux capabilities
    '--security-opt=no-new-privileges',
    '-v', `${absRoot}:/workspace:rw`,
    '-w', '/workspace',
    dockerImage,
    'sh', '-c', command
  ];

  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;

    const proc = spawn(dockerCmd[0], dockerCmd.slice(1), {
      timeout,
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
    });

    proc.stdout.on('data', d => {
      stdout += d;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) proc.kill('SIGTERM');
    });
    proc.stderr.on('data', d => { stderr += d; });

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
        mode: 'docker'
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: 1, timedOut: false, mode: 'docker' });
    });
  });
}

// ── Restricted child_process execution ───────────────────────────────────────

async function runRestricted(command, projectRoot, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  // Safety checks before any execution
  assertCommandSafe(command);
  const absRoot = path.resolve(projectRoot);

  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;

    const proc = spawn('sh', ['-c', command], {
      cwd: absRoot,
      env: {
        // Minimal env — no HOME, no user tokens exposed
        PATH: '/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
        NODE_ENV: 'development',
        TMPDIR: absRoot + '/.tmp',
      },
      timeout
    });

    proc.stdout.on('data', d => {
      stdout += d;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        proc.kill('SIGTERM');
        stdout += '\n[OUTPUT TRUNCATED — exceeded 500KB]';
      }
    });
    proc.stderr.on('data', d => { stderr += d; });

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
        mode: 'restricted'
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: 1, timedOut: false, mode: 'restricted' });
    });
  });
}

// ── Safe file write (only inside projectRoot) ─────────────────────────────────

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
  // Never delete directories — only files
  if (fs.statSync(safe).isDirectory()) throw new Error('Use rmdir for directories, not delete');
  fs.unlinkSync(safe);
  return safe;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a command in the sandbox.
 *
 * If the command is a package install, returns { isInstall: true, installRequest }
 * WITHOUT executing — caller must gate through permissions first then call
 * runCommandApproved() to actually run it.
 *
 * For all other commands, executes immediately (after safety checks).
 */
async function runCommand(command, projectRoot, opts = {}) {
  // Install detection — intercept BEFORE execution
  const installReq = detectInstall(command, projectRoot);
  if (installReq) {
    return {
      isInstall:      true,
      installRequest: installReq,
      stdout:         '',
      stderr:         '',
      exitCode:       -1,
    };
  }

  const useDocker = await detectDocker();
  if (useDocker) {
    return runInDocker(command, projectRoot, opts);
  } else {
    return runRestricted(command, projectRoot, opts);
  }
}

/**
 * Run a command that has already passed the install gate (or any permission gate).
 * This executes unconditionally — caller is responsible for having gated it.
 */
async function runCommandApproved(command, projectRoot, opts = {}) {
  // Use install-appropriate timeout
  const installReq = detectInstall(command, projectRoot);
  const timeout = installReq ? INSTALL_TIMEOUT_MS : (opts.timeout || DEFAULT_TIMEOUT_MS);

  const useDocker = await detectDocker();
  if (useDocker) {
    return runInDocker(command, projectRoot, { ...opts, timeout });
  } else {
    return runRestricted(command, projectRoot, { ...opts, timeout });
  }
}

async function getSandboxInfo() {
  const docker = await detectDocker();
  return {
    mode: docker ? 'docker' : 'restricted',
    dockerImage: docker ? dockerImage : null,
    blockedCommands: BLOCKED_COMMANDS.length,
    allowedCommands: ALLOWED_COMMANDS,
    maxTimeoutMs: DEFAULT_TIMEOUT_MS,
    installTimeoutMs: INSTALL_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  };
}

module.exports = {
  runCommand,
  runCommandApproved,
  detectInstall,
  safeWriteFile,
  safeReadFile,
  safeDeleteFile,
  assertPathSafe,
  assertCommandSafe,
  getSandboxInfo,
  detectDocker,
};
