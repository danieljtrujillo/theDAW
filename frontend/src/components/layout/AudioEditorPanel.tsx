/**
 * AUDIO EDIT — the dock drawer bound to ONE audio clip.
 *
 * Double-clicking an audio clip on the EDIT timeline opens it here, the way
 * double-clicking a MIDI clip opens the piano roll. The two are deliberately
 * the same shape: `audioEditorStore` holds a clip ID exactly as
 * `pianoRollStore.editingClipId` does, and everything on screen is resolved
 * from the live clip on every render, so a trim made on the timeline shows up
 * here and a trim made here shows up there.
 *
 * WHAT IT SHOWS. The clip's whole SOURCE, at this drawer's own zoom and scroll
 * — reading a 40 ms click out of a clip must not disturb the arrangement you
 * are looking at. The part of the source the clip actually plays is drawn
 * bright between two trim handles; everything the clip trims away is dimmed but
 * still there, because the thing you most need to see while trimming is the
 * audio you are about to cut off. The waveform itself is the app's existing
 * SemanticWave (the DJ tab's frequency-coloured render, reused by MAKE, MIX and
 * the timeline's own clip bodies) pointed at a window of the same blob — no
 * second decoder, no second peak pass.
 *
 * WHAT IT WRITES. Clip fields, through `editorStore.updateClip`, and nothing
 * else. Every edit is non-destructive: trims, fades, gain and mute are all
 * properties of the clip, and THE SOURCE FILE IS NEVER TOUCHED. Reset trims
 * puts the whole source back.
 *
 * UNDO. A drag is one step: the pointer-down calls `beginUndoStep('clip:<id>')`
 * to cut the coalescing burst and name the gesture, and every frame after it
 * folds into that step because `updateClip` carries the same key. A field
 * commit or a button is a discrete edit and calls `beginUndoStep()` first, so
 * it can never be swallowed by a drag that happened beside it.
 *
 * AUDITION plays through the app's ONE transport (`playerStore`), which is what
 * makes a second simultaneous copy impossible: loading the clip's blob there
 * drops whatever the transport was doing, exactly as auditioning a library
 * track does.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Play, RotateCcw, Square, VolumeX, ZoomIn, ZoomOut } from 'lucide-react';
import { SemanticWave } from '../audio/SemanticWave';
import { WaveformModeToggle } from '../audio/WaveformModeControl';
import {
  beginUndoStep,
  clipPeakGain,
  clipSourceSpanSec,
  clipStretchRate,
  useEditorStore,
  type AudioClip,
} from '../../state/editorStore';
import { useAudioEditorStore, selectEditedClip } from '../../state/audioEditorStore';
import { REVEAL_CLIP_EVENT, type RevealClipDetail } from '../audio/clipDoubleClick';
import { useAppUiStore } from '../../state/appUiStore';
import { useLibraryStore } from '../../state/libraryStore';
import { usePlayerStore } from '../../state/playerStore';
import { logError } from '../../state/logStore';
import {
  AUDIO_EDITOR_NUDGE_COARSE_SEC,
  AUDIO_EDITOR_NUDGE_SEC,
  CLIP_GAIN_DB_MAX,
  CLIP_GAIN_DB_MIN,
  clampGainDb,
  dbToGain,
  dragClipOf,
  fadeTargetOf,
  fitZoom,
  formatSeconds,
  gainToDb,
  parseNumberField,
  resetTrims,
  setFadeIn,
  setFadeOut,
  slipSourceTo,
  sourcePercentInWindow,
  sourceSecAtWindowFrac,
  sourceWindow,
  trimEndTo,
  trimStartTo,
} from './audioEditorModel';

/* ── shared class strings (the dock's own idiom) ───────────────────────────── */

const LABEL = 'font-display text-xs font-bold uppercase tracking-wider et-ink-2';
const DOMAIN = 'text-xs font-bold uppercase tracking-widest text-purple-300/70';
const FIELD =
  'w-20 px-1.5 py-0.5 rounded border border-white/10 bg-black/40 text-xs font-semibold et-ink tabular-nums focus-visible:outline focus-visible:outline-purple-400';
