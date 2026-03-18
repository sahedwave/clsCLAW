/**
 * versionStore.js — Per-file version history with rollback
 *
 * Replaces scattered .codex-bak.* files.
 *
 * Storage layout in data/versions/:
 *   index.json          — { filePath → [VersionMeta, ...] }
 *   <sha256>.content    — file content snapshot (deduplicated by hash)
 *
 * Each version record:
 *   {
 *     versionId:   string   (uuid)
 *     filePath:    string   (absolute, resolved)
 *     hash:        string   (sha256 of content — used to find content file)
 *     size:        number
 *     lines:       number
 *     agentId:     string
 *     agentName:   string
 *     description: string
 *     savedAt:     number   (epoch ms)
 *     stats:       { added, removed }   (diff vs previous version)
 *   }
 *
 * Content deduplication: two versions with identical content share
 * one content file. This keeps storage small for repeated no-op saves.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID: uuid } = require('crypto');
const { computeStructuredDiff } = require('../diff/diff');

const MAX_VERSIONS_PER_FILE = 50;

class VersionStore {
  constructor(storeDir) {
    this._dir     = storeDir;
    this._content = path.join(storeDir, 'content');
    this._indexFile = path.join(storeDir, 'index.json');
    // index: Map<resolvedFilePath, VersionMeta[]>  (newest first)
    this._index   = new Map();
    fs.mkdirSync(this._content, { recursive: true });
    this._loadIndex();
  }

  // ── Save a snapshot ─────────────────────────────────────────────────────────

  /**
   * Snapshot the current on-disk content of filePath BEFORE it is overwritten.
   * Call this right before writing the new version.
   *
   * If the file doesn't exist yet (new file), nothing is saved — there is
   * no "before" state to preserve.
   */
  snapshotBefore(filePath, { agentId, agentName, description, stats } = {}) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return null;   // new file — no prior state

    let content;
    try { content = fs.readFileSync(resolved, 'utf-8'); }
    catch { return null; }

    return this._saveSnapshot(resolved, content, { agentId, agentName, description, stats });
  }

  /**
   * Snapshot arbitrary content (used when we want to record what was written,
   * e.g. right after a successful apply so we have the exact approved version).
   */
  snapshotContent(filePath, content, { agentId, agentName, description, stats } = {}) {
    const resolved = path.resolve(filePath);
    return this._saveSnapshot(resolved, content, { agentId, agentName, description, stats });
  }

  // ── Query ───────────────────────────────────────────────────────────────────

  /** All versions for a file, newest first */
  getVersions(filePath) {
    const resolved = path.resolve(filePath);
    return (this._index.get(resolved) || []).slice(); // defensive copy
  }

  /** Get the content of a specific version */
  getContent(versionId) {
    // Find the version across all files
    for (const versions of this._index.values()) {
      const v = versions.find(x => x.versionId === versionId);
      if (v) {
        const contentFile = path.join(this._content, v.hash + '.content');
        if (!fs.existsSync(contentFile)) return null;
        return fs.readFileSync(contentFile, 'utf-8');
      }
    }
    return null;
  }

  /** All files that have at least one version */
  getAllTrackedFiles() {
    const result = [];
    for (const [filePath, versions] of this._index) {
      if (versions.length > 0) {
        result.push({
          filePath,
          versionCount: versions.length,
          latestAt: versions[0].savedAt,
          latestAgent: versions[0].agentName,
        });
      }
    }
    return result.sort((a, b) => b.latestAt - a.latestAt);
  }

  // ── Restore ─────────────────────────────────────────────────────────────────

  /**
   * Restore a file to a specific version.
   * The current file is snapshotted first (so the restore itself is undoable).
   * Returns { ok, filePath, restoredFrom }
   */
  restore(versionId, { agentId = 'manual', agentName = 'Restore' } = {}) {
    const content = this.getContent(versionId);
    if (content === null) return { ok: false, error: 'Version content not found: ' + versionId };

    let targetPath = null;
    for (const [filePath, versions] of this._index) {
      if (versions.find(v => v.versionId === versionId)) {
        targetPath = filePath;
        break;
      }
    }
    if (!targetPath) return { ok: false, error: 'Version not found in index: ' + versionId };

    // Snapshot current state before restoring (makes restore itself undoable)
    this.snapshotBefore(targetPath, {
      agentId,
      agentName,
      description: `Before restore to version ${versionId.slice(0, 8)}`,
    });

    // Write the restored content
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(targetPath, content, 'utf-8');

    // Record the restore as a new snapshot
    this._saveSnapshot(targetPath, content, {
      agentId,
      agentName,
      description: `Restored from version ${versionId.slice(0, 8)}`,
    });

    return { ok: true, filePath: targetPath, restoredFrom: versionId };
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  _saveSnapshot(resolvedPath, content, { agentId, agentName, description, stats } = {}) {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const contentFile = path.join(this._content, hash + '.content');

    // Write content if not already stored (deduplication)
    if (!fs.existsSync(contentFile)) {
      fs.writeFileSync(contentFile, content, 'utf-8');
    }

    const lines = content.split('\n').length;

    // Compute diff stats vs previous version if not provided
    let diffStats = stats || { added: 0, removed: 0 };
    if (!stats) {
      const existing = this._index.get(resolvedPath);
      if (existing && existing.length > 0) {
        const prevContent = this.getContent(existing[0].versionId);
        if (prevContent !== null && prevContent !== content) {
          const diff = computeStructuredDiff(prevContent, content, path.basename(resolvedPath));
          diffStats = diff.stats;
        }
      }
    }

    const versionMeta = {
      versionId:   uuid(),
      filePath:    resolvedPath,
      hash,
      size:        Buffer.byteLength(content, 'utf-8'),
      lines,
      agentId:     agentId  || 'unknown',
      agentName:   agentName || 'Unknown',
      description: description || `Saved ${path.basename(resolvedPath)}`,
      savedAt:     Date.now(),
      stats:       diffStats,
    };

    // Prepend (newest first)
    const existing = this._index.get(resolvedPath) || [];
    existing.unshift(versionMeta);

    // Enforce max versions per file
    if (existing.length > MAX_VERSIONS_PER_FILE) {
      const removed = existing.splice(MAX_VERSIONS_PER_FILE);
      // Orphaned content files are cleaned up lazily (not blocking)
      this._gcContentFiles();
    }

    this._index.set(resolvedPath, existing);
    this._saveIndex();
    return versionMeta;
  }

  _gcContentFiles() {
    // Collect all hashes still referenced by the index
    const used = new Set();
    for (const versions of this._index.values()) {
      for (const v of versions) used.add(v.hash + '.content');
    }
    // Delete unreferenced content files
    try {
      for (const f of fs.readdirSync(this._content)) {
        if (f.endsWith('.content') && !used.has(f)) {
          fs.unlinkSync(path.join(this._content, f));
        }
      }
    } catch { /* non-fatal */ }
  }

  _saveIndex() {
    try {
      const obj = {};
      for (const [k, v] of this._index) obj[k] = v;
      fs.writeFileSync(this._indexFile, JSON.stringify(obj), 'utf-8');
    } catch { /* non-fatal */ }
  }

  _loadIndex() {
    try {
      if (fs.existsSync(this._indexFile)) {
        const obj = JSON.parse(fs.readFileSync(this._indexFile, 'utf-8'));
        for (const [k, v] of Object.entries(obj)) this._index.set(k, v);
      }
    } catch { this._index = new Map(); }
  }
}

module.exports = VersionStore;
