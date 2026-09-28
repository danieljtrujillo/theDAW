/**
 * Import as tracks renders each part once, one at a time, with EDIT open.
 *
 * Before: every clip Import as tracks made held a silent placeholder and no
 * renderedProgram, so EDIT's instrument-sync effect read every one as a stale
 * render and started a re-render of each at once, and again for every clip
 * still rendering each time a render landed, on top of the import's own
 * one-at-a-time renders. Replaying the effect's rule on a 24-part file
 * started 324 renders, up to 278 at once. The effect had the same fault on
 * its own: a picker change over 24 clips started 24 renders at once and more
 * as each landed.
 *
 * This replays the effect exactly as WaveformEditor runs it (lib/clipRerender
 * midiClipVoiceSig and staleMidiClipIds into a StaleRerenderQueue) on every
 * change of the real editor store, synchronously, which is the harshest order
 * a React commit can give it, while a real 24-part MIDI file goes through
 * importMidiAsTracks. Both renderers count their calls and how many run at once.
 *
 *   cd frontend && npx tsx src/lib/midiImportTracks.renders.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore, type AudioClip, type EditorTrack } from '../state/editorStore.ts';
import { clipVoice } from './clipProgram.ts';
import { createStaleRerenderQueue, midiClipVoiceSig, onClipRenderHandedBack, staleMidiClipIds, type ClipRerenderDeps } from './clipRerender.ts';
import { encodeMidi, parseMidi, type MidiTrack } from './midi.ts';
import { importMidiAsTracks, type MidiTracksDeps } from './midiImportTracks.ts';

const ed = () => useEditorStore.getState();
const PARTS = 24;
let global = { useSoundfont: true, activeProgram: 5 };

/** A renderer that counts its calls, how many run at once, and which program each played. */
function countingRenderer() {
  const calls: Array<{ program?: number }> = [];
  let running = 0;
  let most = 0;
  const render = async (_notes: unknown[], _bpm: number, _total: number, opts: { program?: number }) => {
    calls.push({ program: opts.program });
    running += 1;
    most = Math.max(most, running);
    await new Promise((res) => setTimeout(res, 3));
    running -= 1;
    return { blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' }), duration: 4 };
  };
  return { calls, render, most: () => most };
}

/** EDIT's instrument-sync effect, run on every change of the editor store. */
function replayEditorSync() {
  const r = countingRenderer();
  const deps: ClipRerenderDeps = {
    render: r.render,
    computePeaks: () => Promise.resolve({ peaks: new Float32Array(8) }),
    global: () => global,
    ensureReady: () => Promise.resolve(),
  };
  const errors: unknown[] = [];
  const queue = createStaleRerenderQueue(deps, (_id, e) => errors.push(e));
  let sig = '';
  const run = () => {
    const s = ed();
    const next = midiClipVoiceSig(s.clips, s.tracks, global);
    if (next === sig) return;
    sig = next;
    queue.request(staleMidiClipIds(s.clips, s.tracks, global));
  };
  const unsubscribe = useEditorStore.subscribe(run);
  // WaveformEditor's second effect: a clip handed back unrendered asks the pass again.
  const handBack = onClipRenderHandedBack(() => {
    const s = ed();
    queue.request(staleMidiClipIds(s.clips, s.tracks, global));
  });
  run();
  return {
    ...r,
    queue,
    errors,
    stop: () => {
      unsubscribe();
      handBack();
    },
    rerun: run,
  };
}

// A 24-part orchestral file: one track per part, each with its own program and eight notes.
const tracks: MidiTrack[] = Array.from({ length: PARTS }, (_, i) => {
  const channel = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15][i % 15];
  return {
    name: `Part ${i + 1}`,
    programs: [{ tick: 0, channel, program: 40 + (i % 30) }],
    notes: Array.from({ length: 8 }, (_, k) => ({ tick: k * 960, durationTicks: 960, note: 48 + ((i + k) % 24), velocity: 80, channel })),
  };
});
const data = parseMidi(encodeMidi({ ppq: 960, bpm: 96, tracks }));
assert.equal(data.tracks.filter((t) => t.notes.length).length, PARTS);

