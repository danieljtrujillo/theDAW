/**
 * Formant / talk-box voices — the full singer matrix.
 *
 * Five voice types (Bass, Tenor, Countertenor, Alto, Soprano) times the five
 * sung vowels (a, e, i, o, u), each driven by the canonical Csound formant
 * tables (F1-F5 with amplitude in dB and bandwidth in Hz). A single sawtooth
 * glottal source is shaped by a parallel bank of five bandpass formant filters,
 * which is the classic subtractive vowel-synthesis model.
 *
 * Source: Csound manual, "Formant Values by Voice Type and Vowel".
 */

import type { SynthVoice, VoiceTrigger } from './synthVoiceKit';
import { mtof, ampEnv } from './synthVoiceKit';

type VoiceType = 'Bass' | 'Tenor' | 'Countertenor' | 'Alto' | 'Soprano';
type Vowel = 'a' | 'e' | 'i' | 'o' | 'u';

/** One formant: [frequency Hz, amplitude dB, bandwidth Hz]. */
type Formant = readonly [freq: number, dB: number, bw: number];

const FORMANT_TABLE: Record<VoiceType, Record<Vowel, readonly Formant[]>> = {
  Bass: {
    a: [[600, -7, 60], [1040, -7, 70], [2250, -9, 110], [2450, -9, 120], [2750, -20, 130]],
    e: [[400, 0, 40], [1620, -12, 80], [2400, -9, 100], [2800, -12, 120], [3100, -18, 120]],
    i: [[250, 0, 60], [1750, -30, 90], [2600, -16, 100], [3050, -22, 120], [3340, -28, 120]],
    o: [[400, 0, 40], [750, -11, 80], [2400, -21, 100], [2600, -20, 120], [2900, -40, 120]],
    u: [[350, 0, 40], [600, -20, 80], [2400, -32, 100], [2675, -28, 120], [2950, -36, 120]],
  },
  Tenor: {
    a: [[650, 0, 80], [1080, -6, 90], [2650, -7, 120], [2900, -8, 130], [3250, -22, 140]],
    e: [[400, 0, 70], [1700, -14, 80], [2600, -12, 100], [3200, -14, 120], [3580, -20, 120]],
    i: [[290, 0, 40], [1870, -15, 90], [2800, -18, 100], [3250, -20, 120], [3540, -30, 120]],
    o: [[400, 0, 70], [800, -10, 80], [2600, -12, 100], [2800, -12, 130], [3000, -26, 135]],
    u: [[350, 0, 40], [600, -20, 60], [2700, -17, 100], [2900, -14, 120], [3300, -26, 120]],
  },
  Countertenor: {
    a: [[660, 0, 80], [1120, -6, 90], [2750, -23, 120], [3000, -24, 130], [3350, -38, 140]],
    e: [[440, 0, 70], [1800, -14, 80], [2700, -18, 100], [3000, -20, 120], [3300, -20, 120]],
    i: [[270, 0, 40], [1850, -24, 90], [2900, -24, 100], [3350, -36, 120], [3590, -36, 120]],
    o: [[430, 0, 40], [820, -10, 80], [2700, -26, 100], [3000, -22, 120], [3300, -34, 120]],
    u: [[370, 0, 40], [630, -20, 60], [2750, -23, 100], [3000, -30, 120], [3400, -34, 120]],
  },
  Alto: {
    a: [[800, 0, 80], [1150, -4, 90], [2800, -20, 120], [3500, -36, 130], [4950, -60, 140]],
    e: [[400, 0, 60], [1600, -24, 80], [2700, -30, 120], [3300, -35, 150], [4950, -60, 200]],
    i: [[350, 0, 50], [1700, -20, 100], [2700, -30, 120], [3700, -36, 150], [4950, -60, 200]],
    o: [[450, 0, 70], [800, -9, 80], [2830, -16, 100], [3500, -28, 130], [4950, -55, 135]],
    u: [[325, 0, 50], [700, -12, 60], [2530, -30, 170], [3500, -40, 180], [4950, -64, 200]],
  },
  Soprano: {
    a: [[800, 0, 80], [1150, -6, 90], [2900, -32, 120], [3900, -20, 130], [4950, -50, 140]],
    e: [[350, 0, 60], [2000, -20, 100], [2800, -15, 120], [3600, -40, 150], [4950, -56, 200]],
    i: [[270, 0, 60], [2140, -12, 90], [2950, -26, 100], [3900, -26, 120], [4950, -44, 120]],
    o: [[450, 0, 40], [800, -11, 80], [2830, -22, 100], [3800, -22, 120], [4950, -50, 120]],
    u: [[325, 0, 50], [700, -16, 60], [2700, -35, 170], [3800, -40, 180], [4950, -60, 200]],
  },
};

/** Build a vowel voice: a sawtooth glottal source through a parallel bandpass
 *  formant bank. Per-vowel gains are normalized so the loudest formant sits at
 *  unity, which keeps the authentic formant balance but levels the 25 voices. */
const makeFormantVoice = (formants: readonly Formant[]): VoiceTrigger => {
  const maxDb = Math.max(...formants.map((f) => f[1]));
  return (ctx, dest, midi, vel, when, dur, master) => {
    const env = ampEnv(ctx, when, dur, (vel / 127) * 0.5 * master, 0.02, 0.12);
    env.connect(dest);
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(mtof(midi), when);
    for (const [freq, dB, bw] of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(freq, when);
      bp.Q.setValueAtTime(Math.max(1, freq / bw), when);
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.pow(10, (dB - maxDb) / 20), when);
      src.connect(bp).connect(g).connect(env);
    }
    src.start(when);
    src.stop(when + dur + 0.2);
  };
};

const VOICE_TYPES: readonly VoiceType[] = ['Bass', 'Tenor', 'Countertenor', 'Alto', 'Soprano'];
const VOWELS: readonly Vowel[] = ['a', 'e', 'i', 'o', 'u'];
const VOWEL_LABEL: Record<Vowel, string> = {
  a: 'a (ah)',
  e: 'e (eh)',
  i: 'i (ee)',
  o: 'o (oh)',
  u: 'u (oo)',
};

/** All 25 voice-type x vowel talk-box voices, grouped per voice type so the
 *  instrument picker shows "Synth · Talk-Box (Bass)", "(Tenor)", and so on. */
export const FORMANT_VOICES: readonly SynthVoice[] = VOICE_TYPES.flatMap((type) =>
  VOWELS.map((vowel) => ({
    id: `tb-${type.toLowerCase()}-${vowel}`,
    name: VOWEL_LABEL[vowel],
    group: `Talk-Box (${type})`,
    trigger: makeFormantVoice(FORMANT_TABLE[type][vowel]),
  })),
);
