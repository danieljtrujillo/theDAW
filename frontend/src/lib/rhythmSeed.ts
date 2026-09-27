/**
 * rhythmSeed — the piano roll's meter and tempo from a library song's rhythm
 * analysis (GET /api/rhythm/{entry_id} and POST /api/rhythm/{entry_id}/run in
 * backend/modules/rhythm/router.py).
 *
 * The analysis's meter_map gives each segment's numerator, denominator,
 * grouping and first bar; its first downbeat gives the pickup; polymeter
 * entries that name a denominator become lanes looping at their bar length,
 * each limited to the bars of the segments it was heard in.
 *
 * Tempo comes from the downbeats. Each analysis bar holds a known number of
 * quarter notes (its meter), and each downbeat says when it starts, so a run
 * of bars at one tempo is the quarter notes it holds over the seconds it
 * lasts. Runs grow while every downbeat inside them stays within
 * TEMPO_TOLERANCE_SEC of where that tempo puts it; a new run starts where the
 * song speeds up or slows down. One run is one BPM; more become the roll's
 * tempo map, so the bar lines follow the song's downbeats while the notes keep
 * their steps. Reading tempo off bar lengths also makes it a quarter-note
 * tempo whatever pulse the engine tracked (it reports 190 for a 7/8 counted
 * in eighths, which is 95 to the quarter).
 *
 * The analysis's swing ratio (long off-beat over short, 1 straight, 2
 * triplet) becomes a swing groove on the tracked beat's halves: 8ths under a
 * quarter-note beat, 16ths under an eighth-note beat.
 */
import { barStartStep, meterFromAnalysis, normalizeMeterMap, stepsPerBar, type LaneSpan, type MeterSegment, type PolyLane } from './meterMap';
import type { TempoEvent } from './tempoMap';

export interface RhythmMeterSegment {
  start_bar: number;
  bars: number;
  numerator: number;
  denominator: number;
  grouping: number[];
  beats_per_bar: number;
  /** The tracked beat's note value: 'quarter', 'eighth', 'sixteenth' or 'dotted-quarter'. */
  beat_unit?: string;
  bpm?: number;
  confidence?: number;
  uncertain?: boolean;
}

export interface RhythmPolymeterEntry {
  segment: number;
  layer: string;
  beats_per_bar: number;
  grouping: number[];
  /** Written by the engine since polymeter entries named their grid; older caches lack it. */
  denominator?: number;
  label?: string;
  confidence: number;
}

export interface RhythmAnalysis {
  entry_id?: string;
  status: 'ready' | 'pending';
  tempo?: { bpm: number; stable: boolean };
  /** Seconds of each analysis bar's first beat, bar 0 first. */
  downbeats?: number[];
  meter_map?: RhythmMeterSegment[];
  polymeter?: RhythmPolymeterEntry[];
  syncopation?: { swing_ratio?: number | null; swing_confidence?: number };
}

/** The song's swing as a groove: `pct` is the long off-beat's share of the beat (50 straight, 66.7 triplet). */
export interface RhythmSwing {
  ratio: number;
  pct: number;
  /** 8 = swing the 8ths (a quarter-note beat), 16 = swing the 16ths (an eighth-note beat). */
  unit: 8 | 16;
  /** The groove id the roll's feel resolves (lib/grooveTemplate `grooveById`). */
  grooveId: string;
}

export interface RhythmSeed {
  meterMap: MeterSegment[];
  pickupSteps: number;
  /** Lane A plus one lane per distinct polymeter loop, strongest first. */
  lanes: PolyLane[];
  /** The song's quarter-note tempo (its average over the downbeats), or null when the analysis has none. */
  bpm: number | null;
  /** The roll's tempo changes when the song's tempo moves; empty when one BPM holds it. */
  tempoMap: TempoEvent[];
  /** True when the tempo was read off two or more downbeats, so bar lines follow the song. */
  tempoFromDownbeats: boolean;
  tempoStable: boolean;
  /** Bars in segments the engine marked uncertain. */
  uncertainBars: number;
  /** The song's swing when it swings (52% or more); null when it plays straight or has no reading. */
  swing: RhythmSwing | null;
}

const EPS = 1e-9;
const MAX_PICKUP = 64;
/** How far a downbeat may sit from where its run's tempo puts it before a new run starts. */
export const TEMPO_TOLERANCE_SEC = 0.025;
/** Below this share of the beat the song plays straight, and MATCH leaves the groove alone. */
const SWING_MIN_PCT = 52;
const SWING_MAX_PCT = 75;

