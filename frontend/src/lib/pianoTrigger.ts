/**
 * Standalone piano-note trigger.
 *
 * Extracted from PianoRoll.tsx so the global Web MIDI listener (App.tsx) and the
 * Sway control surface (state/swaySurface.ts) can play a controller note WITHOUT
 * importing the whole PianoRoll component graph — which drags AiComposePopover ->
 * aiComposeClient -> @google/genai (and the rest of the MIDI-tab UI) into the
 * eager first-paint bundle. Those callers only need the synth voice, which lives
 * in lib/midiSynth + lib/soundfontEngine, so this module keeps their import graph
 * tiny. PianoRoll itself imports these back for its own scheduling.
 */
import { getEngineCtx, getMasterGain } from '../state/playerStore';
import { triggerActiveVoice } from './midiSynth';
import type { VoiceBend } from './pitchBendVoice';
import { ensureSoundfontReady, isLiveSynthReady, isSoundfontActive, liveNoteOff, liveNoteOn, previewNoteSF } from './soundfontEngine';
import { DRUM_CHANNEL } from './editChannels';
import { KEYBOARD_LIVE_CHANNEL } from './pitchBend';
import type { ClipVoice } from './clipProgram';

/** Where a scheduled roll note plays: its soundfont channel (a lane with a pitch
 *  bend has its own, and every part after the first has its own, lib/rollTracks
 *  rollLiveChannels), the bend a built-in voice follows, and the program and
 *  bank it sounds (its part's, lib/rollTracks partVoice). A program plays
 *  through the soundfont even while the picker is on Basic, as the clip does in
 *  EDIT; `percussion` puts the note on a drum channel, where the program is the
 *  kit: `channel` when it is one (a channel n with n % 16 === 9), else 9. */
export interface PianoNoteVoice {
  channel?: number;
  bend?: VoiceBend;
  program?: number;
  bank?: number;
  percussion?: boolean;
}

/** True for a soundfont channel SpessaSynth plays as drums: every n with n % 16 === 9. */
export const isDrumChannel = (channel: number | undefined): boolean => channel !== undefined && channel % 16 === DRUM_CHANNEL;

/** Live preview convenience: route the shared synth voice through the engine
 *  master/analyser. The voice itself lives in `lib/midiSynth` so previews,
 *  bounces, and library MIDI renders all sound identical. */
export const triggerPianoNote = (
  midi: number,
  velocity: number,
  when: number,
  duration: number,
  master: number,
  voice?: PianoNoteVoice,
) => {
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume();
  if (voice?.program !== undefined || isSoundfontActive()) {
    // The soundfont note is timed at `when` on the synth. Its bend is the
    // channel's pitch wheel, which the roll's scheduler sends for the same times.
    const channel = voice?.percussion ? (isDrumChannel(voice.channel) ? (voice.channel as number) : DRUM_CHANNEL) : voice?.channel ?? 0;
    void previewNoteSF(midi, velocity, duration, channel, when, voice?.program, voice?.percussion ? 0 : voice?.bank ?? 0);
    return;
  }
  triggerActiveVoice(ctx, getMasterGain(), midi, velocity, when, duration, master, voice?.bend);
};

/**
 * A one-shot controller note: the Sway surface's pads before the soundfont is
 * live. Defaults `when` to the engine's current time + a tiny lookahead,
 * `duration` to a 180 ms decay, and `master` to 0.8. A hardware keyboard holds
 * its notes instead (startHeldNote, lib/keyboardMonitor).
 */
export const triggerPianoNoteFromMidi = (midi: number, velocity = 100, duration = 0.18) => {
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume();
  triggerPianoNote(midi, velocity, ctx.currentTime + 0.02, duration, 0.8);
};

/** The longest a built-in voice holds a key before its own envelope ends the note. */
export const MAX_BUILTIN_HOLD_SEC = 16;

/** What startHeldNote started, for stopHeldNote. */
export type HeldNote =
  | { kind: 'soundfont'; channel: number; note: number }
  | { kind: 'builtin'; gate: GainNode };

/**
 * Start a hardware keyboard's key and keep it sounding until stopHeldNote. A
 * voice with a program plays on the preview synth's keyboard channel (the drum
 * channel for a percussion voice), switched to that program. Until the
 * soundfont is live, and for a voice with no program (the picker on Basic or a
 * synth voice), the built-in voice plays it through a gate that stopHeldNote
 * closes.
 */
export const startHeldNote = (note: number, velocity: number, voice: ClipVoice): HeldNote => {
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume();
  if (voice.program !== undefined && isLiveSynthReady()) {
    const channel = voice.percussion ? DRUM_CHANNEL : KEYBOARD_LIVE_CHANNEL;
    liveNoteOn(channel, voice.program, note, velocity);
    return { kind: 'soundfont', channel, note };
  }
  if (voice.program !== undefined) void ensureSoundfontReady(); // the next key plays the soundfont
  const gate = ctx.createGain();
  gate.connect(getMasterGain());
  triggerActiveVoice(ctx, gate, note, velocity, ctx.currentTime + 0.005, MAX_BUILTIN_HOLD_SEC, 0.8);
  return { kind: 'builtin', gate };
};

/** Release a key startHeldNote started: a note-off, or the gate closing over the built-in voice's release. */
export const stopHeldNote = (held: HeldNote): void => {
  if (held.kind === 'soundfont') {
    liveNoteOff(held.channel, held.note);
    return;
  }
  const ctx = getEngineCtx();
  held.gate.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
  window.setTimeout(() => {
    try {
      held.gate.disconnect();
    } catch {
      /* already disconnected */
    }
  }, 500);
};
