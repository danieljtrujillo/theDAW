/**
 * tendril — a living strand that GROWS between two cells and stays attached.
 *
 * Not a curve. A Verlet rope (Jakobsen position-based dynamics) with distance
 * constraints, simulated in the dish's own local space on a fixed timestep, so
 * it has inertia: it sags, swings, overshoots and settles as the cells drift,
 * and goes taut when they pull apart. What makes it read as biological rather
 * than as a wire:
 *
 *   slack, not gravity   a top-down dish has no "down", so the sag comes from
 *                        a rest length LONGER than the gap (plus a sideways
 *                        bow whose sign is hashed off the edge, so two strands
 *                        between the same cells bow apart instead of overlapping).
 *   a rest that creeps   the rest length eases toward its target over seconds,
 *                        so pulling two cells apart pulls the strand taut and it
 *                        only slowly gives. That lag is the slime-mould creep.
 *   a spine, not a chain a weak i→i+2 constraint stops it kinking like a necklace.
 *   an anchor that slides the attachment point eases around the membrane with a
 *                        slew cap, aiming at the strand's OWN next point — so
 *                        the strand swings, the root slides, and the swing changes.
 *   buried ends          both ends sit INSIDE the membrane (never abutting it),
 *                        and leave it along the normal, like a pseudopod.
 *   it grows             a new strand creeps out of one cell with the hyphal
 *                        wander from hyphae.ts, finds the other, and fuses.
 *
 * Everything here is in the dish's LOCAL space (the same units as a Body's pos
 * and radius). Screen conversion happens once per frame at draw time, so
 * panning and zooming never yank the physics.
 */

export interface Pt { x: number; y: number; px: number; py: number }

export interface Rope {
  pts: Pt[];
  /** Segment count (pts.length - 1). */
  n: number;
  /** Current rest length per segment; eases toward the slack target. */
  rest: number;
  /** 0..1 — how much of the strand has grown out of the source cell. */
  grow: number;
  /** Index of the live tip while growing (== n once fused). */
  live: number;
  /** Anchor angles on each cell, eased. */
  thA: number | null;
  thB: number | null;
  aPrev: { x: number; y: number };
  bPrev: { x: number; y: number };
  /** Which way it bows, hashed off the edge key. */
  bow: number;
  /** performance.now() it appeared, for the fusion bloom. */
  born: number;
  /** Fixed-step accumulator. */
  acc: number;
  /** Self-loop (a cell wired to itself): both ends on the same body. */
  self: boolean;
}

/** Physics step. Small and fixed so the strand behaves the same on any display. */
const H = 1 / 120;
const MAX_SUB = 4;
/** Target segment length in dish-local units. */
const SEG_LEN = 18;
const MIN_N = 6;
const MAX_N = 26;
const ITER = 3;
const ITER_JOLT = 9;
/** Velocity kept per 60 Hz step — low, so the strand moves like syrup. */
const DRAG60 = 0.12;
const BEND_K = 0.12;
const MAX_STRETCH = 1.15;
/** How fast the rest length gives (per second). Small = slow creep. */
const CREEP = 0.5;
/** Seconds for a new strand to reach across and fuse. */
export const GROW_SEC = 6.5;

export interface Field {
  /** Sideways bow acceleration, local units/s². */
  bowX: number;
  bowY: number;
  /** Outward normal at the source anchor. */
  nAx: number;
  nAy: number;
  /** The source cell's muscle phase, so the slack breathes with it. */
  phase: number;
}

