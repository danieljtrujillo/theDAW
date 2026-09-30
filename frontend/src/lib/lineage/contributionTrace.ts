/**
 * contributionTrace — derives which library sources were actually AUDIBLE in
 * a render (F23).
 *
 * This is derived from the render PLAN — the same tracks, clips, mute/solo,
 * takes/comp and optional range a render itself reads — not from a mute
 * filter applied to some other list after the fact. A muted track or clip
 * never produces a candidate contribution in the first place, so there is no
 * separate filter step to get wrong or to forget. `traceContributions` is
 * pure arithmetic over plain data, in the same spirit as `clipComp.ts`: no
 * store, no DOM, no network, so a render's lineage can be reasoned about and
 * tested on its own.
 *
 * Inputs are declared as narrow, structural `Trace*` types rather than
 * imported from `editorStore`, so this module carries no runtime dependency
 * on the store. A real `EditorTrack` / `AudioClip` satisfies them as-is —
 * they simply carry more fields than this module reads.
 *
 * Run: npx tsx src/lib/lineage/contributionTrace.test.ts
 */

import { compSegments, type CompRegion } from '../clipComp';
import { frameToSec, type RenderRange } from '../render/renderRange';
import type { LineageContribution, LineageContributionRole } from './lineageTypes';

export interface TraceTrack {
  id: string;
  mute: boolean;
  solo: boolean;
}

export interface TraceClip {
  id: string;
  trackId: string;
  /** Position on the timeline (start time in seconds). */
  startSec: number;
  /** Length of this clip on the timeline. */
  durationSec: number;
  /** Seconds into the source where this clip starts reading. */
  offsetIntoSource: number;
  /** Reference back to a Library entry id. Undefined or empty: nothing to attribute this clip to. */
  libraryEntryId?: string;
  muted?: boolean;
  /** 'piano-roll' clips trace with role 'midi' regardless of `TraceInput.role`. */
  sourceKind?: string;
  /** Only the LENGTH is read (>= 2 is a precondition for comping). The clip's
   *  own `offsetIntoSource` above already mirrors the active take's, per the
   *  `AudioClip.takes` invariant, so no individual take's fields are read. */
  takes?: Array<{ offsetIntoSource: number }>;
  /** Ordered, clip-relative take-choice boundaries (lib/clipComp). */
  comp?: Array<{ startSec: number; takeIndex: number; crossfadeSec?: number }>;
  /** Index into `takes` of the take currently active; undefined = 0. */
  activeTakeIndex?: number;
}

export interface TraceInput {
  tracks: TraceTrack[];
  clips: TraceClip[];
  /** Clips the trace to a window; absent or null = the whole timeline. */
  range?: RenderRange | null;
  /** Role for every non-piano-roll clip's contributions; absent = 'audio'. */
  role?: LineageContributionRole;
}

/** One clip-relative stretch of playback that is actually audible: either a
 *  comp's active-take `CompSegment` narrowed to its two ends, or a plain
 *  clip's one whole span. */
interface AudibleSpan {
  startSec: number;
  endSec: number;
}

const isPositiveFinite = (n: number): boolean => Number.isFinite(n) && n > 0;

/** Rounds to 1e-6 so the wire body is stable across re-derivation and a bad
 *  upstream number (NaN/Infinity) can never leak into the output. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Same qualification `clipComp.isComped` uses. Reimplemented rather than
 * imported: `TraceClip.takes` is narrowed to `{ offsetIntoSource }` (this
 * module never needs a take's audio `Blob`), and that narrower shape does not
 * structurally satisfy `isComped`'s `ClipTake[]` parameter.
 */
function isCompedTrace(takes: TraceClip['takes'], comp: TraceClip['comp']): boolean {
  return (takes?.length ?? 0) > 1 && (comp?.length ?? 0) >= 1;
}

/** The clip-relative spans this clip actually plays: its comp's active-take
 *  segments, or — for every clip that is not comping — its one whole span. */
function audibleSpans(clip: TraceClip): AudibleSpan[] {
  const { comp, takes, durationSec, activeTakeIndex } = clip;
  if (isCompedTrace(takes, comp) && comp) {
    const activeTake = activeTakeIndex ?? 0;
    return compSegments(comp as CompRegion[], durationSec)
      .filter((seg) => seg.takeIndex === activeTake)
      .map((seg) => ({ startSec: seg.startSec, endSec: seg.endSec }));
  }
  return isPositiveFinite(durationSec) ? [{ startSec: 0, endSec: durationSec }] : [];
}

export function traceContributions(input: TraceInput): LineageContribution[] {
  const { tracks, clips, range } = input;
  const defaultRole: LineageContributionRole = input.role ?? 'audio';
  const trackById = new Map(tracks.map((t) => [t.id, t] as const));
  const anySolo = tracks.some((t) => t.solo === true);

  // The kept window, in seconds. `prerollFrames` is rendered and then thrown
  // away (renderRange.ts's own header), so it never widens this window — only
  // the tail, which IS kept, extends it past `endFrame`.
  const renderWindow = range
    ? { start: frameToSec(range.startFrame), end: frameToSec(range.endFrame) + frameToSec(range.tailFrames) }
    : null;

  const out: LineageContribution[] = [];

  for (const clip of clips) {
    const track = trackById.get(clip.trackId);
    if (!track) continue; // names no track: nothing to attribute the sound to
    if (track.mute === true) continue;
    if (anySolo && track.solo !== true) continue; // solo restricts to soloed tracks
    if (clip.muted === true) continue;
    const libraryEntryId = clip.libraryEntryId;
    if (!libraryEntryId) continue; // nothing to attribute this clip's audio to

    const clipRole: LineageContributionRole = clip.sourceKind === 'piano-roll' ? 'midi' : defaultRole;

    for (const span of audibleSpans(clip)) {
      let startSec = clip.startSec + span.startSec;
      let endSec = clip.startSec + span.endSec;
      let sourceOffsetSec = clip.offsetIntoSource + span.startSec;

      if (renderWindow) {
        if (endSec <= renderWindow.start || startSec >= renderWindow.end) continue; // entirely outside
        const clippedStart = Math.max(startSec, renderWindow.start);
        const clippedEnd = Math.min(endSec, renderWindow.end);
        sourceOffsetSec += clippedStart - startSec; // advance by exactly what was trimmed off the front
        startSec = clippedStart;
        endSec = clippedEnd;
      }

      const start_sec = round6(startSec);
      const end_sec = round6(endSec);
      const source_offset_sec = round6(sourceOffsetSec);
      if (!(end_sec > start_sec)) continue; // zero/negative length, including after rounding
      if (!Number.isFinite(start_sec) || !Number.isFinite(end_sec) || !Number.isFinite(source_offset_sec)) continue;

      out.push({
        library_entry_id: libraryEntryId,
        clip_id: clip.id,
        track_id: clip.trackId,
        start_sec,
        end_sec,
        source_offset_sec,
        role: clipRole,
      });
    }
  }

  return out;
}

export function contributionsAreEmpty(list: LineageContribution[]): boolean {
  return list.length === 0;
}
