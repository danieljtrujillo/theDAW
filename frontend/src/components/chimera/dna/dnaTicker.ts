// One shared animation clock for the CRISPR DNA scene — a long-drawn-out
// version of the reference HTML's eased time windows.
//
// Choreography clock: the scene follows the SAME whole-run fraction that
// paces the displayed progress % (weave render + model load + REAL sampler
// pace, see generateStore's pacer), smoothed per-frame. So the animation and
// the number always agree: chunks self-schedule along p (first chunks
// separate early, last chunks land well before the end), and at any moment
// some are seated, some lifting, some flying, some landed — movement rolls
// like water, with no rush, no hover, no plop.
import { useGenerateStore, getRunFraction } from '../../../state/generateStore';
import { win } from './dnaMath';

export interface DnaPhase {
  generating: boolean;
  complete: boolean;
  p: number; // overall 0..1 choreography progress (smooth, monotonic)
  analyze: number;
  warp: number;
  chop: number;
  weave: number;
  fuse: number;
  scan: number; // legacy sweep position (scene derives its own from analyze)
}

type DrawFn = (t: number, ph: DnaPhase) => void;

const subs = new Set<DrawFn>();
let raf = 0;
let startT = 0;

// pre-completion ceiling: the ramp can carry the choreography almost home on
// its own; actual completion eases the final landings in
const PRE_COMPLETE_CEIL = 0.965;

let runActive = false;
let smoothP = 0;
let shownP = 0;
let lastNow = -1;

const IDLE: DnaPhase = {
  generating: false,
  complete: false,
  p: 0,
  analyze: 0,
  warp: 0,
  chop: 0,
  weave: 0,
  fuse: 0,
  scan: 0,
};

function phase(nowSec: number): DnaPhase {
  const g = useGenerateStore.getState();
  const generating = g.isGenerating;
  const complete = g.statusLabel === 'COMPLETE';
  const dt = lastNow < 0 ? 0 : Math.min(0.05, nowSec - lastNow);
  lastNow = nowSec;

  if (!generating && !complete) {
    runActive = false;
    smoothP = 0;
    shownP = 0;
    return IDLE;
  }
  if (!runActive) {
    runActive = true;
    smoothP = 0;
    shownP = 0;
  }

  // target = the run's real paced fraction (identical to the progress %)
  const target = complete ? 1 : Math.min(getRunFraction(), PRE_COMPLETE_CEIL);

  // frame-rate-independent exponential smoothing — one continuous motion
  const k = 1 - Math.exp(-dt * (complete ? 1.5 : 0.9));
  smoothP += (target - smoothP) * k;

  let p = smoothP;
  if (!complete) p = Math.min(p, PRE_COMPLETE_CEIL);
  if (p < shownP) p = shownP; // monotonic within a run
  shownP = p;

  return {
    generating,
    complete,
    p,
    analyze: win(p, 0.06, 0.32),
    warp: win(p, 0.28, 0.5),
    chop: win(p, 0.46, 0.64),
    weave: win(p, 0.6, 0.86),
    fuse: win(p, 0.82, 1.0),
    scan: (p * 2) % 1,
  };
}

function loop(now: number): void {
  if (!startT) startT = now;
  const t = (now - startT) / 1000;
  const ph = phase(now / 1000);
  subs.forEach((fn) => {
    try {
      fn(t, ph);
    } catch {
      /* never let one canvas error stall the shared loop */
    }
  });
  raf = requestAnimationFrame(loop);
}

export function registerDnaDraw(fn: DrawFn): () => void {
  subs.add(fn);
  if (subs.size === 1) {
    startT = 0;
    lastNow = -1;
    raf = requestAnimationFrame(loop);
  }
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
