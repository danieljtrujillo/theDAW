/**
 * Shared MIDI → audio synthesis.
 *
 * Centralizes the offline render path so MIDI is usable everywhere audio is:
 * preview playback, init audio, chimera fodder, and the piano roll's SEND TO
 * EDITOR bounce. Today the only engine is a built-in subtractive sawtooth
 * voice (no soundfont dependency), but the public surface is engine-shaped so
 * a sample/soundfont engine can be dropped in later without touching callers.
 *
 * The voice is byte-for-byte the same one the piano roll used inline before
 * this module existed, so previews and bounces stay consistent.
 */
import { parseMidi } from './midi';
import { isSoundfontActive, getActiveSynthVoice, renderNotesToBlobSF, renderMidiBufferToBlobSF } from './soundfontEngine';
import { getSynthVoice } from './synthVoices';

/** One note in absolute seconds — the engine-neutral render unit. */
export interface RenderNote {
  /** MIDI note number 0-127 (60 = middle C). */
  midi: number;
  /** Start time in seconds from the render origin. */
  startSec: number;
  /** Sounding length in seconds. */
  durationSec: number;
  /** Velocity 1-127. */
  velocity: number;
}

export interface RenderOptions {
  /** Output sample rate. Defaults to 44.1kHz to match the rest of the app. */
  sampleRate?: number;
  /** Silence appended after the last note so tails aren't clipped. */
  tailSec?: number;
}

/**
 * Schedule a single sawtooth + lowpass + envelope voice on any audio context.
 * Works on both a live `AudioContext` (preview) and an `OfflineAudioContext`
 * (render), since it only touches the standard `BaseAudioContext` surface.
 */
export const triggerSynthVoice = (
  ctx: BaseAudioContext,
  dest: AudioNode,
  midi: number,
  velocity: number,
  when: number,
  duration: number,
  master: number,
): void => {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, when);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(8000, freq * 6), when);
  const env = ctx.createGain();
  const peak = (velocity / 127) * 0.7 * master;
  env.gain.setValueAtTime(0.001, when);
  env.gain.exponentialRampToValueAtTime(peak, when + 0.008);
  env.gain.setTargetAtTime(peak * 0.5, when + 0.05, 0.08);
  env.gain.setTargetAtTime(0.001, when + duration, 0.05);
  osc.connect(lp).connect(env).connect(dest);
  osc.start(when);
  osc.stop(when + duration + 0.2);
};

/**
 * Trigger the currently-selected built-in voice: a procedural synth voice if one
 * is active (EDM bank), else the basic sawtooth. Soundfont selection is handled
 * separately (callers check `isSoundfontActive()` first). Same signature as
 * `triggerSynthVoice` so it's a drop-in for preview + render.
 */
export const triggerActiveVoice: typeof triggerSynthVoice = (
  ctx,
  dest,
  midi,
  velocity,
  when,
  duration,
  master,
) => {
  const voice = getSynthVoice(getActiveSynthVoice());
  (voice ? voice.trigger : triggerSynthVoice)(ctx, dest, midi, velocity, when, duration, master);
};

/** Encode an AudioBuffer to a 16-bit PCM WAV Blob. */
export const encodeWavBlob = (audioBuf: AudioBuffer): Blob => {
  const numCh = audioBuf.numberOfChannels;
  const sr = audioBuf.sampleRate;
  const len = audioBuf.length;
  const buffer = new ArrayBuffer(44 + len * numCh * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * numCh * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * numCh * 2, true);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c += 1) channels.push(audioBuf.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < len; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
};

/**
 * Render absolute-seconds notes to a WAV Blob. Uses the active soundfont
 * instrument when one is selected, falling back to the built-in sawtooth voice
 * if soundfonts are off or fail to render.
 */
export const renderNotesToBlob = async (
  notes: RenderNote[],
  opts: RenderOptions = {},
): Promise<{ blob: Blob; duration: number }> => {
  if (isSoundfontActive()) {
    try {
      return await renderNotesToBlobSF(notes, opts);
    } catch {
      /* fall back to the built-in voice below */
    }
  }
  return renderNotesBuiltin(notes, opts);
};

/** The built-in render path: routes through the active synth voice (EDM bank)
 *  or the basic sawtooth. Used when no soundfont is selected. */
const renderNotesBuiltin = async (
  notes: RenderNote[],
  opts: RenderOptions = {},
): Promise<{ blob: Blob; duration: number }> => {
  const sr = opts.sampleRate ?? 44100;
  const tail = opts.tailSec ?? 0.6;
  let maxEnd = 0;
  for (const n of notes) {
    const end = n.startSec + n.durationSec;
    if (end > maxEnd) maxEnd = end;
  }
  const totalSec = Math.max(0.1, maxEnd + tail);
  const offline = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);
  for (const n of notes) {
    triggerActiveVoice(offline, offline.destination, n.midi, n.velocity, n.startSec, n.durationSec, 1);
  }
  const rendered = await offline.startRendering();
  return { blob: encodeWavBlob(rendered), duration: rendered.duration };
};

/** Render step-grid notes (piano roll / step sequencer) to a WAV Blob. */
export const renderStepNotesToBlob = async (
  notes: Array<{ note: number; velocity: number; step: number; length: number }>,
  bpm: number,
  totalSteps: number,
): Promise<{ blob: Blob; duration: number }> => {
  const stepSec = 60 / Math.max(40, bpm) / 4; // 16th-note seconds
  const renderNotes: RenderNote[] = notes.map((n) => ({
    midi: n.note,
    velocity: n.velocity,
    startSec: n.step * stepSec,
    durationSec: n.length * stepSec,
  }));
  // Pad to the pattern's nominal length so trailing rests are preserved.
  const result = await renderNotesToBlob(renderNotes, { tailSec: 0.6 });
  const nominal = totalSteps * stepSec;
  return { blob: result.blob, duration: Math.max(result.duration, nominal) };
};

/**
 * Parse a Standard MIDI File buffer and render it to a WAV Blob. Uses the active
 * soundfont (honoring the file's own program changes) when one is selected,
 * falling back to the built-in sawtooth voice otherwise.
 */
export const renderMidiBufferToBlob = async (
  buf: ArrayBuffer | Uint8Array,
): Promise<{ blob: Blob; duration: number }> => {
  if (isSoundfontActive()) {
    try {
      return await renderMidiBufferToBlobSF(buf);
    } catch {
      /* fall back to the built-in voice below */
    }
  }
  const midi = parseMidi(buf);
  const ppq = midi.ppq || 480;
  const bpm = midi.bpm || 120;
  const secPerTick = 60 / Math.max(20, bpm) / ppq;
  const notes: RenderNote[] = midi.tracks.flatMap((t) =>
    t.notes.map((n) => ({
      midi: n.note,
      velocity: n.velocity,
      startSec: n.tick * secPerTick,
      durationSec: Math.max(0.02, n.durationTicks * secPerTick),
    })),
  );
  if (notes.length === 0) throw new Error('MIDI has no playable notes');
  return renderNotesBuiltin(notes);
};
