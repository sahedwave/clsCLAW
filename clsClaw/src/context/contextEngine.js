

'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const {
  resolveEmbeddingProvider,
  describeEmbeddingStatus,
  fetchEmbeddings,
} = require('./embeddingProviders');

const CODE_EXTS = new Set([
  '.js','.ts','.jsx','.tsx','.py','.java','.c','.cpp',
  '.cs','.go','.rs','.rb','.php','.swift','.kt','.vue',
  '.svelte','.html','.css','.scss','.json','.yaml','.yml',
  '.toml','.sh','.bash','.md','.sql',
]);
const IGNORE_DIRS = new Set([
  'node_modules','.git','__pycache__','.next','dist','build',
  'coverage','.cache','venv','.env','.clsclaw-worktrees',
]);

const MAX_FILE_SIZE = 150 * 1024;
const CHUNK_LINES = 80;
const CHUNK_OVERLAP = 10;
const HYBRID_ALPHA = 0.70;

const STOPWORDS = new Set([
  'the','and','for','this','that','with','are','was','but',
  'not','you','all','can','had','has','have','its','let',
  'var','const','return','from','import','function','class',
]);

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(vector) {
  return Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const mag = magnitude(a) * magnitude(b);
  return mag === 0 ? 0 : dotProduct(a, b) / mag;
}

class EmbeddingStore {
  constructor(storeDir) {
    this._dir = storeDir;
    this._file = path.join(storeDir, 'embeddings.json');
    this._meta = { providerKey: null, model: null };
    this._data = new Map();
    fs.mkdirSync(storeDir, { recursive: true });
    this._load();
  }

  has(chunkId) { return this._data.has(chunkId); }
  get(chunkId) { return this._data.get(chunkId) || null; }
  set(chunkId, record) { this._data.set(chunkId, record); }
  delete(chunkId) { this._data.delete(chunkId); }
  size() { return this._data.size; }
  getMeta() { return { ...this._meta }; }

  ensureProvider(meta = {}) {
    const providerKey = meta.providerKey || null;
    const model = meta.model || null;
    const changed = this._meta.providerKey !== providerKey || this._meta.model !== model;
    if (changed) {
      this._data.clear();
      this._meta = { providerKey, model };
      this.save();
    }
  }

  pruneStale(currentHashes) {
    for (const [id, record] of this._data) {
      const expected = currentHashes.get(record.filePath);
      if (!expected || record.fileHash !== expected) {
        this._data.delete(id);
      }
    }
  }

  save() {
    try {
      fs.writeFileSync(this._file, JSON.stringify({
        _meta: this._meta,
        _data: Object.fromEntries(this._data),
      }), 'utf-8');
    } catch {}
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const parsed = JSON.parse(fs.readFileSync(this._file, 'utf-8'));
      if (parsed && parsed._data && typeof parsed._data === 'object') {
        this._meta = parsed._meta || { providerKey: null, model: null };
        this._data = new Map(Object.entries(parsed._data));
        return;
      }
      if (parsed && typeof parsed === 'object') {
        this._meta = { providerKey: null, model: null };
        this._data = new Map(Object.entries(parsed));
      }
    } catch {
      this._meta = { providerKey: null, model: null };
      this._data = new Map();
    }
  }
}

class ContextEngine {
  constructor(indexDir = null, { fetchImpl = fetch } = {}) {
    this._index = new Map();
    this._embedStore = null;
    this._indexDir = indexDir;
    this._lastIndexed = null;
    this._projectRoot = null;
    this._embeddingStatus = 'disabled';
    this._embeddingError = null;
    this._providerConfig = {};
    this._fetchImpl = fetchImpl;
  }

  setApiKey(key) {
    this.setProviderConfig({ anthropic: key || '' });
  }

  setProviderConfig(config = {}) {
    if (!config || typeof config !== 'object') return;
    this._providerConfig = {
      ...this._providerConfig,
      ...config,
    };
  }

  setIndexDir(dir) {
    this._indexDir = dir;
    this._embedStore = new EmbeddingStore(dir);
  }

