/**
 * node:assert regression for the highway schedule math and the notechart
 * mirror. Run from `frontend/`:
 *
 *   npx tsx src/components/layout/score/highway/schedule.test.ts
 *
 * The fixture is a tiny hand-built `gantasmo.notechart`: two pitched parts
 * (six events between them: one rest, one grace, one tie 'stop', Beat Saber
 * candidates at difficulties 0/1/2) and one percussion part carrying
 * `drumVoice` values. No network, no DOM.
 */
import assert from 'node:assert/strict';

import {
  beatsFromSeconds,
  blankChartEvent,
  hasBeatSaberFields,
  isHitBearing,
  NOTEHEAD_BLACK_CODEPOINT,
  NOTEHEAD_CIRCLE_X_CODEPOINT,
  NOTEHEAD_X_CODEPOINT,
  secondsFromBeats,
  type ChartEvent,
  type ChartPart,
  type NoteChart,
  type TempoEntry,
} from '../../../../lib/notechart.ts';
import { defaultPartVisibility, partsForInstrument } from '../../../../state/playAlongStore.ts';
import {
  BLOCK_PITCH,
  buildSchedule,
  codepointsOf,
  DRUM_LANE_COUNT,
  DRUM_PAD_SPACING,
  laneForVoice,
  laneX,
  windowFor,
  zForTime,
} from './schedule.ts';

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/** Every key `exporters/notechart.py::_blank_event()` writes, in order, plus
 *  the additive Beat Saber and drum fields. Guards the TS mirror against
 *  drifting from the Python builder. */
const PYTHON_BLANK_EVENT_KEYS = [
  'id',
  'isRest',
  'onsetSec',
  'onsetSecRaw',
  'onsetBeats',
  'onsetBeatsRaw',
  'onsetTicks',
  'durationSec',
  'durationSecRaw',
  'durationBeats',
  'durationTicks',
  'measure',
  'beatInMeasure',
  'voice',
  'staff',
  'midi',
  'velocity',
  'step',
  'octave',
  'alter',
  'accidental',
  'accidentalIsCautionary',
  'diatonicNoteNum',
  'staffStep',
  'ledgerLines',
  'ledgerBelow',
  'noteType',
  'dots',
  'isTuplet',
  'tupletActual',
  'tupletNormal',
  'tupletBracket',
  'isGrace',
  'tie',
  'beam',
  'beamDepth',
  'stemDirection',
  'chordId',
  'isChordRoot',
  'glyph',
  'glyphCodepoint',
  'noteheadGlyph',
  'noteheadCodepoint',
  'flagGlyph',
  'flagCodepoint',
  'accidentalGlyph',
  'accidentalCodepoint',
  'dotGlyph',
  'dotCodepoint',
];
const ADDITIVE_EVENT_KEYS = ['bsLine', 'bsLayer', 'bsColor', 'bsCut', 'bsMinDifficulty', 'drumVoice'];

const TEMPO: TempoEntry[] = [
  { timeSec: 0, timeBeats: 0, timeTicks: 0, bpm: 120, secPerBeat: 0.5, measure: 0, interpolateToNext: false },
  { timeSec: 4, timeBeats: 8, timeTicks: 3840, bpm: 60, secPerBeat: 1, measure: 0, interpolateToNext: false },
];

let nextId = 1;
function ev(overrides: Partial<ChartEvent>): ChartEvent {
  const base = blankChartEvent();
  const onsetSec = overrides.onsetSec ?? 0;
  return {
    ...base,
    id: nextId++,
    onsetSecRaw: onsetSec,
    onsetBeats: beatsFromSeconds(TEMPO, onsetSec),
    onsetBeatsRaw: beatsFromSeconds(TEMPO, onsetSec),
    durationSec: 0.5,
    durationSecRaw: 0.5,
    durationBeats: 1,
    durationTicks: 480,
    noteType: 'quarter',
    ...overrides,
  };
}