const BTN =
  'inline-flex items-center gap-1 px-2 py-1 rounded border border-white/10 et-ink-2 hover:et-ink hover:bg-white/5 font-display text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline focus-visible:outline-purple-400 disabled:opacity-40';
const BTN_ON = 'border-[rgb(var(--et-accent)/0.6)] bg-white/10 text-[rgb(var(--et-accent))]';
const EMPTY = 'h-full flex items-center justify-center px-6 text-center font-sans text-xs et-ink-2';

/** Shortest visible waveform box, in local CSS px. */
const WAVE_MIN_H = 72;
/** One zoom button press, as a factor on px-per-source-second. */
const ZOOM_STEP = 1.6;

/* The model throws `RangeError` on a non-finite number rather than writing one
 * into a clip, which is right for an editor and wrong for a renderer: a project
 * file carrying a damaged field would take the whole tab down instead of
 * showing it. These two are the boundary — every number that reaches the model
 * or the DOM from a clip passes through one of them first. */

/** A clip field as a number the geometry can use. */
const sane = (n: number, fallback = 0): number => (Number.isFinite(n) ? n : fallback);
/** A clip field as text, with an em dash where there is no number to show. */
const secs = (n: number, decimals = 3): string => (Number.isFinite(n) ? formatSeconds(n, decimals) : '—');

/* ── a labelled numeric field ──────────────────────────────────────────────── */

/**
 * One numeric field, with its TIME DOMAIN spelled out beside the label — the
 * same three words the model's doc comments use, because "start" means three
 * different numbers depending on whether you are counting from the head of the
 * arrangement, the head of the clip or the head of the file.
 *
 * Edits commit on Enter or blur, never on every keystroke: a clip must not be
 * rewritten while a number is half-typed. Escape reverts the draft and does
 * nothing else — it is the one key on this panel guaranteed to change no clip.
 */
