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
import { isSoundfontActive, previewNoteSF } from './soundfontEngine';

/** Live preview convenience: route the shared synth voice through the engine
 *  master/analyser. The voice itself lives in `lib/midiSynth` so previews,
 *  bounces, and library MIDI renders all sound identical. */
export const triggerPianoNote = (
  midi: number,
  velocity: number,
  when: number,
  duration: number,
  master: number,
) => {
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume();
  if (isSoundfontActive()) {
    // The soundfont voice plays immediately, so approximate the scheduled
    // `when` with a timer relative to now (fine for preview + playback).
    const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
    window.setTimeout(() => void previewNoteSF(midi, velocity, duration), delayMs);
    return;
  }
  triggerActiveVoice(ctx, getMasterGain(), midi, velocity, when, duration, master);
};

/**
 * Public alias used by the global Web MIDI listener in App.tsx (and the Sway
 * surface). Defaults `when` to the engine's current time + a tiny lookahead,
 * `duration` to a comfortable 180ms decay, and `master` to 0.8 so
 * controller-driven notes feel uniform without callers having to know the
 * synth's internals.
 */
export const triggerPianoNoteFromMidi = (midi: number, velocity = 100, duration = 0.18) => {
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume();
  triggerPianoNote(midi, velocity, ctx.currentTime + 0.02, duration, 0.8);
};
