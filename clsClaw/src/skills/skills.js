

'use strict';

const { runCommand } = require('../sandbox/sandbox');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const {
  readIdentityFiles,
  ensureIdentityFiles,
} = require('../workspaceIdentity');



const SKILLS = [

  {
    id: 'security-audit',
    name: 'Security audit',
    icon: '🔒',
    category: 'inspect',
    description: 'Scan for hardcoded secrets, insecure patterns, and common vulnerabilities',
    async execute(projectRoot) {
      const findings = [];
      const PATTERNS = [
        { re: /(?:password|passwd|pwd)\s*=\s*['"][^'"]{3,}/gi, label: 'Hardcoded password' },
        { re: /(?:api_?key|apikey|secret|token)\s*=\s*['"][^'"]{8,}/gi, label: 'Hardcoded secret/key' },
        { re: /eval\s*\(/g, label: 'Use of eval()' },
        { re: /exec\s*\(/g, label: 'Use of exec()' },
        { re: /innerHTML\s*=/g, label: 'innerHTML assignment (XSS risk)' },
        { re: /document\.write\s*\(/g, label: 'document.write (XSS risk)' },
        { re: /http:\/\/(?!localhost)/g, label: 'Plain HTTP URL (use HTTPS)' },
        { re: /Math\.random\s*\(\)/g, label: 'Math.random() not cryptographically secure' },
        { re: /(?:SELECT|INSERT|UPDATE|DELETE).+\+\s*(?:req\.|params\.|body\.)/gi, label: 'Possible SQL injection' },
      ];

      const files = walkForAudit(projectRoot);
      for (const filePath of files) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const rel = path.relative(projectRoot, filePath);
          for (const { re, label } of PATTERNS) {
            const matches = content.match(re);
            if (matches) {
              
              const lines = content.split('\n');
              const lineNos = [];
              lines.forEach((line, i) => {
                if (re.test(line)) lineNos.push(i + 1);
                re.lastIndex = 0;
              });
              findings.push({ file: rel, issue: label, occurrences: matches.length, lines: lineNos.slice(0, 5) });
            }
            re.lastIndex = 0;
          }
        } catch {  }
      }

      
      let npmAudit = null;
      if (fs.existsSync(path.join(projectRoot, 'package.json'))) {
        try {
          const { stdout } = await execAsync('npm audit --json 2>/dev/null', { cwd: projectRoot, timeout: 30000 });
          const parsed = JSON.parse(stdout);
          npmAudit = { vulnerabilities: parsed.metadata?.vulnerabilities };
        } catch { npmAudit = { error: 'npm audit not available or failed' }; }
      }

      return {
        skill: 'security-audit',
        findings,
        npmAudit,
        summary: `Found ${findings.length} potential security issues across ${files.length} files`,
      };
    }
  },

  {
    id: 'heartbeat-review',
    name: 'Heartbeat review',
    icon: '💓',
    category: 'inspect',
    description: 'Review HEARTBEAT.md and identity files for unattended follow-up',
    async execute(projectRoot) {
      const before = readIdentityFiles(projectRoot, { includeContent: true });
      const missingIdentity = before.filter((file) => !file.exists).map((file) => file.name);
      if (missingIdentity.length > 0) ensureIdentityFiles(projectRoot, missingIdentity);
      const files = readIdentityFiles(projectRoot, { includeContent: true });
      const heartbeat = files.find((file) => file.name === 'HEARTBEAT.md');
      const pendingTasks = [];

      for (const line of String(heartbeat?.content || '').split('\n')) {
        const match = line.match(/^- \[ \]\s+(.+)$/);
        if (match) pendingTasks.push(match[1].trim());
      }
      const findings = [];

      if (missingIdentity.length > 0) {
        findings.push({
          file: 'workspace',
          issue: 'Missing identity files',
          occurrences: missingIdentity.length,
          lines: [],
          detail: missingIdentity.join(', '),
        });
      }

      for (const task of pendingTasks) {
        findings.push({
          file: 'HEARTBEAT.md',
          issue: task,
          occurrences: 1,
          lines: [],
        });
      }

      return {
        skill: 'heartbeat-review',
        findings,
        summary: pendingTasks.length
          ? `Heartbeat found ${pendingTasks.length} outstanding task(s)`
          : 'Heartbeat check completed with no open checklist items',
      };
    },
  },

  {
    id: 'run-tests',
    name: 'Run tests',
    icon: '🧪',
    category: 'execute',
    description: 'Detect and run project test suite',
    async execute(projectRoot) {
      const pkg = path.join(projectRoot, 'package.json');
      let testCmd = null;

      if (fs.existsSync(pkg)) {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
        if (parsed.scripts?.test) testCmd = 'npm test';
      }
      if (!testCmd && fs.existsSync(path.join(projectRoot, 'pytest.ini'))) testCmd = 'python -m pytest';
      if (!testCmd && fs.existsSync(path.join(projectRoot, 'Makefile'))) testCmd = 'make test';

      if (!testCmd) {
        return { skill: 'run-tests', output: 'No test runner detected', exitCode: -1 };
      }

      const result = await runCommand(testCmd, projectRoot, { timeout: 60000 });
      return { skill: 'run-tests', command: testCmd, ...result };
    }
  },

  {
    id: 'lint',
    name: 'Lint code',
    icon: '🔍',
    category: 'inspect',
    description: 'Run ESLint or pylint on the project',
    async execute(projectRoot) {

      let lintCmd = null;
      if (fs.existsSync(path.join(projectRoot, '.eslintrc.js')) ||
          fs.existsSync(path.join(projectRoot, '.eslintrc.json')) ||
          fs.existsSync(path.join(projectRoot, 'eslint.config.js'))) {
        lintCmd = 'npx eslint . --max-warnings=50 --format=compact 2>&1 | head -100';
      } else if (fs.existsSync(path.join(projectRoot, '.pylintrc'))) {
        lintCmd = 'python -m pylint **/*.py --output-format=text 2>&1 | head -100';
      }

      if (!lintCmd) {
        return { skill: 'lint', output: 'No linter config detected (.eslintrc, .pylintrc)', exitCode: -1 };
      }

      const result = await runCommand(lintCmd, projectRoot, { timeout: 30000 });
      return { skill: 'lint', command: lintCmd, ...result };
    }
  },

  {
    id: 'dependency-check',
    name: 'Check dependencies',
    icon: '📦',
    category: 'inspect',
    description: 'List outdated packages and check for known vulnerabilities',
    async execute(projectRoot) {
      const results = {};
      if (fs.existsSync(path.join(projectRoot, 'package.json'))) {
        try {
          const { stdout: outdated } = await execAsync('npm outdated --json 2>/dev/null || true', { cwd: projectRoot, timeout: 30000 });
          try { results.npmOutdated = JSON.parse(outdated); } catch { results.npmOutdated = outdated; }
        } catch { results.npmError = 'npm outdated failed'; }
      }
      if (fs.existsSync(path.join(projectRoot, 'requirements.txt'))) {
        try {
          const { stdout } = await execAsync('pip list --outdated --format=columns 2>&1 | head -30', { cwd: projectRoot, timeout: 20000 });
          results.pipOutdated = stdout;
        } catch { results.pipError = 'pip check failed'; }
      }
      return { skill: 'dependency-check', results, summary: 'Dependency analysis complete' };
    }
  },

  {
    id: 'file-stats',
    name: 'Project stats',
    icon: '📊',
    category: 'inspect',
    description: 'Count lines of code, files, languages',
    async execute(projectRoot) {
      const stats = { byExtension: {}, totalFiles: 0, totalLines: 0, totalSize: 0 };
      const files = walkForAudit(projectRoot);
      for (const f of files) {
        try {
          const ext = path.extname(f) || 'no-ext';
          const content = fs.readFileSync(f, 'utf-8');
          const lines = content.split('\n').length;
          const size = fs.statSync(f).size;
          if (!stats.byExtension[ext]) stats.byExtension[ext] = { files: 0, lines: 0, size: 0 };
          stats.byExtension[ext].files++;
          stats.byExtension[ext].lines += lines;
          stats.byExtension[ext].size += size;
          stats.totalFiles++;
          stats.totalLines += lines;
          stats.totalSize += size;
        } catch {}
      }
      return { skill: 'file-stats', stats };
    }
  },

  {
    id: 'git-log',
    name: 'Recent git history',
    icon: '📜',
    category: 'git',
    description: 'Show recent commits and changed files',
    async execute(projectRoot) {
      try {
        const { stdout: log } = await execAsync(
          'git log --oneline --graph --decorate -20',
          { cwd: projectRoot, timeout: 5000 }
        );
        const { stdout: status } = await execAsync(
          'git status --short',
          { cwd: projectRoot, timeout: 5000 }
        );
        return { skill: 'git-log', log: log.trim(), status: status.trim() };
      } catch (err) {
        return { skill: 'git-log', error: 'Not a git repo or git unavailable: ' + err.message };
      }
    }
  },

  {
    id: 'write-tests',
    name: 'Write tests',
    icon: '🧪',
    category: 'build',
    description: 'Detect test framework, extract exported functions, generate real test files',
    async execute(projectRoot) {

      const framework = detectTestFramework(projectRoot);
      if (!framework) {
        return { skill: 'write-tests', ok: false, error: 'No test framework detected. Install jest, mocha, or pytest first.' };
      }

      const sourceFiles = walkForAudit(projectRoot).filter(f => {
        const ext = path.extname(f);
        const rel = path.relative(projectRoot, f);

        if (/\.(test|spec)\.[jt]sx?$/.test(f)) return false;
        if (rel.includes('__tests__') || rel.includes('/test/') || rel.includes('/tests/')) return false;
        return ['.js', '.ts', '.jsx', '.tsx', '.py'].includes(ext);
      });

      const fileProposals = [];
      const skipped = [];

      for (const srcFile of sourceFiles.slice(0, 15)) {
        try {
          const content = fs.readFileSync(srcFile, 'utf-8');
          const ext = path.extname(srcFile);
          const isPy  = ext === '.py';

          const symbols = extractSymbols(content, ext);
          if (symbols.length === 0) { skipped.push(path.relative(projectRoot, srcFile)); continue; }

          const testPath = isPy
            ? path.join(path.dirname(srcFile), 'test_' + path.basename(srcFile))
            : path.join(
                path.dirname(srcFile),
                path.basename(srcFile, ext) + '.test' + ext
              );

          if (fs.existsSync(testPath)) { skipped.push(path.relative(projectRoot, testPath) + ' (exists)'); continue; }

          const relSrc = path.relative(projectRoot, srcFile);
          const testContent = isPy
            ? generatePytestFile(relSrc, symbols)
            : generateJestFile(relSrc, symbols, framework, ext);

          fileProposals.push({
            filePath:    testPath,
            content:     testContent,
            description: `Generated ${framework} tests for ${path.basename(srcFile)} (${symbols.length} function${symbols.length!==1?'s':''})`,
          });
        } catch { skipped.push(path.relative(projectRoot, srcFile)); }
      }

      return {
        skill:         'write-tests',
        ok:            true,
        framework,
        fileProposals,
        skipped,
        summary:       `Generated ${fileProposals.length} test file(s) using ${framework}`,
      };
    }
  },

  {
    id: 'generate-docs',
    name: 'Generate docs',
    icon: '📝',
    category: 'build',
    description: 'Generate README.md and add JSDoc/docstring comments to undocumented functions',
    async execute(projectRoot) {
      const fileProposals = [];

      const readmePath = path.join(projectRoot, 'README.md');
      const readmeContent = generateReadme(projectRoot);
      fileProposals.push({
        filePath:    readmePath,
        content:     readmeContent,
        description: 'Generated README.md from project structure',
      });

      const jsFiles = walkForAudit(projectRoot).filter(f =>
        ['.js', '.ts', '.jsx', '.tsx'].includes(path.extname(f)) &&
        !f.includes('node_modules') && !f.includes('.test.') && !f.includes('.spec.')
      ).slice(0, 20);

      for (const filePath of jsFiles) {
        try {
          const original = fs.readFileSync(filePath, 'utf-8');
          const documented = addJsDocComments(original);
          if (documented !== original) {
            fileProposals.push({
              filePath,
              content:     documented,
              description: `Added JSDoc comments to ${path.basename(filePath)}`,
            });
          }
        } catch {}
      }

      const pyFiles = walkForAudit(projectRoot).filter(f =>
        path.extname(f) === '.py' && !f.includes('test_')
      ).slice(0, 10);

      for (const filePath of pyFiles) {
        try {
          const original = fs.readFileSync(filePath, 'utf-8');
          const documented = addPythonDocstrings(original);
          if (documented !== original) {
            fileProposals.push({
              filePath,
              content:     documented,
              description: `Added docstrings to ${path.basename(filePath)}`,
            });
          }
        } catch {}
      }

      return {
        skill:        'generate-docs',
        ok:           true,
        fileProposals,
        summary:      `Generated ${fileProposals.length} documentation file(s)/change(s)`,
      };
    }
  },

  {
    id: 'migrate',
    name: 'Migrate & modernise',
    icon: '🚀',
    category: 'rewrite',
    description: 'Upgrade deprecated patterns: var→const/let, callbacks→promises, require→import where safe',
    async execute(projectRoot) {
      const fileProposals = [];
      const report = [];

      const jsFiles = walkForAudit(projectRoot).filter(f =>
        ['.js', '.mjs'].includes(path.extname(f)) &&
        !f.includes('node_modules') && !f.includes('.min.') &&
        !f.includes('.test.') && !f.includes('.spec.')
      ).slice(0, 30);

      for (const filePath of jsFiles) {
        try {
          const original = fs.readFileSync(filePath, 'utf-8');
          const result   = migrateJs(original, filePath);

          if (result.changed) {
            fileProposals.push({
              filePath,
              content:     result.content,
              description: `Migrated ${path.basename(filePath)}: ${result.changes.join(', ')}`,
            });
            report.push({
              file:    path.relative(projectRoot, filePath),
              changes: result.changes,
            });
          }
        } catch {}
      }

      const pyFiles = walkForAudit(projectRoot).filter(f =>
        path.extname(f) === '.py' && !f.includes('test_')
      ).slice(0, 15);

      for (const filePath of pyFiles) {
        try {
          const original = fs.readFileSync(filePath, 'utf-8');
          const result   = migratePy(original);

          if (result.changed) {
            fileProposals.push({
              filePath,
              content:     result.content,
              description: `Migrated ${path.basename(filePath)}: ${result.changes.join(', ')}`,
            });
            report.push({
              file:    path.relative(projectRoot, filePath),
              changes: result.changes,
            });
          }
        } catch {}
      }

      return {
        skill:        'migrate',
        ok:           true,
        fileProposals,
        report,
        summary:      `${fileProposals.length} file(s) modernised across ${jsFiles.length + pyFiles.length} scanned`,
      };
    }
  },

];


const IGNORE_DIRS = new Set(['node_modules', '.git', '__pycache__', 'dist', 'build', '.clsclaw-worktrees']);
const AUDIT_EXTS  = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.php', '.go', '.rs', '.java', '.cs']);

function walkForAudit(dir, depth = 0) {
  if (depth > 8) return [];
  let results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) results = results.concat(walkForAudit(fp, depth + 1));
    else if (AUDIT_EXTS.has(path.extname(e.name).toLowerCase())) results.push(fp);
  }
  return results.slice(0, 200);
}


function detectTestFramework(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.jest || pkg.jest)   return 'jest';
      if (deps.vitest)             return 'vitest';
      if (deps.mocha)              return 'mocha';
      if (pkg.scripts?.test?.includes('jest'))   return 'jest';
      if (pkg.scripts?.test?.includes('mocha'))  return 'mocha';
      if (pkg.scripts?.test?.includes('vitest')) return 'vitest';
    } catch {}
  }
  if (fs.existsSync(path.join(projectRoot, 'pytest.ini')) ||
      fs.existsSync(path.join(projectRoot, 'setup.cfg'))  ||
      fs.existsSync(path.join(projectRoot, 'pyproject.toml'))) return 'pytest';
  if (walkForAudit(projectRoot).some(f => f.endsWith('.py'))) return 'pytest';
  return 'jest'; // default for JS projects
}

