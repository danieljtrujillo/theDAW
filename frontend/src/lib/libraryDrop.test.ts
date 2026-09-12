/**
 * The shared "what was dropped here" helper, under plain node.
 *
 * Pins: an in-app library drag resolves to its entry (and to nothing for an
 * unknown id, without importing); an OS drop imports its audio files in file
 * order through the injected `importEntry`, skips non-audio files with one
 * warning that names them, and honours `max` for single-slot targets; and the
 * dragover gate says yes to the mime, to a 'Files' drag, and to an empty-type
 * file item (the Windows case), and no to a text-only drag. `libraryListDropIntent`
 * adds the list-OF-the-library rule: files import, a library row dropped back
 * on the library is ignored.
 *
 * The DataTransfer is a plain object shaped like the real one: `types`,
 * `getData`, `files`, `items` — everything the helper touches.
 *
 * Run: `npm run test:library-drop`
 */
import assert from 'node:assert/strict';
import type { ImportRequest, LibraryEntry } from '../state/libraryEntry';
import { useLogStore } from '../state/logStore';
import {
  DESKTOP_DROP_ORIGIN,
  LIBRARY_ID_MIME,
  dropHasLibraryOrFiles,
  entriesFromDrop,
  libraryListDropIntent,
} from './libraryDrop';

const bytes = new Uint8Array([82, 73, 70, 70]);
// Empty mime on purpose: what Windows hands over for a .wav with no handler.
const wav = new File([bytes], 'kick loop.wav', { type: '' });
const mp3 = new File([bytes], 'song.mp3', { type: 'audio/mpeg' });
const txt = new File([bytes], 'notes.txt', { type: 'text/plain' });

const DJ_MIME = 'application/x-thedaw-djtrack';

interface FakeDt {
  types?: string[];
  data?: Record<string, string>;
  files?: File[];
  items?: Array<{ kind: string; type: string }>;
}

const makeDt = (o: FakeDt): DataTransfer =>
  ({
    types: o.types ?? [],
    getData: (mime: string) => o.data?.[mime] ?? '',
    files: o.files ?? [],
    items: o.items ?? [],
  }) as unknown as DataTransfer;

const entry = (id: string, title: string): LibraryEntry => ({
  id,
  title,
  prompt: '',
  negativePrompt: '',
  model: '',
  duration: 0,
  steps: 0,
  cfg: 0,
  seed: 0,
  audioUrl: `/api/library/audio/${id}`,
  audioFilename: `${title}.wav`,
  fileSizeBytes: 0,
  mimeType: 'audio/wav',
  timestamp: new Date(0).toISOString(),
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  lyrics: '',
  source: 'import',
});

const library = [entry('a1', 'Alpha'), entry('b2', 'Beta')];

let importCalls: ImportRequest[] = [];
const fakeImport = async (req: ImportRequest): Promise<LibraryEntry> => {
  importCalls.push(req);
  return { ...entry(`id-${importCalls.length}`, req.metadata?.title ?? req.filename), tags: req.metadata?.tags ?? [] };
};
const deps = { importEntry: fakeImport, decodeDuration: async () => undefined };
const reset = () => { importCalls = []; useLogStore.getState().clear(); };

// ── dropHasLibraryOrFiles: the dragover gate ────────────────────────────────
assert.equal(dropHasLibraryOrFiles(makeDt({ types: [LIBRARY_ID_MIME, 'text/plain'] })), true, 'library mime -> yes');
assert.equal(dropHasLibraryOrFiles(makeDt({ types: ['Files'] })), true, "'Files' type -> yes (an OS drag)");
assert.equal(
  dropHasLibraryOrFiles(makeDt({ types: [], items: [{ kind: 'file', type: '' }] })),
  true,
  'an empty-type file item -> yes (Windows dragover)',
);
assert.equal(
  dropHasLibraryOrFiles(makeDt({ types: [], items: [{ kind: 'file', type: 'audio/wav' }] })),
  true,
  'an audio file item -> yes',
);
assert.equal(dropHasLibraryOrFiles(makeDt({ types: ['text/plain'] })), false, 'text-only drag -> no');
assert.equal(
  dropHasLibraryOrFiles(makeDt({ types: ['text/plain'], items: [{ kind: 'string', type: 'text/plain' }] })),
  false,
  'a string item is not a file',
);
assert.equal(dropHasLibraryOrFiles(makeDt({ types: [DJ_MIME] }), [DJ_MIME]), true, 'a custom mime list is honoured');
assert.equal(dropHasLibraryOrFiles(makeDt({ types: [LIBRARY_ID_MIME] }), [DJ_MIME]), false, '…and excludes mimes not in it');
assert.equal(dropHasLibraryOrFiles(makeDt({ types: [LIBRARY_ID_MIME] }), []), false, 'an empty list ignores every in-app mime');
assert.equal(dropHasLibraryOrFiles(makeDt({ types: ['Files'] }), []), true, '…but still takes OS files');