function part(index: number, name: string, events: ChartEvent[], isPercussion = false): ChartPart {
  return {
    index,
    id: `P${index + 1}`,
    name,
    abbreviation: name.slice(0, 3),
    instrumentName: isPercussion ? 'Percussion' : name,
    midiProgram: isPercussion ? -1 : 0,
    midiChannel: isPercussion ? 10 : 1,
    staffCount: 1,
    isPercussion,
    transposeSemitones: 0,
    clefs: [
      {
        measure: 1,
        staff: 1,
        timeSec: 0,
        timeBeats: 0,
        sign: isPercussion ? 'percussion' : 'G',
        line: 2,
        octaveChange: 0,
        lowestLineDiatonic: 31,
        glyph: isPercussion ? 'unpitchedPercussionClef1' : 'gClef',
        glyphCodepoint: isPercussion ? 0xe069 : 0xe050,
      },
    ],
    events,
  };
}

// Part 0 (lead): a candidate at every difficulty, one grace, one tie stop.
const LEAD: ChartEvent[] = [
  ev({
    onsetSec: 0,
    onsetSecRaw: 0.02,
    midi: 60,
    step: 'C',
    octave: 4,
    staffStep: -2,
    glyph: 'noteQuarterUp',
    glyphCodepoint: 0xe1d5,
    noteheadGlyph: 'noteheadBlack',
    noteheadCodepoint: NOTEHEAD_BLACK_CODEPOINT,
    bsLine: 1,
    bsLayer: 0,
    bsColor: 0,
    bsCut: 1,
    bsMinDifficulty: 0,
  }),
  ev({
    onsetSec: 1.5,
    onsetSecRaw: 1.47,
    midi: 64,
    step: 'E',
    octave: 4,
    staffStep: 0,
    isGrace: true,
    noteType: 'eighth',
    glyph: 'noteEighthUp',
    glyphCodepoint: 0xe1d7,
    noteheadCodepoint: NOTEHEAD_BLACK_CODEPOINT,
    bsMinDifficulty: -1,
  }),
  ev({
    onsetSec: 1,
    onsetSecRaw: 1.01,
    midi: 67,
    step: 'G',
    octave: 4,
    staffStep: 2,
    tie: 'start',
    glyph: 'noteQuarterUp',
    glyphCodepoint: 0xe1d5,
    noteheadCodepoint: NOTEHEAD_BLACK_CODEPOINT,
    bsLine: 2,
    bsLayer: 1,
    bsColor: 1,
    bsCut: 0,
    bsMinDifficulty: 1,
  }),
  ev({
    onsetSec: 2,
    onsetSecRaw: 2.03,
    midi: 67,
    step: 'G',
    octave: 4,
    staffStep: 2,
    tie: 'stop',
    glyph: 'noteQuarterUp',
    glyphCodepoint: 0xe1d5,
    noteheadCodepoint: NOTEHEAD_BLACK_CODEPOINT,
    bsMinDifficulty: -1,
  }),
];

// Part 1 (bass): one rest and one Expert-only candidate on staff 1.
const BASS: ChartEvent[] = [
  ev({
    onsetSec: 0.5,
    isRest: true,
    glyph: 'restQuarter',
    glyphCodepoint: 0xe4e5,
    bsMinDifficulty: -1,
  }),
  ev({
    onsetSec: 3,
    onsetSecRaw: 2.96,
    midi: 43,
    step: 'G',
    octave: 2,
    staffStep: 1,
    glyph: 'noteQuarterUp',
    glyphCodepoint: 0xe1d5,
    noteheadCodepoint: NOTEHEAD_BLACK_CODEPOINT,
    bsLine: 3,
    bsLayer: 2,
    bsColor: 0,
    bsCut: 8,
    bsMinDifficulty: 2,
  }),
];

