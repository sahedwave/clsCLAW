'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parsePatchDocument,
  materializePatchDocument,
  applyUpdateHunks,
} = require('../src/diff/patchProposal');

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clsclaw-patch-'));
}

function cleanup(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

test('parsePatchDocument reads add and update operations', () => {
  const ops = parsePatchDocument(`*** Begin Patch
*** Add File: src/new.js
+console.log('hi');
*** Update File: src/app.js
@@
-old line
+new line
*** End Patch`);

  assert.equal(ops.length, 2);
  assert.equal(ops[0].type, 'add');
  assert.equal(ops[0].filePath, 'src/new.js');
  assert.equal(ops[1].type, 'update');
  assert.equal(ops[1].filePath, 'src/app.js');
});

test('applyUpdateHunks performs a surgical replacement', () => {
  const result = applyUpdateHunks(
    'alpha\nold line\nomega',
    [['-old line', '+new line']],
    'src/app.js',
  );

  assert.equal(result, 'alpha\nnew line\nomega');
});

test('materializePatchDocument returns file proposals for patch blocks', () => {
  const workspace = makeWorkspace();

  try {
    const target = path.join(workspace, 'src', 'app.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'const mode = "old";\nconsole.log(mode);\n', 'utf-8');

    const proposals = materializePatchDocument(`*** Begin Patch
*** Update File: src/app.js
@@
-const mode = "old";
+const mode = "new";
*** Add File: src/new.js
+export const created = true;
*** End Patch`, workspace);

    assert.equal(proposals.length, 2);
    assert.equal(proposals[0].relativePath, 'src/app.js');
    assert.match(proposals[0].content, /"new"/);
    assert.equal(proposals[1].relativePath, 'src/new.js');
    assert.match(proposals[1].content, /created = true/);
  } finally {
    cleanup(workspace);
  }
});