export function makeRope(ax: number, ay: number, bx: number, by: number, n: number, bow: number, now: number, self = false): Rope {
  const pts: Pt[] = [];
  let nx = -(by - ay);
  let ny = bx - ax;
  const nl = Math.hypot(nx, ny) || 1;
  nx /= nl;
  ny /= nl;
  for (let i = 0; i <= n; i += 1) {
    const u = i / n;
    // Start bowed — a strand is never a straight line, not even on its first frame.
    const b = Math.sin(u * Math.PI) * nl * 0.16 * bow;
    const x = ax + (bx - ax) * u + nx * b;
    const y = ay + (by - ay) * u + ny * b;
    pts.push({ x, y, px: x, py: y });
  }
  return {
    pts, n, rest: (nl * 1.18) / n, grow: 0, live: 2,
    thA: null, thB: null, aPrev: { x: ax, y: ay }, bPrev: { x: bx, y: by },
    bow, born: now, acc: 0, self,
  };
}

/* ── resampling: segment count follows the span, with hysteresis ────────── */

function resample(rope: Rope, n: number): void {
  const old = rope.pts;
  if (old.length - 1 === n) return;
  const cum = [0];
  for (let i = 1; i < old.length; i += 1) cum.push(cum[i - 1] + Math.hypot(old[i].x - old[i - 1].x, old[i].y - old[i - 1].y));
  const total = cum[cum.length - 1] || 1;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i += 1) {
    const s = (i / n) * total;
    let j = 1;
    while (j < cum.length - 1 && cum[j] < s) j += 1;
    const t = (s - cum[j - 1]) / ((cum[j] - cum[j - 1]) || 1);
    const A = old[j - 1];
    const B = old[j];
    const x = A.x + (B.x - A.x) * t;
    const y = A.y + (B.y - A.y) * t;
    // Carry the velocity through, or the strand dies every time the count changes.
    const vx = (A.x - A.px) * (1 - t) + (B.x - B.px) * t;
    const vy = (A.y - A.py) * (1 - t) + (B.y - B.py) * t;
    out.push({ x, y, px: x - vx, py: y - vy });
  }
  // Rest is PER SEGMENT, so it has to be rescaled or the strand's total
  // length jumps with the segment count — a rope that suddenly goes slack
  // (or snaps taut) for no reason the eye can connect to anything.
  const oldN = old.length - 1;
  if (oldN > 0) rope.rest = (rope.rest * oldN) / n;
  rope.pts = out;
  rope.n = n;
  rope.live = rope.grow >= 1 ? n : Math.max(2, Math.min(n, Math.round(rope.grow * n)));
}

function retarget(rope: Rope, dist: number): void {
  const ideal = dist / SEG_LEN;
  // Hysteresis: without it the count flickers as the cells breathe.
  if (Math.abs(ideal - rope.n) < 1.5) return;
  resample(rope, Math.max(MIN_N, Math.min(MAX_N, Math.round(ideal))));
}

/* ── constraints ────────────────────────────────────────────────────────── */

function solveDist(a: Pt, b: Pt, rest: number, k: number, aFix: boolean, bFix: boolean): void {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d = Math.hypot(dx, dy);
  // Coincident points would make a NaN normal, and one NaN poisons the whole
  // rope forever because Verlet feeds position back into itself.
  if (d < 1e-6) { dx = 1e-3; dy = 0; d = 1e-3; }
  let diff = ((d - rest) / d) * k;
  const mag = Math.abs(diff) * d;
  if (mag > rest * 0.5) diff *= (rest * 0.5) / mag;
  const wa = aFix ? 0 : 1;
  const wb = bFix ? 0 : 1;
  const w = wa + wb;
  if (!w) return;
  a.x += dx * diff * (wa / w); a.y += dy * diff * (wa / w);
  b.x -= dx * diff * (wb / w); b.y -= dy * diff * (wb / w);
}

/** Pin a point AND hand it the anchor's velocity, or the strand never whips. */
function pin(p: Pt, x: number, y: number, prevX: number, prevY: number): void {
  p.x = x; p.y = y; p.px = prevX; p.py = prevY;
}