function extractSymbols(content, ext) {
  const symbols = [];
  const isPy = ext === '.py';

  if (isPy) {

    const re = /^def\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)/gm;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (!m[1].startsWith('_')) { // skip private
        symbols.push({ name: m[1], params: m[2].split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean), type: 'function' });
      }
    }

    const classRe = /^class\s+([A-Z]\w*)/gm;
    while ((m = classRe.exec(content)) !== null) {
      symbols.push({ name: m[1], params: [], type: 'class' });
    }
  } else {

    const patterns = [
      /export\s+(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z_$]\w*)\s*\(([^)]*)\)/g,
      /export\s+const\s+([a-zA-Z_$]\w*)\s*=\s*(?:async\s*)?\(([^)]*)\)/g,
      /export\s+const\s+([a-zA-Z_$]\w*)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/g,

      /^(?:async\s+)?function\s+([a-zA-Z_$]\w*)\s*\(([^)]*)\)/gm,
      /^const\s+([a-zA-Z_$]\w*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/gm,
    ];
    const seen = new Set();
    for (const re of patterns) {
      let m;
      while ((m = re.exec(content)) !== null) {
        if (!seen.has(m[1]) && m[1] !== 'if' && m[1] !== 'while' && m[1] !== 'for') {
          seen.add(m[1]);
          const params = m[2] ? m[2].split(',').map(p => p.trim().split('=')[0].split(':')[0].trim()).filter(Boolean) : [];
          symbols.push({ name: m[1], params, type: 'function' });
        }
      }
    }

    const classRe = /(?:export\s+)?class\s+([A-Z]\w*)/g;
    let m;
    while ((m = classRe.exec(content)) !== null) {
      if (!seen.has(m[1])) { seen.add(m[1]); symbols.push({ name: m[1], params: [], type: 'class' }); }
    }
  }

  return symbols.slice(0, 20);
}

