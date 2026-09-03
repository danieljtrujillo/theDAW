/**
 * Canvas painters for the Levels meter bridge: the stereo bar meters, the
 * short-term loudness history strip, and the correlation / balance meters.
 * Pure drawing in local CSS px — no React, no state; called from LevelsPanel's
 * single rAF loop. Colours are the app's dark-chrome palette (zinc text on the
 * #0b0912 panel) with the shared semantic accents (emerald / amber / rose for
 * the level zones, purple for the target).
 */
import type { LoudnessHistory } from '../../../state/levelsStore';
import type { BarMeter, StereoMeter } from './meterModel';
import {
  METER_MIN_DB,
  METER_MAX_DB,
  METER_TICKS,
  ZONE_AMBER_DB,
  ZONE_RED_DB,
  CLIP_DB,
  dbToNorm,
  clamp01,
  fmtSigned,
  fmtBalance,
} from './meterModel';

const BG = '#0b0912';
const TRACK = 'rgba(255,255,255,0.05)';
const PLOT = 'rgba(255,255,255,0.025)';
const GRID = 'rgba(255,255,255,0.08)';
const EDGE = 'rgba(255,255,255,0.07)';
const LADDER = 'rgba(11,9,18,0.55)';
const DIM = '#71717a'; // zinc-500
const FAINT = '#52525b'; // zinc-600
const BRIGHT = '#e4e4e7'; // zinc-200
const ACCENT = '#a855f7'; // purple-500
const ACCENT_TEXT = '#c084fc'; // purple-400
const GOOD = '#34d399'; // emerald-400
const WARN = '#f59e0b'; // amber-500
const HOT = '#f43f5e'; // rose-500
const GOOD_HI = '#6ee7b7'; // emerald-300
const WARN_HI = '#fcd34d'; // amber-300
const HOT_HI = '#fda4af'; // rose-300
const FONT = '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace';
const font = (px: number, weight = 400): string => `${weight} ${px}px ${FONT}`;

/**
 * Bar-meter column geometry, in px. LevelsPanel's clip-LED and peak-hold rows
 * are CSS grids built from the same numbers (`grid-cols-[2.25rem_1fr_1fr]
 * gap-x-1 pr-1.5`), which is what keeps the DOM rows aligned to the bars.
 */
export const METER_SCALE_W = 36;
export const METER_GAP = 4;
export const METER_PAD_R = 6;
const METER_PAD_TOP = 8;
const METER_PAD_BOTTOM = 8;

const zoneColorHi = (db: number): string => (db >= ZONE_RED_DB ? HOT_HI : db >= ZONE_AMBER_DB ? WARN_HI : GOOD_HI);

const ZONES: ReadonlyArray<{ lo: number; hi: number; col: string }> = [
  { lo: METER_MIN_DB, hi: ZONE_AMBER_DB, col: GOOD },
  { lo: ZONE_AMBER_DB, hi: ZONE_RED_DB, col: WARN },
  { lo: ZONE_RED_DB, hi: METER_MAX_DB, col: HOT },
];