const importDeps = (render: MidiTracksDeps['render']): MidiTracksDeps => ({
  render,
  computePeaks: () => Promise.resolve({ peaks: new Float32Array(8) }),
  global: () => global,
});

// ── 24 parts with EDIT open: 24 renders, one at a time, none from the effect ─
{
  ed().loadProject({ tracks: [], clips: [] });
  const sync = replayEditorSync();
  const own = countingRenderer();
  const landed = importMidiAsTracks(data, { label: 'orchestra', atSec: 0 }, importDeps(own.render));
  assert.ok(landed);
  assert.equal(landed.parts.length, PARTS);
  await landed.rendered;
  await sync.queue.idle();
  sync.stop();
  assert.equal(own.calls.length, PARTS, 'the import renders each part once');
  assert.equal(own.most(), 1, 'one at a time');
  assert.equal(sync.calls.length, 0, "EDIT's instrument-sync pass leaves the import's clips to it");
  const clips = ed().clips.filter((c) => landed.parts.some((p) => p.clipId === c.id));
  assert.ok(clips.every((c) => c.renderedProgram === clipVoice(c, ed().tracks.find((t) => t.id === c.trackId), global).program), 'every clip holds a current render');
  assert.deepEqual(staleMidiClipIds(ed().clips, ed().tracks, global), [], 'nothing left stale');
}

// ── an instrument changed while the parts render ────────────────────────────
{
  ed().loadProject({ tracks: [], clips: [] });
  const sync = replayEditorSync();
  const own = countingRenderer();
  const landed = importMidiAsTracks(data, { label: 'orchestra', atSec: 0 }, importDeps(own.render));
  assert.ok(landed);
  const first = landed.parts[0];
  const last = landed.parts[PARTS - 1];
  // Wait for the first part's render to land, then re-voice the first (rendered) and the last (still waiting).
  while (!ed().clips.find((c) => c.id === first.clipId)?.renderedProgram) await new Promise((res) => setTimeout(res, 1));
  // A part with a program of its own keeps it on its clip, so the clip is what the instrument picker changes.
  ed().updateClip(first.clipId, { instrumentProgram: 71 });
  ed().updateClip(last.clipId, { instrumentProgram: 72 });
  await landed.rendered;
  await sync.queue.idle();
  sync.stop();
  assert.equal(own.calls.length, PARTS, 'the import still renders each part once');
  assert.equal(own.calls[PARTS - 1].program, 72, 'the part still waiting renders with the voice it has at its turn');
  assert.deepEqual(sync.calls.map((c) => c.program), [71], 'EDIT renders the re-voiced part that had already rendered, once');
  assert.equal(ed().clips.find((c) => c.id === first.clipId)?.renderedProgram, 71);
  assert.equal(ed().clips.find((c) => c.id === last.clipId)?.renderedProgram, 72);
}

// ── an import undone before its renders land: nothing stays claimed ──────────
{
  ed().loadProject({ tracks: [], clips: [] });
  const sync = replayEditorSync();
  const own = countingRenderer();
  const landed = importMidiAsTracks(data, { label: 'orchestra', atSec: 0 }, importDeps(own.render));
  assert.ok(landed);
  ed().undo();
  assert.equal(ed().clips.length, 0, 'one undo takes every part away');
  await landed.rendered;
  assert.equal(own.calls.length, 0, 'nothing renders: every clip was gone when its turn came');
  // Redo brings the parts back with their placeholders: EDIT renders them, one at a time.
  ed().redo();
  sync.rerun();
  await sync.queue.idle();
  sync.stop();
  assert.equal(ed().clips.length, PARTS);
  assert.equal(sync.calls.length, PARTS, 'each part once');
  assert.equal(sync.most(), 1, 'one at a time');
  assert.deepEqual(staleMidiClipIds(ed().clips, ed().tracks, global), []);
}

