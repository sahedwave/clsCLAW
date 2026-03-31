/**
 * memoryStore.js — Persistent memory with relevance-scored injection
 *
 * NOT a log dump. Stores structured memories and scores them
 * against the current query before injecting into context.
 * Only the top-K most relevant memories are injected.
 *
 * Memory types:
 *   file_summary  — what a file does (updated on every approve)
 *   decision      — why something was done (from agent replies)
 *   task_outcome  — what a completed task produced
 *   user_pref     — preferences observed from user behaviour
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { randomUUID: uuid } = require('crypto');

const MAX_MEMORIES     = 500;
const MAX_INJECT_CHARS = 3000;
const TOP_K            = 8;
const MAX_CONSTRAINTS  = 6;
const MAX_CONSTRAINT_CHARS = 1400;

class MemoryStore {
  constructor(dataDir) {
    this._dir           = dataDir;
    this._memoriesFile  = path.join(dataDir, 'memories.json');
    this._summariesFile = path.join(dataDir, 'summaries.json');
    this._memories      = [];
    this._summaries     = {};
    fs.mkdirSync(dataDir, { recursive: true });
    this._load();
  }

  // ── Write ────────────────────────────────────────────────────────────────

  recordTask({ goal, outcome, agentNames = [], projectRoot }) {
    this._add({
      type:    'task_outcome',
      key:     goal.slice(0, 80),
      content: `Goal: ${goal}\nOutcome: ${outcome}\nAgents: ${agentNames.join(', ')}`,
      tags:    this._extractTags(goal + ' ' + outcome),
      projectRoot,
    });
  }

  recordDecision({ decision, reasoning, filePath, agentName, projectRoot }) {
    this._add({
      type:    'decision',
      key:     (filePath ? path.basename(filePath) + ': ' : '') + decision.slice(0, 60),
      content: `Decision: ${decision}\nReasoning: ${reasoning}\nBy: ${agentName}${filePath ? '\nFile: ' + filePath : ''}`,
      tags:    this._extractTags(decision + ' ' + reasoning + ' ' + (filePath || '')),
      projectRoot,
    });
  }

  updateFileSummary(filePath, content, { agentName, description } = {}) {
    const summary = this._summariseFile(content, path.extname(filePath));
    this._summaries[filePath] = {
      summary,
      description: description || '',
      agentName:   agentName || 'unknown',
      updatedAt:   Date.now(),
    };
    this._saveSummaries();
    this._add({
      type:    'file_summary',
      key:     filePath,
      content: `File: ${filePath}\n${summary}`,
      tags:    this._extractTags(path.basename(filePath) + ' ' + summary),
      projectRoot: path.dirname(filePath),
    });
  }

  recordPreference({ preference, context }) {
    this._add({
      type:    'user_pref',
      key:     preference.slice(0, 60),
      content: `Preference: ${preference}\nContext: ${context}`,
      tags:    this._extractTags(preference + ' ' + context),
    });
  }

  // ── Query ────────────────────────────────────────────────────────────────

  /**
   * Return formatted memory string for injection into a prompt.
   * Empty string if nothing relevant.
   */
  query(queryText, { projectRoot = null, maxChars = MAX_INJECT_CHARS } = {}) {
    const scored = this._relevantMemories(queryText, { projectRoot, topK: TOP_K });
    if (scored.length === 0) return '';

    let result = '--- RELEVANT MEMORY ---\n';
    let chars  = result.length;
    for (const m of scored) {
      const entry = `[${m.type}] ${m.content}\n\n`;
      if (chars + entry.length > maxChars) break;
      result += entry;
      chars  += entry.length;
    }
    return result.trim();
  }

  /**
   * Convert relevant memories into explicit behavioral constraints.
   * Returns both structured constraints and a prompt-ready formatted block.
   * Keeps query()/record* APIs unchanged for compatibility.
   */
  queryBehaviorConstraints(
    queryText,
    {
      projectRoot = null,
      maxConstraints = MAX_CONSTRAINTS,
      maxChars = MAX_CONSTRAINT_CHARS,
    } = {},
  ) {
    const relevant = this._relevantMemories(queryText, { projectRoot, topK: TOP_K * 2 });
    if (!relevant.length) return { constraints: [], formatted: '' };

    const constraints = [];
    const seen = new Set();
    for (const mem of relevant) {
      const c = this._memoryToConstraint(mem);
      if (!c) continue;
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      constraints.push({
        text: c,
        sourceType: mem.type,
        score: mem.score,
        memoryId: mem.id,
      });
      if (constraints.length >= maxConstraints) break;
    }

    if (!constraints.length) return { constraints: [], formatted: '' };
    let formatted = '--- BEHAVIORAL CONSTRAINTS (from memory) ---\n';
    let chars = formatted.length;
    for (let i = 0; i < constraints.length; i++) {
      const line = `${i + 1}. ${constraints[i].text}\n`;
      if (chars + line.length > maxChars) break;
      formatted += line;
      chars += line.length;
    }
    return { constraints, formatted: formatted.trim() };
  }

  getFileSummary(filePath)       { return this._summaries[filePath] || null; }
  getStats() {
    const byType = {};
    for (const m of this._memories) byType[m.type] = (byType[m.type] || 0) + 1;
    return { total: this._memories.length, byType, files: Object.keys(this._summaries).length };
  }
  clear() {
    this._memories = []; this._summaries = {};
    this._save(); this._saveSummaries();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _add(record) {
    this._memories.unshift({
      id: uuid(), type: record.type, key: record.key,
      content: record.content, tags: record.tags || [],
      projectRoot: record.projectRoot || null, createdAt: Date.now(),
    });
    // Dedup by type+key
    const seen = new Set();
    this._memories = this._memories.filter(m => {
      const k = m.type + ':' + m.key;
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    if (this._memories.length > MAX_MEMORIES) this._memories = this._memories.slice(0, MAX_MEMORIES);
    this._save();
  }

  _scoreMemory(memory, queryTags) {
    let score = 0;
    const memTags = new Set(memory.tags);
    for (const qt of queryTags) {
      if (memTags.has(qt)) score += 3;
      if (memory.key.toLowerCase().includes(qt)) score += 5;
    }
    const ageHours = (Date.now() - memory.createdAt) / 3600000;
    if (ageHours < 1) score += 4;
    else if (ageHours < 24) score += 2;
    else if (ageHours < 168) score += 1;
    if (memory.type === 'decision')     score += 1;
    if (memory.type === 'task_outcome') score += 1;
    return score;
  }

  _relevantMemories(queryText, { projectRoot = null, topK = TOP_K } = {}) {
    if (this._memories.length === 0) return [];
    const queryTags = this._extractTags(queryText);
    if (queryTags.length === 0) return [];
    return this._memories
      .filter(m => !projectRoot || !m.projectRoot || m.projectRoot === projectRoot)
      .map(m => ({ ...m, score: this._scoreMemory(m, queryTags) }))
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  _memoryToConstraint(memory) {
    if (!memory?.content) return null;
    const extractLine = (prefix) => {
      const re = new RegExp(`^${prefix}:\\s*(.+)$`, 'mi');
      const m = memory.content.match(re);
      return m?.[1]?.trim() || '';
    };

    if (memory.type === 'user_pref') {
      const pref = extractLine('Preference');
      if (!pref) return null;
      return `Respect user preference: ${pref}.`;
    }

    if (memory.type === 'decision') {
      const decision = extractLine('Decision');
      if (!decision) return null;
      return `Follow prior decision when applicable: ${decision}.`;
    }

    if (memory.type === 'task_outcome') {
      const outcome = extractLine('Outcome');
      if (!outcome) return null;
      return `Prefer approaches aligned with successful outcome: ${outcome}.`;
    }

    return null;
  }

  _extractTags(text) {
    if (!text) return [];
    return text.toLowerCase()
      .replace(/[^a-z0-9_$./\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t))
      .slice(0, 30);
  }

  _summariseFile(content, ext) {
    const lines = content.split('\n');
    const symbols = [];
    const pats = ['.js','.ts','.jsx','.tsx'].includes(ext)
      ? [/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m, /^(?:export\s+)?class\s+(\w+)/m]
      : ext === '.py' ? [/^def\s+(\w+)/m, /^class\s+(\w+)/m]
      : [/(?:function|class|def)\s+(\w+)/m];
    for (const p of pats) { const m = content.match(p); if (m?.[1]) symbols.push(m[1]); }
    return [
      `${lines.length} lines`,
      symbols.length > 0 ? `exports: ${symbols.slice(0,5).join(', ')}` : '',
    ].filter(Boolean).join(' | ');
  }

  _save() {
    try { fs.writeFileSync(this._memoriesFile, JSON.stringify(this._memories), 'utf-8'); } catch {}
  }
  _saveSummaries() {
    try { fs.writeFileSync(this._summariesFile, JSON.stringify(this._summaries), 'utf-8'); } catch {}
  }
  _load() {
    try { if (fs.existsSync(this._memoriesFile)) this._memories = JSON.parse(fs.readFileSync(this._memoriesFile,'utf-8')); } catch { this._memories = []; }
    try { if (fs.existsSync(this._summariesFile)) this._summaries = JSON.parse(fs.readFileSync(this._summariesFile,'utf-8')); } catch { this._summaries = {}; }
  }
}

const STOPWORDS = new Set([
  'the','and','for','this','that','with','are','was','but','not','you',
  'all','can','had','has','have','its','let','var','const','return',
  'from','import','function','class','def','use','using','will','should',
]);

module.exports = MemoryStore;