function substep(rope: Rope, A: { x: number; y: number }, Ap: { x: number; y: number }, B: { x: number; y: number } | null, Bp: { x: number; y: number } | null, f: Field, iters: number): void {
  const pts = rope.pts;
  const last = rope.live;
  const damp = Math.pow(1 - DRAG60, H * 60);
  const cap = rope.rest * 0.8;
  const ax = f.bowX * H * H;
  const ay = f.bowY * H * H;

  for (let i = 1; i < last; i += 1) {
    const p = pts[i];
    let vx = (p.x - p.px) * damp;
    let vy = (p.y - p.py) * damp;
    const v = Math.hypot(vx, vy);
    if (v > cap) { vx *= cap / v; vy *= cap / v; }
    p.px = p.x; p.py = p.y;
    p.x += vx + ax; p.y += vy + ay;
  }

  pin(pts[0], A.x, A.y, Ap.x, Ap.y);
  if (B && Bp) pin(pts[last], B.x, B.y, Bp.x, Bp.y);

  for (let k = 0; k < iters; k += 1) {
    const omega = k < iters - 1 ? 1.4 : 1.0;
    for (let i = 0; i < last; i += 1) solveDist(pts[i], pts[i + 1], rope.rest, omega, i === 0, B != null && i + 1 === last);
    for (let i = 0; i + 2 <= last; i += 1) solveDist(pts[i], pts[i + 2], rope.rest * 1.85, BEND_K, i === 0, B != null && i + 2 === last);
    // Leave the membrane along its normal, like a pseudopod, not at a shear angle.
    if (last >= 2) {
      const t = pts[1];
      t.x += (A.x + f.nAx * rope.rest - t.x) * 0.15;
      t.y += (A.y + f.nAy * rope.rest - t.y) * 0.15;
    }
    pin(pts[0], A.x, A.y, Ap.x, Ap.y);
    if (B && Bp) pin(pts[last], B.x, B.y, Bp.x, Bp.y);
  }
}

/** The hyphal tip walk (constants from hyphae.ts) while the strand reaches out. */
function growTip(rope: Rope, target: { x: number; y: number }, wander: number): void {
  const tip = rope.pts[rope.live];
  if (!tip) return;
  let ang = Math.atan2(tip.y - tip.py, tip.x - tip.px);
  if (!Number.isFinite(ang) || (tip.x === tip.px && tip.y === tip.py)) ang = Math.atan2(target.y - tip.y, target.x - tip.x);
  ang += (wander - 0.5) * 0.17;
  const want = Math.atan2(target.y - tip.y, target.x - tip.x);
  let d = want - ang;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  ang += d * 0.10;
  const step = rope.rest * 0.10;
  tip.px = tip.x; tip.py = tip.y;
  tip.x += Math.cos(ang) * step;
  tip.y += Math.sin(ang) * step;
}

/**
 * Advance one strand. `A`/`B` are the anchor points ON the two membranes, in
 * dish-local space; `dt` is real seconds.
 */
