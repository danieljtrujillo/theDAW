/**
 * Loosen clip notes that are too perfect.
 *
 * A clip drawn on the grid or generated from a pattern plays back mechanically;
 * scattering starts and velocities by a small amount fixes that. The PRNG is
 * seedable (mulberry32) so the assistant can offer "undo and try again with the
 * same feel", and so this file's behaviour is testable at all.
 */
import type { PianoNote } from '../../state/pianoRollStore';
import { MAX_VELOCITY, MIN_VELOCITY } from './velocity';

export interface HumanizeOptions {
  /** Maximum timing scatter in either direction, in steps. */
  timingSteps?: number;
  /** Maximum velocity scatter in either direction. */
  velocity?: number;
  /** Seed for deterministic output. Omit for a different result each call. */
  seed?: number;
}

/**
 * mulberry32 — a 32-bit PRNG small enough to inline and good enough for
 * scattering note timings. Same seed, same sequence, on every platform.
 */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Scatter note starts and velocities. Pitch and length are never touched —
 * humanizing is about feel, not about rewriting the part. Returns a new array
 * of new notes, ids preserved.
 */
export function humanizeNotes(
  notes: readonly PianoNote[],
  options: HumanizeOptions = {},
): PianoNote[] {
  const timingSteps = Math.abs(options.timingSteps ?? 0.1);
  const velocityAmount = Math.abs(options.velocity ?? 8);
  const random = options.seed === undefined ? Math.random : mulberry32(options.seed);

  return notes.map((note) => {
    // Two draws per note, always, so the sequence a seed produces does not
    // depend on which of the two amounts happens to be zero.
    const timingRoll = random() * 2 - 1;
    const velocityRoll = random() * 2 - 1;
    const step = Math.max(0, note.step + timingRoll * timingSteps);
    const velocity = Math.max(
      MIN_VELOCITY,
      Math.min(MAX_VELOCITY, Math.round(note.velocity + velocityRoll * velocityAmount)),
    );
    return { ...note, step, velocity };
  });
}

/* ── Humanize by section, across parts together ─────────────────────────── */

/** One note of a part on a shared clock (EDIT's timeline seconds). */
export interface TimedPartNote {
  id: string;
  /** Onset. */
  t: number;
  /** Length. */
  dur: number;
  velocity: number;
  note: number;
}

/** A part (an EDIT track's notes) for humanizeSections. */
export interface HumanizePart {
  id: string;
  notes: readonly TimedPartNote[];
}

export interface SectionHumanizeOptions {
  /** Where each section starts on the shared clock (a marker, a FORM section). The first section starts at the first note. */
  sections?: readonly number[];
  /** The most a section pushes ahead or lays back, in the clock's units. Default 0.012 (12 ms). */
  onsetBias?: number;
  /** The most the ensemble drifts inside a phrase, in the clock's units. Default 0.008. */
  drift?: number;
  /** The most velocity rises toward a phrase's peak (and half of it falls at its edges). Default 10. */
  velocity?: number;
  /** A gap with no onset in any part this long ends a phrase. Default 0.6. */
  phraseGap?: number;
  seed?: number;
}

/** One moved note: its new onset and velocity. */
export interface HumanizedNote {
  id: string;
  t: number;
  velocity: number;
}

/** An ensemble phrase: its span and its peak (the loudest, highest onset in any part). */
interface EnsemblePhrase {
  from: number;
  to: number;
  peak: number;
  /** The drift's own shape: its lean and its wave's weight and phase. */
  lean: number;
  wave: number;
  phase: number;
}

/**
 * Humanize several parts together, the way an ensemble plays: every part
 * reads one set of sections and one set of phrases, so they move as one.
 *
 *   - Each section pushes ahead or lays back by its own seeded bias (up to
 *     `onsetBias`), shared by the parts, with a little of each part's own
 *     (a quarter of it) on top.
 *   - Inside each phrase (the parts' onsets together, broken at a gap of
 *     `phraseGap` or at a section), the ensemble drifts: a smooth seeded
 *     curve, zero where the phrase starts and ends, up to `drift` in between,
 *     the same curve for every part, each part following it at its own share
 *     (70-100%).
 *   - Velocity leans toward each phrase's peak: up to `velocity` louder at the
 *     peak, half of it softer at the phrase's edges, plus a small per-note
 *     scatter.
 *
 * Pitch and length are never touched. Returns each part's notes, moved, by
 * part id. Seeded (mulberry32): the same seed plays the same.
 */
