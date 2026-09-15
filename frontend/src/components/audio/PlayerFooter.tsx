import React, { useEffect, useRef, useState } from 'react';
import { Volume2, Download, Share2, Heart, Repeat, Repeat1, Shuffle, VolumeX, Cast, Check, Activity, ChevronUp, Headphones, Speaker } from 'lucide-react';
import { useGenerateStore } from '../../state/generateStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { usePlayerStore, getLoadedAudioUrl } from '../../state/playerStore';
import { useLibraryStore } from '../../state/libraryStore';
import type { LibraryEntry } from '../../state/libraryStore';
import { useAppUiStore } from '../../state/appUiStore';
import { useEffectChainStore } from '../../state/effectChainStore';
import {
  bypassLiveRack, liveRackEntries, rackEntryLabel,
  useMixLiveRackStore, LEVEL_TAKING_RACK_IDS,
} from '../../state/mixLiveRack';
import { callEditorPlay, isEditorPlaybackRegistered } from '../../state/editorPlaybackBridge';
import { SlideTrack } from './SlideTrack';
import { IoGlobalSelect } from './IoDeviceSelect';
import { useIoDevicesStore, useResolvedGlobal } from '../../state/ioDevicesStore';
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
import {
  transportKey,
  transportKeyDead,
  transportKeyOff,
  transportKeyOn,
  transportPlate,
  transportPlayDead,
  transportPlayKey,
  transportPlayOn,
  transportPlayRest,
} from './transportKeys';
import { Glyph, GLYPH_PAUSE, GLYPH_PLAY, GLYPH_TO_END, GLYPH_TO_START } from './transportGlyphs';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import { entryAudioFileName, entryFileName } from '../../convert/convertClient';
import { saveFile } from '../../lib/saveFile';
import { TrackMenu } from './TrackMenu';
import { audioExtForMime, EDITOR_TIMELINE_ID } from './trackMenuModel';

/**
 * What each repeat state is called, in the tooltip and for a screen reader.
 * Each name starts with the words its key prints (LOOP, ALL, ONE), so a speech
 * command that reads the key off the screen finds it (label-in-name).
 */
