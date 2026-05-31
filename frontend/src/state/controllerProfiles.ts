/**
 * Controller profiles — the physical control layout of a connected MIDI
 * device. The SLIDE tab mirrors these so the # of on-screen slots equals the
 * device's real knobs / faders / buttons.
 *
 * Sections are ordered top → bottom as they should render in CONTROLLER view.
 * For the user's AKAI MIDIMIX that's KNOBS (3×8) → FADERS (1×8) → BUTTONS
 * (2×8) = 48 controls.
 *
 * Phase 1 (now): built-in presets + auto-detect by the MIDI input name that
 * App.tsx already enumerates. Phase 2 (later): MIDI-learn that builds a
 * profile from whatever controls the user wiggles.
 */

export type ControlKind = 'knob' | 'fader' | 'pad';

export interface ControllerSection {
  id: string;
  kind: ControlKind;
  label: string;
  rows: number;
  cols: number;
}

export interface ControllerProfile {
  id: string;
  name: string;
  /** Lowercase substrings to match against a MIDI input's reported name. */
  match: string[];
  sections: ControllerSection[];
}

export const CONTROLLER_PROFILES: ControllerProfile[] = [
  {
    id: 'akai-midimix',
    name: 'AKAI MIDIMIX',
    match: ['midimix'],
    sections: [
      { id: 'knobs', kind: 'knob', label: 'KNOBS', rows: 3, cols: 8 },
      { id: 'faders', kind: 'fader', label: 'FADERS', rows: 1, cols: 8 },
      { id: 'buttons', kind: 'pad', label: 'BUTTONS', rows: 2, cols: 8 },
    ],
  },
  {
    id: 'novation-lcxl',
    name: 'Launch Control XL',
    match: ['launch control xl', 'lcxl', 'launch control'],
    sections: [
      { id: 'knobs', kind: 'knob', label: 'KNOBS', rows: 3, cols: 8 },
      { id: 'faders', kind: 'fader', label: 'FADERS', rows: 1, cols: 8 },
      { id: 'buttons', kind: 'pad', label: 'BUTTONS', rows: 2, cols: 8 },
    ],
  },
  {
    id: 'korg-nanokontrol2',
    name: 'Korg nanoKONTROL2',
    match: ['nanokontrol', 'nano kontrol'],
    sections: [
      { id: 'knobs', kind: 'knob', label: 'KNOBS', rows: 1, cols: 8 },
      { id: 'faders', kind: 'fader', label: 'FADERS', rows: 1, cols: 8 },
      { id: 'buttons', kind: 'pad', label: 'S / M / R', rows: 3, cols: 8 },
    ],
  },
  {
    id: 'generic-8',
    name: 'Generic 8-channel',
    match: [],
    sections: [
      { id: 'knobs', kind: 'knob', label: 'KNOBS', rows: 1, cols: 8 },
      { id: 'faders', kind: 'fader', label: 'FADERS', rows: 1, cols: 8 },
    ],
  },
];

export const DEFAULT_PROFILE_ID = 'akai-midimix';

export function profileById(id: string): ControllerProfile {
  return CONTROLLER_PROFILES.find((p) => p.id === id) ?? CONTROLLER_PROFILES[0];
}

/** Total physical controls a profile exposes. */
export function profileControlCount(p: ControllerProfile): number {
  return p.sections.reduce((n, s) => n + s.rows * s.cols, 0);
}

/** Count of a single kind across a profile (e.g. faders → one page size). */
export function profileKindCount(p: ControllerProfile, kind: ControlKind): number {
  return p.sections.filter((s) => s.kind === kind).reduce((n, s) => n + s.rows * s.cols, 0);
}

/**
 * Best-match a profile from a connected MIDI input name (case-insensitive
 * substring). Returns null when nothing matches so the caller can keep the
 * user's manual choice instead of overriding it.
 */
export function detectProfile(midiInputName: string | null | undefined): ControllerProfile | null {
  if (!midiInputName) return null;
  const name = midiInputName.toLowerCase();
  for (const p of CONTROLLER_PROFILES) {
    if (p.match.some((m) => name.includes(m))) return p;
  }
  return null;
}
