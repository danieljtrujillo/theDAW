// Convert a loaded .tasmo project into a DawProject the Session grid can render,
// so theDAW's own saved projects open in the Session tab alongside Ableton sets.
//
// A .tasmo has no session-view scenes, so each track's clips are laid into scene
// rows in start-time order (track = column, clip = scene row). Audio clips keep
// their absolute on-disk path (the load step relinks embedded audio to disk, and
// /api/dawimport/audio serves any absolute path). MIDI clips carry step-based
// notes, converted here to the seconds-based shape the grid renders.

import type { DawProject, DawTrack, DawClip } from './dawImportClient';
import type { TasmoProjectLoaded } from './projectClient';

export function tasmoLoadedToDawProject(loaded: TasmoProjectLoaded): DawProject {
  const bpm = loaded.tempo || 120;
  const stepSec = 60 / Math.max(40, bpm) / 4; // one 16th-note step in seconds

  const tracks: DawTrack[] = loaded.tracks.map((t, ti) => {
    const sorted = [...t.clips].sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
    const clips: DawClip[] = sorted.map((c, ci) => {
      const isMidi =
        c.clip_type === 'midi' && Array.isArray(c.midi_notes) && c.midi_notes.length > 0;
      return {
        name: c.name || `Clip ${ci + 1}`,
        start_time: c.start_time ?? 0,
        end_time: c.end_time ?? 0,
        file_path: !isMidi ? (c.audio_file ?? null) : null,
        midi_notes: isMidi
          ? (c.midi_notes ?? []).map((n) => ({
              pitch: Number(n.note ?? n.pitch ?? 60),
              start: Number(n.step ?? 0) * stepSec,
              duration: Math.max(1, Number(n.length ?? 1)) * stepSec,
              velocity: Number(n.velocity ?? 100),
            }))
          : null,
        track_index: ti,
        scene_index: ci,
        slot_index: ci,
        scene_name: null,
      };
    });
    return {
      name: t.name || `Track ${ti + 1}`,
      type: t.type === 'midi' ? 'midi' : 'audio',
      volume_db: t.volume_db ?? 0,
      pan: t.pan ?? 0,
      mute: !!t.mute,
      solo: !!t.solo,
      color: t.color ?? null,
      clips,
      devices: [],
    };
  });

  return {
    source_daw: 'tasmo',
    source_version: '',
    name: loaded.project_name || 'theDAW Project',
    tempo: bpm,
    time_signature: [4, 4],
    sample_rate: loaded.sample_rate || 44100,
    tracks,
    locators: [],
    controller_mappings: [],
    scenes: [],
    plugins_used: [],
    warnings: [],
    missing_files: [],
  };
}