export function stepRope(rope: Rope, dt: number, A: { x: number; y: number }, B: { x: number; y: number }, f: Field, wander: number): void {
  const span = Math.hypot(B.x - A.x, B.y - A.y) || 1;
  retarget(rope, rope.self ? Math.max(span, SEG_LEN * MIN_N) : span);

  if (rope.grow < 1) {
    rope.grow = Math.min(1, rope.grow + dt / GROW_SEC);
    rope.live = Math.max(2, Math.ceil(rope.grow * rope.n));
    // Unborn points ride the tip, so each one is drawn OUT of it, never popped in.
    const tip = rope.pts[rope.live];
    if (tip) for (let i = rope.live + 1; i <= rope.n; i += 1) { const p = rope.pts[i]; p.x = p.px = tip.x; p.y = p.py = tip.y; }
  } else {
    rope.live = rope.n;
  }

  // The rest length CREEPS toward slack: taut first, giving later.
  const slack = (rope.self ? 1.9 : 1.12) + 0.14 * (0.5 + 0.5 * Math.sin(f.phase));
  const want = (span * slack) / rope.n;
  rope.rest += (want - rope.rest) * (1 - Math.exp(-CREEP * dt));
  const need = span / rope.n;
  if (rope.rest * MAX_STRETCH < need) rope.rest = need / MAX_STRETCH;

  // A big anchor jump is a transition (a dive, a re-parent), not a drag —
  // relaxing it away would explode; re-seeding is invisible.
  const jumpA = Math.hypot(A.x - rope.aPrev.x, A.y - rope.aPrev.y);
  const jumpB = Math.hypot(B.x - rope.bPrev.x, B.y - rope.bPrev.y);
  if (Math.max(jumpA, jumpB) > rope.rest * rope.n * 0.5) {
    const g = rope.grow;
    const born = rope.born;
    const seeded = makeRope(A.x, A.y, B.x, B.y, rope.n, rope.bow, born, rope.self);
    rope.pts = seeded.pts; rope.rest = seeded.rest; rope.thA = null; rope.thB = null;
    rope.grow = g; rope.live = g >= 1 ? rope.n : Math.max(2, Math.ceil(g * rope.n));
  }
  const iters = Math.max(jumpA, jumpB) > rope.rest ? ITER_JOLT : ITER;

  rope.acc = Math.min(rope.acc + dt, H * MAX_SUB);
  let s = 0;
  while (rope.acc >= H) {
    rope.acc -= H;
    s += 1;
    // Anchors lerp across the substeps, so a fast drag arrives as several small
    // moves rather than one teleport.
    const u0 = (s - 1) / MAX_SUB;
    const u1 = s / MAX_SUB;
    const a0 = { x: rope.aPrev.x + (A.x - rope.aPrev.x) * u0, y: rope.aPrev.y + (A.y - rope.aPrev.y) * u0 };
    const a1 = { x: rope.aPrev.x + (A.x - rope.aPrev.x) * u1, y: rope.aPrev.y + (A.y - rope.aPrev.y) * u1 };
    const b0 = { x: rope.bPrev.x + (B.x - rope.bPrev.x) * u0, y: rope.bPrev.y + (B.y - rope.bPrev.y) * u0 };
    const b1 = { x: rope.bPrev.x + (B.x - rope.bPrev.x) * u1, y: rope.bPrev.y + (B.y - rope.bPrev.y) * u1 };
    const fused = rope.grow >= 1;
    substep(rope, a1, a0, fused ? b1 : null, fused ? b0 : null, f, iters);
    if (!fused) growTip(rope, B, wander);
  }
  rope.aPrev = { x: A.x, y: A.y };
  rope.bPrev = { x: B.x, y: B.y };
}

/**
 * Ease an anchor angle around a membrane. `toward` is the strand's OWN next
 * point, not the other cell — that closes the loop between the swing and the
 * attachment, and the slew cap is what makes it lag like something alive.
 */
export function easeAngle(prev: number | null, toward: { x: number; y: number }, at: { x: number; y: number }, dt: number): number {
  const th = Math.atan2(toward.y - at.y, toward.x - at.x);
  if (prev == null || !Number.isFinite(prev)) return th;
  let d = th - prev;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const eased = d * (1 - Math.exp(-3.5 * dt));
  const cap = 1.1 * dt;
  return prev + Math.max(-cap, Math.min(cap, eased));
}

