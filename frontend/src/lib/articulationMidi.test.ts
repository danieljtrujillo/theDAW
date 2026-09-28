/**
 * Articulations through MIDI files (stage 4.5 follow-up): the roll's .mid
 * export and EDIT's arrangement export write a preset articulation on the
 * channel and program the live players give it, and every articulation rides
 * in the track's `theDAW:art=` text, so an import gets it back.
 *
 * The sequence: a violin line, four arco then four pizzicato. Exported, the
 * pizzicato notes sit on a channel of their own whose program is GM 46
 * (Pizzicato Strings, program 45) and the arco notes on the violin's; read
 * back, the roll has the same eight notes in one part and one lane, the last
 * four marked pizzicato. A roll of two parts and an EDIT arrangement do the
 * same, and a staccato (no preset of its own) stays on the part's channel and
 * still comes back.
 *
 *   cd frontend && npx tsx src/lib/articulationMidi.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData } from './midi.ts';
import { midiFileToRoll, midiFileToRollParts, rollToMidiFile } from './rollMidi.ts';
import { arrangementToMidiFile } from './arrangementMidi.ts';
import { makeRollTrack } from './rollTracks.ts';
import { normalizeMeterMap, type PolyLane } from './meterMap.ts';
import { DEFAULT_LANES, migrateNotes, type PianoNote } from '../state/pianoRollStore.ts';
import type { AudioClip, EditorTrack } from '../state/editorStore.ts';

const line = (): PianoNote[] =>
  migrateNotes(
    Array.from({ length: 8 }, (_, i) => ({
      id: `v${i}`,
      note: 67 + (i % 4),
      step: i * 4,
      length: 4,
      velocity: 90,
      ...(i >= 4 ? { articulation: 'pizzicato' as const } : i === 1 ? { articulation: 'staccato' as const } : {}),
    })),
  );
const base = { notes: [] as PianoNote[], lanes: [...DEFAULT_LANES] as PolyLane[], totalSteps: 32, bpm: 120, meterMap: normalizeMeterMap([]), pickupSteps: 0, bends: [] };

/** The program a file's channel plays at tick 0. */
const programOn = (file: MidiFileData, channel: number): number | undefined =>
  file.tracks.flatMap((t) => t.programs ?? []).find((p) => p.channel === channel && p.tick === 0)?.program;

// ── The roll's .mid export, one part ────────────────────────────────────────
{
  const violin = makeRollTrack({ id: 'vn', name: 'Violin', program: 40, instrumentId: 'violin', notes: line() }, 0);
  const file = rollToMidiFile({ ...base, tracks: [violin] });
  const notes = file.tracks.flatMap((t) => t.notes);
  const arco = notes.filter((n) => n.articulation !== 'pizzicato');
  const pizz = notes.filter((n) => n.articulation === 'pizzicato');
  assert.equal(pizz.length, 4);
  assert.equal(new Set(pizz.map((n) => n.channel)).size, 1, 'the pizzicato on one channel');
  assert.notEqual(pizz[0].channel, arco[0].channel, 'of its own');
  assert.equal(programOn(file, pizz[0].channel), 45, 'which plays GM 46 Pizzicato Strings');
  assert.equal(programOn(file, arco[0].channel), 40, 'while the arco plays the violin');
  assert.ok(arco.every((n) => n.channel === arco[0].channel), 'a staccato has no preset: it stays on the violin');
  const bytes = encodeMidi(file);
  const hasBytes = (seq: number[]) => bytes.some((_, i) => seq.every((b, j) => bytes[i + j] === b));
  assert.ok(hasBytes([0xc0 | pizz[0].channel, 45]), 'the file carries the program change a player reads');

  // Read back: one part, one lane, the articulations where they were.
  const back = parseMidi(bytes);
  assert.ok(back.tracks[0].notes.every((n) => n.channel === arco[0].channel), 'a parse puts each note back on its part’s channel');
  const roll = midiFileToRoll(back);
  assert.equal(roll.meter.lanes.length, 1, 'no lane for the pizzicato channel');
  assert.deepEqual(
    roll.notes.map((n) => n.articulation ?? null),
    [null, 'staccato', null, null, 'pizzicato', 'pizzicato', 'pizzicato', 'pizzicato'],
    'every articulation comes back',
  );
  const parts = midiFileToRollParts(back);
  assert.equal(parts.parts.length, 1, 'one part');
  assert.equal(parts.parts[0].track.program, 40);
}

