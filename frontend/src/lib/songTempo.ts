/**
 * songTempo — EDIT's tempo map and meter map taken from a song's rhythm
 * analysis (backend/modules/rhythm, GET /api/rhythm/{entry_id}), lined up with
 * where the song sounds on the timeline.
 *
 * The analysis gives every bar's downbeat in song seconds and every bar's
 * meter (lib/rhythmSeed songMeters: a segment's meter from its first bar, a bar
 * cut short at a change as a meter of its own). A clip tied to the song
 * (lib/clipSongTime) says where each song second sounds on the timeline, so
 * each downbeat has a timeline second. The plan puts EDIT's bar lines on those
 * seconds:
 *
 *  - Bar 1 of the analysis (the first downbeat inside the clip, when the clip
 *    is trimmed) starts an EDIT bar at that second. Everything before it stays
 *    as it was, except the EDIT bar it falls inside: that bar is cut to end on
 *    the downbeat, a partial bar of whole 32nds at the tempo that makes it end
 *    exactly there. A downbeat too close to the start of the timeline for any
 *    bar (under 25 ms, a 32nd at 300 BPM) starts bar 1 at 0 instead, and the
 *    preview says by how much.
 *  - Tempo per bar where the analysis has downbeats: a run of bars shares one
 *    tempo while every downbeat inside it stays within SONG_TEMPO_TOLERANCE_SEC
 *    of where that tempo puts it, and each run starts from where the map
 *    actually is, so rounding never accumulates. One tempo otherwise.
 *  - The song's meters from bar 1 on, bar for bar.
 *
 * Pure: no store, so node tests load it.
 */
import type { Meter } from './colony';
import {
  dropRepeatedTempos,
  editBarAtSec,
  editBarStartSec,
  editBarStartStep,
  editBpmText,
  editMeterLabel,
  editStartBpm,
  editTempoRange,
  sameMeterMap,
  sameTempoMap,
  sanitizeEditMeterMap,
  tempoEventsBefore,
  type EditTimeMaps,
} from './editTimeMap';
import { meterAtBar, normalizeMeterMap, stepsAsMeter, type MeterSegment } from './meterMap';
import { sanitizeRollTempoMap, stepClock, tickBeat } from './rollTempo';
import { songDownbeats, songMeters, trackedQuarterBpm, type RhythmAnalysis } from './rhythmSeed';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN, type TempoEvent } from './tempoMap';

/** How far a downbeat may sit from its bar line before its bar gets a tempo of its own. */
export const SONG_TEMPO_TOLERANCE_SEC = 0.001;
/** A first downbeat this close to its EDIT bar line starts that bar: a partial bar would be shorter than it. */
export const SONG_TEMPO_SNAP_SEC = 0.001;
/** The shortest bar EDIT can hold: a 32nd at the fastest tempo. */
export const MIN_PARTIAL_BAR_SEC = 7.5 / TEMPO_BPM_MAX;

const EPS = 1e-9;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Where the song sounds: its seconds as timeline seconds, and the timeline window whose downbeats count. */
export interface SongPlacement {
  /** Timeline second of song second `songSec`. Must rise with it. */
  toTimeline: (songSec: number) => number;
  /** Downbeats sounding in [startSec, endSec] count (a clip's played region). */
  startSec: number;
  endSec: number;
}

/** A downbeat the plan put a bar line on. */
export interface PlacedDownbeat {
  /** 0-based analysis bar. */
  songBar: number;
  /** 0-based EDIT bar that starts on it. */
  editBar: number;
  /** Timeline second of the downbeat. */
  sec: number;
}

