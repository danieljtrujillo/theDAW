/**
 * Psychoacoustic synth voices — instruments built around how hearing actually
 * works rather than around a raw waveform. Same `VoiceTrigger` shape as the EDM
 * bank, so they drop into the picker, live preview, offline bounce, and the
 * timeline with no extra plumbing.
 *
 * Each voice leans on a real auditory phenomenon:
 *   - missing fundamental / residue pitch (Phantom Sub)
 *   - subharmonic reinforcement (Subharmonic Sub)
 *   - binaural beats (Binaural Drone, headphones)
 *   - vowel formants (Formant Talk-Box)
 *   - Shepard / barberpole pitch illusion (Shepard Lead)
 *   - HRTF spatialization (Orbit Pad)
 *   - the precedence / Haas effect (Haas Pluck)
 *   - combination (Tartini) tones (Difference-Tone Bell)
 */

import type { SynthVoice, VoiceTrigger } from './synthVoiceKit';
import { mtof, distCurve, ampEnv } from './synthVoiceKit';

/* ── Bass / sub ──────────────────────────────────────────────────────────────── */

/** Renders the harmonics of the note but NOT its fundamental. The ear's
 *  residue-pitch mechanism reconstructs the low note, so it reads as deep bass
 *  even through speakers/earbuds that cannot reproduce the real fundamental. */
const phantomSub: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.4 * master, 0.012, 0.09);
  // keep the partials smooth, not fizzy
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(2400, f * 8), when);
  lp.connect(env).connect(dest);
  const partials: Array<[number, number]> = [
    [2, 1.0],
    [3, 0.6],
    [4, 0.4],
    [5, 0.22],
  ];
  for (const [h, a] of partials) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * h, when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(a, when);
    o.connect(g).connect(lp);
    o.start(when);
    o.stop(when + dur + 0.25);
  }
};

/** Fundamental plus a tracked octave-down subharmonic for seismic weight, with
 *  a touch of saturation so small drivers still render harmonics of the sub. */
const subharmonicSub: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.75 * master, 0.014, 0.1);
  const shaper = ctx.createWaveShaper();
  shaper.curve = distCurve(2);
  shaper.oversample = '2x';
  shaper.connect(env).connect(dest);
  const add = (freq: number, amp: number) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, when);
    o.connect(g).connect(shaper);
    o.start(when);
    o.stop(when + dur + 0.3);
  };
  add(f, 0.7); // fundamental
  add(f / 2, 0.55); // subharmonic — the seismic octave-down
};

/* ── Spatial / binaural ──────────────────────────────────────────────────────── */

/** Pure tone in the left ear, the same tone offset by a few Hz in the right.
 *  Over headphones the brain fuses them into a slow beat at the difference
 *  frequency (here ~7 Hz). Sine purity matters, so no detune stack. */
const binauralDrone: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const beatHz = 7;
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.4 * master, 0.06, 0.25);
  env.connect(dest);
  const ear = (freq: number, pan: number) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, when);
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(pan, when);
    o.connect(p).connect(env);
    o.start(when);
    o.stop(when + dur + 0.3);
  };
  ear(f, -1);
  ear(f + beatHz, 1);
};

/** A lush detuned-saw pad fed through an HRTF panner that drifts around the
 *  listener's head (two LFOs at slightly different rates trace an evolving
 *  orbit). This is the "spatial oscillation" / 3D-movement voice. */
const orbitPad: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.26 * master, 0.08, 0.35);
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 1;
  panner.connect(env).connect(dest);
  panner.positionY.setValueAtTime(0, when);
  const orbit = (rate: number, target: AudioParam, radius: number) => {
    target.setValueAtTime(0, when);
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(rate, when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(radius, when);
    lfo.connect(g).connect(target);
    lfo.start(when);
    lfo.stop(when + dur + 0.4);
  };
  orbit(0.3, panner.positionX, 2.2);
  orbit(0.23, panner.positionZ, 2.2); // different rate -> the orbit slowly evolves
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(8000, f * 8), when);
  lp.Q.setValueAtTime(0.4, when);
  lp.connect(panner);
  for (const d of [-8, 0, 8]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, when);
    o.detune.setValueAtTime(d, when);
    o.connect(lp);
    o.start(when);
    o.stop(when + dur + 0.4);
  }
};

