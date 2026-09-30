/**
 * An orchestral MIDI file's tempo and meter changes become the EDIT
 * arrangement's, and every surface that counts bars follows them.
 *
 * The sequence: a type-1 file with 24 parts, 4/4 x3 at 96 BPM, 7/8 3+2+2 x2 at
 * 72, 5/4 x3 at 132 is written (lib/midi encodeMidi) and read back
 * (parseMidi). Each part is dropped into EDIT the way addMidiClipFromBytes
 * drops a file (lib/rollClip midiFileClipFields, addClipToTrack, then
 * offerClipTimeMaps) and gets its own instrument. The offer banner's "Use its
 * tempo and meter" (adoptClipTimeMaps) is pressed. Then the arrangement's bar
 * lines, ruler, grid, snap, seek (editor_seek_bar), bar nudge
 * (editor_nudge_clip) and the transport click (metronomeStore's maps into
 * lib/metronome clicksInWindow) are each checked against the file's own bar
 * lines, integrated here from its ticks rather than by the app.
 *
 *   cd frontend && npx tsx src/lib/editTimeMap.orchestra.test.ts
 */
import assert from 'node:assert/strict';
import { encodeMidi, parseMidi, tempoMicros, tempoOfMicros, type MidiFileData, type MidiTrack } from './midi.ts';
import { midiFileClipFields } from './rollClip.ts';
import { stepClock } from './rollTempo.ts';
import { editBarStartSec, editGridLines, editRulerBars } from './editTimeMap.ts';
import { clicksInWindow } from './metronome.ts';
import { useEditorStore } from '../state/editorStore.ts';
import { editMeterMap, editTempoMap } from '../state/metronomeStore.ts';
import * as tools from '../state/editorTools.ts';

const PPQ = 480;
const PARTS = 24;
const PROGRAMS = [45, 45, 45, 45, 46, 46, 56, 56, 57, 58, 60, 60, 68, 69, 70, 71, 72, 73, 11, 12, 13, 9, 8, 0];
const BAR44 = PPQ * 4;
const BAR78 = (PPQ / 2) * 7;
const BAR54 = PPQ * 5;
const T78 = BAR44 * 3;
const T54 = T78 + BAR78 * 2;
const END = T54 + BAR54 * 3;
const tempos = [{ tick: 0, bpm: 96 }, { tick: T78, bpm: 72 }, { tick: T54, bpm: 132 }];
/** The tempo an FF 51 written for `bpm` holds: a whole number of microseconds a
 *  quarter, read back exactly (72 is 833333 us, 72.0000288 BPM). */
const heard = (bpm: number): number => tempoOfMicros(tempoMicros(bpm));
const timeSignatures = [{ tick: 0, num: 4, den: 4 }, { tick: T78, num: 7, den: 8, groups: [3, 2, 2] }, { tick: T54, num: 5, den: 4 }];