function generateJestFile(relSrcPath, symbols, framework, ext) {
  const importPath = './' + path.basename(relSrcPath, ext);
  const importLine = framework === 'jest' || framework === 'vitest'
    ? `import { ${symbols.filter(s=>s.type==='function').map(s=>s.name).join(', ')} } from '${importPath}';`
    : `const { ${symbols.filter(s=>s.type==='function').map(s=>s.name).join(', ')} } = require('${importPath}');`;

  const describeLabel = path.basename(relSrcPath, ext);
  const testBlocks = symbols.map(sym => {
    if (sym.type === 'class') {
      return `  describe('${sym.name}', () => {
    it('should instantiate correctly', () => {
      const instance = new ${sym.name}();
      expect(instance).toBeDefined();
    });
  });`;
    }
    const args = sym.params.map(p => {
      if (p.includes('str') || p.includes('name') || p.includes('text') || p.includes('msg')) return `'test'`;
      if (p.includes('num') || p.includes('count') || p.includes('size') || p.includes('id')) return `1`;
      if (p.includes('arr') || p.includes('list') || p.includes('items')) return `[]`;
      if (p.includes('obj') || p.includes('data') || p.includes('options') || p.includes('config')) return `{}`;
      if (p.includes('bool') || p.includes('flag') || p.includes('enabled')) return `true`;
      return `undefined`;
    }).join(', ');

    return `  describe('${sym.name}()', () => {
    it('should be defined', () => {
      expect(${sym.name}).toBeDefined();
    });

    it('should return a value when called with valid arguments', () => {
      const result = ${sym.name}(${args});
      
      expect(result).toBeDefined();
    });

    it('should handle edge cases', () => {
      
      expect(() => ${sym.name}(${args})).not.toThrow();
    });
  });`;
  }).join('\n\n');

  return `



${importLine}

describe('${describeLabel}', () => {
${testBlocks}
});
`;
}

