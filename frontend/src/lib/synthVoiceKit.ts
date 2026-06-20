/**
 * Shared building blocks for the procedural synth voices. The EDM bank
 * (`synthVoices.ts`) and the psychoacoustic bank (`psychoacousticVoices.ts`)
 * both build on these so a voice is the same shape no matter which file it
 * lives in: a Web Audio graph scheduled on a `when`/`duration` window that
 * connects into a single `dest` node.
 */

export type VoiceTrigger = (
  ctx: BaseAudioContext,
  dest: AudioNode,
  midi: number,
  velocity: number,
  when: number,
  duration: number,
  master: number,
) => void;

export interface SynthVoice {
  id: string;
  name: string;
  /** optgroup label in the instrument picker. */
  group: string;
  trigger: VoiceTrigger;
}

/** MIDI note number to frequency in Hz (A4 = 69 = 440 Hz). */
export const mtof = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

// Soft-clip distortion curves, cached by drive amount (building one per note is wasteful).
const distCurves = new Map<number, Float32Array>();
export const distCurve = (amount: number): Float32Array => {
  const cached = distCurves.get(amount);
  if (cached) return cached;
  const n = 1024;
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  distCurves.set(amount, curve);
  return curve;
};

/** Standard exponential AD/AR gain envelope on a fresh GainNode. */
export const ampEnv = (
  ctx: BaseAudioContext,
  when: number,
  duration: number,
  peak: number,
  attack = 0.008,
  release = 0.06,
): GainNode => {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + attack);
  g.gain.setTargetAtTime(0.0001, when + duration, release);
  return g;
};
