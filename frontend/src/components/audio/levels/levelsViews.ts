/**
 * Canvas painters for the Levels tab's six meter views. Each takes the current
 * readings frame and draws to a 2D context. Pure drawing — no React, no state;
 * called from LevelsPanel's single rAF loop.
 */
import type { LevelsFrame } from '../../../state/levelsStore';

export interface ViewCtx {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  frame: LevelsFrame;
  lufsTarget: number;
  truePeakCeiling: number;
}

const BG = '#0b0912';
const GRID = 'rgba(255,255,255,0.08)';
const TEXT = '#cfc9dd';
const DIM = '#7a7390';
const ACCENT = '#a855f7';
const GOOD = '#34d399';
const WARN = '#f59e0b';
const HOT = '#f43f5e';

const fmt = (v: number, unit = ''): string => (Number.isFinite(v) ? v.toFixed(1) + unit : '—');
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
/** Map a dB value to 0..1 over [min,max]. */
const dbNorm = (db: number, min: number, max: number): number =>
  Number.isFinite(db) ? clamp01((db - min) / (max - min)) : 0;

function bg(v: ViewCtx): void {
  v.ctx.fillStyle = BG;
  v.ctx.fillRect(0, 0, v.w, v.h);
}

function label(v: ViewCtx, text: string, x: number, y: number, color = DIM, size = 9, align: CanvasTextAlign = 'left'): void {
  v.ctx.fillStyle = color;
  v.ctx.font = `${size}px ui-monospace, monospace`;
  v.ctx.textAlign = align;
  v.ctx.fillText(text, x, y);
}

function lufsColor(lufs: number, target: number): string {
  if (!Number.isFinite(lufs)) return DIM;
  const d = lufs - target;
  if (d > 1) return HOT;
  if (d > -1) return GOOD;
  return WARN;
}

// ── Peak ────────────────────────────────────────────────────────────────────
export function drawPeak(v: ViewCtx): void {
  bg(v);
  const { ctx, w, h, frame } = v;
  const min = -60;
  const max = 3;
  const padL = 34;
  const padR = 90;
  const top = 14;
  const barH = 18;
  const gap = 12;
  const trackW = w - padL - padR;

  const rows = [
    { name: 'PEAK', db: frame.samplePeakDb, col: ACCENT },
    { name: 'TRUE', db: frame.truePeakDb, col: '#22d3ee' },
    { name: 'RMS', db: frame.rmsDb, col: GOOD },
  ];
  rows.forEach((r, i) => {
    const y = top + i * (barH + gap);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(padL, y, trackW, barH);
    const n = dbNorm(r.db, min, max);
    ctx.fillStyle = r.col;
    ctx.fillRect(padL, y, trackW * n, barH);
    label(v, r.name, padL - 4, y + barH - 5, DIM, 9, 'right');
    label(v, fmt(r.db, ' dB'), padL + trackW + 8, y + barH - 5, TEXT, 11, 'left');
  });

  // Ceiling line + headroom readout.
  const cn = dbNorm(v.truePeakCeiling, min, max);
  const cx = padL + trackW * cn;
  ctx.strokeStyle = HOT;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, top - 4);
  ctx.lineTo(cx, top + rows.length * (barH + gap) - gap + 4);
  ctx.stroke();
  ctx.setLineDash([]);
  const headroom = Number.isFinite(frame.truePeakDb) ? v.truePeakCeiling - frame.truePeakDb : NaN;
  label(v, `ceiling ${v.truePeakCeiling.toFixed(1)} dBTP`, w - 6, h - 18, DIM, 9, 'right');
  label(v, `headroom ${fmt(headroom, ' dB')}`, w - 6, h - 6, headroom < 0 ? HOT : GOOD, 10, 'right');
}