function generatePytestFile(relSrcPath, symbols) {
  const moduleName = path.basename(relSrcPath, '.py').replace(/-/g, '_');
  const importLine = `from ${moduleName} import ${symbols.filter(s=>s.type==='function').slice(0,10).map(s=>s.name).join(', ')}`;

  const testFunctions = symbols.map(sym => {
    if (sym.type === 'class') {
      return `class Test${sym.name}:
    def test_instantiation(self):
        """Test that ${sym.name} can be instantiated."""
        # TODO: add constructor arguments if needed
        pass`;
    }
    const args = sym.params
      .filter(p => p && p !== 'self' && p !== 'cls' && !p.startsWith('*'))
      .map(p => {
        if (p.includes('str') || p.includes('name') || p.includes('text')) return `"test"`;
        if (p.includes('num') || p.includes('count') || p.includes('n')) return `1`;
        if (p.includes('list') || p.includes('arr') || p.includes('items')) return `[]`;
        if (p.includes('dict') || p.includes('data') || p.includes('config')) return `{}`;
        return `None`;
      }).join(', ');

    return `def test_${sym.name}_basic():
    """Test basic functionality of ${sym.name}."""
    result = ${sym.name}(${args})
    # TODO: replace with specific assertion
    assert result is not None

def test_${sym.name}_edge_cases():
    """Test edge cases for ${sym.name}."""
    # TODO: add edge case tests
    pass`;
  }).join('\n\n');

  return `# SAVE_AS: ${path.dirname(relSrcPath)}/test_${path.basename(relSrcPath)}
# Auto-generated by clsClaw write-tests skill
# Review and customise each test before running

import pytest
${importLine}


${testFunctions}
`;
}


