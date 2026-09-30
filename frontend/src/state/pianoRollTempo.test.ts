/**
 * The piano roll's tempo map as a document field, replayed against the real
 * roll and editor stores: the TEMPO lane's edits and the header's BPM, undo
 * and redo over every one of them, imports and clip loads, and the send that
 * carries the map to EDIT and back (lib/rollBounce, lib/rollClip), where live
 * playback, drawing, every export render and every re-render (the MIDI render
 * queue, state/midiRenderQueue) time the clip's notes through it.
 * Run from `frontend/`:
 *   npx tsx src/state/pianoRollTempo.test.ts
 */
import assert from 'node:assert/strict';
import { usePianoRollStore, type PianoNote } from './pianoRollStore.ts';
import { useEditorStore } from './editorStore.ts';
import { midiClipNoteTimes } from './liveMixer.ts';
import { bounceRollToEditor, type RollBounceDeps } from '../lib/rollBounce.ts';
import { clipNoteSpan, clipRollLoad } from '../lib/rollClip.ts';
import { clipsWithMidiAudio, configureMidiRenderQueue, requestMidiRender } from './midiRenderQueue.ts';
import { liveMidiIfHeard } from './liveMixer.ts';
import { stepRenderRequest, type RenderNote } from '../lib/midiSynth.ts';
import { bounceMidiClip, stretchMidiClip } from '../lib/clipOps/audioOps.ts';
import { stepClock } from '../lib/rollTempo.ts';
import type { TempoEvent } from '../lib/tempoMap.ts';

