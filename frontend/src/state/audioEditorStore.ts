/**
 * Audio Editor binding — which ONE clip the AUDIO EDIT drawer is editing, and
 * how that drawer is looking at it.
 *
 * The drawer is bound to a clip id, never to a clip object: the clip itself
 * lives in `editorStore`, where it can be trimmed, moved, replaced or deleted
 * by anything else in the app while the drawer is open. Holding the id and
 * resolving it on every render (`selectEditedClip`) is what makes the drawer
 * show the live clip — and what lets it say "Clip no longer exists" instead of
 * editing a ghost. This mirrors `pianoRollStore.editingClipId`, which binds the
 * roll to a MIDI clip the same way.
 *
 * NOT persisted, and deliberately so. A clip id is meaningless in a different
 * project, and the same project reloaded may not still have the clip; a drawer
 * that reopened onto a missing clip would be the first thing a user saw.
 *
 * VIEW STATE. The drawer draws the clip's own source at its own magnification,
 * independent of the EDIT timeline's zoom — reading a 40 ms click out of a clip
 * should not disturb the arrangement you are looking at.
 *   - `viewZoom` is local CSS px per SOURCE second.
 *   - `viewScrollSec` is the SOURCE second at the left edge of the view.
 * Both are view-only: they never reach the project document or the undo
 * history. `components/layout/audioEditorModel.sourceWindow` turns the pair
 * into the window the waveform actually draws.
 */
import { create } from 'zustand';

/** Zoom floor, in px per source second. Above zero: the window the view shows
 *  is `widthPx / viewZoom` seconds wide, so a zoom of zero has no window. */
export const AUDIO_EDITOR_VIEW_ZOOM_MIN = 1;
/** Zoom ceiling, in px per source second — about 22 samples per px at 44.1 kHz,
 *  far past where a trim handle can be placed any more precisely. */
export const AUDIO_EDITOR_VIEW_ZOOM_MAX = 2000;
/** Where a freshly opened clip starts, in px per source second. The panel
 *  refits this to its own measured width as soon as it has one; this is only
 *  what is on screen for the frame before that. */
export const AUDIO_EDITOR_VIEW_ZOOM_DEFAULT = 100;

const clampZoom = (z: number): number =>
  Math.min(AUDIO_EDITOR_VIEW_ZOOM_MAX, Math.max(AUDIO_EDITOR_VIEW_ZOOM_MIN, z));

interface AudioEditorState {
  /** The clip being edited, or null when the drawer has nothing open. */
  clipId: string | null;
  /** The clip `viewZoom` / `viewScrollSec` were measured against. Kept across
   *  `close()` — that is what lets reopening the same clip land where you left
   *  it — and compared on open to decide whether the view still means anything. */
  viewClipId: string | null;
  /** Local CSS px per SOURCE second. */
  viewZoom: number;
  /** SOURCE seconds at the left edge of the view. */
  viewScrollSec: number;
  /**
   * Bind the drawer to a clip. Opening a DIFFERENT clip resets the view — a
   * scroll position counted in one source's seconds means nothing in another's
   * — while reopening the clip already bound leaves it exactly as it was, so
   * closing and reopening does not lose your place.
   *
   * A blank id is not a clip and is ignored, so a mis-wired caller cannot leave
   * the drawer bound to nothing-in-particular (which is a different state from
   * `clipId: null`, and would render as "Clip no longer exists").
   */
  openForClip: (id: string) => void;
  /** Unbind. Non-destructive: nothing about the clip changes, and the view is
   *  kept for the next open of the same clip. */
  close: () => void;
  /** Set the magnification, in px per source second. Clamped; a non-finite
   *  value leaves the view alone rather than blanking the waveform. */
  setViewZoom: (z: number) => void;
  /** Set the left edge of the view, in source seconds. Held at or after zero;
   *  the right-hand clamp needs the source length and lives in
   *  `audioEditorModel.sourceWindow`. */
  setViewScrollSec: (sec: number) => void;
}

export const useAudioEditorStore = create<AudioEditorState>()((set) => ({
  clipId: null,
  viewClipId: null,
  viewZoom: AUDIO_EDITOR_VIEW_ZOOM_DEFAULT,
  viewScrollSec: 0,

  openForClip: (id) =>
    set((s) => {
      if (id.trim().length === 0) return s;
      if (s.viewClipId === id) return { clipId: id };
      return {
        clipId: id,
        viewClipId: id,
        viewZoom: AUDIO_EDITOR_VIEW_ZOOM_DEFAULT,
        viewScrollSec: 0,
      };
    }),

  close: () => set({ clipId: null }),

  setViewZoom: (z) =>
    set((s) => (Number.isFinite(z) ? { viewZoom: clampZoom(z) } : s)),

  setViewScrollSec: (sec) =>
    set((s) => (Number.isFinite(sec) ? { viewScrollSec: Math.max(0, sec) } : s)),
}));

/**
 * The live clip the drawer is bound to, or null.
 *
 * Pure and generic on purpose: it takes the clip list rather than reaching into
 * `editorStore`, so this module stays importable from a node test and the
 * drawer's "which clip" question has exactly one implementation. Null covers
 * both "nothing is open" and "what was open has been deleted"; the panel tells
 * those apart by looking at `clipId` itself.
 */
export const selectEditedClip = <T extends { id: string }>(
  clips: readonly T[],
  clipId: string | null,
): T | null => (clipId === null ? null : (clips.find((c) => c.id === clipId) ?? null));
