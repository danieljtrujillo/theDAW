/**
 * beatClock — ONE bar/beat phase for every surface.
 *
 * Before this, tempo lived in five unrelated places (EDIT bpm, PERFORM
 * project.tempo, DJ per-deck analysis, NodeF.I. Live Out, the arp) and the only
 * launch quantizer in the app was PERFORM's bars-only `nextLaunchTime`, anchored
 * to a component-local ref nothing else could read. This module holds a single
 * (bpm, beatsPerBar, anchor) on the shared AudioContext so LOOM, the DJ shard
 * pads, PERFORM slots and NodeF.I. can all ask "when is the next bar?" and get
 * the same answer.
 *
 * The anchor is the AudioContext time of bar 0, beat 0. `setBpm` re-anchors so
 * the CURRENT beat position is preserved (no phase jump when a deck drifts).
 * The first `nextGrid` call with no anchor makes NOW bar 0, so a cold start is
 * immediate and everything after it lines up.
 */
import { getEngineCtx } from '../state/playerStore';

export type ClockGrid = 'now' | '16th' | '8th' | 'beat' | 'half' | 'bar' | '2bar' | '4bar';
export type ClockSource = 'internal' | 'dj' | 'perform' | 'edit' | 'nodefi' | 'loom';

export interface BeatClockState {
  bpm: number;
  beatsPerBar: number;
  /** AudioContext time of bar 0 beat 0; null until something has launched. */
  anchor: number | null;
  source: ClockSource;
}

export interface ClockPhase {
  bar: number;
  beat: number;
  sixteenth: number;
  /** 0..1 inside the current beat. */
  beatFrac: number;
  /** 0..1 inside the current bar. */
  barFrac: number;
}

type Listener = (s: BeatClockState) => void;

/** Small scheduling lead so a launch computed "now" is never already past. */
export const CLOCK_LEAD_SEC = 0.01;

const state: BeatClockState = { bpm: 120, beatsPerBar: 4, anchor: null, source: 'internal' };
const listeners = new Set<Listener>();

const emit = () => { for (const l of listeners) l({ ...state }); };
const clampBpm = (b: number) => Math.max(20, Math.min(300, b));

function now(): number {
  try { return getEngineCtx().currentTime; } catch { return 0; }
}

export const beatClock = {
  get state(): BeatClockState { return { ...state }; },
  get bpm(): number { return state.bpm; },
  get beatsPerBar(): number { return state.beatsPerBar; },
  beatSec(): number { return 60 / state.bpm; },
  barSec(): number { return (60 / state.bpm) * state.beatsPerBar; },

  /** Seconds per grid unit. */
  gridSec(grid: ClockGrid): number {
    const beat = 60 / state.bpm;
    switch (grid) {
      case 'now': return 0;
      case '16th': return beat / 4;
      case '8th': return beat / 2;
      case 'beat': return beat;
      case 'half': return beat * state.beatsPerBar / 2;
      case 'bar': return beat * state.beatsPerBar;
      case '2bar': return beat * state.beatsPerBar * 2;
      case '4bar': return beat * state.beatsPerBar * 4;
    }
  },

  /** Make `at` (default now) bar `bar`, beat 0. */
  setAnchor(at?: number, bar = 0): void {
    const t = at ?? now();
    state.anchor = t - bar * this.barSec();
    emit();
  },

  /** Change tempo without a phase jump: the beat we are on stays the beat we are on. */
  setBpm(bpm: number, source?: ClockSource): void {
    const next = clampBpm(bpm);
    if (Math.abs(next - state.bpm) < 1e-6 && (!source || source === state.source)) return;
    const t = now();
    if (state.anchor != null) {
      const beatsElapsed = (t - state.anchor) / (60 / state.bpm);
      state.anchor = t - beatsElapsed * (60 / next);
    }
    state.bpm = next;
    if (source) state.source = source;
    emit();
  },

  setBeatsPerBar(n: number): void {
    const v = Math.max(1, Math.min(16, Math.round(n)));
    if (v === state.beatsPerBar) return;
    state.beatsPerBar = v;
    emit();
  },

  /** Where we are, at `at` (default now). */
  phase(at?: number): ClockPhase {
    const t = at ?? now();
    const anchor = state.anchor ?? t;
    const beat = 60 / state.bpm;
    const beats = Math.max(0, (t - anchor) / beat);
    const bar = Math.floor(beats / state.beatsPerBar);
    const beatInBar = beats - bar * state.beatsPerBar;
    const beatIdx = Math.floor(beatInBar);
    const beatFrac = beatInBar - beatIdx;
    return {
      bar,
      beat: beatIdx,
      sixteenth: Math.floor(beatFrac * 4),
      beatFrac,
      barFrac: beatInBar / state.beatsPerBar,
    };
  },

  /** The next `grid` line at or after `from` (default now + lead). A cold clock
   *  anchors itself at `from`, so the first launch is immediate. */
  nextGrid(grid: ClockGrid, from?: number): number {
    const t = from ?? now() + CLOCK_LEAD_SEC;
    if (state.anchor == null) {
      state.anchor = t;
      emit();
      return t;
    }
    if (grid === 'now') return t;
    const unit = this.gridSec(grid);
    const n = Math.ceil((t - state.anchor) / unit - 1e-6);
    return state.anchor + n * unit;
  },

  /** Time of an absolute step: bar `bar`, plus `stepsIntoBar` of `stepsPerBar`. */
  timeOf(bar: number, stepsIntoBar = 0, stepsPerBar = 16): number {
    const anchor = state.anchor ?? now();
    return anchor + bar * this.barSec() + (stepsIntoBar / stepsPerBar) * this.barSec();
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

export type BeatClock = typeof beatClock;
