/**
 * Shared MIDI → audio synthesis.
 *
 * Centralizes the offline render path so MIDI is usable everywhere audio is:
 * preview playback, init audio, chimera fodder, and the piano roll's SEND TO
 * EDITOR bounce. Two engines sit behind one surface: the General MIDI
 * soundfont (lib/soundfontEngine) and the built-in voices (the subtractive
 * sawtooth below, and the procedural synth voices of lib/synthVoices).
 *
 * The sawtooth is byte-for-byte the voice the piano roll used inline before
 * this module existed, so previews and bounces stay consistent.
 */
import { midiStartTempo, parseMidi, type MidiFileData } from './midi';
import type { SmfControl, SmfWheel } from './midiWrite';
import type { RollControl } from '../state/pianoRollStore';
import { TICKS_PER_STEP } from './rollSnap';
import type { RollRenderBends } from './pitchBend';
import { stepNotesToRender, voiceContext, type VoiceBend } from './pitchBendVoice';
import { encodeWav } from './wavEncode';
import { isSoundfontActive, getActiveSynthVoice, renderNotesToBlobSF, renderMidiBufferToBlobSF } from './soundfontEngine';
import { getSynthVoice } from './synthVoices';
import { GM_STANDARD_KIT } from './clipProgram';
import { DRUM_CHANNEL } from './editChannels';
import { stepClock } from './rollTempo';
import { beatToTime, type TempoEvent } from './tempoMap';

/** What a step-grid render takes besides its notes: the voice, lane bends, and the roll's tempo map. */
export interface StepRenderOptions {
  program?: number;
  percussion?: boolean;
  bends?: RollRenderBends;
  /**
   * The roll's or the clip's tempo map (lib/rollTempo). Its tempi are scaled so
   * it starts at the render's `bpm`; left out, or one event, the render holds `bpm`.
   */
  tempoMap?: readonly TempoEvent[];
  /**
   * The part's controller changes on the roll's clock (RollTrack `controls`):
   * a soundfont render plays each at its step's seconds under the tempo map, on
   * every channel the notes play on. The built-in voices have no controllers.
   */
  controls?: readonly RollControl[];
}

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
  /** MIDI channel a soundfont render plays the note on; 0 when absent. A lane with a bend has its own. */
  channel?: number;
  /** The pitch bend a built-in voice follows (a soundfont render bends through RenderOptions.wheel). */
  bend?: VoiceBend;
}

export interface RenderOptions {
  /** Output sample rate. Defaults to 44.1kHz to match the rest of the app. */
  sampleRate?: number;
  /** A fixed time the render rings past its last note. Left out, a soundfont
   *  render rings for the longest release among the presets it plays and is cut
   *  where it falls silent (lib/renderTail); the built-in voices ring 0.6 s. */
  tailSec?: number;
  /** The least the rendered audio lasts, in seconds: a clip's nominal length, so
   *  its trailing rests are in the audio and not only in the reported duration. */
  minDurationSec?: number;
  /** GM program (0-127) to render through. Defaults to the globally selected
   *  instrument. Pass a clip's effective program so the bounced audio matches the
   *  instrument the live scheduler plays it with — otherwise a clip assigned an
   *  instrument after it was created exports as whatever was selected at insert.
   *  A program is a soundfont instrument, so a render given one uses the
   *  soundfont even while the picker is on Basic or a synth voice, as live
   *  playback does. */
  program?: number;
  /** Pitch wheels by channel for a soundfont render (the built-in voices bend through each note's `bend`). */
  wheel?: SmfWheel[];
  /** Controller changes by channel, in seconds, for a soundfont render (the built-in voices have none). */
  controls?: SmfControl[];
}

/** Built-in voices ring this long past the last note: the sawtooth's release and a margin. */
const BUILTIN_TAIL_SEC = 0.6;

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
 * separately (callers check `isSoundfontActive()` first). The signature of
 * `triggerSynthVoice` so it's a drop-in for preview + render, plus an optional
 * `bend` the voice follows (lib/pitchBendVoice).
 */
export const triggerActiveVoice = (
  ctx: BaseAudioContext,
  dest: AudioNode,
  midi: number,
  velocity: number,
  when: number,
  duration: number,
  master: number,
  bend?: VoiceBend,
): void => {
  const voice = getSynthVoice(getActiveSynthVoice());
  const voiceCtx = voiceContext(ctx, bend, when, duration);
  (voice ? voice.trigger : triggerSynthVoice)(voiceCtx, dest, midi, velocity, when, duration, master);
};

/** Encode an AudioBuffer to a WAV Blob. Kept as a named re-export because
 * callers outside this module import it by this name; the encoder itself lives
 * in lib/wavEncode so every bounce path in the app shares one. */
export const encodeWavBlob = (audioBuf: AudioBuffer): Blob => encodeWav(audioBuf);

/**
 * Render absolute-seconds notes to a WAV Blob. Uses the soundfont when the
 * picker is on it or the caller names a program, falling back to the built-in
 * voice if soundfonts are off or fail to render.
 */