function generateReadme(projectRoot) {
  let name = path.basename(projectRoot);
  let description = '';
  let stack = [];
  let scripts = {};
  let hasTests = false;

  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      name        = pkg.name || name;
      description = pkg.description || '';
      scripts     = pkg.scripts || {};
      const deps  = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.react)      stack.push('React');
      if (deps.vue)        stack.push('Vue');
      if (deps.express)    stack.push('Express');
      if (deps.fastify)    stack.push('Fastify');
      if (deps.next)       stack.push('Next.js');
      if (deps.typescript) stack.push('TypeScript');
      if (deps.jest || deps.vitest || deps.mocha) { stack.push(deps.vitest ? 'Vitest' : deps.jest || pkg.jest ? 'Jest' : 'Mocha'); hasTests = true; }
    } catch {}
  }

  if (fs.existsSync(path.join(projectRoot, 'requirements.txt'))) stack.push('Python');
  if (fs.existsSync(path.join(projectRoot, 'pytest.ini')))        hasTests = true;

  const files = walkForAudit(projectRoot);
  const byExt = {};
  for (const f of files) {
    const ext = path.extname(f) || 'other';
    byExt[ext] = (byExt[ext] || 0) + 1;
  }

  const scriptSection = Object.keys(scripts).length > 0
    ? `## Scripts\n\n${Object.entries(scripts).map(([k,v]) => `- \`npm run ${k}\` — ${v}`).join('\n')}\n`
    : '';

  const stackSection = stack.length > 0
    ? `## Tech stack\n\n${stack.map(s => `- ${s}`).join('\n')}\n`
    : '';

  const fileSection = Object.keys(byExt).length > 0
    ? `## Project structure\n\n${Object.entries(byExt).sort((a,b)=>b[1]-a[1]).map(([ext,count])=>`- \`${ext}\` — ${count} file${count!==1?'s':''}`).join('\n')}\n`
    : '';

  const testSection = hasTests
    ? `## Testing\n\n\`\`\`bash\nnpm test\n\`\`\`\n`
    : '';

  return `# ${name}

${description || '_Add a description here._'}

## Installation

\`\`\`bash
npm install
\`\`\`

## Usage

\`\`\`bash
npm start
\`\`\`

${scriptSection}${stackSection}${fileSection}${testSection}
---
_README generated by clsClaw generate-docs skill on ${new Date().toISOString().slice(0,10)}_
`;
}

