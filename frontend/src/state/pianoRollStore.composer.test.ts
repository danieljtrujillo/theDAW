/**
 * The composer routes' answers written into the piano roll, and the roll's
 * parts sent to them, through the store's own actions.
 *
 * The sequence: a roll of one part gets a plan (four new parts, one undo
 * step, its key and figures), a second plan replaces those parts' notes, a
 * voice-leading check reads the SATB parts with their registry ranges and the
 * roll's meter, and a flag selects the notes it is about. A part is marked as
 * the cantus firmus and a species answer writes its cantus back into it; a
 * canon and a fugue write their voices by name. A realized form movement sets
 * the meter, tempo and markers with its parts in one step. Figures written
 * under a bass part survive a bounce to EDIT, a .tasmo save and reopening, and
 * a realized figured bass writes the upper three voices. Every transform of
 * the selection goes through undo.
 *
 *   cd frontend && npx tsx src/state/pianoRollStore.composer.test.ts
 */
import assert from 'node:assert/strict';
import {
  ROLL_TRANSFORMS,
  cantusFirmusOf,
  effectiveRollKey,
  rollComposeContext,
  rollTracksOf,
  usePianoRollStore,
  type PianoNote,
  type RollTrack,
} from './pianoRollStore.ts';
import type {
  CanonResult,
  ComposerNote,
  ContinuoResult,
  FormResult,
  FugueResult,
  PlanResult,
  SpeciesResult,
  VoiceLeadingFlag,
} from '../lib/composerClient.ts';
import { cleanRollPartRef, clipPartsLoad, rollPartRef } from '../lib/rollClip.ts';
import { rollPartToTasmo, tasmoRollPart } from '../lib/projectClient.ts';
import { sanitizeRollTracks } from '../lib/rollTracks.ts';

const roll = () => usePianoRollStore.getState();
const parts = () => rollTracksOf(roll());
const byName = (name: string): RollTrack => {
  const t = parts().find((p) => p.name === name);
  assert.ok(t, `a part named ${name}`);
  return t;
};
const pitches = (t: RollTrack) => t.notes.map((n) => n.note);
const ticks = (t: RollTrack) => t.notes.map((n) => [n.tick, n.ticks]);
const cn = (note: number, tick: number, ticks = 960): ComposerNote => ({ note, tick, ticks });
const pn = (id: string, note: number, tick: number, ticks = 960): PianoNote => ({ id, note, tick, ticks, step: tick / 240, length: ticks / 240, velocity: 90 });

// Each write is its own step: the history coalesces writes closer than 300 ms, which a test makes in microseconds.
const realNow = performance.now.bind(performance);
let clock = realNow();
performance.now = () => (clock += 1000);

