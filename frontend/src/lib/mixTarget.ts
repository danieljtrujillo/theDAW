/**
 * mixTarget — the ONE pure answer to "which clip is MIX currently editing, is
 * that binding still valid, and what does its banner say".
 *
 * MIX opens on a clip, but the rack it shows lives on that clip's TRACK
 * (`EditorTrack.fxChain`, see state/mixLiveRack.ts) — there is no per-clip
 * effects engine, and this module must not invent one. A `MixTarget` is
 * therefore a pointer at a clip plus a snapshot of the fields that make that
 * clip's mix-relevant state distinguishable (`clipRevision`), so the store
 * and the banner can both answer, without re-deriving anything, whether the
 * binding still points at a live clip and whether that clip has changed
 * since MIX opened it — a clip trimmed or moved out from under an open MIX
 * tab must not be presented to the user as unchanged.
 *
 * Pure and DOM-free, in the style of lib/clipEditTarget.ts: every input is
 * structural, so `AudioClip` / `EditorTrack` satisfy these types without
 * `lib/` importing `state/`. The live-rack effect id set is passed in as a
 * parameter for the same reason — `effectChainStore.MIX_RACK_IDS` lives in
 * `state/`.
 */

/**
 * A binding from an open MIX tab to the one clip it is editing. `scope` is
 * `'clip'` (never `'track'`) because MIX always opens on a clip — the rack it
 * shows is that clip's track's rack, but the thing MIX points at is the clip.
 */
export interface MixTarget {
  readonly projectId: string;
  readonly clipId: string;
  readonly trackId: string;
  readonly clipRevision: string;
  readonly scope: 'clip';
}

/**
 * The part of a clip a MixTarget needs: enough to identify it, place it on a
 * track, and detect the edits (trim, move, rename, gain, fade, mute) that
 * should invalidate a stale binding. Structural so `AudioClip` satisfies it
 * without this module importing `state/editorStore`.
 */
export interface MixTargetClipLike {
  readonly id: string;
  readonly trackId: string;
  readonly label: string;
  readonly startSec: number;
  readonly durationSec: number;
  readonly offsetIntoSource: number;
  readonly gain?: number;
  readonly fadeInSec?: number;
  readonly fadeOutSec?: number;
  readonly muted?: boolean;
}

/**
 * The part of a track the banner and rack-row helpers need. `fxChain` is
 * `readonly unknown[]` because only its entries' `effect`/`label` matter, and
 * those are read through `mixTargetRackRows`'s own structural entry type
 * rather than `state/effectChainStore`'s `ChainEntry`.
 */
export interface MixTargetTrackLike {
  readonly id: string;
  readonly name: string;
  readonly fxChain?: readonly unknown[];
}

/**
 * A stable signature of the fields that define "this clip, as MIX would show
 * it". Two calls against an unchanged clip always produce the same string; a
 * trim, move, rename, gain/fade change, or mute toggle always changes it.
 * `id` is deliberately excluded — a clip's id never changes, so it carries no
 * revision information — as is everything with no mix-visible effect (peaks,
 * takes, warp markers, and so on).
 */
export const clipRevision = (clip: MixTargetClipLike): string =>
  [
    clip.trackId,
    clip.startSec,
    clip.durationSec,
    clip.offsetIntoSource,
    clip.label,
    clip.gain ?? 1,
    clip.fadeInSec ?? 0,
    clip.fadeOutSec ?? 0,
    clip.muted ?? false,
  ].join('|');

/**
 * Bind MIX to `clip` within `projectId`, stamping the revision it was opened
 * at so a later `resolveMixTarget` can tell whether the clip has since
 * changed.
 */
export const makeMixTarget = (projectId: string, clip: MixTargetClipLike): MixTarget => ({
  projectId,
  clipId: clip.id,
  trackId: clip.trackId,
  clipRevision: clipRevision(clip),
  scope: 'clip',
});

/**
 * What `resolveMixTarget` reports: no binding at all, a binding left over
 * from a different project, a binding whose clip no longer exists (deleted,
 * or undone away), or a live binding with its current clip/track and whether
 * it has drifted from the revision it was opened at.
 */
export type MixTargetResolution =
  | { readonly status: 'none' }
  | { readonly status: 'other-project' }
  | { readonly status: 'missing-clip' }
  | {
      readonly status: 'ok';
      readonly clip: MixTargetClipLike;
      readonly track: MixTargetTrackLike | null;
      readonly revision: string;
      readonly revisionChanged: boolean;
    };

/**
 * Resolve a `MixTarget` against the project's current clips/tracks. This is
 * the one place that decides whether MIX's binding still means anything: a
 * null target has nothing open, a target stamped for another project is
 * stale the moment the project switches, and a target whose clip id no
 * longer resolves has nothing left to show. Only a clip that still exists
 * reaches `'ok'`, where `revisionChanged` tells the caller whether the clip
 * has been edited since MIX opened it.
 */
export function resolveMixTarget(
  target: MixTarget | null,
  projectId: string,
  clips: readonly MixTargetClipLike[],
  tracks: readonly MixTargetTrackLike[],
): MixTargetResolution {
  if (!target) return { status: 'none' };
  if (target.projectId !== projectId) return { status: 'other-project' };
  const clip = clips.find((c) => c.id === target.clipId);
  if (!clip) return { status: 'missing-clip' };
  const track = tracks.find((t) => t.id === clip.trackId) ?? null;
  const revision = clipRevision(clip);
  return { status: 'ok', clip, track, revision, revisionChanged: revision !== target.clipRevision };
}

/** MIX's banner text while editing a clip. */
export const mixTargetBannerText = (clipLabel: string, trackName: string): string =>
  `Editing: ${clipLabel} — ${trackName}`;

/**
 * Printed under the banner: the rack MIX shows is the clip's TRACK's rack
 * (there is no per-clip effects engine), so a change made there reaches
 * every clip on that track, not just the one MIX opened on.
 */
export const MIX_TARGET_TRACK_SCOPE_NOTE = 'Changes apply to the whole track';

/**
 * Is `effect` heard live on the master insert right now, or only printed at
 * bounce? Mirrors state/mixLiveRack.ts's `inMixRack`: the live-effect id set
 * (`effectChainStore.MIX_RACK_IDS`) plus every hosted `vst3` plugin are live;
 * everything else is a backend-only effect applied offline by processChain.
 * The id set is a parameter, not an import, so this module stays free of
 * `state/`.
 */
export const isLiveRackEffect = (effect: string, liveEffectIds: ReadonlySet<string>): boolean =>
  liveEffectIds.has(effect) || effect === 'vst3';

/**
 * One row of the rack list MIX's banner area shows for the target clip's
 * track: the entry as given, plus whether it is only a printed-at-bounce
 * preview rather than something audible live right now.
 */
export interface MixTargetRackRow {
  readonly effect: string;
  readonly label?: string;
  readonly printedPreview: boolean;
}

/**
 * Build the rack rows for a track's `fxChain`, marking every entry that is
 * not live (see `isLiveRackEffect`) as a printed-only preview. `label` is
 * copied over only when the source entry has one, so a row for an unlabelled
 * entry has no `label` key at all rather than an explicit `undefined` one.
 */
export const mixTargetRackRows = (
  entries: readonly { readonly effect: string; readonly label?: string }[],
  liveEffectIds: ReadonlySet<string>,
): MixTargetRackRow[] =>
  entries.map((e) => ({
    effect: e.effect,
    ...(e.label !== undefined ? { label: e.label } : {}),
    printedPreview: !isLiveRackEffect(e.effect, liveEffectIds),
  }));