// Part 2 (drums): kick, open hi-hat, snare, plus an unpitched event with no
// voice (must be dropped by the drums skin) and a pitched-looking event.
const DRUMS: ChartEvent[] = [
  ev({
    onsetSec: 0,
    midi: 36,
    step: 'F',
    octave: 4,
    staffStep: 1,
    glyphCodepoint: 0xe1d5,
    noteheadCodepoint: NOTEHEAD_BLACK_CODEPOINT,
    drumVoice: 'kick',
  }),
  ev({
    onsetSec: 0.25,
    midi: 46,
    step: 'G',
    octave: 5,
    staffStep: 9,
    noteheadGlyph: 'noteheadCircleX',
    noteheadCodepoint: NOTEHEAD_CIRCLE_X_CODEPOINT,
    drumVoice: 'hihat',
  }),
  ev({
    onsetSec: 0.5,
    midi: 38,
    step: 'C',
    octave: 5,
    staffStep: 5,
    noteheadCodepoint: NOTEHEAD_BLACK_CODEPOINT,
    drumVoice: 'snare',
  }),
  ev({
    onsetSec: 0.75,
    midi: 42,
    step: 'G',
    octave: 5,
    staffStep: 9,
    noteheadGlyph: 'noteheadXBlack',
    noteheadCodepoint: NOTEHEAD_X_CODEPOINT,
    drumVoice: 'hihat',
  }),
  ev({
    onsetSec: 1,
    midi: 0,
    staffStep: 4,
    noteheadCodepoint: NOTEHEAD_BLACK_CODEPOINT,
    drumVoice: '',
  }),
];

function makeChart(rawIsQuantized: boolean, parts: ChartPart[]): NoteChart {
  return {
    schema: 'gantasmo.notechart',
    schemaVersion: 1,
    generator: 'schedule.test.ts',
    generatedAtUtc: '2026-09-04T00:00:00Z',
    source: {
      entryId: 'entry',
      sourceArtifactId: 'entry__sheet',
      sourcePath: 'sheet.musicxml',
      sourceFormat: 'musicxml',
      rawMidiArtifactId: rawIsQuantized ? '' : 'entry__midi',
      title: 'Fixture',
      artist: '',
      composer: '',
    },
    audio: { url: '', filename: '', mimeType: '', sampleRate: 44100, durationSec: 6 },
    timing: {
      beatUnit: 'quarter',
      ticksPerQuarter: 480,
      durationSec: 6,
      durationBeats: 10,
      totalMeasures: 2,
      pickupBeats: 0,
      audioOffsetSec: 0,
    },
    quantization: {
      gridDivisionsPerQuarter: 4,
      gridLabel: '1/16',
      gridSeconds: 0.125,
      tripletsAllowed: true,
      engine: 'source',
      rawIsQuantized,
      rawSource: rawIsQuantized ? '' : 'midi:entry__midi',
      matchedRawEvents: rawIsQuantized ? 0 : 4,
      unmatchedRawEvents: 0,
      maxRawDeviationSec: rawIsQuantized ? 0 : 0.04,
      meanAbsRawDeviationSec: rawIsQuantized ? 0 : 0.025,
    },
    tempoMap: TEMPO,
    timeSignatureMap: [],
    keySignatureMap: [],
    measures: [
      {
        number: 1,
        timeSec: 0,
        timeBeats: 0,
        durationBeats: 4,
        isPickup: false,
        barlineGlyph: 'barlineSingle',
        barlineCodepoint: 0xe030,
        startsRepeat: false,
        endsRepeat: false,
      },
      {
        number: 2,
        timeSec: 2,
        timeBeats: 4,
        durationBeats: 4,
        isPickup: false,
        barlineGlyph: 'barlineFinal',
        barlineCodepoint: 0xe032,
        startsRepeat: false,
        endsRepeat: false,
      },
    ],
    parts,
    stats: {
      partCount: parts.length,
      noteCount: 10,
      restCount: 1,
      chordCount: 0,
      tupletCount: 0,
      graceCount: 1,
      tiedCount: 1,
      measureCount: 2,
      clampedDurations: 0,
      densityNotesPerSec: 10 / 6,
      maxSimultaneous: 2,
      meanAbsRawDeviationSec: 0,
      beatSaberCandidates: 3,
    },
  };
}

