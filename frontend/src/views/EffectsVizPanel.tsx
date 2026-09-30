import React, { useMemo } from 'react';
import { Activity } from 'lucide-react';
import { EFFECT_LABELS } from '../state/effectChainStore';
import { getRackEffect } from '../lib/rackEffects';

/* ── EffectsVizPanel ───────────────────────────────────────────────────
   Reserved bottom-center region of the MIX tab for effects visualization
   (real EQ-curve, transfer-function / scope display, etc.).

   FE-022: this used to draw one fixed decorative curve for every effect,
   which is a lie — a compressor and a reverb do not have the shape of a
   sweepable EQ. `parametric_eq` (`makeParametricEq`, `lib/rackEffects.ts`)
   is the one MIX rack effect whose ENTIRE signal path is a topology this
   file can reconstruct exactly from its params alone — three
   `BiquadFilterNode`s in series (a fixed 120 Hz low shelf, a `Q=1` peaking
   filter swept by `midFreq`, a fixed 6000 Hz high shelf) — so it is the one
   effect that gets a REAL response curve, computed with the same
   coefficient formulas the Web Audio spec normatively defines for
   `BiquadFilterNode` (the Audio EQ Cookbook, R. Bristow-Johnson — see
   `biquadMagnitudeDb` below). Every other effect honestly says it has no
   live response to show rather than reusing that curve as set dressing.

   Props:
     effect — the currently-selected/active effect id (e.g. 'parametric_eq')
     params — that effect's live params (feeds the real response for the
              one effect that has one) */
export interface EffectsVizPanelProps {
  effect: string | null;
  params: Record<string, number>;
  /** The chain entry's own bypass state (`ChainEntry.enabled`). A bypassed
   *  effect passes audio through unchanged, so its real curve would be
   *  misleading — drawn as a flat 0 dB line instead. Required rather than
   *  defaulted, so a caller cannot forget to wire it and silently get the
   *  curve back for a bypassed effect. */
  enabled: boolean;
  className?: string;
}

/* ── biquad coefficients (Web Audio API §1.13.5 / Audio EQ Cookbook) ─────────
   Verified against https://webaudio.github.io/web-audio-api/#filters-characteristics
   and https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html — the
   spec's own normative source — rather than written from memory. */

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a0: number;
  a1: number;
  a2: number;
}

/** peakingEQ: A = 10^(gainDb/40), alpha = sin(w0)/(2*Q). */
export function peakingCoeffs(freqHz: number, gainDb: number, q: number, sampleRate: number): BiquadCoeffs {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  return {
    b0: 1 + alpha * A,
    b1: -2 * cosw0,
    b2: 1 - alpha * A,
    a0: 1 + alpha / A,
    a1: -2 * cosw0,
    a2: 1 - alpha / A,
  };
}

/**
 * lowshelf/highshelf: A = 10^(gainDb/40). The Web Audio spec HARDCODES the
 * shelf-slope `S = 1` for these two filter types unconditionally (the
 * maximally-flat monotonic shelf, in the cookbook's own terms) — its `Q`
 * `AudioParam` is explicitly "Not used in this filter type" per the spec's
 * own per-type parameter table, never read for lowshelf/highshelf at all,
 * regardless of what a caller sets it to (unlike the cookbook this spec is
 * "inspired by", which lets `S` vary as a general slope parameter). `S` is
 * hardcoded here rather than accepted as a parameter for that reason: there
 * is no live value to thread through, live or otherwise.
 * `alpha = (sin(w0)/2) * sqrt((A + 1/A)*(1/S - 1) + 2)`, which collapses to
 * `(sin(w0)/2) * sqrt(2)` once `S = 1`.
 */
export function shelfCoeffs(
  kind: 'lowshelf' | 'highshelf',
  freqHz: number,
  gainDb: number,
  sampleRate: number,
): BiquadCoeffs {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * freqHz) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const S = 1;
  const alpha = (sinw0 / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  if (kind === 'lowshelf') {
    return {
      b0: A * (A + 1 - (A - 1) * cosw0 + twoSqrtAAlpha),
      b1: 2 * A * (A - 1 - (A + 1) * cosw0),
      b2: A * (A + 1 - (A - 1) * cosw0 - twoSqrtAAlpha),
      a0: A + 1 + (A - 1) * cosw0 + twoSqrtAAlpha,
      a1: -2 * (A - 1 + (A + 1) * cosw0),
      a2: A + 1 + (A - 1) * cosw0 - twoSqrtAAlpha,
    };
  }
  return {
    b0: A * (A + 1 + (A - 1) * cosw0 + twoSqrtAAlpha),
    b1: -2 * A * (A - 1 + (A + 1) * cosw0),
    b2: A * (A + 1 + (A - 1) * cosw0 - twoSqrtAAlpha),
    a0: A + 1 - (A - 1) * cosw0 + twoSqrtAAlpha,
    a1: 2 * (A - 1 - (A + 1) * cosw0),
    a2: A + 1 - (A - 1) * cosw0 - twoSqrtAAlpha,
  };
}

