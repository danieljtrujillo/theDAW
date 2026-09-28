/**
 * A real string quartet (bars 530-640 of Beethoven's Op. 132, as a notation
 * program exports it: type 1 at 480 PPQ, tests/fixtures/quartet) into the roll
 * and into EDIT as tracks, and the EDIT arrangement back out as MIDI.
 *
 * The sequence: IMPORT the file into the roll: four parts on their registry
 * instruments, every note on the roll's 960 PPQ clock, the four time
 * signatures and the tempo change where they are (the file's first tempo sits
 * 251 beats in, so the piece plays at 120 until there, as SMF has it). Then
 * "Import as tracks" puts the same file into EDIT: four tracks named and voiced
 * after the parts, one clip each at the chosen second, all in one undo step,
 * rendered one part at a time; opening any clip opens all four parts. Then the
 * whole arrangement goes out as one type-1 MIDI file: a track per EDIT track,
 * each note at the second EDIT plays it.
 *
 *   cd frontend && npx tsx src/lib/quartetImport.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeMidi, parseMidi } from './midi.ts';
import { midiFileToRollParts } from './rollMidi.ts';
import { importMidiParts } from './rollPartsImport.ts';
import { importMidiAsTracks, type MidiTracksDeps } from './midiImportTracks.ts';
import { arrangementToMidiFile } from './arrangementMidi.ts';
import { clipNoteSpan, clipPartsLoad } from './rollClip.ts';
import { stepClock } from './rollTempo.ts';
import { beatToTime, timeToBeat } from './tempoMap.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';

class FakeAudioContext {
  async decodeAudioData() {
    return { duration: 1, getChannelData: () => new Float32Array(64).fill(0.5) };
  }
  async close() {}
}
(globalThis as { window?: unknown }).window = { AudioContext: FakeAudioContext };

const ed = () => useEditorStore.getState();
const roll = () => usePianoRollStore.getState();
const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../../../tests/fixtures/quartet/op132_m530-640.mid', import.meta.url))));
const data = parseMidi(bytes);

// ── the file as the roll reads it ─────────────────────────────────────────────
const file = midiFileToRollParts(data, 'q');
assert.equal(data.ppq, 480, 'the file is at 480 PPQ, as the roll wrote before and most programs do');
assert.deepEqual(file.parts.map((p) => p.track.name), ['Violin I', 'Violin II', 'Viola', 'Violoncello']);
assert.deepEqual(file.parts.map((p) => p.track.program), [40, 40, 41, 42], 'each part on its own program');
assert.deepEqual(file.parts.map((p) => p.track.instrumentId), ['violin', 'violin', 'viola', 'cello'], 'and its registry instrument');
assert.deepEqual(file.parts.map((p) => p.track.channel), [1, 1, 2, 3], 'on the channels the file gives them');
const noteCounts = data.tracks.filter((t) => t.notes.length).map((t) => t.notes.length);
assert.deepEqual(file.parts.map((p) => p.notes.length), noteCounts, 'every note of every track');
// 480 PPQ scales to the roll's 960 exactly: every tick doubled, nothing snapped to 16ths.
file.parts.forEach((p, k) => {
  const src = data.tracks.filter((t) => t.notes.length)[k].notes;
  const want = src.map((n) => `${n.tick * 2}:${n.durationTicks * 2}:${n.note}`).sort();
  const got = p.notes.map((n) => `${n.tick}:${n.ticks}:${n.note}`).sort();
  assert.deepEqual(got, want, `${p.track.name}: the file's ticks, doubled`);
});
// The first tempo mark (andantino, a dotted eighth at 80 = 60) is 251.5 beats in: 120 until there.
assert.deepEqual(file.tempoMap.map((e) => [e.beat, e.bpm]), [[0, 120], [251.5, 60]], 'the tempo change where the file puts it');
assert.deepEqual(
  file.meter.meterMap.map((s) => [s.bar, s.meter.num, s.meter.den]),
  [[0, 4, 4], [12, 3, 8], [65, 4, 4], [96, 3, 8]],
  'every time signature: bars 530, 542, 595 and 626',
);
assert.equal(file.meter.pickupSteps, 0);

// ── into the roll ─────────────────────────────────────────────────────────────
{
  const done = importMidiParts(data, 'q');
  assert.equal(done.into, 'parts');
  assert.equal(roll().tracks.length, 4);
  assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm]), [[0, 120], [251.5, 60]]);
  assert.deepEqual(roll().meterMap.map((s) => s.bar), [0, 12, 65, 96]);
}

// ── "Import as tracks": four EDIT tracks in one undo step ────────────────────
ed().loadProject({ tracks: [], clips: [] });
const renders: Array<{ program?: number; percussion?: boolean; started: number; ended?: number; notes: number }> = [];
let running = 0;
let maxRunning = 0;
const deps: MidiTracksDeps = {
  render: async (notes, _bpm, _total, opts) => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    const r: { program?: number; percussion?: boolean; started: number; ended?: number; notes: number } = { program: opts.program, percussion: opts.percussion, started: renders.length, notes: notes.length };
    renders.push(r);
    await new Promise((res) => setTimeout(res, 2));
    running -= 1;
    return { blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), duration: 300 };
  },
  computePeaks: () => Promise.resolve({ peaks: new Float32Array(8) }),
  global: () => ({ useSoundfont: true, activeProgram: 5 }),
};
const undoBefore = ed()._undo.length;
// A fresh arrangement holds its empty default tracks; the parts land after them.
const tracksBefore = ed().tracks.length;
const added = () => ed().tracks.slice(tracksBefore);
const landed = importMidiAsTracks(data, { label: 'op132', atSec: 2.5 }, deps);
assert.ok(landed, 'the file lands');
assert.equal(ed()._undo.length, undoBefore + 1, 'every track and clip in one undo step');
assert.deepEqual(added().map((t) => t.name), ['Violin I', 'Violin II', 'Viola', 'Violoncello'], 'a track per part, named after it');
assert.deepEqual(added().map((t) => t.instrumentProgram), [40, 40, 41, 42], "each track holds its part's program");
assert.ok(added().every((t) => !t.nameAutoGenerated && !t.isPercussion));
const clips = landed.parts.map((p) => ed().clips.find((c) => c.id === p.clipId)!);
assert.ok(clips.every((c) => c.startSec === 2.5 && c.sourceKind === 'piano-roll' && c.label === 'op132'), 'one piano-roll clip each at 2.5 s');
assert.equal(new Set(clips.map((c) => c.sourceRollPart?.doc)).size, 1, 'all four clips name one roll document');
assert.deepEqual(clips.map((c) => c.sourceRollPart?.order), [0, 1, 2, 3]);
assert.deepEqual(clips.map((c) => c.sourcePianoRoll?.length), noteCounts, 'each clip holds its part');
assert.deepEqual(clips.map((c) => c.sourceTempoMap?.map((e) => [e.beat, e.bpm])), Array(4).fill([[0, 120], [251.5, 60]]), 'with the tempo map');
assert.ok(clips.every((c) => c.sourceTotalSteps === clips[0].sourceTotalSteps), 'every clip as long as the longest part, bar for bar');
// The notes on the clip are the file's ticks, doubled.
clips.forEach((c, k) => {
  const src = data.tracks.filter((t) => t.notes.length)[k].notes;
  assert.deepEqual(c.sourcePianoRoll?.map((n) => n.tick).sort((a, b) => (a ?? 0) - (b ?? 0)), src.map((n) => n.tick * 2).sort((a, b) => a - b));
});
// Undo takes the whole import away; redo brings it back.
ed().undo();
assert.equal(ed().tracks.length, tracksBefore, 'one undo removes every track');
assert.equal(ed().clips.length, 0);
ed().redo();
assert.equal(added().length, 4);
// The renders come one part at a time, through each track's voice.
const written = await landed.rendered;
assert.equal(written, 4, 'every part rendered');
assert.equal(maxRunning, 1, 'one render at a time');
assert.deepEqual(renders.map((r) => [r.program, r.percussion]), [[40, false], [40, false], [41, false], [42, false]]);
assert.deepEqual(landed.parts.map((p) => ed().clips.find((c) => c.id === p.clipId)?.renderedProgram), [40, 40, 41, 42], 'each clip records the voice its audio has');

// ── opening one clip opens every part ─────────────────────────────────────────
{
  const second = ed().clips.find((c) => c.id === landed.parts[1].clipId)!;
  roll().loadFromClip(...clipPartsLoad(second, ed().clips, ed().tracks));
  const back = rollTracksOf(roll());
  assert.deepEqual(back.map((t) => t.name), ['Violin I', 'Violin II', 'Viola', 'Violoncello']);
  assert.equal(roll().activeTrackId, landed.parts[1].partId, 'the clicked part is the one being edited');
  assert.deepEqual(back.map((t) => t.notes.length), noteCounts);
  assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm]), [[0, 120], [251.5, 60]]);
  assert.deepEqual(roll().meterMap.map((s) => s.bar), [0, 12, 65, 96]);
}

// ── the EDIT arrangement back out as one MIDI file ───────────────────────────
{
  const st = ed();
  assert.equal(st.bpm, 120);
  const out = arrangementToMidiFile(st, { global: { useSoundfont: true, activeProgram: 5 } });
  assert.deepEqual(out.file.tracks.map((t) => t.name), ['Violin I', 'Violin II', 'Viola', 'Violoncello'], 'a MIDI track per EDIT track');
  assert.equal(out.file.ppq, 960, "at the roll's own resolution");
  assert.deepEqual(out.file.tracks.map((t) => t.programs?.[0]?.program), [40, 40, 41, 42]);
  // The violins came in sharing channel 1; each EDIT track has its own fader and pan, so the second violin takes a free channel.
  assert.deepEqual(out.file.tracks.map((t) => t.notes[0].channel), [0, 3, 1, 2], 'the channels the parts came in on, the second violin on the next free one');
  assert.deepEqual(out.sharedTracks, [], 'no two tracks share a channel while one is free');
  assert.equal(out.noteCount, noteCounts.reduce((a, b) => a + b, 0), 'every note');
  // Each note at the second EDIT plays it: the clip's offset plus its own clock (120, then 60 from beat 251.5).
  const arrangement = [{ beat: 0, bpm: 120 }];
  let worst = 0;
  out.file.tracks.forEach((t, k) => {
    const clip = ed().clips.find((c) => c.id === landed.parts[k].clipId)!;
    const clk = stepClock(clip.sourceBpm ?? 120, clip.sourceTempoMap);
    const want = (clip.sourcePianoRoll ?? []).map((n) => clip.startSec + clipNoteSpan(n, clk, 0).relStart).sort((a, b) => a - b);
    const got = t.notes.map((n) => beatToTime(arrangement, n.tick / 960)).sort((a, b) => a - b);
    assert.equal(got.length, want.length);
    for (let i = 0; i < got.length; i += 1) worst = Math.max(worst, Math.abs(got[i] - want[i]));
  });
  assert.ok(worst <= 0.5 / 960 / 2 + 1e-9, `every note within half a tick of its second (worst ${(worst * 1000).toFixed(3)} ms)`);
  // Round trip through the bytes.
  const back = parseMidi(encodeMidi(out.file));
  assert.deepEqual(back.tracks.map((t) => t.notes.length), noteCounts);
  // EDIT holds one time signature, which the import set to the file's first (4/4); the clips keep all four,
  // and the export writes them once the arrangement holds a meter map.
  assert.deepEqual(back.timeSignatures?.map((s) => [s.tick, s.num, s.den]), [[0, 4, 4]], "the arrangement's one time signature");
  // A span: the file starts on the bar line at or before it (EDIT is 4/4 at 120: a bar every 2 s).
  const span = arrangementToMidiFile(st, { range: { startSec: 11, endSec: 21 } });
  assert.equal(span.startSec, 10, 'the bar line before 11 s');
  const first = Math.min(...span.file.tracks.flatMap((t) => t.notes.map((n) => n.tick)));
  assert.ok(first >= timeToBeat(arrangement, 1) * 960 - 1, 'nothing before the span');
  const last = Math.max(...span.file.tracks.flatMap((t) => t.notes.map((n) => n.tick + n.durationTicks)));
  assert.ok(last <= timeToBeat(arrangement, 11) * 960 + 1, 'notes cut at its end');
}

console.log('quartetImport: ok');
