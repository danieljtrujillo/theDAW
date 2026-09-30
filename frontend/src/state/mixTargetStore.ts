/**
 * mixTargetStore — the ONE binding both EDIT and MIX read: which clip MIX is
 * currently editing. A single module-scope Zustand store holds it, so
 * "Edit in Mix" set from EDIT is immediately visible to MIX and vice versa —
 * one store, two views, no copying. Neither view keeps its own idea of the
 * binding, so they can never disagree about which clip is open.
 *
 * Module-scope for the same reason as state/mixStageStore.ts: DAWCenterPanel
 * fully unmounts MixView on every tab switch, so component state would not
 * survive a tab round-trip.
 *
 * NOT persisted, and deliberately so, mirroring audioEditorStore's clipId
 * binding: a clip id means nothing in a different project, and the same
 * project reloaded may not still have the clip a stale binding pointed at.
 *
 * The MixTarget model itself — the pointer, its revision stamp, and
 * `resolveMixTarget`'s live/stale classification — lives in lib/mixTarget.ts;
 * this module only holds the one binding and the actions that mutate it.
 */
import { create } from 'zustand';

import { makeMixTarget, type MixTarget, type MixTargetClipLike } from '../lib/mixTarget';
import { useProjectStore } from './projectStore';

interface MixTargetState {
  /** The one MixTarget binding both EDIT and MIX read, or null when MIX has nothing open. */
  target: MixTarget | null;
  /**
   * Bind (or, passed null, unbind) the target. A target whose clipId or
   * projectId is blank is not a valid binding and is ignored, mirroring
   * audioEditorStore.openForClip's blank-id guard.
   */
  setTarget: (target: MixTarget | null) => void;
  /** Unbind. Non-destructive: nothing about the clip itself changes. */
  clearTarget: () => void;
  /**
   * Replace `clipRevision` on the current target with `revision`, so a
   * caller that has already recomputed it does not need to rebuild the whole
   * target. No-op when there is no target bound.
   */
  noteRevision: (revision: string) => void;
}

export const useMixTargetStore = create<MixTargetState>()((set) => ({
  target: null,

  setTarget: (target) =>
    set((s) => {
      if (target === null) return { target: null };
      if (target.clipId.trim().length === 0 || target.projectId.trim().length === 0) return s;
      return { target };
    }),

  clearTarget: () => set({ target: null }),

  noteRevision: (revision) =>
    set((s) => (s.target === null ? s : { target: { ...s.target, clipRevision: revision } })),
}));

/**
 * Bind MIX to `clip` in the current project (`useProjectStore`'s
 * `projectName`, falling back to `'untitled'` when that is blank), store the
 * resulting MixTarget, and return it. Returns null instead of binding
 * anything when `clip.id` is blank, mirroring `setTarget`'s own guard rather
 * than storing a binding that points nowhere.
 */
export function bindMixTargetToClip(clip: MixTargetClipLike): MixTarget | null {
  if (clip.id.trim().length === 0) return null;
  const rawProjectName = useProjectStore.getState().projectName;
  const projectId = rawProjectName.trim().length === 0 ? 'untitled' : rawProjectName;
  const target = makeMixTarget(projectId, clip);
  useMixTargetStore.getState().setTarget(target);
  return target;
}
