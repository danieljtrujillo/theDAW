// EDIT's tempo and meter from a song's rhythm analysis (lib/songTempo), on a
// real analysis: GET /api/rhythm/{id} of a 295 s song in 6/8 with 15/8
// sections, read from the running app (lib/__fixtures__). Every block places
// the song the way a clip on the timeline does and checks that each downbeat
// has an EDIT bar line within 2 ms of it, whatever came before the clip.
//
//   cd frontend && npx tsx src/lib/songTempo.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planSongTempo, MIN_PARTIAL_BAR_SEC, type SongPlacement, type SongTempoPlan } from './songTempo';
import { editBarAtSec, editBarStartSec, editDefaultMeterMap, editDefaultTempoMap, editMeterLabel, type EditTimeMaps } from './editTimeMap';
import { meterAtBar } from './meterMap';
import { songDownbeats, songMeters, type RhythmAnalysis } from './rhythmSeed';
import { sanitizeRollTempoMap } from './rollTempo';

const fx = JSON.parse(readFileSync(new URL('./__fixtures__/rhythm-owl-grinned.json', import.meta.url), 'utf8')) as { rhythm: RhythmAnalysis };
const song = fx.rhythm;
const meters = songMeters(song);
assert.ok(meters, 'the fixture has meters');
const downs = songDownbeats(song, meters.songMap);

const fresh = (): EditTimeMaps => ({ tempoMap: editDefaultTempoMap(120), meterMap: editDefaultMeterMap() });
const TOL = 0.002;

/** A clip at `startSec` playing the song from `offset` at `rate` song seconds per timeline second, `dur` long. */
const clipAt = (startSec: number, offset = 0, rate = 1, dur = 295.2 / rate): SongPlacement => ({
  toTimeline: (s) => startSec + (s - offset) / rate,
  startSec,
  endSec: startSec + dur,
});

const ok = (res: ReturnType<typeof planSongTempo>): SongTempoPlan => {
  assert.ok(res.ok, res.ok ? '' : res.error);
  return res as SongTempoPlan;
};

/** Every downbeat sounding in the window has a bar line within 2 ms, bars count up one per downbeat, and each bar carries its song bar's meter. */
function checkLinedUp(plan: SongTempoPlan, at: SongPlacement, label: string): number {
  const maps = { tempoMap: plan.tempoMap, meterMap: plan.meterMap };
  const inside = downs.filter((d) => {
    const t = at.toTimeline(d.sec);
    return t >= at.startSec - 1e-6 && t <= at.endSec + 1e-6;
  });
  assert.ok(inside.length > 1, `${label}: downbeats in the clip`);
  let prevBar: number | null = null;
  let worst = 0;
  for (const d of inside) {
    const t = at.toTimeline(d.sec);
    // The bar line nearest the downbeat, found from the maps alone.
    const bar = editBarAtSec(maps, t + TOL);
    const err = Math.abs(bar.startSec - t);
    worst = Math.max(worst, err);
    assert.ok(err <= TOL, `${label}: song bar ${d.bar} at ${t.toFixed(4)}s has its bar line ${(err * 1000).toFixed(3)} ms away`);
    if (prevBar !== null) assert.equal(bar.bar, prevBar + 1, `${label}: one EDIT bar per song bar at song bar ${d.bar}`);
    prevBar = bar.bar;
    assert.equal(editMeterLabel(bar.meter), editMeterLabel(meterAtBar(meters!.songMap, d.bar)), `${label}: song bar ${d.bar}'s meter`);
  }
  assert.ok(plan.maxErrorSec <= TOL, `${label}: the plan's own reading of its error`);
  return worst;
}

// 1. A stem dropped at 0: bar 1 of the analysis (1.5557 s) lands on an EDIT bar
//    line, a partial bar fills the 1.5557 s before it, and every later downbeat
//    has its bar line. The tempo follows the downbeats bar by bar.
{
  const at = clipAt(0);
  const plan = ok(planSongTempo(fresh(), song, at));
  assert.equal(plan.firstSongBar, 0);
  assert.equal(plan.firstDownbeatSec, 1.5557);
  assert.equal(plan.firstBar, 1, 'the partial bar is bar 1, the song starts bar 2');
  assert.ok(plan.partial && plan.partial.bar === 0, 'bar 1 is cut to end on the downbeat');
  // Counted in quarters at the song's opening pace, not in 32nds: 5/4 near 193 BPM.
  assert.equal(editMeterLabel(plan.partial.meter), '5/4');
  assert.ok(Math.abs(plan.partial.bpm - (60 * 5) / 1.5557) < 1e-9);
  assert.ok(Math.abs(editBarStartSec(plan, 1) - 1.5557) < 1e-9, 'bar 2 starts exactly on the first downbeat');
  assert.equal(plan.earlySec, 0);
  assert.ok(plan.perBar);
  assert.ok(plan.tempoChanges > 20, 'a played song speeds up and slows down');
  assert.equal(plan.clampedBars, 0);
  assert.ok(plan.changes);
  assert.equal(plan.meterText.split(' then ')[0].split(',')[0], '6/8');
  checkLinedUp(plan, at, 'stem at 0');
}

