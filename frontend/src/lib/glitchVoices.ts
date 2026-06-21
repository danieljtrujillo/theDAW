/**
 * Glitch-hop synth voices — crunchy, wonky, half-time-friendly instruments:
 * distorted neuro basses, crushed stabs, FM screeches, and laser FX. Same
 * VoiceTrigger signature as the EDM bank in ./synthVoices, so they drop into the
 * piano-roll preview, the offline bounce, and live timeline MIDI. Merged into the
 * shared SYNTH_VOICES registry there, so the instrument picker lists them under
 * "Synth - Glitch-Hop".
 */

import type { SynthVoice, VoiceTrigger } from './synthVoiceKit';
import { mtof, distCurve, ampEnv } from './synthVoiceKit';

const GROUP = 'Glitch-Hop';

/* Distorted, filter-swept three-saw bass. The classic crunchy glitch-hop low end. */
const crunchBass: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(70);
  shaper.oversample = '4x';
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.setValueAtTime(3, when);
  lp.frequency.setValueAtTime(Math.min(5000, f * 8), when);
  lp.frequency.exponentialRampToValueAtTime(Math.max(180, f * 2.5), when + Math.min(Math.max(dur, 0.05), 0.3));
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.42 * master, 0.006, 0.08);
  shaper.connect(lp).connect(env).connect(dest);
  for (const det of [-12, 0, 7]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, when);
    o.detune.setValueAtTime(det, when);
    o.connect(shaper);
    o.start(when);
    o.stop(when + dur + 0.25);
  }
};

/* Off-kilter bass: stepped crush plus a slow triangle wobble on the cutoff. */
const wonkyBass: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(35);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.setValueAtTime(7, when);
  lp.frequency.setValueAtTime(0, when); // cutoff comes entirely from base + LFO
  const base = ctx.createConstantSource();
  base.offset.setValueAtTime(900, when);
  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.setValueAtTime(3, when);
  const lfoGain = ctx.createGain();
  lfoGain.gain.setValueAtTime(700, when);
  base.connect(lp.frequency);
  lfo.connect(lfoGain).connect(lp.frequency);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.45 * master, 0.01, 0.07);
  shaper.connect(lp).connect(env).connect(dest);
  for (const det of [-7, 5]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(f, when);
    o.detune.setValueAtTime(det, when);
    o.connect(shaper);
    o.start(when);
    o.stop(when + dur + 0.2);
  }
  base.start(when);
  lfo.start(when);
  base.stop(when + dur + 0.2);
  lfo.stop(when + dur + 0.2);
};

/* Short crushed minor-cluster chord hit with a fast bandpass drop. */
const glitchStab: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(28);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.setValueAtTime(1.2, when);
  bp.frequency.setValueAtTime(f * 4, when);
  bp.frequency.exponentialRampToValueAtTime(Math.max(300, f * 1.5), when + 0.08);
  const peak = (vel / 127) * 0.5 * master;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(Math.max(dur, 0.08), 0.3));
  shaper.connect(bp).connect(env).connect(dest);
  for (const semi of [0, 3, 7]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(mtof(midi + semi), when);
    o.connect(shaper);
    o.start(when);
    o.stop(when + 0.5);
  }
};

/* FM screech lead: a fast-decaying modulator into a distorted, sweeping bandpass. */
const neuroScreech: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const carrier = ctx.createOscillator();
  carrier.type = 'sawtooth';
  carrier.frequency.setValueAtTime(f, when);
  const mod = ctx.createOscillator();
  mod.type = 'square';
  mod.frequency.setValueAtTime(f * 1.5, when);
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(f * 6, when);
  modGain.gain.exponentialRampToValueAtTime(Math.max(1, f), when + 0.18);
  mod.connect(modGain).connect(carrier.frequency);
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(60);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.setValueAtTime(5, when);
  bp.frequency.setValueAtTime(900, when);
  bp.frequency.exponentialRampToValueAtTime(3500, when + Math.min(Math.max(dur, 0.05), 0.25));
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.32 * master, 0.008, 0.09);
  carrier.connect(shaper).connect(bp).connect(env).connect(dest);
  carrier.start(when);
  mod.start(when);
  carrier.stop(when + dur + 0.3);
  mod.stop(when + dur + 0.3);
};

/* Downward pitch-swept square zap for glitch fills and accents. */
const laserZap: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const o = ctx.createOscillator();
  o.type = 'square';
  o.frequency.setValueAtTime(f * 4, when);
  o.frequency.exponentialRampToValueAtTime(Math.max(60, f * 0.5), when + 0.18);
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(22);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(250, when);
  const peak = (vel / 127) * 0.4 * master;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.003);
  env.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(Math.max(dur, 0.12), 0.4));
  o.connect(shaper).connect(hp).connect(env).connect(dest);
  o.start(when);
  o.stop(when + 0.5);
};

/* Ring-modulated saw for a metallic, robotic / vocoder-ish tone. */
const roboTone: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(f, when);
  const ring = ctx.createGain();
  ring.gain.setValueAtTime(0, when); // carrier drives the computed gain => signal x carrier
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.setValueAtTime(f * 1.5 + 60, when);
  carrier.connect(ring.gain);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(6000, f * 6), when);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.4 * master, 0.01, 0.08);
  o.connect(ring).connect(lp).connect(env).connect(dest);
  o.start(when);
  carrier.start(when);
  o.stop(when + dur + 0.25);
  carrier.stop(when + dur + 0.25);
};

export const GLITCH_VOICES: readonly SynthVoice[] = [
  { id: 'gh-crunch', name: 'Crunch Bass', group: GROUP, trigger: crunchBass },
  { id: 'gh-wonky', name: 'Wonky Bass', group: GROUP, trigger: wonkyBass },
  { id: 'gh-stab', name: 'Glitch Stab', group: GROUP, trigger: glitchStab },
  { id: 'gh-neuro', name: 'Neuro Screech', group: GROUP, trigger: neuroScreech },
  { id: 'gh-zap', name: 'Laser Zap', group: GROUP, trigger: laserZap },
  { id: 'gh-robo', name: 'Robo Tone', group: GROUP, trigger: roboTone },
];
