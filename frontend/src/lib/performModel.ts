// Shared derivation of the Perform grid's track + scene model, so the grid
// (DawSessionGrid) and the routing panel (PerformRoutingPanel) index scenes and
// tracks identically. Both consume the same DawProject; keeping this in one place
// means a scene number the user assigns in the panel always maps to the same row
// the grid launches.
import type { DawProject, DawTrack } from './dawImportClient';

/** Audio + MIDI tracks in project order (the columns the grid + mixer render). */
export const performTracks = (project: DawProject): DawTrack[] =>
  project.tracks.filter((track) => track.type === 'audio' || track.type === 'midi');

/** Number of scene rows: the greater of named scenes and the highest clip slot. */
export const performSceneCount = (project: DawProject): number => {
  const tracks = performTracks(project);
  const maxClipScene = tracks.reduce((max, track) => {
    return Math.max(
      max,
      ...track.clips.map((clip) => clip.scene_index ?? clip.slot_index ?? -1),
    );
  }, -1);
  return Math.max(project.scenes.length, maxClipScene + 1);
};

/** Scene display names, one per row, filled with "Scene N" where unnamed. */
export const performScenes = (project: DawProject): string[] => {
  const count = performSceneCount(project);
  return Array.from({ length: count }, (_, index) => project.scenes[index] ?? `Scene ${index + 1}`);
};
