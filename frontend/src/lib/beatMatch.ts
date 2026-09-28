/**
 * Beat matching for EDIT clips, the way a DJ deck's SYNC works: every clip is
 * time-stretched so its tempo equals the target's, then nudged so its first
 * beat sits on the project grid. Pure maths; the editor renders the stretch
 * through the backend and applies the result.
 */

/** The stretch bounds the backend's time_pitch effect accepts. */
export const STRETCH_MIN = 0.25;
export const STRETCH_MAX = 4;

/** Ratios this close to 1 are left alone: the clip already matches. */
const UNITY_EPSILON = 0.005;

export interface BeatMatchInput {
  id: string;
  /** The clip's known tempo, or null when nothing analysed it. */
  bpm: number | null;
}

export interface BeatMatchStep {
  id: string;
  /** Tempo factor for the stretch: > 1 speeds the clip up (shorter). */
  tempo: number;
  /** What the clip plays at afterwards. */
  bpm: number;
}

/**
 * The tempo factor that takes `fromBpm` to `toBpm`, choosing among the
 * half-time and double-time readings the one closest to unity. A track
 * analysed at 85 against a 170 target is left at 85 (ratio 1), the way a deck
 * treats a half-time reading, and the phase alignment still lands its beats.
 */
export function stretchRatio(fromBpm: number, toBpm: number): number {
  if (!(fromBpm > 0) || !(toBpm > 0)) return 1;
  const direct = toBpm / fromBpm;
  const candidates = [direct, direct / 2, direct * 2];
  let best = direct;
  for (const c of candidates) {
    if (Math.abs(Math.log(c)) < Math.abs(Math.log(best))) best = c;
  }
  return Math.max(STRETCH_MIN, Math.min(STRETCH_MAX, best));
}

/**
 * One stretch per clip whose tempo is known and differs from the target.
 * Clips without a tempo and clips already at the target are skipped.
 */
export function beatMatchPlan(clips: BeatMatchInput[], targetBpm: number): BeatMatchStep[] {
  if (!(targetBpm > 0)) return [];
  const steps: BeatMatchStep[] = [];
  for (const clip of clips) {
    if (!clip.bpm || !(clip.bpm > 0)) continue;
    const tempo = stretchRatio(clip.bpm, targetBpm);
    if (Math.abs(tempo - 1) < UNITY_EPSILON) continue;
    steps.push({ id: clip.id, tempo, bpm: clip.bpm * tempo });
  }
  return steps;
}

/**
 * The first analysed beat inside the clip's played region, as seconds from
 * the clip's start AFTER a stretch by `tempo`. Null when no beat falls inside.
 */
export function firstBeatInClip(
  beats: readonly number[] | null | undefined,
  offsetIntoSource: number,
  durationSec: number,
  tempo = 1,
): number | null {
  if (!beats || beats.length === 0) return null;
  const end = offsetIntoSource + durationSec;
  for (const b of beats) {
    if (b >= offsetIntoSource && b < end) return (b - offsetIntoSource) / tempo;
  }
  return null;
}

/**
 * The start that puts the clip's first beat on the nearest grid line, never
 * before 0. `beatLenSec` is 60 / project bpm. With no beat known, the start is
 * returned unchanged.
 */
export function alignedStart(startSec: number, firstBeatSec: number | null, beatLenSec: number): number {
  if (firstBeatSec === null || !(beatLenSec > 0)) return startSec;
  const beatAt = startSec + firstBeatSec;
  let line = Math.round(beatAt / beatLenSec) * beatLenSec;
  if (line - firstBeatSec < 0) line += beatLenSec;
  return Math.max(0, line - firstBeatSec);
}

/**
 * `alignedStart` on a beat grid that is not evenly spaced (the arrangement's
 * quarter grid through a tempo map): `lineNear` is the nearest beat line to a
 * second, `lineAfter` the beat line one beat after a given line. The first beat
 * lands on the nearest line that keeps the clip at or after 0.
 */
export function alignedStartOn(
  startSec: number,
  firstBeatSec: number | null,
  lineNear: (sec: number) => number,
  lineAfter: (lineSec: number) => number,
): number {
  if (firstBeatSec === null) return startSec;
  let line = lineNear(startSec + firstBeatSec);
  for (let guard = 0; line - firstBeatSec < 0 && guard < 64; guard += 1) line = lineAfter(line);
  return Math.max(0, line - firstBeatSec);
}