export function humanizeSections(parts: readonly HumanizePart[], options: SectionHumanizeOptions = {}): Map<string, HumanizedNote[]> {
  const bias = Math.abs(options.onsetBias ?? 0.012);
  const drift = Math.abs(options.drift ?? 0.008);
  const velAmount = Math.abs(options.velocity ?? 10);
  const gap = Math.max(1e-6, options.phraseGap ?? 0.6);
  const random = mulberry32(options.seed ?? 1);
  const all = parts.flatMap((p) => p.notes).sort((a, b) => a.t - b.t);
  const out = new Map<string, HumanizedNote[]>();
  if (!all.length) {
    for (const p of parts) out.set(p.id, []);
    return out;
  }
  const cuts = [...new Set((options.sections ?? []).filter((s) => Number.isFinite(s)))].sort((a, b) => a - b);
  const sectionOf = (t: number): number => {
    let i = 0;
    while (i < cuts.length && cuts[i] <= t + 1e-9) i += 1;
    return i;
  };
  // One bias per section for the ensemble, drawn in section order.
  const sectionBias: number[] = Array.from({ length: cuts.length + 1 }, () => (random() * 2 - 1) * bias);

  // The ensemble's phrases.
  const phrases: EnsemblePhrase[] = [];
  let cur: EnsemblePhrase | null = null;
  let peakScore = -Infinity;
  for (const n of all) {
    const breaks = !cur || n.t - cur.to >= gap || sectionOf(n.t) !== sectionOf(cur.from);
    if (breaks) {
      cur = { from: n.t, to: n.t + n.dur, peak: n.t, lean: 0, wave: 0, phase: 0 };
      phrases.push(cur);
      peakScore = -Infinity;
    }
    const c = cur as EnsemblePhrase;
    c.to = Math.max(c.to, n.t + n.dur);
    const score = n.velocity + n.note * 0.5;
    if (score > peakScore) {
      peakScore = score;
      c.peak = n.t;
    }
  }
  for (const p of phrases) {
    p.lean = random() * 2 - 1;
    p.wave = random();
    p.phase = random() * Math.PI * 2;
  }
  const phraseOf = (t: number): EnsemblePhrase | undefined => {
    let lo = 0;
    let hi = phrases.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (phrases[mid].from <= t + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return phrases[lo];
  };
  const driftAt = (p: EnsemblePhrase, t: number): number => {
    const u = Math.max(0, Math.min(1, (t - p.from) / Math.max(1e-6, p.to - p.from)));
    return drift * Math.sin(Math.PI * u) * (p.lean * (1 - p.wave) + p.wave * Math.sin(2 * Math.PI * u + p.phase));
  };
  const velShape = (p: EnsemblePhrase, t: number): number => {
    const span = Math.max(1e-6, t <= p.peak ? p.peak - p.from : p.to - p.peak);
    const u = Math.min(1, Math.abs(t - p.peak) / span);
    // 1 at the peak, -0.5 at the edges.
    return 1 - 1.5 * u;
  };

  for (const part of parts) {
    const own: number[] = sectionBias.map(() => (random() * 2 - 1) * bias * 0.25);
    const follow = 0.7 + 0.3 * random();
    const moved = part.notes.map((n) => {
      const p = phraseOf(n.t);
      const s = sectionOf(n.t);
      const scatter = (random() * 2 - 1) * 2;
      const shift = sectionBias[s] + own[s] + (p ? driftAt(p, n.t) * follow : 0);
      const v = n.velocity + (p ? velShape(p, n.t) * velAmount : 0) + scatter;
      return {
        id: n.id,
        t: Math.max(0, n.t + shift),
        velocity: Math.max(MIN_VELOCITY, Math.min(MAX_VELOCITY, Math.round(v))),
      };
    });
    out.set(part.id, moved);
  }
  return out;
}
