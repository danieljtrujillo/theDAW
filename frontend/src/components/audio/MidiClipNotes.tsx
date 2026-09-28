import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AudioClip } from '../../state/editorStore';
import { clipNoteLayout, paintClipNotes } from '../../lib/clipNotesCanvas';
import { NULL_PAINT, canvas2d } from '../../lib/rollCanvas';
import { applyCanvasBox, computeCanvasBox, effectiveZoom } from '../../lib/canvasScale';
import { stepClock } from '../../lib/rollTempo';

/** How far (px) outside the timeline's view a clip's body starts painting, so a track scrolled into view is drawn as it arrives. */
const ON_SCREEN_MARGIN_PX = 160;

/**
 * An EDIT MIDI clip's notes (FL-style) on a canvas that covers only the part
 * of the clip in the timeline's view: across, `visibleFromPx` to
 * `visibleToPx` (clip px); down, only while the clip's track is in view (an
 * IntersectionObserver on the body, so a vertical scroll re-renders nothing
 * else). The notes sit in an interval index by their seconds on the clip's own
 * clock (lib/clipNotesCanvas), and a paint draws only those inside the visible
 * span, so a forty-minute part scrolled across draws what is on screen, and a
 * clip out of view in either direction mounts no canvas and paints nothing.
 *
 * The backing store holds the visible span at the device pixel ratio times the
 * shell's CSS zoom (lib/canvasScale). What a paint drew is on the canvas as
 * `data-notes`, and its device pixels per clip px as `data-scale`.
 */
export const MidiClipNotes: React.FC<{
  clip: AudioClip;
  /** The timeline's px per second. */
  zoom: number;
  selected: boolean;
  /** The body's height (px): the clip's height under its 14px header. */
  height: number;
  visibleFromPx: number;
  visibleToPx: number;
}> = ({ clip, zoom, selected, height, visibleFromPx, visibleToPx }) => {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // In view down the timeline. Where the page has no IntersectionObserver the body counts as in view.
  const [onScreen, setOnScreen] = useState(true);
  // The clip's own clock: one tempo, or its tempo map, so a note inside a
  // ritardando is drawn where it plays.
  const clock = useMemo(() => stepClock(clip.sourceBpm ?? 120, clip.sourceTempoMap), [clip.sourceBpm, clip.sourceTempoMap]);
  const offset = clip.offsetIntoSource ?? 0;
  const layout = useMemo(() => clipNoteLayout(clip.sourcePianoRoll, clock, offset), [clip.sourcePianoRoll, clock, offset]);
  const clipPx = clip.durationSec * zoom;
  const fromPx = Math.max(0, Math.min(clipPx, visibleFromPx));
  const toPx = Math.max(fromPx, Math.min(clipPx, visibleToPx));
  const width = toPx - fromPx;
  const hasNotes = layout !== null;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setOnScreen(last.isIntersecting);
      },
      { rootMargin: `${ON_SCREEN_MARGIN_PX}px 0px` },
    );
    io.observe(body);
    return () => io.disconnect();
  }, [hasNotes]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout) return;
    const win = typeof window === 'undefined' ? null : window;
    const box = computeCanvasBox(0, 0, effectiveZoom(canvas), Math.max(1, win?.devicePixelRatio || 1), {
      cssWidth: width,
      cssHeight: height,
    });
    applyCanvasBox(canvas, box);
    // The context is the canvas element's own (lib/rollCanvas canvas2d): a clip
    // scrolled out of view and back mounts a new canvas, which draws into its own.
    const drawn = paintClipNotes(canvas2d(canvas) ?? NULL_PAINT, layout, {
      zoom,
      clipDur: clip.durationSec,
      fromPx,
      toPx,
      height,
      color: clip.color,
      selected,
      scale: box.scale,
    });
    canvas.dataset.notes = String(drawn);
    canvas.dataset.scale = String(box.scale);
  }, [layout, zoom, clip.durationSec, clip.color, selected, fromPx, toPx, width, height, onScreen]);

  if (!layout) return null;
  return (
    <div ref={bodyRef} className="absolute inset-x-0 bottom-0 top-3.5 overflow-hidden pointer-events-none">
      {width > 0 && onScreen && (
        <canvas
          ref={canvasRef}
          data-clip-notes={clip.id}
          aria-hidden="true"
          className="absolute top-0"
          style={{ left: fromPx, width, height }}
        />
      )}
    </div>
  );
};
