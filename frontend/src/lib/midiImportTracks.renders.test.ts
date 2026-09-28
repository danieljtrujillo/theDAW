/**
 * Import as tracks renders nothing for a part that plays live, and each part
 * that cannot play live exactly once, one at a time, through EDIT's MIDI
 * render queue.
 *
 * Before (midi3-io on its own): every clip Import as tracks made held a silent
 * placeholder and was rendered at once by the import, whatever its voice, and
 * EDIT's instrument-sync effect read every placeholder as a stale render and
 * started more; a 24-part file started 324 renders, up to 278 at once. With
 * EDIT's live MIDI, a part with a voice plays on EDIT's synths and renders
 * only when an export needs it, so a 24-part file holds no audio, and a part
 * with no voice (no program and the picker off) is queued on the MIDI render
 * queue (state/midiRenderQueue), which renders one clip at a time and skips a
 * clip that is gone when its turn comes.
 *
 * The queue here is the app's, configured with a stand-in synth that counts
 * its calls and how many run at once, and the import runs on a real 24-part
 * MIDI file against the real editor store.
 *
 *   cd frontend && npx tsx src/lib/midiImportTracks.renders.test.ts
 */
import assert from 'node:assert/strict';
import { useEditorStore } from '../state/editorStore.ts';
import { configureMidiRenderQueue, requestMidiRender } from '../state/midiRenderQueue.ts';
import { liveMidiIfHeard } from '../state/liveMixer.ts';
import { encodeMidi, parseMidi, type MidiTrack } from './midi.ts';
import { importMidiAsTracks, type MidiTracksDeps } from './midiImportTracks.ts';
import { midiRenderState, type MidiStepRender } from './midiRender.ts';
import type { GlobalVoice } from './clipProgram.ts';

const ed = () => useEditorStore.getState();
const PARTS = 24;
let global: GlobalVoice = { useSoundfont: true, activeProgram: 5 };

// The app's MIDI render queue with a stand-in synth that counts its calls and how many run at once.
const calls: Array<{ program?: number; percussion?: boolean }> = [];
let running = 0;
let most = 0;
let failNext = 0;
const render: MidiStepRender = async (_notes, _bpm, _total, opts) => {
  calls.push({ program: opts.program, percussion: opts.percussion });
  running += 1;
  most = Math.max(most, running);
  await new Promise((res) => setTimeout(res, 3));
  running -= 1;
  if (failNext > 0) {
    failNext -= 1;
    throw new Error('the soundfont refused this part');
  }
  return { blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' }), duration: 4 };
};
configureMidiRenderQueue({
  render,
  computePeaks: () => Promise.resolve({ peaks: new Float32Array(8) }),
  global: () => global,
  ensureReady: () => Promise.resolve(),
  livePlan: liveMidiIfHeard,
});
const reset = () => {
  calls.length = 0;
  most = 0;
};
const deps = (extra: Partial<MidiTracksDeps> = {}): MidiTracksDeps => ({ global: () => global, ...extra });
const stateOf = (clipId: string) => {
  const clip = ed().clips.find((c) => c.id === clipId)!;
  return midiRenderState(clip, ed().tracks.find((t) => t.id === clip.trackId), global);
};

/** A 24-part orchestral file: one track per part, eight notes each, with a program change or (voiceless) without. */
const orchestra = (programs: boolean) => {
  const tracks: MidiTrack[] = Array.from({ length: PARTS }, (_, i) => {
    const channel = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15][i % 15];
    return {
      name: `Part ${i + 1}`,
      ...(programs ? { programs: [{ tick: 0, channel, program: 40 + (i % 30) }] } : {}),
      notes: Array.from({ length: 8 }, (_, k) => ({ tick: k * 960, durationTicks: 960, note: 48 + ((i + k) % 24), velocity: 80, channel })),
    };
  });
  const data = parseMidi(encodeMidi({ ppq: 960, bpm: 96, tracks }));
  assert.equal(data.tracks.filter((t) => t.notes.length).length, PARTS);
  return data;
};