const REPEAT_LABEL: Record<'off' | 'all' | 'one', string> = {
  off: 'Loop off - play the list through and stop',
  all: 'Loop all - the list starts again at the end',
  one: 'Loop one - this track loops',
};

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
 * The scrub strip: the middle three-fifths of the footer's top edge, 16px
 * tall, centred on the window so it is symmetric about PLAY, with the elapsed
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
    // data-scrub-strip: the orb's status panel measures this row so a long
    // notice rises clear of it instead of covering the playhead (noticeLift).
    <div data-scrub-strip className="flex items-center gap-2.5 w-3/5 mx-auto h-4 shrink-0">
      {/* The times: the bold sans at 12px in tabular figures, so the digits
          hold still as they tick. */}
      <span className="w-10 shrink-0 text-right font-sans font-bold text-xs leading-4 tabular-nums text-zinc-400">
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
        {/* The rail: flat and squared like the plate below (no rounding, no
            gradient) — thin at rest, thicker under the pointer or keyboard focus. */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 bg-white/10 transition-[height] group-hover/scrub:h-1 group-focus-visible/scrub:h-1">
          {hover !== null && drag === null && (
            <div className="absolute inset-y-0 left-0 bg-white/10" style={{ width: `${hover * 100}%` }} />
          )}
          <div
            className="absolute inset-y-0 left-0 bg-[rgb(var(--et-accent))]"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
        {/* The playhead: a 2×10px cursor bar, no glow, widened under the hand. */}
        <div
          className={`absolute top-1/2 w-0.5 h-2.5 -translate-x-1/2 -translate-y-1/2 bg-white transition-[opacity,scale] ${
            canSeek ? 'opacity-100' : 'opacity-0'
          } ${drag !== null ? 'scale-x-150' : 'group-hover/scrub:scale-x-150 group-focus-visible/scrub:scale-x-150'}`}
          style={{ left: `${frac * 100}%` }}
        />
        {canSeek && shown !== null && (
          <span
            className="absolute bottom-full mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-xs border border-white/12 bg-[#0a080f] px-1.5 py-0.5 font-sans font-bold text-xs leading-4 tabular-nums text-zinc-200 pointer-events-none"
            style={{ left: `${shown * 100}%` }}
          >
            {formatDuration(shown * duration)}
          </span>
        )}
      </div>
      <span className="w-10 shrink-0 font-sans font-bold text-xs leading-4 tabular-nums text-zinc-400">
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
/**
 * Output device, where the symptom is.
 *
 * Plugging headphones in mid-session is the moment a person reaches for this,
 * and making them open the hamburger → Settings for it is the wrong
 * ergonomics. Mains + cue only; the full menu is one click away.
 *
 * Custom control (CLAUDE.md rule 3): a button carrying its own accessible name,
 * expanded state and the id of the panel it controls — NOT wrapped in a label.
 */
const AudioOutIndicator: React.FC = () => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const main = useResolvedGlobal('audio_output');
  const supports = useIoDevicesStore((s) => s.supports);

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

  const missing = main.source === 'missing';
  const name = main.label || 'System default';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Audio output device: ${missing ? 'not connected' : name}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="footer-audio-out"
        title={missing ? `${name} is not connected — playing on the system default` : `Output: ${name}`}
        className={`${iconButton} ${missing ? 'text-amber-400 hover:text-amber-300' : ''}`}
      >
        <Speaker className="w-4 h-4" />
      </button>
      <div
        id="footer-audio-out"
        hidden={!open}
        role="dialog"
        aria-label="Audio output devices"
        className="absolute bottom-full right-0 mb-2 z-50 w-80 rounded-md border border-purple-500/30 bg-[#0c0a14] p-2 shadow-xl flex flex-col gap-2"
      >
        {/* Each row: icon, legend, select, and under them any status chip the
            picker prints (flex-wrap; the chip takes the whole next line). */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 [&>span]:basis-full">
          <Speaker className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          <IoGlobalSelect
            slot="audio_output"
            id="footer-main-out"
            label="Main output"
            showLabel
            labelClassName={AUDIO_OUT_LEGEND}
            className="flex-1"
            unsupported={supports.ctxSink ? undefined : 'the desktop app can move this'}
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 [&>span]:basis-full">
          <Headphones className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          <IoGlobalSelect
            slot="cue_output"
            id="footer-cue-out"
            label="Cue output"
            showLabel
            labelClassName={AUDIO_OUT_LEGEND}
            className="flex-1"
            unsupported={supports.elementSink ? undefined : 'not routable here'}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            window.dispatchEvent(new CustomEvent('thedaw:open-settings'));
          }}
          className="self-start font-display font-bold text-xs leading-4 uppercase text-purple-300 hover:text-purple-100"
        >
          All inputs &amp; outputs…
        </button>
      </div>
    </div>
  );
};

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
      {/* The printed words lead the name (label-in-name): "Master FX", then the count. */}
      <button
        type="button"
        onClick={openMix}
        aria-label={`Master FX: ${count} effect${plural} live on the output. Open MIX`}
        title={`${count} effect${plural} on the master insert${takers > 0 ? ', some of which take level' : ''}. Open MIX.`}
        className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-l border border-r-0 border-[rgb(var(--et-accent)/0.4)] bg-[rgb(var(--et-accent)/0.1)] text-[rgb(var(--et-accent))] hover:bg-[rgb(var(--et-accent)/0.2)] hover:border-[rgb(var(--et-accent)/0.7)] transition-colors shadow-[0_0_12px_rgb(var(--et-accent)/0.18)]"
      >
        <Activity className="w-3.5 h-3.5 shrink-0" />
        <span className="font-display font-bold text-xs leading-4 uppercase whitespace-nowrap">Master FX</span>
        <span className="font-sans font-bold text-xs leading-4 tabular-nums">{count}</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Hide what is on the master insert' : 'Show what is on the master insert'}
        aria-expanded={open}
        aria-controls="master-fx-detail"
        className="px-1 py-1 rounded-r border border-[rgb(var(--et-accent)/0.4)] bg-[rgb(var(--et-accent)/0.1)] text-[rgb(var(--et-accent))] hover:bg-[rgb(var(--et-accent)/0.2)] hover:border-[rgb(var(--et-accent)/0.7)] transition-colors"
      >
        <ChevronUp className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          id="master-fx-detail"
          className="absolute bottom-full right-0 mb-2 w-72 flex flex-col gap-2 p-2.5 rounded-lg border border-[rgb(var(--et-accent)/0.3)] bg-[#0a080f] shadow-[0_0_24px_rgb(var(--et-accent)/0.2)]"
        >
          {/* Orbitron bold for the heading, the tags and the buttons; the bold
              sans for the copy and the rows; nothing under 12px. */}
          <span className="font-display font-bold text-xs leading-4 uppercase text-[rgb(var(--et-accent))]">On the master insert</span>
          <p className="font-sans font-bold text-xs leading-4 text-zinc-400">
            These sit between the mix bus and the meter, so they shape everything the
            transport plays — in every tab, until they are switched off.
          </p>
          <ul className="flex flex-col gap-1">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 font-sans font-bold text-xs leading-4 text-zinc-200 truncate" title={rackEntryLabel(e)}>{rackEntryLabel(e)}</span>
                {LEVEL_TAKING_RACK_IDS.has(e.effect) && (
                  <span className="shrink-0 font-display font-bold text-xs leading-4 uppercase whitespace-nowrap text-amber-300">takes level</span>
                )}
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openMix}
              className="flex-1 px-2 py-1 rounded border border-white/10 font-display font-bold text-xs leading-4 uppercase whitespace-nowrap text-zinc-300 hover:border-[rgb(var(--et-accent)/0.6)] hover:text-[rgb(var(--et-accent))] transition-colors"
            >
              Show in MIX
            </button>
            <button
              type="button"
              onClick={bypassLiveRack}
              className="flex-1 px-2 py-1 rounded border border-[rgb(var(--et-accent)/0.4)] bg-[rgb(var(--et-accent)/0.1)] font-display font-bold text-xs leading-4 uppercase whitespace-nowrap text-[rgb(var(--et-accent))] hover:bg-[rgb(var(--et-accent)/0.2)] hover:border-[rgb(var(--et-accent)/0.7)] transition-colors"
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