const NumField: React.FC<{
  id: string;
  label: string;
  domain: 'timeline' | 'source' | 'clip';
  value: number;
  unit?: string;
  decimals?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}> = ({ id, label, domain, value, unit = 's', decimals = 3, disabled = false, onCommit }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? secs(value, decimals);

  const commit = () => {
    if (draft === null) return;
    const parsed = parseNumberField(draft);
    setDraft(null);
    if (parsed !== null) onCommit(parsed);
  };

  return (
    <div className="flex flex-col gap-0.5 shrink-0">
      <label htmlFor={id} className={LABEL}>
        {label} <span className={DOMAIN}>{domain}</span>
      </label>
      <div className="flex items-center gap-1">
        <input
          id={id}
          name={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={shown}
          className={FIELD}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
              return;
            }
            if (e.key === 'Escape') {
              // Non-destructive by construction: throw the draft away, leave
              // the clip alone, and keep the key off the timeline's own handler.
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
        <span aria-hidden="true" className="tabular-nums text-xs font-semibold et-ink-2">
          {unit}
        </span>
      </div>
    </div>
  );
};

/* ── the panel ─────────────────────────────────────────────────────────────── */

export const AudioEditorPanel: React.FC = () => {
  const clipId = useAudioEditorStore((s) => s.clipId);
  const viewZoom = useAudioEditorStore((s) => s.viewZoom);
  const viewScrollSec = useAudioEditorStore((s) => s.viewScrollSec);
  const setViewZoom = useAudioEditorStore((s) => s.setViewZoom);
  const setViewScrollSec = useAudioEditorStore((s) => s.setViewScrollSec);

  const clip = useEditorStore((s) => selectEditedClip(s.clips, clipId));
  const trackName = useEditorStore((s) =>
    clip ? (s.tracks.find((t) => t.id === clip.trackId)?.name ?? 'Unassigned track') : null,
  );
  const updateClip = useEditorStore((s) => s.updateClip);
  const setSelected = useEditorStore((s) => s.setSelected);
  const setSelectedClipIds = useEditorStore((s) => s.setSelectedClipIds);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const setCenterTab = useAppUiStore((s) => s.setCenterTab);

  const sourceAsset = useLibraryStore((s) => {
    if (!clip?.libraryEntryId) return null;
    const entry = s.entries.find((e) => e.id === clip.libraryEntryId);
    return entry ? (entry.audioFilename || entry.title) : null;
  });

  const ids = useId();
  const waveRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: WAVE_MIN_H });

  // The blob's object URL is minted INSIDE the effect that revokes it, so each
  // mount owns exactly the URL its own cleanup tears down (ClipWave's rule —
  // StrictMode's mount/cleanup/remount otherwise hands the remount a dead URL).
  const blob = clip?.audioBlob ?? null;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setAudioUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setAudioUrl(url);
    return () => {
      setAudioUrl((current) => (current === url ? null : current));
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already gone */
      }
    };
  }, [blob]);

  // The drawer measures itself so a fit is a real fit rather than a guess.
  useLayoutEffect(() => {
    const el = waveRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const next = { width: el.clientWidth, height: Math.max(WAVE_MIN_H, el.clientHeight) };
      setBox((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── derived geometry ──────────────────────────────────────────────────── */

  const rate = clip ? clipStretchRate(clip) : 1;
  /** The clip's own length on the timeline, in TIMELINE seconds. */
  const clipDurationSec = clip ? Math.max(0, sane(clip.durationSec)) : 0;
  // A clip at rate `r` eats `r` SOURCE seconds per TIMELINE second, so a
  // missing sourceDuration falls back to the timeline length converted
  // through the rate — the raw timeline seconds undercounted a stretched clip.
  const sourceDuration = clip
    ? Math.max(0, sane(clip.sourceDuration) > 0 ? sane(clip.sourceDuration) : clipDurationSec * rate)
    : 0;
  /** SOURCE second the clip starts reading at. */
  const readStart = clip ? Math.max(0, sane(clip.offsetIntoSource)) : 0;
  /** SOURCE second the clip stops reading at. */
  const readEnd = clip ? readStart + Math.max(0, sane(clipSourceSpanSec(clip))) : 0;
  // The sanitised clip every trim/slip/reset model call reads instead of the
  // raw `clip` — see dragClipOf's doc comment for why a damaged clip degrades
  // here rather than throwing out of a pointer handler mid-gesture.
  const dragClip = useMemo(
    () => (clip ? dragClipOf(clip, clipDurationSec * rate) : null),
    [clip, clipDurationSec, rate],
  );

  const win = useMemo(
    () => sourceWindow(sourceDuration, viewScrollSec, viewZoom, box.width),
    [sourceDuration, viewScrollSec, viewZoom, box.width],
  );

  // A clip newly opened is fitted to the drawer, once. Keyed on the clip and
  // the source it reads, NOT on the width, so resizing the dock never yanks the
  // zoom back out from under someone who has zoomed in.
  const fitKey = `${clipId ?? ''}:${sourceDuration}`;
  const fittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!clipId || box.width <= 0 || sourceDuration <= 0) return;
    if (fittedRef.current === fitKey) return;
    fittedRef.current = fitKey;
    setViewZoom(fitZoom(sourceDuration, box.width));
    setViewScrollSec(0);
  }, [clipId, fitKey, box.width, sourceDuration, setViewZoom, setViewScrollSec]);

  /** SOURCE seconds per fraction of the visible window. */
  const winSpan = Math.max(1e-6, win.endSec - win.startSec);
  /** Scroll slack: 0 when the whole source already fits. */
  const scrollMax = Math.max(0, sourceDuration - winSpan);

  /* ── writing to the clip ───────────────────────────────────────────────── */

  /** Fields for `updateClip`, with the undo burst already cut for a DISCRETE
   *  edit (a field commit, a button). Drags cut their own burst on pointer-down. */
  const writeDiscrete = useCallback(
    (updates: Partial<AudioClip>) => {
      if (!clip) return;
      beginUndoStep();
      updateClip(clip.id, updates);
    },
    [clip, updateClip],
  );

  /** Fields for `updateClip` from inside a gesture whose pointer-down already
   *  opened the step. */
  const writeDrag = useCallback(
    (updates: Partial<AudioClip>) => {
      if (!clip) return;
      updateClip(clip.id, updates);
    },
    [clip, updateClip],
  );

  /** Move the clip's head so it reads SOURCE second `sec`. */
  const applyTrimStartSource = useCallback(
    (sec: number, write: (u: Partial<AudioClip>) => void) => {
      if (!dragClip) return;
      const next = trimStartTo(dragClip, rate, dragClip.startSec + (sec - dragClip.offsetIntoSource) / rate);
      if (next) write(next);
    },
    [dragClip, rate],
  );

  /** Move the clip's tail so it stops reading at SOURCE second `sec`. */
  const applyTrimEndSource = useCallback(
    (sec: number, write: (u: Partial<AudioClip>) => void) => {
      if (!dragClip) return;
      write(trimEndTo(dragClip, rate, dragClip.startSec + (sec - dragClip.offsetIntoSource) / rate));
    },
    [dragClip, rate],
  );

  /* ── pointer gestures on the waveform ──────────────────────────────────── */

  type Grab = { kind: 'trim-start' | 'trim-end' | 'fade-in' | 'fade-out' | 'slip'; fromSec: number; offsetAtStart: number };
  const grabRef = useRef<Grab | null>(null);

  /** The SOURCE second under a pointer, from the wave box's own rect. */
  const sourceSecAtClientX = useCallback(
    (clientX: number): number => {
      const el = waveRef.current;
      if (!el) return win.startSec;
      const rect = el.getBoundingClientRect();
      return sourceSecAtWindowFrac(win, rect.width > 0 ? (clientX - rect.left) / rect.width : 0);
    },
    [win],
  );

  const beginGrab = (kind: Grab['kind']) => (e: React.PointerEvent) => {
    if (!clip || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // ONE undo step for the whole drag: this cuts the coalescing burst and
    // names the gesture, so every frame below folds into it.
    beginUndoStep(`clip:${clip.id}`);
    grabRef.current = { kind, fromSec: sourceSecAtClientX(e.clientX), offsetAtStart: clip.offsetIntoSource };
  };

  const onGrabMove = (e: React.PointerEvent) => {
    const grab = grabRef.current;
    if (!grab || !clip || !dragClip) return;
    const sec = sourceSecAtClientX(e.clientX);
    switch (grab.kind) {
      case 'trim-start':
        applyTrimStartSource(sec, writeDrag);
        break;
      case 'trim-end':
        applyTrimEndSource(sec, writeDrag);
        break;
      case 'fade-in':
        writeDrag(setFadeIn(fadeTargetOf(clip), (sec - readStart) / rate));
        break;
      case 'fade-out':
        writeDrag(setFadeOut(fadeTargetOf(clip), (readEnd - sec) / rate));
        break;
      case 'slip':
        // The SOURCE is what is drawn here and it stays still, so the bright
        // region follows the pointer: dragging it right makes the clip read
        // LATER audio. (The timeline's slip handle is the same edit with the
        // opposite metaphor — there the clip box is fixed and the audio slides
        // under it.)
        writeDrag(slipSourceTo(dragClip, rate, grab.offsetAtStart + (sec - grab.fromSec)));
        break;
    }
  };

  const endGrab = (e: React.PointerEvent) => {
    if (!grabRef.current) return;
    grabRef.current = null;
    // The capture belongs to the HANDLE, not to this box — a captured pointer
    // retargets its events to the capturing element, which then bubbles here.
    const captured = e.target;
    if (captured instanceof Element && captured.hasPointerCapture?.(e.pointerId)) {
      captured.releasePointerCapture(e.pointerId);
    }
  };

  /** Arrow keys on a handle. Shift nudges further; the write is discrete, so
   *  each press is its own undo step. */
  const nudge = (apply: (deltaSec: number) => void) => (e: React.KeyboardEvent) => {
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    e.stopPropagation();
    apply(dir * (e.shiftKey ? AUDIO_EDITOR_NUDGE_COARSE_SEC : AUDIO_EDITOR_NUDGE_SEC));
  };

  /* ── audition ──────────────────────────────────────────────────────────── */

  const [auditioning, setAuditioning] = useState(false);
  const playerTime = usePlayerStore((s) => s.currentTime);

  const stopAudition = useCallback(() => {
    setAuditioning(false);
    usePlayerStore.getState().pause();
  }, []);

  const startAudition = useCallback(() => {
    if (!clip) return;
    const player = usePlayerStore.getState();
    // Loading here is what guarantees ONE copy: playerStore drops the live
    // editor session and replaces whatever was in the transport.
    void player
      .load(clip.audioBlob, { label: `${clip.label} — clip` })
      .then(() => {
        player.seek(readStart);
        player.play();
        setAuditioning(true);
      })
      .catch((err) => {
        setAuditioning(false);
        logError('editor', `Audition failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, [clip, readStart]);

  // The region ends where the trim ends. `timeupdate` only fires a few times a
  // second, so the timer does the stopping and the time check is the backstop
  // for a transport that was scrubbed somewhere else meanwhile.
  useEffect(() => {
    if (!auditioning) return;
    if (playerTime >= readEnd - 0.005) {
      stopAudition();
      return;
    }
    const timer = window.setTimeout(stopAudition, Math.max(0, (readEnd - playerTime) * 1000));
    return () => window.clearTimeout(timer);
  }, [auditioning, playerTime, readEnd, stopAudition]);

  // An audition is bounded to a region, so it does not outlive the panel that
  // bounded it — or survive a switch to another clip. (Leaving it running would
  // leave nothing to stop it at the trim, and it would play out the whole file.)
  const auditioningRef = useRef(auditioning);
  useEffect(() => {
    auditioningRef.current = auditioning;
  }, [auditioning]);
  useEffect(() => {
    setAuditioning(false);
    return () => {
      if (auditioningRef.current) usePlayerStore.getState().pause();
    };
  }, [clipId]);

  /* ── empty states ──────────────────────────────────────────────────────── */

  if (!clipId) {
    return <div className={EMPTY}>No clip open — double-click an audio clip in the timeline.</div>;
  }
  if (!clip) {
    return (
      <div className={EMPTY}>
        <span>
          Clip no longer exists.
          <button
            type="button"
            onClick={() => useAudioEditorStore.getState().close()}
            className={`${BTN} ml-2`}
          >
            Close
          </button>
        </span>
      </div>
    );
  }

  /* ── derived readouts ──────────────────────────────────────────────────── */

  // `clipPeakGain` is the same sanitiser every scheduling path reads clip gain
  // through, so the fader can never show a level playback would not use.
  const gainDb = clampGainDb(gainToDb(clipPeakGain(clip)));
  // `?? 0` alone would let a NaN through — NaN is not nullish — and a NaN fade
  // reaches the geometry two lines below.
  const fadeInSec = Math.max(0, sane(clip.fadeInSec ?? 0));
  const fadeOutSec = Math.max(0, sane(clip.fadeOutSec ?? 0));
  const startPct = sourcePercentInWindow(win, readStart);
  const endPct = sourcePercentInWindow(win, readEnd);
  const fadeInPct = sourcePercentInWindow(win, readStart + fadeInSec * rate);
  const fadeOutPct = sourcePercentInWindow(win, readEnd - fadeOutSec * rate);
  const trimmed = readStart > 0 || readEnd < sourceDuration - 1e-6;

  const handleClass =
    'absolute top-0 bottom-0 w-2 -ml-1 z-30 cursor-ew-resize touch-none focus-visible:outline focus-visible:outline-purple-400';

  return (
    <div className="h-full flex flex-col min-h-0 font-sans text-xs et-ink select-none">
      {/* ── breadcrumb + actions ─────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-2 py-1 border-b border-white/5 bg-black/30">
        <nav aria-label="Clip being edited" className="flex items-center gap-1.5 min-w-0">
          <span className="truncate et-ink-2 font-display text-xs font-bold uppercase tracking-wider">
            {trackName}
          </span>
          <span aria-hidden="true" className="et-ink-2 opacity-50">
            ›
          </span>
          <span className="truncate font-display text-xs font-bold uppercase tracking-wider text-[rgb(var(--et-accent))]">
            {clip.label}
          </span>
          <span aria-hidden="true" className="et-ink-2 opacity-50">
            ›
          </span>
          <span className="truncate font-sans text-xs font-bold et-ink-2" title={sourceAsset ?? undefined}>
            {sourceAsset ?? 'Embedded audio'}
          </span>
        </nav>
        <div className="flex items-center gap-1 shrink-0">
          {/* The waveform colour mode lives up here: in the waveform's corner
              it sat over the trim-end and fade-out handles. */}
          <WaveformModeToggle variant="toolbar" />
          <button
            type="button"
            onClick={() => {
              setCenterTab('edit');
              setSelected(clip.id);
              setSelectedClipIds([clip.id]);
              setPlayhead(clip.startSec);
              // The timeline's own half of the reveal: it scrolls the lanes to
              // the clip and parks the EDIT CURSOR on its start. Dispatched on
              // the next frame because EDIT only mounts once `setCenterTab`
              // above has rendered, and the listener lives inside it. The four
              // store writes above are not conditional on that: if EDIT is
              // still loading its chunk and misses the event, the clip is
              // still selected and the playhead still moves — only the scroll
              // is lost, which is exactly today's behaviour.
              const clipId = clip.id;
              requestAnimationFrame(() => {
                window.dispatchEvent(
                  new CustomEvent<RevealClipDetail>(REVEAL_CLIP_EVENT, { detail: { clipId } }),
                );
              });
            }}
            className={BTN}
            title="Open EDIT, scroll to this clip, select it and park the playhead at its start"
          >
            <Crosshair aria-hidden="true" className="w-3 h-3" />
            Reveal in timeline
          </button>
          <button
            type="button"
            onClick={auditioning ? stopAudition : startAudition}
            className={`${BTN} ${auditioning ? BTN_ON : ''}`}
            aria-pressed={auditioning}
            title={auditioning ? 'Stop the audition' : 'Play just this clip’s trimmed region through the transport'}
          >
            {auditioning ? (
              <Square aria-hidden="true" className="w-3 h-3" />
            ) : (
              <Play aria-hidden="true" className="w-3 h-3" />
            )}
            {auditioning ? 'Stop' : 'Audition'}
          </button>
        </div>
      </div>

      {/* ── the source, with the clip's window over it ───────────────────── */}
      <div className="grow min-h-0 relative px-2 pt-2">
        <div
          ref={waveRef}
          className="relative h-full min-h-18 rounded border border-white/10 bg-black/50 overflow-hidden"
          onPointerMove={onGrabMove}
          onPointerUp={endGrab}
          onPointerCancel={endGrab}
        >
          {audioUrl && box.width > 0 && (
            <SemanticWave
              audioUrl={audioUrl}
              height={box.height}
              viewportStart={win.startFrac}
              viewportEnd={Math.max(win.startFrac + 1e-4, win.endFrac)}
              transparentBg
              showModeToggle={false}
            />
          )}

          {/* Everything the clip trims away, dimmed but still legible — the
              audio you are about to cut off is the audio you need to see. */}
          <div
            aria-hidden="true"
            className="absolute inset-y-0 left-0 z-10 bg-black/65 pointer-events-none"
            style={{ width: `${startPct}%` }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-y-0 right-0 z-10 bg-black/65 pointer-events-none"
            style={{ width: `${100 - endPct}%` }}
          />

          {/* The region the clip plays. Dragging it slips the audio. */}
          <div
            role="slider"
            aria-label="Slip the audio under the clip, in source seconds"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, sourceDuration - (readEnd - readStart))}
            aria-valuenow={Number(readStart.toFixed(3))}
            aria-valuetext={`Reads from ${secs(readStart)} seconds into the source`}
            tabIndex={0}
            className="absolute inset-y-0 z-20 cursor-grab touch-none border-x-2 border-[rgb(var(--et-accent)/0.9)] focus-visible:outline focus-visible:outline-purple-400"
            style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
            onPointerDown={beginGrab('slip')}
            onKeyDown={nudge((d) => writeDiscrete(slipSourceTo(dragClip, rate, readStart + d)))}
          >
            {/* Fade ramps, drawn where they sound. */}
            {fadeInSec > 0 && (
              <div
                aria-hidden="true"
                className="absolute inset-y-0 left-0 pointer-events-none bg-linear-to-r from-black/70 to-transparent"
                style={{ width: `${((fadeInPct - startPct) / Math.max(1e-6, endPct - startPct)) * 100}%` }}
              />
            )}
            {fadeOutSec > 0 && (
              <div
                aria-hidden="true"
                className="absolute inset-y-0 right-0 pointer-events-none bg-linear-to-l from-black/70 to-transparent"
                style={{ width: `${((endPct - fadeOutPct) / Math.max(1e-6, endPct - startPct)) * 100}%` }}
              />
            )}
          </div>

          {/* Trim handles. */}
          <div
            role="slider"
            aria-label="Trim the clip’s start, in source seconds"
            aria-valuemin={0}
            aria-valuemax={Number(sourceDuration.toFixed(3))}
            aria-valuenow={Number(readStart.toFixed(3))}
            aria-valuetext={`${secs(readStart)} seconds into the source`}
            tabIndex={0}
            className={`${handleClass} bg-[rgb(var(--et-accent)/0.9)]`}
            style={{ left: `${startPct}%` }}
            onPointerDown={beginGrab('trim-start')}
            onKeyDown={nudge((d) => applyTrimStartSource(readStart + d, writeDiscrete))}
          />
          <div
            role="slider"
            aria-label="Trim the clip’s end, in source seconds"
            aria-valuemin={0}
            aria-valuemax={Number(sourceDuration.toFixed(3))}
            aria-valuenow={Number(readEnd.toFixed(3))}
            aria-valuetext={`${secs(readEnd)} seconds into the source`}
            tabIndex={0}
            className={`${handleClass} bg-[rgb(var(--et-accent)/0.9)]`}
            style={{ left: `${endPct}%` }}
            onPointerDown={beginGrab('trim-end')}
            onKeyDown={nudge((d) => applyTrimEndSource(readEnd + d, writeDiscrete))}
          />

          {/* Fade handles, on the ramp ends rather than the clip ends. */}
          <div
            role="slider"
            aria-label="Fade in length, in clip seconds"
            aria-valuemin={0}
            aria-valuemax={Number(clipDurationSec.toFixed(3))}
            aria-valuenow={Number(fadeInSec.toFixed(3))}
            aria-valuetext={`${secs(fadeInSec)} second fade in`}
            tabIndex={0}
            className={`${handleClass} bg-amber-300/80`}
            style={{ left: `${fadeInPct}%` }}
            onPointerDown={beginGrab('fade-in')}
            onKeyDown={nudge((d) => writeDiscrete(setFadeIn(fadeTargetOf(clip), fadeInSec + d)))}
          />
          <div
            role="slider"
            aria-label="Fade out length, in clip seconds"
            aria-valuemin={0}
            aria-valuemax={Number(clipDurationSec.toFixed(3))}
            aria-valuenow={Number(fadeOutSec.toFixed(3))}
            aria-valuetext={`${secs(fadeOutSec)} second fade out`}
            tabIndex={0}
            className={`${handleClass} bg-amber-300/80`}
            style={{ left: `${fadeOutPct}%` }}
            onPointerDown={beginGrab('fade-out')}
            onKeyDown={nudge((d) => writeDiscrete(setFadeOut(fadeTargetOf(clip), fadeOutSec - d)))}
          />
        </div>
      </div>

      {/* ── view controls ────────────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-2 px-2 pt-1.5">
        <div role="group" aria-label="Waveform zoom" className="flex items-center gap-1 shrink-0">
          <button type="button" className={BTN} onClick={() => setViewZoom(viewZoom / ZOOM_STEP)} aria-label="Zoom out">
            <ZoomOut aria-hidden="true" className="w-3 h-3" />
          </button>
          <button type="button" className={BTN} onClick={() => setViewZoom(viewZoom * ZOOM_STEP)} aria-label="Zoom in">
            <ZoomIn aria-hidden="true" className="w-3 h-3" />
          </button>
          <button
            type="button"
            className={BTN}
            onClick={() => {
              setViewZoom(fitZoom(sourceDuration, box.width));
              setViewScrollSec(0);
            }}
          >
            Fit source
          </button>
        </div>
        <label htmlFor={`${ids}-scroll`} className={`${LABEL} shrink-0`}>
          Scroll <span className={DOMAIN}>source</span>
        </label>
        <input
          id={`${ids}-scroll`}
          name={`${ids}-scroll`}
          type="range"
          min={0}
          max={Math.max(0.001, scrollMax)}
          step={0.001}
          value={Math.min(viewScrollSec, scrollMax)}
          disabled={scrollMax <= 0}
          aria-valuetext={`${secs(win.startSec)} to ${secs(win.endSec)} seconds`}
          onChange={(e) => setViewScrollSec(Number(e.target.value))}
          className="grow min-w-0 accent-[rgb(var(--et-accent))] disabled:opacity-30"
        />
        <span className="shrink-0 text-xs font-semibold et-ink-2 tabular-nums">
          {secs(win.startSec, 2)}–{secs(win.endSec, 2)} / {secs(sourceDuration, 2)} s
        </span>
      </div>

      {/* ── clip fields ──────────────────────────────────────────────────── */}
      <div className="shrink-0 flex flex-wrap items-end gap-3 px-2 py-2 border-t border-white/5 mt-1.5">
        <NumField
          id={`${ids}-start`}
          label="Start"
          domain="timeline"
          value={clip.startSec}
          onCommit={(v) => writeDiscrete({ startSec: Math.max(0, v) })}
        />
        <NumField
          id={`${ids}-end`}
          label="End"
          domain="timeline"
          value={sane(clip.startSec) + clipDurationSec}
          onCommit={(v) => applyTrimEndSource(readStart + (v - clip.startSec) * rate, writeDiscrete)}
        />
        <NumField
          id={`${ids}-length`}
          label="Length"
          domain="clip"
          value={clipDurationSec}
          onCommit={(v) => applyTrimEndSource(readStart + v * rate, writeDiscrete)}
        />
        <NumField
          id={`${ids}-offset`}
          label="Read from"
          domain="source"
          value={readStart}
          onCommit={(v) => writeDiscrete(slipSourceTo(dragClip, rate, v))}
        />
        <NumField
          id={`${ids}-fade-in`}
          label="Fade in"
          domain="clip"
          value={fadeInSec}
          onCommit={(v) => writeDiscrete(setFadeIn(fadeTargetOf(clip), v))}
        />
        <NumField
          id={`${ids}-fade-out`}
          label="Fade out"
          domain="clip"
          value={fadeOutSec}
          onCommit={(v) => writeDiscrete(setFadeOut(fadeTargetOf(clip), v))}
        />

        {/* Clip gain sits before the track fader and the insert rack, so it is
            gain staging rather than a second volume. */}
        <div className="flex flex-col gap-0.5 grow min-w-40">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${ids}-gain`} className={LABEL}>
              Clip gain
            </label>
            <output htmlFor={`${ids}-gain`} className="text-xs font-semibold et-ink-2 tabular-nums">
              {gainDb.toFixed(1)} dB
            </output>
          </div>
          <input
            id={`${ids}-gain`}
            name={`${ids}-gain`}
            type="range"
            min={CLIP_GAIN_DB_MIN}
            max={CLIP_GAIN_DB_MAX}
            step={0.1}
            value={gainDb}
            aria-valuetext={`${gainDb.toFixed(1)} decibels`}
            onChange={(e) => writeDrag({ gain: dbToGain(Number(e.target.value)) })}
            // A fader ride is ONE undo step: cut the burst once, before the
            // ride starts. Focus covers the keyboard ride (arrow keys never
            // fire a pointer event); pointer-down covers a second mouse ride
            // on a slider that already had focus.
            onFocus={() => beginUndoStep(`clip:${clip.id}`)}
            onPointerDown={() => beginUndoStep(`clip:${clip.id}`)}
            className="w-full accent-[rgb(var(--et-accent))]"
          />
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <input
            id={`${ids}-mute`}
            name={`${ids}-mute`}
            type="checkbox"
            checked={clip.muted === true}
            onChange={(e) => writeDiscrete({ muted: e.target.checked })}
            className="accent-[rgb(var(--et-accent))]"
          />
          <label htmlFor={`${ids}-mute`} className={`${LABEL} inline-flex items-center gap-1`}>
            <VolumeX aria-hidden="true" className="w-3 h-3" />
            Mute
          </label>
        </div>

        <button
          type="button"
          className={BTN}
          disabled={!trimmed}
          onClick={() => writeDiscrete(resetTrims(dragClip, rate))}
          title="Play the whole source again, from the same place on the timeline"
        >
          <RotateCcw aria-hidden="true" className="w-3 h-3" />
          Reset trims
        </button>
      </div>
    </div>
  );
};
