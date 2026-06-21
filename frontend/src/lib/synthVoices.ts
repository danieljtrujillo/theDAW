/**
 * Procedural synth voices — an EDM-leaning instrument bank that needs no
 * samples. Each voice is a Web Audio graph scheduled on a `when`/`duration`
 * window, with the SAME signature as midiSynth's `triggerSynthVoice`, so it
 * drops into every place that voice is used: piano-roll preview, the offline
 * bounce, init render, and (via the bounce) the timeline.
 *
 * Genres in mind: dubstep (wobble, growl, sub), future bass (supersaw, pluck),
 * complextro (hoover, FM stab), glitch-hop (blip). Psychoacoustic voices live
 * in `./psychoacousticVoices` and are merged into the bank below.
 */

import type { SynthVoice, VoiceTrigger } from './synthVoiceKit';
import { mtof, distCurve, ampEnv } from './synthVoiceKit';
import { PSYCHOACOUSTIC_VOICES } from './psychoacousticVoices';
import { FORMANT_VOICES } from './formantVoices';
import { GLITCH_VOICES } from './glitchVoices';

export type { SynthVoice, VoiceTrigger } from './synthVoiceKit';

/* ── Bass ─────────────────────────────────────────────────────────────────── */

const subBass: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(mtof(midi), when);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.95 * master, 0.012, 0.07);
  osc.connect(env).connect(dest);
  osc.start(when);
  osc.stop(when + dur + 0.3);
};

const reeseBass: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(6000, f * 5), when);
  lp.Q.setValueAtTime(6, when);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.5 * master, 0.02, 0.09);
  lp.connect(env).connect(dest);
  for (const det of [-16, -1, 14]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, when);
    o.detune.setValueAtTime(det, when);
    o.connect(lp);
    o.start(when);
    o.stop(when + dur + 0.3);
  }
};

const wobbleBass: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.setValueAtTime(9, when);
  lp.frequency.setValueAtTime(0, when); // cutoff comes entirely from base + LFO below
  const base = ctx.createConstantSource();
  base.offset.setValueAtTime(1100, when);
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.setValueAtTime(5.5, when); // the "wub"
  const lfoGain = ctx.createGain();
  lfoGain.gain.setValueAtTime(950, when);
  base.connect(lp.frequency);
  lfo.connect(lfoGain).connect(lp.frequency);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.5 * master, 0.01, 0.06);
  lp.connect(env).connect(dest);
  for (const det of [0, 9]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, when);
    o.detune.setValueAtTime(det, when);
    o.connect(lp);
    o.start(when);
    o.stop(when + dur + 0.2);
  }
  base.start(when);
  lfo.start(when);
  base.stop(when + dur + 0.2);
  lfo.stop(when + dur + 0.2);
};

const growlBass: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(50);
  shaper.oversample = '2x';
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.setValueAtTime(4.5, when);
  bp.frequency.setValueAtTime(750, when);
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.setValueAtTime(7, when);
  const lfoGain = ctx.createGain();
  lfoGain.gain.setValueAtTime(900, when);
  lfo.connect(lfoGain).connect(bp.frequency);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.4 * master, 0.01, 0.07);
  shaper.connect(bp).connect(env).connect(dest);
  for (const [type, det] of [['sawtooth', 0], ['square', 7]] as const) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, when);
    o.detune.setValueAtTime(det, when);
    o.connect(shaper);
    o.start(when);
    o.stop(when + dur + 0.2);
  }
  lfo.start(when);
  lfo.stop(when + dur + 0.2);
};

/* ── Leads / chords ─────────────────────────────────────────────────────────── */

const superSaw: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(13000, f * 9), when);
  lp.Q.setValueAtTime(0.5, when);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.3 * master, 0.02, 0.13);
  env.gain.setTargetAtTime((vel / 127) * 0.3 * master * 0.75, when + 0.12, 0.2);
  lp.connect(env).connect(dest);
  const dets = [-24, -15, -7, 0, 7, 15, 24];
  dets.forEach((d) => {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, when);
    o.detune.setValueAtTime(d, when);
    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime((d / 24) * 0.8, when); // spread wide
    o.connect(pan).connect(lp);
    o.start(when);
    o.stop(when + dur + 0.3);
  });
};