const PITCHED_PARTS = [part(0, 'Lead', LEAD), part(1, 'Bass', BASS)];
const ALL_PARTS = [...PITCHED_PARTS, part(2, 'Drums', DRUMS, true)];
const chartRaw = makeChart(false, ALL_PARTS);
const chartQuantized = makeChart(true, ALL_PARTS);

const isSorted = (times: number[]): boolean => times.every((t, i) => i === 0 || times[i - 1] <= t);
const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ---------------------------------------------------------------------------
// notechart mirror
// ---------------------------------------------------------------------------

{
  const keys = Object.keys(blankChartEvent());
  assert.deepEqual(
    keys,
    [...PYTHON_BLANK_EVENT_KEYS, ...ADDITIVE_EVENT_KEYS],
    'blankChartEvent must mirror _blank_event() field-for-field, then the additive fields',
  );
  const blank = blankChartEvent();
  assert.equal(blank.staffStep, 4, 'rests sit on REST_STAFF_STEP');
  assert.equal(blank.chordId, -1);
  assert.equal(blank.noteType, 'quarter');
  assert.equal(blank.bsCut, 8, 'BS_DEFAULTS.bsCut is "any"');
  assert.equal(blank.bsMinDifficulty, -1, 'BS_DEFAULTS.bsMinDifficulty is "never"');
  assert.equal(blank.drumVoice, '');
  for (const [k, v] of Object.entries(blank)) assert.notEqual(v, null, `${k} must never be null`);
}

{
  // Piecewise tempo arithmetic: 120 BPM for 8 beats (4 s), then 60 BPM.
  near(secondsFromBeats(TEMPO, 0), 0);
  near(secondsFromBeats(TEMPO, 4), 2);
  near(secondsFromBeats(TEMPO, 8), 4);
  near(secondsFromBeats(TEMPO, 10), 6);
  near(beatsFromSeconds(TEMPO, 6), 10);
  near(beatsFromSeconds(TEMPO, 3), 6);
  for (const b of [0, 1.25, 7.999, 8, 9.5, 20]) near(beatsFromSeconds(TEMPO, secondsFromBeats(TEMPO, b)), b);
  near(secondsFromBeats([], 4), 2, 1e-9);
  near(beatsFromSeconds([], 2), 4, 1e-9);
  // Before the first entry (negative beats) the first tempo carries backwards,
  // exactly like Python's max(0, bisect_right - 1).
  near(secondsFromBeats(TEMPO, -2), -1);
}

{
  assert.equal(isHitBearing(LEAD[0]), true);
  assert.equal(isHitBearing(LEAD[1]), false, 'grace notes are not hit-bearing');
  assert.equal(isHitBearing(LEAD[2]), true, 'tie start is hit-bearing');
  assert.equal(isHitBearing(LEAD[3]), false, 'tie stop is not hit-bearing');
  assert.equal(isHitBearing(BASS[0]), false, 'rests are not hit-bearing');
  assert.equal(isHitBearing(ev({ tupletBracket: 'irrational', midi: 60 })), false);
  assert.equal(hasBeatSaberFields(chartRaw), true);
  const legacy = makeChart(true, [
    part(0, 'Lead', [ev({ isRest: true }), { ...ev({ midi: 60 }), bsMinDifficulty: undefined }]),
  ]);
  assert.equal(hasBeatSaberFields(legacy), false, 'a pre-Beat-Saber chart is detected on its first non-rest event');
  assert.equal(hasBeatSaberFields(makeChart(true, [])), false);
}

// ---------------------------------------------------------------------------
// notation skin
// ---------------------------------------------------------------------------

