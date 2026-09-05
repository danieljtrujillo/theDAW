/**
 * Meter bridge model — scale constants, dB helpers and per-channel ballistics
 * for the Levels tab. Pure arithmetic (no DOM, no React, no audio graph): the
 * panel's rAF loop feeds each BarMeter the analyser window's peak / RMS once
 * per frame and the painters read the resulting display values.
 *
 * Ballistics follow the digital PPM convention (IEC 60268-18): instant
 * attack, a 20 dB / 1.7 s fall on the peak marker, a 1.5 s peak hold that then
 * falls at 20 dB/s, and a ~150 ms integration on the RMS fill.
 */

export const METER_MIN_DB = -60;
export const METER_MAX_DB = 0;
/** Labelled ticks on the dBFS scale, top to bottom. */
export const METER_TICKS: readonly number[] = [0, -3, -6, -12, -18, -24, -36, -48, -60];
/** Conventional colour zones: green below -18, amber to -6, red to 0 dBFS. */
export const ZONE_AMBER_DB = -18;
export const ZONE_RED_DB = -6;
/** A sample at or above -0.01 dBFS counts as a clip. */
export const CLIP_DB = -0.01;

const PEAK_FALL_DB_PER_S = 20 / 1.7;
const HOLD_SECONDS = 1.5;
const HOLD_FALL_DB_PER_S = 20;
const RMS_TAU_S = 0.15;
const STEREO_TAU_S = 0.25;
/** Below this a falling marker is treated as silent instead of decaying forever. */
const FLOOR_DB = METER_MIN_DB - 12;

export const toDb = (lin: number): number => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Position of `db` on the meter scale: 0 at the floor, 1 at 0 dBFS. */
export const dbToNorm = (db: number, min = METER_MIN_DB, max = METER_MAX_DB): number =>
  Number.isFinite(db) ? clamp01((db - min) / (max - min)) : 0;

/** Format a level: NaN → '—' (no reading), -Infinity → '-∞', else fixed decimals. */
export function fmtLevel(v: number, plus = false, digits = 1): string {
  if (Number.isNaN(v)) return '—';
  if (v === -Infinity) return '-∞';
  if (v === Infinity) return '+∞';
  const r = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v;
  return (plus && r > 0 ? '+' : '') + r.toFixed(digits);
}

/** Signed difference readout ('+1.2', '-0.4', '0.0'). */
export const fmtSigned = (v: number, digits = 1): string => fmtLevel(v, true, digits);

/** Balance readout from an L-R level difference in dB (positive = left louder). */
export function fmtBalance(balanceDb: number): string {
  if (!Number.isFinite(balanceDb) || Math.abs(balanceDb) < 0.05) return 'C';
  return `${balanceDb > 0 ? 'L' : 'R'} ${Math.abs(balanceDb).toFixed(1)} dB`;
}

export class BarMeter {
  /** Smoothed RMS level driving the bar fill (dBFS). */
  rmsDb = -Infinity;
  /** Falling peak marker (dBFS). */
  peakDb = -Infinity;
  /** Peak-hold marker: holds HOLD_SECONDS, then falls (dBFS). */
  holdDb = -Infinity;
  /** Highest peak since the last reset (dBFS) — the numeric readout. */
  maxDb = -Infinity;
  /** Latched clip indicator; cleared by resetHold(). */
  clipped = false;

  private rmsPow = 0;
  private holdAge = 0;

  /** Advance by `dt` seconds with the analyser window's linear peak and RMS. */
  update(peakLin: number, rmsLin: number, dt: number): void {
    const pDb = toDb(peakLin);

    const a = 1 - Math.exp(-dt / RMS_TAU_S);
    this.rmsPow += (rmsLin * rmsLin - this.rmsPow) * a;
    this.rmsDb = this.rmsPow > 1e-12 ? 10 * Math.log10(this.rmsPow) : -Infinity;

    if (pDb >= this.peakDb) this.peakDb = pDb;
    else this.peakDb = Math.max(pDb, this.peakDb - PEAK_FALL_DB_PER_S * dt);
    if (this.peakDb < FLOOR_DB) this.peakDb = -Infinity;

    if (pDb >= this.holdDb) {
      this.holdDb = pDb;
      this.holdAge = 0;
    } else {
      this.holdAge += dt;
      if (this.holdAge > HOLD_SECONDS) this.holdDb = Math.max(pDb, this.holdDb - HOLD_FALL_DB_PER_S * dt);
      if (this.holdDb < FLOOR_DB) this.holdDb = -Infinity;
    }

    if (pDb > this.maxDb) this.maxDb = pDb;
    if (pDb >= CLIP_DB) this.clipped = true;
  }

  /** Clear the peak-hold readout and the clip latch (click on the meter). */
  resetHold(): void {
    this.maxDb = -Infinity;
    this.holdDb = -Infinity;
    this.holdAge = 0;
    this.clipped = false;
  }
}

export class StereoMeter {
  /** Smoothed inter-channel correlation, -1 … +1 (rests at +1 in silence). */
  correlation = 1;
  /** Smoothed L-R level difference in dB (positive = left louder). */
  balanceDb = 0;

  update(correlation: number, rmsL: number, rmsR: number, dt: number): void {
    const a = 1 - Math.exp(-dt / STEREO_TAU_S);
    const silent = rmsL < 1e-5 && rmsR < 1e-5; // both below ≈ -100 dBFS
    if (silent) {
      const slow = 1 - Math.exp(-dt / 1.5);
      this.correlation += (1 - this.correlation) * slow;
      this.balanceDb += (0 - this.balanceDb) * slow;
      return;
    }
    if (Number.isFinite(correlation)) this.correlation += (correlation - this.correlation) * a;
    const l = Math.max(rmsL, 1e-5);
    const r = Math.max(rmsR, 1e-5);
    const b = Math.max(-24, Math.min(24, 20 * Math.log10(l / r)));
    this.balanceDb += (b - this.balanceDb) * a;
  }
}
