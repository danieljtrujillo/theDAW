// Typed client for the .tasmo project backend (/api/project/*).
import { getJson, postJson, postForm } from './apiJson';
import type { DawProject } from './dawImportClient';
import { dawDeviceToEffectNode } from './dawEffectMap';
import type { SwayBinding, SwayUnattached } from './swayImportResolve';
import type { PerformRoutingSnapshot } from '../state/performRouting';

// --- Effect chain (mirrors backend tasmo_project.py EffectChainNode/VstPluginState) ---
export interface VstPluginState {
  plugin_path: string;
  plugin_name: string;
  parameters?: Record<string, number>;
  preset_path?: string | null;
  instance_id?: string;
}

export interface EffectChainNode {
  node_type: string; // "vst3" | "audiounit" | "builtin"
  effect_name: string;
  parameters?: Record<string, number>;
  bypass?: boolean;
  vst_state?: VstPluginState | null;
  /** Stable chain-entry id, so controller mappings keyed to this FX slot survive
   *  a save/load round-trip. */
  id?: string;
}

/** Persisted controller (MIDI-learn) auto-attach for a saved session — the
 *  resolved Sway bindings + unattached list, so reopening re-wires the hardware
 *  to the same targets. Mirrors the frontend SwayResolveResult + source name. */
export interface TasmoControllerMappings {
  source_name: string;
  bindings: SwayBinding[];
  unattached: SwayUnattached[];
}

// --- Save payload (built in the frontend, validated by the backend) ---
export interface TasmoClipInput {
  id: string;
  name: string;
  clip_type: string; // "audio" | "midi" | "generated"
  track_id: string;
  start_time?: number;
  end_time?: number;
  audio_file?: string | null;
  /** Carried so MIDI clips survive the round-trip (the backend Clip model keeps
   *  these). The shape is whatever the importer produced; the loader is tolerant. */
  midi_notes?: unknown[] | null;
  loop_start?: number | null;
  loop_end?: number | null;
  /** Per-clip mute; optional so pre-mute payloads stay valid. */
  muted?: boolean;
  /** Linear clip gain (1 = unity) and fade lengths in seconds. Optional for the
   *  same reason: the backend defaults them, so older payloads still validate. */
  gain?: number;
  fade_in?: number;
  fade_out?: number;
  /** Seconds into the source where the clip starts — the trim point. */
  offset_into_source?: number;
  /** Session-view (Perform grid) placement; null on an arrangement clip.
   *  Without these the format could not represent a clip-launch grid, so every
   *  session clip was dropped on save. */
  track_index?: number | null;
  scene_index?: number | null;
  slot_index?: number | null;
}

export interface TasmoTrackInput {
  id: string;
  name: string;
  type: string; // "audio" | "midi" | ...
  volume_db?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  color?: string | null;
  clips?: TasmoClipInput[];
  effect_chain?: EffectChainNode[];
}

export interface TasmoProjectInput {
  project_name: string;
  tempo?: number;
  time_signature?: number[];
  sample_rate?: number;
  author?: string;
  tracks?: TasmoTrackInput[];
  source_daw?: string | null;
  import_warnings?: string[];
  /** Session-view scene names in row order; empty when there is no grid. */
  scenes?: string[];
  controller_mappings?: TasmoControllerMappings | null;
  /** Perform-tab scene-launch + modulation routing (see performRouting.ts). */
  perform_routing?: PerformRoutingSnapshot | null;
}

// --- Load result. The backend returns the FULL TasmoProject (model_dump), so
// these mirror the fields the editor import reads; unlisted fields are ignored. ---
export interface TasmoLoadedClip {
  id?: string;
  name: string;
  clip_type: string;
  track_id?: string;
  start_time?: number;
  end_time?: number;
  audio_file: string | null;
  midi_notes?: Array<Record<string, number>> | null;
  instrument_program?: number;
  /** Per-clip mute; absent in .tasmo files written before the field existed. */
  muted?: boolean;
  /** Linear clip gain (1 = unity) and fade lengths in seconds; absent in .tasmo
   *  files written before these fields existed. */
  gain?: number;
  fade_in?: number;
  fade_out?: number;
  /** Seconds into the source where the clip starts — the trim point. */
  offset_into_source?: number;
  /** Session-view (Perform grid) placement; null on an arrangement clip.
   *  Without these the format could not represent a clip-launch grid, so every
   *  session clip was dropped on save. */
  track_index?: number | null;
  scene_index?: number | null;
  slot_index?: number | null;
}

export interface TasmoLoadedTrack {
  id?: string;
  name: string;
  type: string;
  volume_db?: number;
  pan?: number;
  mute?: boolean;
  solo?: boolean;
  color?: string | null;
  instrument_program?: number;
  clips: TasmoLoadedClip[];
  effect_chain?: EffectChainNode[];
}