/**
 * The magnitude response of one biquad at `freqHz`, in dB — evaluating
 * `H(z) = (b0 + b1*z^-1 + b2*z^-2) / (a0 + a1*z^-1 + a2*z^-2)` at
 * `z = e^(j*2*pi*freqHz/sampleRate)`, exactly what
 * `BiquadFilterNode.getFrequencyResponse()` computes for the same node.
 */
export function biquadMagnitudeDb(c: BiquadCoeffs, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cosw = Math.cos(w);
  const sinw = Math.sin(w);
  const cos2w = Math.cos(2 * w);
  const sin2w = Math.sin(2 * w);
  const reNum = c.b0 + c.b1 * cosw + c.b2 * cos2w;
  const imNum = -(c.b1 * sinw + c.b2 * sin2w);
  const reDen = c.a0 + c.a1 * cosw + c.a2 * cos2w;
  const imDen = -(c.a1 * sinw + c.a2 * sin2w);
  const magDen = Math.hypot(reDen, imDen);
  if (magDen === 0) return 0; // degenerate coefficient set; treat as unity rather than +/-Infinity
  return 20 * Math.log10(Math.hypot(reNum, imNum) / magDen);
}

/* ── parametric_eq: the exact topology `makeParametricEq` builds ─────────── */

/** The rate `renderCore.ts` (`BOUNCE_SAMPLE_RATE`) calls "44100 today,
 *  everywhere" — close enough to any real device rate for a visualization,
 *  and the one constant this app treats as canonical. */
const EQ_SAMPLE_RATE = 44100;
/** Fixed low-shelf corner in `makeParametricEq` (`lib/rackEffects.ts:1473`). */
const EQ_LOW_SHELF_FREQ = 120;
/** Fixed high-shelf corner in `makeParametricEq` (`lib/rackEffects.ts:1479`). */
const EQ_HIGH_SHELF_FREQ = 6000;
/** `mid.Q.value = 1`, never exposed as a param (`lib/rackEffects.ts:1476`). */
const EQ_MID_Q = 1;

const clampGainDb = (v: number | undefined): number => Math.max(-24, Math.min(24, v ?? 0));
const clampMidFreq = (v: number | undefined): number => Math.max(100, Math.min(12000, v ?? 1000));

/** The live chain's total response at `freqHz`, in dB — the three bands are
 *  in SERIES, so their linear magnitudes multiply, which is addition once
 *  everything is already in the log (dB) domain. Mirrors
 *  `makeParametricEq.setParams`'s own defaults and clamps exactly. */
export function parametricEqResponseDb(params: Record<string, number>, freqHz: number): number {
  const low = shelfCoeffs('lowshelf', EQ_LOW_SHELF_FREQ, clampGainDb(params.low), EQ_SAMPLE_RATE);
  const mid = peakingCoeffs(clampMidFreq(params.midFreq), clampGainDb(params.mid), EQ_MID_Q, EQ_SAMPLE_RATE);
  const high = shelfCoeffs('highshelf', EQ_HIGH_SHELF_FREQ, clampGainDb(params.high), EQ_SAMPLE_RATE);
  return (
    biquadMagnitudeDb(low, freqHz, EQ_SAMPLE_RATE) +
    biquadMagnitudeDb(mid, freqHz, EQ_SAMPLE_RATE) +
    biquadMagnitudeDb(high, freqHz, EQ_SAMPLE_RATE)
  );
}

/** Effect ids whose live response this panel can reconstruct exactly from
 *  their params alone. Deliberately a short, explicit allowlist rather than
 *  "every effect with a biquad in it": several rack ids (`highpass`,
 *  `lowpass`) COLLIDE with backend (FFmpeg) effect ids of the same name under
 *  a different DSP entirely (see `effectChainStore.ts`'s `MIX_RACK_IDS`
 *  comment) — drawing a Web-Audio curve for one of those would be honest for
 *  the id but wrong for the audio actually playing. */
