import React, { useCallback, useEffect, useRef, useState } from 'react';
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

export interface TabStripProps {
  artifact: NotationArtifact;
  entry: LibraryEntry | null;
}

/** alphaTab aligns the played bar to the scroller's left edge plus this
 *  offset; a negative offset of READING_POS of the pane puts the bar under
 *  the same now-position the sheet strip uses. */
const scrollOffsetFor = (scroller: HTMLElement | null): number =>
  -Math.round((scroller?.clientWidth ?? 0) * readingPos());

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

  // The now-position is a fraction of the pane: keep alphaTab's scroll
  // offset in step when the pane resizes or the NOW preference changes.
  const nowLine = usePlayAlongStore((s) => s.nowLine);
  const ink = usePlayAlongStore((s) => s.ink);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const apply = () => {
      const api = apiRef.current;
      if (!api) return;
      try {
        const player = api.settings.player as { scrollOffsetX?: number };
        const next = scrollOffsetFor(el);
        if (player.scrollOffsetX === next) return;
        player.scrollOffsetX = next;
        api.updateSettings();
      } catch {
        /* settings not ready */
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nowLine]);

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
              starts at the top and scrolls (safe centring). */}
          <div ref={containerRef} className="shrink-0" />
        </div>
        {/* The now-position: alphaTab scrolls the played bar to this line. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-0.5 opacity-60"
          style={{ left: `${readingPos() * 100}%`, backgroundColor: HIGHLIGHT_INKS[ink].color }}
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
