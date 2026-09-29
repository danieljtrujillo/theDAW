// Typed client for the DAW project import backend (/api/dawimport/*).
import { getJson, postJson } from './apiJson';
import type { FollowAction } from './followAction';
import type { TasmoLoadedClip, TasmoLoadedTrack, TasmoProjectLoaded } from './projectClient';

export interface DawClip {
  name: string;
  start_time: number;
  end_time: number;
  loop_start?: number | null;
  loop_end?: number | null;
  file_path: string | null;
  midi_notes?: unknown[] | null;
  warp_markers?: unknown[] | null;
  /** Ableton Session-view placement (null/absent for arrangement clips):
   *  which track column, which scene row, and the scene's name. */
  track_index?: number | null;
  scene_index?: number | null;
  scene_name?: string | null;
  slot_index?: number | null;
  /** Seconds into the source file where this clip starts (its trim point). */
  offset_into_source?: number;
  /** Whether the clip loops when launched; null when the set didn't say. */
  loop_on?: boolean | null;
  /** Warping: play rate is project.tempo / source_tempo. */
  is_warped?: boolean;
  source_tempo?: number | null;
  /** Clip colour as #rrggbb, decoded from Live's palette index. */
  color?: string | null;
  /** What this clip does to its column once it has played for a set period —
   *  Live's follow action. Absent on every imported set (no parser reads one
   *  yet); set in the Session grid and carried through the .tasmo round-trip as
   *  `follow_action`. See lib/followAction.ts. */
  followAction?: FollowAction;
  /** The .tasmo clip this one was opened from (lib/tasmoToSession), absent on
   *  a DAW import. A PERFORM save writes it back under the grid's own fields,
   *  so what the grid does not show (the clip's id, gain, fades, tempo,
   *  library entry, notes, render, takes) is kept. */
  tasmo?: TasmoLoadedClip;
  /** A MIDI clip's own General MIDI program, the bank select it was picked in
   *  and its sound bank (lib/bankRegistry). Absent on an imported set; carried
   *  from and back to a .tasmo clip. It wins over its track's program. */
  instrument_program?: number | null;
  instrument_bank?: number | null;
  instrument_bank_id?: string | null;
}

export interface DawDevice {
  name: string;
  plugin_type: string; // "vst3" | "audiounit" | "builtin"
  plugin_path?: string | null;
  parameters?: Record<string, number>;
  bypass?: boolean;
  /** Opaque base64 plugin-state chunk, when a parser can capture it. */
  state?: string | null;
  /** Display name of the rack this device was flattened out of, if any. */
  rack?: string | null;
  /** True for instrument/sampler devices (no live per-track engine). */
  is_instrument?: boolean;
  /** True for a rack container itself (its nested devices follow it). */
  is_rack?: boolean;
  /** A device opened from a .tasmo (lib/tasmoToSession): the insert's chain
   *  entry id, and the plugin state theDAW captured with the host that
   *  captured it. `state` above is a DAW import's own chunk, which neither
   *  host reads; these are theDAW's. Absent on a DAW import. */
  id?: string | null;
  raw_state?: string | null;
  state_host?: string | null;
}

export interface DawTrack {
  name: string;
  type: string; // "audio" | "midi" | "return" | "master"
  volume_db: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  color?: string | null;
  clips: DawClip[];
  devices: DawDevice[];
  /** The .tasmo track this one was opened from, its clips left out (each
   *  DawClip carries its own), absent on a DAW import. A PERFORM save writes
   *  it back under the grid's own fields, so the track's id, instrument,
   *  routing and folder place are kept. */
  tasmo?: Omit<TasmoLoadedTrack, 'clips'>;
  /** The General MIDI program the track's MIDI clips play with when a clip has
   *  none, the bank select it was picked in and its sound bank. Absent on an
   *  imported set, whose MIDI then follows the global instrument picker; carried
   *  from and back to a .tasmo track. */
  instrument_program?: number | null;
  instrument_bank?: number | null;
  instrument_bank_id?: string | null;
  /** A drum track: its MIDI clips play on the drum channel, where the program is the kit. */
  is_percussion?: boolean;
}

export interface DawLocator {
  name: string;
  position: number;
  color?: string | null;
}