const REAL_RESPONSE_EFFECTS = new Set(['parametric_eq']);

export function hasRealResponse(effect: string | null): boolean {
  return effect !== null && REAL_RESPONSE_EFFECTS.has(effect);
}

const CURVE_FREQ_MIN = 20;
const CURVE_FREQ_MAX = 20000;
const CURVE_DB_RANGE = 24; // matches the EQ bands' own +/-24 dB param bounds
const CURVE_POINTS = 48;
const CURVE_W = 100;
const CURVE_H = 40;

const freqToX = (freqHz: number): number =>
  (Math.log10(freqHz / CURVE_FREQ_MIN) / Math.log10(CURVE_FREQ_MAX / CURVE_FREQ_MIN)) * CURVE_W;

const dbToY = (db: number): number => {
  const clamped = Math.max(-CURVE_DB_RANGE, Math.min(CURVE_DB_RANGE, db));
  return CURVE_H / 2 - (clamped / CURVE_DB_RANGE) * (CURVE_H / 2);
};

/** An SVG path (`viewBox="0 0 100 40"`) tracing the live chain's real
 *  response, log-spaced from 20 Hz to 20 kHz. */
export function buildEqCurvePath(params: Record<string, number>): string {
  const pts: string[] = [];
  for (let i = 0; i < CURVE_POINTS; i++) {
    const t = i / (CURVE_POINTS - 1);
    const freq = CURVE_FREQ_MIN * (CURVE_FREQ_MAX / CURVE_FREQ_MIN) ** t;
    const db = parametricEqResponseDb(params, freq);
    const x = freqToX(freq);
    const y = dbToY(db);
    pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

/** A bypassed effect passes its input through unchanged — a flat 0 dB line,
 *  not whatever curve its (now-inert) params would otherwise draw. Two
 *  points rather than a sampled sweep: there is nothing to sample. */
export function buildFlatCurvePath(): string {
  const y = dbToY(0).toFixed(2);
  return `M0.00,${y} L${CURVE_W.toFixed(2)},${y}`;
}

export const EffectsVizPanel: React.FC<EffectsVizPanelProps> = ({ effect, params, enabled, className }) => {
  const label = effect ? EFFECT_LABELS[effect] || getRackEffect(effect)?.label || effect : null;
  // Surface a couple of the live param values so the panel reflects the
  // selection even for an effect whose response cannot be drawn.
  const paramPairs = Object.entries(params).slice(0, 4);
  const curvePath = useMemo(
    () => (effect && hasRealResponse(effect) ? (enabled ? buildEqCurvePath(params) : buildFlatCurvePath()) : null),
    [effect, params, enabled],
  );

  return (
    <div
      className={`relative h-full w-full overflow-hidden rounded-lg border border-white/8 bg-[#0a080f] ${className ?? ''}`}
    >
      {/* ambient field */}
      <div className="absolute inset-0 opacity-40 pointer-events-none bg-[radial-gradient(circle_at_50%_60%,rgba(168,85,247,0.18),transparent_65%)]" />

      {curvePath ? (
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full text-purple-400/70">
          <line x1="0" y1="20" x2="100" y2="20" stroke="currentColor" strokeWidth="0.2" strokeDasharray="1 2" opacity="0.4" />
          <path d={curvePath} fill="none" stroke="currentColor" strokeWidth="0.6" />
        </svg>
      ) : (
        <div className="absolute inset-0 grid place-items-center pointer-events-none px-4 text-center">
          <span className="text-[9px] font-mono text-zinc-700">
            {label ? 'no live response to show for this effect yet' : 'select an effect to visualize'}
          </span>
        </div>
      )}

      {/* corner tag — faint, no big heading */}
      <div className="absolute top-2 left-2 flex items-center gap-1.5 text-zinc-600">
        <Activity className="w-3 h-3" />
        <span className="text-[8px] font-black uppercase tracking-widest">
          {label ? label : 'Effects Visualization'}
        </span>
      </div>

      {/* live params readout */}
      {paramPairs.length > 0 && (
        <div className="absolute bottom-2 left-2 right-2 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {paramPairs.map(([k, v]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="text-[8px] font-mono text-zinc-600 uppercase">{k}</span>
              <span className="text-[9px] font-mono text-purple-300/80 tabular-nums">{v}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
