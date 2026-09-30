import { useEffect, useRef, useState } from 'react';
import { computeCanvasBox, measureCanvasBox } from '../../lib/canvasScale';
import { retainDecodedAudio } from '../../lib/djAudioCache';
import {
  EMPTY_BINS,
  MAX_CANVAS_DEVICE_WIDTH,
  analyzeBufferAsync,
  binCountFor,
  canvasWindowFor,
  decodeAudio,
  drawWaveformCached,
  type WaveBin,
  type WaveformDrawMode,
} from './djSemanticWaveformAnalysis';

/** The on-screen part of `el`, in viewport px, after the window and every
 *  ancestor that clips horizontally. */
function visibleRangeOf(el: Element): { left: number; right: number } {
  const rect = el.getBoundingClientRect();
  let left = Math.max(rect.left, 0);
  let right = Math.min(rect.right, typeof window === 'undefined' ? rect.right : window.innerWidth);
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (window.getComputedStyle(node).overflowX === 'visible') continue;
    const clip = node.getBoundingClientRect();
    left = Math.max(left, clip.left);
    right = Math.min(right, clip.right);
  }
  return { left, right: Math.max(left, right) };
}

export function DJSemanticWaveform({
  audioUrl,
  height = 64,
  viewportStart = 0,
  viewportEnd = 1,
  onDuration,
  transparentBg = false,
  normalize = true,
  mode = 'semantic',
  width,
}: {
  audioUrl: string;
  height?: number;
  viewportStart?: number;
  viewportEnd?: number;
  /** Fires once the audio decodes, reporting its length in seconds. */
  onDuration?: (seconds: number) => void;
  /** Skip the opaque canvas background so a caller's own background shows through. */
  transparentBg?: boolean;
  /** `true` (default, unchanged): rescale peaks to this track's own loudest
   *  sample — the DJ decks' behaviour, so two tracks of different mastering
   *  loudness still fill the same visual height. `false`: absolute amplitude,
   *  clamped but never rescaled — REAPER's default, and what the EDIT
   *  timeline wants (see `analyzeBuffer`'s `AnalyzeOptions`). */
  normalize?: boolean;
  /** How the body is coloured; see `WaveformDrawMode`. This component stays
   *  a plain-props leaf (no store read) — `SemanticWave` owns picking it
   *  from the global preference. */
  mode?: WaveformDrawMode;
  /** Lane width in CSS px, if the caller already knows it. With the viewport
   *  span it decides how many analysis bins this instance asks for (see
   *  `binCountFor`). Omitted, the wrapper is measured instead, so no call
   *  site has to change. */
  width?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bins, setBins] = useState<WaveBin[]>(EMPTY_BINS);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  // What the decode learned: which URL, and how long it is. The AudioBuffer
  // itself is NOT kept here. Holding it in state kept a full decoded copy of
  // every mounted waveform's audio alive for as long as it was mounted (an
  // EDIT arrangement of twenty clips is twenty buffers of ~74 MB), and made
  // the decode cache's eviction free nothing. A re-analysis asks the cache
  // again; while this lane holds the URL (`retainDecodedAudio`) that is a hit.
  const [decoded, setDecoded] = useState<{ url: string; duration: number } | null>(null);

  // The latest `onDuration`, read when a decode lands: a fresh closure each
  // render must not re-run the decode.
  const onDurationRef = useRef(onDuration);
  useEffect(() => {
    onDurationRef.current = onDuration;
  }, [onDuration]);

  // The measured lane width in CSS px, as STATE — refreshed by the draw
  // effect's ResizeObserver below. A lane that is hidden, or not laid out yet
  // when the audio finishes decoding, measures 0 (the historical bin count)
  // and must re-analyse once it is shown or resized. 0 means "not measured".
  const [laneWidth, setLaneWidth] = useState(0);

  // Fetch + decode — keyed ONLY on `audioUrl`. Through the page-wide decode
  // cache (`lib/djAudioCache`): the deck's two lanes and the engine share one
  // fetch and one decode per URL. The lane holds the URL while mounted, and
  // its signal withdraws it from a download still in flight when it unmounts
  // or changes track, so an unmounted lane no longer fills the cache with
  // audio nobody shows.
  useEffect(() => {
    const release = retainDecodedAudio(audioUrl);
    const controller = new AbortController();
    setDecoded(null);
    setDecodeError(null);
    decodeAudio(audioUrl, null, controller.signal)
      .then((buffer) => {
        if (controller.signal.aborted) return;
        setDecoded({ url: audioUrl, duration: buffer.duration });
        onDurationRef.current?.(buffer.duration);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDecodeError(err instanceof Error ? err.message : 'Unable to decode audio waveform');
      });
    return () => {
      controller.abort();
      release();
    };
  }, [audioUrl]);

  // The bin count follows ZOOM: the whole track spans lane width / viewport
  // span CSS px, and `binCountFor` quantises that, so most resizes and zooms
  // leave the count — and therefore the analysis below — untouched.
  const span = viewportEnd - viewportStart;
  const lane = width ?? laneWidth;
  const binCount =
    decoded && decoded.url === audioUrl
      ? binCountFor(decoded.duration, lane > 0 && span > 0 ? lane / span : undefined)
      : 0;

  // Analyze — keyed on the decode, `normalize` and the bin count, the inputs
  // that decide the result. Runs again only when one of them changes; a
  // `normalize` flip alone never touches the effect above. `analyzeBufferAsync`
  // memoises per (url, normalize, binCount, rate) and runs the loop in a
  // Worker where one exists, so the deck's SECOND lane costs nothing.
  useEffect(() => {
    if (!decoded || decoded.url !== audioUrl || binCount <= 0) {
      setBins(EMPTY_BINS);
      return;
    }
    const controller = new AbortController();
    decodeAudio(audioUrl, null, controller.signal)
      .then((buffer) => analyzeBufferAsync(audioUrl, buffer, { normalize, bins: binCount, signal: controller.signal }))
      .then((result) => {
        if (!controller.signal.aborted) setBins(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBins(EMPTY_BINS);
      });
    return () => controller.abort();
  }, [decoded, audioUrl, normalize, binCount]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const cacheKey = `${audioUrl}|${normalize ? 'n' : 'a'}`;
    /** The part of the wrapper the canvas covers while windowed (CSS px), so
     *  a scroll that stays inside it needs no redraw. */
    let drawn: { left: number; width: number } | null = null;
    let frame = 0;

    const render = () => {
      frame = 0;
      // Publish the measured lane width for the bin count. Compared before
      // setting, so this never loops.
      const measured = Math.round(wrap.clientWidth);
      setLaneWidth((prev) => (prev === measured ? prev : measured));
      // `height` is the wrapper's inline height, already in local css px, so
      // it is passed straight through; only the width needs the zoom correction.
      const full = measureCanvasBox(wrap, { cssHeight: height });
      // Only a wrapper too wide for one canvas pays for finding what is on
      // screen; this runs on every viewport move of a playing deck.
      let win: { left: number; width: number } | null = null;
      if (full.deviceWidth > MAX_CANVAS_DEVICE_WIDTH) {
        const rect = wrap.getBoundingClientRect();
        const visible = visibleRangeOf(wrap);
        win = canvasWindowFor({
          wrapLeft: rect.left,
          wrapWidth: rect.width,
          visibleLeft: visible.left,
          visibleRight: visible.right,
          zoom: full.zoom,
          dpr: full.dpr,
        });
      }
      if (!win) {
        // Back to filling the wrapper (the window may be left over from an
        // earlier run of this effect, so the canvas itself is what says so).
        if (canvas.style.width) {
          canvas.style.left = '';
          canvas.style.right = '';
          canvas.style.width = '';
        }
        drawn = null;
        drawWaveformCached(canvas, full, bins, viewportStart, viewportEnd, transparentBg, decodeError, cacheKey, mode);
        return;
      }
      // Too wide for one canvas: cover the on-screen part (plus margin) and
      // draw exactly that part of the viewport, at full resolution.
      drawn = win;
      canvas.style.left = `${win.left}px`;
      canvas.style.right = 'auto';
      canvas.style.width = `${win.width}px`;
      const box = computeCanvasBox(win.width * full.zoom, full.cssHeight * full.zoom, full.zoom, full.dpr, {
        cssWidth: win.width,
        cssHeight: height,
      });
      const perPx = span / full.cssWidth;
      drawWaveformCached(
        canvas,
        box,
        bins,
        viewportStart + win.left * perPx,
        viewportStart + (win.left + win.width) * perPx,
        transparentBg,
        decodeError,
        cacheKey,
        mode,
      );
    };

    // A windowed canvas follows the wrapper as the page scrolls; it redraws
    // only when the on-screen part leaves what it drew.
    const onScroll = () => {
      if (!drawn || frame) return;
      const rect = wrap.getBoundingClientRect();
      const zoom = rect.width > 0 && wrap.clientWidth > 0 ? rect.width / wrap.clientWidth : 1;
      const visible = visibleRangeOf(wrap);
      const left = (visible.left - rect.left) / zoom;
      const right = (visible.right - rect.left) / zoom;
      if (left >= drawn.left && right <= drawn.left + drawn.width) return;
      frame = requestAnimationFrame(render);
    };

    render();
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [bins, height, viewportEnd, viewportStart, span, transparentBg, decodeError, audioUrl, normalize, mode]);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full min-w-0 overflow-hidden rounded"
      style={{ height, background: transparentBg ? 'transparent' : '#06070d' }}
      role={decodeError ? 'img' : undefined}
      aria-label={decodeError ? `Waveform unavailable: ${decodeError}` : undefined}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      {decodeError && (
        // A decode failure that happens after mount (the canvas was already
        // painted, or the wrapper is off-screen) must still be announced to
        // screen readers, not just exposed via the static aria-label above —
        // a visually-hidden live region fires even without focus moving.
        <span role="status" className="sr-only">
          Waveform unavailable: {decodeError}
        </span>
      )}
    </div>
  );
}
