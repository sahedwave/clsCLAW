/**
 * contextEngine.js — Hybrid context engine: keyword + semantic embeddings
 *
 * Two modes, automatically selected:
 *
 *   KEYWORD MODE (always available)
 *     - Token overlap, symbol matching, import graph, recency
 *     - Fast, free, works offline
 *     - Weakness: "where is auth handled?" won't find files named 'middleware.js'
 *
 *   SEMANTIC MODE (requires Anthropic API key)
 *     - Uses Anthropic voyage-code-2 embeddings via /v1/embeddings
 *     - Cosine similarity between query embedding and chunk embeddings
 *     - Finds conceptually related files even without keyword overlap
 *     - Embeddings persisted to data/index/ — rebuilt only when files change
 *
 * Hybrid scoring: final_score = α * semantic_score + (1-α) * keyword_score
 *   α = 0.7 when embeddings available, 0.0 otherwise
 *
 * HONEST NOTE: Embedding generation costs API tokens.
 *   - Each file chunk sent to the embeddings API on first index
 *   - Subsequent queries only embed the query string itself (cheap)
 *   - Falls back to keyword-only if API call fails
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const CODE_EXTS = new Set([
  '.js','.ts','.jsx','.tsx','.py','.java','.c','.cpp',
  '.cs','.go','.rs','.rb','.php','.swift','.kt','.vue',
  '.svelte','.html','.css','.scss','.json','.yaml','.yml',
  '.toml','.sh','.bash','.md','.sql',
]);
const IGNORE_DIRS = new Set([
  'node_modules','.git','__pycache__','.next','dist','build',
  'coverage','.cache','venv','.env','.codex-worktrees',
]);

const MAX_FILE_SIZE  = 150 * 1024;
const CHUNK_LINES    = 80;
const CHUNK_OVERLAP  = 10;
const EMBED_MODEL    = 'voyage-code-2';
const HYBRID_ALPHA   = 0.70;  // weight for semantic vs keyword

const STOPWORDS = new Set([
  'the','and','for','this','that','with','are','was','but',
  'not','you','all','can','had','has','have','its','let',
  'var','const','return','from','import','function','class',
]);

// ── Maths helpers ─────────────────────────────────────────────────────────────

function dotProduct(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function magnitude(v) {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const mag = magnitude(a) * magnitude(b);
  return mag === 0 ? 0 : dotProduct(a, b) / mag;
}

// ── Anthropic embeddings API ──────────────────────────────────────────────────

async function fetchEmbeddings(texts, apiKey) {
  // Anthropic uses the voyage-code-2 model via their embeddings endpoint
  const response = await fetch('https://api.anthropic.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embeddings API ${response.status}: ${err}`);
  }

  const data = await response.json();
  // Response: { embeddings: [{ embedding: float[] }, ...] }
  return data.embeddings.map(e => e.embedding);
}

// ── Embedding store (disk-persisted) ─────────────────────────────────────────

class EmbeddingStore {
  constructor(storeDir) {
    this._dir  = storeDir;
    this._file = path.join(storeDir, 'embeddings.json');
    // Map<chunkId → { embedding: float[], text: string, filePath: string, chunkIdx: number }>
    this._data = new Map();
    fs.mkdirSync(storeDir, { recursive: true });
    this._load();
  }

  has(chunkId)       { return this._data.has(chunkId); }
  get(chunkId)       { return this._data.get(chunkId) || null; }
  set(chunkId, rec)  { this._data.set(chunkId, rec); }
  delete(chunkId)    { this._data.delete(chunkId); }
  size()             { return this._data.size; }

  /** Remove all entries for files whose content hash has changed */
  pruneStale(currentHashes) {
    for (const [id, rec] of this._data) {
      const expected = currentHashes.get(rec.filePath);
      if (!expected || rec.fileHash !== expected) {
        this._data.delete(id);
      }
    }
  }

  save() {
    try {
      const obj = {};
      for (const [k, v] of this._data) obj[k] = v;
      fs.writeFileSync(this._file, JSON.stringify(obj), 'utf-8');
    } catch { /* non-fatal */ }
  }

  _load() {
    try {
      if (fs.existsSync(this._file)) {
        const obj = JSON.parse(fs.readFileSync(this._file, 'utf-8'));
        for (const [k, v] of Object.entries(obj)) this._data.set(k, v);
      }
    } catch { this._data = new Map(); }
  }
}