export interface DawControllerMapping {
  is_note: boolean;
  /** 0-indexed MIDI channel (0..15); -1 = omni ("All" channels in the source DAW). */
  channel: number;
  /** CC# or note number (0..127). */
  number: number;
  map_mode: number;
  /** "mixer" (track volume/pan) | "device" (a device parameter) | "unknown". */
  target_kind: string;
  track_name: string;
  /** Index into DawProject.tracks (-1 when unresolved). */
  track_index: number;
  device_name: string;
  /** Index into the target track's (flattened) devices, -1 when unresolved. */
  device_index: number;
  param_name: string;
  /** The mapped parameter is a rack macro (fanned out to the params it drives). */
  is_macro: boolean;
  /** The target is an instrument-internal parameter (no theDAW engine). */
  is_instrument_target: boolean;
}

export interface DawProject {
  source_daw: string;
  source_version: string;
  name: string;
  tempo: number;
  time_signature: number[];
  sample_rate: number;
  tracks: DawTrack[];
  locators: DawLocator[];
  controller_mappings: DawControllerMapping[];
  /** Ableton Session-view scene names, in row order (empty for DAWs without a
   *  session grid). Drives the Session tab's clip-launch grid. */
  scenes: string[];
  plugins_used: string[];
  warnings: string[];
  missing_files: string[];
  /** The .tasmo project this one was opened from, its tracks left out (each
   *  DawTrack carries its own), absent on a DAW import. A PERFORM save writes
   *  its project-level fields back (the tempo and meter maps among them), so
   *  a set saved from PERFORM keeps what only EDIT shows. */
  tasmo?: Omit<TasmoProjectLoaded, 'tracks'>;
}

export interface DawDetect {
  daw: string;
  name: string;
  format: string;
}

export interface DawExportHint {
  format: string;
  limitation: string;
  recommended_workflow: string[];
}

// Map a detected DAW key to the importer endpoint segment.
const IMPORT_ENDPOINT: Record<string, string> = {
  ableton: 'ableton',
  reaper: 'reaper',
  logic: 'logic',
  fl_studio: 'fl-studio',
  audacity: 'audacity',
  audition: 'audition',
  bitwig: 'bitwig',
  resolume: 'resolume',
  sway: 'sway',
};

// DAWs with no direct parser — export-hint guidance only.
const HINT_ENDPOINT: Record<string, string> = {
  logic: 'logic/export-hint',
  cubase: 'cubase/export-hint',
  pro_tools: 'pro-tools/export-hint',
};

export const DAW_LABELS: Record<string, string> = {
  ableton: 'Ableton Live',
  reaper: 'Reaper',
  logic: 'Logic Pro X',
  fl_studio: 'FL Studio',
  audacity: 'Audacity',
  audition: 'Adobe Audition',
  bitwig: 'Bitwig Studio',
  resolume: 'Resolume Arena',
  cubase: 'Cubase',
  pro_tools: 'Pro Tools',
  sway: 'Audima Labs Sway',
  unknown: 'Unknown',
};

export const canImport = (daw: string): boolean => daw in IMPORT_ENDPOINT;
export const hasHint = (daw: string): boolean => daw in HINT_ENDPOINT;

/** URL that streams a source audio file referenced by an imported DAW project
 *  (used by the Perform/Session grid + timeline import to play clips). Routes to
 *  the project clip-audio endpoint, which serves browser-native formats directly
 *  and transcodes DAW-native ones (AIFF/CAF/…) to WAV on the fly so they decode. */
export const dawImportAudioUrl = (path: string): string =>
  `/api/project/clip-audio?path=${encodeURIComponent(path)}`;

export const dawApi = {
  detect: (path: string) => postJson<DawDetect>('/api/dawimport/detect', { path }),
  import: (daw: string, path: string) => {
    const seg = IMPORT_ENDPOINT[daw];
    if (!seg) throw new Error(`No importer available for ${DAW_LABELS[daw] ?? daw}`);
    return postJson<DawProject>(`/api/dawimport/${seg}`, { path });
  },
  hint: (daw: string) => {
    const seg = HINT_ENDPOINT[daw];
    if (!seg) throw new Error(`No export hint for ${DAW_LABELS[daw] ?? daw}`);
    return getJson<DawExportHint>(`/api/dawimport/${seg}`);
  },
};
