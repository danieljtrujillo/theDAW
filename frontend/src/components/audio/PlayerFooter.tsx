import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, Download, Share2, Heart, Repeat, VolumeX, Maximize2, MoreHorizontal, Cast, Check, Activity, ChevronUp } from 'lucide-react';
import { useGenerateStore } from '../../state/generateStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { usePlayerStore } from '../../state/playerStore';
import { useLibraryStore } from '../../state/libraryStore';
import { useAppUiStore } from '../../state/appUiStore';
import { useEffectChainStore } from '../../state/effectChainStore';
import {
  bypassLiveRack, liveRackEntries, rackEntryLabel,
  useMixLiveRackStore, LEVEL_TAKING_RACK_IDS,
} from '../../state/mixLiveRack';
import { callEditorPlay, isEditorPlaybackRegistered } from '../../state/editorPlaybackBridge';
import { SlideTrack } from './SlideTrack';
import { OrbTipBubble } from './OrbTipBubble';
import {
  toggleVjPlayback,
  subscribeToVjPlaybackState,
  type VjPlaybackState,
} from '../../state/vjPlaybackBus';
import { useVjSetStatusStore } from '../../state/vjSetStatusStore';
import {
  toggleDjMaster,
  subscribeDjMasterState,
  type DjMasterState,
} from '../../state/djMasterBus';
import { useEditThemeStore } from '../../state/editThemeStore';
import { resolveEditThemeVars } from '../../lib/editThemes';
import { LogActionButton } from '../layout/ProcessingLog';