// ── Main engine ───────────────────────────────────────────────────────────────

class ContextEngine {
  constructor(indexDir = null) {
    this._index       = new Map();   // filePath → FileRecord
    this._embedStore  = null;
    this._indexDir    = indexDir;
    this._lastIndexed = null;
    this._projectRoot = null;
    this._embeddingStatus = 'disabled'; // 'disabled'|'building'|'ready'|'error'
    this._embeddingError  = null;
    this._apiKey      = null;
  }

  setApiKey(key)  { this._apiKey = key; }
  setIndexDir(d)  {
    this._indexDir   = d;
    this._embedStore = new EmbeddingStore(d);
  }

  // ── Build index ─────────────────────────────────────────────────────────────

  async buildIndex(projectRoot, { apiKey = null, buildEmbeddings = false } = {}) {
    this._projectRoot = projectRoot;
    if (apiKey) this._apiKey = apiKey;
    this._index.clear();

    const files = this._walkProject(projectRoot);
    for (const fp of files) {
      try {
        const rec = this._indexFile(fp, projectRoot);
        if (rec) this._index.set(fp, rec);
      } catch {}
    }

    this._lastIndexed = Date.now();

    const stats = {
      files:       this._index.size,
      projectRoot,
      indexedAt:   this._lastIndexed,
      embeddings:  false,
    };

    // Build embeddings if requested and API key available
    if ((buildEmbeddings || this._apiKey) && this._indexDir) {
      if (!this._embedStore) this._embedStore = new EmbeddingStore(this._indexDir);
      try {
        await this._buildEmbeddings();
        stats.embeddings    = true;
        stats.embeddedChunks = this._embedStore.size();
      } catch (err) {
        stats.embeddingError = err.message;
      }
    }

    return stats;
  }

  // ── Rebuild embeddings only (no re-read of files) ───────────────────────────