export const renderNotesToBlob = async (
  notes: RenderNote[],
  opts: RenderOptions = {},
): Promise<{ blob: Blob; duration: number }> => {
  if (opts.program !== undefined || isSoundfontActive()) {
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
  const tail = opts.tailSec ?? BUILTIN_TAIL_SEC;
  let maxEnd = 0;
  for (const n of notes) {
    const end = n.startSec + n.durationSec;
    if (end > maxEnd) maxEnd = end;
  }
  const totalSec = Math.max(0.1, maxEnd + tail, opts.minDurationSec ?? 0);
  const offline = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);
  for (const n of notes) {
    triggerActiveVoice(offline, offline.destination, n.midi, n.velocity, n.startSec, n.durationSec, 1, n.bend);
  }
  const rendered = await offline.startRendering();
  return { blob: encodeWavBlob(rendered), duration: rendered.duration };
};

/** Render step-grid notes (piano roll / step sequencer) to a WAV Blob. With
 *  `bends` (lib/pitchBend rollRenderBends) each note follows its lane's bend,
 *  and with a `tempoMap` each note sounds at its step's seconds under the map
 *  (tempo changes, ritardandos and fermatas), its bar lines where they are.
 *  With `percussion` every note plays on the General MIDI drum channel, where
 *  `program` picks the kit (the Standard kit when left out); a drum channel has
 *  one wheel for every drum, so a percussion render carries no lane bends.
 *
 *  The audio lasts at least the pattern's nominal length, so trailing rests are
 *  in it, and rings out past the last note for as long as its instrument's
 *  release (RenderOptions.tailSec), so a final chord is not cut. */
export const renderStepNotesToBlob = async (
  notes: Array<{ note: number; velocity: number; step: number; length: number; lane?: number }>,
  bpm: number,
  totalSteps: number,
  opts: StepRenderOptions = {},
): Promise<{ blob: Blob; duration: number }> => {
  const request = stepRenderRequest(notes, bpm, totalSteps, opts);
  const result = await renderNotesToBlob(request.notes, request.options);
  return { blob: result.blob, duration: Math.max(result.duration, request.nominalSec) };
};

/** The notes and options renderStepNotesToBlob renders a step pattern with,
 *  and the pattern's nominal length in seconds. The options carry no fixed
 *  tail, so a soundfont render rings out (RenderOptions.tailSec). */
export function stepRenderRequest(
  notes: Array<{ note: number; velocity: number; step: number; length: number; lane?: number }>,
  bpm: number,
  totalSteps: number,
  opts: StepRenderOptions = {},
): { notes: RenderNote[]; options: RenderOptions; nominalSec: number } {
  // A 16th's seconds at one tempo (20-300, the app's range), or the map's clock.
  const clock = stepClock(bpm, opts.tempoMap);
  const render = stepNotesToRender(notes, clock, opts.percussion ? undefined : opts.bends);
  const nominalSec = clock.at(totalSteps);
  const played = opts.percussion ? render.notes.map((n) => ({ ...n, channel: DRUM_CHANNEL })) : render.notes;
  // A controller acts on a channel, so each change goes to every channel a note plays on (a bent lane has its own).
  const controls: SmfControl[] = [];
  if (opts.controls?.length) {
    const channels = [...new Set(played.map((n) => n.channel ?? 0))].sort((a, b) => a - b);
    for (const channel of channels) {
      for (const c of opts.controls) controls.push({ sec: clock.at(c.tick / TICKS_PER_STEP), channel, controller: c.controller, value: c.value });
    }
  }
  return {
    notes: played,
    options: {
      minDurationSec: nominalSec,
      program: opts.percussion ? (opts.program ?? GM_STANDARD_KIT) : opts.program,
      ...(render.wheel.length ? { wheel: render.wheel } : {}),
      ...(controls.length ? { controls } : {}),
    },
    nominalSec,
  };
}

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
  const notes = midiFileRenderNotes(parseMidi(buf));
  if (notes.length === 0) throw new Error('MIDI has no playable notes');
  return renderNotesBuiltin(notes);
};

/**
 * A parsed file's notes in seconds, for the built-in voice: every tempo the
 * file sets, each at its own tick, so a file that slows down renders slowing
 * down. A file with no tempo plays at its one tempo (120 when it names none),
 * and a file whose first tempo comes later plays at 120 until it (lib/midi
 * midiStartTempo), as SMF has it.
 */
export function midiFileRenderNotes(midi: MidiFileData): RenderNote[] {
  const ppq = midi.ppq || 480;
  const tempos: TempoEvent[] = midi.tempos?.length
    ? midi.tempos.map((t) => ({ beat: t.tick / ppq, bpm: t.bpm }))
    : [{ beat: 0, bpm: midi.bpm || 120 }];
  if (!tempos.some((t) => t.beat === 0)) tempos.unshift({ beat: 0, bpm: midiStartTempo(midi) });
  const secOf = (tick: number) => beatToTime(tempos, tick / ppq);
  return midi.tracks.flatMap((t) =>
    t.notes.map((n) => ({
      midi: n.note,
      velocity: n.velocity,
      startSec: secOf(n.tick),
      durationSec: Math.max(0.02, secOf(n.tick + n.durationTicks) - secOf(n.tick)),
    })),
  );
}