const title = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** One run of bars at one tempo: downbeat indices `from`..`to` and quarter notes per minute. */
export interface TempoRun { from: number; to: number; bpm: number }

/**
 * Downbeats `sec` at quarter-note positions `beats` (both rising) as runs of
 * one tempo. A run starts at a downbeat and takes in the next ones while
 * every downbeat inside it stays within `tol` seconds of the straight line
 * from its first to its last, so each run begins and ends exactly on a
 * downbeat and bars inside it are off by `tol` at most.
 */
export function tempoRuns(beats: readonly number[], sec: readonly number[], tol = TEMPO_TOLERANCE_SEC): TempoRun[] {
  const n = Math.min(beats.length, sec.length);
  const runs: TempoRun[] = [];
  let a = 0;
  while (a < n - 1) {
    let best = a + 1;
    for (let c = a + 2; c < n; c += 1) {
      const spq = (sec[c] - sec[a]) / (beats[c] - beats[a]);
      let fits = true;
      for (let j = a + 1; j < c && fits; j += 1) fits = Math.abs(sec[a] + (beats[j] - beats[a]) * spq - sec[j]) <= tol;
      if (!fits) break;
      best = c;
    }
    runs.push({ from: a, to: best, bpm: (60 * (beats[best] - beats[a])) / (sec[best] - sec[a]) });
    a = best;
  }
  return runs;
}

/** The analysis's swing as a groove, or null when it plays straight or carries no ratio. */
export function swingFromRhythm(a: RhythmAnalysis): RhythmSwing | null {
  const ratio = a.syncopation?.swing_ratio;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0) return null;
  const pct = Math.min(SWING_MAX_PCT, Math.round((1000 * ratio) / (1 + ratio)) / 10);
  if (pct < SWING_MIN_PCT) return null;
  // The engine measures swing on the tracked beat's halves.
  const first = (a.meter_map ?? []).find((s) => s.beat_unit === 'quarter' || s.beat_unit === 'eighth') ?? a.meter_map?.[0];
  const unit: 8 | 16 = first?.beat_unit === 'eighth' || (first?.beat_unit === undefined && first?.denominator === 8) ? 16 : 8;
  return { ratio, pct, unit, grooveId: `swing${unit}:${pct}` };
}

/**
 * The roll's meter and tempo for a ready analysis, or null when it is pending
 * or has no meter map. `rollBpm` places the pickup when the analysis carries
 * neither a tempo nor two downbeats.
 */
