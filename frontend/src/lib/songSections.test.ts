/**
 * lib/songSections: a song's sections on their way into EDIT and the roll.
 *
 * The sequence the app runs: the finder's document, then "Add section
 * markers" on a clip that was moved and trimmed (a marker at the timeline
 * second the clip plays each section start, the starts outside the clip left
 * out, a split hands the markers past the seam to the right half), then FORM
 * on the roll (a section marker at the nearest bar line through the roll's
 * clock, replacing the last FORM's and keeping the user's own) and the HARMONY
 * row from the song's chord track (a repeat and a no-chord span left out).
 * Run from `frontend/`:
 *   npx tsx src/lib/songSections.test.ts
 */
import assert from 'node:assert/strict';
import { PPQ, ROLL_STEPS_PER_BEAT } from './noteClock';
import { splitClipTimelineMarkers, withClipSectionMarkers, withFormMarkers } from './rollMarkers';
import { stepClock } from './rollTempo';
import { chordTrackHarmony, sectionEditMarkerId, sectionEditMarkers, sectionRollMarkers, type SongSection } from './songSections';

const section = (index: number, start_sec: number, end_sec: number, letter: string, name: string): SongSection => ({
  index,
  start_sec,
  end_sec,
  start_bar: start_sec / 2,
  bars: (end_sec - start_sec) / 2,
  letter,
  role: 'verse',
  name,
  confidence: 0.8,
  repeat_of: null,
  similarity: 0,
  energy: 0.5,
  stems: {},
});

// A 64 s song at 120 BPM (2 s bars): intro 0-16, verse 16-32, chorus 32-48, verse 48-64.
const sections = [section(0, 0, 16, 'A', 'Intro'), section(1, 16, 32, 'B', 'Verse'), section(2, 32, 48, 'C', 'Chorus'), section(3, 48, 64, "B'", 'Verse 2')];

// ── EDIT ─────────────────────────────────────────────────────────────────────
// The clip sits at 10 s on the timeline, trimmed 20 s into the song, 30 s long:
// it plays song seconds 20..50, so the verse start (16 s) is before its trim,
// the chorus (32 s) lands at 10 + 12 = 22 s and the last verse (48 s) at 38 s.
const clip = { id: 'clip1', startSec: 10, offsetIntoSource: 20, durationSec: 30, sourceDuration: 64, rate: 1 };
const placed = sectionEditMarkers(sections, clip, 64);
assert.deepEqual(
  placed.map((m) => [m.id, m.t, m.label]),
  [
    [sectionEditMarkerId('clip1', 2), 22, 'Chorus'],
    [sectionEditMarkerId('clip1', 3), 38, 'Verse 2'],
  ],
  'a marker at the timeline second the clip plays each section start inside its window',
);
// A clip stretched to half speed (2 audio seconds per timeline second... rate 2 = audio runs twice as fast).
assert.deepEqual(
  sectionEditMarkers(sections, { ...clip, rate: 2, durationSec: 15 }, 64).map((m) => m.t),
  [16, 24],
  'a stretched clip places the marks through its rate',
);
// A whole clip of the song at 0: every section start; a second add replaces the first.
const whole = sectionEditMarkers(sections, { id: 'clip1', startSec: 0, offsetIntoSource: 0, durationSec: 64, sourceDuration: 64, rate: 1 }, 64);
assert.deepEqual(whole.map((m) => m.t), [0, 16, 32, 48]);
const user = { id: 'user-1', t: 5, label: 'mine' };
const once = withClipSectionMarkers([user, ...placed], 'clip1', whole);
assert.deepEqual(
  once.map((m) => m.id),
  [sectionEditMarkerId('clip1', 0), 'user-1', sectionEditMarkerId('clip1', 1), sectionEditMarkerId('clip1', 2), sectionEditMarkerId('clip1', 3)],
  'the last add is replaced, the user marker stays, all in time order',
);
// A split at 40 s hands the markers past the seam to the right half under the same prefix.
const split = splitClipTimelineMarkers(once, 'clip1', 'clip1b', 40);
assert.deepEqual(
  split.filter((m) => m.id.startsWith('sect:')).map((m) => m.id),
  [sectionEditMarkerId('clip1', 0), sectionEditMarkerId('clip1', 1), sectionEditMarkerId('clip1', 2), sectionEditMarkerId('clip1b', 3)],
  'the section marker past the seam belongs to the right half',
);

// ── the roll ─────────────────────────────────────────────────────────────────
// The roll at 120 BPM in 4/4: a bar is 16 steps, so bar lines every 16 steps.
const clock = stepClock(120, null);
const lines = Array.from({ length: 40 }, (_, i) => i * 16);
const form = sectionRollMarkers(sections, clock, lines);
assert.deepEqual(
  form.map((m) => [m.id, m.tick / (PPQ / ROLL_STEPS_PER_BEAT), m.name, m.kind, m.origin]),
  [
    ['section-0', 0, 'Intro', 'section', 'form'],
    ['section-1', 128, 'Verse', 'section', 'form'],
    ['section-2', 256, 'Chorus', 'section', 'form'],
    ['section-3', 384, 'Verse 2', 'section', 'form'],
  ],
  'one section marker per section at the bar line where it starts on the roll',
);
// A section starting 0.3 s off a bar line snaps to the nearest line.
assert.equal(sectionRollMarkers([section(0, 16.3, 32, 'A', 'x')], clock, lines)[0].tick / (PPQ / ROLL_STEPS_PER_BEAT), 128);
// A rebuild replaces the last FORM's markers and keeps the user's own.
const mine = { id: 'm1', tick: 40 * (PPQ / ROLL_STEPS_PER_BEAT), name: 'Solo', kind: 'section' as const };
const again = withFormMarkers([mine, ...form], sectionRollMarkers(sections.slice(0, 2), clock, lines));
assert.deepEqual(again.map((m) => m.id), ['section-0', 'm1', 'section-1'], 'the user marker stays, the last FORM markers go');

// ── the HARMONY row ──────────────────────────────────────────────────────────
const harmony = chordTrackHarmony(
  [
    { startSec: 0, symbol: 'Fm', roman: 'i', romanKey: 'F minor' },
    { startSec: 2, symbol: 'Fm' },
    { startSec: 4, symbol: 'N.C.' },
    { startSec: 6, symbol: 'C7', roman: 'V7', romanKey: 'F minor' },
    { startSec: 8, symbol: '' },
  ],
  clock,
);
assert.deepEqual(
  harmony,
  [
    { tick: 0, figure: 'Fm', key: 'F minor', roman: 'i' },
    { tick: 6 / (60 / 120 / 4) * (PPQ / ROLL_STEPS_PER_BEAT), figure: 'C7', key: 'F minor', roman: 'V7' },
  ],
  'each chord symbol at its tick, a repeat and a no-chord span left out',
);

console.log('songSections: EDIT markers where the clip plays each section, FORM markers on the roll bar lines, the HARMONY row from the chord track');