// ── LUFS ──────────────────────────────────────────────────────────────────
export function drawLufs(v: ViewCtx): void {
  bg(v);
  const { ctx, w, h, frame, lufsTarget } = v;
  const min = -40;
  const max = 0;
  const padL = 44;
  const padR = 16;
  const top = 14;
  const barH = 20;
  const gap = 14;
  const trackW = w - padL - padR;

  const rows = [
    { name: 'M', db: frame.momentary },
    { name: 'S', db: frame.short },
    { name: 'I', db: frame.integrated },
  ];
  rows.forEach((r, i) => {
    const y = top + i * (barH + gap);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(padL, y, trackW, barH);
    const n = dbNorm(r.db, min, max);
    ctx.fillStyle = lufsColor(r.db, lufsTarget);
    ctx.fillRect(padL, y, trackW * n, barH);
    label(v, r.name, padL - 6, y + barH - 6, DIM, 11, 'right');
    label(v, `${fmt(r.db)} LUFS`, padL + 6, y + barH - 6, '#0b0912', 11, 'left');
  });

  // Target line.
  const tn = dbNorm(lufsTarget, min, max);
  const tx = padL + trackW * tn;
  ctx.strokeStyle = ACCENT;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(tx, top - 4);
  ctx.lineTo(tx, top + rows.length * (barH + gap) - gap + 4);
  ctx.stroke();
  ctx.setLineDash([]);
  label(v, `target ${lufsTarget} LUFS  ·  LRA ${fmt(frame.lra, ' LU')}`, w - 6, h - 6, DIM, 9, 'right');
  label(v, 'M omentary · S hort · I ntegrated', padL, h - 6, DIM, 8, 'left');
}

// ── Dynamic Range ───────────────────────────────────────────────────────────
const drHistory: number[] = [];
export function drawDynamicRange(v: ViewCtx): void {
  bg(v);
  const { ctx, w, h, frame } = v;
  const dr = frame.crestDb;
  drHistory.push(Number.isFinite(dr) ? dr : 0);
  if (drHistory.length > w) drHistory.shift();

  // Big DR number.
  ctx.fillStyle = TEXT;
  ctx.font = '600 40px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(fmt(dr), 14, 48);
  label(v, 'DR (crest, dB)', 16, 62, DIM, 9, 'left');

  // Crest ribbon along the bottom.
  const base = h - 10;
  const scale = 2.2;
  ctx.strokeStyle = GOOD;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  drHistory.forEach((d, i) => {
    const y = base - clamp01(d / 24) * (h * 0.5) * scale;
    if (i === 0) ctx.moveTo(i, y);
    else ctx.lineTo(i, y);
  });
  ctx.stroke();
  ctx.lineWidth = 1;
  label(v, `peak ${fmt(frame.samplePeakDb)}  rms ${fmt(frame.rmsDb)}`, w - 6, 18, DIM, 9, 'right');
}

// ── Stereo Field (goniometer + correlation) ─────────────────────────────────
export function drawStereo(v: ViewCtx): void {
  bg(v);
  const { ctx, w, h, frame } = v;
  const size = Math.min(w - 90, h - 20);
  const cx = 10 + size / 2;
  const cy = h / 2;
  const r = size / 2;

  ctx.strokeStyle = GRID;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // Scatter (rotate 45° so mono = vertical).
  const rot = Math.PI / 4;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  ctx.fillStyle = ACCENT;
  const s = frame.scope;
  for (let i = 0; i + 1 < s.length; i += 2) {
    const l = s[i];
    const rr = s[i + 1];
    const x = (l - rr) * r * cos - (l + rr) * r * sin;
    const y = (l - rr) * r * sin + (l + rr) * r * cos;
    ctx.fillRect(cx + x * 0.7, cy - y * 0.7, 1.4, 1.4);
  }

  // Correlation strip.
  const bx = cx + r + 16;
  const bw = w - bx - 12;
  const by = cy - 8;
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(bx, by, bw, 16);
  const corr = Number.isFinite(frame.correlation) ? frame.correlation : 0;
  const mid = bx + bw / 2;
  ctx.fillStyle = corr < 0 ? HOT : corr < 0.4 ? WARN : GOOD;
  ctx.fillRect(mid, by, (bw / 2) * corr, 16);
  ctx.strokeStyle = GRID;
  ctx.beginPath();
  ctx.moveTo(mid, by - 3);
  ctx.lineTo(mid, by + 19);
  ctx.stroke();
  label(v, 'correlation', bx, by - 6, DIM, 9, 'left');
  label(v, corr.toFixed(2), bx + bw, by + 30, TEXT, 12, 'right');
  label(v, '-1', bx, by + 30, DIM, 8, 'left');
  label(v, '+1', bx + bw, by - 6, DIM, 8, 'right');
}