  async buildIndex(projectRoot, { providerConfig = null, apiKey = null, buildEmbeddings = false } = {}) {
    this._projectRoot = projectRoot;
    if (providerConfig) this.setProviderConfig(providerConfig);
    else if (apiKey) this.setApiKey(apiKey);
    this._index.clear();

    const files = this._walkProject(projectRoot);
    for (const filePath of files) {
      try {
        const record = this._indexFile(filePath, projectRoot);
        if (record) this._index.set(filePath, record);
      } catch {}
    }

    this._lastIndexed = Date.now();
    const provider = this._resolveEmbeddingProvider();
    const stats = {
      files: this._index.size,
      projectRoot,
      indexedAt: this._lastIndexed,
      embeddings: false,
      embeddingProvider: provider?.key || null,
      embeddingModel: provider?.model || null,
    };

    if ((buildEmbeddings || provider) && this._indexDir && provider) {
      if (!this._embedStore) this._embedStore = new EmbeddingStore(this._indexDir);
      try {
        await this._buildEmbeddings(provider);
        stats.embeddings = true;
        stats.embeddedChunks = this._embedStore.size();
      } catch (err) {
        this._embeddingStatus = 'error';
        this._embeddingError = err.message;
        stats.embeddingError = err.message;
      }
    } else {
      this._embeddingStatus = provider ? 'disabled' : 'disabled';
      this._embeddingError = null;
    }

    return stats;
  }

  async reindex(providerConfig = null) {
    if (!this._index.size) throw new Error('Build the index first (/api/context/index)');
    if (providerConfig) this.setProviderConfig(providerConfig);
    const provider = this._resolveEmbeddingProvider();
    if (!provider) throw new Error('No embedding provider configured');
    if (!this._embedStore) {
      if (!this._indexDir) throw new Error('indexDir not set');
      this._embedStore = new EmbeddingStore(this._indexDir);
    }
    this._embeddingStatus = 'building';
    this._embeddingError = null;
    try {
      await this._buildEmbeddings(provider);
      return {
        ok: true,
        chunks: this._embedStore.size(),
        provider: provider.key,
        model: provider.model,
      };
    } catch (err) {
      this._embeddingStatus = 'error';
      this._embeddingError = err.message;
      throw err;
    }
  }

  async query(queryText, { maxFiles = 10, maxTokens = 12000, providerConfig = null, apiKey = null } = {}) {
    if (!this._index.size) return { files: [], warning: 'Index empty — run /api/context/index first' };
    if (providerConfig) this.setProviderConfig(providerConfig);
    else if (apiKey) this.setApiKey(apiKey);

    const provider = this._resolveEmbeddingProvider();
    const queryTokens = this._tokenize(queryText);

    const keywordScores = new Map();
    for (const [filePath, record] of this._index) {
      const score = this._keywordScore(record, queryTokens, queryText);
      if (score > 0) keywordScores.set(filePath, score);
    }

    let semanticScores = new Map();
    const hasEmbeddings = Boolean(this._embedStore && this._embedStore.size() > 0 && this._isStoreCompatible(provider));

    if (hasEmbeddings && provider) {
      try {
        semanticScores = await this._semanticQuery(queryText, provider);
      } catch (err) {
        this._embeddingError = err.message;
      }
    }

    const allFiles = new Set([...keywordScores.keys(), ...semanticScores.keys()]);
    const finalScores = [];
    const maxKeyword = Math.max(1, ...keywordScores.values());
    const maxSemantic = Math.max(1, ...semanticScores.values());

    for (const filePath of allFiles) {
      const kw = (keywordScores.get(filePath) || 0) / maxKeyword;
      const sem = (semanticScores.get(filePath) || 0) / maxSemantic;
      const alpha = hasEmbeddings && semanticScores.size > 0 ? HYBRID_ALPHA : 0;
      const score = alpha * sem + (1 - alpha) * kw;
      if (score > 0) finalScores.push({ filePath, score });
    }

    finalScores.sort((a, b) => b.score - a.score);

    let usedTokens = 0;
    const files = [];
    for (const { filePath, score } of finalScores.slice(0, maxFiles)) {
      if (usedTokens >= maxTokens) break;
      const record = this._index.get(filePath);
      if (!record) continue;
      const budget = Math.min(maxTokens - usedTokens, 3000);
      const content = this._getRelevantChunks(record, queryTokens, budget);
      files.push({
        relativePath: record.relativePath,
        filePath: record.filePath,
        score: Math.round(score * 100) / 100,
        content,
        symbols: record.symbols,
        lines: record.lines,
      });
      usedTokens += this._estimateTokens(content);
    }

    return {
      files,
      totalIndexed: this._index.size,
      tokensUsed: usedTokens,
      mode: hasEmbeddings && semanticScores.size > 0 ? 'hybrid' : 'keyword',
      embeddingChunks: this._embedStore?.size() || 0,
      embeddingProvider: provider?.key || null,
      embeddingModel: provider?.model || null,
    };
  }

