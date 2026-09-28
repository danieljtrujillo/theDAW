/**
 * The COMPOSE panel's model: every option it offers is one the backend takes,
 * every limit is the backend's own (read out of router.py, so the two cannot
 * drift apart), requests come out clamped and without the fields that mean
 * nothing for the choice made, and a refusal reads as the backend's sentence.
 *
 * Run: `npx tsx src/lib/composerPanelModel.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError } from './apiJson';
import { FORM_NAMES, type StyleProfile, type VoiceLeadingFlag } from './composerClient';
import {
  CADENCE_OPTIONS,
  CANON_INTERVALS,
  CANTUS_PRESETS,
  ComposeInputError,
  DEFAULT_CANON,
  DEFAULT_COUNTERPOINT,
  DEFAULT_FORM,
  DEFAULT_FUGUE,
  DEFAULT_HARMONY,
  DEFAULT_PROFILE,
  FORM_METER_OPTIONS,
  FORM_OPTIONS,
  INVERTIBLE_OPTIONS,
  LIMITS,
  MODAL_MODES,
  SPECIES_OPTIONS,
  TONICS,
  cadenceShares,
  canonIntervalLabel,
  canonRequest,
  clampInt,
  countByRule,
  doneStatus,
  errorStatus,
  flagPlace,
  formBarsMax,
  formControlApplies,
  formRequest,
  fugueRequest,
  harmonicRhythmOptions,
  harmonicRhythmText,
  inversionRequest,
  melodicLine,
  minCanonBars,
  notesSoundingAt,
  parseFormMeter,
  planRequest,
  profileRequest,
  rerollSeed,
  ruleLabel,
  sameFormRequest,
  speciesRequest,
  styleOptionLabel,
  toggleCorpusPiece,
  topChords,
} from './composerPanelModel';

// ── the backend's own numbers, read from router.py ──────────────────────────
const ROUTER = readFileSync(path.resolve(import.meta.dirname, '../../../backend/modules/composer/router.py'), 'utf8');
const SPEC = readFileSync(path.resolve(import.meta.dirname, '../../../backend/modules/composer/spec.py'), 'utf8');
const constant = (name: string): number => {
  const m = new RegExp(`^${name} = (\\d+)$`, 'm').exec(ROUTER);
  assert.ok(m, `router.py defines ${name}`);
  return Number(m[1]);
};
assert.equal(LIMITS.planBars.max, constant('MAX_BARS'));
assert.equal(LIMITS.formBars.min, constant('MIN_FORM_BARS'));
assert.equal(LIMITS.formBars.max, constant('MAX_FORM_BARS'));
assert.equal(LIMITS.symphonyBars.max, constant('MAX_SYMPHONY_BARS'));
assert.equal(LIMITS.variations.max, constant('MAX_VARIATIONS'));
assert.equal(LIMITS.profileWorks.max, constant('MAX_PROFILE_WORKS'));
assert.equal(LIMITS.cantusNotes.max, constant('MAX_CANTUS'));
assert.equal(LIMITS.subjectNotes.max, constant('MAX_SUBJECT'));
assert.equal(LIMITS.canonBars.max, constant('MAX_CANON_BARS'));
assert.equal(LIMITS.inversionNotes.max, constant('MAX_NOTES'));
assert.match(ROUTER, /bars: int = Field\(default=8, ge=2, le=MAX_BARS\)/, 'a plan is 2 bars or more');
assert.match(ROUTER, /interval: int = Field\(default=5, ge=-15, le=15\)/);
assert.match(ROUTER, /lag: int = Field\(default=BAR_TICKS, ge=PPQ, le=4 \* BAR_TICKS\)/, 'a lag is 1 to 16 quarters');
assert.match(ROUTER, /bars: int = Field\(default=8, ge=4, le=MAX_CANON_BARS\)/);
assert.match(ROUTER, /tempo: Optional\[float\] = Field\(default=None, ge=20, le=300\)/);
assert.match(ROUTER, /max_bars: int = Field\(default=96, ge=4, le=400\)/);
assert.match(ROUTER, /name: str = Field\(default="", max_length=80\)/);
assert.equal(LIMITS.formTempo.min, 20);
assert.equal(LIMITS.formTempo.max, 300);
assert.equal(LIMITS.profileMaxBars.min, 4);
assert.equal(LIMITS.profileMaxBars.max, 400);
assert.equal(LIMITS.profileName, 80);

// ── the options are the backend's vocabularies ──────────────────────────────
const tuple = (name: string): string[] => {
  const m = new RegExp(`^${name} = \\(([^)]*)\\)`, 'ms').exec(SPEC);
  assert.ok(m, `spec.py defines ${name}`);
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
};
assert.deepEqual(FORM_OPTIONS.map((o) => o.value), [...FORM_NAMES]);
assert.deepEqual(FORM_OPTIONS.map((o) => o.value), tuple('FORMS'));
assert.deepEqual(CADENCE_OPTIONS.filter((o) => o.value).map((o) => o.value), tuple('CADENCES'));
assert.equal(CADENCE_OPTIONS[0].value, '', 'the first cadence leaves it to the backend');
assert.deepEqual(MODAL_MODES.map((o) => o.value), tuple('MODES'));
assert.deepEqual(SPECIES_OPTIONS.map((o) => o.value), [1, 2, 3, 4, 5]);
assert.deepEqual(
  CANTUS_PRESETS.map((o) => o.value),
  [...SPEC.matchAll(/^ {4}"(fux_[a-z]+)": \{/gm)].map((m) => m[1]),
  'the Fux presets are spec.py CANTUS_FIRMI',
);
assert.deepEqual(INVERTIBLE_OPTIONS.map((o) => o.value), ['', 8, 10, 12]);
assert.equal(TONICS.length, 14);

// Every canon interval canon.py takes, and none it refuses (0 and -1).
const intervals = CANON_INTERVALS.map((o) => o.value);
assert.equal(intervals.length, 29);
assert.ok(!intervals.includes(0) && !intervals.includes(-1));
assert.ok(intervals.every((n) => n >= -15 && n <= 15));
assert.equal(canonIntervalLabel(1), 'Unison');
assert.equal(canonIntervalLabel(5), '5th above');
assert.equal(canonIntervalLabel(8), 'Octave above');
assert.equal(canonIntervalLabel(-4), '4th below');

// Meters: all valid for the backend's MeterIn; '' keeps the form's own.
assert.equal(FORM_METER_OPTIONS[0].value, '');
for (const o of FORM_METER_OPTIONS.slice(1)) assert.ok(parseFormMeter(o.value), `${o.value} parses`);
assert.deepEqual(parseFormMeter('6/8'), { num: 6, den: 8, groups: [] });
assert.equal(parseFormMeter('7/6'), null, 'a denominator of 6 is not a meter');
assert.equal(parseFormMeter(''), null);

// ── the style picker says measured or authored ──────────────────────────────
assert.equal(styleOptionLabel({ name: 'J. S. Bach', era: 'Baroque', source: 'extracted', works: 40 }), 'J. S. Bach (Baroque): measured, 40 works');
assert.equal(styleOptionLabel({ name: 'Debussy', era: 'Impressionist', source: 'authored', works: 0 }), 'Debussy (Impressionist): authored');

// "style" as a harmonic rhythm exists only with a style.
assert.ok(!harmonicRhythmOptions(false).some((o) => o.value === 'style'));
assert.ok(harmonicRhythmOptions(true).some((o) => o.value === 'style'));

// ── plan ────────────────────────────────────────────────────────────────────
assert.deepEqual(planRequest(DEFAULT_HARMONY), { key: 'C', mode: 'major', bars: 8, seed: 0 }, 'unset options stay unset');
assert.equal(planRequest({ ...DEFAULT_HARMONY, bars: 1 }).bars, 2, 'a plan has at least 2 bars');
assert.equal(planRequest({ ...DEFAULT_HARMONY, bars: 99 }).bars, 64, 'and at most 64');
assert.equal(planRequest({ ...DEFAULT_HARMONY, harmonicRhythm: 'style' }).harmonicRhythm, undefined, "no 'style' rhythm without a style");
const inStyle = planRequest({ ...DEFAULT_HARMONY, style: 'bach', harmonicRhythm: 'style', cadence: 'half', seed: 7 }, [
  { bar: 0, meter: { num: 3, den: 4, groups: [] } },
]);
assert.deepEqual(inStyle, {
  key: 'C',
  mode: 'major',
  bars: 8,
  seed: 7,
  cadence: 'half',
  harmonicRhythm: 'style',
  style: 'bach',
  meterMap: [{ bar: 0, meter: { num: 3, den: 4, groups: [] } }],
});

// ── form ────────────────────────────────────────────────────────────────────
assert.deepEqual(formRequest(DEFAULT_FORM), { form: 'sonata', key: 'C', mode: 'major', seed: 0 }, "the form's own length, tempo and meter");
assert.equal(formBarsMax('symphony'), 800);
assert.equal(formBarsMax('rondo'), 400);
assert.equal(formRequest({ ...DEFAULT_FORM, bars: 900 }).bars, 400, 'a single form is at most 400 bars');
assert.equal(formRequest({ ...DEFAULT_FORM, form: 'symphony', bars: 900 }).bars, 800, 'a symphony at most 800');
assert.equal(formRequest({ ...DEFAULT_FORM, bars: 3 }).bars, 16, 'a form needs 16 bars');
const symphony = formRequest({ ...DEFAULT_FORM, form: 'symphony', tempo: 90, meter: '3/4', rondo: 'ABACABA', variations: 5 });
assert.deepEqual(symphony, { form: 'symphony', key: 'C', mode: 'major', seed: 0 }, "a symphony's movements keep their own meter and tempo");
assert.ok(!formControlApplies('symphony', 'tempo') && !formControlApplies('symphony', 'meter'));
const rondo = formRequest({ ...DEFAULT_FORM, form: 'rondo', tempo: 400, meter: '2/4', rondo: 'ABACABA', variations: 5 });
assert.deepEqual(rondo, { form: 'rondo', key: 'C', mode: 'major', seed: 0, tempo: 300, meter: { num: 2, den: 4, groups: [] }, rondo: 'ABACABA' });
const tv = formRequest({ ...DEFAULT_FORM, form: 'theme_and_variations', variations: 30 });
assert.equal(tv.variations, 12, 'at most 12 variations');
assert.equal(tv.rondo, undefined, 'only a rondo has a pattern');
assert.ok(sameFormRequest(formRequest(DEFAULT_FORM), formRequest({ ...DEFAULT_FORM })));
assert.ok(!sameFormRequest(formRequest(DEFAULT_FORM), formRequest({ ...DEFAULT_FORM, seed: 1 })));
assert.ok(!sameFormRequest(null, formRequest(DEFAULT_FORM)));

// ── counterpoint ────────────────────────────────────────────────────────────
assert.deepEqual(speciesRequest(DEFAULT_COUNTERPOINT), { species: 1, position: 'above', seed: 0, preset: 'fux_dorian' });
const line = [
  { note: 62, tick: 0, ticks: 3840 },
  { note: 50, tick: 0, ticks: 3840 }, // a chord: the top note is the line
  { note: 65, tick: 3840, ticks: 3840 },
  { note: 64, step: 32, length: 16 },
];
assert.deepEqual(melodicLine(line).map((n) => n.note), [62, 65, 64]);
const fromPart = speciesRequest({ ...DEFAULT_COUNTERPOINT, cantus: 'part', species: 3, position: 'below', key: 'D', mode: 'dorian', invertible: 10 }, line);
assert.deepEqual(fromPart.cantus?.map((n) => n.note), [62, 65, 64]);
assert.equal(fromPart.key, 'D');
assert.equal(fromPart.mode, 'dorian');
assert.equal(fromPart.invertible, 10);
assert.equal(fromPart.preset, undefined, 'a cantus or a preset, never both');
assert.throws(() => speciesRequest({ ...DEFAULT_COUNTERPOINT, cantus: 'part' }, [{ note: 60, tick: 0, ticks: 960 }]), ComposeInputError);
const long = Array.from({ length: 33 }, (_, i) => ({ note: 60 + (i % 5), tick: i * 3840, ticks: 3840 }));
assert.throws(() => speciesRequest({ ...DEFAULT_COUNTERPOINT, cantus: 'part' }, long), /at most 32 notes; the selected part has 33/);

// canon: the lag goes in ticks, and the bars rise to what the lag needs
assert.equal(minCanonBars(1), 4);
assert.equal(minCanonBars(4), 4);
assert.equal(minCanonBars(8), 5);
assert.equal(minCanonBars(16), 7);
assert.deepEqual(canonRequest(DEFAULT_CANON), {
  key: 'C',
  mode: 'major',
  interval: 8,
  lag: 3840,
  bars: 8,
  transposition: 'diatonic',
  rhythm: 'mixed',
  seed: 0,
});
const wide = canonRequest({ ...DEFAULT_CANON, lagBeats: 16, bars: 4, interval: 0 });
assert.equal(wide.lag, 16 * 960);
assert.equal(wide.bars, 7, 'a 16-beat lag needs 7 bars');
assert.equal(wide.interval, 8, 'an interval the backend refuses falls back to the octave');
assert.equal(canonRequest({ ...DEFAULT_CANON, lagBeats: 40 }).lag, 16 * 960, 'a lag is at most four bars');

// fugue
assert.deepEqual(fugueRequest(DEFAULT_FUGUE), { key: 'C', mode: 'minor', voices: 3, episodes: 1, countersubject: true, seed: 0, subjectStart: 'tonic' });
const subject = fugueRequest({ ...DEFAULT_FUGUE, subject: 'part', voices: 4, episodes: 2 }, line);
assert.deepEqual(subject.subject?.map((n) => n.note), [62, 65, 64]);
assert.equal(subject.subjectStart, undefined, 'a given subject starts where it starts');
assert.throws(() => fugueRequest({ ...DEFAULT_FUGUE, subject: 'part' }, []), ComposeInputError);

// inversion
const inv = inversionRequest([{ note: 72, tick: 0, ticks: 960 }], [{ note: 60, tick: 0, ticks: 960 }], 12, 'C', 'major');
assert.deepEqual(inv, { upper: [{ note: 72, tick: 0, ticks: 960 }], lower: [{ note: 60, tick: 0, ticks: 960 }], interval: 12, key: 'C', mode: 'major' });
assert.deepEqual(Object.keys(inversionRequest([{ note: 72 }], [{ note: 60 }], 8, '', '')), ['upper', 'lower', 'interval'], 'no key: read from the notes');
assert.throws(() => inversionRequest([], [{ note: 60 }], 8), ComposeInputError);

// ── profile ─────────────────────────────────────────────────────────────────
assert.throws(() => profileRequest(DEFAULT_PROFILE), /at least one corpus piece/);
assert.deepEqual(profileRequest({ ...DEFAULT_PROFILE, corpus: ['bach_bwv66_6_mxl'], name: '  Chorales  ', maxBars: 1000 }), {
  corpus: ['bach_bwv66_6_mxl'],
  id: 'custom',
  name: 'Chorales',
  maxBars: 400,
});
assert.deepEqual(profileRequest({ ...DEFAULT_PROFILE, source: 'library', entryId: 'e1', id: 'my-style_2', maxBars: 2 }), {
  entryId: 'e1',
  id: 'my-style_2',
  maxBars: 4,
});
assert.throws(() => profileRequest({ ...DEFAULT_PROFILE, source: 'library' }), /pick a library score/);
assert.throws(() => profileRequest({ ...DEFAULT_PROFILE, corpus: ['x'], id: 'My Style' }), /lowercase/);
let picked: string[] = [];
for (let i = 0; i < 45; i += 1) picked = toggleCorpusPiece(picked, `p${i}`);
assert.equal(picked.length, 40, 'never past the backend’s 40 works');
assert.deepEqual(toggleCorpusPiece(['a', 'b'], 'a'), ['b']);

const prof = {
  vocabulary: { major: { I: 0.4, V: 0.3, IV: 0.1, ii: 0.1, vi: 0.1 }, minor: {} },
  cadences: { authentic_perfect: 0.5, authentic_imperfect: 0.1, half: 0.2, plagal: 0.05, deceptive: 0.05, phrygian_half: 0 },
  cadence_other: 0.1,
  harmonic_rhythm: { chords_per_bar: 2.25, chords_per_pulse: 0.5625 },
} as unknown as StyleProfile;
assert.deepEqual(topChords(prof, 'major', 3), [
  { label: 'I', pct: 40 },
  { label: 'V', pct: 30 },
  { label: 'IV', pct: 10 },
]);
assert.deepEqual(topChords(prof, 'minor'), []);
assert.deepEqual(cadenceShares(prof).slice(0, 2), [
  { label: 'Perfect authentic', pct: 50 },
  { label: 'Half', pct: 20 },
]);
assert.deepEqual(cadenceShares(prof).at(-1), { label: 'Other', pct: 10 });
assert.equal(harmonicRhythmText(prof), '2.25 chords a bar, 0.56 a pulse');

// ── flags ───────────────────────────────────────────────────────────────────
const flag = (rule: VoiceLeadingFlag['rule'], bar: number, beat: number, tick = 0): VoiceLeadingFlag => ({
  bar,
  beat,
  tick,
  parts: ['Soprano', 'Alto'],
  rule,
  message: 'm',
});
const flags = [flag('parallel_fifths', 0, 1), flag('spacing', 1, 2), flag('parallel_fifths', 2, 1)];
assert.deepEqual(countByRule(flags), [
  { rule: 'parallel_fifths', label: 'Parallel fifths', count: 2 },
  { rule: 'spacing', label: 'Spacing', count: 1 },
]);
assert.equal(ruleLabel('unresolved_leading_tone'), 'Unresolved leading tone');
assert.equal(flagPlace(flag('range', 0, 1)), 'Bar 1, beat 1', 'bar 0 is the first bar');
assert.equal(flagPlace(flag('range', -1, 2)), 'Pickup, beat 2');
const rollNotes = [
  { id: 'a', note: 60, step: 0, length: 4, tick: 0, ticks: 960 },
  { id: 'b', note: 64, step: 4, length: 4, tick: 960, ticks: 960 },
  { id: 'c', note: 67, step: 0, length: 8 },
];
assert.deepEqual(notesSoundingAt(rollNotes, 960), ['b', 'c'], 'held notes sound; ended ones do not');
assert.deepEqual(notesSoundingAt(rollNotes, 0), ['a', 'c']);

// ── status: a dot's tone, one word, the sentence ────────────────────────────
assert.deepEqual(doneStatus('ok'), { tone: 'ok', word: 'Done', message: 'ok' });
assert.equal(doneStatus('ok', 3).word, 'Flagged');
assert.deepEqual(errorStatus('Write', new ApiError('no path of pivot chords from C major to F# major', 422)), {
  tone: 'error',
  word: 'Refused',
  message: 'Write: no path of pivot chords from C major to F# major',
});
assert.equal(errorStatus('Profile', new ApiError("no corpus piece 'x'", 404)).word, 'Missing');
assert.equal(errorStatus('Plan', new ApiError('backend down', 502)).word, 'Error');
assert.deepEqual(errorStatus('Species', new ComposeInputError('the selected part needs at least two notes to be a cantus')), {
  tone: 'warn',
  word: 'Check',
  message: 'Species: the selected part needs at least two notes to be a cantus',
});
assert.equal(errorStatus('Check', new Error('boom')).message, 'Check: boom');
assert.equal(errorStatus('Check', 'plain').message, 'Check: plain');

// ── small helpers ───────────────────────────────────────────────────────────
assert.equal(clampInt('12', 1, 10, 5), 10);
assert.equal(clampInt('', 1, 10, 5), 5);
assert.equal(clampInt(3.6, 1, 10, 5), 4);
assert.equal(clampInt(Number.NaN, 1, 10, 5), 5);
assert.equal(rerollSeed(() => 0.5), 500000);

console.log('composerPanelModel tests passed');
