import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { LibraryEntry } from '../../../../state/libraryEntry';
import { fetchArtifactText, type NotationArtifact } from '../../../../lib/notationClient';
import {
  defaultPartVisibility,
  HIGHLIGHT_INKS,
  usePlayAlongStore,
  type PartDescriptor,
} from '../../../../state/playAlongStore';
import {
  buildTimeMap,
  createCursorDriver,
  findStepIndexBySeconds,
  type CursorDriver,
  type ScoreTimeMap,
} from '../../scoreTimeMap';
import {
  applyStripEngraving,
  clampZoom,
  createNoteHighlighter,
  createZoomSettler,
  highlightColor,
  prepareMusicXml,
  readingPos,
  useWheelZoom,
  ZOOM_DEFAULT,
  ZOOM_STEP,
  ZoomControls,
  type NoteHighlighter,
} from '../scoreShared';
import {
  buildStripXMap,
  fitZoomForHeight,
  fitZoomForWidth,
  STRIP_MAX_WIDTH_PX,
  STRIP_SIZE_NOTICE,
  stripContentWidthPx,
  createScrollFollower,
  stripSystemCount,
  xAtSeconds,
  type ScrollFollower,
  type StripXMap,
} from './stripXMap';
import { usePlayAlong } from '../playAlong/usePlayAlongClock';
import { applyInstrumentPreset, registerParts } from '../playAlong/partRegistry';
import { PlayAlongTransport } from '../playAlong/PlayAlongTransport';
import { PartFilter } from '../playAlong/PartFilter';

export interface SheetStripProps {
  artifact: NotationArtifact;
  entry: LibraryEntry | null;
  /** The entry's other artifacts; accepted for interface parity with the
   *  sibling play-along views, unused by the strip itself. */
  artifacts?: NotationArtifact[];
}

/** OSMD's ClefEnum.percussion. Duck-typed rather than imported so the enum
 *  does not drag the OSMD bundle into this module's static graph (the
 *  renderer itself is loaded dynamically, like the PAGE view does). */
const OSMD_CLEF_PERCUSSION = 3;
/** OSMD's MidiInstrument.Percussion. */
const OSMD_MIDI_PERCUSSION = 128;

/** How long a strip write claims the scroll events it causes, ms. Scroll
 *  events are dispatched in the rendering step right after the rAF that wrote
 *  scrollLeft, so this only has to outlive one frame comfortably. */
const AUTO_SCROLL_CLAIM_MS = 200;
/** How long a user scroll parks the auto-scroll, ms (same as the PAGE view). */
const MANUAL_HOLD_MS = 2500;

/** Prepared width handed to prepareMusicXml: the title is not drawn in the
 *  strip, so the wrap budget only has to be generous enough never to break. */
const TITLE_BUDGET_PX = 10000;

/** Extra renders a rebuild may spend bringing a wrapped score back onto one
 *  line (fitZoomForWidth over-estimates a little, so one usually suffices). */
const WIDTH_FIT_PASSES = 2;

/**
 * One PartDescriptor per OSMD instrument. A part is percussion when its first
 * measure opens with a percussion clef on any of its staves, when its MIDI
 * instrument is the percussion channel, or when it is plainly named so.
 */
export function describeOsmdParts(osmd: OpenSheetMusicDisplay): PartDescriptor[] {
  const instruments = osmd?.Sheet?.Instruments ?? [];
  const firstMeasure = osmd?.Sheet?.SourceMeasures?.[0];
  const entries = firstMeasure?.FirstInstructionsStaffEntries ?? [];
  let staffOffset = 0;
  return instruments.map((inst, i) => {
    const staffCount = Math.max(1, inst.Staves?.length ?? 1);
    let percussion = false;
    try {
      percussion = inst.MidiInstrumentId === OSMD_MIDI_PERCUSSION;
      for (let s = staffOffset; s < staffOffset + staffCount && !percussion; s += 1) {
        const instructions = entries[s]?.Instructions ?? [];
        percussion = instructions.some(
          (ins) => (ins as unknown as { ClefType?: number } | null)?.ClefType === OSMD_CLEF_PERCUSSION,
        );
      }
    } catch {
      /* a sheet without instructions: fall through to the name check */
    }
    staffOffset += staffCount;
    let name = '';
    try {
      name = (inst.NameLabel?.text ?? inst.Name ?? '').trim();
    } catch {
      name = '';
    }
    if (!percussion && /drum|percussion/i.test(name)) percussion = true;
    return { name: name || `Part ${i + 1}`, isPercussion: percussion };
  });
}