// ── an import that fails part way hands the clips it made back to EDIT ──────
{
  ed().loadProject({ tracks: [], clips: [] });
  const sync = replayEditorSync();
  const real = ed().addClipToTrack;
  let adds = 0;
  useEditorStore.setState({
    addClipToTrack: (clip) => {
      adds += 1;
      if (adds === 3) throw new Error('the third clip failed');
      return real(clip);
    },
  });
  let failure: unknown = null;
  try {
    importMidiAsTracks(data, { label: 'orchestra', atSec: 0 }, importDeps(countingRenderer().render));
  } catch (e) {
    failure = e;
  } finally {
    useEditorStore.setState({ addClipToTrack: real });
  }
  assert.match(String(failure), /the third clip failed/, 'the failure reaches the caller, which logs it');
  assert.equal(ed().clips.length, 2, 'the two clips made before it');
  // Handed back unrendered, they are EDIT's to render at once: nothing stays claimed.
  await sync.queue.idle();
  sync.stop();
  assert.equal(sync.calls.length, 2);
  assert.deepEqual(staleMidiClipIds(ed().clips, ed().tracks, global), []);
}

// ── a part whose render fails is tried once more through EDIT ────────────────
{
  ed().loadProject({ tracks: [], clips: [] });
  const sync = replayEditorSync();
  const own = countingRenderer();
  let n = 0;
  const failing: MidiTracksDeps['render'] = async (notes, bpm, total, opts) => {
    n += 1;
    if (n === 2) throw new Error('the soundfont refused part 2');
    return own.render(notes, bpm, total, opts);
  };
  const errors: string[] = [];
  const landed = importMidiAsTracks(data, { label: 'orchestra', atSec: 0 }, { ...importDeps(failing), onRenderError: (name) => errors.push(name) });
  assert.ok(landed);
  assert.equal(await landed.rendered, PARTS - 1, 'every part but the second rendered in turn');
  await sync.queue.idle();
  sync.stop();
  assert.deepEqual(errors, ['Part 2']);
  assert.equal(sync.calls.length, 1, 'EDIT rendered the second part once');
  assert.deepEqual(staleMidiClipIds(ed().clips, ed().tracks, global), [], 'nothing left stale');
}

// ── EDIT's own pass: a picker change over 24 clips renders each once, in turn ─
{
  const track = (id: string): EditorTrack => ({ id, name: id, nameAutoGenerated: false, volume: 0.8, pan: 0, mute: false, solo: false, color: '#fff' });
  const clip = (i: number): AudioClip => ({
    id: `c${i}`,
    trackId: `t${i}`,
    label: `c${i}`,
    audioBlob: new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 2,
    offsetIntoSource: 0,
    durationSec: 2,
    startSec: 0,
    color: '#fff',
    sourceKind: 'piano-roll',
    sourcePianoRoll: [{ id: `n${i}`, note: 60, step: 0, length: 4, velocity: 90, tick: 0, ticks: 960 }],
    sourceBpm: 120,
    sourceTotalSteps: 16,
    // Rendered with the picker's program 5; the clips and their tracks have none of their own.
    renderedProgram: 5,
  });
  global = { useSoundfont: true, activeProgram: 5 };
  ed().loadProject({ tracks: Array.from({ length: PARTS }, (_, i) => track(`t${i}`)), clips: Array.from({ length: PARTS }, (_, i) => clip(i)) });
  const sync = replayEditorSync();
  assert.equal(sync.calls.length, 0, 'every render current');
  global = { useSoundfont: true, activeProgram: 7 };
  sync.rerun();
  await sync.queue.idle();
  sync.stop();
  assert.equal(sync.calls.length, PARTS, 'each clip once, however many renders land meanwhile');
  assert.equal(sync.most(), 1, 'one at a time');
  assert.ok(sync.calls.every((c) => c.program === 7));
  assert.deepEqual(sync.errors, []);
}

console.log('midiImportTracks.renders: ok');