// ── libraryListDropIntent: a list OF the library only takes files ───────────
assert.equal(libraryListDropIntent(makeDt({ types: ['Files'], files: [wav] })), 'import', 'desktop files -> import');
assert.equal(
  libraryListDropIntent(makeDt({ types: [], items: [{ kind: 'file', type: '' }] })),
  'import',
  'the Windows empty-type dragover -> import',
);
assert.equal(
  libraryListDropIntent(makeDt({ types: [LIBRARY_ID_MIME, 'text/plain'] })),
  'ignore',
  'a library row dropped on the library -> ignore',
);
assert.equal(
  libraryListDropIntent(makeDt({ types: [LIBRARY_ID_MIME, 'Files'], files: [wav] })),
  'ignore',
  '…even if the drag also claims files',
);
assert.equal(libraryListDropIntent(makeDt({ types: ['text/plain'] })), 'ignore', 'a text drag -> ignore');
assert.equal(libraryListDropIntent(makeDt({})), 'ignore', 'an empty drag -> ignore');

// ── entriesFromDrop: an in-app drag resolves, never imports ─────────────────
reset();
assert.deepEqual(
  await entriesFromDrop(makeDt({ types: [LIBRARY_ID_MIME], data: { [LIBRARY_ID_MIME]: 'b2' } }), { entries: library, deps }),
  [library[1]],
  'library mime -> the matching entry',
);
assert.equal(importCalls.length, 0, 'no import for an in-app drag');

assert.deepEqual(
  await entriesFromDrop(makeDt({ types: [LIBRARY_ID_MIME], data: { [LIBRARY_ID_MIME]: 'nope' } }), { entries: library, deps }),
  [],
  'unknown id -> []',
);

assert.deepEqual(
  await entriesFromDrop(makeDt({ types: [DJ_MIME], data: { [DJ_MIME]: 'a1' } }), { mimes: [DJ_MIME], entries: library, deps }),
  [library[0]],
  'a DJ drag resolves through its own mime',
);
assert.deepEqual(
  await entriesFromDrop(makeDt({ types: [DJ_MIME], data: { [DJ_MIME]: 'a1' } }), { entries: library, deps }),
  [],
  'a DJ drag is not read by a library-mime caller (no files either)',
);

// ── entriesFromDrop: OS files import in order ───────────────────────────────
reset();
const two = await entriesFromDrop(makeDt({ types: ['Files'], files: [wav, mp3] }), { entries: library, deps });
assert.equal(importCalls.length, 2, 'importEntry called once per audio file');
assert.deepEqual(importCalls.map((r) => r.filename), ['kick loop.wav', 'song.mp3'], 'in file order');
assert.deepEqual(two.map((e) => e.title), ['kick loop', 'song'], 'returned in file order');
assert.equal(importCalls[0].metadata?.prompt, DESKTOP_DROP_ORIGIN.prompt, 'the desktop origin is the default');
assert.deepEqual(importCalls[0].metadata?.tags, ['finder-drop']);
assert.equal(useLogStore.getState().entries.filter((e) => e.level === 'warn').length, 0, 'nothing to warn about');

// ── a non-audio file is skipped, named once ─────────────────────────────────
reset();
const mixed = await entriesFromDrop(makeDt({ types: ['Files'], files: [wav, txt, mp3] }), { entries: library, deps });
assert.equal(mixed.length, 2, 'the .txt did not import');
assert.deepEqual(importCalls.map((r) => r.filename), ['kick loop.wav', 'song.mp3']);
const warns = useLogStore.getState().entries.filter((e) => e.level === 'warn' && e.source === 'import');
assert.equal(warns.length, 1, 'one warning for the skipped file');
assert.match(warns[0].msg, /notes\.txt/, 'the warning names it');

// ── a custom origin is passed through ───────────────────────────────────────
reset();
await entriesFromDrop(makeDt({ types: ['Files'], files: [wav] }), {
  entries: library,
  deps,
  origin: { prompt: 'Imported from a test', tags: ['t'] },
});
assert.equal(importCalls[0].metadata?.prompt, 'Imported from a test');

// ── max: a single-slot target imports one and says what it ignored ──────────
reset();
const one = await entriesFromDrop(makeDt({ types: ['Files'], files: [wav, mp3] }), { entries: library, deps, max: 1 });
assert.equal(one.length, 1);
assert.equal(importCalls.length, 1, 'only the first file is imported');
assert.equal(importCalls[0].filename, 'kick loop.wav');
const ignored = useLogStore.getState().entries.filter((e) => e.level === 'warn' && e.source === 'import');
assert.equal(ignored.length, 1);
assert.match(ignored[0].msg, /song\.mp3/, 'the ignored file is named');

// ── empty drops never throw ─────────────────────────────────────────────────
reset();
assert.deepEqual(await entriesFromDrop(makeDt({}), { entries: library, deps }), []);
assert.deepEqual(await entriesFromDrop(makeDt({ types: ['Files'], files: [txt] }), { entries: library, deps }), [], 'only non-audio -> []');
assert.deepEqual(await entriesFromDrop(makeDt({ types: ['text/plain'], data: { 'text/plain': 'hello' } }), { entries: library, deps }), []);
assert.equal(importCalls.length, 0);

console.log('libraryDrop tests passed');