function addJsDocComments(content) {

  const lines = content.split('\n');
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$]\w*)\s*\(([^)]*)\)/);
    const arrowMatch = line.match(/^(?:export\s+)?const\s+([a-zA-Z_$]\w*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/);

    const match = funcMatch || arrowMatch;
    if (match) {

      const prevLine = output[output.length - 1] || '';
      const prevPrev = output[output.length - 2] || '';
      const hasJsDoc = prevLine.trim() === '*/' || prevLine.trim().startsWith('*') || prevPrev.trim() === '*/';

      if (!hasJsDoc) {
        const funcName  = match[1];
        const paramsStr = match[2] || '';
        const params    = paramsStr.split(',').map(p => p.trim().split(/[=:]/)[0].trim()).filter(p => p && !p.startsWith('...'));
        const indent    = line.match(/^(\s*)/)[1];

        const paramLines = params.map(p => `${indent} * @param {*} ${p}`).join('\n');
        const jsdoc = [
          `${indent}`,
        ].join('\n');

        output.push(jsdoc);
      }
    }

    output.push(line);
    i++;
  }

  return output.join('\n');
}

function addPythonDocstrings(content) {

  const lines  = content.split('\n');
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    output.push(line);

    const defMatch = line.match(/^(\s*)def\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*(?:->.*?)?:\s*$/);
    if (defMatch) {
      const nextLine = lines[i + 1] || '';
      const hasDocstring = nextLine.trim().startsWith('"""') || nextLine.trim().startsWith("'''");

      if (!hasDocstring) {
        const indent  = defMatch[1] + '    ';
        const name    = defMatch[2];
        const rawParams = defMatch[3].split(',')
          .map(p => p.trim().split(':')[0].split('=')[0].trim())
          .filter(p => p && p !== 'self' && p !== 'cls' && !p.startsWith('*'));

        const paramLines = rawParams.map(p => `${indent}    ${p}: Description of ${p}`).join('\n');
        const docstring = rawParams.length > 0
          ? `${indent}"""${name}\n\n${indent}Args:\n${paramLines}\n\n${indent}Returns:\n${indent}    Description of return value\n${indent}"""`
          : `${indent}"""${name}."""`;

        output.push(docstring);
      }
    }

    i++;
  }

  return output.join('\n');
}