/** Arc-length point along the live part of a strand, 0..1. Screen or local pts. */
export function ropeAt(pts: { x: number; y: number }[], live: number, u: number): { x: number; y: number } {
  const last = Math.max(1, Math.min(live, pts.length - 1));
  const t = Math.max(0, Math.min(1, u)) * last;
  const i = Math.min(last - 1, Math.floor(t));
  const f = t - i;
  const a = pts[i];
  const b = pts[i + 1];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Shortest distance from a point to the live strand, for hit testing. */
export function ropeDistance(pts: { x: number; y: number }[], live: number, x: number, y: number): number {
  let best = Infinity;
  const last = Math.min(live, pts.length - 1);
  for (let i = 0; i < last; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    if (d < best) best = d;
  }
  return best;
}

/* ── drawing: a ribbon that merges into both membranes ──────────────────── */

export interface RibbonStyle {
  /** Colour at each end. */
  colA: string;
  colB: string;
  /** Alpha of the whole strand (vitality, selection). */
  alpha: number;
  /** Widest half-width in screen px at the middle. */
  mid: number;
  /** Half-width where it enters each membrane (a flare). */
  flareA: number;
  flareB: number;
  /** 0..1 — has the far end fused yet. */
  fused: number;
  /** Selected strands get a bright core. */
  core: string | null;
}

/** Half-width of the ribbon at parameter u, in screen px. */
function widthAt(u: number, s: RibbonStyle): number {
  // Flared at both ends, slim through the middle: a hypha, not a cable.
  const ends = Math.pow(1 - Math.sin(u * Math.PI), 2);
  const flare = s.flareA * Math.pow(1 - u, 3) + s.flareB * s.fused * Math.pow(u, 3);
  return s.mid * (0.45 + 0.55 * Math.sin(u * Math.PI)) + flare * ends;
}

/**
 * Fill the strand as a smoothed ribbon. `pts` are SCREEN points; `live` is how
 * many segments have grown. Nothing here strokes a line.
 */
export function drawRibbon(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[], live: number, s: RibbonStyle): void {
  const last = Math.min(live, pts.length - 1);
  if (last < 1) return;
  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  let lnx = 0;
  let lny = -1;
  for (let i = 0; i <= last; i += 1) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(last, i + 1)];
    let nx = -(b.y - a.y);
    let ny = b.x - a.x;
    const nl = Math.hypot(nx, ny);
    // Carry the last good normal rather than emitting NaN on a degenerate span.
    if (nl < 1e-6) { nx = lnx; ny = lny; } else { nx /= nl; ny /= nl; lnx = nx; lny = ny; }
    const w = widthAt(i / last, s);
    const p = pts[i];
    left.push({ x: p.x + nx * w, y: p.y + ny * w });
    right.push({ x: p.x - nx * w, y: p.y - ny * w });
  }

  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i += 1) {
      const m = { x: (left[i - 1].x + left[i].x) / 2, y: (left[i - 1].y + left[i].y) / 2 };
      ctx.quadraticCurveTo(left[i - 1].x, left[i - 1].y, m.x, m.y);
    }
    ctx.lineTo(left[left.length - 1].x, left[left.length - 1].y);
    for (let i = right.length - 1; i > 0; i -= 1) {
      const m = { x: (right[i].x + right[i - 1].x) / 2, y: (right[i].y + right[i - 1].y) / 2 };
      ctx.quadraticCurveTo(right[i].x, right[i].y, m.x, m.y);
    }
    ctx.lineTo(right[0].x, right[0].y);
    ctx.closePath();
  };

  const a = pts[0];
  const b = pts[last];
  const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
  grad.addColorStop(0, s.colA);
  grad.addColorStop(1, s.colB);

  ctx.save();
  // A soft halo under the body, so the strand sits in the dish rather than on it.
  ctx.globalAlpha = s.alpha * 0.28;
  ctx.filter = 'blur(3px)';
  trace();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.filter = 'none';
  // The body itself, source-over: a wide additive fill blows out to white.
  ctx.globalAlpha = s.alpha;
  trace();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  if (s.core) {
    ctx.save();
    ctx.globalAlpha = s.alpha;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= last; i += 1) {
      const m = { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 };
      ctx.quadraticCurveTo(pts[i - 1].x, pts[i - 1].y, m.x, m.y);
    }
    ctx.lineTo(pts[last].x, pts[last].y);
    ctx.strokeStyle = s.core;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }
}