{
  const s = buildSchedule(chartRaw, [true, true, false], { skin: 'notation', difficulty: 1 });
  const times = s.items.map((i) => i.hitTime);
  assert.ok(isSorted(times), 'items sorted by hitTime');
  // 4 lead events minus the grace + 2 bass events = 5.
  assert.equal(s.items.length, 5);
  assert.ok(!s.items.some((i) => i.eventRef[0] === 0 && i.eventRef[1] === 1), 'grace absent');
  const rest = s.items.find((i) => i.eventRef[0] === 1 && i.eventRef[1] === 0);
  assert.ok(rest, 'rest present');
  assert.equal(rest.color, 1, 'rest is dimmed');
  assert.equal(rest.codepoint, 0xe4e5, 'rest draws its own glyph');
  assert.equal(rest.judgeable, false);
  near(rest.y, 4 * 0.06, 1e-9);
  const tieStop = s.items.find((i) => i.eventRef[0] === 0 && i.eventRef[1] === 3);
  assert.ok(tieStop);
  assert.equal(tieStop.judgeable, false, 'tie stop not judgeable');
  const tieStart = s.items.find((i) => i.eventRef[0] === 0 && i.eventRef[1] === 2);
  assert.ok(tieStart);
  assert.equal(tieStart.judgeable, true);
  assert.equal(s.hitCount, 3, 'lead C, lead G(start), bass G');
  // Two lanes centred: lead at -0.6, bass at +0.6.
  for (const i of s.items) near(i.x, i.eventRef[0] === 0 ? -0.6 : 0.6);
  // Notation hitTime is the quantised onset, never the raw one.
  const leadC = s.items.find((i) => i.eventRef[0] === 0 && i.eventRef[1] === 0);
  assert.ok(leadC);
  assert.equal(leadC.hitTime, 0);
  near(leadC.y, -2 * 0.06);
  assert.equal(leadC.codepoint, 0xe1d5, 'glyphCodepoint wins over noteheadCodepoint');
  assert.deepEqual(s.bars, [0, 2]);
  assert.deepEqual([...codepointsOf(s)].sort(), [0xe1d5, 0xe4e5]);
}

{
  // Hidden part: no items from it, and the remaining lane is centred at x 0.
  const s = buildSchedule(chartRaw, [true, false, false], { skin: 'notation', difficulty: 1 });
  assert.equal(s.items.length, 3);
  assert.ok(s.items.every((i) => i.eventRef[0] === 0));
  for (const i of s.items) assert.equal(i.x, 0);
}

{
  // A short visibility array means "visible"; staff 2 drops; layout override.
  const grand = makeChart(true, [
    part(0, 'Piano', [
      ev({ onsetSec: 0, midi: 60, staffStep: 0, staff: 1, glyphCodepoint: 0xe1d5 }),
      ev({ onsetSec: 0, midi: 48, staffStep: 0, staff: 2, glyphCodepoint: 0xe1d5 }),
    ]),
  ]);
  const s = buildSchedule(grand, [], { skin: 'notation', difficulty: 0, layout: { staffDrop: 1 } });
  assert.equal(s.items.length, 2);
  const [upper, lower] = s.items;
  assert.equal(upper.y, 0);
  assert.equal(lower.y, -1);
  // Codepoint falls back to noteheadBlack when the chart gives nothing.
  const bare = buildSchedule(makeChart(true, [part(0, 'X', [ev({ midi: 60 })])]), [true], {
    skin: 'notation',
    difficulty: 0,
  });
  assert.equal(bare.items[0].codepoint, NOTEHEAD_BLACK_CODEPOINT);
  assert.equal(NOTEHEAD_BLACK_CODEPOINT, 57508);
  // A visible percussion part keeps its glyphs in the notation skin, coloured 2.
  const mixed = buildSchedule(chartRaw, [false, false, true], { skin: 'notation', difficulty: 0 });
  assert.equal(mixed.items.length, DRUMS.length);
  assert.ok(mixed.items.every((i) => i.color === 2));
  assert.ok(mixed.items.every((i) => i.x === 0));
}

// ---------------------------------------------------------------------------
// blocks skin
// ---------------------------------------------------------------------------