const futurePluck: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.setValueAtTime(2, when);
  lp.frequency.setValueAtTime(f * 12, when);
  lp.frequency.exponentialRampToValueAtTime(Math.max(220, f * 2), when + 0.2);
  const peak = (vel / 127) * 0.6 * master;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(peak, when + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(Math.max(dur, 0.12), 0.4));
  lp.connect(env).connect(dest);
  for (const d of [-7, 0, 7]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, when);
    o.detune.setValueAtTime(d, when);
    o.connect(lp);
    o.start(when);
    o.stop(when + 0.6);
  }
};

const hoover: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(9000, f * 7), when);
  lp.Q.setValueAtTime(3, when);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.32 * master, 0.02, 0.1);
  lp.connect(env).connect(dest);
  for (const d of [-22, -7, 0, 7, 22]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f * 1.06, when);
    o.frequency.exponentialRampToValueAtTime(f, when + 0.09); // signature downward sweep
    o.detune.setValueAtTime(d, when);
    o.connect(lp);
    o.start(when);
    o.stop(when + dur + 0.3);
  }
};

const fmStab: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.setValueAtTime(f, when);
  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.setValueAtTime(f * 2.01, when);
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(f * 4, when);
  modGain.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.5), when + 0.15);
  mod.connect(modGain).connect(carrier.frequency);
  const peak = (vel / 127) * 0.5 * master;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(peak, when + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(Math.max(dur, 0.1), 0.45));
  carrier.connect(env).connect(dest);
  carrier.start(when);
  mod.start(when);
  carrier.stop(when + 0.6);
  mod.stop(when + 0.6);
};

/* ── FX ──────────────────────────────────────────────────────────────────────── */

const glitchBlip: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.setValueAtTime(f * 1.5, when);
  o.frequency.exponentialRampToValueAtTime(f, when + 0.03);
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(18);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(300, when);
  const peak = (vel / 127) * 0.5 * master;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(peak, when + 0.003);
  env.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(Math.max(dur, 0.05), 0.14));
  o.connect(shaper).connect(hp).connect(env).connect(dest);
  o.start(when);
  o.stop(when + 0.25);
};

export const SYNTH_VOICES: readonly SynthVoice[] = [
  { id: 'sub', name: 'Sub Bass', group: 'Bass', trigger: subBass },
  { id: 'reese', name: 'Reese Bass', group: 'Bass', trigger: reeseBass },
  { id: 'wobble', name: 'Wobble Bass', group: 'Bass', trigger: wobbleBass },
  { id: 'growl', name: 'Growl Bass', group: 'Bass', trigger: growlBass },
  { id: 'supersaw', name: 'Supersaw', group: 'Lead / Chord', trigger: superSaw },
  { id: 'pluck', name: 'Future Pluck', group: 'Lead / Chord', trigger: futurePluck },
  { id: 'hoover', name: 'Hoover', group: 'Lead / Chord', trigger: hoover },
  { id: 'fmstab', name: 'FM Stab', group: 'Lead / Chord', trigger: fmStab },
  { id: 'glitch', name: 'Glitch Blip', group: 'FX', trigger: glitchBlip },
  // Psychoacoustic + formant (talk-box singer matrix) banks live in their own
  // modules; appended here so the picker and `getSynthVoice` see one registry.
  ...PSYCHOACOUSTIC_VOICES,
  ...FORMANT_VOICES,
  ...GLITCH_VOICES,
];

const VOICE_BY_ID = new Map<string, SynthVoice>(SYNTH_VOICES.map((v) => [v.id, v]));

/** Look up a voice by id, or null if unknown. */
export const getSynthVoice = (id: string | null | undefined): SynthVoice | null =>
  (id && VOICE_BY_ID.get(id)) || null;
