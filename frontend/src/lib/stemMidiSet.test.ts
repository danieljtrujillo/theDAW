/**
 * Every stem MIDI of a library song in one step (lib/stemMidiSet): the
 * LIBRARY's MIDI rows menu "All stems to piano roll" and "All stems to EDIT
 * as tracks".
 *
 * Before: each stem's MIDI came in on its own, and a second one replaced the
 * first in the roll. The sequence now: a song converted with its stems has a
 * full-mix MIDI and four stem MIDI rows (vocals, bass and other from
 * basic-pitch at the song's stamped 96 BPM, the drums from the drum engine
 * with its own tempo map). The roll action opens them as four parts named for
 * their stems, each on its stem's instrument (the drums on channel 10), every
 * note at the second it was transcribed at under one tempo map, each part
 * marked as timed against the song's audio; the vocal's pitch wheel becomes
 * its notes' own bends, so no lane curve bends the other parts. The EDIT
 * action lays the same four parts on four tracks, the drums on a drum track,
 * in one undo step. The full mix never joins them, and a stem whose file
 * fails to load is named in the LOG while the rest come in.
 *
 *   cd frontend && npx tsx src/lib/stemMidiSet.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, type MidiFileData } from './midi.ts';
import { stemMidiRows, stemMidisToEdit, stemMidisToRoll } from './stemMidiSet.ts';
import { stepClock } from './rollTempo.ts';
import { beatToTime } from './tempoMap.ts';
import { rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { useLogStore } from '../state/logStore.ts';
import { clipVoice } from './clipProgram.ts';

const roll = () => usePianoRollStore.getState();
const ed = () => useEditorStore.getState();
const near = (a: number, b: number, eps: number, msg: string) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

/** A basic-pitch stem at the song's stamped tempo: one unnamed track on program 4, notes at `seconds`. */
const pitched = (bpm: number, seconds: number[], pitch: number, bends: Array<[number, number]> = []): MidiFileData => {
  const ppq = 220;
  const tick = (sec: number) => Math.round((sec * bpm * ppq) / 60);
  return {
    ppq,
    bpm,
    tracks: [{
      name: '',
      programs: [{ tick: 0, channel: 0, program: 4 }],
      notes: seconds.map((sec, i) => ({ tick: tick(sec), durationTicks: tick(0.4), note: pitch + i, velocity: 90, channel: 0 })),
      ...(bends.length ? { bends: bends.map(([sec, value]) => ({ tick: tick(sec), channel: 0, value })) } : {}),
    }],
  };
};

// The drum engine's file: channel 10 on the song's beats, a tempo change at beat 8 (96 then 90 BPM).
const drumTempos = [{ tick: 0, bpm: 96 }, { tick: 8 * 220, bpm: 90 }];
const drumSec = (tick: number) => beatToTime([{ beat: 0, bpm: 96 }, { beat: 8, bpm: 90 }], tick / 220);
const drumTicks = [0, 440, 1760, 2200];
const drums: MidiFileData = {
  ppq: 220,
  bpm: 96,
  tempos: drumTempos,
  tracks: [{ name: 'Drums', programs: [{ tick: 0, channel: 9, program: 0 }], notes: drumTicks.map((tick, i) => ({ tick, durationTicks: 30, note: i % 2 ? 38 : 36, velocity: 100, channel: 9 })) }],
};

const files: Record<string, MidiFileData> = {
  e9__full: pitched(96, [0.1, 0.9], 60),
  e9__vocals_midi: pitched(96, [0.5, 2.0, 7.3], 67, [[0.5, 8192], [0.7, 12000], [0.85, 8192]]),
  e9__bass_midi: pitched(96, [0.0, 1.25, 6.9], 40),
  e9__drums_midi: drums,
  e9__other_midi: pitched(96, [3.3], 72),
};
const rows = [
  { id: 'e9__full', source: 'full', midi_path: 'C:/data/e9/midi/full.mid', parent_id: 'e9' },
  { id: 'e9__vocals_midi', source: 'stem', midi_path: 'C:/data/e9/midi/vocals.mid', parent_id: 'e9' },
  { id: 'e9__bass_midi', source: 'stem', midi_path: 'C:/data/e9/midi/bass.mid', parent_id: 'e9' },
  { id: 'e9__drums_midi', source: 'stem', midi_path: 'C:/data/e9/midi/drums.mid', parent_id: 'e9' },
  { id: 'e9__other_midi', source: 'stem', midi_path: 'C:/data/e9/midi/other.mid', parent_id: 'e9' },
];
const missing = new Set<string>();
(globalThis as { fetch: unknown }).fetch = async (url: string) => {
  const id = decodeURIComponent(String(url).split('/').pop() ?? '');
  const f = files[id];
  if (!f || missing.has(id)) return new Response('gone', { status: 404 });
  return new Response(encodeMidi(f).slice().buffer as ArrayBuffer, { status: 200 });
};