function hline(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

// ── Stereo bar meters ───────────────────────────────────────────────────────
export interface BarPaint {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  left: BarMeter;
  right: BarMeter;
}

export function drawBarMeters({ ctx, w, h, left, right }: BarPaint): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  const top = METER_PAD_TOP;
  const bottom = h - METER_PAD_BOTTOM;
  const span = bottom - top;
  if (span < 24 || w < METER_SCALE_W + 24) return;

  const barW = Math.max(8, (w - METER_SCALE_W - METER_GAP * 2 - METER_PAD_R) / 2);
  const xL = METER_SCALE_W + METER_GAP;
  const xR = xL + barW + METER_GAP;
  const yOf = (db: number): number => bottom - dbToNorm(db) * span;

  // Scale: ticks flank the pair; labels sit left of the L bar, thinned when
  // the panel is too short for -3 / -6 to keep clear of 0.
  ctx.font = font(10);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  let lastLabelY = -Infinity;
  for (const t of METER_TICKS) {
    const y = Math.round(yOf(t)) + 0.5;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(xL - 4, y);
    ctx.lineTo(xL - 1, y);
    ctx.moveTo(xR + barW + 1, y);
    ctx.lineTo(xR + barW + 4, y);
    ctx.stroke();
    if (Math.abs(y - lastLabelY) >= 11) {
      ctx.fillStyle = t === 0 ? BRIGHT : DIM;
      ctx.fillText(String(t), xL - 7, y);
      lastLabelY = y;
    }
  }

  drawBar(ctx, xL, barW, top, bottom, left, yOf);
  drawBar(ctx, xR, barW, top, bottom, right, yOf);
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  bw: number,
  top: number,
  bottom: number,
  m: BarMeter,
  yOf: (db: number) => number,
): void {
  ctx.fillStyle = TRACK;
  ctx.fillRect(x, top, bw, bottom - top);

  // Unlit zones: a dim ladder so the green / amber / red bands read even at rest.
  ctx.globalAlpha = 0.12;
  for (const z of ZONES) {
    ctx.fillStyle = z.col;
    ctx.fillRect(x, yOf(z.hi), bw, yOf(z.lo) - yOf(z.hi));
  }
  ctx.globalAlpha = 1;

  // RMS fill, coloured per zone.
  const rms = m.rmsDb;
  if (rms > METER_MIN_DB) {
    for (const z of ZONES) {
      if (rms <= z.lo) continue;
      const hi = Math.min(rms, z.hi);
      ctx.fillStyle = z.col;
      ctx.fillRect(x, yOf(hi), bw, yOf(z.lo) - yOf(hi));
    }
  }

  // Segment hairlines every 3 dB (LED-ladder look).
  ctx.fillStyle = LADDER;
  for (let db = METER_MIN_DB + 3; db < METER_MAX_DB; db += 3) {
    ctx.fillRect(x, Math.round(yOf(db)), bw, 1);
  }

  // Falling peak marker, then the peak-hold line on top.
  if (m.peakDb > METER_MIN_DB) {
    ctx.fillStyle = zoneColorHi(m.peakDb);
    ctx.fillRect(x, Math.round(yOf(m.peakDb)) - 1, bw, 2);
  }
  if (m.holdDb > METER_MIN_DB) {
    ctx.fillStyle = m.holdDb >= CLIP_DB ? HOT : BRIGHT;
    ctx.fillRect(x, Math.round(yOf(m.holdDb)) - 1, bw, 2);
  }

  ctx.strokeStyle = EDGE;
  ctx.strokeRect(x + 0.5, top + 0.5, bw - 1, bottom - top - 1);
}

// ── Short-term loudness history (last 60 s) ─────────────────────────────────
export interface HistoryPaint {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  history: LoudnessHistory;
  target: number;
}

