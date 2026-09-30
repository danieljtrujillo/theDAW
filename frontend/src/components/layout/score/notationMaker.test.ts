// Run with: npx tsx src/components/layout/score/notationMaker.test.ts
import assert from 'node:assert/strict';
import {
  defaultStaffInstrument,
  legacyMidiId,
  MAKER_INSTRUMENTS,
  needsMidi,
  pickSource,
  planFor,
  staffInstrumentsFor,
  staffInstrumentValue,
  stemOf,
  tuningsFor,
  wayAfterInstrumentChange,
  WAYS_FOR,
  type MakerChoice,
} from './notationMakerModel.ts';
import type { NotationArtifact } from '../../../lib/notationClient.ts';

const ENTRY = '00a6ece6971240ea86eb592de54d3986';

/** The rows a song with Convert to MIDI run on every stem really carries. */
const midi = (stem: string): NotationArtifact => ({
  id: stem === 'full' ? `${ENTRY}__full__artifact_midi` : `${ENTRY}__${stem}`,
  entry_id: ENTRY,
  kind: 'midi',
  source_ref: stem === 'full' ? 'full' : `${ENTRY}__${stem}`,
  path: `data/generations/${ENTRY}/midi/${stem}.mid`,
  metadata_json: JSON.stringify({
    legacy_midi_id: stem === 'full' ? `${ENTRY}__full` : `${ENTRY}__${stem}_midi`,
    notes_count: 10,
  }),
} as NotationArtifact);

const MIDIS = ['full', 'bass', 'drums', 'guitar', 'other', 'piano', 'vocals'].map(midi);
const TUNINGS = ['bass-5-string', 'bass-standard', 'guitar-7-string', 'guitar-drop-d', 'guitar-standard', 'ukulele-standard'];

const choice = (patch: Partial<MakerChoice>): MakerChoice => ({
  instrument: 'guitar',
  way: 'tab',
  source: pickSource(patch.instrument ?? 'guitar', MIDIS),
  midis: MIDIS,
  tuning: 'guitar-standard',
  capo: 0,
  difficulty: 'medium',
  ...patch,
});

// ── stems ────────────────────────────────────────────────────────────────────
assert.deepEqual(MIDIS.map(stemOf), ['full', 'bass', 'drums', 'guitar', 'other', 'piano', 'vocals']);
assert.equal(legacyMidiId(MIDIS[1]), `${ENTRY}__bass_midi`);
assert.equal(legacyMidiId({ ...MIDIS[1], metadata_json: 'null' }), `${ENTRY}__bass`, 'a null metadata row falls back to the ref');

// ── each instrument reads its own stem ───────────────────────────────────────
assert.equal(stemOf(pickSource('bass', MIDIS)!), 'bass');
assert.equal(stemOf(pickSource('voice', MIDIS)!), 'vocals');
assert.equal(stemOf(pickSource('ukulele', MIDIS)!), 'guitar');
assert.equal(stemOf(pickSource('drums', MIDIS)!), 'drums');
assert.equal(stemOf(pickSource('piano', [midi('full'), midi('bass')])!), 'full', 'no piano stem: the full mix');
assert.equal(pickSource('piano', []), null);

// ── tunings follow the instrument ────────────────────────────────────────────
assert.deepEqual(tuningsFor('bass', TUNINGS), ['bass-5-string', 'bass-standard']);
assert.deepEqual(tuningsFor('ukulele', TUNINGS), ['ukulele-standard']);
assert.deepEqual(tuningsFor('piano', TUNINGS), []);

// ── every instrument has a way, and switching keeps a shared way ─────────────
for (const inst of MAKER_INSTRUMENTS) assert.ok(WAYS_FOR[inst].length > 0, inst);
assert.equal(wayAfterInstrumentChange('ukulele', 'tab'), 'tab');
assert.equal(wayAfterInstrumentChange('drums', 'tab'), 'exact');
assert.equal(wayAfterInstrumentChange('band', 'chords'), 'score');
assert.equal(needsMidi('chords'), false);
assert.equal(needsMidi('tab'), true);