export interface SongTempoPlan {
  ok: true;
  tempoMap: TempoEvent[];
  meterMap: MeterSegment[];
  /** Timeline second of the first downbeat the plan lines up (bar 1 of the analysis, or the first inside the clip). */
  firstDownbeatSec: number;
  /** 0-based EDIT bar that starts there. */
  firstBar: number;
  /** 0-based analysis bar placed first. */
  firstSongBar: number;
  /** Every downbeat the plan lines a bar up with, in order. */
  downbeats: PlacedDownbeat[];
  /** Tempo changes in the new map (tempo events after its start). */
  tempoChanges: number;
  /** The new map's start tempo and its slowest and fastest tempo. */
  startBpm: number;
  range: [number, number];
  /** True when the tempo follows the downbeats bar by bar; false for one tempo. */
  perBar: boolean;
  /** The partial bar cut before the first downbeat, when there is one. */
  partial: { bar: number; meter: Meter; bpm: number } | null;
  /** Seconds bar 1 starts before the first downbeat when no partial bar fits (0 otherwise). */
  earlySec: number;
  /** Bars whose tempo fell outside 20-300 BPM and were held at the limit. */
  clampedBars: number;
  /** The farthest any lined-up bar line sits from its downbeat, in seconds. */
  maxErrorSec: number;
  /** The meters the song writes, in words ("6/8 then 15/8 3+2"). */
  meterText: string;
  /** Bars in segments the engine marked uncertain. */
  uncertainBars: number;
  /** True when the plan differs from the maps it was computed against. */
  changes: boolean;
  error?: undefined;
}

export type SongTempoResult = SongTempoPlan | { ok: false; error: string };