export function seedFromRhythm(a: RhythmAnalysis, rollBpm: number, maxLanes = 3): RhythmSeed | null {
  if (a.status !== 'ready' || !a.meter_map?.length) return null;
  const segs = [...a.meter_map].sort((x, y) => x.start_bar - y.start_bar);
  const raw: MeterSegment[] = [];
  for (const s of segs) {
    const meter = meterFromAnalysis(s);
    if (meter) raw.push({ bar: Math.max(0, Math.round(s.start_bar)), meter });
  }
  if (!raw.length) return null;
  const songMap = normalizeMeterMap(raw);

  // Each downbeat's quarter-note position counted from the analysis's bar 0,
  // kept only while both keep rising.
  const qs: number[] = [];
  const ds: number[] = [];
  (a.downbeats ?? []).forEach((d, j) => {
    const q = barStartStep(songMap, j, 0) / 4;
    if (!Number.isFinite(d) || (ds.length && (d <= ds[ds.length - 1] + EPS || q <= qs[qs.length - 1] + EPS))) return;
    qs.push(q);
    ds.push(d);
  });
  const runs = tempoRuns(qs, ds);
  const tracked = a.tempo && a.tempo.bpm > 0 ? a.tempo.bpm : null;
  const average = runs.length ? (60 * (qs[qs.length - 1] - qs[0])) / (ds[ds.length - 1] - ds[0]) : null;
  const bpm = average ?? tracked;

  // The pickup counts at the tempo the song opens with.
  const stepSec = 60 / (runs[0]?.bpm ?? bpm ?? rollBpm) / 4;
  const firstDownbeat = a.downbeats?.[0];
  const barLen = stepsPerBar(songMap[0].meter);
  const lead = typeof firstDownbeat === 'number' && firstDownbeat > 0 && stepSec > 0 ? Math.round(firstDownbeat / stepSec) : 0;
  // Whole bars of the first meter before the first downbeat come ahead of the
  // analysis's bar 0; what is left over is the pickup.
  const extraBars = barLen > 0 ? Math.floor(lead / barLen + EPS) : 0;
  const pickupSteps = Math.min(MAX_PICKUP, Math.max(0, lead - extraBars * barLen));
  const meterMap = normalizeMeterMap(raw.map((s, i) => ({ bar: i === 0 ? 0 : s.bar + extraBars, meter: s.meter })));

  // Tempo events in the roll's beats: the first run from beat 0 (the pickup
  // and the bars before the first downbeat take its tempo), each later run from
  // the downbeat it starts on. Neighbours that come out equal merge.
  const leadBeats = (pickupSteps + extraBars * barLen) / 4;
  const events: TempoEvent[] = [];
  runs.forEach((r, i) => {
    const bpmR = round3(r.bpm);
    if (events.length && events[events.length - 1].bpm === bpmR) return;
    events.push({ beat: i === 0 ? 0 : round3(leadBeats + qs[r.from]), bpm: bpmR });
  });
  const tempoMap = events.length > 1 ? events : [];

  // Polymeter loops by cycle: the strongest entry names the lane, and the lane
  // plays over the bars of every segment where its loop was heard.
  const byCycle = new Map<number, { name: string; first: number; last: number }>();
  const entries = [...(a.polymeter ?? [])].sort((x, y) => y.confidence - x.confidence);
  for (const p of entries) {
    if (!(typeof p.denominator === 'number' && p.denominator > 0)) continue;
    const cycle = (p.beats_per_bar * 16) / p.denominator;
    if (!Number.isInteger(cycle) || cycle < 1) continue;
    const seg = segs[p.segment];
    const segMeter = seg ? meterFromAnalysis(seg) : null;
    if (segMeter && Math.abs(stepsPerBar(segMeter) - cycle) < EPS) continue;
    const at = seg ? p.segment : 0;
    const got = byCycle.get(cycle);
    if (got) {
      got.first = Math.min(got.first, at);
      got.last = Math.max(got.last, at);
      continue;
    }
    if (byCycle.size >= maxLanes) continue;
    byCycle.set(cycle, { name: title(p.layer), first: at, last: at });
  }
  const segStart = (i: number): number => barStartStep(meterMap, Math.round(segs[i].start_bar) + extraBars, pickupSteps);
  const lanes: PolyLane[] = [{ id: 0, name: 'A', cycleSteps: null }];
  for (const [cycle, c] of byCycle) {
    const id = lanes.length;
    const span: LaneSpan = { start: c.first === 0 ? 0 : segStart(c.first), end: c.last + 1 < segs.length ? segStart(c.last + 1) : null };
    const whole = span.start <= EPS && span.end === null;
    lanes.push({ id, name: c.name || `Lane ${id}`, cycleSteps: cycle, ...(whole ? {} : { span }) });
  }

  return {
    meterMap,
    pickupSteps,
    lanes,
    bpm,
    tempoMap,
    tempoFromDownbeats: runs.length > 0,
    tempoStable: a.tempo?.stable ?? true,
    uncertainBars: segs.filter((s) => s.uncertain).reduce((n, s) => n + (s.bars || 0), 0),
    swing: swingFromRhythm(a),
  };
}

/**
 * A library entry's rhythm analysis. With `run`, an entry that has none yet
 * is analyzed now. Throws an Error whose message names the failing request.
 */
export async function fetchRhythm(entryId: string, { run = false, signal }: { run?: boolean; signal?: AbortSignal } = {}): Promise<RhythmAnalysis> {
  const base = `/api/rhythm/${encodeURIComponent(entryId)}`;
  const read = async (r: Response, what: string): Promise<RhythmAnalysis> => {
    if (!r.ok) {
      let detail = '';
      try { detail = ((await r.json()) as { detail?: string }).detail ?? ''; } catch { /* no JSON body */ }
      throw new Error(`${what} failed with ${r.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await r.json()) as RhythmAnalysis;
  };
  const got = await read(await fetch(base, { signal }), 'Reading the rhythm analysis');
  if (got.status === 'ready' || !run) return got;
  return read(await fetch(`${base}/run`, { method: 'POST', signal }), 'Analyzing the rhythm');
}