{
  const at = (level: number) => buildSchedule(chartRaw, [true, true, true], { skin: 'blocks', difficulty: level });
  const easy = at(0);
  assert.equal(easy.items.length, 1, 'difficulty 0 -> only bsMinDifficulty 0');
  assert.deepEqual(easy.items[0].eventRef, [0, 0]);
  assert.deepEqual(easy.items[0].block, { line: 1, layer: 0, color: 0, cut: 1 });
  near(easy.items[0].x, (1 - 1.5) * BLOCK_PITCH);
  assert.equal(easy.items[0].y, 0);
  assert.equal(easy.items[0].hitTime, 0.02, 'blocks use onsetSecRaw when raw timing exists');
  assert.equal(easy.items[0].judgeable, true);

  const normal = at(1);
  const hard = at(2);
  const expertPlus = at(4);
  assert.equal(normal.items.length, 2);
  assert.equal(hard.items.length, 3);
  assert.equal(expertPlus.items.length, 3, 'difficulty above the top candidate adds nothing');
  const refs = (s: ReturnType<typeof at>) => s.items.map((i) => i.eventRef.join(':'));
  for (const r of refs(easy)) assert.ok(refs(normal).includes(r), 'normal ⊇ easy');
  for (const r of refs(normal)) assert.ok(refs(hard).includes(r), 'hard ⊇ normal');
  assert.ok(isSorted(hard.items.map((i) => i.hitTime)));
  assert.ok(!hard.items.some((i) => i.eventRef[0] === 2), 'percussion never appears in the blocks skin');
  assert.ok(!hard.items.some((i) => i.eventRef[0] === 1 && i.eventRef[1] === 0), 'rests never appear');
  const bassG = hard.items.find((i) => i.eventRef[0] === 1);
  assert.ok(bassG);
  near(bassG.x, (3 - 1.5) * BLOCK_PITCH);
  near(bassG.y, 2 * BLOCK_PITCH);
  assert.equal(bassG.hitTime, 2.96);
  assert.equal(hard.hitCount, 3);

  // Quantised chart: raw onsets are meaningless, hitTime falls back to onsetSec.
  const q = buildSchedule(chartQuantized, [true, true, true], { skin: 'blocks', difficulty: 4 });
  assert.deepEqual(
    q.items.map((i) => i.hitTime),
    [0, 1, 3],
  );
  // Hidden pitched part is excluded; out-of-range difficulty is clamped.
  assert.equal(buildSchedule(chartRaw, [true, false, true], { skin: 'blocks', difficulty: 9 }).items.length, 2);
  assert.equal(buildSchedule(chartRaw, [true, true], { skin: 'blocks', difficulty: -3 }).items.length, 1);
}

// ---------------------------------------------------------------------------
// drums skin
// ---------------------------------------------------------------------------

{
  assert.equal(laneForVoice('kick'), 0);
  assert.equal(laneForVoice('snare'), 1);
  assert.equal(laneForVoice('perc'), 1);
  assert.equal(laneForVoice('hihat'), 2);
  assert.equal(laneForVoice('tom'), 3);
  assert.equal(laneForVoice('crash'), 4);
  assert.equal(laneForVoice('ride'), 4);
  assert.equal(laneForVoice(''), -1);
  assert.equal(laneForVoice('cowbell'), -1);
  assert.equal(DRUM_LANE_COUNT, 5);

  const s = buildSchedule(chartRaw, [true, true, true], { skin: 'drums', difficulty: 0 });
  assert.equal(s.items.length, 4, 'kick, open hat, snare, closed hat; the voiceless event and every pitched part drop');
  assert.ok(s.items.every((i) => i.eventRef[0] === 2), 'pitched parts are excluded');
  assert.ok(s.items.every((i) => i.color === 2));
  assert.ok(isSorted(s.items.map((i) => i.hitTime)));

  const kick = s.items[0];
  assert.equal(kick.drum?.voice, 'kick');
  assert.equal(kick.drum?.lane, 0, 'kick on lane 0');
  assert.equal(kick.x, 0, 'the kick bar spans the highway, so it is centred');
  assert.equal(kick.y, 0);
  assert.equal(kick.judgeable, true);

  const openHat = s.items[1];
  assert.equal(openHat.drum?.voice, 'hihat');
  assert.equal(openHat.drum?.lane, 2, 'hi-hat on lane 2');
  assert.equal(openHat.drum?.open, true, 'circle-x head / MIDI 46 is an open hat');
  near(openHat.x, laneX(1, DRUM_LANE_COUNT - 1, DRUM_PAD_SPACING));

  const snare = s.items[2];
  assert.equal(snare.drum?.lane, 1);
  near(snare.x, laneX(0, DRUM_LANE_COUNT - 1, DRUM_PAD_SPACING));

  const closedHat = s.items[3];
  assert.equal(closedHat.drum?.lane, 2);
  assert.equal(closedHat.drum?.open, false);
  assert.equal(closedHat.codepoint, NOTEHEAD_X_CODEPOINT);

  // The four pad lanes are centred as a group around the kick bar.
  const padXs = [1, 2, 3, 4].map((lane) => laneX(lane - 1, DRUM_LANE_COUNT - 1, DRUM_PAD_SPACING));
  near(padXs.reduce((a, b) => a + b, 0), 0);

  // Hiding the percussion part empties the drum highway.
  assert.equal(buildSchedule(chartRaw, [true, true, false], { skin: 'drums', difficulty: 0 }).items.length, 0);
}