const formatDuration = (sec: number | null | undefined): string => {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '--:--';
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** Arrow keys move the playhead by this much; Shift multiplies it by six. */
const SEEK_STEP_SEC = 5;

/**
 * The scrub strip: the footer's whole top edge, 16px tall, with the elapsed
 * and total times at its ends. It used to be a 3px line under the transport
 * buttons with a handle that only appeared on hover, which made the playhead
 * the hardest thing in the footer to reach. Now the hit area is the strip, the
 * handle is always there once a track is loaded, a hover shows the time under
 * the pointer, dragging scrubs, and the keyboard seeks.
 *
 * Isolated so the per-frame `currentTime` tick re-renders ONLY this strip —
 * the footer shell (side sections, transport, action button) must not pay
 * that cost.
 */
const ScrubStrip: React.FC = () => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef(false);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const engineDuration = usePlayerStore((s) => s.duration);
  const hasTrack = usePlayerStore((s) => s.hasTrack);
  const seekByFraction = usePlayerStore((s) => s.seekByFraction);
  const lastDurationSec = useGenerateStore((s) => s.lastDurationSec);
  // Fraction under the pointer while dragging; the strip follows it instead of
  // the engine so the handle never lags the hand.
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const duration = engineDuration > 0 ? engineDuration : (lastDurationSec ?? 0);
  const canSeek = hasTrack && duration > 0;
  const frac = drag ?? (duration > 0 ? clamp01(currentTime / duration) : 0);
  const shown = drag ?? hover;

  const fracAt = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return frac;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? clamp01((clientX - r.left) / r.width) : frac;
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canSeek) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    // Focus before preventDefault, or the widget never becomes activeElement
    // and the keyboard seek below is unreachable by mouse (same trap SlideTrack
    // documents).
    el.focus({ preventScroll: true });
    dragRef.current = true;
    const f = fracAt(e.clientX);
    setDrag(f);
    seekByFraction(f);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = fracAt(e.clientX);
    if (dragRef.current) {
      setDrag(f);
      seekByFraction(f);
    } else {
      setHover(canSeek ? f : null);
    }
  };
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      dragRef.current = false;
      seekByFraction(fracAt(e.clientX));
      setDrag(null);
    }
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canSeek) return;
    const step = (SEEK_STEP_SEC * (e.shiftKey ? 6 : 1)) / duration;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': seekByFraction(clamp01(frac + step)); break;
      case 'ArrowLeft': case 'ArrowDown': seekByFraction(clamp01(frac - step)); break;
      case 'Home': seekByFraction(0); break;
      case 'End': seekByFraction(1); break;
      default: handled = false;
    }
    // stopPropagation too: the window-level editor shortcuts share these keys.
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };

  return (
    <div className="flex items-center gap-2.5 pl-36 pr-6 h-4 shrink-0">
      <span className="w-9 shrink-0 text-right text-[10px] font-mono tabular-nums text-zinc-400">
        {formatDuration(drag !== null ? drag * duration : currentTime)}
      </span>
      <div
        ref={trackRef}
        role="slider"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(frac * duration)}
        aria-valuetext={`${formatDuration(frac * duration)} of ${formatDuration(duration)}`}
        aria-disabled={!canSeek}
        tabIndex={canSeek ? 0 : -1}
        className={`group/scrub relative flex-1 h-4 select-none outline-none ${canSeek ? 'cursor-pointer' : 'cursor-default'}`}
        style={{ touchAction: 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        {/* The rail: thin at rest, thicker under the pointer or keyboard focus. */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 rounded-full bg-white/12 transition-[height] group-hover/scrub:h-1 group-focus-visible/scrub:h-1">
          {hover !== null && drag === null && (
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/10" style={{ width: `${hover * 100}%` }} />
          )}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-linear-to-r from-purple-600 to-purple-400"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
        <div
          className={`absolute top-1/2 w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_8px_rgba(168,85,247,0.8)] transition-[opacity,transform] ${
            canSeek ? 'opacity-100' : 'opacity-0'
          } ${drag !== null ? 'scale-125' : 'group-hover/scrub:scale-125 group-focus-visible/scrub:scale-125'}`}
          style={{ left: `${frac * 100}%` }}
        />
        {canSeek && shown !== null && (
          <span
            className="absolute bottom-full mb-1.5 -translate-x-1/2 whitespace-nowrap rounded border border-purple-500/30 bg-[#0a080f] px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-purple-200 pointer-events-none"
            style={{ left: `${shown * 100}%` }}
          >
            {formatDuration(shown * duration)}
          </span>
        )}
      </div>
      <span className="w-9 shrink-0 text-[10px] font-mono tabular-nums text-zinc-400">
        {formatDuration(duration)}
      </span>
    </div>
  );
};

/**
 * MASTER FX — the one thing outside MIX that admits the master is not clean.
 *
 * MIX's psychoacoustic rack lives on the GLOBAL master insert (master → rack
 * insert → live-FX insert → analyser → monitor) and stays there for the session
 * once MIX has been opened, so a chain left enabled in an earlier session shapes
 * — and, with the HRTF spatializer or a gate in it, quietly attenuates —
 * everything the transport plays, in every tab, with nothing on screen to
 * account for the missing level. That is what this pill accounts for. It renders
 * NOTHING while the insert is clean, so it never becomes permanent chrome: the
 * badge opens MIX, the caret lists what is actually on the insert, and Bypass
 * all returns the master to a clean passthrough from wherever the user is
 * standing. It sits next to the volume control because that is the symptom.
 */
const MasterFxIndicator: React.FC = () => {
  const attached = useMixLiveRackStore((s) => s.attached);
  const chain = useEffectChainStore((s) => s.chain);
  const setCenterTab = useAppUiStore((s) => s.setCenterTab);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const entries = React.useMemo(() => liveRackEntries(chain, attached), [chain, attached]);
  const count = entries.length;

  // Emptying the rack unmounts the whole pill, but the chain can also be emptied
  // from MIX while this is open — either way the panel must not outlive it.
  useEffect(() => { if (count === 0) setOpen(false); }, [count]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (count === 0) return null;
  const takers = entries.filter((e) => LEVEL_TAKING_RACK_IDS.has(e.effect)).length;
  const plural = count === 1 ? '' : 's';
  const openMix = () => { setOpen(false); setCenterTab('mix'); };

  return (
    <div ref={wrapRef} className="relative flex items-center shrink-0">
      <button
        type="button"
        onClick={openMix}
        aria-label={`${count} master effect${plural} live on the output — open MIX`}
        title={`${count} effect${plural} on the master insert${takers > 0 ? ', some of which take level' : ''}. Open MIX.`}
        className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-l border border-r-0 border-purple-500/40 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20 hover:border-purple-400/70 transition-colors shadow-[0_0_12px_rgba(168,85,247,0.18)]"
      >
        <Activity className="w-3 h-3" />
        <span className="text-[9px] font-black uppercase tracking-widest">Master FX</span>
        <span className="text-[9px] font-mono text-purple-300">{count}</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Hide what is on the master insert' : 'Show what is on the master insert'}
        aria-expanded={open}
        aria-controls="master-fx-detail"
        className="px-1 py-1 rounded-r border border-purple-500/40 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 hover:border-purple-400/70 transition-colors"
      >
        <ChevronUp className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          id="master-fx-detail"
          className="absolute bottom-full right-0 mb-2 w-64 flex flex-col gap-2 p-2.5 rounded-lg border border-purple-500/30 bg-[#0a080f] shadow-[0_0_24px_rgba(168,85,247,0.2)]"
        >
          <span className="text-[9px] font-black uppercase tracking-widest text-purple-300">On the master insert</span>
          <p className="text-[10px] leading-snug text-zinc-400">
            These sit between the mix bus and the meter, so they shape everything the
            transport plays — in every tab, until they are switched off.
          </p>
          <ul className="flex flex-col gap-1">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-zinc-200 truncate">{rackEntryLabel(e)}</span>
                {LEVEL_TAKING_RACK_IDS.has(e.effect) && (
                  <span className="shrink-0 text-[8px] font-mono uppercase tracking-widest text-amber-300">takes level</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openMix}
              className="flex-1 px-2 py-1 rounded border border-white/10 text-[9px] font-black uppercase tracking-widest text-zinc-300 hover:border-purple-400/60 hover:text-purple-200 transition-colors"
            >
              Show in MIX
            </button>
            <button
              type="button"
              onClick={bypassLiveRack}
              className="flex-1 px-2 py-1 rounded border border-purple-500/40 bg-purple-500/10 text-[9px] font-black uppercase tracking-widest text-purple-200 hover:bg-purple-500/20 hover:border-purple-400/70 transition-colors"
            >
              Bypass all
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

/** A quiet icon button in the footer's secondary row. */
const iconButton = 'p-1.5 rounded-md text-zinc-500 hover:text-white hover:bg-white/5 transition-colors disabled:opacity-30 disabled:pointer-events-none';

export const PlayerFooter: React.FC = () => {
  const [isLiked, setIsLiked] = useState(false);

  // The footer sits OUTSIDE Shell (to escape the layout zoom), so it must
  // carry its own edit-theme scope for the theme's utility-class remaps to
  // reach it — that's what makes the action button "derivative of the theme".
  const editThemeId = useEditThemeStore((s) => s.themeId);
  const editThemeImage = useEditThemeStore((s) => s.customImage);
  const editTheme = React.useMemo(
    () => resolveEditThemeVars(editThemeId, editThemeImage),
    [editThemeId, editThemeImage],
  );

  // The footer's G-Search field was replaced by the orb's speech bubble, so
  // Ctrl/Cmd-K no longer has an inline input to focus. It now opens the library
  // rail, which carries its own search — the shortcut still lands the user in
  // front of a search box rather than doing nothing.
  const setRightPanelOpen = useAppUiStore((s) => s.setRightPanelOpen);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setRightPanelOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setRightPanelOpen]);

  // Volume / mute live in playbackStore; they drive the engine's master gain.
  const volume = usePlaybackStore((s) => s.volume);
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const isMuted = usePlaybackStore((s) => s.muted);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);

  // Engine state — deliberately NO `currentTime` subscription here: the
  // per-frame tick lives in ScrubStrip so the footer shell doesn't re-render
  // 60×/s.
  const engineLabel = usePlayerStore((s) => s.currentLabel);
  const engineDuration = usePlayerStore((s) => s.duration);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isLooping = usePlayerStore((s) => s.isLooping);
  const hasTrack = usePlayerStore((s) => s.hasTrack);
  const toggle = usePlayerStore((s) => s.toggle);
  const seekByFraction = usePlayerStore((s) => s.seekByFraction);
  const toggleLoop = usePlayerStore((s) => s.toggleLoop);
  const setMasterGain = usePlayerStore((s) => s.setMasterGain);
  const load = usePlayerStore((s) => s.load);
  const currentEntryId = usePlayerStore((s) => s.currentEntryId);
  const libraryEntries = useLibraryStore((s) => s.entries);

  // Last-generation metadata (used when nothing's been explicitly loaded yet).
  const lastFilename = useGenerateStore((s) => s.lastFilename);
  const lastDurationSec = useGenerateStore((s) => s.lastDurationSec);
  const lastModelName = useGenerateStore((s) => s.lastModelName);

  // Editor mode — when the EDIT tab is active and editor bridge is registered,
  // the first play click triggers an offline render into playerStore.
  // After that, all transport (seek, skip, loop, volume) works natively.
  // Keyed on centerTab (the state the tab bar actually writes) — the legacy
  // activeView stayed 'create' when the user clicked EDIT, so footer PLAY
  // never took the editor render path.
  const centerTab = useAppUiStore((s) => s.centerTab);
  const inEditorMode = centerTab === 'edit' && isEditorPlaybackRegistered();

  // Volume → master gain (continuous).
  useEffect(() => {
    setMasterGain(isMuted ? 0 : volume / 100);
  }, [volume, isMuted, setMasterGain]);

  // Auto-load: when a new generation lands and nothing is currently loaded, load it.
  useEffect(() => {
    if (hasTrack) return;
    const entries = useLibraryStore.getState().entries;
    if (entries.length === 0) return;
    const newest = entries.reduce((acc, e) => (e.timestamp.localeCompare(acc.timestamp) > 0 ? e : acc), entries[0]);
    if (newest) {
      void (async () => {
        const blob = await useLibraryStore.getState().fetchAudioBlob(newest);
        await load(blob, { label: newest.title, entryId: newest.id });
      })();
    }
  }, [hasTrack, lastFilename, load]);

  // VJ playback state — when the user is on the VJ tab, the play
  // button controls the VJ iframe's video element instead of (or in
  // addition to) the SA3 player engine. The vjPlaybackBus signals
  // whether a handler is registered (VJ tab mounted) and the latest
  // playing/paused echo from the iframe.
  const [vjState, setVjState] = useState<VjPlaybackState>('unknown');
  useEffect(() => subscribeToVjPlaybackState(setVjState), []);
  // On the DJ and VJ tabs the footer's central PLAY is the MASTER / live
  // transport (drives the VJ performance via the playback bus), so there's one
  // obvious master control instead of a separate "Play Live" button. VJ tab
  // lives in centerTab (not the legacy activeView enum). Don't gate on handler
  // registration: while the iframe boots, the footer should still present the
  // live transport rather than a disabled audio-only state.
  const isVjMode = centerTab === 'vj' || centerTab === 'dj';
  const isDjMode = centerTab === 'dj';
  const vjSetCount = useVjSetStatusStore((s) => s.count);
  const vjSetAcked = useVjSetStatusStore((s) => s.acked);
  const vjSetName = useVjSetStatusStore((s) => s.name);

  // DJ master transport — the footer ▶ drives the DJ decks/set (not the global
  // single-track player) while on the DJ tab.
  const [djMaster, setDjMaster] = useState<DjMasterState>('paused');
  useEffect(() => subscribeDjMasterState(setDjMaster), []);

  const displayLabel = engineLabel ?? lastFilename
    ?? (centerTab === 'vj' ? 'VJ · live visuals' : centerTab === 'dj' ? 'DJ · live master' : null);
  const displayDuration = engineDuration > 0 ? engineDuration : (lastDurationSec ?? 0);
  // The transport icon reflects whatever is ACTUALLY producing output, on any
  // surface: the global engine (library / make / edit — `isPlaying` also covers
  // editor playback, which loads into the engine), the DJ master on the DJ tab,
  // or the VJ video on the VJ tab. So pressing play on a library row (or
  // anywhere) flips the footer to pause even while the live tabs are open.
  const displayIsPlaying =
    isPlaying ||
    (isDjMode && djMaster === 'playing') ||
    (centerTab === 'vj' && vjState === 'playing');

  const handleToggle = () => {
    // DJ-tab mode: the footer ▶ is the Live Master — play/pause the DJ decks
    // (or start the active set from the top) and start the VJ visuals with it.
    // It does NOT drive the global single-track player (that was the confusing
    // "second playhead").
    if (isDjMode) {
      toggleDjMaster();
      toggleVjPlayback();
      return;
    }
    // VJ-tab mode: drive the VJ iframe's video element via the bus.
    // Also toggle the SA3 player if a track is loaded so loaded
    // audio + visuals start together. When there's no SA3 track,
    // the VJ-only path runs alone.
    if (isVjMode) {
      toggleVjPlayback();
      if (hasTrack) toggle();
      return;
    }
    // In editor mode, if editor audio isn't loaded yet, trigger the offline render+play.
    // Once loaded (entryId === 'editor-timeline'), toggle works natively.
    if (inEditorMode && currentEntryId !== 'editor-timeline') {
      callEditorPlay();
    } else {
      toggle();
    }
  };

  const handleDownload = () => {
    const entries = useLibraryStore.getState().entries;
    const target = entries.find((e) => e.id === currentEntryId) ?? entries[0];
    if (!target) return;
    const url = useLibraryStore.getState().getAudioUrl(target);
    const a = document.createElement('a');
    a.href = url;
    a.download = target.title;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // "Up next" — no formal play queue yet, so derive the next track from the
  // library in newest-first order (wraps at the end). Clicking it loads it.
  const nextEntry = React.useMemo(() => {
    if (libraryEntries.length === 0) return null;
    const sorted = [...libraryEntries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (!currentEntryId) return sorted[0] ?? null;
    const idx = sorted.findIndex((e) => e.id === currentEntryId);
    if (idx < 0) return sorted[0] ?? null;
    return sorted[(idx + 1) % sorted.length] ?? null;
  }, [libraryEntries, currentEntryId]);

  const loadNext = () => {
    if (!nextEntry) return;
    void (async () => {
      const blob = await useLibraryStore.getState().fetchAudioBlob(nextEntry);
      await load(blob, { label: nextEntry.title, entryId: nextEntry.id });
    })();
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
  };

  return (
    <footer
      className="edit-theme-scope fixed bottom-0 left-0 right-0 h-16 bg-[#0a080f]/95 backdrop-blur-xl border-t border-white/5 z-50 flex flex-col group"
      data-et-light={editTheme.light ? '1' : undefined}
      style={editTheme.vars as React.CSSProperties}
    >
      {/* Row 1: the scrub strip along the footer's top edge, full width from
          the orb's clearance to the right padding. Its height is FOOTER_H
          (lib/layoutScale.ts) minus the 48px row below; change both together. */}
      <ScrubStrip />

      {/* Row 2: now playing · transport · up next + utilities. One row, so
          nothing stacks inside 48px any more. */}
      <div className="flex-1 min-h-0 flex items-center gap-4 px-6 pb-0.5">
        {/* 1. Orb speech bubble + Now Playing. flex-1 (mirrors section 3) so the
            now-playing readout fills the space between the bubble and the centred
            transport, and the PLAY button still lands on the true viewport centre.
            The orb sticks to the bottom-left corner and overlaps the footer, so
            pad left past it: 16px margin + the 112px orb = 128, plus clearance. */}
        <div className="flex items-center gap-3 flex-1 min-w-0 pl-36">
          {/* The orb's speech bubble, in the slot G-Search used to hold. */}
          <OrbTipBubble className="hidden xl:block" />
          <div className="flex flex-col min-w-0 flex-1 gap-0.5">
            <h4 className="text-[13px] font-bold text-zinc-100 truncate tracking-tight leading-tight">
              {displayLabel ?? 'No output loaded'}
            </h4>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-purple-400 font-mono uppercase tracking-widest border border-purple-500/20 px-1 rounded bg-purple-500/5">
                {lastModelName ? lastModelName.toUpperCase() : (displayLabel ? 'LIBRARY' : 'IDLE')}
              </span>
              <span className="text-[10px] text-zinc-500 font-mono">
                {displayDuration > 0 ? `${formatDuration(displayDuration)} // 48kHz` : '--:-- // 48kHz'}
              </span>
              {isVjMode && vjSetCount > 0 && (
                <span
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-mono uppercase tracking-widest shrink-0 ${
                    vjSetAcked
                      ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-300'
                      : 'border-amber-500/40 bg-amber-500/5 text-amber-300'
                  }`}
                  title={
                    vjSetAcked
                      ? `VJ set "${vjSetName ?? ''}" loaded — ${vjSetCount} item${vjSetCount === 1 ? '' : 's'}`
                      : `Sending set "${vjSetName ?? ''}" to the VJ…`
                  }
                >
                  {vjSetAcked ? <Check className="w-3 h-3" /> : <Cast className="w-3 h-3" />}
                  VJ {vjSetCount}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-0.5 ml-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={() => setIsLiked(!isLiked)}
              aria-label={isLiked ? 'Unlike' : 'Like'}
              aria-pressed={isLiked}
              className={`${iconButton} ${isLiked ? 'text-pink-500 hover:text-pink-400' : ''}`}
            >
              <Heart className={`w-3.5 h-3.5 ${isLiked ? 'fill-current' : ''}`} />
            </button>
            <button type="button" aria-label="Share" className={iconButton}>
              <Share2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 2. Transport — one row of controls, centred between the two flex-1
            side sections so PLAY stays on the viewport centre. The playhead is
            in the strip above, so this cluster no longer stacks. */}
        <div data-tour="transport" className="shrink-0 flex items-center gap-4">
          <button
            type="button"
            onClick={toggleLoop}
            aria-label={isLooping ? 'Looping on' : 'Looping off'}
            aria-pressed={isLooping}
            title={isLooping ? 'Looping on' : 'Looping off'}
            className={`${iconButton} ${isLooping ? 'text-purple-400 hover:text-purple-300' : ''}`}
          >
            <Repeat className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => seekByFraction(0)}
            disabled={!inEditorMode && !hasTrack}
            aria-label="Jump to start"
            title="Jump to start"
            className={iconButton}
          >
            <SkipBack className="w-4 h-4 fill-current" />
          </button>
          <button
            type="button"
            onClick={handleToggle}
            disabled={!isVjMode && !inEditorMode && !hasTrack}
            aria-label={displayIsPlaying ? 'Pause' : 'Play'}
            title={displayIsPlaying ? 'Pause' : 'Play'}
            className={`w-7.5 h-7.5 rounded-full flex items-center justify-center text-white bg-linear-to-br from-purple-400 to-purple-700 ring-1 ring-white/15 transition-all hover:scale-105 hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:pointer-events-none ${
              displayIsPlaying
                ? 'shadow-[0_0_18px_rgba(168,85,247,0.6)]'
                : 'shadow-[0_0_10px_rgba(168,85,247,0.25)]'
            }`}
          >
            {displayIsPlaying
              ? <Pause className="w-3.5 h-3.5 fill-current" />
              : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
          </button>
          <button
            type="button"
            onClick={() => seekByFraction(1)}
            disabled={!hasTrack}
            aria-label="Jump to end"
            title="Jump to end"
            className={iconButton}
          >
            <SkipForward className="w-4 h-4 fill-current" />
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label="Toggle fullscreen"
            title="Toggle fullscreen"
            className={iconButton}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 3. Up Next (mirrors Now Playing) + Utilities. flex-1 (mirrors section 1)
            so the up-next readout fills the space between the transport and the
            utilities, right-aligned. */}
        <div className="flex items-center gap-4 flex-1 min-w-0 justify-end">
          {/* Up Next — mirror of the Now Playing block, right-aligned. Click loads
              the next track (no formal queue yet, so it's the next library entry).
              Hidden on narrow windows so the transport and action button keep room. */}
          <button
            type="button"
            onClick={loadNext}
            disabled={!nextEntry}
            title={nextEntry ? `Play next: ${nextEntry.title}` : 'Nothing queued'}
            className="group/next hidden lg:flex flex-col min-w-0 flex-1 items-end text-right gap-0.5 disabled:cursor-default"
          >
            <h4 className="text-[13px] font-bold text-zinc-300 group-hover/next:text-white transition-colors truncate tracking-tight leading-tight w-full">
              {nextEntry?.title ?? 'Nothing queued'}
            </h4>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 font-mono">
                {nextEntry ? formatDuration(nextEntry.duration) : '--:--'}
              </span>
              <span className="text-[9px] text-emerald-400 font-mono uppercase tracking-widest border border-emerald-500/20 px-1 rounded bg-emerald-500/5">
                Up Next
              </span>
            </div>
          </button>
          <div className="flex items-center gap-4 shrink-0">
            <MasterFxIndicator />
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={isMuted ? 'Unmute' : 'Mute'}
                aria-pressed={isMuted}
                title={isMuted ? 'Unmute' : 'Mute'}
                className={iconButton}
              >
                {isMuted || volume === 0 ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <SlideTrack min={0} max={100} step={1} value={volume}
                onChange={(v) => setVolume(v)} className="w-24" ariaLabel="Volume" />
            </div>

            <div className="h-6 w-px bg-white/5" />

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleDownload}
                disabled={!hasTrack}
                aria-label="Download current track"
                title="Download current track"
                className={iconButton}
              >
                <Download className="w-4 h-4" />
              </button>
              <button type="button" aria-label="More options" title="More options" className={iconButton}>
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </div>

            <div className="h-6 w-px bg-white/5" />

            {/* The workspace action button (CREATE / PROCESS / TRAIN / …) — lives
                at the footer's bottom-right on EVERY tab. Rounded 2×1, sized to
                sit inside the 48px row. */}
            <div data-tour="action-button" className="shrink-0 w-20 h-10">
              <LogActionButton />
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};