interface Sent {
  url: string;
  body: Record<string, unknown>;
}
let sent: Sent[] = [];
const realFetch = globalThis.fetch;
function serve(payload: unknown, status = 200): void {
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

function freshRoll(notes: PianoNote[] = []): void {
  roll().importParts([{ name: 'Part 1', notes }], 120, { meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0 });
  usePianoRollStore.setState({ _undo: [], _redo: [] });
}

// ── plan into the roll ──────────────────────────────────────────────────────
const plan = {
  key: 'G major',
  final_key: 'G major',
  bars: 2,
  seed: 1,
  cadence: 'authentic_perfect',
  style: null,
  harmonic_rhythm: 'bar',
  ppq: 960,
  meter_map: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
  chords: [
    { index: 0, bar: 0, beat: 1, tick: 0, ticks: 3840, accent: 1, figure: 'I', key: 'G major', kind: 'triad', pivot: null, pitches: { soprano: 71, alto: 67, tenor: 62, bass: 55 }, names: {} },
    { index: 1, bar: 1, beat: 1, tick: 3840, ticks: 3840, accent: 1, figure: 'V7', key: 'G major', kind: 'seventh', pivot: null, pitches: { soprano: 72, alto: 66, tenor: 62, bass: 50 }, names: {} },
  ],
  parts: {
    soprano: [cn(71, 0, 3840), cn(72, 3840, 3840)],
    alto: [cn(67, 0, 3840), cn(66, 3840, 3840)],
    tenor: [cn(62, 0, 3840), cn(62, 3840, 3840)],
    bass: [cn(55, 0, 3840), cn(50, 3840, 3840)],
  },
  flags: [],
} as unknown as PlanResult;

freshRoll([pn('seed', 60, 0)]);
const beforePlan = parts();
const planned = roll().writePlanToRoll(plan);
assert.equal(planned.created, 4, 'four new parts');
assert.equal(planned.skipped, 0);
assert.deepEqual(parts().map((p) => p.name), ['Part 1', 'Soprano', 'Alto', 'Tenor', 'Bass']);
assert.deepEqual(pitches(byName('Soprano')), [71, 72]);
assert.deepEqual(ticks(byName('Bass')), [[0, 3840], [3840, 3840]], 'each voice at its ticks');
assert.equal(byName('Soprano').instrumentId, 'soprano', "a new SATB part sings in the registry's voice");
assert.equal(byName('Bass').instrumentId, 'bass-voice');
assert.deepEqual(roll().rollKey, { tonic: 'G', mode: 'major' }, "the roll takes the plan's key");
assert.deepEqual(roll().harmonyChords.map((c) => [c.tick, c.figure]), [[0, 'I'], [3840, 'V7']], 'the figures for the harmony row');
assert.equal(roll().voiceLeading?.source, 'plan');
assert.equal(roll().voiceLeading?.ids.soprano, byName('Soprano').id, "the plan's part names map onto the parts");
assert.equal(roll().showHarmony, true, 'the harmony row opens with figures to show');
assert.deepEqual(parts()[0].notes.map((n) => n.id), ['seed'], 'the part being edited keeps its notes');
assert.equal(roll()._undo.length, 1, 'one undo step');
roll().undo();
assert.deepEqual(parts().map((p) => p.name), beforePlan.map((p) => p.name), 'undo takes the four parts away');
assert.equal(roll().rollKey, null, 'and the key');
roll().redo();
assert.equal(parts().length, 5, 'redo brings them back');

// A second plan replaces the notes of the parts it names and makes none.
const again = roll().writePlanToRoll({ ...plan, parts: { ...plan.parts, soprano: [cn(74, 0, 7680)] } } as PlanResult);
assert.equal(again.created, 0);
assert.deepEqual(pitches(byName('Soprano')), [74]);
assert.equal(parts().length, 5);
roll().undo();
assert.deepEqual(pitches(byName('Soprano')), [71, 72], 'undo puts the first plan back');

// ── the compose context: key, meter, SATB ranges ────────────────────────────
{
  const ctx = rollComposeContext(roll());
  assert.deepEqual(ctx.key, { tonic: 'G', mode: 'major' });
  assert.equal(ctx.keySet, true);
  assert.deepEqual(ctx.ranges.soprano, [60, 84], "the Soprano part's range from the registry");
  assert.deepEqual(ctx.meterMap, [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }]);
}

// ── key picker ──────────────────────────────────────────────────────────────
roll().setRollKey({ tonic: 'E♭', mode: 'minor' });
assert.deepEqual(roll().rollKey, { tonic: 'Eb', mode: 'minor' }, 'a picked key is cleaned');
roll().setRollKey({ tonic: 'H', mode: 'major' });
assert.deepEqual(roll().rollKey, { tonic: 'Eb', mode: 'minor' }, 'a key that is not one changes nothing');
roll().undo();
assert.deepEqual(roll().rollKey, { tonic: 'G', mode: 'major' }, 'undo puts the key back');
roll().setRollKey(null);
assert.equal(effectiveRollKey(roll()).mode, 'major', 'with none set, the key is read from the notes');
assert.equal(effectiveRollKey(roll()).tonic, 'G');
roll().undo();