// ── Two parts ───────────────────────────────────────────────────────────────
{
  const violin = makeRollTrack({ id: 'vn', name: 'Violin', program: 40, instrumentId: 'violin', notes: line() }, 0);
  const cello = makeRollTrack({ id: 'vc', name: 'Cello', program: 42, instrumentId: 'cello', notes: migrateNotes([{ id: 'c0', note: 48, step: 0, length: 16, velocity: 80, articulation: 'tremolo' }]) }, 1);
  const file = rollToMidiFile({ ...base, tracks: [violin, cello] });
  const celloNotes = file.tracks.find((t) => t.name === 'Cello')?.notes ?? [];
  assert.equal(programOn(file, celloNotes[0].channel), 44, 'the cello’s tremolo plays GM 45 Tremolo Strings');
  const channels = new Set(file.tracks.flatMap((t) => t.notes.map((n) => n.channel)));
  assert.equal(channels.size, 3, 'notes on the violin, its pizzicato and the cello’s tremolo');
  assert.ok(file.tracks.flatMap((t) => t.programs ?? []).some((p) => p.program === 42), 'the cello’s own channel keeps its program');
  const parts = midiFileToRollParts(parseMidi(encodeMidi(file)));
  assert.deepEqual(parts.parts.map((p) => p.track.name), ['Violin', 'Cello'], 'still two parts');
  assert.equal(parts.parts[1].notes[0].articulation, 'tremolo');
  assert.equal(parts.parts[0].notes.filter((n) => n.articulation === 'pizzicato').length, 4);
}

// ── EDIT's arrangement export ───────────────────────────────────────────────
{
  const track = { id: 'strings', name: 'Violins', color: '#fff', volume: 0.8, pan: 0, mute: false, solo: false, fxChain: [], instrumentProgram: 40 } as unknown as EditorTrack;
  const clip = {
    id: 'c',
    trackId: 'strings',
    label: 'Violin',
    mimeType: 'audio/wav',
    sourceDuration: 4,
    offsetIntoSource: 0,
    durationSec: 4,
    startSec: 0,
    color: '#fff',
    sourceKind: 'piano-roll',
    sourcePianoRoll: line(),
    sourceBpm: 120,
    sourceTotalSteps: 32,
    sourceRollPart: { doc: 'd', id: 'vn', order: 0, name: 'Violin', program: 40, bank: 0, channel: null, color: '#fff', mute: false, solo: false, instrumentId: 'violin', controls: [{ tick: 0, controller: 11, value: 90 }] },
  } as unknown as AudioClip;
  const out = arrangementToMidiFile({ tracks: [track], clips: [clip], bpm: 120 });
  const t = out.file.tracks[0];
  const pizz = t.notes.filter((n) => n.articulation === 'pizzicato');
  const arco = t.notes.filter((n) => n.articulation !== 'pizzicato');
  assert.notEqual(pizz[0].channel, arco[0].channel);
  assert.equal(programOn(out.file, pizz[0].channel), 45, 'the arrangement plays the pizzicato on GM 46');
  assert.equal(programOn(out.file, arco[0].channel), 40);
  assert.ok((t.controls ?? []).some((c) => c.channel === pizz[0].channel && c.controller === 11), 'the part’s expression reaches the pizzicato channel');
  const back = parseMidi(encodeMidi(out.file));
  assert.deepEqual(back.tracks[0].notes.map((n) => n.articulation ?? null), [null, 'staccato', null, null, 'pizzicato', 'pizzicato', 'pizzicato', 'pizzicato']);
  assert.ok(back.tracks[0].notes.every((n) => n.channel === arco[0].channel), 'read back on the track’s own channel');
}

console.log('articulationMidi: ok');
