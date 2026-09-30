/**
 * ORCHESTRATE's two pure halves: the request the panel builds from the roll
 * (orchestrateRequest + orchestrateBody: snake_case keys, the sketch's
 * velocities and articulations kept, the density as 0-1, the pickers only
 * when they name a part that has notes), and the answer as part writes
 * (orchestrationPartWrites: one write per instrument in the answer's order,
 * on its registry instrument, with its CC 1 swells, its notes' articulations
 * and the chords for the harmony row).
 *
 * Run: `npx tsx src/lib/rollComposer.orchestrate.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { orchestrateBody, type OrchestrateResult } from './composerClient';
import { DEFAULT_ORCHESTRATE, orchestrateRequest } from './composerPanelModel';
import { orchestrationPartWrites } from './rollComposer';

// ── the request ─────────────────────────────────────────────────────────────
const parts = [
  { id: 'p1', name: 'Melody', program: 0, notes: [{ note: 72, tick: 0, ticks: 960, velocity: 96, articulation: 'legato' }] },
  { id: 'p2', name: 'Bass', instrumentId: 'cello', program: 42, notes: [{ note: 48, step: 0, length: 8, velocity: 70 }] },
  { id: 'p3', name: 'Spare', program: null, notes: [] },
];
const ctx = {
  key: 'G',
  mode: 'major' as const,
  meterMap: [{ bar: 0, meter: { num: 3, den: 4, groups: [] } }],
  pickupSteps: 0,
  harmony: [
    { tick: 0, figure: 'I', key: 'G major' },
    { tick: 2880, figure: '' },
  ],
  markers: [{ tick: 0, name: 'A' }],
};

const req = orchestrateRequest({ ...DEFAULT_ORCHESTRATE, ensemble: 'chamber', texture: 'chorale', density: 70, melody: 'p1', bass: 'p3' }, parts, ctx);
assert.deepEqual(
  req.parts.map((p) => p.id),
  ['p1', 'p2'],
  'a part with no notes is left out of the sketch',
);
assert.equal(req.melody, 'p1');
assert.equal(req.bass, undefined, 'a picker naming an empty part falls back to the backend default');
assert.equal(req.density, 0.7);
assert.deepEqual(req.harmony, [{ tick: 0, figure: 'I', key: 'G major' }], 'a blank figure is not a chord');

const body = orchestrateBody(req);
assert.deepEqual(body, {
  parts: [
    { id: 'p1', name: 'Melody', program: 0, notes: [{ note: 72, tick: 0, ticks: 960, velocity: 96, articulation: 'legato' }] },
    { id: 'p2', name: 'Bass', instrument_id: 'cello', program: 42, notes: [{ note: 48, tick: 0, ticks: 1920, velocity: 70 }] },
  ],
  harmony: [{ tick: 0, figure: 'I', key: 'G major' }],
  markers: [{ tick: 0, name: 'A' }],
  key: 'G',
  mode: 'major',
  meter_map: [{ bar: 0, meter: { num: 3, den: 4, groups: [] } }],
  pickup_steps: 0,
  ensemble: 'chamber',
  texture: 'chorale',
  density: 0.7,
  melody: 'p1',
});

assert.throws(() => orchestrateRequest(DEFAULT_ORCHESTRATE, [parts[2]], ctx), /no notes/);

// ── the answer as part writes ───────────────────────────────────────────────
const result: OrchestrateResult = {
  key: 'G major',
  ppq: 960,
  ensemble: 'strings',
  texture: 'tutti',
  density: 0.5,
  melody_part: 'p1',
  bass_part: 'p2',
  parts: [
    {
      name: 'Violin I',
      instrument_id: 'violin',
      role: 'lead',
      notes: [{ note: 72, tick: 0, ticks: 960, velocity: 96, articulation: 'legato' }],
      controls: [
        { tick: 0, controller: 1, value: 60 },
        { tick: 1920, controller: 1, value: 110 },
      ],
    },
    {
      name: 'Contrabass',
      instrument_id: 'contrabass',
      role: 'bass8vb',
      notes: [{ note: 36, tick: 0, ticks: 1920, velocity: 70, articulation: 'pizzicato' }, { note: 43, tick: 1920, ticks: 960, velocity: 70, articulation: 'not-one' }],
      controls: [],
    },
  ],
  sections: [{ name: 'A', tick: 0, ticks: 2880, dynamic: 'f', velocity: 96, climax: true, lead: 'strings', plan: 'A, bars 1-1, f (climax): Violin I carries the melody.' }],
  plan: ['A, bars 1-1, f (climax): Violin I carries the melody.'],
  chords: [
    { tick: 0, ticks: 2880, figure: 'I', key: 'G major' },
    { tick: 2880, ticks: 2880, figure: '', key: 'G major' },
  ],
};

const w = orchestrationPartWrites(result);
assert.deepEqual(
  w.writes.map((x) => [x.voice, x.name, x.instrumentId]),
  [
    ['Violin I', 'Violin I', 'violin'],
    ['Contrabass', 'Contrabass', 'contrabass'],
  ],
  'one write per part, named as the answer names it, on its registry instrument',
);
const lead = w.writes[0];
assert.equal(lead.notes.length, 1);
assert.equal(lead.notes[0].note, 72);
assert.equal(lead.notes[0].velocity, 96, 'the section dynamic is the note velocity');
assert.equal(lead.notes[0].articulation, 'legato');
assert.equal(lead.notes[0].step, 0);
assert.equal(lead.notes[0].length, 4, '960 ticks is four sixteenths');
assert.deepEqual(lead.controls, [
  { tick: 0, controller: 1, value: 60 },
  { tick: 1920, controller: 1, value: 110 },
]);
const basses = w.writes[1];
assert.equal(basses.notes[0].articulation, 'pizzicato');
assert.equal('articulation' in basses.notes[1], false, 'an articulation the roll does not know is dropped');
assert.deepEqual(basses.controls, []);
assert.deepEqual(w.chords, [{ tick: 0, figure: 'I', key: 'G major' }], 'only chords with a figure reach the harmony row');
assert.deepEqual(w.flags, []);
assert.deepEqual(w.key, { tonic: 'G', mode: 'major' });

console.log('rollComposer.orchestrate.test: ok');
