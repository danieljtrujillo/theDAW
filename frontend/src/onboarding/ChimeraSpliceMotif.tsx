/**
 * ChimeraSpliceMotif — a small, self-contained canvas rendition of the Chimera
 * CRISPR splice: two waveform lanes twist into DNA helices, alternating chunks
 * lift out of each lane and fuse into ONE strand at the centre while the
 * leftover material vaporises; the fused strand holds, then the cycle replays.
 *
 * Used by the onboarding tour's Chimera step, and safe to mount anywhere else
 * that wants a live preview without the WebGL scene (which needs real clips
 * plus DOM lane anchors, so it draws nothing on an empty stack).
 *
 * Why a 2D canvas instead of per-bead CSS/WAAPI transforms: the previous motif
 * animated 18 <span> beads as two rigid rows sliding past each other — the
 * animations ran, but there was no helix, no chunk transfer, and its "hold"
 * frame (fill: both at the last keyframe) was the DIMMEST one (opacity .15,
 * beads pushed off to the sides), so it looked broken. A canvas draws the real
 * choreography in one pass, is immune to `prefers-reduced-motion` CSS rules
 * (the motif must always animate — that was the previous fix's requirement),
 * and sizes itself from its container via ResizeObserver, so it works whether
 * it is mounted inside the fixed tour portal or in a normal panel: a 0×0 first
 * frame simply draws nothing until layout settles. Under React StrictMode the
 * effect's cleanup cancels the frame loop and the observer, and the re-mount
 * starts a fresh one.
 */
import React, { useEffect, useRef } from 'react';
import { laneColor, mixRgb, type Rgb } from '../components/chimera/dna/dnaPalette';
import { SLOT_EDGES, sampleEnv, smoother, win } from '../components/chimera/dna/dnaMath';

const PLAY_MS = 5600; // one splice, flat lanes → fused strand
const HOLD_MS = 1500; // hold the finished strand
const FADE_MS = 500; // crossfade back to the start (no snap)
const CYCLE_MS = PLAY_MS + HOLD_MS + FADE_MS;
const CHUNKS = SLOT_EDGES.length - 1;
const FLIGHT = 0.2; // fraction of the play window a chunk spends in flight

const HOLO: Rgb = { r: 205, g: 232, b: 255 }; // hologram tint (same as the WebGL scene)
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BG: Rgb = { r: 5, g: 6, b: 10 };

const hash = (n: number): number => {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
};

const slotOf = (u: number): number => {
  let s = 0;
  while (s < CHUNKS - 1 && u >= SLOT_EDGES[s + 1]) s++;
  return s;
};

/** Distance (in u) from the nearest interior slot boundary. */
const seamDist = (u: number): number => {
  let d = 1;
  for (let e = 1; e < SLOT_EDGES.length - 1; e++) d = Math.min(d, Math.abs(u - SLOT_EDGES[e]));
  return d;
};

/** Deterministic waveform envelope so each strand has an audio-like shape. */
function makeEnv(seed: number, bins = 96): Float32Array {
  const out = new Float32Array(bins);
  const ph = seed * 2.399;
  for (let i = 0; i < bins; i++) {
    const u = i / bins;
    const v =
      0.4 +
      0.3 * Math.sin(u * 21 + ph) +
      0.2 * Math.sin(u * 8 + ph * 1.7) +
      0.15 * Math.sin(u * 47 + ph * 0.3);
    out[i] = Math.max(0.08, Math.min(1, Math.abs(v)));
  }
  return out;
}

const css = (c: Rgb, a: number): string => `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${a})`;

interface Node {
  x: number;
  cy: number;
  off: number; // strand offset magnitude (front = +off, back = -off)
  za: number; // depth of the + strand: 1 = front, 0 = back
  size: number;
  col: Rgb;
  alpha: number;
  rung: boolean;
}

