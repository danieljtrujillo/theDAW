import assert from 'node:assert/strict';

import {
  allowedModes,
  defaultPartVisibility,
  modeForInstrument,
  partsForInstrument,
  PLAY_ALONG_MODES,
  USER_OFFSET_MAX_MS,
  USER_OFFSET_MIN_MS,
  usePlayAlongStore,
} from './playAlongStore.ts';

// Runs under plain node (no DOM, no localStorage): the store must construct
// with its defaults and never throw on persistence.

// allowedModes per artifact kind.
assert.deepEqual(allowedModes('musicxml'), ['page', 'strip', 'chords', 'highway']);
assert.deepEqual(allowedModes('alphatex'), ['page', 'strip', 'chords']);
assert.deepEqual(allowedModes('notechart'), ['highway']);
assert.deepEqual(allowedModes('chordtrack'), ['chords']);
for (const kind of ['midi', 'abc', 'pdf', 'svg', 'vocal', 'other', 'beatsaber']) {
  assert.deepEqual(allowedModes(kind), ['chords'], `allowedModes(${kind})`);
}
for (const kind of ['musicxml', 'alphatex', 'notechart', 'chordtrack', 'midi']) {
  for (const m of allowedModes(kind)) assert.ok(PLAY_ALONG_MODES.includes(m));
}

// Default part visibility: everything on, except 'full' when stems exist.
const band = [
  { name: 'full' },
  { name: 'drums', isPercussion: true },
  { name: 'bass' },
  { name: 'vocals' },
  { name: 'other' },
  { name: 'guitar' },
  { name: 'piano' },
];
assert.deepEqual(defaultPartVisibility(band), [false, true, true, true, true, true, true]);
assert.deepEqual(defaultPartVisibility([{ name: 'full' }]), [true], 'a lone full part stays visible');
assert.deepEqual(defaultPartVisibility([{ name: 'Piano' }, { name: 'Bass' }]), [true, true]);
assert.deepEqual(defaultPartVisibility([{ name: 'song__full' }, { name: 'song__bass' }]), [false, true]);
assert.deepEqual(defaultPartVisibility([]), []);

// Instrument presets pick parts by name / percussion flag.
assert.deepEqual(partsForInstrument('all', band), defaultPartVisibility(band));
assert.deepEqual(partsForInstrument('drums', band), [false, true, false, false, false, false, false]);
assert.deepEqual(partsForInstrument('bass', band), [false, false, true, false, false, false, false]);
assert.deepEqual(partsForInstrument('guitar', band), [false, false, false, false, false, true, false]);
assert.deepEqual(partsForInstrument('vocals', band), [false, false, false, true, false, false, false]);
assert.deepEqual(partsForInstrument('keys', band), [false, false, false, false, true, false, true]);
assert.deepEqual(
  partsForInstrument('drums', [{ name: 'Drum Kit' }, { name: 'Piano' }]),
  [true, false],
  'drums also match by name when no percussion flag is present',
);
assert.deepEqual(
  partsForInstrument('strings', [{ name: 'Violin I' }, { name: 'Cello' }, { name: 'Piano' }]),
  [true, true, false],
);
assert.deepEqual(
  partsForInstrument('strings', band),
  defaultPartVisibility(band),
  'a preset that matches nothing falls back to the default rather than an empty score',
);

// Preset -> mode, constrained by what the artifact kind allows.
assert.deepEqual(modeForInstrument('drums', 'musicxml'), { mode: 'highway', skin: 'drums' });
assert.deepEqual(modeForInstrument('guitar', 'musicxml'), { mode: 'chords' });
assert.deepEqual(modeForInstrument('guitar', 'alphatex'), { mode: 'strip' });
assert.deepEqual(modeForInstrument('bass', 'chordtrack'), { mode: 'chords' });
assert.deepEqual(modeForInstrument('keys', 'musicxml'), { mode: 'strip' });
assert.deepEqual(modeForInstrument('vocals', 'notechart'), { mode: 'highway' }, 'falls back to the only allowed mode');
assert.deepEqual(modeForInstrument('drums', 'chordtrack'), { mode: 'chords', skin: 'drums' });
assert.deepEqual(modeForInstrument('all', 'musicxml'), { mode: 'page' });

// Store defaults and clamping.
const s0 = usePlayAlongStore.getState();
assert.equal(s0.mode, 'page');
assert.equal(s0.userOffsetMs, 0);
assert.equal(s0.approachSpeed, 8);
assert.equal(s0.leadInSec, 2.5);
assert.equal(s0.skin, 'notation');
assert.equal(s0.difficulty, 1);
assert.equal(s0.chordInstrument, 'guitar');
assert.equal(s0.chordTuning, 'guitar-standard');
assert.equal(s0.capo, 0);
assert.equal(s0.judgeEnabled, false);
assert.equal(s0.instrument, 'all');
assert.deepEqual(s0.partVisibility, {});

s0.setUserOffsetMs(999);
assert.equal(usePlayAlongStore.getState().userOffsetMs, USER_OFFSET_MAX_MS);
s0.setUserOffsetMs(-999);
assert.equal(usePlayAlongStore.getState().userOffsetMs, USER_OFFSET_MIN_MS);
s0.setUserOffsetMs(12.4);
assert.equal(usePlayAlongStore.getState().userOffsetMs, 12, 'offsets are whole milliseconds');
s0.setUserOffsetMs(Number.NaN);
assert.equal(usePlayAlongStore.getState().userOffsetMs, 0);
s0.setDifficulty(4);
assert.equal(usePlayAlongStore.getState().difficulty, 4);
s0.setCapo(40);
assert.equal(usePlayAlongStore.getState().capo, 12);
s0.setMode('highway');
assert.equal(usePlayAlongStore.getState().mode, 'highway');
s0.setInstrument('drums');
assert.equal(usePlayAlongStore.getState().instrument, 'drums');

// Part visibility is per artifact and toggles in place.
s0.setPartVisibility('art-1', [true, false, true]);
assert.deepEqual(usePlayAlongStore.getState().partVisibility['art-1'], [true, false, true]);
s0.togglePart('art-1', 1);
assert.deepEqual(usePlayAlongStore.getState().partVisibility['art-1'], [true, true, true]);
s0.togglePart('art-1', 7);
assert.deepEqual(usePlayAlongStore.getState().partVisibility['art-1'], [true, true, true], 'out-of-range index is a no-op');
s0.togglePart('unknown', 0);
assert.equal(usePlayAlongStore.getState().partVisibility['unknown'], undefined);
s0.setPartVisibility('art-2', [false]);
assert.deepEqual(usePlayAlongStore.getState().partVisibility['art-1'], [true, true, true], 'other artifacts untouched');

console.log('playAlongStore regression passed');
