/**
 * The roll's parts to EDIT tracks and back, through a .tasmo save.
 *
 * The sequence: a roll of three parts (a violin, a cello, a drum kit on
 * channel 10) is bounced with the EDIT key; each part lands on an EDIT track
 * of its own named, coloured and voiced after the part. The cello is edited
 * and saved again: every clip updates in place and no track is added. The
 * project is saved to .tasmo and opened in a fresh session, and "Edit in
 * Piano Roll" on the cello's clip opens all three parts again, each linked to
 * its clip. A .tasmo written before parts (no `roll_part`) opens each roll
 * clip as one part named after its track.
 *
 *   cd frontend && npx tsx src/lib/rollParts.edit.test.ts
 */
import assert from 'node:assert/strict';
import { captureEditorSession, loadProjectIntoEditor } from './projectImport.ts';
import { projectApi, rollPartToTasmo, tasmoRollPart, type TasmoProjectInput, type TasmoProjectLoaded } from './projectClient.ts';
import { clipPartsLoad } from './rollClip.ts';
import { bounceRollToEditor, type RollBounceDeps } from './rollBounce.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { partLinkOf, rollTracksOf, usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';

class FakeAudioContext {
  async decodeAudioData() {
    return { duration: 1, getChannelData: () => new Float32Array(64).fill(0.5) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

const ed = () => useEditorStore.getState();
const roll = () => usePianoRollStore.getState();
const note = (step: number, pitch: number): PianoNote => ({ id: `n${step}-${pitch}`, note: pitch, step, length: 2, velocity: 90 });

const renders: Array<{ program?: number; percussion?: boolean; count: number }> = [];
const deps: RollBounceDeps = {
  render: (notes, _bpm, _total, opts) => {
    renders.push({ program: opts.program, percussion: opts.percussion, count: notes.length });
    return Promise.resolve({ blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' }), duration: 4 });
  },
  computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
  global: () => ({ useSoundfont: true, activeProgram: 1 }),
};

async function saveThroughTheWire(): Promise<{ project: TasmoProjectLoaded; files: Array<{ name: string; blob: Blob }> }> {
  const session = captureEditorSession();
  const input: TasmoProjectInput = { project_name: 'Parts', tempo: session.bpm, tracks: session.tracks, buses: session.buses };
  let posted: FormData | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    posted = init?.body as FormData;
    return new Response(JSON.stringify({ status: 'saved', path: 'P.tasmo', manifest: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    await projectApi.saveSession(input, 'P.tasmo', session.files);
  } finally {
    globalThis.fetch = realFetch;
  }
  const part = (posted as FormData | null)?.get('project');
  assert.ok(part instanceof Blob);
  return { project: JSON.parse(await (part as Blob).text()) as TasmoProjectLoaded, files: session.files };
}

async function openWithFiles(project: TasmoProjectLoaded, files: Array<{ name: string; blob: Blob }>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const path = decodeURIComponent(String(url).split('path=')[1] ?? '');
    const file = files.find((f) => path.endsWith(f.name));
    return file ? new Response(file.blob, { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
  try {
    await loadProjectIntoEditor(project);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function main(): Promise<void> {
  ed().loadProject({ tracks: [], clips: [] });
  roll().importParts(
    [
      { name: 'Violin I', notes: [note(0, 76), note(4, 79)] },
      { name: 'Cello', program: 42, notes: [note(0, 48), note(8, 43)] },
      { name: 'Kit', notes: [note(0, 36), note(4, 38), note(8, 36)] },
    ],
    100,
  );
  const [vn, vc, kit] = rollTracksOf(roll()).map((t) => t.id);
  roll().setTrackInstrument(vn, 'violin');
  roll().setTrackProgram(kit, 0, true);

  // ── EDIT: one track per part ──────────────────────────────────────────────
  const tracksBefore = ed().tracks.length;
  const first = await bounceRollToEditor(deps);
  assert.ok(first);
  assert.equal(first.parts.length, 3, 'every part bounced');
  assert.equal(first.kind, 'created');
  assert.equal(ed().tracks.length, tracksBefore + 3, 'three EDIT tracks');
  assert.deepEqual(renders.map((r) => [r.program, r.percussion, r.count]), [[40, false, 2], [42, false, 2], [0, true, 3]], 'each part renders through its own voice');
  const clipOf = (partId: string) => ed().clips.find((c) => c.id === partLinkOf(roll(), partId))!;
  const trackOf = (partId: string) => ed().tracks.find((t) => t.id === clipOf(partId).trackId)!;
  assert.deepEqual([trackOf(vn).name, trackOf(vc).name, trackOf(kit).name], ['Violin I', 'Cello', 'Kit'], 'each track is named after its part');
  assert.deepEqual([trackOf(vn).instrumentProgram, trackOf(vc).instrumentProgram, trackOf(kit).instrumentProgram], [40, 42, 0], "each track holds its part's program");
  assert.equal(trackOf(kit).isPercussion, true, 'the kit part makes a drum track');
  assert.equal(trackOf(vc).color, rollTracksOf(roll())[1].color, "the track takes the part's colour");
  const doc = roll().rollDocId;
  assert.deepEqual([vn, vc, kit].map((id) => [clipOf(id).sourceRollPart?.doc, clipOf(id).sourceRollPart?.order]), [[doc, 0], [doc, 1], [doc, 2]], 'every clip records its part and the roll it came from');
  assert.equal(clipOf(vc).sourceRollNotes?.length, 2, "a clip holds its own part's notes only");

  // ── SAVE after an edit in the cello: every clip in place, no new track ────
  roll().setActiveTrack(vc);
  roll().addNote({ note: 55, step: 12, length: 2, velocity: 80 });
  const clipIds = [vn, vc, kit].map((id) => clipOf(id).id);
  const again = await bounceRollToEditor(deps);
  assert.ok(again);
  assert.equal(again.kind, 'updated', 'every linked part updates in place');
  assert.equal(ed().tracks.length, tracksBefore + 3, 'no track is added');
  assert.deepEqual([vn, vc, kit].map((id) => clipOf(id).id), clipIds, 'the same clips');
  assert.equal(clipOf(vc).sourceRollNotes?.length, 3, "the cello's clip has the new note");
  assert.equal(clipOf(vc).instrumentProgram, 42, "a part's own program is written onto its clip");

  // ── .tasmo save and open ──────────────────────────────────────────────────
  const { project, files } = await saveThroughTheWire();
  const saved = project.tracks.flatMap((t) => t.clips);
  assert.equal(saved.filter((c) => c.roll_part).length, 3, 'three roll clips with their parts');
  const cello = saved.find((c) => c.id === clipIds[1])!;
  assert.deepEqual(
    { ...cello.roll_part, color: undefined },
    { doc, id: vc, order: 1, name: 'Cello', program: 42, bank: 0, channel: null, color: undefined, mute: false, solo: false, instrument_id: null },
    'the file holds the part',
  );
  assert.equal(saved.find((c) => c.id === clipIds[0])!.roll_part?.instrument_id, 'violin');
  assert.equal(saved.find((c) => c.id === clipIds[2])!.roll_part?.channel, 10);

  ed().loadProject({ tracks: [], clips: [] });
  roll().importParts([{ name: 'Something else', notes: [note(0, 60)] }], 120);
  await openWithFiles(project, files);
  const reopened = ed().clips.find((c) => c.id === clipIds[1]);
  assert.ok(reopened?.sourceRollPart, 'the reopened clip has its part');
  roll().loadFromClip(...clipPartsLoad(reopened, ed().clips, ed().tracks));
  const back = rollTracksOf(roll());
  assert.deepEqual(back.map((t) => t.name), ['Violin I', 'Cello', 'Kit'], 'Edit in Piano Roll opens every part, in order');
  assert.equal(roll().activeTrackId, vc, 'with the opened clip’s part active');
  assert.deepEqual(back.map((t) => [t.program, t.channel, t.instrumentId ?? null]), [[40, null, 'violin'], [42, null, null], [0, 10, null]]);
  assert.deepEqual(back.map((t) => t.notes.length), [2, 3, 3], 'each with its notes');
  assert.deepEqual(back.map((t) => partLinkOf(roll(), t.id)), clipIds, 'each linked to its clip');
  assert.equal(roll().rollDocId, doc);
  assert.equal(roll().bpm, 100);

  // ── A file written before parts: each roll clip opens as one part ─────────
  const older = JSON.parse(JSON.stringify(project)) as TasmoProjectLoaded;
  for (const t of older.tracks) for (const c of t.clips) delete c.roll_part;
  ed().loadProject({ tracks: [], clips: [] });
  await openWithFiles(older, files);
  const plain = ed().clips.find((c) => c.id === clipIds[1]);
  assert.ok(plain);
  assert.equal(plain.sourceRollPart, undefined, 'no part record');
  roll().loadFromClip(...clipPartsLoad(plain, ed().clips, ed().tracks));
  assert.equal(roll().tracks.length, 1, 'one part');
  assert.equal(rollTracksOf(roll())[0].name, 'Cello', 'named after its EDIT track');
  assert.equal(roll().notes.length, 3);
  assert.equal(roll().editingClipId, plain.id);
  const drums = ed().clips.find((c) => c.id === clipIds[2])!;
  roll().loadFromClip(...clipPartsLoad(drums, ed().clips, ed().tracks));
  assert.equal(rollTracksOf(roll())[0].channel, 10, 'a clip on a drum track opens as a percussion part');

  // ── The file field alone, a hand-edited record and junk ───────────────────
  const ref = rollPartToTasmo({ doc: 'd', id: 'p', order: 2, name: 'Oboe', program: 68, bank: 0, channel: 3, color: '#22d3ee', mute: true, solo: false, instrumentId: 'oboe' });
  assert.deepEqual(tasmoRollPart(JSON.parse(JSON.stringify(ref)), { name: 'x', color: '#000000' }), { doc: 'd', id: 'p', order: 2, name: 'Oboe', program: 68, bank: 0, channel: 3, color: '#22d3ee', mute: true, solo: false, instrumentId: 'oboe' });
  assert.deepEqual(tasmoRollPart({ doc: 'd', id: 'p', program: 400, channel: 99, color: 'red', name: '' }, { name: 'Track', color: '#123456' }), { doc: 'd', id: 'p', order: 0, name: 'Track', program: 127, bank: 0, channel: 16, color: '#123456', mute: false, solo: false });
  assert.equal(tasmoRollPart({ id: 'p' }, { name: 'x', color: '#000000' }), undefined, 'a record with no document is no part');

  console.log('rollParts.edit: ok');
}

await main();