/** The visible legend beside each picker in the audio-output panel: Orbitron bold at 12px. */
const AUDIO_OUT_LEGEND = 'font-display font-bold text-xs leading-4 uppercase text-zinc-400 shrink-0';

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
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const hasTrack = usePlayerStore((s) => s.hasTrack);
  const toggle = usePlayerStore((s) => s.toggle);
  const seekByFraction = usePlayerStore((s) => s.seekByFraction);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const setMasterGain = usePlayerStore((s) => s.setMasterGain);
  const load = usePlayerStore((s) => s.load);
  const currentEntryId = usePlayerStore((s) => s.currentEntryId);
  const libraryEntries = useLibraryStore((s) => s.entries);

  // Shuffle (the RAND key) — local to the footer: playerStore carries no shuffle
  // state and transportControlSource mirrors play/loop only, so this resets on
  // a footer remount and does not reach controllers; it belongs in playerStore
  // if it ever has to persist or reach the mobile transport. When on, "up next"
  // is a random OTHER library entry, drawn once per current entry: the pick is
  // pinned to the entry it was drawn for (`forId`), so re-renders never re-roll
  // it, a new current entry draws afresh, and a library refresh that removes
  // the picked entry draws again. Held in state and written from an effect —
  // never a ref written during render.
  const [isShuffle, setIsShuffle] = useState(false);
  const [shufflePick, setShufflePick] = useState<{ forId: string | null; pick: LibraryEntry | null }>({ forId: null, pick: null });
  useEffect(() => {
    if (!isShuffle) return;
    setShufflePick((prev) => {
      const others = libraryEntries.filter((e) => e.id !== currentEntryId);
      const pickId = prev.forId === currentEntryId ? prev.pick?.id : undefined;
      const kept = pickId !== undefined ? others.find((e) => e.id === pickId) : undefined;
      if (kept) return kept === prev.pick ? prev : { forId: currentEntryId, pick: kept };
      return { forId: currentEntryId, pick: others[Math.floor(Math.random() * others.length)] ?? null };
    });
  }, [isShuffle, currentEntryId, libraryEntries]);

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

  // Save a copy of what the footer holds: the library file for an entry, the
  // loaded bytes for anything else (a stem, a MIX render, the MIDI beat). It
  // used to fall back to the first library entry, which saved an unrelated file
  // for every track that was not an entry.
  const currentEntry = React.useMemo(
    () => (currentEntryId ? libraryEntries.find((e) => e.id === currentEntryId) ?? null : null),
    [libraryEntries, currentEntryId],
  );
  const canSaveCopy = hasTrack && (!!currentEntry || !!getLoadedAudioUrl());
  const saveCopyTitle = canSaveCopy
    ? 'Save a copy of the current track'
    : currentEntryId === EDITOR_TIMELINE_ID
      ? 'The EDIT timeline plays live. Mix it down in EDIT to save it'
      : 'Load a track to save a copy';
  const handleDownload = () => {
    if (currentEntry) {
      const url = useLibraryStore.getState().getAudioUrl(currentEntry);
      void saveFile({ url, suggestedName: entryAudioFileName(currentEntry), kind: 'audio' });
      return;
    }
    const loaded = getLoadedAudioUrl();
    if (!loaded) return;
    const name = engineLabel || 'track';
    void fetch(loaded)
      .then((res) => res.blob())
      .then((blob) => saveFile({ blob, suggestedName: entryFileName(name, audioExtForMime(blob.type), 'track'), kind: 'audio' }));
  };

  // "Up next" — no formal play queue yet, so derive the next track from the
  // library in newest-first order (wraps at the end). Clicking it loads it.
  const sequentialNext = React.useMemo(() => {
    if (libraryEntries.length === 0) return null;
    const sorted = [...libraryEntries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (!currentEntryId) return sorted[0] ?? null;
    const idx = sorted.findIndex((e) => e.id === currentEntryId);
    if (idx < 0) return sorted[0] ?? null;
    return sorted[(idx + 1) % sorted.length] ?? null;
  }, [libraryEntries, currentEntryId]);
  // With RAND on (and a second entry to draw from), up next is the random pick
  // instead — once the effect above has drawn it for THIS entry; the one render
  // before that falls back to the sequential next, never to the entry already
  // playing. `loadNext` loads whichever this resolves to.
  const nextEntry = isShuffle && libraryEntries.length > 1 && shufflePick.forId === currentEntryId
    ? shufflePick.pick
    : sequentialNext;

  const loadNext = () => {
    if (!nextEntry) return;
    void (async () => {
      const blob = await useLibraryStore.getState().fetchAudioBlob(nextEntry);
      await load(blob, { label: nextEntry.title, entryId: nextEntry.id });
    })();
  };

  // The dead keys: START needs a track (or the editor's render path); PLAY also
  // counts the live tabs, where it is the master transport with no track loaded.
  const startDisabled = !inEditorMode && !hasTrack;
  const playDisabled = !isVjMode && !inEditorMode && !hasTrack;

  // The now-playing chip: the model that made the last output, LIBRARY for a
  // loaded entry, IDLE for nothing.
  const nowChip = lastModelName ? lastModelName.toUpperCase() : (displayLabel ? 'LIBRARY' : 'IDLE');

  return (
    <footer
      className="edit-theme-scope fixed bottom-0 left-0 right-0 h-16 bg-[#0a080f]/95 backdrop-blur-xl border-t border-white/5 z-50 flex flex-col group"
      data-et-light={editTheme.light ? '1' : undefined}
      style={editTheme.vars as React.CSSProperties}
    >
      {/* Row 1: the scrub strip, centred, the middle 3/5 of the footer width
          (w-3/5 mx-auto), clear of the orb from 1024px up. Its height is
          FOOTER_H (lib/layoutScale.ts) minus the 48px row below; change both
          together. */}
      <ScrubStrip />

      {/* Row 2: now playing · transport · up next + utilities. One row, so
          nothing stacks inside 48px any more. An explicit 1fr · auto · 1fr grid,
          because only a grid keeps the two side tracks equal with padding
          inside them: as a flex-1 pair, section 1's 144px orb clearance made it
          144px wider and pushed PLAY 72px right of the window centre. */}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 xl:gap-4 px-4 xl:px-6 pb-0.5">
        {/* 1. Orb speech bubble + Now Playing, in the left track. The orb
            sticks to the bottom-left corner and overlaps the footer, so pad left
            past it: 16px margin + the 112px orb = 128, plus clearance. */}
        <div className="flex items-center gap-3 min-w-0 pl-36">
          {/* The orb's speech bubble, in the slot G-Search held, from xl up.
              Status notices show in it, and a click on one opens the LOG; below
              xl it is hidden and OrbStatusFloat (App.tsx) shows notices by the
              orb. 192px below 2xl and 224px from 2xl: beside the 276px transport
              plate, 192px at 1280px still leaves the now-playing block room for
              its title and a LIBRARY chip row. */}
          <OrbTipBubble
            className="hidden xl:block"
            widthClass="w-48 2xl:w-56"
            onOpenLog={() => useBottomPanelStore.getState().setLogOpen(true)}
          />
          <div className="flex flex-col min-w-0 flex-1 gap-0.5">
            <h4 className="text-[13px] font-bold text-zinc-100 truncate tracking-tight leading-tight">
              {displayLabel ?? 'No output loaded'}
            </h4>
            {/* One line at every width: the chip gives way first and ends in an
                ellipsis (its whole name is its title); the duration and the VJ
                chip keep their width. No sample rate: the engine plays whatever
                rate the file carries. */}
            <div className="flex items-center gap-2 min-w-0 whitespace-nowrap">
              <span
                title={nowChip}
                className="min-w-0 truncate font-display font-bold text-xs leading-4 uppercase text-[rgb(var(--et-accent))] border border-[rgb(var(--et-accent)/0.25)] px-1 rounded-xs bg-[rgb(var(--et-accent)/0.06)]"
              >
                {nowChip}
              </span>
              <span className="shrink-0 font-sans font-bold text-xs leading-4 tabular-nums text-zinc-400">
                {displayDuration > 0 ? formatDuration(displayDuration) : '--:--'}
              </span>
              {isVjMode && vjSetCount > 0 && (
                <span
                  className={`flex items-center gap-1 px-1.5 rounded border font-display font-bold text-xs leading-4 uppercase shrink-0 ${
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
          {/* Like and Share, on footer hover or keyboard focus, at every width.
              At rest the pair is 0px wide and its -ml-3 cancels the row gap, so
              the now-playing block keeps that room; hover or focus opens it,
              and its overflow turns visible with it so a focused key's outline
              is never clipped. Both keys stay in the tab order throughout. */}
          <div className="flex shrink-0 items-center gap-0.5 w-0 -ml-3 overflow-hidden opacity-0 transition-opacity group-hover:w-auto group-hover:ml-1 group-hover:overflow-visible group-hover:opacity-100 focus-within:w-auto focus-within:ml-1 focus-within:overflow-visible focus-within:opacity-100">
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

        {/* 2. Transport — one matte plate (transportPlate): LOOP · START · PLAY ·
            END · RAND on a hairline grid (the plate's p-px/gap-px well IS the
            grid; keys carry no borders or the theme floors them to a 3:1 line).
            2+2 about PLAY so the flex-1 side sections keep it on the viewport
            centre, and the keys pair up in width about PLAY (w-12 · w-14 · w-15
            · w-14 · w-12) so PLAY stays on the plate's centre too. Each width
            is its widest legend at 12px Orbitron bold plus about 4px a side:
            RAND 39.9px, START 48.1px, PAUSE 48.6px. The playhead is in the
            strip above. Fullscreen lives in the top bar beside Mobile — an even
            key count is what keeps PLAY dead centre. */}
        <div data-tour="transport" className={`shrink-0 ${transportPlate}`}>
          {/* Three states, one key: off -> the list plays through and stops,
              all -> the list wraps, one -> this track repeats. aria-pressed is
              deliberately absent: a tri-state control is not a toggle, so the
              state travels in the label instead. */}
          <button
            type="button"
            onClick={cycleRepeat}
            aria-label={REPEAT_LABEL[repeatMode]}
            title={`${REPEAT_LABEL[repeatMode]} - click to change`}
            className={`${transportKey} w-9 ${repeatMode === 'off' ? transportKeyOff : transportKeyOn}`}
          >
            {repeatMode === 'one' ? (
              <Repeat1 className="w-3.5 h-3.5" strokeWidth={1.5} absoluteStrokeWidth strokeLinecap="square" strokeLinejoin="miter" />
            ) : (
              <Repeat className="w-3.5 h-3.5" strokeWidth={1.5} absoluteStrokeWidth strokeLinecap="square" strokeLinejoin="miter" />
            )}
          </button>
          <button
            type="button"
            onClick={() => seekByFraction(0)}
            disabled={startDisabled}
            aria-label="Jump to start"
            title="Jump to start"
            className={`${transportKey} w-9 ${startDisabled ? transportKeyDead : transportKeyOff}`}
          >
            <Glyph d={GLYPH_TO_START} className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleToggle}
            disabled={playDisabled}
            aria-label={displayIsPlaying ? 'Pause' : 'Play'}
            title={displayIsPlaying ? 'Pause' : 'Play'}
            className={`${transportPlayKey} w-11 ${playDisabled ? transportPlayDead : displayIsPlaying ? transportPlayOn : transportPlayRest}`}
          >
            {displayIsPlaying
              ? <Glyph d={GLYPH_PAUSE} className="w-4 h-4" />
              : <Glyph d={GLYPH_PLAY} className="w-4 h-4 ml-0.5" />}
          </button>
          <button
            type="button"
            onClick={() => seekByFraction(1)}
            disabled={!hasTrack}
            aria-label="Jump to end"
            title="Jump to end"
            className={`${transportKey} w-9 ${hasTrack ? transportKeyOff : transportKeyDead}`}
          >
            <Glyph d={GLYPH_TO_END} className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setIsShuffle((v) => !v)}
            aria-label="Rand: random order"
            aria-pressed={isShuffle}
            title={`Rand: random order ${isShuffle ? 'on' : 'off'} - any other library track plays next`}
            className={`${transportKey} w-9 ${isShuffle ? transportKeyOn : transportKeyOff}`}
          >
            <Shuffle className="w-3.5 h-3.5" strokeWidth={1.5} absoluteStrokeWidth strokeLinecap="square" strokeLinejoin="miter" />
          </button>
        </div>

        {/* 3. Next (mirrors Now Playing) + Utilities, right-aligned in the
            right track. */}
        <div className="flex items-center gap-4 min-w-0 justify-end">
          {/* Next — mirror of the Now Playing block, right-aligned. Click loads
              the next track (no formal queue yet, so it's the next library entry —
              or a random other one while RAND is on, which the title says).
              Hidden below xl: there the right track is all the utilities' (at
              the desktop app's 960px minimum it is 318px, the utilities 312px),
              and at lg it once collapsed to 0px and its second row spilled over
              the plate. */}
          <button
            type="button"
            onClick={loadNext}
            disabled={!nextEntry}
            title={nextEntry ? `Play next${isShuffle ? ' (random)' : ''}: ${nextEntry.title}` : 'Nothing queued'}
            className="group/next hidden xl:flex flex-col min-w-0 flex-1 items-end text-right gap-0.5 disabled:cursor-default"
          >
            <h4 className="text-[13px] font-bold text-zinc-300 group-hover/next:text-white transition-colors truncate tracking-tight leading-tight w-full">
              {nextEntry?.title ?? 'Nothing queued'}
            </h4>
            <div className="flex items-center gap-2 whitespace-nowrap">
              <span className="shrink-0 font-sans font-bold text-xs leading-4 tabular-nums text-zinc-400">
                {nextEntry ? formatDuration(nextEntry.duration) : '--:--'}
              </span>
              <span className="shrink-0 font-display font-bold text-xs leading-4 uppercase text-emerald-400 border border-emerald-500/20 px-1 rounded-xs bg-emerald-500/5">
                Next
              </span>
            </div>
          </button>
          {/* Left to right: download and more options, then the output (the
              master FX pill, the output device, mute + volume), then the action
              key. The two indicators stay beside the volume control because
              that is where the symptom they account for shows. Fullscreen is in
              the top bar, beside Mobile. Below 2xl the gaps close to 8px and the
              volume track to 64px (312px of utilities, 384px at 2xl): that keeps
              them inside the right track beside the 276px transport plate from
              the desktop app's 960px minimum, and leaves Next room for its
              title and chip row from xl. */}
          <div className="flex items-center gap-2 2xl:gap-4 shrink-0">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleDownload}
                disabled={!canSaveCopy}
                aria-label="Save a copy of the current track"
                title={saveCopyTitle}
                className={iconButton}
              >
                <Download className="w-4 h-4" />
              </button>
              <TrackMenu buttonClassName={iconButton} />
            </div>

            <div className="h-6 w-px bg-white/5" />

            <MasterFxIndicator />
            <AudioOutIndicator />
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
                onChange={(v) => setVolume(v)} className="w-16 2xl:w-24" ariaLabel="Volume" />
            </div>

            <div className="h-6 w-px bg-white/5" />

            {/* The workspace action key (CREATE / PROCESS / TRAIN / STOP / CHAIN
                / SEND) — at the footer's bottom-right on EVERY tab, alone on a
                matte plate the transport's height (transportPlate). The plate
                is 80px: its key is 76px inside, and PROCESS, the widest legend,
                is 68.2px at 12px Orbitron bold. The plate is `relative` for
                CREATE's stage caption, which hangs over its top edge. */}
            <div data-tour="action-button" className={`relative shrink-0 w-20 ${transportPlate}`}>
              <LogActionButton />
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};