  async reindex(apiKey) {
    if (!this._index.size) throw new Error('Build the index first (/api/context/index)');
    const key = apiKey || this._apiKey;
    if (!key) throw new Error('API key required for embeddings');
    this._apiKey = key;
    if (!this._embedStore) {
      if (!this._indexDir) throw new Error('indexDir not set');
      this._embedStore = new EmbeddingStore(this._indexDir);
    }
    this._embeddingStatus = 'building';
    try {
      await this._buildEmbeddings();
      this._embeddingStatus = 'ready';
      return { ok: true, chunks: this._embedStore.size() };
    } catch (err) {
      this._embeddingStatus = 'error';
      this._embeddingError  = err.message;
      throw err;
    }
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  async query(queryText, { maxFiles = 10, maxTokens = 12000, apiKey = null } = {}) {
    if (!this._index.size) return { files: [], warning: 'Index empty — run /api/context/index first' };

    const key = apiKey || this._apiKey;
    const queryTokens = this._tokenize(queryText);

    // Keyword scores (always computed)
    const keywordScores = new Map();
    for (const [fp, rec] of this._index) {
      const s = this._keywordScore(rec, queryTokens, queryText);
      if (s > 0) keywordScores.set(fp, s);
    }

    // Semantic scores (when embeddings available)
    let semanticScores = new Map();
    const hasEmbeddings = this._embedStore && this._embedStore.size() > 0;

    if (hasEmbeddings && key) {
      try {
        semanticScores = await this._semanticQuery(queryText, key);
      } catch {
        // Fall back to keyword-only silently
      }
    }

    // Hybrid merge
    const allFiles = new Set([...keywordScores.keys(), ...semanticScores.keys()]);
    const finalScores = [];

    // Normalise each set to [0,1]
    const maxKw  = Math.max(1, ...keywordScores.values());
    const maxSem = Math.max(1, ...semanticScores.values());

    for (const fp of allFiles) {
      const kw  = (keywordScores.get(fp)  || 0) / maxKw;
      const sem = (semanticScores.get(fp) || 0) / maxSem;
      const alpha = hasEmbeddings && semanticScores.size > 0 ? HYBRID_ALPHA : 0;
      const score = alpha * sem + (1 - alpha) * kw;
      if (score > 0) finalScores.push({ filePath: fp, score });
    }

    finalScores.sort((a, b) => b.score - a.score);

    // Build result with chunk selection
    let usedTokens = 0;
    const result = [];

    for (const { filePath, score } of finalScores.slice(0, maxFiles)) {
      if (usedTokens >= maxTokens) break;
      const rec = this._index.get(filePath);
      if (!rec) continue;
      const budget  = Math.min(maxTokens - usedTokens, 3000);
      const content = this._getRelevantChunks(rec, queryTokens, budget);
      result.push({
        relativePath: rec.relativePath,
        filePath:     rec.filePath,
        score:        Math.round(score * 100) / 100,
        content,
        symbols:      rec.symbols,
        lines:        rec.lines,
      });
      usedTokens += this._estimateTokens(content);
    }

    return {
      files:          result,
      totalIndexed:   this._index.size,
      tokensUsed:     usedTokens,
      mode:           hasEmbeddings && semanticScores.size > 0 ? 'hybrid' : 'keyword',
      embeddingChunks: this._embedStore?.size() || 0,
    };
  }

  getStats() {
    if (!this._index.size) return { indexed: false, embeddingStatus: this._embeddingStatus };
    const byExt = {};
    let totalLines = 0;
    for (const rec of this._index.values()) {
      byExt[rec.ext] = (byExt[rec.ext] || 0) + 1;
      totalLines += rec.lines;
    }
    return {
      indexed:          true,
      files:            this._index.size,
      totalLines,
      byExtension:      byExt,
      indexedAt:        this._lastIndexed,
      projectRoot:      this._projectRoot,
      embeddingStatus:  this._embeddingStatus,
      embeddingChunks:  this._embedStore?.size() || 0,
      embeddingError:   this._embeddingError || null,
    };
  }

  // ── Build embeddings for all chunks ─────────────────────────────────────────

  async _buildEmbeddings() {
    this._embeddingStatus = 'building';

    // Compute current file hashes for stale detection
    const currentHashes = new Map();
    for (const [fp, rec] of this._index) {
      currentHashes.set(fp, rec.hash);
    }

    // Remove stale embeddings
    this._embedStore.pruneStale(currentHashes);

    // Collect chunks that need embedding
    const toEmbed = [];  // { chunkId, text, filePath, fileHash, chunkIdx }

    for (const [fp, rec] of this._index) {
      const chunks = this._chunkFile(rec);
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${rec.hash}:${i}`;
        if (!this._embedStore.has(chunkId)) {
          toEmbed.push({
            chunkId,
            text:      chunks[i],
            filePath:  fp,
            fileHash:  rec.hash,
            chunkIdx:  i,
          });
        }
      }
    }

    if (toEmbed.length === 0) {
      this._embeddingStatus = 'ready';
      return;
    }

    // Batch embed — Anthropic allows up to 128 texts per request
    const BATCH = 96;
    for (let i = 0; i < toEmbed.length; i += BATCH) {
      const batch    = toEmbed.slice(i, i + BATCH);
      const texts    = batch.map(c => c.text.slice(0, 2000)); // truncate per chunk
      const vectors  = await fetchEmbeddings(texts, this._apiKey);

      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        this._embedStore.set(item.chunkId, {
          embedding: vectors[j],
          filePath:  item.filePath,
          fileHash:  item.fileHash,
          chunkIdx:  item.chunkIdx,
        });
      }
    }

    this._embedStore.save();
    this._embeddingStatus = 'ready';
  }

  // ── Semantic query ───────────────────────────────────────────────────────────

  async _semanticQuery(queryText, apiKey) {
    const [queryVec] = await fetchEmbeddings([queryText.slice(0, 2000)], apiKey);

    // Score each file by max chunk similarity
    const fileMaxSim = new Map();

    for (let chunkId of this._getAllChunkIds()) {
      const rec = this._embedStore.get(chunkId);
      if (!rec) continue;
      const sim = cosineSimilarity(queryVec, rec.embedding);
      const cur = fileMaxSim.get(rec.filePath) || 0;
      if (sim > cur) fileMaxSim.set(rec.filePath, sim);
    }

    return fileMaxSim;
  }

  _getAllChunkIds() {
    // Collect all chunkIds from the embed store that match current index
    const ids = [];
    for (const [fp, rec] of this._index) {
      const chunks = this._chunkFile(rec);
      for (let i = 0; i < chunks.length; i++) {
        ids.push(`${rec.hash}:${i}`);
      }
    }
    return ids;
  }

  // ── File chunking ─────────────────────────────────────────────────────────────

  _chunkFile(rec) {
    const lines  = rec.content.split('\n');
    const chunks = [];
    for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
      chunks.push(lines.slice(i, i + CHUNK_LINES).join('\n'));
    }
    return chunks.length > 0 ? chunks : [rec.content.slice(0, 2000)];
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  _walkProject(dir, depth = 0) {
    if (depth > 10) return [];
    let results = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) results = results.concat(this._walkProject(fp, depth + 1));
      else if (CODE_EXTS.has(path.extname(e.name).toLowerCase())) results.push(fp);
    }
    return results;
  }

  _indexFile(fp, projectRoot) {
    const stat = fs.statSync(fp);
    if (stat.size > MAX_FILE_SIZE) return null;
    const content = fs.readFileSync(fp, 'utf-8');
    const ext     = path.extname(fp).toLowerCase();
    const hash    = createHash('sha256').update(content).digest('hex').slice(0, 16);
    return {
      filePath:     fp,
      relativePath: path.relative(projectRoot, fp),
      ext,
      size:         stat.size,
      lines:        content.split('\n').length,
      modifiedAt:   stat.mtimeMs,
      hash,
      content,
      symbols:      this._extractSymbols(content, ext),
      imports:      this._extractImports(content, ext),
      tokens:       this._tokenize(content),
    };
  }

  _extractSymbols(content, ext) {
    const syms = [];
    const pats = ['.js','.ts','.jsx','.tsx'].includes(ext) ? [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
      /class\s+(\w+)/g,
      /(?:export\s+)?const\s+(\w+)\s*=/g,
    ] : ext === '.py' ? [
      /^def\s+(\w+)/gm, /^class\s+(\w+)/gm, /^async\s+def\s+(\w+)/gm,
    ] : [ /(?:function|class|def|fn|func)\s+(\w+)/g ];

    const seen = new Set();
    for (const p of pats) {
      const re = new RegExp(p.source, p.flags);
      let m;
      while ((m = re.exec(content)) !== null) {
        if (m[1] && !seen.has(m[1])) { seen.add(m[1]); syms.push(m[1]); }
      }
    }
    return syms.slice(0, 50);
  }

  _extractImports(content, ext) {
    const imports = [];
    const pats = [
      /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /from\s+(\S+)\s+import/g,
    ];
    for (const p of pats) {
      let m;
      while ((m = p.exec(content)) !== null) {
        if (m[1] && !imports.includes(m[1])) imports.push(m[1]);
      }
    }
    return imports.slice(0, 20);
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9_$]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && !STOPWORDS.has(t));
  }

  _keywordScore(rec, queryTokens, rawQuery) {
    let score = 0;
    const fileTokenSet = new Set(rec.tokens);

    for (const qt of queryTokens) {
      if (fileTokenSet.has(qt)) score += 2;
    }
    for (const sym of rec.symbols) {
      if (rawQuery.toLowerCase().includes(sym.toLowerCase())) score += 10;
      for (const qt of queryTokens) {
        if (sym.toLowerCase().includes(qt)) score += 5;
      }
    }
    for (const imp of rec.imports) {
      for (const qt of queryTokens) {
        if (imp.toLowerCase().includes(qt)) score += 3;
      }
    }
    const ageDays = (Date.now() - rec.modifiedAt) / 86400000;
    if (ageDays < 1) score += 5;
    else if (ageDays < 7) score += 2;

    const fn = path.basename(rec.filePath).toLowerCase();
    for (const qt of queryTokens) {
      if (fn.includes(qt)) score += 8;
    }
    return score;
  }

  _getRelevantChunks(rec, queryTokens, tokenBudget) {
    const lines = rec.content.split('\n');
    if (lines.length <= CHUNK_LINES) return rec.content.slice(0, tokenBudget * 4);

    const chunks = [];
    for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
      const text  = lines.slice(i, i + CHUNK_LINES).join('\n');
      const toks  = new Set(this._tokenize(text));
      let score   = 0;
      for (const qt of queryTokens) { if (toks.has(qt)) score++; }
      chunks.push({ text, startLine: i, score });
    }
    chunks.sort((a, b) => b.score - a.score);

    let result = '', used = 0;
    for (const c of chunks) {
      const est = this._estimateTokens(c.text);
      if (used + est > tokenBudget) break;
      result += `// Lines ${c.startLine + 1}–${c.startLine + CHUNK_LINES}\n${c.text}\n\n`;
      used   += est;
    }
    return result || rec.content.slice(0, tokenBudget * 4);
  }

  _estimateTokens(text) { return Math.ceil(text.length / 4); }
}

module.exports = ContextEngine;
