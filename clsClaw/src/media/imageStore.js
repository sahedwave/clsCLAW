'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

class ImageStore {
  constructor(baseDir) {
    this._baseDir = baseDir;
    fs.mkdirSync(this._baseDir, { recursive: true });
  }

  saveDataUrl({ dataUrl, name = '' } = {}) {
    const parsed = parseImageDataUrl(dataUrl);
    const id = crypto.randomUUID();
    const ext = MIME_TO_EXT[parsed.mimeType] || '.bin';
    const safeName = sanitizeFileName(name || `upload${ext}`);
    const filePath = path.join(this._baseDir, `${id}${ext}`);
    const metaPath = path.join(this._baseDir, `${id}.json`);

    fs.writeFileSync(filePath, parsed.buffer);
    const meta = {
      id,
      name: safeName,
      mimeType: parsed.mimeType,
      size: parsed.buffer.length,
      fileName: path.basename(filePath),
      filePath,
      createdAt: Date.now(),
      url: `/api/uploads/${id}`,
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    return redactMeta(meta);
  }

  getMeta(id) {
    const metaPath = path.join(this._baseDir, `${sanitizeId(id)}.json`);
    if (!fs.existsSync(metaPath)) return null;
    return redactMeta(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
  }

  readAttachment(id) {
    const metaPath = path.join(this._baseDir, `${sanitizeId(id)}.json`);
    if (!fs.existsSync(metaPath)) {
      throw new Error('Uploaded image not found');
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const filePath = path.join(this._baseDir, meta.fileName);
    if (!fs.existsSync(filePath)) {
      throw new Error('Uploaded image payload missing');
    }
    const buffer = fs.readFileSync(filePath);
    return {
      ...redactMeta(meta),
      buffer,
      dataUrl: `data:${meta.mimeType};base64,${buffer.toString('base64')}`,
    };
  }
}

function parseImageDataUrl(dataUrl) {
  const source = String(dataUrl || '').trim();
  const match = source.match(/^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new Error('Expected an image data URL payload');
  }
  const mimeType = match[1].toLowerCase();
  if (!MIME_TO_EXT[mimeType]) {
    throw new Error(`Unsupported image type: ${mimeType}`);
  }
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) {
    throw new Error('Image payload was empty');
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB limit`);
  }
  return { mimeType, buffer };
}

function sanitizeFileName(name) {
  const cleaned = String(name || 'upload')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return cleaned || 'upload';
}

function sanitizeId(id) {
  return String(id || '').replace(/[^a-z0-9-]/gi, '');
}

function redactMeta(meta) {
  return {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    size: meta.size,
    createdAt: meta.createdAt,
    url: meta.url,
  };
}

module.exports = {
  ImageStore,
  MAX_IMAGE_BYTES,
  parseImageDataUrl,
};
