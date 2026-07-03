/**
 * liveMasterFx — an always-available, non-destructive FX chain on the global
 * player's live-FX insert (playerStore: master -> [MIX rack insert] ->
 * [live-FX insert] -> analyser). Purpose-built as the VST-Foundry "Live Audio"
 * bind-test surface: while building a VST UI, demo-mode controls drive these
 * setters over the XR control bus and audibly shape whatever the footer
 * transport is playing, from any tab.
 *
 * Strictly a monitoring-path effect: it colours the live output only — no
 * file, clip, chain entry, or render setting is ever touched — and every
 * parameter's default is fully transparent (unity gain, centred pan, open
 * filters, flat EQ, no drive, no echo), so an untouched chain is
 * indistinguishable from the clean passthrough it replaces.
 *
 * The graph attaches lazily on the first param move and then persists for the
 * session (like the MIX live rack — an idle chain colours nothing). All param
 * moves are click-free via setTargetAtTime.
 *
 *   input ─▶ hp ─▶ lp ─▶ eqLow ─▶ eqMid ─▶ eqHigh ─┬─▶ driveDry ─┬─▶ panner ─▶ volume ─▶ mute ─▶ chainTail ─▶ output
 *                                                  └─▶ shaper ─▶ driveWet ─┘   ▲
 *                                (echo send) driveSum ─▶ delaySend ─▶ delay ───┘ (feedback: delay ─▶ fb ─▶ delay)
 *   input ─▶ bypassDirect ─▶ output   (crossfaded with chainTail by the bypass toggle)
 */
import { getLiveFxInsert } from '../state/playerStore';

export type LiveFxKey =
  | 'volume'
  | 'mute'
  | 'pan'
  | 'lpCutoff'
  | 'hpCutoff'
  | 'resonance'
  | 'eqLow'
  | 'eqMid'
  | 'eqHigh'
  | 'drive'
  | 'delayMix'
  | 'delayTime'
  | 'delayFeedback'
  | 'bypass';

/** Transparent defaults — the chain at these values is a clean passthrough. */
export const LIVE_FX_DEFAULTS: Record<LiveFxKey, number | boolean> = {
  volume: 100, // %
  mute: false,
  pan: 0, // -100..100 %
  lpCutoff: 100, // % of log sweep, 100 = fully open (20 kHz)
  hpCutoff: 0, // % of log sweep, 0 = fully open (20 Hz)
  resonance: 0, // % -> Q 0.707..12 on both filters
  eqLow: 0, // dB
  eqMid: 0, // dB
  eqHigh: 0, // dB
  drive: 0, // %
  delayMix: 0, // %
  delayTime: 350, // ms
  delayFeedback: 35, // %
  bypass: false,
};

const state: Record<LiveFxKey, number | boolean> = { ...LIVE_FX_DEFAULTS };

interface FxNodes {
  ctx: AudioContext;
  hp: BiquadFilterNode;
  lp: BiquadFilterNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  shaper: WaveShaperNode;
  driveDry: GainNode;
  driveWet: GainNode;
  driveSum: GainNode;
  delaySend: GainNode;
  delay: DelayNode;
  fb: GainNode;
  panner: StereoPannerNode;
  volume: GainNode;
  mute: GainNode;
  chainTail: GainNode;
  bypassDirect: GainNode;
}

let nodes: FxNodes | null = null;

/* ── param mappings ─────────────────────────────────────────────────────────
   Cutoffs are % of a LOG sweep so a knob feels perceptually even across the
   whole travel (a linear Hz knob spends half its throw above 10 kHz where
   nothing audible happens). */

/** LP cutoff: 0 % -> 60 Hz, 100 % -> 20 kHz (open). */
const lpHz = (pct: number): number =>
  20000 * Math.pow(60 / 20000, (100 - clampPct(pct)) / 100);

/** HP cutoff: 0 % -> 20 Hz (open), 100 % -> 8 kHz. */
const hpHz = (pct: number): number => 20 * Math.pow(8000 / 20, clampPct(pct) / 100);

/** Resonance: 0 % -> Butterworth 0.707, 100 % -> Q 12 (punchy but stable). */
const filterQ = (pct: number): number => 0.707 + (clampPct(pct) / 100) * (12 - 0.707);

const clampPct = (v: number): number => Math.max(0, Math.min(100, v));

/** Smoothly set an AudioParam toward a target (click-free for live moves). */
const ramp = (p: AudioParam, v: number, ctx: AudioContext): void => {
  p.setTargetAtTime(v, ctx.currentTime, 0.02);
};

/** Normalized tanh drive curve: identity at amount 0, hard saturation at 1. */
const driveCurve = (amount01: number): Float32Array => {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount01 * 30 + 1e-3;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
};

/** Build the chain onto the live-FX insert (idempotent), then push the full
 *  current state so a late attach lands exactly where the params already are. */