// 2. A beat-matched copy: the song played 120/103.36 faster from 0.5 s in,
//    placed at 3.37 s. The downbeats move with the stretch and the bars follow.
{
  const rate = 120 / 103.359375;
  const at = clipAt(3.37, 0.5, rate);
  const plan = ok(planSongTempo(fresh(), song, at));
  assert.equal(plan.firstSongBar, 0);
  assert.ok(Math.abs(plan.firstDownbeatSec - (3.37 + (1.5557 - 0.5) / rate)) < 1e-9);
  // Bars 1 and 2 of the arrangement (0-4 s at 120 in 4/4) keep their place.
  assert.ok(Math.abs(editBarStartSec(plan, 1) - 2) < 1e-9, 'bar 2 still starts at 2 s');
  checkLinedUp(plan, at, 'stretched stem');
}

// 3. A clip trimmed to start 40 s into the song, placed at 10 s: the first
//    downbeat inside the clip is bar 1 of what is lined up, and the song's
//    bars before it are not placed.
{
  const at = clipAt(10, 40, 1, 120);
  const plan = ok(planSongTempo(fresh(), song, at));
  const first = downs.find((d) => d.sec >= 40);
  assert.equal(plan.firstSongBar, first?.bar);
  assert.ok(Math.abs(plan.firstDownbeatSec - (10 + (first!.sec - 40))) < 1e-9);
  // Bars before the clip keep 120 BPM in 4/4.
  for (let b = 0; b < plan.partial!.bar; b += 1) assert.ok(Math.abs(editBarStartSec(plan, b) - b * 2) < 1e-9, `bar ${b + 1} kept`);
  checkLinedUp(plan, at, 'trimmed clip');
  // The meter after the clip's last bar holds; no song meter past it.
  const last = plan.downbeats[plan.downbeats.length - 1];
  assert.ok(plan.meterMap.every((s) => s.bar <= last.editBar), 'no meter change past the clip');
}

// 4. The arrangement already changes tempo before the clip (96, then 140 from
//    beat 8): every second before the clip's first downbeat stays put.
{
  const edit: EditTimeMaps = {
    tempoMap: sanitizeRollTempoMap([{ beat: 0, bpm: 96 }, { beat: 8, bpm: 140 }], 96),
    meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 2, meter: { num: 3, den: 4, groups: [] } }],
  };
  const at = clipAt(12.3);
  const plan = ok(planSongTempo(edit, song, at));
  const cut = plan.partial!.bar;
  for (let b = 0; b <= cut; b += 1) {
    assert.ok(Math.abs(editBarStartSec(plan, b) - editBarStartSec(edit, b)) < 1e-9, `bar ${b + 1} starts where it did`);
  }
  checkLinedUp(plan, at, 'after a tempo change');
}

// 5. A first downbeat 12 ms into the timeline: no bar is that short (a 32nd at
//    300 BPM is 25 ms), so bar 1 starts at 0, 12 ms early, and says so; bar 2
//    on is exact.
{
  const at = clipAt(-1.5557 + 0.012, 0, 1, 290);
  const plan = ok(planSongTempo(fresh(), song, { ...at, startSec: 0 }));
  assert.equal(plan.firstBar, 0);
  assert.equal(plan.partial, null);
  assert.ok(Math.abs(plan.earlySec - 0.012) < 1e-9 && plan.earlySec < MIN_PARTIAL_BAR_SEC);
  assert.ok(Math.abs(editBarStartSec(plan, 1) - at.toTimeline(downs[1].sec)) < TOL, 'bar 2 is on the second downbeat');
}

// 6. A downbeat within 1 ms of an existing bar line starts that bar: no partial bar.
{
  const at = clipAt(4 - 1.5557 + 0.0004);
  const plan = ok(planSongTempo(fresh(), song, at));
  assert.equal(plan.partial, null);
  assert.equal(plan.firstBar, 2);
  checkLinedUp(plan, at, 'on a bar line');
}

// 7. One downbeat inside a short clip: one tempo, the song's, and bar 1 on it.
{
  const at = clipAt(0, 0, 1, 2.0);
  const plan = ok(planSongTempo(fresh(), song, at));
  assert.equal(plan.perBar, false);
  assert.equal(plan.tempoChanges, 1, 'the partial bar, then the song');
  assert.ok(Math.abs(editBarStartSec(plan, plan.firstBar) - 1.5557) < 1e-9);
}

// 8. An analysis that is not ready, or has no meter, is refused with the reason.
{
  const pending = planSongTempo(fresh(), { status: 'pending' }, clipAt(0));
  assert.equal(pending.ok, false);
  const noMeter = planSongTempo(fresh(), { ...song, meter_map: [] }, clipAt(0));
  assert.equal(noMeter.ok, false);
  const outside = planSongTempo(fresh(), song, clipAt(0, 0, 1, 1.0));
  assert.equal(outside.ok, false, 'no downbeat and no beat past the song start inside a one-second clip');
}

// 9. The same plan twice changes nothing the second time.
{
  const at = clipAt(0);
  const plan = ok(planSongTempo(fresh(), song, at));
  const again = ok(planSongTempo({ tempoMap: plan.tempoMap, meterMap: plan.meterMap }, song, at));
  assert.equal(again.changes, false);
}

console.log('songTempo: ok');
