'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

class ArtifactStore {
  constructor(dir) {
    this._dir = dir;
    this._indexFile = path.join(dir, 'index.json');
    fs.mkdirSync(dir, { recursive: true });
    this._index = this._loadIndex();
  }

  create({
    type = 'note',
    title = 'Artifact',
    summary = '',
    content = '',
    projectRoot = null,
    metadata = null,
    createdBy = null,
  } = {}) {
    const id = randomUUID();
    const record = {
      id,
      type: String(type || 'note'),
      title: String(title || 'Artifact').trim() || 'Artifact',
      summary: String(summary || '').trim(),
      projectRoot: projectRoot || null,
      metadata: metadata && typeof metadata === 'object' ? { ...metadata } : null,
      createdBy: createdBy && typeof createdBy === 'object' ? { ...createdBy } : null,
      createdAt: Date.now(),
    };
    fs.writeFileSync(path.join(this._dir, `${id}.json`), JSON.stringify({
      ...record,
      content: String(content || ''),
    }), 'utf-8');
    this._index.unshift(record);
    this._index = this._index.slice(0, 500);
    this._saveIndex();
    return record;
  }

  list(limit = 50) {
    return this._index.slice(0, Math.max(1, Number(limit) || 50));
  }

  get(id) {
    const meta = this._index.find((item) => item.id === id);
    if (!meta) return null;
    const file = path.join(this._dir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }

  update(id, patch = {}) {
    const current = this.get(id);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      metadata: patch.metadata && typeof patch.metadata === 'object'
        ? { ...(current.metadata || {}), ...patch.metadata }
        : current.metadata || null,
      updatedBy: patch.updatedBy && typeof patch.updatedBy === 'object'
        ? { ...patch.updatedBy }
        : current.updatedBy || null,
    };
    fs.writeFileSync(path.join(this._dir, `${id}.json`), JSON.stringify(next), 'utf-8');
    const idx = this._index.findIndex((item) => item.id === id);
    if (idx >= 0) {
      this._index[idx] = {
        id: next.id,
        type: next.type,
        title: next.title,
        summary: next.summary,
        projectRoot: next.projectRoot || null,
        metadata: next.metadata || null,
        createdBy: next.createdBy || null,
        createdAt: next.createdAt,
      };
      this._saveIndex();
    }
    return next;
  }

  _loadIndex() {
    try {
      if (fs.existsSync(this._indexFile)) {
        const parsed = JSON.parse(fs.readFileSync(this._indexFile, 'utf-8'));
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  }

  _saveIndex() {
    try {
      fs.writeFileSync(this._indexFile, JSON.stringify(this._index), 'utf-8');
    } catch {}
  }
}

module.exports = {
  ArtifactStore,
};