  getStats() {
    const embeddingStatus = describeEmbeddingStatus(this._providerConfig);
    if (!this._index.size) {
      return {
        indexed: false,
        embeddingStatus: this._embeddingStatus,
        embeddingProviderSelected: embeddingStatus.selected,
        embeddingProviderActive: embeddingStatus.active,
        embeddingProviderModel: embeddingStatus.activeModel,
      };
    }
    const byExtension = {};
    let totalLines = 0;
    for (const record of this._index.values()) {
      byExtension[record.ext] = (byExtension[record.ext] || 0) + 1;
      totalLines += record.lines;
    }
    return {
      indexed: true,
      files: this._index.size,
      totalLines,
      byExtension,
      indexedAt: this._lastIndexed,
      projectRoot: this._projectRoot,
      embeddingStatus: this._embeddingStatus,
      embeddingChunks: this._embedStore?.size() || 0,
      embeddingError: this._embeddingError || null,
      embeddingProviderSelected: embeddingStatus.selected,
      embeddingProviderActive: embeddingStatus.active,
      embeddingProviderModel: embeddingStatus.activeModel,
      embeddingProviderAvailable: embeddingStatus.available,
    };
  }

  async _buildEmbeddings(provider) {
    this._embeddingStatus = 'building';
    this._embeddingError = null;
    if (!provider) throw new Error('No embedding provider configured');
    if (!this._embedStore) {
      if (!this._indexDir) throw new Error('indexDir not set');
      this._embedStore = new EmbeddingStore(this._indexDir);
    }

    this._embedStore.ensureProvider({
      providerKey: provider.key,
      model: provider.model,
    });

    const currentHashes = new Map();
    for (const [filePath, record] of this._index) {
      currentHashes.set(filePath, record.hash);
    }
    this._embedStore.pruneStale(currentHashes);

    const toEmbed = [];
    for (const [filePath, record] of this._index) {
      const chunks = this._chunkFile(record);
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `${record.hash}:${i}`;
        if (!this._embedStore.has(chunkId)) {
          toEmbed.push({
            chunkId,
            text: chunks[i],
            filePath,
            fileHash: record.hash,
            chunkIdx: i,
          });
        }
      }
    }

    if (toEmbed.length === 0) {
      this._embeddingStatus = 'ready';
      return;
    }

