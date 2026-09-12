/**
 * The shared audio-import helper, under plain node.
 *
 * Pins three things: which files count as audio (extension rescues an empty
 * mime, the Windows case), the exact request each file becomes (the bytes the
 * provider uploads, so DJ drops and the header IMPORT stay identical), and
 * error isolation — one failing file is recorded and logged, the rest still
 * land, in file order.
 *
 * `importEntry` is injected so nothing fetches; `decodeDuration` is injected so
 * no Web Audio is needed (the default guards `typeof window` and returns
 * undefined here anyway).
 *
 * Run: `npx tsx src/lib/importAudioFiles.test.ts`
 */
import assert from 'node:assert/strict';
import type { ImportRequest, LibraryEntry } from '../state/libraryEntry';
import { useLogStore } from '../state/logStore';
import {
  audioImportRequest,
  decodeAudioDuration,
  importAudioFiles,
  isAudioFile,
} from './importAudioFiles';

const bytes = new Uint8Array([82, 73, 70, 70]);
// Empty mime on purpose: what Windows hands over for a .wav with no handler.
const wav = new File([bytes], 'kick loop.wav', { type: '' });
const mp3 = new File([bytes], 'song.mp3', { type: 'audio/mpeg' });
const caf = new File([bytes], 'bell.CAF', { type: '' });
const txt = new File([bytes], 'notes.txt', { type: 'text/plain' });
const dotless = new File([bytes], 'noext', { type: 'audio/wav' });

const fakeEntry = (req: ImportRequest, id: string): LibraryEntry => ({
  id,
  title: req.metadata?.title ?? req.filename,
  prompt: req.metadata?.prompt ?? '',
  negativePrompt: '',
  model: req.metadata?.model ?? '',
  duration: req.metadata?.duration ?? 0,
  steps: 0,
  cfg: 0,
  seed: 0,
  audioUrl: `/api/library/audio/${id}`,
  audioFilename: req.filename,
  fileSizeBytes: req.blob.size,
  mimeType: req.mimeType ?? '',
  timestamp: new Date(0).toISOString(),
  favorite: false,
  rating: null,
  tags: req.metadata?.tags ?? [],
  notes: '',
  lyrics: '',
  source: 'import',
});

// ── isAudioFile: mime OR extension ──────────────────────────────────────────
assert.equal(isAudioFile(wav), true, 'empty mime, .wav extension -> audio');
assert.equal(isAudioFile(mp3), true, 'audio/* mime -> audio');
assert.equal(isAudioFile(caf), true, 'extension match is case-insensitive');
assert.equal(isAudioFile(dotless), true, 'mime alone is enough');
assert.equal(isAudioFile(txt), false, 'text/plain .txt -> not audio');

// ── decodeAudioDuration: no Web Audio here, so undefined, never a throw ─────
assert.equal(await decodeAudioDuration(wav), undefined);

// ── audioImportRequest: the exact upload shape ──────────────────────────────
const origin = { prompt: 'Imported from file picker', tags: ['imported'] };
assert.deepEqual(audioImportRequest(wav, origin, 1.5), {
  blob: wav,
  filename: 'kick loop.wav',
  mimeType: undefined,
  metadata: {
    title: 'kick loop',
    prompt: 'Imported from file picker',
    model: 'imported',
    duration: 1.5,
    source: 'import',
    tags: ['imported'],
  },
});
assert.equal(audioImportRequest(mp3, origin).mimeType, 'audio/mpeg', 'a real mime is kept');
assert.equal(audioImportRequest(mp3, origin).metadata?.duration, undefined, 'no decode -> no duration');
assert.equal(audioImportRequest(dotless, origin).metadata?.title, 'noext', 'a dotless name is its own title');
assert.equal(audioImportRequest(caf, origin).metadata?.title, 'bell', 'only the last extension is stripped');

// ── importAudioFiles: one request per file, in order; failure isolated ──────
useLogStore.getState().clear();
const seen: ImportRequest[] = [];
const fakeImport = async (req: ImportRequest): Promise<LibraryEntry> => {
  seen.push(req);
  if (req.filename === 'song.mp3') throw new Error('backend said no');
  return fakeEntry(req, `id-${seen.length}`);
};
const wav2 = new File([bytes], 'snare.wav', { type: '' });
const result = await importAudioFiles([wav, mp3, wav2], origin, {
  importEntry: fakeImport,
  decodeDuration: async () => 2.25,
});

assert.equal(seen.length, 3, 'every file is attempted, the failure does not stop the rest');
assert.deepEqual(
  seen.map((r) => r.filename),
  ['kick loop.wav', 'song.mp3', 'snare.wav'],
  'requests are made in file order',
);
assert.ok(seen.every((r) => r.metadata?.duration === 2.25), 'the injected decode feeds every request');

assert.equal(result.imported.length, 2);
assert.deepEqual(result.imported.map((e) => e.id), ['id-1', 'id-3'], 'imported entries keep file order');
assert.equal(result.failed.length, 1);
assert.equal(result.failed[0].file, mp3, 'the failed record names the file');
assert.equal(result.failed[0].error, 'backend said no');

const log = useLogStore.getState().entries;
const errors = log.filter((e) => e.level === 'error');
assert.equal(errors.length, 1, 'exactly one error line for the one failure');
assert.equal(errors[0].source, 'import');
assert.match(errors[0].msg, /song\.mp3: backend said no/);
const infos = log.filter((e) => e.level === 'info' && e.source === 'import');
assert.equal(infos.length, 1, 'one summary line for a multi-file import — never per-file successes');
assert.equal(infos[0].msg, '2 file(s) imported, 1 failed');

// ── A single file gets no summary line (importEntry already logs it) ────────
useLogStore.getState().clear();
const single = await importAudioFiles([wav], origin, {
  importEntry: fakeImport,
  decodeDuration: async () => undefined,
});
assert.equal(single.imported.length, 1);
assert.equal(single.failed.length, 0);
assert.equal(useLogStore.getState().entries.length, 0, 'no log line at all from the helper for one clean file');

// ── A non-Error throw still becomes a string ────────────────────────────────
const weird = await importAudioFiles([wav], origin, {
  importEntry: async () => { throw 'plain string'; },
  decodeDuration: async () => undefined,
});
assert.equal(weird.failed[0].error, 'plain string');

// ── A decode failure imports anyway, without a duration ─────────────────────
const noDecode = await importAudioFiles([wav], origin, {
  importEntry: fakeImport,
  decodeDuration: async () => { throw new Error('undecodable'); },
});
assert.equal(noDecode.imported.length, 1);
assert.equal(noDecode.failed.length, 0);
assert.equal(seen[seen.length - 1].metadata?.duration, undefined);

console.log('importAudioFiles tests passed');
