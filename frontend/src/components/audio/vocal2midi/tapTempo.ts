/**
 * Tap tempo: the whole BPM a run of taps gives, inside the app's tempo range
 * (lib/tempoMap, 20-300), so a tapped 24 BPM Grave reaches the roll the way a
 * typed one does. A gap between two taps that no tempo in the range explains
 * (a missed or doubled tap) is left out, and the rest are averaged.
 */
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN, clampTempoBpm } from '../../../lib/tempoMap';

/** The longest gap between two taps that still counts: one beat at the slowest tempo (3 s at 20 BPM). */
export const TAP_MAX_INTERVAL_MS = 60000 / TEMPO_BPM_MIN;

/** The tempo of `tapTimes` (milliseconds, oldest first), or null with fewer than two usable taps. */
export function tapTempoBpm(tapTimes: readonly number[]): number | null {
  if (tapTimes.length < 2) return null;
  const valid: number[] = [];
  for (let i = 1; i < tapTimes.length; i += 1) {
    const ms = tapTimes[i] - tapTimes[i - 1];
    if (!(ms > 0) || !Number.isFinite(ms)) continue;
    const bpm = 60000 / ms;
    if (bpm >= TEMPO_BPM_MIN && bpm <= TEMPO_BPM_MAX) valid.push(ms);
  }
  if (valid.length === 0) return null;
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  return clampTempoBpm(Math.round(60000 / avg));
}