/** The Haas / precedence effect: a dry transient hard-left and a copy delayed
 *  under ~25 ms hard-right. The ear localizes to the first arrival but fuses
 *  the pair into one wide image, so it sounds huge without obvious phasing. */
const haasPluck: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const peak = (vel / 127) * 0.5 * master;
  const oneSide = (pan: number, delaySec: number) => {
    const start = when + delaySec;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, start + Math.min(Math.max(dur, 0.15), 0.5));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.setValueAtTime(1, start);
    lp.frequency.setValueAtTime(f * 10, start);
    lp.frequency.exponentialRampToValueAtTime(Math.max(220, f * 2.5), start + 0.18);
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(pan, when);
    lp.connect(env).connect(p).connect(dest);
    for (const d of [-6, 0, 6]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(f, start);
      o.detune.setValueAtTime(d, start);
      o.connect(lp);
      o.start(start);
      o.stop(start + 0.7);
    }
  };
  oneSide(-0.85, 0); // first arrival
  oneSide(0.85, 0.018); // 18 ms later -> width
};

/* ── Lead / tonal illusions ──────────────────────────────────────────────────── */

/** Shepard / barberpole lead: the pitch class stacked across five octaves under
 *  a fixed bell-shaped spectral envelope, with a slow upward glide. The spectrum
 *  stays put while pitch seems to climb forever. */
const shepardLead: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const env = ampEnv(ctx, when, dur, (vel / 127) * 0.26 * master, 0.03, 0.16);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(7000, when);
  lp.connect(env).connect(dest);
  const centerOct = 2;
  for (let oct = 0; oct < 5; oct += 1) {
    const f = mtof(midi - 24 + oct * 12);
    const weight = Math.exp(-Math.pow(oct - centerOct, 2) / 2.0);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, when);
    o.frequency.exponentialRampToValueAtTime(f * 1.04, when + Math.max(dur, 0.2));
    const g = ctx.createGain();
    g.gain.setValueAtTime(weight * 0.35, when);
    o.connect(g).connect(lp);
    o.start(when);
    o.stop(when + dur + 0.3);
  }
};

/** Two high sine partials whose spacing equals the note's fundamental, so the
 *  ear generates a combination (Tartini) tone at that pitch. A bell that rings
 *  a bass note that is not actually present in the signal. */
const differenceToneBell: VoiceTrigger = (ctx, dest, midi, vel, when, dur, master) => {
  const f = mtof(midi);
  const peak = (vel / 127) * 0.4 * master;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, when);
  env.gain.exponentialRampToValueAtTime(peak, when + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, when + Math.min(Math.max(dur, 0.4), 2.2));
  env.connect(dest);
  // 8f and 9f differ by f -> combination tone at the fundamental; a faint real
  // f anchors the pitch without filling in the illusion entirely.
  const partials: Array<[number, number]> = [
    [8, 0.5],
    [9, 0.5],
    [1, 0.12],
  ];
  for (const [mult, amp] of partials) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * mult, when);
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, when);
    o.connect(g).connect(env);
    o.start(when);
    o.stop(when + 2.5);
  }
};

export const PSYCHOACOUSTIC_VOICES: readonly SynthVoice[] = [
  { id: 'phantom-sub', name: 'Phantom Sub', group: 'Psychoacoustic', trigger: phantomSub },
  { id: 'subharmonic', name: 'Subharmonic Sub', group: 'Psychoacoustic', trigger: subharmonicSub },
  { id: 'binaural', name: 'Binaural Drone', group: 'Psychoacoustic', trigger: binauralDrone },
  { id: 'orbit', name: 'Orbit Pad', group: 'Psychoacoustic', trigger: orbitPad },
  { id: 'haas', name: 'Haas Pluck', group: 'Psychoacoustic', trigger: haasPluck },
  { id: 'shepard', name: 'Shepard Lead', group: 'Psychoacoustic', trigger: shepardLead },
  { id: 'difference-bell', name: 'Difference-Tone Bell', group: 'Psychoacoustic', trigger: differenceToneBell },
];