export interface TasmoProjectLoaded {
  project_name: string;
  tempo: number;
  sample_rate: number;
  tracks: TasmoLoadedTrack[];
  import_warnings?: string[];
  /** Session-view scene names in row order; empty when there is no grid. */
  scenes?: string[];
  controller_mappings?: TasmoControllerMappings | null;
  perform_routing?: PerformRoutingSnapshot | null;
}

export interface ProjectManifest {
  format: string;
  format_version: number;
  project_name: string;
  audio_mode: string; // "embedded" | "linked"
  total_tracks: number;
  total_clips?: number;
  sample_rate: number;
  created_at?: string;
  modified_at?: string;
}

export interface RecentItem {
  path: string;
  name: string;
}

export const projectApi = {
  save: (project: TasmoProjectInput, path: string, embed_audio: boolean) =>
    postJson<{ status: string; path: string; manifest: ProjectManifest }>('/api/project/save', {
      project,
      path,
      embed_audio,
    }),
  /** Save the live session, embedding each clip's audio bytes (the editor's
   *  clips are in-memory blobs with no on-disk path, so plain /save can't link
   *  them). Each clip's audio_file must be ``audio/<file.name>``. */
  saveSession: (
    project: TasmoProjectInput,
    path: string,
    files: Array<{ name: string; blob: Blob }>,
  ) => {
    const form = new FormData();
    form.append('project', JSON.stringify(project));
    form.append('path', path);
    for (const f of files) form.append('files', f.blob, f.name);
    return postForm<{ status: string; path: string; manifest: ProjectManifest }>(
      '/api/project/save-session',
      form,
    );
  },
  load: (path: string) =>
    postJson<{ project: TasmoProjectLoaded; manifest: ProjectManifest }>('/api/project/load', {
      path,
    }),
  info: (path: string) =>
    getJson<ProjectManifest>(`/api/project/info?path=${encodeURIComponent(path)}`),
  recent: () => getJson<RecentItem[]>('/api/project/recent'),
  defaultDir: () => getJson<{ path: string }>('/api/project/default-dir'),
  /** URL that streams a clip's on-disk audio file (for loading a project into
   *  the editor). The path is an absolute local path from the loaded project. */
  clipAudioUrl: (path: string) => `/api/project/clip-audio?path=${encodeURIComponent(path)}`,
  listAudio: (path: string) =>
    getJson<{ files: string[] }>(`/api/project/list-audio?path=${encodeURIComponent(path)}`),
};

// Build a .tasmo save payload from an imported DAW project.
let _seq = 0;
const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${_seq++}`;

export function dawProjectToTasmo(d: DawProject): TasmoProjectInput {
  const tracks: TasmoTrackInput[] = d.tracks.map((t) => {
    const trackId = uid('t');
    return {
      id: trackId,
      name: t.name,
      type: t.type === 'midi' ? 'midi' : 'audio',
      volume_db: t.volume_db,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      // Session (Perform grid) clips are saved ALONGSIDE arrangement clips and
      // told apart by their scene indices — they used to be filtered out here,
      // which silently discarded the entire clip-launch grid on save. Worse, the
      // Perform tab's own .tasmo path stamps scene_index on EVERY clip
      // (tasmoToSession.ts), so opening a .tasmo in Perform and saving wrote a
      // project with ZERO clips over the user's file. The EDIT timeline filters
      // session clips out on LOAD instead, which is where that belongs.
      clips: (t.clips ?? []).map((c) => ({
        id: uid('c'),
        name: c.name,
        // Per-clip type: a clip with notes is MIDI even on an "audio" track.
        clip_type: c.midi_notes && c.midi_notes.length ? 'midi' : 'audio',
        track_id: trackId,
        start_time: c.start_time,
        end_time: c.end_time,
        audio_file: c.file_path ?? null,
        midi_notes: c.midi_notes ?? null,
        loop_start: c.loop_start ?? null,
        loop_end: c.loop_end ?? null,
        // Carry the grid placement so the Perform tab can be restored exactly
        // rather than rebuilt from arrangement clips.
        track_index: c.track_index ?? null,
        scene_index: c.scene_index ?? null,
        slot_index: c.slot_index ?? null,
      })),
      // Map the track's device chain into theDAW effect nodes (VST3 -> real,
      // creative FX -> rack, EQ/comp/reverb -> preserved). Order is kept.
      effect_chain: (t.devices ?? []).map(dawDeviceToEffectNode),
      color: t.color ?? null,
    };
  });
  return {
    project_name: d.name,
    tempo: d.tempo,
    time_signature: Array.isArray(d.time_signature) ? d.time_signature.slice(0, 2) : [4, 4],
    sample_rate: d.sample_rate,
    source_daw: d.source_daw,
    import_warnings: d.warnings,
    // Scene names in row order, so a saved Perform grid reloads with the
    // user's own scene names instead of a generic "Scene 1..N" ladder.
    scenes: d.scenes ?? [],
    tracks,
  };
}