/** Each part's note onsets in seconds under the roll's clock. */
const partSeconds = (name: string): number[] => {
  const clock = stepClock(roll().bpm, roll().tempoMap);
  return rollTracksOf(roll()).find((t) => t.name === name)!.notes.map((n) => clock.at(n.step)).sort((a, b) => a - b);
};

// The rows a song's menu offers: its stems, never its full mix.
assert.deepEqual(stemMidiRows(rows).map((r) => r.id), ['e9__vocals_midi', 'e9__bass_midi', 'e9__drums_midi', 'e9__other_midi']);

// All stems to piano roll.
{
  roll().importParts([{ name: 'Old', notes: [{ id: 'o', note: 60, step: 0, length: 4, velocity: 80 }] }], 120);
  const done = await stemMidisToRoll(stemMidiRows(rows), 'Night Drive');
  assert.ok(done);
  const parts = rollTracksOf(roll());
  assert.deepEqual(parts.map((t) => t.name), ['Vocals', 'Bass', 'Drums', 'Other'], 'one part a stem, named for it');
  assert.deepEqual(parts.map((t) => [t.program, t.channel]), [[53, null], [33, null], [0, 10], [4, null]], "each on its stem's instrument, the drums on channel 10");
  assert.equal(parts.every((t) => t.fromAudio === true), true, "every part is timed against the song's audio");
  // Every note at the second it was transcribed at, the drums' tempo change and the pitched stems' one tempo together.
  partSeconds('Bass').forEach((s, i) => near(s, [0.0, 1.25, 6.9][i], 0.003, `bass note ${i}`));
  partSeconds('Vocals').forEach((s, i) => near(s, [0.5, 2.0, 7.3][i], 0.003, `vocal note ${i}`));
  partSeconds('Drums').forEach((s, i) => near(s, drumSec(drumTicks[i]), 0.003, `drum hit ${i}`));
  assert.equal(roll().tempoMap.length, 2, "the roll plays the drums' tempo map, the one that follows the song's beats");
  // The vocal's wheel is its first note's own bend; no lane curve bends the bass or the drums.
  assert.equal(roll().bends.filter((b) => b.points.length).length, 0);
  const vocal = parts.find((t) => t.name === 'Vocals')!.notes.find((n) => n.note === 67)!;
  assert.ok(vocal.expr?.curves?.pitchBend?.length, "the vocal's bend is its note's own");
  assert.match(useLogStore.getState().entries.map((e) => e.msg).join('\n'), /All stems of "Night Drive" into the piano roll: 4 parts \(Vocals, Bass, Drums, Other\)/);
}

// A stem whose file is gone: the rest come in, and the LOG names it.
{
  missing.add('e9__other_midi');
  useLogStore.getState().clear();
  const done = await stemMidisToRoll(stemMidiRows(rows), 'Night Drive', { retries: 0 });
  assert.ok(done);
  assert.deepEqual(rollTracksOf(roll()).map((t) => t.name), ['Vocals', 'Bass', 'Drums']);
  assert.match(useLogStore.getState().entries.filter((e) => e.level === 'warn').map((e) => e.msg).join('\n'), /"Night Drive": the other MIDI did not load/);
  missing.clear();
}

// All stems to EDIT as tracks.
{
  ed().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
  const undoBefore = ed()._undo.length;
  const done = await stemMidisToEdit(stemMidiRows(rows), 'Night Drive', { global: () => ({ useSoundfont: true, activeProgram: 0 }) });
  assert.ok(done);
  assert.equal(ed()._undo.length, undoBefore + 1, 'every track and clip in one undo step');
  assert.deepEqual(done.parts.map((p) => p.name), ['Vocals', 'Bass', 'Drums', 'Other']);
  const trackOf = (name: string) => ed().tracks.find((t) => t.id === done.parts.find((p) => p.name === name)!.trackId)!;
  assert.equal(trackOf('Drums').isPercussion, true, 'the drums on a drum track');
  assert.equal(trackOf('Bass').instrumentProgram, 33);
  const drumClip = ed().clips.find((c) => c.id === done.parts.find((p) => p.name === 'Drums')!.clipId)!;
  assert.equal(clipVoice(drumClip, trackOf('Drums'), { useSoundfont: true, activeProgram: 0 }).percussion, true);
  assert.equal(drumClip.sourceRollPart?.fromAudio, true, 'the clip keeps the audio mark for the roll');
  assert.match(useLogStore.getState().entries.map((e) => e.msg).join('\n'), /Import as tracks: 4 parts of "Night Drive"/);
}

console.log('stemMidiSet: ok');