// ── the request each choice becomes ──────────────────────────────────────────
assert.deepEqual(planFor(choice({ instrument: 'bass', tuning: 'bass-5-string', capo: 2, difficulty: 'easy' })), {
  route: 'tabs',
  req: {
    source_artifact_id: `${ENTRY}__bass`,
    instrument: 'bass',
    tuning_name: 'bass-5-string',
    capo: 2,
    difficulty: 'easy',
  },
});
assert.deepEqual(planFor(choice({ instrument: 'piano', way: 'grand' })), {
  route: 'arrange',
  req: { style: 'piano-reduction', source_artifact_id: `${ENTRY}__piano` },
});
assert.deepEqual(planFor(choice({ instrument: 'voice', way: 'lead' })), {
  route: 'arrange',
  req: { style: 'lead-sheet', source_artifact_id: `${ENTRY}__vocals` },
});
assert.deepEqual(planFor(choice({ instrument: 'voice', way: 'melody' })), {
  route: 'arrange',
  req: { style: 'simplified', source_artifact_id: `${ENTRY}__vocals` },
});
assert.deepEqual(planFor(choice({ instrument: 'drums', way: 'exact' })), {
  route: 'from-midi',
  midiId: `${ENTRY}__drums_midi`,
});
const band = planFor(choice({ instrument: 'band', way: 'score', source: null }));
assert.ok('route' in band && band.route === 'arrange');
assert.equal(band.req.style, 'band-score');
assert.equal(band.req.source_artifact_ids?.length, MIDIS.length, 'a band score reads every stem');

// ── a band score writes each stem for an instrument from the registry ────────
assert.deepEqual(
  MIDIS.map(defaultStaffInstrument),
  ['', 'electric-bass', 'drum-kit', 'electric-guitar', '', 'piano', 'voice'],
  'each stem starts on its own instrument; the full mix and "other" keep their names',
);
assert.equal(defaultStaffInstrument(midi('Flute 1')), 'flute', 'a stem named for an instrument is that instrument');
assert.deepEqual(band.req.instruments, {
  [`${ENTRY}__bass`]: 'electric-bass',
  [`${ENTRY}__drums`]: 'drum-kit',
  [`${ENTRY}__guitar`]: 'electric-guitar',
  [`${ENTRY}__piano`]: 'piano',
  [`${ENTRY}__vocals`]: 'voice',
});
const picked = planFor(choice({
  instrument: 'band',
  way: 'score',
  source: null,
  staffInstruments: { [`${ENTRY}__other`]: 'cello', [`${ENTRY}__vocals`]: '', [`${ENTRY}__piano`]: 'no-such-instrument' },
}));
assert.ok('route' in picked && picked.route === 'arrange');
assert.deepEqual(picked.req.instruments, {
  [`${ENTRY}__bass`]: 'electric-bass',
  [`${ENTRY}__drums`]: 'drum-kit',
  [`${ENTRY}__guitar`]: 'electric-guitar',
  [`${ENTRY}__other`]: 'cello',
}, 'a pick replaces the default, "" keeps the stem name, an unknown id is never sent');
assert.equal(staffInstrumentValue(MIDIS[6], { [`${ENTRY}__vocals`]: '' }), '');
assert.equal(staffInstrumentValue(MIDIS[6], {}), 'voice');
const plain = planFor(choice({
  instrument: 'band',
  way: 'score',
  source: null,
  midis: [midi('full'), midi('other')],
}));
assert.ok('route' in plain && plain.route === 'arrange');
assert.equal('instruments' in plain.req, false, 'no instrument picked: the request is the one older builds sent');
assert.deepEqual(staffInstrumentsFor([midi('bass')], {}), { [`${ENTRY}__bass`]: 'electric-bass' });

// ── chords need no MIDI; everything else says why it cannot run ──────────────
assert.deepEqual(planFor(choice({ instrument: 'guitar', way: 'chords', midis: [], source: null })), { route: 'chords' });
const noMidi = planFor(choice({ midis: [], source: null }));
assert.ok('error' in noMidi && /Convert to MIDI/.test(noMidi.error));
const wrongWay = planFor(choice({ instrument: 'drums', way: 'tab' }));
assert.ok('error' in wrongWay, 'drums cannot be written as tab');

console.log('notationMaker tests passed');
