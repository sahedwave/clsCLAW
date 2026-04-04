'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const VERSION = '1.0.0';

function commandExists(command) {
  const result = spawnSync('which', [command], { encoding: 'utf-8' });
  return result.status === 0 && String(result.stdout || '').trim().length > 0;
}

function detectCapabilities(env = process.env, platform = process.platform) {
  const capabilities = {
    platform,
    sandboxExec: platform === 'darwin' && sandboxExecUsable(),
    lima: commandExists('limactl') && Boolean(String(env.CLSCLAW_MICROVM_LIMA_INSTANCE || '').trim()),
    multipass: commandExists('multipass') && Boolean(String(env.CLSCLAW_MICROVM_MULTIPASS_INSTANCE || '').trim()),
  };
  capabilities.available = capabilities.sandboxExec || capabilities.lima || capabilities.multipass;
  capabilities.preferredBackend = resolveBackend('auto', env, capabilities);
  return capabilities;
}

function sandboxExecUsable() {
  if (!commandExists('sandbox-exec')) return false;
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/usr/bin/true'], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  return result.status === 0;
}

function resolveBackend(requested = 'auto', env = process.env, capabilities = detectCapabilities(env)) {
  const explicit = String(env.CLSCLAW_MICROVM_BACKEND || requested || 'auto').trim().toLowerCase();
  if (explicit === 'sandbox-exec' && capabilities.sandboxExec) return 'sandbox-exec';
  if (explicit === 'lima' && capabilities.lima) return 'lima';
  if (explicit === 'multipass' && capabilities.multipass) return 'multipass';
  if (explicit !== 'auto') return null;
  if (capabilities.lima) return 'lima';
  if (capabilities.multipass) return 'multipass';
  if (capabilities.sandboxExec) return 'sandbox-exec';
  return null;
}

function parseCliArgs(argv = []) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function buildSandboxProfile({ workspace, tmpDir }) {
  const escapedWorkspace = escapeSandboxPath(workspace);
  const escapedTmp = escapeSandboxPath(tmpDir);
  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow file-read*)',
    `(allow file-write* (subpath "${escapedWorkspace}") (subpath "${escapedTmp}"))`,
    '(allow sysctl-read)',
  ].join('\n');
}

function escapeSandboxPath(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runWithSandboxExec({ workspace, command, env = process.env }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-microvm-'));
  const profileFile = path.join(tmpDir, 'profile.sb');
  fs.writeFileSync(profileFile, buildSandboxProfile({ workspace, tmpDir }), 'utf-8');
  const proc = spawn('/usr/bin/sandbox-exec', ['-f', profileFile, '/bin/sh', '-lc', command], {
    cwd: workspace,
    env: {
      ...env,
      TMPDIR: tmpDir,
      CLSCLAW_MICROVM_BACKEND: 'sandbox-exec',
    },
    stdio: 'inherit',
  });
  const cleanup = () => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  };
  proc.on('close', cleanup);
  proc.on('error', cleanup);
  return proc;
}

function runWithLima({ workspace, command, env = process.env }) {
  const instance = String(env.CLSCLAW_MICROVM_LIMA_INSTANCE || '').trim();
  if (!instance) throw new Error('CLSCLAW_MICROVM_LIMA_INSTANCE is required for Lima backend');
  return spawn('limactl', ['shell', instance, 'sh', '-lc', `cd ${shellQuote(workspace)} && ${command}`], {
    env: {
      ...env,
      CLSCLAW_MICROVM_BACKEND: 'lima',
    },
    stdio: 'inherit',
  });
}

function runWithMultipass({ workspace, command, env = process.env }) {
  const instance = String(env.CLSCLAW_MICROVM_MULTIPASS_INSTANCE || '').trim();
  if (!instance) throw new Error('CLSCLAW_MICROVM_MULTIPASS_INSTANCE is required for Multipass backend');
  return spawn('multipass', ['exec', instance, '--', 'sh', '-lc', `cd ${shellQuote(workspace)} && ${command}`], {
    env: {
      ...env,
      CLSCLAW_MICROVM_BACKEND: 'multipass',
    },
    stdio: 'inherit',
  });
}

function launchRunner({ workspace, command, backend = 'auto', env = process.env } = {}) {
  const resolvedWorkspace = path.resolve(String(workspace || ''));
  if (!resolvedWorkspace || !fs.existsSync(resolvedWorkspace)) {
    throw new Error('Workspace is required and must exist');
  }
  if (!command || !String(command).trim()) {
    throw new Error('Command is required');
  }
  const capabilities = detectCapabilities(env);
  const selectedBackend = resolveBackend(backend, env, capabilities);
  if (!selectedBackend) {
    throw new Error('No microvm runner backend is available on this machine');
  }
  if (selectedBackend === 'sandbox-exec') {
    return { backend: selectedBackend, proc: runWithSandboxExec({ workspace: resolvedWorkspace, command, env }) };
  }
  if (selectedBackend === 'lima') {
    return { backend: selectedBackend, proc: runWithLima({ workspace: resolvedWorkspace, command, env }) };
  }
  if (selectedBackend === 'multipass') {
    return { backend: selectedBackend, proc: runWithMultipass({ workspace: resolvedWorkspace, command, env }) };
  }
  throw new Error(`Unsupported backend: ${selectedBackend}`);
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

async function main(argv = process.argv.slice(2), io = process) {
  const args = parseCliArgs(argv);
  if (args.version) {
    io.stdout.write(`clsclaw-microvm-run ${VERSION}\n`);
    return 0;
  }
  if (args.capabilities) {
    io.stdout.write(`${JSON.stringify(detectCapabilities(io.env || process.env), null, 2)}\n`);
    return 0;
  }
  if (args['self-test']) {
    const capabilities = detectCapabilities(io.env || process.env);
    io.stdout.write(`${capabilities.available ? 'ok' : 'unavailable'}\n`);
    return capabilities.available ? 0 : 1;
  }
  const workspace = args.workspace || args['project-root'] || '';
  const command = args.command || '';
  const backend = args.backend || 'auto';
  const { proc } = launchRunner({ workspace, command, backend, env: io.env || process.env });
  return await new Promise((resolve) => {
    proc.on('close', (code) => resolve(code || 0));
    proc.on('error', () => resolve(1));
  });
}

module.exports = {
  VERSION,
  parseCliArgs,
  detectCapabilities,
  resolveBackend,
  buildSandboxProfile,
  launchRunner,
  main,
};
