'use strict';

const fs = require('fs');
const path = require('path');

const IDENTITY_TEMPLATES = [
  {
    name: 'IDENTITY.md',
    label: 'Identity',
    description: 'Name, vibe, and workspace identity for cLoSe',
    defaultContent: `# IDENTITY

Name: cLoSe
Product: clsClaw
Creator: Md Shahed Rahman
Vibe: Evidence-first, product-minded, calm, and direct
Emoji: claw

Keep this short and durable. This is the quick identity card for the workspace.
`,
  },
  {
    name: 'USER.md',
    label: 'User',
    description: 'How cLoSe should address and support the user',
    defaultContent: `# USER

- Preferred product name: clsClaw
- Preferred assistant name: cLoSe
- Preferred style: clear, practical, and honest
- Preferred workflow: explain first for analysis, justify before making code changes
`,
  },
  {
    name: 'SOUL.md',
    label: 'Soul',
    description: 'Core product behavior and tone',
    defaultContent: `# SOUL

Prime directives:
- Be evidence-first: separate verified facts from inference.
- Be product-minded: prefer clean outcomes over flashy output.
- Be safe-by-default: route risky changes through review and approval.
- Be honest about uncertainty and missing evidence.
`,
  },
  {
    name: 'AGENTS.md',
    label: 'Agents',
    description: 'Guard rails and red lines for agent behavior',
    defaultContent: `# AGENTS

## Red lines

RED_LINE: rm -rf
RED_LINE: curl | sh
RED_LINE: wget | sh
RED_LINE: sudo
RED_LINE: chmod 777

## Guard rails

- Prefer editing existing files before creating new structure.
- Do not claim you read files or sources unless you actually read them.
- If uncertain, state what is missing.
`,
  },
  {
    name: 'HEARTBEAT.md',
    label: 'Heartbeat',
    description: 'Small recurring checklist for scheduled reviews',
    defaultContent: `# HEARTBEAT

- [ ] Check whether the workspace is missing identity or security files.
- [ ] Scan for urgent regressions or broken defaults.
- [ ] If a task is blocked, write down exactly what is missing.
- [ ] Keep this checklist short and stable.
`,
  },
];

const TEMPLATE_MAP = new Map(IDENTITY_TEMPLATES.map((entry) => [entry.name, entry]));

function getIdentityTemplates() {
  return IDENTITY_TEMPLATES.map((entry) => ({ ...entry }));
}

function resolveIdentityFile(projectRoot, name) {
  if (!TEMPLATE_MAP.has(name)) {
    throw new Error(`Unsupported identity file: ${name}`);
  }
  return path.join(projectRoot, name);
}

function readIdentityFiles(projectRoot, { includeContent = true } = {}) {
  return IDENTITY_TEMPLATES.map((entry) => {
    const filePath = resolveIdentityFile(projectRoot, entry.name);
    const exists = fs.existsSync(filePath);
    const content = exists && includeContent ? fs.readFileSync(filePath, 'utf-8') : '';
    return {
      name: entry.name,
      label: entry.label,
      description: entry.description,
      path: filePath,
      exists,
      content,
      size: exists ? Buffer.byteLength(content, 'utf-8') : 0,
    };
  });
}

function ensureIdentityFiles(projectRoot, names = IDENTITY_TEMPLATES.map((entry) => entry.name)) {
  const created = [];
  for (const name of names) {
    const entry = TEMPLATE_MAP.get(name);
    if (!entry) continue;
    const filePath = resolveIdentityFile(projectRoot, name);
    if (fs.existsSync(filePath)) continue;
    fs.writeFileSync(filePath, entry.defaultContent, 'utf-8');
    created.push({ name, path: filePath });
  }
  return created;
}

function writeIdentityFile(projectRoot, name, content) {
  const filePath = resolveIdentityFile(projectRoot, name);
  fs.writeFileSync(filePath, String(content || ''), 'utf-8');
  return filePath;
}

function readIdentityContext(projectRoot, { maxCharsPerFile = 1200 } = {}) {
  const sections = [];
  for (const file of readIdentityFiles(projectRoot, { includeContent: true })) {
    if (!file.exists) continue;
    const text = String(file.content || '').trim();
    if (!text) continue;
    const trimmed = text.length > maxCharsPerFile
      ? `${text.slice(0, maxCharsPerFile)}\n...[trimmed]`
      : text;
    sections.push(`## ${file.name}\n${trimmed}`);
  }
  return sections.join('\n\n');
}

function readRedLinePatterns(projectRoot) {
  const filePath = resolveIdentityFile(projectRoot, 'AGENTS.md');
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const patterns = new Set();
  let inRedLinesSection = false;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const explicit = line.match(/^RED_LINE:\s*(.+)$/i);
    if (explicit) {
      patterns.add(explicit[1].trim().toLowerCase());
      continue;
    }

    if (/^#+\s*red lines\b/i.test(line)) {
      inRedLinesSection = true;
      continue;
    }

    if (inRedLinesSection && /^#+\s+/.test(line)) {
      inRedLinesSection = false;
      continue;
    }

    if (inRedLinesSection) {
      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) patterns.add(bullet[1].trim().toLowerCase());
    }
  }

  return [...patterns].filter(Boolean);
}

module.exports = {
  IDENTITY_TEMPLATES,
  getIdentityTemplates,
  readIdentityFiles,
  ensureIdentityFiles,
  writeIdentityFile,
  readIdentityContext,
  readRedLinePatterns,
};