const st = () => usePianoRollStore.getState();
const ed = () => useEditorStore.getState();
const near = (a: number, b: number, eps = 1e-9, msg = ''): void => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} !~ ${b}`);
const shape = (map: readonly TempoEvent[]) =>
  map.map((e) => (e.fermata ? `f${e.beat}:${e.fermata.beats}x${e.fermata.stretch}` : `${e.beat}:${e.bpm}${e.curve === 'linear' ? 'r' : ''}`)).join(' ');

/** Reset the undo stacks and the coalesce clock, so the next edit is a step of its own. */
const fresh = () => {
  usePianoRollStore.setState({ _undo: [], _redo: [] });
  // An undo with nothing to undo is a no-op; a real one resets the coalesce clock.
  st().setTempoMap(st().tempoMap);
};

/** One edit as one undo step: the coalesce window is 300 ms, so each edit waits it out. */
const later = () => new Promise((r) => setTimeout(r, 320));

async function main(): Promise<void> {
  // ── The header's BPM is the map's start ─────────────────────────────────
  st().importNotes([{ id: 'a', note: 60, step: 0, length: 4, velocity: 90 }], 120);
  assert.equal(shape(st().tempoMap), '0:120');
  st().setBpm(97.35);
  assert.equal(st().bpm, 97.35, 'the BPM field keeps a fraction');
  assert.equal(shape(st().tempoMap), '0:97.35', 'and writes it into the start of the map');
  st().setBpm(12);
  assert.equal(st().bpm, 20, 'the range is the app\'s 20-300');
  st().setBpm(333);
  assert.equal(st().bpm, 300);
  st().setBpm(60);

  // ── TEMPO lane edits, and undo over each ────────────────────────────────
  fresh();
  await later();
  const start = shape(st().tempoMap);
  st().addTempoEvent({ beat: 8, bpm: 132 });
  await later();
  st().addTempoEvent({ beat: 16, bpm: 132, curve: 'linear' });
  await later();
  st().addTempoEvent({ beat: 24, bpm: 66 });
  await later();
  st().addTempoEvent({ beat: 28, bpm: 66, fermata: { beats: 2, stretch: 2.5 } });
  await later();
  st().moveTempoEvent(8, 'tempo', { beat: 8.25, bpm: 138 });
  await later();
  st().moveTempoEvent(0, 'tempo', { beat: 5, bpm: 54 });
  await later();
  st().moveTempoEvent(28, 'fermata', { fermata: { beats: 1, stretch: 3 } });
  await later();
  st().removeTempoEvent(24, 'tempo');
  await later();
  st().removeTempoEvent(0, 'tempo');
  const end = '0:54 8.25:138 16:132r f28:1x3';
  assert.equal(shape(st().tempoMap), end, 'the start stays at beat 0 and cannot be removed');
  assert.equal(st().bpm, 54, 'moving the start re-tempos the header');
  const steps = [
    end,
    '0:54 8.25:138 16:132r 24:66 f28:1x3',
    '0:54 8.25:138 16:132r 24:66 f28:2x2.5',
    '0:60 8.25:138 16:132r 24:66 f28:2x2.5',
    '0:60 8:132 16:132r 24:66 f28:2x2.5',
    '0:60 8:132 16:132r 24:66',
    '0:60 8:132 16:132r',
    '0:60 8:132',
    start,
  ];
  for (let i = 1; i < steps.length; i += 1) {
    st().undo();
    assert.equal(shape(st().tempoMap), steps[i], `undo ${i}`);
    assert.equal(st().bpm, st().tempoMap[0].bpm, 'bpm follows the map through undo');
  }
  for (let i = steps.length - 2; i >= 0; i -= 1) {
    st().redo();
    assert.equal(shape(st().tempoMap), steps[i], `redo to ${i}`);
  }
  // A tempo change dragged onto beat 0 stops a tick after it; the start is never lost.
  st().moveTempoEvent(8.25, 'tempo', { beat: 0 });
  assert.equal(shape(st().tempoMap).split(' ').slice(0, 2).join(' '), `0:54 ${1 / 960}:138`);
  st().undo();

  // ── Imports ─────────────────────────────────────────────────────────────
  const map = st().tempoMap;
  st().importNotes([{ id: 'x', note: 62, step: 0, length: 1, velocity: 80 }]);
  assert.equal(st().tempoMap, map, 'an import with no tempo keeps the map');
  st().importNotes([{ id: 'y', note: 62, step: 0, length: 1, velocity: 80 }], 97.3);
  assert.equal(shape(st().tempoMap), '0:97.3', 'notes placed at one tempo make the roll one tempo');
  st().importNotes([{ id: 'z', note: 62, step: 0, length: 1, velocity: 80 }], 70, undefined, undefined, [{ beat: 0, bpm: 70 }, { beat: 4, bpm: 90, curve: 'linear' }, { beat: 8, bpm: 110 }]);
  assert.equal(shape(st().tempoMap), '0:70 4:90r 8:110');
  assert.equal(st().bpm, 70);

  // ── Bounce to EDIT and back ─────────────────────────────────────────────
  ed().loadProject({ tracks: [], clips: [] });
  st().clear();
  st().setEditingClip(null);
  const notes: PianoNote[] = [];
  for (let s = 0; s < 64; s += 4) notes.push({ id: `n${s}`, note: 60 + (s % 12), step: s, length: 2, velocity: 90 });
  const ritardando: TempoEvent[] = [{ beat: 0, bpm: 60 }, { beat: 8, bpm: 132 }, { beat: 12, bpm: 132, curve: 'linear' }, { beat: 16, bpm: 66 }];
  st().importNotes(notes, 60, undefined, [], ritardando);
  usePianoRollStore.setState({ totalSteps: 64 });
  const rendered: Array<{ notes: RenderNote[]; nominalSec: number; tempoMap?: readonly TempoEvent[] }> = [];
  const picker = () => ({ useSoundfont: true, activeProgram: 0 });
  configureMidiRenderQueue({
    render: (n, bpm, totalSteps, opts) => {
      const req = stepRenderRequest(n, bpm, totalSteps, opts);
      rendered.push({ notes: req.notes, nominalSec: req.nominalSec, tempoMap: opts.tempoMap });
      return Promise.resolve({ blob: new Blob([new Uint8Array(8)], { type: 'audio/wav' }), duration: req.nominalSec });
    },
    computePeaks: () => Promise.resolve({ peaks: new Float32Array(4) }),
    global: picker,
    ensureReady: () => Promise.resolve(),
    livePlan: liveMidiIfHeard,
  });
  const deps: RollBounceDeps = { global: picker };
  /** An export of the clip: the MIDI render queue renders it for that export alone. */
  const exportClip = async (clipId: string): Promise<void> => {
    const out = await clipsWithMidiAudio((c) => c.id === clipId);
    out.release();
  };
  const done = await bounceRollToEditor(deps);
  assert.ok(done);
  assert.equal(rendered.length, 0, 'the part plays live, so the send renders nothing');
  await exportClip(done.clipId);
  const clock = stepClock(60, ritardando);
  const bounce = rendered.at(-1)!;
  // The bounce plays the map: each note at its step's seconds, its length its steps' seconds.
  bounce.notes.forEach((r, i) => {
    near(r.startSec, clock.at(notes[i].step), 1e-9, `note ${i} starts at its step's second`);
    near(r.durationSec, clock.at(notes[i].step + 2) - clock.at(notes[i].step), 1e-9, `note ${i} length`);
  });
  near(bounce.nominalSec, clock.at(64), 1e-9, 'the clip lasts the map\'s time');
  near(bounce.notes[2].startSec, 2, 1e-9, 'the Adagio: a second a beat');
  near(bounce.notes[9].startSec - bounce.notes[8].startSec, 60 / 132, 1e-9, 'the Allegro');

  const clip = ed().clips.find((c) => c.id === done.clipId)!;
  assert.equal(shape(clip.sourceTempoMap ?? []), '0:60 8:132 12:132r 16:66', 'the clip carries the map');
  assert.equal(clip.sourceBpm, 60);
  // EDIT live playback and drawing time the notes as the bounce does.
  const live = midiClipNoteTimes({ ...clip, startSec: 3, durationSec: 60 }, 120, 0);
  live.forEach((t, i) => {
    near(t.onSec, 3 + clock.at(notes[i].step), 1e-9, `live note ${i}`);
    near(t.offSec, 3 + clock.at(notes[i].step + 2), 1e-9);
  });
  const drawn = clipNoteSpan(clip.sourcePianoRoll![10], stepClock(clip.sourceBpm!, clip.sourceTempoMap), 0);
  near(drawn.relStart, clock.at(40), 1e-9, 'EDIT draws the note where it plays');

  // Reopening the clip brings the map back, and undoing the open brings back the roll's own.
  st().setTempoMap([{ beat: 0, bpm: 90 }]);
  st().loadFromClip(...clipRollLoad(clip));
  assert.equal(shape(st().tempoMap), '0:60 8:132 12:132r 16:66');
  st().undo();
  assert.equal(shape(st().tempoMap), '0:90');
  st().redo();

  // A re-send after the last change is gone clears the clip's map.
  st().setTempoMap([{ beat: 0, bpm: 60 }]);
  await bounceRollToEditor(deps);
  await exportClip(done.clipId);
  const cleared = ed().clips.find((c) => c.id === done.clipId)!;
  assert.equal(cleared.sourceTempoMap, undefined, 'a clip at one tempo carries no map');
  assert.equal(rendered.at(-1)?.tempoMap, undefined);
  assert.deepEqual(clipRollLoad(cleared)[6], undefined);

  // A clip bounced before maps existed opens at its one tempo.
  const older = { ...cleared, sourceBpm: 88 };
  delete older.sourceTempoMap;
  st().loadFromClip(...clipRollLoad(older));
  assert.equal(shape(st().tempoMap), '0:88');

  // ── EDIT re-renders and the assistant's stretch keep the map ────────────
  st().importNotes(notes, 60, undefined, [], ritardando);
  usePianoRollStore.setState({ totalSteps: 64 });
  await bounceRollToEditor(deps);
  const mapped = ed().clips.find((c) => c.id === done.clipId)!;
  // "Keep rendered audio": the part keeps a render; a new instrument makes it
  // stale, and EDIT's render upkeep renders it again.
  await requestMidiRender(done.clipId, 'keep');
  ed().updateTrack(mapped.trackId, { instrumentProgram: 41 });
  const before = rendered.length;
  const again = await requestMidiRender(done.clipId, 'cache');
  assert.equal(again.kind, 'written', 'the new voice re-renders the clip');
  assert.equal(rendered.length, before + 1);
  assert.equal(shape(rendered.at(-1)!.tempoMap ?? []), '0:60 8:132 12:132r 16:66', 'through its tempo map');
  const opsRenders: Array<{ bpm: number; notes: RenderNote[] }> = [];
  const render = (n: Parameters<typeof stepRenderRequest>[0], bpm: number, total: number, opts?: Parameters<typeof stepRenderRequest>[3]) => {
    opsRenders.push({ bpm, notes: stepRenderRequest(n, bpm, total, opts).notes });
    return Promise.resolve({ blob: new Blob([]), duration: 1 });
  };
  const current = ed().clips.find((c) => c.id === done.clipId)!;
  await bounceMidiClip(current, { render });
  near(opsRenders[0].notes[3].startSec, clock.at(12), 1e-9, 'a clip bounce plays its map');
  await stretchMidiClip(current, 0.5, { render });
  // Twice as fast: the whole map scales, so every note lands at half its second.
  opsRenders[1].notes.forEach((r, i) => near(r.startSec, opsRenders[0].notes[i].startSec / 2, 1e-9, `stretched note ${i}`));

  // ── A stretched or retagged clip opens at the tempo EDIT plays ──────────
  // The assistant's stretch rewrites sourceBpm (60 -> 120) and keeps the map;
  // the roll must open at 120 with every change scaled, never at the map's 60.
  ed().updateClip(done.clipId, { sourceBpm: 120 });
  const stretched = ed().clips.find((c) => c.id === done.clipId)!;
  const plays = midiClipNoteTimes({ ...stretched, startSec: 0, durationSec: 60 }, 120, 0);
  st().loadFromClip(...clipRollLoad(stretched));
  assert.equal(st().bpm, 120, 'the roll opens at the clip\'s sourceBpm');
  assert.equal(shape(st().tempoMap), '0:120 8:264 12:264r 16:132', 'with every change scaled with it');
  const opened = stepClock(st().bpm, st().tempoMap);
  stretched.sourcePianoRoll!.forEach((n, i) => near(opened.at(n.step), plays[i].onSec, 1e-9, `reopened note ${i} plays where EDIT plays it`));
  near(opened.at(32), 4, 1e-9, 'step 32 at 4 s, as EDIT plays it');
  // A SAVE back to the clip writes the stretched tempo, so the stretch survives.
  assert.equal(clipRollLoad(stretched)[2], 120);

  console.log('pianoRollTempo: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