/** The meters of a meter map in words, as the offer reads them. */
function metersInWords(map: readonly MeterSegment[]): string {
  const labels: string[] = [];
  for (const s of normalizeMeterMap(map)) {
    const label = editMeterLabel(s.meter);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length > 3 ? `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more meters` : labels.join(' then ');
}

/** How far a partial bar's tempo may sit from the song's to count in a plainer note value. */
const PARTIAL_TEMPO_SLACK = 0.15;

/**
 * Whole 32nds and a tempo that fill `sec` seconds, within 20-300 BPM: the
 * plainest count (quarters, then 8ths, 16ths, 32nds) whose tempo stays within
 * 15% of `refBpm`, else the 32nds nearest it. Null when no bar fits.
 */
function partialBarFor(sec: number, refBpm: number): { thirtySeconds: number; bpm: number } | null {
  if (!(sec > 0)) return null;
  // m 32nds at X BPM last 7.5 m / X seconds, so X = 7.5 m / sec.
  const lo = Math.max(1, Math.ceil((TEMPO_BPM_MIN * sec) / 7.5 - EPS));
  const hi = Math.min(512, Math.floor((TEMPO_BPM_MAX * sec) / 7.5 + EPS));
  if (lo > hi) return null;
  const ref = Math.max(TEMPO_BPM_MIN, Math.min(TEMPO_BPM_MAX, refBpm));
  const ideal = (ref * sec) / 7.5;
  for (const unit of [8, 4, 2]) {
    const m = Math.max(unit, Math.round(ideal / unit) * unit);
    const bpm = (7.5 * m) / sec;
    if (m >= lo && m <= hi && Math.abs(bpm / ref - 1) <= PARTIAL_TEMPO_SLACK) return { thirtySeconds: m, bpm };
  }
  const m = Math.max(lo, Math.min(hi, Math.round(ideal)));
  return { thirtySeconds: m, bpm: (7.5 * m) / sec };
}

/**
 * EDIT's tempo map and meter map from `analysis`, placed by `at`, over the
 * arrangement's current maps `edit`. The reason when it cannot be done.
 */
export function planSongTempo(edit: EditTimeMaps, analysis: RhythmAnalysis, at: SongPlacement): SongTempoResult {
  if (analysis.status !== 'ready') return { ok: false, error: 'The song has no rhythm analysis yet. Analyse it first.' };
  const meters = songMeters(analysis);
  if (!meters) return { ok: false, error: 'The rhythm analysis found no meter in this song, so there are no bars to line up.' };
  const { songMap } = meters;

  // The song's pace against the timeline's: song seconds per timeline second.
  const span = at.toTimeline(1) - at.toTimeline(0);
  const pace = span > 0 ? 1 / span : NaN;
  if (!isNum(pace) || pace <= 0) return { ok: false, error: 'The clip does not play the song forward in time.' };

  // Downbeats that sound inside the window, on the timeline.
  const inWindow = (sec: number) => sec >= Math.max(0, at.startSec) - 1e-6 && sec <= at.endSec + 1e-6;
  const all = songDownbeats(analysis, songMap).map((d) => ({ ...d, t: at.toTimeline(d.sec) }));
  const placed = all.filter((d) => inWindow(d.t));
  let perBar = placed.length >= 2;

  // One tempo when fewer than two downbeats can be lined up: the song's own,
  // anchored at its downbeat, else at its first beat inside the window.
  let singleBpm: number | null = null;
  let anchorSongBar = placed[0]?.bar ?? 0;
  let anchorSec: number | null = placed[0]?.t ?? null;
  if (!perBar) {
    const allDowns = all.length >= 2 ? (60 * (all[all.length - 1].quarters - all[0].quarters)) / (all[all.length - 1].sec - all[0].sec) : null;
    const songBpm = allDowns ?? trackedQuarterBpm(analysis, meters.segs[0]);
    if (!(songBpm && songBpm > 0)) return { ok: false, error: 'The rhythm analysis has no tempo for this song.' };
    singleBpm = songBpm * pace;
    if (anchorSec === null) {
      const beat = (analysis.beats ?? []).filter(isNum).map((b) => at.toTimeline(b)).find(inWindow);
      if (beat === undefined) return { ok: false, error: 'No beat of the song sounds inside the clip, so there is nothing to line the bars up with.' };
      anchorSec = beat;
      anchorSongBar = 0;
    }
  }
  const A = anchorSec as number;

  // Where bar 1 of the song goes: the EDIT bar holding the downbeat, cut to end on it.
  const here = editBarAtSec(edit, A);
  let keepBelow = here.bar;
  let base = here.bar;
  let partial: SongTempoPlan['partial'] = null;
  let partialEvent: TempoEvent | null = null;
  let earlySec = 0;
  const firstGuess = perBar ? (60 * (placed[1].quarters - placed[0].quarters)) / (placed[1].t - placed[0].t) : (singleBpm as number);
  let before: TempoEvent[];
  let baseBeat: number;
  let baseSec: number;
  if (A - here.startSec <= SONG_TEMPO_SNAP_SEC) {
    before = tempoEventsBefore(edit.tempoMap, tickBeat(here.startStep / 4));
    baseBeat = tickBeat(here.startStep / 4);
    baseSec = stepClock(editStartBpm(edit.tempoMap), sanitizeRollTempoMap(before, editStartBpm(edit.tempoMap))).at(here.startStep);
  } else {
    // The partial bar runs from a bar line to the downbeat: the holding bar's,
    // or the one before it when the holding bar has started too recently.
    let fromBar = here.bar;
    if (A - here.startSec < MIN_PARTIAL_BAR_SEC && here.bar > 0) fromBar = here.bar - 1;
    const fromStep = editBarStartStep(edit.meterMap, fromBar);
    const fromBeat = tickBeat(fromStep / 4);
    before = tempoEventsBefore(edit.tempoMap, fromBeat);
    const startBpm = editStartBpm(edit.tempoMap);
    const fromSec = stepClock(startBpm, sanitizeRollTempoMap(before, startBpm)).at(fromStep);
    const fit = partialBarFor(A - fromSec, firstGuess);
    keepBelow = fromBar;
    if (fit) {
      const meter = stepsAsMeter(fit.thirtySeconds / 2);
      if (!meter) return { ok: false, error: 'The space before the first downbeat cannot be written as a bar.' };
      partial = { bar: fromBar, meter, bpm: fit.bpm };
      partialEvent = { beat: fromBeat, bpm: fit.bpm, curve: 'step' };
      base = fromBar + 1;
      baseBeat = tickBeat(fromBeat + fit.thirtySeconds / 8);
      baseSec = A;
    } else {
      // Under 25 ms from the start of the timeline: no bar is that short, so
      // bar 1 starts at 0 and the song's first bar takes up the difference.
      base = fromBar;
      baseBeat = fromBeat;
      baseSec = fromSec;
      earlySec = A - fromSec;
    }
  }

  // Tempo: runs of bars from where the map actually is, each ending exactly on a downbeat.
  const events: TempoEvent[] = [];
  if (partialEvent) events.push(partialEvent);
  let clampedBars = 0;
  const downbeats: PlacedDownbeat[] = [];
  const q0 = perBar ? placed[0].quarters : 0;
  if (perBar) {
    let a = 0;
    let beatA = baseBeat;
    let secA = baseSec;
    while (a < placed.length - 1) {
      let best = a + 1;
      let bestBpm = NaN;
      for (let c = a + 1; c < placed.length; c += 1) {
        const beats = placed[c].quarters - placed[a].quarters;
        const bpm = (60 * beats) / (placed[c].t - secA);
        let fits = bpm > 0 && isNum(bpm);
        for (let j = a + 1; j < c && fits; j += 1) {
          fits = Math.abs(secA + ((placed[j].quarters - placed[a].quarters) * 60) / bpm - placed[j].t) <= SONG_TEMPO_TOLERANCE_SEC;
        }
        if (!fits) break;
        best = c;
        bestBpm = bpm;
      }
      if (!isNum(bestBpm)) bestBpm = (60 * (placed[best].quarters - placed[a].quarters)) / Math.max(EPS, placed[best].t - secA);
      const bpm = Math.max(TEMPO_BPM_MIN, Math.min(TEMPO_BPM_MAX, bestBpm));
      if (bpm !== bestBpm) clampedBars += placed[best].bar - placed[a].bar;
      events.push({ beat: beatA, bpm, curve: 'step' });
      const beats = placed[best].quarters - placed[a].quarters;
      secA += (beats * 60) / bpm;
      beatA = tickBeat(baseBeat + (placed[best].quarters - q0));
      a = best;
    }
  } else {
    events.push({ beat: baseBeat, bpm: Math.max(TEMPO_BPM_MIN, Math.min(TEMPO_BPM_MAX, singleBpm as number)), curve: 'step' });
  }
  // `before` holds EDIT's start tempo whenever the song starts past beat 0;
  // otherwise the song's first event is at beat 0 and is the start.
  const tempoMap = dropRepeatedTempos(sanitizeRollTempoMap([...before, ...events], editStartBpm(edit.tempoMap)));

  // Meter: EDIT's bars before, the partial bar, then the song's bars from bar 1 through the last one lined up.
  const lastSongBar = perBar ? placed[placed.length - 1].bar : anchorSongBar;
  const songSegs: MeterSegment[] = [{ bar: base, meter: meterAtBar(songMap, anchorSongBar) }];
  for (const s of songMap) {
    if (s.bar > anchorSongBar && s.bar <= lastSongBar) songSegs.push({ bar: base + (s.bar - anchorSongBar), meter: s.meter });
  }
  const kept = normalizeMeterMap(edit.meterMap, false).filter((s) => s.bar < keepBelow);
  const meterMap = sanitizeEditMeterMap([...kept, ...(partial ? [{ bar: partial.bar, meter: partial.meter }] : []), ...songSegs]);

  // Every downbeat's bar line under the new maps, and how far off it sits.
  const maps = { tempoMap, meterMap };
  let maxErrorSec = 0;
  const lined = perBar ? placed : [{ bar: anchorSongBar, quarters: 0, sec: 0, t: A }];
  for (const d of lined) {
    const editBar = base + (d.bar - anchorSongBar);
    downbeats.push({ songBar: d.bar, editBar, sec: d.t });
    maxErrorSec = Math.max(maxErrorSec, Math.abs(editBarStartSec(maps, editBar) - d.t));
  }

  const tempoChanges = tempoMap.filter((e) => !e.fermata && e.beat > 0).length;
  const segsUncertain = meters.segs.filter((s) => s.uncertain).reduce((n, s) => n + (s.bars || 0), 0);
  return {
    ok: true,
    tempoMap,
    meterMap,
    firstDownbeatSec: A,
    firstBar: base,
    firstSongBar: anchorSongBar,
    downbeats,
    tempoChanges,
    startBpm: editStartBpm(tempoMap),
    range: editTempoRange(tempoMap),
    perBar,
    partial,
    earlySec,
    clampedBars,
    maxErrorSec,
    meterText: metersInWords(songSegs.map((s) => ({ bar: s.bar - base, meter: s.meter }))),
    uncertainBars: segsUncertain,
    changes: !sameTempoMap(tempoMap, edit.tempoMap) || !sameMeterMap(meterMap, edit.meterMap),
  };
}

/** The plan in words for the log line. */
export function describeSongTempoPlan(plan: SongTempoPlan): string {
  const [lo, hi] = plan.range;
  const tempo = lo === hi ? `${editBpmText(lo)} BPM` : `${editBpmText(lo)}-${editBpmText(hi)} BPM`;
  return `${plan.meterText}, ${tempo}, ${plan.tempoChanges} tempo change${plan.tempoChanges === 1 ? '' : 's'}, bar ${plan.firstBar + 1} on the first downbeat`;
}