/** One frame of the choreography at progress p (0..1) and clock t (seconds). */
function render(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, p: number, envs: Float32Array[]): void {
  const x0 = W * 0.06;
  const span = W * 0.88;
  const laneY = [H * 0.27, H * 0.73];
  const outY = H * 0.5;
  const amp = Math.min(H * 0.14, 15);
  const rb = Math.max(1.5, Math.min(3, H * 0.028));
  const n = Math.max(28, Math.min(110, Math.round(span / (rb * 2.2))));
  const k = (Math.PI * 2 * 2.5) / span; // ~2.5 coils per strand, like the real scene
  const twist = win(p, 0.02, 0.26);
  const chop = win(p, 0.24, 0.4);
  const fuse = win(p, 0.6, 0.9);
  const sweepU = win(p, 0.88, 1); // highlight travels the finished strand once
  const outSpin = t * 0.75;

  // lane / output backdrops — faint bands that hand over as the chunks move
  ctx.lineWidth = 1;
  for (let lane = 0; lane < 2; lane++) {
    const a = 0.05 * (1 - fuse);
    if (a > 0.002) {
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      const bh = amp * 2.9;
      ctx.fillRect(x0 - 4, laneY[lane] - bh / 2, span + 8, bh);
    }
  }
  const lift0 = win(p, 0.34, 0.7);
  if (lift0 > 0.002) {
    ctx.fillStyle = `rgba(255,255,255,${0.06 * lift0})`;
    const bh = amp * 3.1;
    ctx.fillRect(x0 - 4, outY - bh / 2, span + 8, bh);
  }

  const nodes: Node[] = [];
  for (let lane = 0; lane < 2; lane++) {
    const other = 1 - lane;
    const laneCol = laneColor(lane);
    const otherCol = laneColor(other);
    const spin = (t * (0.7 + 0.25 * lane) + lane * 1.7) * twist;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const s = slotOf(u);
      const sel = s % 2 === lane; // even slots come from lane A, odd from lane B
      const x = x0 + u * span;
      const env = sampleEnv(envs[lane], u, 0.5);

      // gaps open at the chunk boundaries as the strand is chopped; the fused
      // strand closes them again as it forms
      const gapW = 0.012 * chop * (1 - fuse);
      if (gapW > 0 && seamDist(u) < gapW) continue;

      const theta = x * k + spin + (hash(i * 6.1 + lane) - 0.5) * 0.3;
      const ampWave = amp * (0.15 + 0.95 * env);
      const ampHelix = amp * (0.55 + 0.75 * env);
      let off = (1 - twist) * ampWave + twist * ampHelix * Math.sin(theta);
      let za = (Math.cos(theta) * twist + 1) / 2;
      let cy = laneY[lane] + twist * (1 - fuse) * amp * 0.12 * Math.sin(u * 6 + t * 1.2 + lane * 2);
      let cx = x;
      let size = rb;
      let alpha = 1;
      let col: Rgb = laneCol;

      if (sel) {
        // each chunk departs on its own schedule and flies its own arc
        const depart = 0.36 + 0.05 * s + 0.015 * lane;
        const lift = smoother((p - depart) / FLIGHT);
        if (lift > 0) {
          const thetaT = x * k + outSpin;
          const offT = amp * (0.55 + 0.75 * env) * Math.sin(thetaT);
          const zaT = (Math.cos(thetaT) + 1) / 2;
          const arc = Math.sin(lift * Math.PI) * (lane === 0 ? -1 : 1) * amp * 0.35;
          cy = laneY[lane] + (outY - laneY[lane]) * lift + arc;
          off = off + (offT - off) * lift;
          za = za + (zaT - za) * lift;
          // colour blends into the neighbouring chunk's lane near the seams
          const seam = Math.max(0, 1 - seamDist(u) / 0.07);
          col = mixRgb(laneCol, otherCol, 0.5 * seam * fuse * lift);
          // the finished strand brightens and a highlight sweeps along it once
          const dl = u - sweepU;
          const sweep = sweepU > 0 && sweepU < 1 ? Math.exp(-(dl * dl) / (2 * 0.03 * 0.03)) : 0;
          col = mixRgb(col, WHITE, 0.12 * fuse * lift + 0.6 * sweep);
        }
      } else {
        // unused material shrinks to a particle, wanders, and is gone
        const dv = 0.42 + 0.28 * hash(lane * 9.7 + s * 2.9 + 13);
        const vap = smoother((p - dv) / 0.3);
        if (vap >= 0.999) continue;
        const vth = hash(i * 2.3 + lane * 1.9 + 2) * Math.PI * 2;
        cx += Math.cos(vth) * vap * 16 * (0.5 + hash(i * 3.9 + lane));
        cy += (Math.sin(vth) * 0.6 + 0.5) * vap * 18 + Math.sin(t * 3 + i) * vap * 2;
        size *= 1 - vap * 0.75;
        alpha = 1 - vap;
        col = mixRgb(laneCol, BG, vap * 0.7);
      }

      nodes.push({ x: cx, cy, off, za, size, col: mixRgb(col, HOLO, 0.28), alpha, rung: i % 5 === 2 });
    }
  }

  // depth-sorted: back beads, then rungs, then front beads
  const bead = (nd: Node, sign: 1 | -1): void => {
    const depth = sign === 1 ? nd.za : 1 - nd.za;
    const r = nd.size * (0.6 + 0.55 * depth);
    if (r < 0.3) return;
    const c = mixRgb(nd.col, BG, (1 - depth) * 0.35);
    ctx.fillStyle = css(c, nd.alpha);
    ctx.beginPath();
    ctx.arc(nd.x, nd.cy + sign * nd.off, r, 0, Math.PI * 2);
    ctx.fill();
  };
  for (const nd of nodes) bead(nd, nd.za >= 0.5 ? -1 : 1);
  for (const nd of nodes) {
    if (!nd.rung) continue;
    const len = Math.max(amp * 0.35, Math.abs(nd.off));
    ctx.strokeStyle = css(mixRgb(nd.col, BG, 0.25), nd.alpha * 0.75);
    ctx.lineWidth = Math.max(1, rb * 0.5);
    ctx.beginPath();
    ctx.moveTo(nd.x, nd.cy - len);
    ctx.lineTo(nd.x, nd.cy + len);
    ctx.stroke();
  }
  for (const nd of nodes) bead(nd, nd.za >= 0.5 ? 1 : -1);
}