// ── voice-leading check ─────────────────────────────────────────────────────
async function checks(): Promise<void> {
  const flag: VoiceLeadingFlag = { bar: 1, beat: 1, tick: 3840, parts: ['soprano', 'bass'], rule: 'parallel_octaves', message: 'Parallel octaves between soprano and bass' };
  roll().setMeterMap([{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 1, meter: { num: 3, den: 4, groups: [] } }]);
  serve({ flags: [flag], count: 1 });
  const res = await roll().runVoiceLeadingCheck();
  assert.equal(res.count, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/composer/check');
  const body = sent[0].body as { parts: Record<string, ComposerNote[]>; order: string[]; key: string; mode: string; ranges: Record<string, number[]>; meter_map: unknown; pickup_steps: number; chords?: unknown[] };
  assert.deepEqual(body.order, ['soprano', 'alto', 'tenor', 'bass'], 'the SATB-named parts under their voice names');
  assert.deepEqual(body.parts.bass, [{ note: 55, tick: 0, ticks: 3840 }, { note: 50, tick: 3840, ticks: 3840 }]);
  assert.equal(Object.keys(body.parts).length, 4, 'Part 1 is left out: the SATB parts are the four');
  assert.deepEqual([body.key, body.mode], ['G', 'major']);
  assert.deepEqual(body.ranges, { soprano: [60, 84], alto: [53, 77], tenor: [48, 72], bass: body.ranges.bass }, 'each voice range from the registry');
  assert.equal(body.ranges.bass.length, 2);
  assert.deepEqual(body.meter_map, [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 1, meter: { num: 3, den: 4, groups: [] } }], "the roll's meter map");
  assert.equal(body.pickup_steps, 0);
  assert.deepEqual(body.chords, [{ tick: 0, figure: 'I', key: 'G major' }, { tick: 3840, figure: 'V7', key: 'G major' }], "the plan's harmony goes with it");
  assert.equal(roll().voiceLeading?.source, 'check');
  assert.deepEqual(roll().voiceLeading?.flags, [flag]);
  assert.equal(roll().showHarmony, true);
  assert.equal(roll()._redo.length, 0, 'a check is no document edit');

  // The flag selects the notes it is about: Part 1 is being edited, so the soprano becomes the part being edited.
  const n = roll().selectFlagNotes(flag);
  assert.equal(n, 1);
  assert.equal(roll().activeTrackId, byName('Soprano').id, 'the first flagged part is the one being edited');
  assert.deepEqual([...roll().selectedIds], [byName('Soprano').notes[1].id], 'its note sounding at the flag');
  assert.equal(roll().currentStep, 16, 'the playhead at the flag');
  roll().setActiveTrack(byName('Bass').id);
  roll().selectFlagNotes(flag);
  assert.equal(roll().activeTrackId, byName('Bass').id, 'a flagged part being edited stays');
  assert.deepEqual([...roll().selectedIds], [byName('Bass').notes[1].id]);
  roll().setActiveTrack(parts()[0].id);

  // Chosen parts, sorted top first under their own names.
  serve({ flags: [], count: 0 });
  await roll().runVoiceLeadingCheck({ partIds: [byName('Bass').id, byName('Alto').id] });
  assert.deepEqual((sent[0].body as { order: string[] }).order, ['Alto', 'Bass']);

  // A key of the caller's (the COMPOSE column's HARMONY key): read in it, and the answer says so.
  serve({ flags: [], count: 0 });
  await roll().runVoiceLeadingCheck({ key: { tonic: 'E♭', mode: 'minor' } });
  assert.deepEqual([sent[0].body.key, sent[0].body.mode], ['Eb', 'minor']);
  assert.deepEqual(roll().voiceLeading?.key, { tonic: 'Eb', mode: 'minor' });
  assert.deepEqual(roll().rollKey, { tonic: 'G', mode: 'major' }, "the roll's own key stays");

  // No SATB names: the four highest parts.
  freshRoll([pn('a', 40, 0)]);
  for (const [name, note] of [['Flute', 84], ['Oboe', 76], ['Viola', 60], ['Cello', 48], ['Kit', 50]] as const) {
    roll().addTrack({ name, notes: [pn(`${name}-1`, note, 0)], ...(name === 'Kit' ? { channel: 10 } : {}) });
  }
  serve({ flags: [], count: 0 });
  await roll().runVoiceLeadingCheck();
  const four = sent[0].body as { order: string[]; ranges: Record<string, number[]> };
  assert.deepEqual(four.order, ['Flute', 'Oboe', 'Viola', 'Cello'], 'the four highest, top first; the drum part never');
  assert.deepEqual(Object.keys(four.ranges).sort(), ['Cello', 'Flute', 'Oboe', 'Viola'], "each part's range from the instrument its name names");

  // One part: nothing to check.
  freshRoll([pn('solo', 60, 0)]);
  await assert.rejects(roll().runVoiceLeadingCheck(), /two parts/);

  // The route's own message on a 422.
  freshRoll([pn('s', 72, 0)]);
  roll().addTrack({ name: 'Bass', notes: [pn('b', 48, 0)] });
  serve({ detail: 'parts overlap' }, 422);
  await assert.rejects(roll().runVoiceLeadingCheck(), /parts overlap/);
}

