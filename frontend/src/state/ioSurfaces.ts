/**
 * Every place in theDAW that opens a microphone or makes a sound of its own,
 * and can therefore be pointed at a different device than the global default.
 *
 * A flat const registry rather than imperative registration: the Settings menu
 * renders one row per entry with no coupling to the components, and a surface
 * that is added here but never wired up would show as an override that does
 * nothing — so the list is the contract, and every id below is read by a real
 * call site.
 *
 * `kind` picks which live device list and which global slot the row falls back
 * to. Surfaces are OVERRIDES; the global slots themselves live in the settings
 * `io` section (audio_output, cue_output, audio_input, …).
 */
export type SurfaceKind = 'audioIn' | 'audioOut';

export interface IoSurface {
  id: string;
  kind: SurfaceKind;
  /** Row label in Settings. */
  label: string;
  /** Hover copy: what actually changes when this row is set. */
  hint: string;
}

export const IO_SURFACES = [
  {
    id: 'midiVocal',
    kind: 'audioIn',
    label: 'MIDI tab — vocal',
    hint: 'The always-on input monitor and the record button in the MIDI tab.',
  },
  {
    id: 'singPitch',
    kind: 'audioIn',
    label: 'SING — pitch lane',
    hint: 'The microphone the pitch lane listens to and scores.',
  },
  {
    id: 'micRecorder',
    kind: 'audioIn',
    label: 'Mic recorder',
    hint: 'The voice-memo recorder that imports takes into the library. Keeps echo cancellation and noise suppression ON, unlike the pitch paths.',
  },
  {
    id: 'vocal2midi',
    kind: 'audioIn',
    label: 'Vocal → MIDI',
    hint: 'The YIN note recorder inside the MIDI tab.',
  },
  // NOT here: the UNDERFIT assistant orb. It is built by a SEPARATE entry
  // (vite.orb.config.ts -> underfit/dashboard/assistant/underfit-orb.js) and
  // runs inside underfit's own page on :8791 — a different origin with its own
  // localStorage and no /api/settings of ours, so nothing chosen here could
  // ever reach it. Offering the row would be a dropdown that does nothing;
  // IoSection says so in words instead.
  {
    id: 'preview',
    kind: 'audioOut',
    label: 'Clip previews',
    hint: 'Mic takes, inpaint previews and Nodefi play through their own <audio> elements rather than the main graph, so they can be sent somewhere else.',
  },
] as const satisfies readonly IoSurface[];

export type SurfaceId = (typeof IO_SURFACES)[number]['id'];

export const surfaceById = (id: string): IoSurface | undefined =>
  IO_SURFACES.find((s) => s.id === id);

/** The global settings key a surface of this kind falls back to. */
export const GLOBAL_SLOT_FOR_KIND: Record<SurfaceKind, 'audio_input' | 'audio_output'> = {
  audioIn: 'audio_input',
  audioOut: 'audio_output',
};