{
  // Instrument presets (playAlongStore) pick the right parts for a chart.
  const parts = ALL_PARTS.map((p) => ({ name: p.name, isPercussion: p.isPercussion }));
  assert.deepEqual(partsForInstrument('drums', parts), [false, false, true], 'drums selects only the percussion part');
  assert.deepEqual(partsForInstrument('bass', parts), [false, true, false]);
  assert.deepEqual(partsForInstrument('all', parts), [true, true, true]);
  const withFull = [{ name: 'full' }, { name: 'drums', isPercussion: true }, { name: 'bass' }];
  assert.deepEqual(partsForInstrument('all', withFull), [false, true, true], "'all' hides 'full' when other parts exist");
  assert.deepEqual(defaultPartVisibility(withFull), [false, true, true]);
  assert.deepEqual(defaultPartVisibility([{ name: 'full' }]), [true], 'a lone full part stays visible');
  assert.deepEqual(partsForInstrument('drums', [{ name: 'Drum Kit' }, { name: 'Bass' }]), [true, false], 'name match');
  assert.deepEqual(partsForInstrument('strings', withFull), [false, true, true], 'no match -> the default');
}

// ---------------------------------------------------------------------------
// window / geometry helpers
// ---------------------------------------------------------------------------

{
  const s = buildSchedule(chartRaw, [true, true, false], { skin: 'notation', difficulty: 1 });
  // hitTimes: 0, 0.5, 1, 2, 3
  assert.deepEqual(windowFor(s, 1, 1, 0.5), [1, 4], 'inclusive both ends: 0.5, 1, 2');
  assert.deepEqual(windowFor(s, 0, 0.25, 0), [0, 1]);
  assert.deepEqual(windowFor(s, 10, 1, 1), [5, 5], 'past the end: empty range at length');
  assert.deepEqual(windowFor(s, -10, 1, 1), [0, 0], 'before the start: empty range at 0');
  assert.deepEqual(windowFor(s, 1.5, 100, 100), [0, 5]);
  const empty = buildSchedule(makeChart(true, []), [], { skin: 'notation', difficulty: 0 });
  assert.deepEqual(windowFor(empty, 0, 1, 1), [0, 0]);
  assert.deepEqual(empty.bars, [0, 2]);
  assert.equal(empty.hitCount, 0);
}

{
  assert.equal(zForTime(5, 3, 8), -16);
  near(zForTime(3, 3, 8), 0); // on the hit line (-0 is fine for a position)
  assert.equal(zForTime(2, 3, 8), 8, 'already past');
  near(laneX(0, 3, 1.2), -1.2);
  near(laneX(1, 3, 1.2), 0);
  near(laneX(2, 3, 1.2), 1.2);
  assert.equal(laneX(0, 1, 1.2), 0);
  near(laneX(0, 2, 1.2), -0.6);
}

console.log('highway schedule + notechart mirror regression passed');