// ── cantus firmus and counterpoint ──────────────────────────────────────────
function counterpoint(): void {
  freshRoll([pn('c1', 62, 0, 3840), pn('c2', 65, 3840, 3840), pn('c3', 64, 7680, 3840), pn('c4', 62, 11520, 3840)]);
  const cantusId = parts()[0].id;
  roll().addTrack({ name: 'Viola' });
  roll().setActiveTrack(cantusId);
  roll().setCantusFirmus(cantusId);
  assert.equal(byName('Part 1').cantusFirmus, true);
  assert.deepEqual(cantusFirmusOf(roll())?.notes.map((n) => n.note), [62, 65, 64, 62], 'the cantus a species request sends');
  roll().setCantusFirmus(byName('Viola').id);
  assert.equal(byName('Part 1').cantusFirmus, undefined, 'one cantus firmus at a time');
  assert.equal(byName('Viola').cantusFirmus, true);
  roll().undo();
  assert.equal(byName('Part 1').cantusFirmus, true, 'undo moves the mark back');
  assert.equal(byName('Viola').cantusFirmus, undefined);

  const species = {
    species: 4,
    position: 'above',
    key: 'D dorian',
    ppq: 960,
    bar_ticks: 3840,
    seed: 3,
    invertible: null,
    order: ['counterpoint', 'cantus'],
    parts: {
      counterpoint: [cn(69, 1920, 3840), cn(69, 5760, 3840), cn(67, 9600, 1920), cn(74, 11520, 3840)],
      cantus: [cn(62, 0, 3840), cn(65, 3840, 3840), cn(64, 7680, 3840), cn(62, 11520, 3840)],
    },
    suspensions: [{ bar: 2, beat: 1, tick: 7680, figure: '7-6' }, { bar: 3, beat: 1, tick: 11520, figure: null }],
    rhythm: [],
    violations: [],
    flags: [],
  } as unknown as SpeciesResult;
  const done = roll().writeCounterpoint(species);
  assert.equal(done.created, 1, 'a new Counterpoint part');
  assert.deepEqual(done.partIds, [byName('Counterpoint').id, cantusId], 'top voice first; the cantus into the marked part');
  assert.deepEqual(ticks(byName('Counterpoint')), [[1920, 3840], [5760, 3840], [9600, 1920], [11520, 3840]], 'the tied line at its ticks');
  assert.deepEqual(pitches(byName('Part 1')), [62, 65, 64, 62], 'the cantus back in its part');
  assert.equal(roll().notes, byName('Part 1').notes, "the part being edited shows the answer's cantus");
  assert.deepEqual(roll().harmonyChords, [{ tick: 7680, figure: '7-6' }], "the suspension's figure for the harmony row");
  assert.equal(roll().rollKey, null, 'a modal answer leaves the key');
  assert.equal(roll().voiceLeading?.ids.cantus, cantusId);
  roll().undo();
  assert.equal(parts().some((p) => p.name === 'Counterpoint'), false, 'one undo step takes the counterpoint away');

  // No marked part: the cantus goes into a part named "Cantus firmus", which takes the mark.
  roll().setCantusFirmus(null);
  roll().writeCounterpoint(species);
  assert.equal(byName('Cantus firmus').cantusFirmus, true);
  assert.deepEqual(pitches(byName('Cantus firmus')), [62, 65, 64, 62]);

  const canon = {
    key: 'C major',
    ppq: 960,
    bar_ticks: 3840,
    interval: 5,
    transposition: 'diatonic',
    lag: 1920,
    bars: 4,
    seed: 1,
    canonic_until: 11520,
    rhythm: [],
    order: ['leader', 'follower'],
    parts: { leader: [cn(60, 0), cn(62, 960)], follower: [cn(67, 1920), cn(69, 2880)] },
    violations: [],
    flags: [],
  } as unknown as CanonResult;
  roll().writeCounterpoint(canon);
  assert.deepEqual(pitches(byName('Leader')), [60, 62]);
  assert.deepEqual(ticks(byName('Follower')), [[1920, 960], [2880, 960]]);

  const fugue = {
    key: 'C minor',
    ppq: 960,
    bar_ticks: 3840,
    voices: ['soprano', 'alto', 'bass'],
    seed: 2,
    subject: [],
    answer: { kind: 'tonal', mutations: [], head: 0, notes: [] },
    countersubject: [],
    countersubject_inversion: null,
    countersubject_entries: 0,
    countersubject_rest: 0,
    resting: [],
    entries: [],
    episodes: [],
    strettos: [],
    exposition_end: 11520,
    parts: { alto: [cn(60, 0)], soprano: [cn(67, 3840)], bass: [cn(48, 7680)] },
    ranges: {},
    violations: [],
    flags: [],
  } as unknown as FugueResult;
  const f = roll().writeCounterpoint(fugue);
  assert.deepEqual(f.partIds.map((id) => parts().find((p) => p.id === id)?.name), ['Soprano', 'Alto', 'Bass'], 'voices top first, named after them');
  assert.equal(byName('Alto').instrumentId, 'alto');
}

