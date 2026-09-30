/**
 * The roll's parts to EDIT tracks and back, through a .tasmo save.
 *
 * The sequence: a roll of three parts (a violin, a cello, a drum kit on
 * channel 10) is sent with the EDIT key; each part lands on an EDIT track of
 * its own named, coloured and voiced after the part, and plays live there
 * with no render. The cello is edited and saved again: every clip updates in
 * place and no track is added. The project is saved to .tasmo and opened in a
 * fresh session, and "Edit in Piano Roll" on the cello's clip opens all three
 * parts again, each linked to its clip. A .tasmo written before parts (no
 * `roll_part`) opens each roll clip as one part named after its track.
 *
 * A Horn part in Bank 1 plays live in bank 1, its clip carries the bank, and a
 * render the MIDI render queue makes of it (Keep rendered audio) is asked for
 * bank 1, so EDIT's voice, its live notes, its render and the .tasmo file all
 * hold it. A Strings part switched to the Orchestral kit and saved again moves
 * its clip onto a drum track (its own, when the clip is alone there; a new one
 * beside it when not), so neither EDIT's live notes nor a render play the
 * drums as String Ensemble.
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
import { clipVoice } from './clipProgram.ts';
import { liveMidiIfHeard, liveMidiNotes, planLiveMidi } from '../state/liveMixer.ts';
import { configureMidiRenderQueue, requestMidiRender } from '../state/midiRenderQueue.ts';
import { midiRenderState, type MidiStepRender } from './midiRender.ts';

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

const GLOBAL = { useSoundfont: true, activeProgram: 1 };
const renders: Array<{ program?: number; percussion?: boolean; bank?: number; count: number }> = [];
// EDIT's MIDI render queue with a stand-in synth: the one place a part's audio is rendered.
const render: MidiStepRender = (notes, _bpm, _total, opts) => {
  renders.push({ program: opts.program, percussion: opts.percussion, bank: opts.bank, count: notes.length });
  return Promise.resolve({ blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' }), duration: 4 });
};
configureMidiRenderQueue({
  render,
  computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
  global: () => GLOBAL,
  ensureReady: () => Promise.resolve(),
  livePlan: liveMidiIfHeard,
});
const deps: RollBounceDeps = { global: () => GLOBAL };

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
  assert.equal(first.parts.length, 3, 'every part sent');
  assert.equal(first.kind, 'created');
  assert.equal(first.rendering, false, 'every part has a voice, so none is queued for a render');
  assert.equal(ed().tracks.length, tracksBefore + 3, 'three EDIT tracks');
  assert.equal(renders.length, 0, 'the EDIT key renders nothing');
  const clipOf = (partId: string) => ed().clips.find((c) => c.id === partLinkOf(roll(), partId))!;
  const trackOf = (partId: string) => ed().tracks.find((t) => t.id === clipOf(partId).trackId)!;
  assert.deepEqual(
    [vn, vc, kit].map((id) => {
      const v = clipVoice(clipOf(id), trackOf(id), GLOBAL);
      return [v.program, v.percussion];
    }),
    [[40, false], [42, false], [0, true]],
    'each part plays through its own voice',
  );
  const heard = liveMidiIfHeard(ed().clips, ed().tracks, GLOBAL);
  assert.ok(
    [vn, vc, kit].every((id) => heard.has(clipOf(id).id) && midiRenderState(clipOf(id), trackOf(id), GLOBAL) === 'none'),
    'each plays live and holds no audio',
  );
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

  // ── A part's Bank: the clip, EDIT's live voice, a render and the file ─────
  ed().loadProject({ tracks: [], clips: [] });
  roll().importParts([{ name: 'Horn', program: 60, notes: [note(0, 53), note(4, 55)] }], 100);
  const horn = rollTracksOf(roll())[0].id;
  roll().setTrackBank(horn, 1);
  const rendersBeforeHorn = renders.length;
  await bounceRollToEditor(deps);
  assert.equal(renders.length, rendersBeforeHorn, 'the part plays live: the EDIT key renders nothing');
  const hornClipId = partLinkOf(roll(), horn) as string;
  const hornNow = () => {
    const clip = ed().clips.find((c) => c.id === hornClipId)!;
    return { clip, track: ed().tracks.find((t) => t.id === clip.trackId) };
  };
  const hornState = () => midiRenderState(hornNow().clip, hornNow().track, GLOBAL);
  assert.deepEqual([hornNow().clip.instrumentProgram, hornNow().clip.instrumentBank], [60, 1], 'the clip holds the program and its bank');
  assert.deepEqual(clipVoice(hornNow().clip, hornNow().track, GLOBAL), { program: 60, percussion: false, bank: 1 }, "EDIT's voice selects bank 1");
  const liveNotes = liveMidiNotes(ed().clips, ed().tracks, planLiveMidi(ed().clips, ed().tracks, GLOBAL), GLOBAL, 0, 100);
  assert.ok(liveNotes.length === 2 && liveNotes.every((x) => x.program === 60 && x.bank === 1), "EDIT's live notes play program 60 in bank 1");
  // Keep rendered audio: the queue's render is asked for the part's bank, and the clip records it.
  await requestMidiRender(hornClipId, 'keep');
  assert.equal(renders.at(-1)?.bank, 1, "the render is asked for the part's bank");
  assert.equal(hornNow().clip.renderedBank, 1, 'the clip records the bank its audio has');
  assert.equal(hornState(), 'current', 'and its audio is current');
  roll().setTrackBank(horn, 0);
  await bounceRollToEditor(deps);
  assert.equal(hornNow().clip.instrumentBank, undefined, "bank 0 again: SAVE clears the clip's bank");
  assert.equal(hornState(), 'stale', 'the kept render, made in bank 1, is out of date');
  await requestMidiRender(hornClipId, 'cache');
  assert.deepEqual([renders.at(-1)?.bank, hornNow().clip.renderedBank, hornState()], [undefined, undefined, 'current'], "EDIT's upkeep renders it again in bank 0");
  roll().setTrackBank(horn, 1);
  await bounceRollToEditor(deps);
  await requestMidiRender(hornClipId, 'cache');
  assert.deepEqual([renders.at(-1)?.bank, hornNow().clip.renderedBank, hornState()], [1, 1, 'current'], 'and in bank 1 once the bank is back');
  const bankSave = await saveThroughTheWire();
  const hornSaved = bankSave.project.tracks.flatMap((t) => t.clips).find((c) => c.id === hornClipId)!;
  assert.deepEqual([hornSaved.instrument_bank, hornSaved.rendered_bank], [1, 1], 'the file holds the bank');
  ed().loadProject({ tracks: [], clips: [] });
  await openWithFiles(bankSave.project, bankSave.files);
  assert.deepEqual([hornNow().clip.instrumentBank, hornNow().clip.renderedBank], [1, 1], 'and gives it back');
  assert.equal(hornState(), 'current', 'so the reopened clip is not rendered again');
  // A file written before banks opens in bank 0.
  const noBank = JSON.parse(JSON.stringify(bankSave.project)) as TasmoProjectLoaded;
  for (const t of noBank.tracks) {
    for (const c of t.clips) {
      delete c.instrument_bank;
      delete c.rendered_bank;
    }
  }
  ed().loadProject({ tracks: [], clips: [] });
  await openWithFiles(noBank, bankSave.files);
  assert.deepEqual([hornNow().clip.instrumentBank, hornNow().clip.renderedBank], [undefined, undefined], 'an older file opens in bank 0');

  // ── A part switched to a kit since its clip was made ─────────────────────
  ed().loadProject({ tracks: [], clips: [] });
  roll().importParts([{ name: 'Strings', program: 48, notes: [note(0, 60), note(4, 64)] }], 100);
  const strings = rollTracksOf(roll())[0].id;
  await bounceRollToEditor(deps);
  const stringsClipId = partLinkOf(roll(), strings) as string;
  const stringsTrackId = ed().clips.find((c) => c.id === stringsClipId)!.trackId;
  assert.equal(ed().tracks.find((t) => t.id === stringsTrackId)?.isPercussion, undefined, 'the part bounced to a melodic track');
  // Drum kits, then the Orchestral kit, in the part's Sound select.
  roll().setTrackProgram(strings, 48, true);
  await bounceRollToEditor(deps);
  const kitNow = () => {
    const clip = ed().clips.find((c) => c.id === stringsClipId)!;
    return { clip, track: ed().tracks.find((t) => t.id === clip.trackId)! };
  };
  assert.equal(kitNow().clip.trackId, stringsTrackId, 'alone on its track, the clip stays there');
  assert.equal(kitNow().track.isPercussion, true, 'and the track becomes a drum track');
  assert.deepEqual(clipVoice(kitNow().clip, kitNow().track, GLOBAL), { program: 48, percussion: true }, "EDIT's voice is the Orchestral kit on the drum channel");
  // A render (an export, Keep rendered audio) plays the kit on the drum channel, never String Ensemble.
  await requestMidiRender(stringsClipId, 'keep');
  assert.deepEqual([renders.at(-1)?.program, renders.at(-1)?.percussion], [48, true], 'the render is the Orchestral kit on the drum channel');
  assert.equal(midiRenderState(kitNow().clip, kitNow().track, GLOBAL), 'current');
  // Back to strings, with another clip sharing the track: the part's clip moves
  // to a new melodic track, and the other clip keeps its drum track.
  const other = ed().addClipToTrack({
    trackId: stringsTrackId,
    label: 'fill',
    audioBlob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 1,
    offsetIntoSource: 0,
    durationSec: 1,
    startSec: 8,
    color: '#ffffff',
  });
  const tracksBeforeSwitch = ed().tracks.length;
  roll().setTrackProgram(strings, 48, false);
  await bounceRollToEditor(deps);
  assert.equal(ed().tracks.length, tracksBeforeSwitch + 1, 'a new track');
  assert.notEqual(kitNow().clip.trackId, stringsTrackId, "the part's clip moved to it");
  assert.equal(kitNow().track.isPercussion, undefined, 'a melodic track');
  assert.deepEqual([kitNow().track.name, kitNow().track.instrumentProgram], ['Strings', 48], 'named after the part, on its program');
  assert.equal(ed().tracks.indexOf(kitNow().track), ed().tracks.findIndex((t) => t.id === stringsTrackId) + 1, 'right below the old track');
  assert.equal(ed().clips.find((c) => c.id === other)?.trackId, stringsTrackId, 'the other clip stays where it was');
  assert.equal(ed().tracks.find((t) => t.id === stringsTrackId)?.isPercussion, true, 'on its drum track');
  // The kept render was the kit; the part is strings again, so EDIT's upkeep renders it through String Ensemble.
  assert.equal(midiRenderState(kitNow().clip, kitNow().track, GLOBAL), 'stale', "the moved clip's kit render is out of date");
  await requestMidiRender(stringsClipId, 'cache');
  assert.deepEqual([renders.at(-1)?.program, renders.at(-1)?.percussion], [48, false], 'rendered again as String Ensemble');
  assert.equal(midiRenderState(kitNow().clip, kitNow().track, GLOBAL), 'current', "the moved clip's audio is current");

  console.log('rollParts.edit: ok');
}

await main();
