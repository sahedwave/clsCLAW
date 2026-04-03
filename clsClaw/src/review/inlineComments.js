'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function buildInlineReviewData({ result = {}, projectRoot = '' } = {}) {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const inlineComments = [];
  const generalFindings = [];

  for (const finding of findings) {
    const normalized = normalizeFinding(finding, projectRoot);
    if (!normalized.filePath || !normalized.ranges.length) {
      generalFindings.push(normalized.general);
      continue;
    }

    for (const range of normalized.ranges) {
      inlineComments.push(createInlineComment({
        finding,
        filePath: normalized.filePath,
        projectRoot,
        start: range.start,
        end: range.end,
      }));
    }
  }

  return {
    inlineComments: reanchorInlineComments(inlineComments, projectRoot),
    generalFindings,
  };
}

function reanchorInlineComments(comments = [], projectRoot = '') {
  return comments.map((comment) => {
    if (!comment.absolutePath || !fs.existsSync(comment.absolutePath)) {
      return {
        ...comment,
        anchorStatus: 'missing_file',
      };
    }
    const content = fs.readFileSync(comment.absolutePath, 'utf8');
    const lines = content.split('\n');
    const originalIndex = Math.max(0, (comment.start || 1) - 1);
    const exact = lines[originalIndex] || '';
    if (comment.lineText && exact.trim() === comment.lineText.trim()) {
      return {
        ...comment,
        currentStart: comment.start,
        currentEnd: comment.end,
        anchorStatus: 'exact',
      };
    }

    const foundAt = findAnchorLine(lines, comment);
    if (foundAt !== null) {
      const length = Math.max(1, (comment.end || comment.start || 1) - (comment.start || 1) + 1);
      return {
        ...comment,
        currentStart: foundAt + 1,
        currentEnd: foundAt + length,
        anchorStatus: 'shifted',
      };
    }

    return {
      ...comment,
      currentStart: comment.start,
      currentEnd: comment.end,
      anchorStatus: 'stale',
    };
  });
}

function normalizeFinding(finding, projectRoot) {
  const file = String(finding.file || finding.path || '').trim();
  const filePath = file && file !== 'workspace'
    ? resolveFile(file, projectRoot)
    : null;
  const ranges = toRanges(finding);
  const general = {
    title: String(finding.title || finding.issue || 'Finding'),
    body: findingBody(finding),
    file: file || null,
    severity: String(finding.severity || 'warn'),
  };
  return { filePath, ranges, general };
}

function createInlineComment({ finding, filePath, projectRoot, start, end }) {
  const absolutePath = resolveFile(filePath, projectRoot);
  const fileContent = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : '';
  const lines = fileContent.split('\n');
  const lineIndex = Math.max(0, start - 1);
  const lineText = lines[lineIndex] || '';
  const before = lineIndex > 0 ? lines[lineIndex - 1] : '';
  const after = lineIndex + 1 < lines.length ? lines[lineIndex + 1] : '';

  return {
    id: randomUUID(),
    title: String(finding.title || finding.issue || 'Finding'),
    body: findingBody(finding),
    file: path.relative(projectRoot, absolutePath) || path.basename(absolutePath),
    absolutePath,
    start,
    end,
    severity: String(finding.severity || 'warn'),
    lineText,
    contextBefore: before,
    contextAfter: after,
    anchorStatus: 'exact',
    currentStart: start,
    currentEnd: end,
  };
}

function toRanges(finding) {
  if (Number.isInteger(finding.start)) {
    return [{ start: Number(finding.start), end: Number(finding.end || finding.start) }];
  }
  if (Number.isInteger(finding.line)) {
    return [{ start: Number(finding.line), end: Number(finding.line) }];
  }
  const lines = Array.isArray(finding.lines)
    ? finding.lines.map((value) => Number(value)).filter(Number.isInteger).sort((a, b) => a - b)
    : [];
  if (!lines.length) return [];
  const ranges = [];
  let rangeStart = lines[0];
  let previous = lines[0];
  for (let index = 1; index < lines.length; index++) {
    const current = lines[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    ranges.push({ start: rangeStart, end: previous });
    rangeStart = current;
    previous = current;
  }
  ranges.push({ start: rangeStart, end: previous });
  return ranges;
}

function findAnchorLine(lines, comment) {
  const needle = String(comment.lineText || '').trim();
  if (!needle) return null;
  const candidates = [];
  for (let index = 0; index < lines.length; index++) {
    if (String(lines[index] || '').trim() !== needle) continue;
    let score = 1;
    if (comment.contextBefore && index > 0 && String(lines[index - 1] || '').trim() === String(comment.contextBefore).trim()) score += 2;
    if (comment.contextAfter && index + 1 < lines.length && String(lines[index + 1] || '').trim() === String(comment.contextAfter).trim()) score += 2;
    candidates.push({ index, score });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  return candidates[0].index;
}

function resolveFile(filePath, projectRoot) {
  if (!filePath) return null;
  return path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectRoot || process.cwd(), filePath);
}

function findingBody(finding) {
  return [
    String(finding.detail || '').trim(),
    String(finding.fix || '').trim(),
  ].filter(Boolean).join('\n\n') || String(finding.issue || finding.title || 'Finding').trim();
}

module.exports = {
  buildInlineReviewData,
  reanchorInlineComments,
  toRanges,
};
