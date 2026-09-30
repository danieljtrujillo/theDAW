/**
 * audioWarp — warp markers, and the playable segments they imply.
 *
 * A warp marker is an anchor: "this moment of the source audio plays at this
 * moment of the clip". Between two anchors the audio runs at one constant
 * playback rate, so a list of markers turns into a list of segments that a
 * scheduler can play back to back (or an offline renderer can resample one at
 * a time). Both coordinates are CLIP-RELATIVE seconds, so a warped clip can be
 * moved along the timeline without touching its markers.
 *
 * DESIGN SOURCES (read for their design only — NO code was copied from them):
 *   - ACE-Step-DAW `src/utils/audioWarp.ts` (AGPL-3.0) — markers as anchor
 *     pairs, implicit anchors at each end, dedupe by source position, skipping
 *     degenerate segments, and rate = source length / target length.
 *   - Tracktion Engine `modules/tracktion_engine/model/clips/
 *     tracktion_WarpTimeManager.h` (GPL-3.0 or commercial) — a warp marker as
 *     a pair mapping a linear SOURCE time to a warped time (there
 *     `sourceTime`/`warpTime`), held as an ordered list against one source.
 * Both are copyleft. Every line here was written from the described behaviour.
 */

/** One anchor tying a moment of the source to a moment of the clip. Both are
 *  clip-relative seconds. */
export interface WarpMarker {
  /** Where this moment sits in the source audio. */
  sourceSec: number;
  /** Where it should be heard, measured from the clip's head. */
  targetSec: number;
}

/** A stretch of source audio played at one rate. */
export interface WarpSegment {
  sourceStart: number;
  sourceEnd: number;
  targetStart: number;
  targetEnd: number;
  /** Source seconds per target second. Above 1 the segment plays faster (the
   *  source is squeezed into less timeline), below 1 it plays slower. */
  playbackRate: number;
}

interface Anchor {
  source: number;
  target: number;
}

/**
 * The playable segments for a clip's warp markers.
 *
 * Markers are sorted by source position and deduped by it — two markers on the
 * same source moment contradict each other, so the first one given wins.
 * Markers that cannot anchor anything are dropped: not finite, before the head
 * of the source, past its end, or asking to be heard before the clip starts.
 *
 * The map is then closed with implicit anchors: 0/0 at the head unless a marker
 * already sits there, and at the tail a continuation from the last anchor at
 * the ORIGINAL speed — so the audio after the last marker follows it instead of
 * being squeezed to preserve the clip's old length, and a marker pushed past
 * the source duration still leaves a playable tail. Segments that would take no
 * time on either side are skipped, so every segment returned is playable. With
 * no usable markers the result is a single identity segment.
 *
 * The TARGET is always contiguous — segments hand over end to end, so playback
 * has no gap. The SOURCE is contiguous too unless a segment was skipped, which
 * is exactly what a skip means: that stretch of audio is not played.
 */
export function warpSegments(markers: readonly WarpMarker[], sourceDurationSec: number): WarpSegment[] {
  if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) return [];

  const usable = markers
    .filter((marker) =>
      !!marker
      && Number.isFinite(marker.sourceSec) && Number.isFinite(marker.targetSec)
      && marker.sourceSec >= 0 && marker.sourceSec <= sourceDurationSec
      && marker.targetSec >= 0)
    .sort((a, b) => a.sourceSec - b.sourceSec);

  const anchors: Anchor[] = [];
  for (const marker of usable) {
    // Sorting is stable, so the first marker given for a source moment is the
    // one that survives.
    if (anchors.length > 0 && anchors[anchors.length - 1].source === marker.sourceSec) continue;
    anchors.push({ source: marker.sourceSec, target: marker.targetSec });
  }
  if (anchors.length === 0 || anchors[0].source > 0) anchors.unshift({ source: 0, target: 0 });
  const last = anchors[anchors.length - 1];
  if (last.source < sourceDurationSec) {
    // The tail carries ON from the last anchor at the original speed. Pinning
    // it to source-end/source-end instead would keep the clip's old length, but
    // a marker pushed past the source duration then makes the tail run
    // backwards in time — it is dropped as degenerate below and that audio is
    // never heard at all. Continuing at rate 1 always leaves a playable tail.
    anchors.push({
      source: sourceDurationSec,
      target: last.target + (sourceDurationSec - last.source),
    });
  }

  const segments: WarpSegment[] = [];
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const from = anchors[i];
    const to = anchors[i + 1];
    const sourceLen = to.source - from.source;
    const targetLen = to.target - from.target;
    if (sourceLen <= 0 || targetLen <= 0) continue;
    segments.push({
      sourceStart: from.source,
      sourceEnd: to.source,
      targetStart: from.target,
      targetEnd: to.target,
      playbackRate: sourceLen / targetLen,
    });
  }
  return segments;
}
