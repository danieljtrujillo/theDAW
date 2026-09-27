/**
 * lib/rollMarkers: the piano roll's named markers as a model.
 *
 * Covered here: a marker list sanitized from junk (a hand-edited .tasmo), the
 * names a new marker gets (rehearsal letters, roman numerals), FORM's section
 * markers and how a rebuild keeps the user's own, and the seconds a marker
 * lands at on EDIT's timeline through a clip's tempo map (a marker after a
 * ritardando sits where the music does, not where one tempo would put it).
 * Run from `frontend/`:
 *   npx tsx src/lib/rollMarkers.test.ts
 */
import assert from 'node:assert/strict';
import {
  MARKER_NAME_MAX,
  clipTimelineMarkers,
  editMarkerId,
  formSectionMarkers,
  markerAround,
  markerBarLabel,
  markerStep,
  nextMarkerName,
  rehearsalLetter,
  rollMarkerToTasmo,
  romanNumeral,
  sanitizeRollMarkers,
  tasmoToRollMarkers,
  withClipTimelineMarkers,
  withFormMarkers,
  withoutFormMarkers,
} from './rollMarkers.ts';
import { normalizeMeterMap } from './meterMap.ts';
import { stepClock } from './rollTempo.ts';

const close = (a: number, b: number, eps: number, what: string) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b}`);

// Names.
assert.equal(romanNumeral(1), 'I');
assert.equal(romanNumeral(4), 'IV');
assert.equal(romanNumeral(9), 'IX');
assert.equal(romanNumeral(14), 'XIV');
assert.equal(rehearsalLetter(0), 'A');
assert.equal(rehearsalLetter(25), 'Z');
assert.equal(rehearsalLetter(26), 'AA');
assert.equal(nextMarkerName([], 'section'), 'A');
assert.equal(nextMarkerName([{ name: 'A', kind: 'section' }, { name: 'I', kind: 'movement' }], 'section'), 'B');
assert.equal(nextMarkerName([{ name: 'A', kind: 'section' }, { name: 'I', kind: 'movement' }], 'movement'), 'II');
// A letter taken by a movement is still free for a section.
assert.equal(nextMarkerName([{ name: 'A', kind: 'movement' }], 'section'), 'A');

// A hand-edited list: junk left out, places in ticks or steps, one id once, one of a kind per tick.
const clean = sanitizeRollMarkers([
  { id: 'm1', tick: 960 * 4, name: '  Exposition  ', kind: 'section' },
  null,
  { id: 'bad', tick: -5, name: 'before the start' },
  { id: 'nan', tick: Number.NaN, name: 'no place' },
  { id: 'm2', step: 0, name: 'I. Allegro', kind: 'movement' },
  { id: 'm1', tick: 99, name: 'second m1' },
  { id: 'm3', step: 0, kind: 'section' },
  { id: 'm4', tick: 960 * 4, name: 'Later at the same tick', kind: 'section' },
  { id: 'm5', tick: 1920.4, name: 'x'.repeat(200), kind: 'nonsense' as never },
]);
assert.deepEqual(
  clean.map((m) => [m.id, m.tick, m.kind]),
  [['m2', 0, 'movement'], ['m3', 0, 'section'], ['m5', 1920, 'section'], ['m4', 3840, 'section']],
  'sorted by tick, a movement before a section at one tick, the later of two sections at one tick kept',
);
assert.equal(clean.find((m) => m.id === 'm3')?.name, 'A', 'a marker with no name gets the next letter');
assert.equal(clean.find((m) => m.id === 'm5')?.name.length, MARKER_NAME_MAX);
assert.equal(markerStep(clean[3]), 16);

// FORM: one marker per section at its first bar line, a returning role numbered.
const meterMap = normalizeMeterMap([{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }]);
const form = formSectionMarkers([
  { label: 'Intro', step: 2 },
  { label: 'Theme', step: 2 + 14 * 2 },
  { label: 'Chorus', step: 2 + 14 * 4 },
  { label: 'Theme', step: 2 + 14 * 6 },
]);
assert.deepEqual(form.map((m) => m.name), ['Intro', 'Theme', 'Chorus', 'Theme 2']);
assert.ok(form.every((m) => m.origin === 'form' && m.kind === 'section'));
assert.deepEqual(form.map((m) => markerBarLabel(m, meterMap, 2)), ['Bar 1', 'Bar 3', 'Bar 5', 'Bar 7'], '7/8 bars after a pickup of 2 steps');

// A rebuild: the previous FORM markers go, the user's stay; a user marker on a FORM marker's tick wins it.
const user = sanitizeRollMarkers([
  { id: 'u1', step: 0, name: 'I. Allegro', kind: 'movement' },
  { id: 'u2', step: 30, name: 'My theme', kind: 'section' },
]);
const first = withFormMarkers(user, form);
assert.deepEqual(first.map((m) => m.name), ['I. Allegro', 'Intro', 'My theme', 'Chorus', 'Theme 2']);
const smaller = formSectionMarkers([{ label: 'Intro', step: 2 }, { label: 'Outro', step: 16 }]);
const second = withFormMarkers(first, smaller);
assert.deepEqual(second.map((m) => m.name), ['I. Allegro', 'Intro', 'Outro', 'My theme'], 'the old Chorus and Theme 2 are gone');
assert.deepEqual(withoutFormMarkers(second).map((m) => m.id), ['u1', 'u2']);

// Previous and next around the playhead.
const around = markerAround(first, 30);
assert.equal(around.prev?.name, 'Intro');
assert.equal(around.next?.name, 'Chorus');

// EDIT's timeline: a clip at 10 s with a ritardando from beat 4 to beat 8 (120 → 60 BPM).
const tempoMap = [
  { beat: 0, bpm: 120 },
  { beat: 4, bpm: 120, curve: 'linear' as const },
  { beat: 8, bpm: 60 },
];
const markers = sanitizeRollMarkers([
  { id: 'a', step: 0, name: 'A' },
  { id: 'b', step: 16, name: 'B' },
  { id: 'c', step: 40, name: 'C' },
  { id: 'far', step: 4000, name: 'past the clip' },
]);
const clock = stepClock(120, tempoMap);
const duration = clock.at(64);
const placed = clipTimelineMarkers(markers, { clipId: 'clip1', startSec: 10, offsetSec: 0, durationSec: duration, bpm: 120, tempoMap });
assert.deepEqual(placed.map((m) => m.id), [editMarkerId('clip1', 'a'), editMarkerId('clip1', 'b'), editMarkerId('clip1', 'c')], 'a marker past the clip is left out');
close(placed[0].t, 10, 1e-9, 'A at the clip start');
close(placed[1].t, 12, 1e-9, 'B after four beats at 120');
// C is 10 beats in: 2 s, then the ramp's four beats (60*4*ln(60/120)/(60-120) s), then two beats at 60.
const ramp = (60 * 4 * Math.log(60 / 120)) / (60 - 120);
close(placed[2].t, 10 + 2 + ramp + 2, 1e-6, 'C after the ritardando');
assert.ok(placed[2].t > 10 + 10 * 0.5 + 0.5, 'C sits later than one tempo would put it');
assert.equal(placed[2].label, 'C');

// A second bounce replaces the clip's markers and leaves every other marker alone.
const others = [{ id: 'user-1', t: 3, label: 'Verse' }, { id: editMarkerId('clip2', 'x'), t: 50, label: 'Other clip' }];
const once = withClipTimelineMarkers(others, 'clip1', placed);
assert.equal(once.length, 5);
const again = withClipTimelineMarkers(once, 'clip1', placed.slice(0, 1));
assert.deepEqual(again.map((m) => m.id), ['user-1', editMarkerId('clip1', 'a'), editMarkerId('clip2', 'x')]);
assert.equal(again[0], others[0], 'a marker the bounce did not write keeps its object');

// .tasmo: a round trip through JSON keeps every field; a file without markers or with junk loads none.
const saved = JSON.parse(JSON.stringify(first.map(rollMarkerToTasmo)));
assert.equal(saved[1].origin, 'form');
assert.equal('origin' in saved[0], false, "a user's marker writes no origin");
assert.deepEqual(tasmoToRollMarkers(saved), first);
assert.deepEqual(tasmoToRollMarkers(undefined), []);
assert.deepEqual(tasmoToRollMarkers('nope'), []);
assert.deepEqual(tasmoToRollMarkers([1, 'x', { name: 'no place' }]), []);

console.log('rollMarkers: ok');
