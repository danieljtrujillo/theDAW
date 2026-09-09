import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AlphaTabApi } from '@coderline/alphatab';
import type { LibraryEntry } from '../../../../state/libraryEntry';
import { fetchArtifactText, type NotationArtifact } from '../../../../lib/notationClient';
import {
  clampZoom,
  readingPos,
  useWheelZoom,
  ZOOM_DEFAULT,
  ZOOM_STEP,
  ZoomControls,
  type ExternalMediaOutput,
} from '../scoreShared';
import { usePlayAlong } from '../playAlong/usePlayAlongClock';
import { PlayAlongTransport } from '../playAlong/PlayAlongTransport';
import { HIGHLIGHT_INKS, usePlayAlongStore } from '../../../../state/playAlongStore';
import { stripNowGeometry, stripScrollOffsetX } from './stripXMap';

export interface TabStripProps {
  artifact: NotationArtifact;
  entry: LibraryEntry | null;
}

/** alphaTab aligns the played bar to the scroller's left edge plus this
 *  offset. The container carries a run-up pad of the now-position's offset —
 *  bar 1 has to sit UNDER the line, and asking for a negative scrollLeft only
 *  gets clamped to 0 and leaves it stranded to the left of it — and alphaTab's
 *  bar bounds are canvas-local, so the pad already does the whole job. */
const scrollOffsetFor = (scroller: HTMLElement | null): number =>
  stripScrollOffsetX(stripNowGeometry(scroller?.clientWidth ?? 0, readingPos()));

/**
 * STRIP view for an alphaTex tab: alphaTab's horizontal layout (one endless
 * system) in the external-media player mode the PAGE tab view already uses,
 * so the beat cursor, the note highlighting and the continuous scroll are
 * alphaTab's own, driven by the play-along clock pushed in every frame.
 * There is no FOLLOW checkbox: the strip IS the follow.
 */
