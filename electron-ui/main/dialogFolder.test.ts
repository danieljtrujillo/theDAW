// Run with: npx tsx electron-ui/main/dialogFolder.test.ts
//
// The folder a native dialog starts in (no Electron import; plain Node/tsx).
//   - dialogDefaultPath: an absolute caller path wins, a bare file name lands
//     in the remembered folder, no path starts in the remembered folder, and
//     with nothing remembered the caller's value passes through.
//   - folderAfterDialog: the folder an open-file, open-directory or save
//     dialog ended in; nothing for a cancelled or empty result.
//   - DialogFolderMemory: survives a restart through its JSON file, reads a
//     missing or corrupt file as no folder, and ignores an empty folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DialogFolderMemory, dialogDefaultPath, folderAfterDialog } from './dialogFolder.ts';

const last = path.join(os.tmpdir(), 'thedaw-dialog-last');
const other = path.join(os.tmpdir(), 'thedaw-dialog-other', 'take.wav');

// ── dialogDefaultPath ─────────────────────────────────────────────────────
assert.equal(dialogDefaultPath(undefined, undefined), undefined);
assert.equal(dialogDefaultPath('take.mid', undefined), 'take.mid');
assert.equal(dialogDefaultPath(undefined, last), last);
assert.equal(dialogDefaultPath('', last), last);
assert.equal(dialogDefaultPath('take.mid', last), path.join(last, 'take.mid'));
assert.equal(dialogDefaultPath(other, last), other);

// ── folderAfterDialog ─────────────────────────────────────────────────────
assert.equal(folderAfterDialog('openFile', { canceled: true, filePaths: [other] }), undefined);
assert.equal(folderAfterDialog('openFile', { canceled: false, filePaths: [] }), undefined);
assert.equal(folderAfterDialog('openFile', { canceled: false, filePaths: [other] }), path.dirname(other));
assert.equal(folderAfterDialog('openDirectory', { canceled: false, filePaths: [last] }), last);
assert.equal(folderAfterDialog('save', { canceled: false, filePath: other }), path.dirname(other));
assert.equal(folderAfterDialog('save', { canceled: false, filePath: '' }), undefined);
assert.equal(folderAfterDialog('save', { canceled: true, filePath: other }), undefined);

// ── DialogFolderMemory ────────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thedaw-dialog-folder-'));
  try {
    const file = path.join(dir, 'nested', 'dialog-folder.json');
    const first = new DialogFolderMemory(file);
    assert.equal(first.get(), undefined, 'no file reads as no folder');
    first.set(undefined);
    first.set('');
    assert.equal(fs.existsSync(file), false, 'an empty folder is never written');
    first.set(last);
    assert.equal(first.get(), last);

    const restarted = new DialogFolderMemory(file);
    assert.equal(restarted.get(), last, 'the folder survives a restart');

    fs.writeFileSync(file, '{not json');
    assert.equal(new DialogFolderMemory(file).get(), undefined, 'a corrupt file reads as no folder');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('dialogFolder: start folder + remembered folder contract passed');
