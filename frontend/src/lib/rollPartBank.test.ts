/**
 * A part's bank select LSB (CC 32): kept from a MIDI file, written back out,
 * set in the roll with its undo, carried by the part's EDIT clip and its
 * .tasmo record, and written by the arrangement's MIDI export.
 *
 * Before: lib/midi read CC 32 with each program change, but a roll part kept
 * the bank MSB alone, so Import MIDI then Export MIDI dropped CC 32, and an XG
 * file whose parts pick variations by it came back with every part on its
 * base voice.
 *
 *   cd frontend && npx tsx src/lib/rollPartBank.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, type MidiFileData } from './midi.ts';
import { midiFileToRollParts, parsePartMeta, partMetaText, rollToMidiFile } from './rollMidi.ts';
import { applyRollParts } from './rollPartsImport.ts';
import { cleanRollPartRef, clipPartsLoad, rollPartRef } from './rollClip.ts';
import { rollPartToTasmo, tasmoRollPart } from './projectClient.ts';
import { arrangementToMidiFile } from './arrangementMidi.ts';
import { importMidiAsTracks } from './midiImportTracks.ts';
import { cleanPartBankLsb, makeRollTrack } from './rollTracks.ts';
import { normalizeMeterMap, type PolyLane } from './meterMap.ts';
import type { LaneBend } from './pitchBend.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { DEFAULT_LANES, endRollGesture, rollTracksOf, usePianoRollStore } from '../state/pianoRollStore.ts';

const roll = () => usePianoRollStore.getState();
const ed = () => useEditorStore.getState();
const cut = () => endRollGesture();

// An XG-style file: strings on bank 0 with variation LSB 3, a choir with no LSB, and drums whose CC 32 a kit ignores.
const file: MidiFileData = {
  ppq: 480,
  bpm: 100,
  tracks: [
    {
      name: 'Strings',
      programs: [{ tick: 0, channel: 0, program: 48, bank: 0, bankLsb: 3 }],
      notes: [{ tick: 0, durationTicks: 480, note: 60, velocity: 90, channel: 0 }],
    },
    {
      name: 'Choir',
      programs: [{ tick: 0, channel: 1, program: 52 }],
      notes: [{ tick: 0, durationTicks: 480, note: 67, velocity: 90, channel: 1 }],
    },
    {
      name: 'Drums',
      programs: [{ tick: 0, channel: 9, program: 16, bankLsb: 1 }],
      notes: [{ tick: 0, durationTicks: 120, note: 36, velocity: 100, channel: 9 }],
    },
  ],
};
const parsed = parseMidi(encodeMidi(file));
assert.deepEqual(parsed.tracks[0].programs?.map((p) => [p.program, p.bank, p.bankLsb]), [[48, 0, 3]], 'the file carries CC 0, CC 32 and the program');

// ── the import keeps it on the part ─────────────────────────────────────────
const parts = midiFileToRollParts(parsed, 'x').parts;
assert.deepEqual(parts.map((p) => p.track.bankLsb), [3, undefined, undefined], 'the strings keep LSB 3; the choir sends none; a kit takes none');
assert.equal('bankLsb' in parts[1].track, false, 'no field at all on a part without one');
assert.equal(cleanPartBankLsb(200), 127);
assert.equal(cleanPartBankLsb('x'), undefined);
assert.equal(makeRollTrack({ bankLsb: 5 }, 0).bankLsb, 5);
assert.equal('bankLsb' in makeRollTrack({}, 0), false, 'a part made before LSB existed has none');

// ── in the roll: the parts column's setter, undo, and an instrument choice ───
{
  applyRollParts(parts, 100, { meterMap: normalizeMeterMap([]), pickupSteps: 0 }, [], [{ beat: 0, bpm: 100 }]);
  const strings = rollTracksOf(roll())[0];
  assert.equal(strings.bankLsb, 3);
  cut();
  const steps = roll()._undo.length;
  roll().setTrackBankLsb(strings.id, 7);
  assert.equal(rollTracksOf(roll())[0].bankLsb, 7);
  assert.equal(roll()._undo.length, steps + 1, 'one undo step');
  cut();
  roll().setTrackBankLsb(strings.id, 7);
  assert.equal(roll()._undo.length, steps + 1, 'the same value adds no step');
  roll().undo();
  assert.equal(rollTracksOf(roll())[0].bankLsb, 3, 'undo puts the file value back');
  cut();
  roll().setTrackBankLsb(strings.id, null);
  assert.equal('bankLsb' in rollTracksOf(roll())[0], false, 'null sends none');
  roll().undo();
  cut();
  // Choosing a registry instrument sets its program and bank; the file's variation belonged to the old voice.
  roll().setTrackInstrument(strings.id, 'violin');
  assert.equal(rollTracksOf(roll())[0].program, 40);
  assert.equal('bankLsb' in rollTracksOf(roll())[0], false, 'an instrument choice clears it');
  roll().undo();
  assert.equal(rollTracksOf(roll())[0].bankLsb, 3, 'and undo brings it back with the old voice');
  // A program picked by hand keeps the bank fields, as it keeps the MSB.
  cut();
  roll().setTrackProgram(strings.id, 49, false);
  assert.equal(rollTracksOf(roll())[0].bankLsb, 3);
  roll().undo();
}

// ── out of the roll: Export MIDI writes it before the program, and reads it back ─
{
  const s = roll();
  const out = rollToMidiFile({
    notes: s.notes,
    lanes: [...DEFAULT_LANES] as PolyLane[],
    totalSteps: s.totalSteps,
    bpm: s.bpm,
    meterMap: s.meterMap,
    pickupSteps: s.pickupSteps,
    bends: [] as LaneBend[],
    tracks: rollTracksOf(s),
  });
  const back = parseMidi(encodeMidi(out));
  const programs = back.tracks.flatMap((t) => (t.programs ?? []).map((p) => [t.name, p.program, p.bank, p.bankLsb]));
  assert.deepEqual(programs, [['Strings', 48, undefined, 3], ['Choir', 52, undefined, undefined], ['Drums', 16, undefined, undefined]], 'CC 32 on the strings alone');
  // The part text carries it too, so the roll's own file gives it back whole.
  assert.equal(parsePartMeta(partMetaText(rollTracksOf(s)[0]))?.bankLsb, 3);
  assert.deepEqual(midiFileToRollParts(back, 'y').parts.map((p) => p.track.bankLsb), [3, undefined, undefined]);
}

// ── the part's EDIT clip and its .tasmo record ──────────────────────────────
{
  const ref = rollPartRef(rollTracksOf(roll())[0], 0, 'doc');
  assert.equal(ref.bankLsb, 3);
  const saved = JSON.parse(JSON.stringify(rollPartToTasmo(ref)));
  assert.equal(saved.bank_lsb, 3, 'the .tasmo record names it bank_lsb');
  assert.equal(tasmoRollPart(saved, { name: 'x', color: '#000000' })?.bankLsb, 3, 'and reads it back');
  const { bank_lsb: _older, ...older } = saved;
  assert.equal('bankLsb' in (tasmoRollPart(older, { name: 'x', color: '#000000' }) ?? {}), false, 'a file written before it opens without one');
  assert.equal(cleanRollPartRef({ ...saved, bankLsb: 999 }, { name: 'x', color: '#000' })?.bankLsb, 127);
  const noLsb = rollPartToTasmo(rollPartRef(rollTracksOf(roll())[1], 1, 'doc'));
  assert.equal('bank_lsb' in noLsb, false, 'a part without one writes no key');
}

// ── Import as tracks, then the arrangement's MIDI export ────────────────────
{
  ed().loadProject({ tracks: [], clips: [] });
  const landed = importMidiAsTracks(parsed, { label: 'xg', atSec: 0 }, { global: () => ({ useSoundfont: true, activeProgram: 0 }) });
  assert.ok(landed);
  await landed.rendered;
  const stringsClip = ed().clips.find((c) => c.id === landed.parts[0].clipId);
  assert.equal(stringsClip?.sourceRollPart?.bankLsb, 3, "the strings clip's part record keeps it");
  // Opening the clip in the roll gives the part back its LSB.
  roll().loadFromClip(...clipPartsLoad(stringsClip!, ed().clips, ed().tracks));
  assert.equal(rollTracksOf(roll()).find((t) => t.name === 'Strings')?.bankLsb, 3);
  const exported = parseMidi(encodeMidi(arrangementToMidiFile({ bpm: 100, tracks: ed().tracks, clips: ed().clips }).file));
  const byName = new Map(exported.tracks.map((t) => [t.name, t.programs ?? []]));
  assert.deepEqual(byName.get('Strings')?.map((p) => [p.program, p.bankLsb]), [[48, 3]], 'CC 32 before the program in the arrangement file');
  assert.deepEqual(byName.get('Choir')?.map((p) => p.bankLsb), [undefined]);
}

console.log('rollPartBank: ok');