    const batchSize = 96;
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const texts = batch.map((item) => item.text.slice(0, 2000));
      const vectors = await fetchEmbeddings(texts, provider, { fetchImpl: this._fetchImpl });
      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        this._embedStore.set(item.chunkId, {
          embedding: vectors[j],
          filePath: item.filePath,
          fileHash: item.fileHash,
          chunkIdx: item.chunkIdx,
          providerKey: provider.key,
          model: provider.model,
        });
      }
    }

    this._embedStore.save();
    this._embeddingStatus = 'ready';
  }

  async _semanticQuery(queryText, provider) {
    const [queryVector] = await fetchEmbeddings([queryText.slice(0, 2000)], provider, { fetchImpl: this._fetchImpl });
    const fileMax = new Map();

    for (const chunkId of this._getAllChunkIds()) {
      const record = this._embedStore.get(chunkId);
      if (!record) continue;
      const score = cosineSimilarity(queryVector, record.embedding);
      const existing = fileMax.get(record.filePath) || 0;
      if (score > existing) fileMax.set(record.filePath, score);
    }

    return fileMax;
  }

  _resolveEmbeddingProvider() {
    return resolveEmbeddingProvider(this._providerConfig);
  }

  _isStoreCompatible(provider) {
    if (!this._embedStore || !provider) return false;
    const meta = this._embedStore.getMeta();
    return meta.providerKey === provider.key && meta.model === provider.model;
  }

  _getAllChunkIds() {
    const ids = [];
    for (const record of this._index.values()) {
      const chunks = this._chunkFile(record);
      for (let i = 0; i < chunks.length; i++) {
        ids.push(`${record.hash}:${i}`);
      }
    }
    return ids;
  }

  _chunkFile(record) {
    const lines = record.content.split('\n');
    const chunks = [];
    for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
      chunks.push(lines.slice(i, i + CHUNK_LINES).join('\n'));
    }
    return chunks.length > 0 ? chunks : [record.content.slice(0, 2000)];
  }

  _walkProject(dir, depth = 0) {
    if (depth > 10) return [];
    let results = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) results = results.concat(this._walkProject(filePath, depth + 1));
      else if (CODE_EXTS.has(path.extname(entry.name).toLowerCase())) results.push(filePath);
    }
    return results;
  }

  _indexFile(filePath, projectRoot) {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const ext = path.extname(filePath).toLowerCase();
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    return {
      filePath,
      relativePath: path.relative(projectRoot, filePath),
      ext,
      size: stat.size,
      lines: content.split('\n').length,
      modifiedAt: stat.mtimeMs,
      hash,
      content,
      symbols: this._extractSymbols(content, ext),
      imports: this._extractImports(content),
      tokens: this._tokenize(content),
    };
  }

  _extractSymbols(content, ext) {
    const symbols = [];
    const patterns = ['.js','.ts','.jsx','.tsx'].includes(ext) ? [
      /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
      /class\s+(\w+)/g,
      /(?:export\s+)?const\s+(\w+)\s*=/g,
    ] : ext === '.py' ? [
      /^def\s+(\w+)/gm,
      /^class\s+(\w+)/gm,
      /^async\s+def\s+(\w+)/gm,
    ] : [/(?:function|class|def|fn|func)\s+(\w+)/g];

    const seen = new Set();
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match;
      while ((match = regex.exec(content)) !== null) {
        if (match[1] && !seen.has(match[1])) {
          seen.add(match[1]);
          symbols.push(match[1]);
        }
      }
    }
    return symbols.slice(0, 50);
  }

  _extractImports(content) {
    const imports = [];
    const patterns = [
      /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /from\s+(\S+)\s+import/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1] && !imports.includes(match[1])) imports.push(match[1]);
      }
    }
    return imports.slice(0, 20);
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^a-z0-9_$]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token));
  }

  _keywordScore(record, queryTokens, rawQuery) {
    let score = 0;
    const tokenSet = new Set(record.tokens);
    for (const queryToken of queryTokens) {
      if (tokenSet.has(queryToken)) score += 2;
    }
    for (const symbol of record.symbols) {
      if (rawQuery.toLowerCase().includes(symbol.toLowerCase())) score += 10;
      for (const queryToken of queryTokens) {
        if (symbol.toLowerCase().includes(queryToken)) score += 5;
      }
    }
    for (const imported of record.imports) {
      for (const queryToken of queryTokens) {
        if (imported.toLowerCase().includes(queryToken)) score += 2;
      }
    }
    if (record.relativePath.toLowerCase().includes(rawQuery.toLowerCase())) score += 8;
    return score;
  }

  _getRelevantChunks(record, queryTokens, tokenBudget) {
    const lines = record.content.split('\n');
    const chunks = [];
    for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
      const text = lines.slice(i, i + CHUNK_LINES).join('\n');
      const tokens = new Set(this._tokenize(text));
      let score = 0;
      for (const queryToken of queryTokens) {
        if (tokens.has(queryToken)) score++;
      }
      chunks.push({ text, startLine: i, score });
    }
    chunks.sort((a, b) => b.score - a.score);

    let result = '';
    let used = 0;
    for (const chunk of chunks) {
      const estimated = this._estimateTokens(chunk.text);
      if (used + estimated > tokenBudget) break;
      result += `\n[${record.relativePath}:${chunk.startLine + 1}]\n${chunk.text}\n`;
      used += estimated;
    }
    return result || record.content.slice(0, tokenBudget * 4);
  }

  _estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }
}

module.exports = ContextEngine;