// ── Bass Space (per-band histogram) ─────────────────────────────────────────
export function drawBass(v: ViewCtx): void {
  bg(v);
  const { ctx, w, h, frame } = v;
  const bands = frame.bands;
  const freqs = frame.bandFreqs;
  if (!bands.length) {
    label(v, 'band metering needs the worklet', w / 2, h / 2, DIM, 10, 'center');
    return;
  }
  const min = -60;
  const max = 0;
  const padL = 12;
  const padR = 12;
  const top = 14;
  const bottom = h - 20;
  const n = bands.length;
  const slot = (w - padL - padR) / n;
  bands.forEach((db, i) => {
    const x = padL + i * slot + 4;
    const bw = slot - 8;
    const nn = dbNorm(db, min, max);
    const bh = (bottom - top) * nn;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(x, top, bw, bottom - top);
    const g = ctx.createLinearGradient(0, bottom, 0, top);
    g.addColorStop(0, '#22d3ee');
    g.addColorStop(1, ACCENT);
    ctx.fillStyle = g;
    ctx.fillRect(x, bottom - bh, bw, bh);
    label(v, `${freqs[i] ?? '?'}Hz`, x + bw / 2, bottom + 14, DIM, 9, 'center');
    label(v, fmt(db), x + bw / 2, top + 10, TEXT, 9, 'center');
  });
}

// ── Radial (combined) ───────────────────────────────────────────────────────
export function drawRadial(v: ViewCtx): void {
  bg(v);
  const { ctx, w, h, frame, lufsTarget } = v;
  const cx = w / 2;
  const cy = h / 2;
  const rOuter = Math.min(w, h) / 2 - 16;
  const rInner = rOuter * 0.42;

  const spokes = [
    { name: 'PEAK', val: dbNorm(frame.samplePeakDb, -60, 3), col: ACCENT, text: fmt(frame.samplePeakDb) },
    { name: 'LUFS', val: dbNorm(frame.momentary, -40, 0), col: lufsColor(frame.momentary, lufsTarget), text: fmt(frame.momentary) },
    { name: 'LRA', val: clamp01(frame.lra / 20), col: '#22d3ee', text: fmt(frame.lra) },
    { name: 'DR', val: clamp01(frame.crestDb / 24), col: GOOD, text: fmt(frame.crestDb) },
    { name: 'FIELD', val: clamp01((frame.correlation + 1) / 2), col: WARN, text: (Number.isFinite(frame.correlation) ? frame.correlation.toFixed(2) : '—') },
    { name: 'BASS', val: frame.bands.length ? dbNorm(frame.bands[1] ?? frame.bands[0], -60, 0) : 0, col: '#fb7185', text: frame.bands.length ? fmt(frame.bands[1] ?? frame.bands[0]) : '—' },
  ];
  const step = (Math.PI * 2) / spokes.length;
  ctx.strokeStyle = GRID;
  ctx.beginPath();
  ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
  ctx.stroke();

  spokes.forEach((s, i) => {
    const ang = -Math.PI / 2 + i * step;
    const x0 = cx + Math.cos(ang) * rInner;
    const y0 = cy + Math.sin(ang) * rInner;
    const rr = rInner + (rOuter - rInner) * clamp01(s.val);
    const x1 = cx + Math.cos(ang) * rr;
    const y1 = cy + Math.sin(ang) * rr;
    // full-length track
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(cx + Math.cos(ang) * rOuter, cy + Math.sin(ang) * rOuter);
    ctx.stroke();
    // value
    ctx.strokeStyle = s.col;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    // labels at the rim
    const lx = cx + Math.cos(ang) * (rOuter + 4);
    const ly = cy + Math.sin(ang) * (rOuter + 4);
    ctx.textAlign = Math.cos(ang) > 0.2 ? 'left' : Math.cos(ang) < -0.2 ? 'right' : 'center';
    label(v, s.name, lx, ly, DIM, 8, ctx.textAlign);
    label(v, s.text, lx, ly + 10, TEXT, 10, ctx.textAlign);
  });
  ctx.lineWidth = 1;

  // Center integrated LUFS.
  ctx.textAlign = 'center';
  ctx.fillStyle = TEXT;
  ctx.font = '600 22px ui-monospace, monospace';
  ctx.fillText(fmt(frame.integrated), cx, cy + 2);
  label(v, 'LUFS integrated', cx, cy + 16, DIM, 8, 'center');
}