export function drawLoudnessHistory({ ctx, w, h, history, target }: HistoryPaint): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  const pl = 8;
  const pr = w - 34;
  const pt = 8;
  const pb = h - 16;
  const pw = pr - pl;
  const ph = pb - pt;
  if (pw < 40 || ph < 24) return;

  // A 30 LU window with the target two-thirds of the way up.
  const hi = Math.min(0, target + 10);
  const lo = hi - 30;
  const yOf = (lufs: number): number => pb - clamp01((lufs - lo) / (hi - lo)) * ph;

  ctx.fillStyle = PLOT;
  ctx.fillRect(pl, pt, pw, ph);

  // Level grid every 5 LU, labelled on the right.
  ctx.font = font(10);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
  for (let v = Math.ceil(lo / 5) * 5; v <= hi; v += 5) {
    const y = Math.round(yOf(v)) + 0.5;
    ctx.strokeStyle = GRID;
    hline(ctx, pl, pr, y);
    ctx.fillStyle = FAINT;
    ctx.fillText(String(v), pr + 5, y);
  }

  // Time ticks every 10 s, labelled at -60 / -30 / now.
  ctx.textBaseline = 'alphabetic';
  for (let s = 0; s <= 60; s += 10) {
    const x = Math.round(pr - (s / 60) * pw) + 0.5;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(x, pb);
    ctx.lineTo(x, pb + 3);
    ctx.stroke();
    if (s % 30 === 0) {
      ctx.fillStyle = FAINT;
      ctx.textAlign = s === 0 ? 'right' : s === 60 ? 'left' : 'center';
      ctx.fillText(s === 0 ? 'now' : `-${s}s`, x, h - 4);
    }
  }

  // Trace: newest sample at the right edge; silent slots drop the area to
  // the floor and break the line.
  const { buf, head, count, slots } = history;
  const dx = pw / (slots - 1);
  const area = new Path2D();
  const line = new Path2D();
  let pen = false;
  let lastX = pr;
  let lastY = NaN;
  for (let i = 0; i < count; i += 1) {
    const v = buf[(head - count + i + slots) % slots];
    const x = pr - (count - 1 - i) * dx;
    const finite = v > -Infinity && v === v;
    const y = finite ? yOf(v) : pb;
    if (i === 0) {
      area.moveTo(x, pb);
      area.lineTo(x, y);
    } else {
      area.lineTo(x, y);
    }
    if (finite) {
      if (pen) line.lineTo(x, y);
      else line.moveTo(x, y);
      pen = true;
    } else {
      pen = false;
    }
    lastX = x;
    lastY = finite ? y : NaN;
  }
  const yT = yOf(target);
  if (count > 0) {
    area.lineTo(lastX, pb);
    area.closePath();
    ctx.fillStyle = 'rgba(52,211,153,0.18)';
    ctx.fill(area);
    // Excursions above the target light up red.
    ctx.save();
    ctx.beginPath();
    ctx.rect(pl, pt, pw, Math.max(0, yT - pt));
    ctx.clip();
    ctx.fillStyle = 'rgba(244,63,94,0.35)';
    ctx.fill(area);
    ctx.restore();
    ctx.strokeStyle = GOOD;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke(line);
    ctx.lineWidth = 1;
  }

  // Target line.
  const yTl = Math.round(yT) + 0.5;
  ctx.strokeStyle = ACCENT;
  ctx.setLineDash([4, 3]);
  hline(ctx, pl, pr, yTl);
  ctx.setLineDash([]);
  ctx.fillStyle = ACCENT_TEXT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`target ${target}`, pl + 4, yTl - 2);

  if (Number.isFinite(lastY)) {
    ctx.fillStyle = GOOD;
    ctx.beginPath();
    ctx.arc(pr, lastY, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Correlation + balance ───────────────────────────────────────────────────
export interface StereoPaint {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  stereo: StereoMeter;
}

const corrColor = (c: number): string => (c < 0 ? HOT : c < 0.4 ? WARN : GOOD);

export function drawStereoMeters({ ctx, w, h, stereo }: StereoPaint): void {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  const padX = 10;
  const labelW = 44;
  const valueW = 68;
  const x0 = padX + labelW;
  const x1 = w - padX - valueW;
  const tw = x1 - x0;
  if (tw < 40 || h < 40) return;
  const rowH = h / 2;
  const mid = x0 + tw / 2;

  const row = (yc: number, label: string, ticks: [string, string, string], value: string): void => {
    ctx.font = font(11);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = DIM;
    ctx.fillText(label, padX, yc);
    ctx.fillStyle = TRACK;
    ctx.fillRect(x0, yc - 4, tw, 8);
    ctx.strokeStyle = EDGE;
    ctx.strokeRect(x0 + 0.5, yc - 3.5, tw - 1, 7);
    ctx.strokeStyle = GRID;
    for (const fx of [0, 0.25, 0.5, 0.75, 1]) {
      const x = Math.round(x0 + tw * fx) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, yc + 5);
      ctx.lineTo(x, yc + 8);
      ctx.stroke();
    }
    ctx.font = font(10);
    ctx.fillStyle = FAINT;
    ctx.textAlign = 'left';
    ctx.fillText(ticks[0], x0, yc + 14);
    ctx.textAlign = 'center';
    ctx.fillText(ticks[1], mid, yc + 14);
    ctx.textAlign = 'right';
    ctx.fillText(ticks[2], x1, yc + 14);
    ctx.font = font(11);
    ctx.fillStyle = BRIGHT;
    ctx.fillText(value, w - padX, yc);
  };

  // Correlation: fill from the centre, -1 … +1.
  const yc1 = rowH * 0.5;
  const corr = Math.max(-1, Math.min(1, stereo.correlation));
  row(yc1, 'CORR', ['-1', '0', '+1'], fmtSigned(corr, 2));
  ctx.fillStyle = corrColor(corr);
  const cw = (tw / 2) * corr;
  ctx.fillRect(cw >= 0 ? mid : mid + cw, yc1 - 3, Math.abs(cw), 6);
  ctx.fillStyle = BRIGHT;
  ctx.fillRect(Math.round(mid) - 1, yc1 - 6, 2, 12);

  // Balance: a needle, ±6 dB full scale (positive dB = left louder = leftward).
  const yc2 = rowH * 1.5;
  const pos = Math.max(-1, Math.min(1, -stereo.balanceDb / 6));
  row(yc2, 'BAL', ['L', 'C', 'R'], fmtBalance(stereo.balanceDb));
  ctx.fillStyle = FAINT;
  ctx.fillRect(Math.round(mid) - 1, yc2 - 6, 2, 12);
  const nx = mid + (tw / 2) * pos;
  ctx.fillStyle = Math.abs(stereo.balanceDb) > 3 ? WARN : ACCENT;
  ctx.fillRect(Math.round(nx) - 1.5, yc2 - 7, 3, 14);
}