/** Seconds of `tick` under the file's tempos, integrated here rather than by the app. */
function tickSec(tick: number): number {
  let sec = 0;
  for (let i = 0; i < tempos.length; i += 1) {
    const from = tempos[i].tick;
    const to = i + 1 < tempos.length ? tempos[i + 1].tick : Infinity;
    if (tick <= from) break;
    sec += ((Math.min(tick, to) - from) / PPQ) * (60 / heard(tempos[i].bpm));
  }
  return sec;
}
/** The file's bar lines in ticks: 3 of 4/4, 2 of 7/8, 3 of 5/4, and the end. */
const BAR_TICKS = [0, BAR44, 2 * BAR44, T78, T78 + BAR78, T54, T54 + BAR54, T54 + 2 * BAR54, END];
const BAR_SEC = BAR_TICKS.map(tickSec);
const near = (a: number, b: number, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b}`);

const partTracks: MidiTrack[] = PROGRAMS.map((_, p) => {
  const notes = [];
  for (let tick = p * 23; tick + PPQ / 2 <= END; tick += PPQ * 2) notes.push({ tick, note: 60 + (p % 12), velocity: 100, durationTicks: PPQ / 2, channel: p % 16 === 9 ? 10 : p % 16 });
  return { name: `Part ${p + 1}`, notes };
});
const written: MidiFileData = { ppq: PPQ, bpm: 96, tracks: partTracks, tempos, timeSignatures };
const file = parseMidi(encodeMidi(written));
assert.equal(file.tracks.length, PARTS, 'the file reads back with its 24 parts');

// ── A fresh arrangement at 120 BPM in 4/4, and each part dropped onto its own track ──
const ed = () => useEditorStore.getState();
ed().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
ed().setTempoMap([{ beat: 0, bpm: 120 }]);
const firstTrack = ed().tracks[0].id;
const clipIds: string[] = [];
file.tracks.forEach((track, p) => {
  const trackId = p === 0 ? firstTrack : ed().addTrack({ name: track.name });
  const fields = midiFileClipFields({ ...file, tracks: [track] }, `p${p}`);
  const len = stepClock(fields.sourceBpm, fields.sourceTempoMap).at(fields.sourceTotalSteps);
  const clipId = ed().addClipToTrack({
    trackId, label: track.name, audioBlob: new Blob([], { type: 'audio/wav' }), mimeType: 'audio/wav',
    sourceDuration: len, offsetIntoSource: 0, durationSec: len, startSec: 0, color: '#a855f7', sourceKind: 'piano-roll', ...fields,
  });
  ed().updateTrack(trackId, { instrumentProgram: PROGRAMS[p] });
  // What addMidiClipFromBytes does after every drop.
  ed().offerClipTimeMaps(clipId);
  clipIds.push(clipId);
});

// Every part keeps its program and the file's maps.
file.tracks.forEach((_, p) => {
  const clip = ed().clips.find((c) => c.id === clipIds[p])!;
  const track = ed().tracks.find((t) => t.id === clip.trackId)!;
  assert.equal(track.instrumentProgram, PROGRAMS[p], `part ${p + 1} on its own instrument`);
  assert.deepEqual((clip.sourceTempoMap ?? []).map((e) => [e.beat, e.bpm]), [[0, heard(96)], [T78 / PPQ, heard(72)], [T54 / PPQ, heard(132)]]);
  assert.deepEqual((clip.sourceMeterMap ?? []).map((s) => `${s.bar}:${s.meter.num}/${s.meter.den}`), ['0:4/4', '3:7/8', '5:5/4']);
});

// ── The offer, and pressing "Use its tempo and meter" ───────────────────────
const offer = ed().timeMapOffer;
assert.ok(offer, 'a file in other meters and tempos is offered');
assert.equal(offer.summary, '4/4 then 7/8 3+2+2 then 5/4, 72-132 BPM');
assert.equal(offer.anchorSec, 0);
const res = ed().adoptClipTimeMaps(offer.clipId);
assert.ok(res.ok, res.error);
assert.deepEqual(ed().tempoMap.map((e) => [e.beat, e.bpm]), [[0, heard(96)], [12, heard(72)], [19, heard(132)]], 'the arrangement takes the file\'s tempo changes');
assert.deepEqual(ed().meterMap.map((s) => `${s.bar}:${s.meter.num}/${s.meter.den} ${s.meter.groups.join('+')}`), ['0:4/4 ', '3:7/8 3+2+2', '5:5/4 ']);
// Every other part now agrees with the arrangement: no offer is left for any of them.
for (const id of clipIds) {
  ed().offerClipTimeMaps(id);
  assert.equal(ed().timeMapOffer, null, 'no part differs from the arrangement');
}

// ── Bar lines, ruler and grid on the file's own bar lines ───────────────────
BAR_SEC.forEach((sec, bar) => near(editBarStartSec(ed(), bar), sec, 1e-9, `bar ${bar + 1}`));
assert.deepEqual(
  editRulerBars({ ...ed(), startSec: 0, endSec: BAR_SEC[8], zoom: 100 }).map((b) => b.bar),
  [1, 2, 3, 4, 5, 6, 7, 8, 9],
);
editRulerBars({ ...ed(), startSec: 0, endSec: BAR_SEC[8], zoom: 100 }).forEach((b) => near(b.sec, BAR_SEC[b.bar - 1], 1e-9, `ruler bar ${b.bar}`));
const barLines = editGridLines({ ...ed(), startSec: 0, endSec: BAR_SEC[8], zoom: 100 }).filter((l) => l.level === 'bar');
assert.equal(barLines.length, 9);
barLines.forEach((l, i) => near(l.sec, BAR_SEC[i], 1e-9, `grid bar ${i + 1}`));
// Inside a 7/8 bar the grid's beat tier is the file's 3+2+2 group starts.
const groupLines = editGridLines({ ...ed(), startSec: BAR_SEC[3], endSec: BAR_SEC[4] - 1e-6, zoom: 100 }).filter((l) => l.level === 'beat').map((l) => l.sec);
assert.deepEqual(groupLines.length, 2);
near(groupLines[0], tickSec(T78 + (PPQ / 2) * 3), 1e-9, 'group 2 of 3+2+2');
near(groupLines[1], tickSec(T78 + (PPQ / 2) * 5), 1e-9, 'group 3 of 3+2+2');

// ── Snap, seek and bar nudges ───────────────────────────────────────────────
ed().setSnap('1/4');
near(ed().snapSec(BAR_SEC[5] - 0.05), BAR_SEC[5], 1e-9, 'a quarter grid meets the 5/4 bar line after a 7/8 bar');
ed().setSnap('1/1');
near(ed().snapSec(BAR_SEC[4] + 0.2), BAR_SEC[4], 1e-9, 'Bar snaps to the 7/8 bar lines');
assert.ok(tools.seekBar({ bar: 6 }).ok);
near(ed().playheadSec, BAR_SEC[5], 1e-9, 'editor_seek_bar 6 lands on the first 5/4 bar');
ed().updateClip(clipIds[0], { startSec: BAR_SEC[2] });
assert.ok(tools.nudgeClip({ clip_id: clipIds[0], bars: 2 }).ok);
near(ed().clips.find((c) => c.id === clipIds[0])!.startSec, BAR_SEC[4], 1e-9, 'two bars on from bar 3 is the second 7/8 bar');
ed().updateClip(clipIds[0], { startSec: 0 });

// ── The transport click counts the file's bars ──────────────────────────────
const accents = clicksInWindow(editTempoMap(), editMeterMap(), 0, BAR_SEC[8] - 1e-6, { mode: 'group' }).filter((c) => c.accent);
assert.equal(accents.length, 8, 'one downbeat per bar');
accents.forEach((c, i) => near(c.sec, BAR_SEC[i], 1e-9, `click downbeat ${i + 1}`));
const sevenEight = clicksInWindow(editTempoMap(), editMeterMap(), BAR_SEC[3], BAR_SEC[4] - 1e-6, { mode: 'group' });
// A 7/8 3+2+2 bar at 72 clicks on its three group starts: 0, 1.25 s and 2.0833 s in,
// at the tempo the file's FF 51 holds.
assert.equal(sevenEight.length, 3, 'a 7/8 3+2+2 bar clicks three times');
[BAR_SEC[3], tickSec(T78 + (PPQ / 2) * 3), tickSec(T78 + (PPQ / 2) * 5)].forEach((sec, i) => near(sevenEight[i].sec, sec, 1e-9, `7/8 group click ${i + 1}`));
near(sevenEight[1].sec - BAR_SEC[3], 1.25, 1e-5, 'group 2 of 3+2+2 at 72 is 1.25 s in');
near(sevenEight[2].sec - BAR_SEC[3], 2.083333, 1e-5, 'group 3 of 3+2+2 at 72 is 2.0833 s in');

console.log('editTimeMap.orchestra: ok');