// ── a realized form movement ────────────────────────────────────────────────
function form(): void {
  freshRoll([]);
  roll().setMarkers([
    { tick: 7680, name: 'My mark', kind: 'section' },
    { tick: 0, name: 'Old form', kind: 'section', origin: 'form' },
  ]);
  const section = (index: number, label: string, start: number, parts: Record<string, ComposerNote[]>) => ({
    index,
    role: 'minuet',
    label,
    part: null,
    theme: null,
    bars: 2,
    start_bar: start / 2880,
    start_tick: start,
    ticks: 5760,
    key: 'F major',
    enter_key: 'F major',
    end_key: 'F major',
    join: 'start',
    tempo: { bpm: 112, marking: 'Allegretto' },
    meter: { num: 3, den: 4, groups: [] },
    phrases: [],
    chords: [{ section: index, phrase: 0, bar: 0, beat: 1, tick: start, ticks: 2880, accent: 1, figure: index ? 'V' : 'I', key: 'F major', kind: 'triad', pivot: null }],
    parts,
    flags: index ? [{ bar: 2, beat: 1, tick: start, parts: ['alto', 'tenor'], rule: 'spacing', message: 'Alto and tenor more than an octave apart' }] : [],
  });
  const result = {
    form: 'minuet_and_trio',
    key: 'F major',
    seed: 5,
    ppq: 960,
    harmonic_rhythm: 'bar',
    bars: 4,
    movements: [
      {
        index: 0,
        title: 'Minuet and trio',
        form: 'minuet_and_trio',
        key: 'F major',
        tempo: { bpm: 112, marking: 'Allegretto' },
        meter: { num: 3, den: 4, groups: [] },
        bars: 4,
        ticks: 11520,
        meter_map: [{ bar: 0, meter: { num: 3, den: 4, groups: [] } }],
        tempo_map: [
          { beat: 0, bpm: 112, curve: 'step', bar: 0, tick: 0, marking: 'Allegretto' },
          { beat: 6, bpm: 104, curve: 'step', bar: 2, tick: 5760, marking: 'Trio' },
        ],
        sections: [
          section(0, 'Minuet', 0, { soprano: [cn(77, 0, 2880)], alto: [cn(72, 0, 2880)], tenor: [cn(69, 0, 2880)], bass: [cn(53, 0, 2880)] }),
          section(1, 'Trio', 5760, { soprano: [cn(79, 5760, 2880)], alto: [cn(72, 5760, 2880)], tenor: [cn(64, 5760, 2880)], bass: [cn(48, 5760, 2880)] }),
        ],
      },
    ],
  } as unknown as FormResult;
  assert.equal(roll().writeFormMovement(result, 3), null, 'a movement the form does not have');
  const before = { meter: roll().meterMap, tempo: roll().tempoMap, markers: roll().markers };
  const spare = parts()[0].id;
  const done = roll().writeFormMovement(result);
  assert.ok(done);
  assert.equal(done.created, 4);
  assert.deepEqual(parts().map((p) => p.name), ['Soprano', 'Alto', 'Tenor', 'Bass'], 'a roll with no notes loses its spare empty part: the movement is the roll');
  assert.equal(roll().activeTrackId, byName('Soprano').id, 'its top voice is the part being edited');
  assert.deepEqual(ticks(byName('Soprano')), [[0, 2880], [5760, 2880]], "both sections' notes in one part");
  assert.deepEqual(roll().meterMap.map((s) => [s.bar, s.meter.num, s.meter.den]), [[0, 3, 4]], "the movement's meter");
  assert.equal(roll().pickupSteps, 0);
  assert.deepEqual(roll().tempoMap.map((e) => [e.beat, e.bpm]), [[0, 112], [6, 104]], 'its tempo map');
  assert.equal(roll().bpm, 112);
  assert.deepEqual(
    roll().markers.map((m) => [m.tick, m.name, m.kind, m.origin ?? null]),
    [[0, 'Minuet and trio', 'movement', 'form'], [0, 'Minuet', 'section', 'form'], [5760, 'Trio', 'section', 'form'], [7680, 'My mark', 'section', null]],
    "FORM's markers replace the old form's and keep the user's",
  );
  assert.deepEqual(roll().rollKey, { tonic: 'F', mode: 'major' });
  assert.deepEqual(roll().harmonyChords.map((c) => c.figure), ['I', 'V']);
  assert.equal(roll().voiceLeading?.flags.length, 1);
  assert.equal(roll().voiceLeading?.ids.tenor, byName('Tenor').id);
  assert.ok(roll().totalSteps >= 48, 'the grid holds the movement');
  roll().undo();
  assert.equal(roll().meterMap, before.meter, 'one undo puts the meter back');
  assert.equal(roll().tempoMap, before.tempo, 'and the tempo map');
  assert.equal(roll().markers, before.markers, 'and the markers');
  assert.equal(parts().length, 1, 'and takes the parts away');
  assert.equal(parts()[0].id, spare, 'the empty part comes back');
  assert.equal(roll().activeTrackId, spare, 'as the part being edited');

  // An empty part with a name of its own, or marked for a job, is no spare.
  freshRoll([]);
  roll().renameTrack(parts()[0].id, 'Oboe line');
  roll().writeFormMovement(result);
  assert.deepEqual(parts().map((p) => p.name), ['Oboe line', 'Soprano', 'Alto', 'Tenor', 'Bass']);
  freshRoll([]);
  roll().setCantusFirmus(parts()[0].id);
  roll().writeFormMovement(result);
  assert.deepEqual(parts().map((p) => p.name), ['Part 1', 'Soprano', 'Alto', 'Tenor', 'Bass'], 'the cantus firmus part stays, empty or not');
}

