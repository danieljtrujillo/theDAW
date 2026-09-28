/**
 * Offline loudness of one preset in a sound bank, rendered through the same
 * SpessaSynth core the app plays with.
 *
 * `scripts/build_orchestra_sf3.py` levels its bank against the bundled
 * `gm.sf3` with this: it renders a held note per preset in both banks and
 * sets a per-preset gain from the difference. The level is the loudest
 * 100 ms RMS window of the note, so a staccato and a sustained note on the
 * same program are compared by their body rather than by their length.
 *
 * `soundbankLevelsCli.ts` is the command-line wrapper the build runs.
 */
import { SoundBankLoader, SpessaSynthProcessor, type BasicSoundBank } from 'spessasynth_core';

export interface LevelJob {
  /** Bank select (CC0). 128 plays the drum channel. */
  bank: number;
  program: number;
  note: number;
  velocity: number;
  /** CC1 held for the whole note. */
  cc1: number;
  /** Seconds rendered; the note is held throughout. Default 1.5. */
  seconds?: number;
}

export interface LevelResult {
  /** Loudest 100 ms RMS window, in dBFS of one output channel. */
  rmsDb: number;
  /** Largest absolute sample on either output channel. */
  peak: number;
  /** Name of the preset SpessaSynth actually played. */
  preset: string | null;
  presetBank: number | null;
  presetProgram: number | null;
}

export const LEVEL_SAMPLE_RATE = 44100;
const BLOCK = 128;
const WINDOW_S = 0.1;

export function loadBank(buffer: ArrayBuffer): BasicSoundBank {
  return SoundBankLoader.fromArrayBuffer(buffer);
}

/** Loudest `WINDOW_S` RMS over both channels, in dB. */
export function maxWindowRmsDb(left: Float32Array, right: Float32Array, rate = LEVEL_SAMPLE_RATE): number {
  const win = Math.max(1, Math.round(WINDOW_S * rate));
  const hop = Math.max(1, Math.round(win / 4));
  let best = 0;
  for (let start = 0; start + win <= left.length; start += hop) {
    let sum = 0;
    for (let i = start; i < start + win; i += 1) sum += left[i] * left[i] + right[i] * right[i];
    best = Math.max(best, sum / (2 * win));
  }
  return 10 * Math.log10(best + 1e-20);
}

/**
 * Render and measure one held note. `afterProgram` runs once the channel has
 * its program, before the note: the app's per-channel playback gain
 * (lib/soundbankGain) is applied there, as the engine applies it live.
 */
export async function measureLevel(
  bank: BasicSoundBank,
  job: LevelJob,
  afterProgram?: (synth: SpessaSynthProcessor, channel: number) => void,
): Promise<LevelResult> {
  const synth = new SpessaSynthProcessor(LEVEL_SAMPLE_RATE, { effectsEnabled: false });
  await synth.processorInitialized;
  synth.soundBankManager.addSoundBank(bank, 'main');
  const drums = job.bank === 128;
  const ch = drums ? 9 : 0;
  // No reverb or chorus send: the level is the dry note.
  synth.controllerChange(ch, 91, 0);
  synth.controllerChange(ch, 93, 0);
  if (!drums) {
    synth.controllerChange(ch, 0, job.bank);
    synth.controllerChange(ch, 32, 0);
  }
  synth.programChange(ch, job.program);
  afterProgram?.(synth, ch);
  synth.controllerChange(ch, 1, job.cc1);
  synth.noteOn(ch, job.note, job.velocity);
  const frames = Math.round((job.seconds ?? 1.5) * LEVEL_SAMPLE_RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += BLOCK) synth.process(left, right, i, Math.min(BLOCK, frames - i));
  let peak = 0;
  for (let i = 0; i < frames; i += 1) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const preset = synth.midiChannels[ch].preset;
  return {
    rmsDb: maxWindowRmsDb(left, right),
    peak,
    preset: preset?.name ?? null,
    presetBank: preset ? (preset.isGMGSDrum ? 128 : preset.bankMSB) : null,
    presetProgram: preset?.program ?? null,
  };
}
