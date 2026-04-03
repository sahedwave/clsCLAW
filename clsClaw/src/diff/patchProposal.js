'use strict';

const fs = require('fs');
const path = require('path');

function parsePatchDocument(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  if (!lines.length || lines[0].trim() !== '*** Begin Patch') {
    throw new Error('Patch must start with "*** Begin Patch"');
  }

  const operations = [];
  let i = 1;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '*** End Patch') {
      return operations;
    }

    if (line.trim() === '*** End of File') {
      i += 1;
      continue;
    }

    if (line.startsWith('*** Add File: ')) {
      const filePath = line.slice('*** Add File: '.length).trim();
      i += 1;
      const contentLines = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) {
          throw new Error(`Invalid add-file line in ${filePath}: ${lines[i]}`);
        }
        contentLines.push(lines[i].slice(1));
        i += 1;
      }
      operations.push({ type: 'add', filePath, content: contentLines.join('\n') });
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const filePath = line.slice('*** Update File: '.length).trim();
      i += 1;
      const hunks = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('@@')) {
          throw new Error(`Expected "@@" in update for ${filePath}`);
        }
        i += 1;
        const hunkLines = [];
        while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('*** ')) {
          const prefix = lines[i][0];
          if (![' ', '+', '-'].includes(prefix)) {
            if (lines[i] === '') {
              hunkLines.push(' ');
              i += 1;
              continue;
            }
            throw new Error(`Invalid patch line in ${filePath}: ${lines[i]}`);
          }
          hunkLines.push(lines[i]);
          i += 1;
        }
        hunks.push(hunkLines);
      }
      operations.push({ type: 'update', filePath, hunks });
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      const filePath = line.slice('*** Delete File: '.length).trim();
      operations.push({ type: 'delete', filePath });
      i += 1;
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    throw new Error(`Unexpected patch line: ${line}`);
  }

  throw new Error('Patch must end with "*** End Patch"');
}

function applyUpdateHunks(originalContent, hunks, filePath) {
  let current = String(originalContent || '').replace(/\r\n/g, '\n');
  let searchOffset = 0;

  for (const hunk of hunks) {
    const oldBlock = hunk.filter((line) => !line.startsWith('+')).map((line) => line.slice(1)).join('\n');
    const newBlock = hunk.filter((line) => !line.startsWith('-')).map((line) => line.slice(1)).join('\n');

    if (!oldBlock.length) {
      throw new Error(`Patch hunk for ${filePath} has no search block`);
    }

    let index = current.indexOf(oldBlock, searchOffset);
    if (index === -1) {
      index = current.indexOf(oldBlock);
    }
    if (index === -1) {
      throw new Error(`Could not apply patch for ${filePath}: target block not found`);
    }

    current = `${current.slice(0, index)}${newBlock}${current.slice(index + oldBlock.length)}`;
    searchOffset = index + newBlock.length;
  }

  return current;
}

function materializePatchDocument(patchText, projectRoot) {
  const operations = parsePatchDocument(patchText);
  const proposals = [];

  for (const op of operations) {
    const absolutePath = path.resolve(projectRoot, op.filePath);
    if (op.type === 'delete') {
      throw new Error(`Delete-file patch is not supported yet: ${op.filePath}`);
    }

    if (op.type === 'add') {
      proposals.push({
        filePath: absolutePath,
        relativePath: op.filePath,
        content: op.content,
        lang: 'patch',
      });
      continue;
    }

    const original = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf-8') : '';
    const nextContent = applyUpdateHunks(original, op.hunks, op.filePath);
    proposals.push({
      filePath: absolutePath,
      relativePath: op.filePath,
      content: nextContent,
      lang: 'patch',
    });
  }

  return proposals;
}

module.exports = {
  parsePatchDocument,
  materializePatchDocument,
  applyUpdateHunks,
};