// ── figured bass: written, saved, reopened, realized ────────────────────────
async function figuredBass(): Promise<void> {
  freshRoll([pn('b1', 48, 0), pn('b2', 50, 960), pn('b2x', 55, 960), pn('b3', 43, 1920, 1920)]);
  const bass = parts()[0].id;
  roll().setFigure(960, ' 6 ');
  roll().setFigure(1920, '7');
  roll().setFigure(1920, '6/4 x');
  assert.deepEqual(parts()[0].figuredBass, [{ tick: 960, figure: '6' }, { tick: 1920, figure: '6/4' }], 'cleaned, one per tick, sorted');
  roll().undo();
  assert.deepEqual(parts()[0].figuredBass, [{ tick: 960, figure: '6' }, { tick: 1920, figure: '7' }], 'undo puts the figure before back');
  roll().setFigure(960, '');
  assert.deepEqual(parts()[0].figuredBass, [{ tick: 1920, figure: '7' }], 'a blank figure removes the mark');
  roll().undo();
  const writes = roll()._undo.length;
  roll().setFigure(960, '6');
  assert.equal(roll()._undo.length, writes, 'the same figure again is no step');

  // Saved with the part's clip, through a .tasmo file, and opened again.
  const ref = rollPartRef(parts()[0], 0, 'doc-1');
  assert.deepEqual(ref.figuredBass, [{ tick: 960, figure: '6' }, { tick: 1920, figure: '7' }]);
  const file = JSON.parse(JSON.stringify(rollPartToTasmo(ref)));
  assert.deepEqual(file.figured_bass, [{ tick: 960, figure: '6' }, { tick: 1920, figure: '7' }], 'the file shape');
  const back = tasmoRollPart(file, { name: 'x', color: '#000000' });
  assert.deepEqual(back?.figuredBass, ref.figuredBass, 'a .tasmo record reads back');
  assert.deepEqual(cleanRollPartRef({ ...ref, figuredBass: [{ tick: -5, figure: '6' }, { tick: 'x' }] }, { name: 'x', color: '#000000' })?.figuredBass, [{ tick: 0, figure: '6' }], 'junk is dropped');
  const clip = {
    id: 'clip-bass',
    trackId: 't1',
    label: 'Bass',
    color: '#000000',
    startSec: 0,
    sourceKind: 'midi',
    sourceRollNotes: parts()[0].notes,
    sourcePianoRoll: parts()[0].notes,
    sourceBpm: 120,
    sourceTotalSteps: 64,
    sourceRollPart: back,
  } as unknown as Parameters<typeof clipPartsLoad>[0];
  const load = clipPartsLoad(clip, [clip], [{ id: 't1', name: 'Bass', color: '#000000' }]);
  roll().loadFromClip(...load);
  assert.deepEqual(parts()[0].figuredBass, [{ tick: 960, figure: '6' }, { tick: 1920, figure: '7' }], 'the reopened part has its figures');
  const reopened = parts()[0].id;
  assert.equal(reopened, bass, 'the same part');

  // Realized: the bass one note at a time with its figures; the upper voices into Soprano, Alto, Tenor.
  roll().setRollKey({ tonic: 'C', mode: 'major' });
  const answer = {
    key: 'C major',
    ppq: 960,
    chords: [
      { bar: 0, beat: 1, tick: 0, ticks: 960, figure: '', roman: 'I', pitches: {}, names: {} },
      { bar: 0, beat: 2, tick: 960, ticks: 960, figure: '6', roman: 'ii6', pitches: {}, names: {} },
      { bar: 0, beat: 3, tick: 1920, ticks: 1920, figure: '7', roman: null, pitches: {}, names: {} },
    ],
    parts: {
      soprano: [cn(72, 0), cn(74, 960), cn(71, 1920, 1920)],
      alto: [cn(67, 0), cn(65, 960), cn(65, 1920, 1920)],
      tenor: [cn(64, 0), cn(62, 960), cn(62, 1920, 1920)],
      bass: [cn(48, 0), cn(50, 960), cn(43, 1920, 1920)],
    },
    flags: [],
  } as unknown as ContinuoResult;
  serve(answer);
  const realized = await roll().realizeFiguredBass();
  assert.equal(sent[0].url, '/api/composer/continuo');
  const body = sent[0].body as { bass: Array<ComposerNote & { figure: string }>; key: string; mode: string };
  assert.deepEqual(
    body.bass,
    [{ note: 48, tick: 0, ticks: 960, figure: '' }, { note: 50, tick: 960, ticks: 960, figure: '6' }, { note: 43, tick: 1920, ticks: 1920, figure: '7' }],
    'one note a time (the lower of a chord), each with its figure',
  );
  assert.deepEqual([body.key, body.mode], ['C', 'major']);
  assert.equal(realized.created, 3);
  assert.deepEqual(parts().map((p) => p.name), ['Part 1', 'Soprano', 'Alto', 'Tenor'], 'the bass keeps its part and notes');
  assert.deepEqual(pitches(byName('Tenor')), [64, 62, 62]);
  assert.deepEqual(roll().harmonyChords.map((c) => c.figure), ['I', 'ii6', '7'], 'the roman numerals, the figure where none was read');
  assert.equal(roll().voiceLeading?.ids.bass, bass);
  roll().undo();
  assert.equal(parts().length, 1, 'one undo step');

  // CLEAR takes the figures with the notes.
  roll().clear();
  assert.equal(parts()[0].figuredBass, undefined);
  roll().undo();
  assert.equal(parts()[0].figuredBass?.length, 2);

  await assert.rejects(roll().realizeFiguredBass('no-such-part'), /no notes/);
}