const attach = (): FxNodes => {
  if (nodes) return nodes;
  const { ctx, input, output } = getLiveFxInsert();
  try { input.disconnect(); } catch { /* nothing wired yet */ }

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const eqLow = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 200;
  const eqMid = ctx.createBiquadFilter();
  eqMid.type = 'peaking';
  eqMid.frequency.value = 1000;
  eqMid.Q.value = 1;
  const eqHigh = ctx.createBiquadFilter();
  eqHigh.type = 'highshelf';
  eqHigh.frequency.value = 4000;

  // Drive: dry/wet pair around a normalized tanh shaper (transparent at 0).
  const shaper = ctx.createWaveShaper();
  shaper.oversample = '2x';
  shaper.curve = driveCurve(0);
  const driveDry = ctx.createGain();
  const driveWet = ctx.createGain();
  driveWet.gain.value = 0;
  const driveSum = ctx.createGain();

  // Echo: post-drive send into a feedback delay, summed back at the panner.
  const delaySend = ctx.createGain();
  delaySend.gain.value = 0;
  const delay = ctx.createDelay(2);
  delay.delayTime.value = 0.35;
  const fb = ctx.createGain();
  fb.gain.value = 0.35;

  const panner = ctx.createStereoPanner();
  const volume = ctx.createGain();
  const mute = ctx.createGain();
  // Bypass crossfade: chainTail carries the processed path, bypassDirect the
  // untouched input; the toggle ramps them opposite ways for a click-free A/B.
  const chainTail = ctx.createGain();
  const bypassDirect = ctx.createGain();
  bypassDirect.gain.value = 0;

  input.connect(hp);
  hp.connect(lp);
  lp.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(driveDry);
  driveDry.connect(driveSum);
  eqHigh.connect(shaper);
  shaper.connect(driveWet);
  driveWet.connect(driveSum);
  driveSum.connect(panner);
  driveSum.connect(delaySend);
  delaySend.connect(delay);
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(panner);
  panner.connect(volume);
  volume.connect(mute);
  mute.connect(chainTail);
  chainTail.connect(output);
  input.connect(bypassDirect);
  bypassDirect.connect(output);

  nodes = {
    ctx, hp, lp, eqLow, eqMid, eqHigh, shaper, driveDry, driveWet, driveSum,
    delaySend, delay, fb, panner, volume, mute, chainTail, bypassDirect,
  };
  for (const key of Object.keys(state) as LiveFxKey[]) applyParam(key);
  return nodes;
};

/** Push one param from `state` onto the live nodes. */
const applyParam = (key: LiveFxKey): void => {
  if (!nodes) return;
  const n = nodes;
  const { ctx } = n;
  switch (key) {
    case 'volume':
      ramp(n.volume.gain, Math.max(0, Number(state.volume)) / 100, ctx);
      break;
    case 'mute':
      ramp(n.mute.gain, state.mute ? 0 : 1, ctx);
      break;
    case 'pan':
      ramp(n.panner.pan, Math.max(-1, Math.min(1, Number(state.pan) / 100)), ctx);
      break;
    case 'lpCutoff':
      ramp(n.lp.frequency, lpHz(Number(state.lpCutoff)), ctx);
      break;
    case 'hpCutoff':
      ramp(n.hp.frequency, hpHz(Number(state.hpCutoff)), ctx);
      break;
    case 'resonance': {
      const q = filterQ(Number(state.resonance));
      ramp(n.lp.Q, q, ctx);
      ramp(n.hp.Q, q, ctx);
      break;
    }
    case 'eqLow':
      ramp(n.eqLow.gain, Number(state.eqLow), ctx);
      break;
    case 'eqMid':
      ramp(n.eqMid.gain, Number(state.eqMid), ctx);
      break;
    case 'eqHigh':
      ramp(n.eqHigh.gain, Number(state.eqHigh), ctx);
      break;
    case 'drive': {
      const a = clampPct(Number(state.drive)) / 100;
      n.shaper.curve = driveCurve(a);
      ramp(n.driveWet.gain, a, ctx);
      ramp(n.driveDry.gain, 1 - a, ctx);
      break;
    }
    case 'delayMix':
      ramp(n.delaySend.gain, (clampPct(Number(state.delayMix)) / 100) * 0.9, ctx);
      break;
    case 'delayTime':
      ramp(n.delay.delayTime, Math.max(0.03, Math.min(1, Number(state.delayTime) / 1000)), ctx);
      break;
    case 'delayFeedback':
      ramp(n.fb.gain, Math.max(0, Math.min(0.9, Number(state.delayFeedback) / 100)), ctx);
      break;
    case 'bypass':
      ramp(n.chainTail.gain, state.bypass ? 0 : 1, ctx);
      ramp(n.bypassDirect.gain, state.bypass ? 1 : 0, ctx);
      break;
  }
};

/**
 * Drive one live-FX parameter. Attaches the chain on first use, then applies
 * the move click-free. Numbers arrive in the unit each target declares
 * (%, dB, ms — see liveFxTargets); toggles arrive as booleans.
 */
export function setLiveFxParam(key: LiveFxKey, value: number | boolean): void {
  state[key] = value;
  attach();
  applyParam(key);
}

/** Current value of one param by key (or target id suffix). Undefined for an
 *  unknown key, so the XR source can seed manifest `value`s safely. */
export function getLiveFxValue(key: string): number | boolean | undefined {
  return key in state ? state[key as LiveFxKey] : undefined;
}
