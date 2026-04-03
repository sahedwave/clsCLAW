

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');





const INSTALL_PATTERNS = [
  
  { re: /^npm\s+(?:install|i|add)\s+([\s\S]+)$/i,         manager: 'npm',   action: 'install' },
  
  { re: /^npm\s+(?:install|i)\s*$/i,                       manager: 'npm',   action: 'install-all', packages: [] },
  
  { re: /^npm\s+ci\s*$/i,                                  manager: 'npm',   action: 'ci', packages: [] },
  
  { re: /^yarn\s+add\s+([\s\S]+)$/i,                       manager: 'yarn',  action: 'install' },
  
  { re: /^yarn\s*$/i,                                      manager: 'yarn',  action: 'install-all', packages: [] },
  
  { re: /^pnpm\s+add\s+([\s\S]+)$/i,                       manager: 'pnpm',  action: 'install' },
  
  { re: /^pnpm\s+install\s*$/i,                            manager: 'pnpm',  action: 'install-all', packages: [] },
  
  { re: /^pip[23]?\s+install\s+-r\s+\S+/i,                manager: 'pip',   action: 'requirements', packages: [] },
  
  { re: /^pip[23]?\s+install\s+([\s\S]+)$/i,               manager: 'pip',   action: 'install' },
  
  { re: /^cargo\s+add\s+([\s\S]+)$/i,                      manager: 'cargo', action: 'install' },
  
  { re: /^go\s+get\s+([\s\S]+)$/i,                         manager: 'go',    action: 'install' },
];


const RISK_SIGNALS = [
  { pattern: /^\.\/|^\.\.\//,         label: 'Local path install',      severity: 'warn' },
  { pattern: /github\.com\//,         label: 'Direct GitHub URL',       severity: 'warn' },
  { pattern: /http[s]?:\/\//,         label: 'Remote URL install',      severity: 'high' },
  { pattern: /--global|-g\b/,         label: 'Global install',          severity: 'high' },
  { pattern: /--unsafe-perm/,         label: 'Unsafe permissions flag', severity: 'high' },
  { pattern: /\beval\b/,              label: 'Contains eval',           severity: 'high' },
  { pattern: /postinstall/,           label: 'Postinstall script',      severity: 'warn' },
  { pattern: /^@[^/]+\/[^@]+@.+/,    label: 'Scoped package with version pinned', severity: 'info' },
];


const KNOWN_MALICIOUS = new Set([
  'crossenv', 'cross-env.js', 'd3.js', 'ffmepg', 'coockiejar',
  'node-opencv', 'node-openssl', 'nodecaffe', 'nodesass', 'nodesqlite',
  'bcrypt.js', 'babelcli', 'eslint-scope-hack', 'event-stream-hack',
]);




function detectInstall(command, projectRoot) {
  const trimmed = command.trim();

  for (const pat of INSTALL_PATTERNS) {
    const m = trimmed.match(pat.re);
    if (!m) continue;

    
    if (pat.packages !== undefined) {
      return buildRequest(pat.manager, pat.action, pat.packages, command, projectRoot);
    }

    
    const pkgsStr = m[1] || '';
    const packages = parsePackageList(pkgsStr, pat.manager);
    return buildRequest(pat.manager, pat.action, packages, command, projectRoot);
  }

  return null; 
}

function parsePackageList(pkgsStr, manager) {
  
  const tokens = pkgsStr.split(/\s+/).filter(t => t && !t.startsWith('-'));

  return tokens.map(token => {
    let name = token, version = 'latest', registry = null;

    if (manager === 'npm' || manager === 'yarn' || manager === 'pnpm') {
      
      const scopedM = token.match(/^(@[^@/]+\/[^@]+)(?:@(.+))?$/);
      const plainM  = token.match(/^([^@][^@]*)(?:@(.+))?$/);
      if (scopedM) { name = scopedM[1]; version = scopedM[2] || 'latest'; }
      else if (plainM) { name = plainM[1]; version = plainM[2] || 'latest'; }
      
      if (token.includes('/') && !token.startsWith('@') && !token.startsWith('http')) {
        registry = 'github';
      }
    } else if (manager === 'pip') {
      
      const pipM = token.match(/^([A-Za-z0-9_.-]+)([>=<!]+.*)?$/);
      if (pipM) { name = pipM[1]; version = pipM[2] || 'latest'; }
    } else if (manager === 'cargo') {
      const cargoM = token.match(/^([^@]+)(?:@(.+))?$/);
      if (cargoM) { name = cargoM[1]; version = cargoM[2] || 'latest'; }
    }

    return { name, version, registry };
  }).filter(p => p.name);
}

function buildRequest(manager, action, packages, rawCommand, projectRoot) {
  
  const risks = [];

  for (const { pattern, label, severity } of RISK_SIGNALS) {
    if (pattern.test(rawCommand)) {
      risks.push({ label, severity });
    }
  }

  
  for (const pkg of packages) {
    if (KNOWN_MALICIOUS.has(pkg.name.toLowerCase())) {
      risks.push({ label: `⚠ Known malicious package: ${pkg.name}`, severity: 'critical' });
    }
  }

  const manifestInfo = readManifestInfo(projectRoot, manager);

  const maxSeverity = risks.reduce((max, r) => {
    const order = { critical: 4, high: 3, warn: 2, info: 1, none: 0 };
    return (order[r.severity] || 0) > (order[max] || 0) ? r.severity : max;
  }, 'none');

  return {
    manager,
    action,
    packages,
    rawCommand,
    risks,
    maxSeverity,
    manifestInfo,
    isInstallAll: action === 'install-all' || action === 'ci' || action === 'requirements',
  };
}

function readManifestInfo(projectRoot, manager) {
  if (!projectRoot) return null;
  try {
    if (manager === 'npm' || manager === 'yarn' || manager === 'pnpm') {
      const pkgPath = path.join(projectRoot, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return {
          name:    pkg.name || '(unnamed)',
          version: pkg.version || '?',
          deps:    Object.keys(pkg.dependencies || {}).length,
          devDeps: Object.keys(pkg.devDependencies || {}).length,
        };
      }
    } else if (manager === 'pip') {
      const reqPath = path.join(projectRoot, 'requirements.txt');
      if (fs.existsSync(reqPath)) {
        const lines = fs.readFileSync(reqPath, 'utf-8').split('\n')
          .filter(l => l.trim() && !l.startsWith('#'));
        return { requirementsCount: lines.length };
      }
    }
  } catch {}
  return null;
}

module.exports = { detectInstall };