export interface ChimeraSpliceMotifProps {
  className?: string;
  /** Accessible description of the animation. */
  label?: string;
}

export const ChimeraSpliceMotif: React.FC<ChimeraSpliceMotifProps> = ({ className = '', label }) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let W = 0;
    let H = 0;
    let dpr = 1;
    const resize = (): void => {
      // rendered size (getBoundingClientRect), never clientWidth: the host may
      // sit under a CSS zoom/transform, and the portal card may be 0×0 for a
      // frame before layout — both are handled by just drawing nothing then.
      const r = wrap.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = r.width;
      H = r.height;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const envs = [makeEnv(1), makeEnv(2)];
    const t0 = performance.now();
    let raf = 0;
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      if (W < 8 || H < 8) return;
      const el = now - t0;
      const tms = el % CYCLE_MS;
      let p: number;
      let alpha = 1;
      if (tms < PLAY_MS) p = tms / PLAY_MS;
      else if (tms < PLAY_MS + HOLD_MS) p = 1;
      else {
        // fade the finished strand out, then the flat lanes back in
        const f = (tms - PLAY_MS - HOLD_MS) / FADE_MS;
        p = f < 0.5 ? 1 : 0;
        alpha = Math.abs(f - 0.5) * 2;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = alpha;
      render(ctx, W, H, el / 1000, p, envs);
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      role="img"
      aria-label={
        label ??
        'Two sound strands twist into DNA helices; alternating chunks lift out of each and fuse into one new strand.'
      }
      className={`relative overflow-hidden rounded border border-white/5 bg-black/40 ${className}`}
    >
      <canvas ref={canvasRef} aria-hidden="true" className="block h-full w-full" />
    </div>
  );
};