export const TabStrip: React.FC<TabStripProps> = ({ artifact, entry }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<AlphaTabApi | null>(null);
  const zoomRef = useRef(ZOOM_DEFAULT);
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  // The measured scroller width: it drives BOTH the run-up pad on the tab and
  // the painted now-line, so a vertical scrollbar (clientWidth < the wrapper's
  // width) cannot put the line off the bar it marks.
  const [paneWidth, setPaneWidth] = useState(0);
  const [status, setStatus] = useState('Loading tab renderer…');
  const [ready, setReady] = useState(false);

  const applyZoom = useCallback((next: number) => {
    const z = clampZoom(next);
    zoomRef.current = z;
    setZoom(z);
    const api = apiRef.current;
    if (api) {
      try {
        api.settings.display.scale = z;
        api.updateSettings();
        api.render();
      } catch {
        /* render races with reload — ignore */
      }
    }
  }, []);

  useWheelZoom(scrollRef, (factor) => applyZoom(zoomRef.current * factor));

  /** Push the song position into alphaTab's external-media output; falls
   *  back to the time-position setter on a build without that output. */
  const pushPosition = useCallback((sec: number) => {
    const api = apiRef.current;
    if (!api) return;
    const ms = sec * 1000;
    const out = (api as unknown as { player?: { output?: ExternalMediaOutput } }).player?.output ?? null;
    try {
      if (out?.updatePosition) out.updatePosition(ms);
      else (api as unknown as { timePosition?: number }).timePosition = ms;
    } catch {
      /* mid-reload */
    }
  }, []);

  const handle = usePlayAlong(entry, pushPosition);

  useEffect(() => {
    let cancelled = false;
    let api: AlphaTabApi | null = null;
    setReady(false);
    setStatus('Loading tab renderer…');
    const run = async () => {
      const container = containerRef.current;
      if (!container) return;
      try {
        const [alphaTab, tex] = await Promise.all([
          import('@coderline/alphatab'),
          fetchArtifactText(artifact.id),
        ]);
        if (cancelled) return;
        // Same construction as the PAGE tab view (external media mode,
        // alphaTab cursor + highlighting, continuous scroll on our scroller)
        // plus the horizontal layout and the now-position scroll offset.
        // Feature-detected so an older bundle degrades to a static tab.
        const at = alphaTab as unknown as {
          PlayerMode?: { EnabledExternalMedia?: number };
          ScrollMode?: { Continuous?: number };
        };
        const externalMode = at.PlayerMode?.EnabledExternalMedia;
        api = new alphaTab.AlphaTabApi(container, {
          player: {
            ...(externalMode !== undefined
              ? {
                  playerMode: externalMode,
                  enableCursor: true,
                  enableAnimatedBeatCursor: true,
                  enableElementHighlighting: true,
                  ...(at.ScrollMode?.Continuous !== undefined ? { scrollMode: at.ScrollMode.Continuous } : {}),
                  scrollElement: scrollRef.current ?? undefined,
                  scrollOffsetX: scrollOffsetFor(scrollRef.current),
                }
              : { enablePlayer: false }),
          } as never,
          display: {
            layoutMode: alphaTab.LayoutMode.Horizontal,
            scale: zoomRef.current,
          },
        });
        apiRef.current = api;
        api.error.on((err) => {
          if (!cancelled) setStatus(`Tab render error: ${err instanceof Error ? err.message : String(err)}`);
        });
        api.renderFinished.on(() => {
          if (cancelled) return;
          setStatus('');
          setReady(true);
        });
        api.tex(tex);
      } catch (e) {
        if (cancelled) return;
        setStatus(`Tab strip unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void run();
    return () => {
      cancelled = true;
      apiRef.current = null;
      try {
        api?.destroy();
      } catch {
        // ignore teardown errors
      }
    };
  }, [artifact.id]);

  // alphaTab's player state follows ours: play() when our engine plays THIS
  // entry so the beat cursor animates between position pushes, pause() when
  // it stops or holds another track. Re-run once the tab has rendered so a
  // strip opened mid-playback starts moving.
  const active = handle.isSameTrack && handle.isPlaying;
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !ready) return;
    try {
      if (active) api.play?.();
      else api.pause?.();
    } catch {
      /* cursor still follows via position pushes */
    }
  }, [active, ready]);

  // The now-position and the pad are fractions of the pane: keep the measured
  // width, alphaTab's scroll offset and the painted line in step when the pane
  // resizes or the NOW preference changes. A layout effect so the first
  // measurement lands before the first paint.
  const nowLine = usePlayAlongStore((s) => s.nowLine);
  const ink = usePlayAlongStore((s) => s.ink);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const apply = () => {
      // A parked strip measures 0 (ScoreView keeps the other mode alive behind
      // `hidden`, which is display:none): keep the last good width so the pad
      // and the line are already right on the first frame back.
      setPaneWidth((w) => (el.clientWidth > 0 ? el.clientWidth : w));
      const api = apiRef.current;
      if (!api) return;
      try {
        const player = api.settings.player as { scrollOffsetX?: number };
        const next = scrollOffsetFor(el);
        if (player.scrollOffsetX !== next) {
          player.scrollOffsetX = next;
          api.updateSettings();
        }
        // The pad moved with the pane, and the tab moved with the pad: put the
        // played bar back on the line instead of waiting for the next beat.
        api.scrollToCursor?.();
      } catch {
        /* settings not ready */
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nowLine]);

  const nowGeom = stripNowGeometry(paneWidth, readingPos());

  return (
    <div className="h-full flex flex-col bg-[#23222a]">
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          className="h-full overflow-x-auto overflow-y-auto bg-white text-black flex flex-col [justify-content:safe_center]"
          role="region"
          aria-label="Tab strip"
        >
          {status && <div className="p-4 text-xs font-mono text-zinc-600">{status}</div>}
          {/* A tab shorter than the pane sits vertically centred; a taller one
              starts at the top and scrolls (safe centring). The left pad is
              the run-up bar 1 needs to sit under the now-position. */}
          <div ref={containerRef} className="shrink-0" style={{ paddingLeft: nowGeom.padPx }} />
        </div>
        {/* The now-position: alphaTab scrolls the played bar to this line.
            Placed from the measured scroller width, the same one the scroll
            offset is computed from. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-0.5 opacity-60"
          style={{ left: nowGeom.offsetPx, backgroundColor: HIGHLIGHT_INKS[ink].color }}
        />
      </div>
      <PlayAlongTransport
        entry={entry}
        isSameTrack={handle.isSameTrack}
        isPlaying={handle.isPlaying}
        otherTrackLoaded={handle.otherTrackLoaded}
        onTransport={handle.onTransport}
      >
        {/* ZoomControls positions itself bottom-right of its nearest positioned
            ancestor; this box gives it one the height of the footer row. */}
        <span className="relative block h-8 w-32 shrink-0">
          <ZoomControls
            zoom={zoom}
            onIn={() => applyZoom(zoomRef.current * ZOOM_STEP)}
            onOut={() => applyZoom(zoomRef.current / ZOOM_STEP)}
            onReset={() => applyZoom(ZOOM_DEFAULT)}
          />
        </span>
      </PlayAlongTransport>
    </div>
  );
};

export default TabStrip;