// ── 24 parts on their programs: every part plays live, nothing renders ───────
{
  ed().loadProject({ tracks: [], clips: [] });
  reset();
  const landed = importMidiAsTracks(orchestra(true), { label: 'orchestra', atSec: 0 }, deps());
  assert.ok(landed);
  assert.equal(landed.parts.length, PARTS);
  assert.equal(await landed.rendered, 0, 'no render queued');
  assert.equal(calls.length, 0, 'nothing rendered');
  const heard = liveMidiIfHeard(ed().clips, ed().tracks, global);
  assert.ok(landed.parts.every((p) => heard.has(p.clipId) && !p.rendering && stateOf(p.clipId) === 'none'), 'each part plays live and holds no audio');
  assert.equal(ed().clips.reduce((n, c) => n + (c.audioBlob?.size ?? 0), 0), 0, '0 bytes of audio held');
}

// ── 24 voiceless parts with the picker off: each renders once, one at a time ─
{
  global = { useSoundfont: false, activeProgram: 0 };
  ed().loadProject({ tracks: [], clips: [] });
  reset();
  const ready: string[] = [];
  const landed = importMidiAsTracks(orchestra(false), { label: 'orchestra', atSec: 0 }, deps({ onRendered: (n, of) => ready.push(`${n}/${of}`) }));
  assert.ok(landed);
  assert.ok(landed.parts.every((p) => p.rendering), 'every part has no voice, so each is queued');
  assert.equal(await landed.rendered, PARTS, 'every queued render landed');
  assert.equal(calls.length, PARTS, 'each part rendered once');
  assert.equal(most, 1, 'one at a time');
  assert.equal(ready.at(-1), `${PARTS}/${PARTS}`, 'the last landing says all are ready');
  assert.ok(landed.parts.every((p) => stateOf(p.clipId) === 'current'), 'every clip holds a current render');
  assert.ok(ed().clips.every((c) => c.renderAuto === true), 'each made so the part can be heard, so dropped once it plays live');
  // A second request finds each render current and renders nothing.
  for (const p of landed.parts) await requestMidiRender(p.clipId, 'cache');
  assert.equal(calls.length, PARTS, 'nothing renders twice');
}

// ── an import undone before its renders land: nothing renders for the gone clips ─
{
  global = { useSoundfont: false, activeProgram: 0 };
  ed().loadProject({ tracks: [], clips: [] });
  reset();
  const landed = importMidiAsTracks(orchestra(false), { label: 'orchestra', atSec: 0 }, deps());
  assert.ok(landed);
  ed().undo();
  assert.equal(ed().clips.length, 0, 'one undo takes every part away');
  const written = await landed.rendered;
  assert.ok(written <= 1, `at most the render already running when the undo came lands (${written})`);
  assert.ok(calls.length <= 1, `and no clip that was gone at its turn renders (${calls.length})`);
  // Redo brings the parts back; the queue renders each that still needs audio, once, one at a time.
  ed().redo();
  reset();
  for (const c of ed().clips) await requestMidiRender(c.id, 'cache');
  assert.equal(ed().clips.length, PARTS);
  assert.ok(calls.length <= PARTS && calls.length >= PARTS - 1, `each part at most once (${calls.length})`);
  assert.equal(most, 1, 'one at a time');
  assert.ok(ed().clips.every((c) => stateOf(c.id) === 'current'));
}

// ── a part whose render fails is reported, and the queue renders it on request ─
{
  global = { useSoundfont: false, activeProgram: 0 };
  ed().loadProject({ tracks: [], clips: [] });
  reset();
  failNext = 1;
  const errors: string[] = [];
  const landed = importMidiAsTracks(orchestra(false), { label: 'orchestra', atSec: 0 }, deps({ onRenderError: (name) => errors.push(name) }));
  assert.ok(landed);
  assert.equal(await landed.rendered, PARTS - 1, 'every part but the failed one rendered');
  assert.equal(errors.length, 1, 'the failed part is reported');
  const failed = landed.parts.find((p) => p.name === errors[0])!;
  assert.equal(stateOf(failed.clipId), 'none', 'it keeps its notes and holds no audio');
  await requestMidiRender(failed.clipId, 'cache');
  assert.equal(stateOf(failed.clipId), 'current', "EDIT's upkeep renders it on its next request");
}

console.log('midiImportTracks.renders: ok');