function migrateJs(content, filePath) {

  const isCommonJs = content.includes('module.exports');

  let result  = content;
  const changes = [];

  const varLines = result.split('\n');
  const varConverted = varLines.map(line => {

    if (/^\s*var\s+[a-zA-Z_$]/.test(line) && !/for\s*\(/.test(line)) {

      return line.replace(/^(\s*)var\s+/, '$1const ');
    }
    return line;
  });
  const varResult = varConverted.join('\n');
  if (varResult !== result) {
    const count = (result.match(/^\s*var\s+/gm) || []).length;
    changes.push(`${count} var→const`);
    result = varResult;
  }


  if (/new Promise\s*\(/.test(content) === false && /callback/.test(content)) {

    result = result.replace(
      /\/\/ TODO.*callback.*promise/gi,
      '// TODO: consider migrating callbacks to async/await'
    );
  }


  const beforeTpl = result;
  result = result.replace(
    /'([^'\\]*)'\s*\+\s*([a-zA-Z_$]\w*(?:\.[a-zA-Z_$]\w*)*)\s*\+\s*'([^'\\]*)'/g,
    (_, pre, varName, post) => `\`${pre}\${${varName}}${post}\``
  );
  if (result !== beforeTpl) {
    const count = (beforeTpl.match(/'[^'\\]*'\s*\+\s*[a-zA-Z_$]/g) || []).length;
    changes.push(`${count} string concat→template literal`);
  }

  const beforeEq = result;
  result = result.replace(/([^=!<>])([^=!<>])==([^=])/g, (m, a, b, c) => {

    if (c.trim().startsWith('null') || c.trim().startsWith('undefined')) return m;
    return `${a}${b}===${c}`;
  });
  if (result !== beforeEq) {
    changes.push('== → ===');
  }

  if (!filePath.includes('test') && !filePath.includes('debug') && (content.match(/console\.log/g)||[]).length > 3) {
    changes.push(`${(content.match(/console\.log/g)||[]).length} console.log calls (consider removing in production)`);
  }

  return { content: result, changed: changes.length > 0, changes };
}

function migratePy(content) {
  let result  = content;
  const changes = [];

  const beforeFmt = result;
  result = result.replace(
    /"([^"]*?)"\s*%\s*\(([^)]+)\)/g,
    (_, template, args) => {

      const parts = args.split(',').map(a => a.trim());
      let i = 0;
      const converted = template.replace(/%[sd]/g, () => `{${parts[i++] || '?'}}`);
      return `f"${converted}"`;
    }
  );
  if (result !== beforeFmt) {
    changes.push('%-style string formatting → f-strings');
  }

  const beforePrint = result;
  result = result.replace(/^(\s*)print\s+(?![(])(.+)$/gm, (_, indent, args) => {
    return `${indent}print(${args.trim()})`;
  });
  if (result !== beforePrint) {
    changes.push('print statement → print()');
  }

  const beforeExcept = result;
  result = result.replace(/except\s+(\w+)\s*,\s*(\w+)\s*:/g, 'except $1 as $2:');
  if (result !== beforeExcept) {
    changes.push('except X, e → except X as e');
  }

  const beforeRange = result;
  result = result.replace(/\bxrange\s*\(/g, 'range(');
  if (result !== beforeRange) {
    changes.push('xrange → range');
  }

  return { content: result, changed: changes.length > 0, changes };
}


class SkillRegistry {
  constructor() {
    this._skills = new Map(SKILLS.map(s => [s.id, s]));
    this._extensionManager = null;
  }

  setExtensionManager(extensionManager) {
    this._extensionManager = extensionManager;
  }

  list() {
    const core = SKILLS.map(({ id, name, icon, category, description }) => ({
      id, name, icon, category, description, source: 'core', pluginId: null, pluginName: null,
    }));
    const installed = this._extensionManager ? this._extensionManager.listInstalledSkills() : [];
    return [...core, ...installed];
  }

  get(id) {
    return this._skills.get(id) || null;
  }

  async runCore(skillId, projectRoot) {
    const skill = this.get(skillId);
    if (!skill) throw new Error(`Unknown skill: ${skillId}`);
    const startTime = Date.now();
    try {
      const result = await skill.execute(projectRoot);
      return { ...result, durationMs: Date.now() - startTime, ok: true };
    } catch (err) {
      return { skill: skillId, error: err.message, ok: false, durationMs: Date.now() - startTime };
    }
  }

  async run(skillId, projectRoot) {
    const skill = this.get(skillId);
    if (skill) {
      return this.runCore(skillId, projectRoot);
    }
    if (this._extensionManager?.getSkill(skillId)) {
      return this._extensionManager.runSkill(skillId, projectRoot);
    }
    throw new Error(`Unknown skill: ${skillId}`);
  }
}

module.exports = SkillRegistry;