// ── the selection transforms, each one undo step ────────────────────────────
function transforms(): void {
  // C major, a rising figure C D E, then a note outside the selection.
  freshRoll([pn('c', 60, 0), pn('d', 62, 960), pn('e', 64, 1920), pn('x', 48, 3840)]);
  roll().setRollKey({ tonic: 'C', mode: 'major' });
  const sel = ['c', 'd', 'e'];
  const at = () => roll().notes.map((n) => [n.id, n.note, n.tick, n.ticks]);
  const start = at();
  const run = (kind: (typeof ROLL_TRANSFORMS)[number], opts = {}) => {
    roll().setSelection(sel);
    const steps = roll()._undo.length;
    const n = roll().transformSelection(kind, opts);
    assert.equal(roll()._undo.length, steps + 1, `${kind}: one undo step`);
    return n;
  };
  assert.equal(run('invert'), 3);
  assert.deepEqual(at().slice(0, 3).map((r) => r[1]), [60, 59, 57], 'inverted by scale degree in C: C B A');
  assert.deepEqual(at()[3], ['x', 48, 3840, 960], 'a note outside the selection stays');
  roll().undo();
  assert.deepEqual(at(), start);
  run('invert', { diatonic: false });
  assert.deepEqual(at().slice(0, 3).map((r) => r[1]), [60, 58, 56], 'chromatic inversion');
  roll().undo();
  run('retrograde');
  assert.deepEqual(at().slice(0, 3).map((r) => [r[1], r[2]]), [[60, 1920], [62, 960], [64, 0]], 'retrograde inside the span');
  roll().undo();
  run('augment');
  assert.deepEqual(at().slice(0, 3).map((r) => [r[2], r[3]]), [[0, 1920], [1920, 1920], [3840, 1920]], 'twice as long from the first onset');
  roll().undo();
  run('diminish');
  assert.deepEqual(at().slice(0, 3).map((r) => [r[2], r[3]]), [[0, 480], [480, 480], [960, 480]]);
  roll().undo();
  const seq = run('sequence', { steps: 2, interval: -1 });
  assert.equal(seq, 9, 'the figure and two statements, all selected');
  assert.equal(roll().notes.length, 10);
  const copies = roll().notes.slice(4);
  assert.deepEqual(copies.map((n) => n.note), [59, 60, 62, 57, 59, 60], 'each statement a scale step lower');
  assert.ok(copies.every((n) => !n.id.includes('~')), 'the copies have ids of their own');
  assert.equal(new Set(roll().notes.map((n) => n.id)).size, 10);
  roll().undo();
  assert.deepEqual(at(), start, 'undo takes the copies away');
  const frag = run('fragment');
  assert.equal(frag, 1, 'half the onsets, at least one');
  assert.deepEqual(roll().notes.map((n) => n.id), ['c', 'x']);
  roll().undo();
  roll().setSelection(sel);
  run('fragment', { part: 'tail', count: 2 });
  assert.deepEqual(roll().notes.map((n) => [n.note, n.tick]), [[62, 0], [64, 960], [48, 3840]], 'the tail, moved to where the selection started');
  roll().undo();
  roll().clearSelection();
  assert.equal(roll().transformSelection('invert'), 0, 'nothing selected, nothing done');
  // A sequence past the roll's end grows the roll.
  freshRoll([pn('late', 60, 3840 * 15, 3840)]);
  roll().setSelection(['late']);
  const total = roll().totalSteps;
  roll().transformSelection('sequence', { steps: 1, interval: 2 });
  assert.ok(roll().totalSteps > total, 'the roll grows to hold the sequence');
}

// ── one cantus firmus a roll, whatever a file says ──────────────────────────
{
  const two = sanitizeRollTracks([{ name: 'A', cantusFirmus: true }, { name: 'B', cantusFirmus: true }]);
  assert.deepEqual(two.map((t) => t.cantusFirmus), [true, undefined]);
}

// A suspension's figure is no harmony for the checker; a roman numeral is.
async function suspensionsAreNoHarmony(): Promise<void> {
  freshRoll([pn('u', 72, 0)]);
  roll().addTrack({ name: 'Bass', notes: [pn('l', 48, 0)] });
  usePianoRollStore.setState({ harmonyChords: [{ tick: 0, figure: '7-6' }, { tick: 960, figure: 'ii6' }, { tick: 1920, figure: '6' }] });
  serve({ flags: [], count: 0 });
  await roll().runVoiceLeadingCheck();
  assert.deepEqual((sent[0].body as { chords?: unknown }).chords, [{ tick: 960, figure: 'ii6' }]);
}

await checks();
await suspensionsAreNoHarmony();
counterpoint();
form();
await figuredBass();
transforms();
globalThis.fetch = realFetch;
performance.now = realNow;
console.log('pianoRollStore.composer: ok');