/**
 * STRIP view for a MusicXML sheet: OSMD renders the whole score ONCE as a
 * single horizontal staffline (a construction-time option, which is why this
 * is a separate mount and not a toggle inside the PAGE view) and the scroller
 * is driven every frame so the music sounding now sits under a fixed now-line
 * at READING_POS of the pane. The scroll position is a pure function of song
 * time through the per-step x map (stripXMap); the OSMD cursor hairline is
 * still stepped by the shared cursor driver and remains the exact truth.
 *
 * A PartFilter (Instrument.Visible) is the lever for wide band scores; every
 * change re-renders and rebuilds the time and x maps. Ctrl+wheel zooms; the
 * zoom cluster's reset fits the staves to the pane height.
 */
export const SheetStrip: React.FC<SheetStripProps> = ({ artifact, entry }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  // Bumped per OSMD load; a driver or highlighter from a discarded StrictMode
  // mount holds an older generation and is refused the cursor.
  const osmdGenRef = useRef(0);
  const mapRef = useRef<ScoreTimeMap | null>(null);
  const xmapRef = useRef<StripXMap | null>(null);
  const driverRef = useRef<CursorDriver | null>(null);
  const highlighterRef = useRef<NoteHighlighter | null>(null);
  const zoomRef = useRef(ZOOM_DEFAULT);
  const renderedZoomRef = useRef(0);
  const visibleRef = useRef<boolean[]>([]);
  const visibleKeyRef = useRef('');
  const cursorVisibleRef = useRef(false);
  const lastStepRef = useRef(-1);
  const lastSecRef = useRef(0);
  // Timestamps + the position we last wrote, so our own scroll events are
  // told apart from the user's (whose scroll parks the auto-scroll).
  const autoScrollUntilRef = useRef(0);
  const expectedLeftRef = useRef(0);
  const manualUntilRef = useRef(0);
  // Smooths the scroll target (see createScrollFollower): the x map places
  // steps proportionally inside their measure, so a long note or a rest is a
  // plateau followed by a jump, and some scores read as a stutter. The
  // follower turns that into one continuous forward glide.
  const followerRef = useRef<ScrollFollower>(createScrollFollower());

  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [status, setStatus] = useState('Loading MusicXML renderer…');
  const [parts, setParts] = useState<PartDescriptor[]>([]);
  const [measureCount, setMeasureCount] = useState(0);
  const [ready, setReady] = useState(false);

  const stored = usePlayAlongStore((s) => s.partVisibility[artifact.id]);
  const nowLine = usePlayAlongStore((s) => s.nowLine);
  const ink = usePlayAlongStore((s) => s.ink);
  const visible = useMemo<boolean[]>(() => {
    if (stored && stored.length === parts.length) return stored;
    return defaultPartVisibility(parts);
  }, [stored, parts]);

  const syncCursorVisibility = useCallback(() => {
    const cursor = osmdRef.current?.cursor;
    if (!cursor) return;
    try {
      if (cursorVisibleRef.current) cursor.show();
      else cursor.hide();
    } catch {
      /* the cursor's page div is not in the document yet */
    }
  }, []);

  /**
   * One frame: step the cursor to the sounding step, repaint the karaoke
   * highlight when the step changed, and put the sounding x under the
   * now-line by writing scrollLeft directly every frame (the browser's own
   * smooth scrolling would only lag a per-frame write; the follower below is
   * what smooths). `force` ignores a manual scroll hold and snaps the
   * follower, for the re-sync after a rebuild or a resize.
   */
  const applyFrame = useCallback((sec: number, force = false) => {
    lastSecRef.current = sec;
    const map = mapRef.current;
    const xmap = xmapRef.current;
    const scroller = scrollRef.current;
    if (!map || !xmap || !scroller || map.steps.length === 0) return;
    const target = findStepIndexBySeconds(map.steps, sec);
    const driver = driverRef.current;
    if (target >= 0 && driver) {
      driver.goTo(target);
      const at = driver.index();
      if (at !== lastStepRef.current) {
        // A step backwards (seek, loop) un-inks the held trail first, so the
        // notes ahead of the new position are not shown as already played.
        if (at < lastStepRef.current) highlighterRef.current?.clear();
        lastStepRef.current = at;
        highlighterRef.current?.apply();
      }
    }
    const now = performance.now();
    if (!force && now < manualUntilRef.current) return;
    const wantLeft = Math.max(0, xAtSeconds(map, xmap, sec) - scroller.clientWidth * readingPos());
    const left = force
      ? followerRef.current.snap(wantLeft)
      : followerRef.current.step(wantLeft, now / 1000, scroller.clientWidth);
    if (Math.abs(scroller.scrollLeft - left) < 0.5) return;
    autoScrollUntilRef.current = now + AUTO_SCROLL_CLAIM_MS;
    scroller.scrollLeft = left;
    // Read back: the browser clamps to the scroll extent, and the scroll
    // event we are about to receive reports the clamped value.
    expectedLeftRef.current = scroller.scrollLeft;
  }, []);

  /**
   * Apply the part visibility, (re)build the time map when it changed, render
   * at the current zoom, rebuild the x map and put the cursor and the scroll
   * back where the audio is. `fit` re-renders once more at the zoom that fits
   * the staves into the pane when that differs by more than 5%.
   */
  const rebuild = useCallback((opts: { remap?: boolean; fit?: boolean } = {}) => {
    const osmd = osmdRef.current;
    const host = hostRef.current;
    const scroller = scrollRef.current;
    if (!osmd || !host || !scroller) return;
    const instruments = osmd.Sheet?.Instruments ?? [];
    let anyVisible = false;
    instruments.forEach((inst, i) => {
      const on = visibleRef.current[i] ?? true;
      try {
        inst.Visible = on;
      } catch {
        /* an instrument without voices cannot be toggled */
      }
      anyVisible = anyVisible || on;
    });
    if (!anyVisible) {
      setStatus('No parts visible: pick a part above.');
      return;
    }
    try {
      host.style.zoom = '';
      if (opts.remap || !mapRef.current) mapRef.current = buildTimeMap(osmd);
      osmd.Zoom = zoomRef.current;
      osmd.render();
      if (opts.fit) {
        const fitted = fitZoomForHeight(host.scrollHeight, scroller.clientHeight, zoomRef.current);
        if (Math.abs(fitted - zoomRef.current) / zoomRef.current > 0.05) {
          zoomRef.current = clampZoom(fitted);
          setZoom(zoomRef.current);
          osmd.Zoom = zoomRef.current;
          osmd.render();
        }
      }
      // The strip's invariant is ONE system. Past OSMD's 32767 px cap the
      // remainder is wrapped into a second system the scroller cannot reach
      // (its measures restart at x 0 and the x map pins them to the right
      // edge), so lower the zoom until the whole score sits on one line. The
      // status line says when that overrode the requested zoom, or when even
      // the smallest zoom was not enough (hide parts, then).
      const requested = zoomRef.current;
      let wrapped = stripSystemCount(osmd) > 1;
      for (let pass = 0; wrapped && pass < WIDTH_FIT_PASSES; pass += 1) {
        const fitted = fitZoomForWidth(
          stripContentWidthPx(osmd, zoomRef.current),
          STRIP_MAX_WIDTH_PX,
          zoomRef.current,
        );
        if (fitted >= zoomRef.current - 1e-6) break;
        zoomRef.current = fitted;
        setZoom(fitted);
        osmd.Zoom = fitted;
        osmd.render();
        wrapped = stripSystemCount(osmd) > 1;
      }
      let note = '';
      if (wrapped) {
        note = `Score too long for one strip line at ${Math.round(zoomRef.current * 100)}%: hide some parts`;
      } else if (zoomRef.current < requested - 1e-6) {
        note = `Zoom capped at ${Math.round(zoomRef.current * 100)}% so the strip stays on one line`;
      }
      renderedZoomRef.current = zoomRef.current;
      xmapRef.current = buildStripXMap(osmd, mapRef.current, zoomRef.current);
      // render() rebuilt every SVG and replaced the Cursor: the painted
      // elements are gone and the driver's index must come from the new
      // cursor's iterator.
      highlighterRef.current?.forget();
      driverRef.current?.resync(mapRef.current);
      lastStepRef.current = -1;
      syncCursorVisibility();
      setStatus(note);
      setReady(true);
      applyFrame(lastSecRef.current, true);
    } catch (e) {
      setStatus(`Strip render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [applyFrame, syncCursorVisibility]);

  // Zoom: instant CSS preview of the strip, one real layout once it settles.
  const settlerRef = useRef<ReturnType<typeof createZoomSettler> | null>(null);
  useEffect(() => {
    settlerRef.current = createZoomSettler(hostRef, renderedZoomRef, () => rebuild());
    return () => settlerRef.current?.cancel();
  }, [rebuild]);
  const applyZoom = useCallback((next: number) => {
    const z = clampZoom(next);
    if (Math.abs(z - zoomRef.current) < 1e-6) return;
    zoomRef.current = z;
    setZoom(z);
    settlerRef.current?.preview(z);
  }, []);

  /** The reset button fits the staves to the pane, which is what "reset"
   *  means for a strip: there is no page size to return to. */
  const fitZoom = useCallback(() => {
    zoomRef.current = ZOOM_DEFAULT;
    setZoom(ZOOM_DEFAULT);
    rebuild({ fit: true });
  }, [rebuild]);

  useWheelZoom(scrollRef, (factor) => applyZoom(zoomRef.current * factor));

  const handle = usePlayAlong(entry, (sec) => applyFrame(sec));

  // The cursor is shown only while it means something: following THIS
  // score's track. Parked against unrelated audio it would claim a sync that
  // does not exist.
  useEffect(() => {
    cursorVisibleRef.current = handle.isSameTrack;
    syncCursorVisibility();
  }, [handle.isSameTrack, syncCursorVisibility, ready]);

  // Load + first render, generation-guarded exactly like the PAGE view.
  useEffect(() => {
    let cancelled = false;
    const generation = osmdGenRef.current + 1;
    osmdGenRef.current = generation;
    setReady(false);
    setParts([]);
    setMeasureCount(0);
    setStatus('Loading MusicXML renderer…');
    const run = async () => {
      const host = hostRef.current;
      if (!host) return;
      host.innerHTML = '';
      try {
        const [{ OpenSheetMusicDisplay: Osmd, CursorType }, xml] = await Promise.all([
          import('opensheetmusicdisplay'),
          fetchArtifactText(artifact.id),
        ]);
        if (cancelled) return;
        const osmd = new Osmd(host, {
          backend: 'svg',
          autoResize: false, // width is the score's own; we re-render on zoom
          renderSingleHorizontalStaffline: true,
          drawTitle: false,
          drawSubtitle: false,
          drawComposer: false,
          drawPartNames: true,
          pageBackgroundColor: '#FFFFFF',
        });
        // Same hairline as the page view. follow:false + FollowCursor=false
        // keeps OSMD's own scrollIntoView (which it calls in single-staffline
        // mode) out of the scroller we drive ourselves.
        osmd.cursorsOptions = [{ type: CursorType.ThinLeft, color: highlightColor(), alpha: 0.95, follow: false }];
        osmd.FollowCursor = false;
        applyStripEngraving(osmd.EngravingRules);
        // Title/subtitle are not drawn; this still drops music21's
        // placeholder credits and normalises the document.
        const prepared = prepareMusicXml(xml, TITLE_BUDGET_PX, '');
        await osmd.load(prepared.xml);
        if (cancelled) return;
        osmdRef.current = osmd;
        const getCursor = () =>
          (osmdGenRef.current === generation ? osmdRef.current?.cursor ?? null : null);
        driverRef.current?.cancel();
        driverRef.current = createCursorDriver(getCursor);
        highlighterRef.current = createNoteHighlighter(getCursor);
        const descriptors = describeOsmdParts(osmd);
        // Tell the shared registry what this sheet contains, so the toolbar's
        // INSTRUMENT preset works from what OSMD parsed instead of fetching
        // the MusicXML again for its <part-list>; then apply the current
        // preset (a no-op for 'all', and for a preset already applied).
        registerParts(artifact.id, descriptors);
        applyInstrumentPreset(artifact.id, usePlayAlongStore.getState().instrument);
        const storedNow = usePlayAlongStore.getState().partVisibility[artifact.id];
        visibleRef.current = storedNow && storedNow.length === descriptors.length
          ? storedNow.slice()
          : defaultPartVisibility(descriptors);
        visibleKeyRef.current = visibleRef.current.map((v) => (v ? '1' : '0')).join('');
        setParts(descriptors);
        setMeasureCount(osmd.Sheet?.SourceMeasures?.length ?? 0);
        // Ours, not the user's: the reset must not read as a manual scroll.
        if (scrollRef.current) {
          autoScrollUntilRef.current = performance.now() + AUTO_SCROLL_CLAIM_MS;
          scrollRef.current.scrollLeft = 0;
          expectedLeftRef.current = 0;
        }
        rebuild({ remap: true, fit: true });
      } catch (e) {
        if (cancelled) return;
        setStatus(`Strip unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void run();
    return () => {
      cancelled = true;
      driverRef.current?.cancel();
      driverRef.current = null;
      highlighterRef.current = null;
      mapRef.current = null;
      xmapRef.current = null;
      const osmd = osmdRef.current;
      osmdRef.current = null;
      try {
        // Dispose() removes the cursor img from its page div, which throws
        // when a render already emptied that container.
        osmd?.cursor?.Dispose();
      } catch {
        /* page div already gone */
      }
      try {
        osmd?.clear();
      } catch {
        /* nothing rendered yet */
      }
    };
  }, [artifact.id, rebuild]);

  // Part visibility comes from the shared store (PartFilter writes it, the
  // instrument preset writes it too); a real change re-renders the strip.
  // Compared by value so the filter seeding the store with the default we
  // already rendered does not cost a second render.
  useEffect(() => {
    if (!ready || parts.length === 0 || !osmdRef.current) return;
    const key = visible.map((v) => (v ? '1' : '0')).join('');
    if (key === visibleKeyRef.current) return;
    visibleKeyRef.current = key;
    visibleRef.current = visible.slice();
    rebuild({ remap: true });
  }, [visible, parts, ready, rebuild]);

  // A scroll we did not just write is the user taking over: hold the
  // auto-scroll off so it does not yank the strip back while they read
  // somewhere else. Re-seat the strip when the pane resizes (the now-line
  // moved with the pane width).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const now = performance.now();
      if (now <= autoScrollUntilRef.current && Math.abs(el.scrollLeft - expectedLeftRef.current) < 1) return;
      manualUntilRef.current = now + MANUAL_HOLD_MS;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => applyFrame(lastSecRef.current, true));
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [applyFrame]);

  // The now-line moved: re-seat the strip under it, even mid-hold.
  useEffect(() => {
    if (ready) applyFrame(lastSecRef.current, true);
  }, [nowLine, ready, applyFrame]);

  const visibleCount = visible.filter(Boolean).length;
  const sizeNotice = measureCount * visibleCount > STRIP_SIZE_NOTICE;
  const showFilter = parts.length > 1;

  return (
    <div className="h-full flex flex-col bg-[#23222a]">
      {(showFilter || sizeNotice || status) && (
        <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 border-b border-white/10 bg-[#0a080f] text-[10px] font-mono text-zinc-300">
          {showFilter && <PartFilter artifactId={artifact.id} parts={parts} />}
          {sizeNotice && (
            <span className="text-amber-300/90" title={`${measureCount} measures × ${visibleCount} parts`}>
              Large score: hide some parts for a smoother strip
            </span>
          )}
          {status && <span className="text-zinc-500 truncate">{status}</span>}
        </div>
      )}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          className="h-full overflow-x-auto overflow-y-auto bg-white flex [align-items:safe_center]"
          role="region"
          aria-label="Score strip"
        >
          {/* OSMD sizes the single-staffline SVG itself; the host only has to
              be as wide as its content so the scroller can travel it. A staff
              shorter than the pane sits vertically centred (safe: a taller one
              still starts at the top and scrolls). */}
          <div ref={hostRef} className="w-max shrink-0" />
        </div>
        {/* The now-line: the music sounding now sits under it. */}
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
            onReset={fitZoom}
          />
        </span>
      </PlayAlongTransport>
    </div>
  );
};

export default SheetStrip;
