import React, { useEffect, useRef, useState } from 'react';
import { Volume2, Download, Share2, Heart, Repeat, Shuffle, VolumeX, Maximize2, MoreHorizontal, Cast, Check, Activity, ChevronUp } from 'lucide-react';
import { useGenerateStore } from '../../state/generateStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { usePlayerStore } from '../../state/playerStore';
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
    <div className="flex items-center gap-2.5 w-3/5 mx-auto h-4 shrink-0">
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
            className="absolute bottom-full mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-xs border border-white/12 bg-[#0a080f] px-1.5 py-0.5 text-[10px] font-mono tabular-nums text-zinc-200 pointer-events-none"
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
        className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-l border border-r-0 border-[rgb(var(--et-accent)/0.4)] bg-[rgb(var(--et-accent)/0.1)] text-[rgb(var(--et-accent))] hover:bg-[rgb(var(--et-accent)/0.2)] hover:border-[rgb(var(--et-accent)/0.7)] transition-colors shadow-[0_0_12px_rgb(var(--et-accent)/0.18)]"
      >
        <Activity className="w-3 h-3" />
        <span className="text-[9px] font-black uppercase tracking-widest">Master FX</span>
        <span className="text-[9px] font-mono text-[rgb(var(--et-accent))]">{count}</span>
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
          className="absolute bottom-full right-0 mb-2 w-64 flex flex-col gap-2 p-2.5 rounded-lg border border-[rgb(var(--et-accent)/0.3)] bg-[#0a080f] shadow-[0_0_24px_rgb(var(--et-accent)/0.2)]"
        >
          <span className="text-[9px] font-black uppercase tracking-widest text-[rgb(var(--et-accent))]">On the master insert</span>
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
              className="flex-1 px-2 py-1 rounded border border-white/10 text-[9px] font-black uppercase tracking-widest text-zinc-300 hover:border-[rgb(var(--et-accent)/0.6)] hover:text-[rgb(var(--et-accent))] transition-colors"
            >
              Show in MIX
            </button>
            <button
              type="button"
              onClick={bypassLiveRack}
              className="flex-1 px-2 py-1 rounded border border-[rgb(var(--et-accent)/0.4)] bg-[rgb(var(--et-accent)/0.1)] text-[9px] font-black uppercase tracking-widest text-[rgb(var(--et-accent))] hover:bg-[rgb(var(--et-accent)/0.2)] hover:border-[rgb(var(--et-accent)/0.7)] transition-colors"
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

/**
 * A transport key on the matte plate: squared, flat, borderless. The plate's
 * own p-px/gap-px well is the grid between keys, so a key must NEVER carry a
 * border-white/N class — index.css floors any bordered button to
 * rgb(var(--et-border)) (a >= 3:1 line) and the hairline grid turns hard. The
 * plate must likewise never gain overflow-hidden or a clip-path: keyboard focus
 * is the scope's 2px ink outline (index.css), drawn OUTSIDE the key, which is
 * why a focused key only lifts itself above its neighbours (relative + z-10)
 * and adds no ring of its own.
 *
 * The OFF / ON / DEAD strings below are exclusive — each owns the key's bg and
 * text — because the scope's ink remaps are unlayered: a `disabled:` or
 * `hover:` utility stacked on `text-zinc-400` would lose to the remapped base
 * class, so state switches the whole string, never layers on top of it.
 */
const transportKey = 'h-full w-8 flex flex-col items-center justify-center gap-0.5 rounded-none first:rounded-l-xs last:rounded-r-xs select-none transition-[color,box-shadow] duration-100 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)] focus-visible:relative focus-visible:z-10 disabled:pointer-events-none';
/**
 * …at rest / toggle OFF: a 5% tile with a 1px etched top highlight (a hairline,
 * not a glow). `bg-white/5`, `text-zinc-400` and `hover:text-zinc-100` are
 * theme-remapped by UNLAYERED rules, which is why hover and press never use a
 * `hover:bg-*` / `active:bg-*` utility: a layered variant loses to the remapped
 * base fill and paints nothing. The hover fill is an inset box-shadow with a
 * 100px spread (a translucent layer over the tile, under the glyph) and the
 * press is the inset shade on the key string; shadows are never remapped.
 * `bg-white/4|6|8` are not remapped at all: never "tune" the tile to those.
 */
const transportKeyOff = 'bg-white/5 text-zinc-400 hover:text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_100px_rgba(255,255,255,0.06)]';
/**
 * …toggle ON: latched IN (inset shade, one tint step up) in the theme's accent
 * ink (`--et-accent`, editThemes.ts: the theme's own hue, or purple on a
 * neutral theme) — the glyph and legend take currentColor, so nothing else is
 * needed and no light is added. Hover brightens the whole key a step.
 */
const transportKeyOn = 'bg-white/10 text-[rgb(var(--et-accent))] hover:brightness-110 shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)] hover:shadow-[inset_0_1px_2px_rgba(0,0,0,0.6),inset_0_0_0_100px_rgba(255,255,255,0.04)]';
/**
 * …disabled: the key keeps its cap — a dead START/END stays a tile in the grid,
 * not a hole — and only its glyph and legend dim, to 40 % of the live ink, so
 * the cue survives every theme (a fixed dead-ink hex read as live on the light
 * themes, and any zinc step is floored up to a live tier by the remaps).
 */
const transportKeyDead = 'bg-white/5 text-zinc-400 [&>*]:opacity-40 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]';
/**
 * The PLAY key: the plate's double-width key, one tint step lighter, primary
 * ink. `border-b` is always present (transparent at rest) so the playing edge
 * never shifts layout; neither border-b colour is in the scope's border-floor
 * list, so nothing floors it.
 */
const transportPlayKey = 'h-full w-11 flex flex-col items-center justify-center gap-0.5 rounded-none select-none border-b transition-[color,box-shadow,border-color] duration-100 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)] focus-visible:relative focus-visible:z-10 disabled:pointer-events-none';
const transportPlayRest = 'bg-white/10 text-zinc-100 border-b-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.08)]';
/**
 * …while playing: the same fill and shadow, accent ink and a 1px etched accent
 * bottom edge (sitting 1px above the plate's own hairline) — the grammar of a
 * latched LOOP/RAND, so it reads across the room on the DJ/VJ tabs where this
 * key is the master transport. No glow.
 */
const transportPlayOn = 'bg-white/10 text-[rgb(var(--et-accent))] hover:brightness-110 border-b-[rgb(var(--et-accent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.06)]';
const transportPlayDead = 'bg-white/10 text-zinc-100 [&>*]:opacity-40 border-b-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]';
/**
 * The etched legend under each glyph. Decorative (aria-hidden — the key's
 * aria-label is its name, and the legend always sits inside that name: LOOP
 * in "Looping on", RAND in "Random order on"),
 * it inherits the key's ink, so rest / hover / ON / dead all flow through the
 * button's class. 8px has no scale token (the file already uses 9px and 10px).
 */
const keyLabel = 'text-[8px] font-mono uppercase tracking-widest leading-none';

/**
 * The four motion glyphs, hard-cornered (no rounded joins) so they read as one
 * engraved set at 14px — lucide's round joins go soft that small. Fill-only in
 * currentColor, so the key's ink, hover ink and ON accent flow straight in.
 */
const Glyph: React.FC<{ d: string; className?: string }> = ({ d, className }) => (
  <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" focusable="false" className={className}>
    <path d={d} />
  </svg>
);
const GLYPH_PLAY = 'M3 1.5 12.5 7 3 12.5Z';
const GLYPH_PAUSE = 'M3 2h3v10H3zM8 2h3v10H8z';
const GLYPH_TO_START = 'M2 2h2v10H2zM12 2 5 7l7 5z';
const GLYPH_TO_END = 'M2 2l7 5-7 5zM10 2h2v10h-2z';

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

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
  };

  // The dead keys: START needs a track (or the editor's render path); PLAY also
  // counts the live tabs, where it is the master transport with no track loaded.
  const startDisabled = !inEditorMode && !hasTrack;
  const playDisabled = !isVjMode && !inEditorMode && !hasTrack;

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
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-6 pb-0.5">
        {/* 1. Orb speech bubble + Now Playing, in the left track. The orb
            sticks to the bottom-left corner and overlaps the footer, so pad left
            past it: 16px margin + the 112px orb = 128, plus clearance. */}
        <div className="flex items-center gap-3 min-w-0 pl-36">
          {/* The orb's speech bubble, in the slot G-Search used to hold. */}
          <OrbTipBubble className="hidden xl:block" />
          <div className="flex flex-col min-w-0 flex-1 gap-0.5">
            <h4 className="text-[13px] font-bold text-zinc-100 truncate tracking-tight leading-tight">
              {displayLabel ?? 'No output loaded'}
            </h4>
            <div className="flex items-center gap-2">
              <span className="text-[9px] text-[rgb(var(--et-accent))] font-mono uppercase tracking-widest border border-[rgb(var(--et-accent)/0.25)] px-1 rounded-xs bg-[rgb(var(--et-accent)/0.06)]">
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

        {/* 2. Transport — one matte plate: LOOP · START · PLAY · END · RAND on a
            hairline grid (the plate's p-px/gap-px well IS the grid; keys carry
            no borders or the theme floors them to a 3:1 line). 2+2 about PLAY
            so the flex-1 side sections keep it on the viewport centre. The
            playhead is in the strip above. Fullscreen lives with the window
            utilities on the right (its handler, aria-label, title and icon are
            unchanged) — an even key count is what keeps PLAY dead centre. The
            wrapper is a div, so its border-white/8 stays a hairline (the scope's
            button border floor never touches it), and `bg-black/40` /
            `border-white/8` are both theme-remapped. Never give it
            overflow-hidden or a clip-path: the keys' focus outline draws
            outside them. */}
        <div data-tour="transport" className="shrink-0 flex items-stretch h-9 p-px gap-px rounded-xs border border-white/8 bg-black/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <button
            type="button"
            onClick={toggleLoop}
            aria-label={isLooping ? 'Looping on' : 'Looping off'}
            aria-pressed={isLooping}
            title={isLooping ? 'Looping on' : 'Looping off'}
            className={`${transportKey} ${isLooping ? transportKeyOn : transportKeyOff}`}
          >
            <Repeat className="w-3.5 h-3.5" strokeWidth={1.5} absoluteStrokeWidth strokeLinecap="square" strokeLinejoin="miter" />
            <span aria-hidden="true" className={keyLabel}>LOOP</span>
          </button>
          <button
            type="button"
            onClick={() => seekByFraction(0)}
            disabled={startDisabled}
            aria-label="Jump to start"
            title="Jump to start"
            className={`${transportKey} ${startDisabled ? transportKeyDead : transportKeyOff}`}
          >
            <Glyph d={GLYPH_TO_START} className="w-3.5 h-3.5" />
            <span aria-hidden="true" className={keyLabel}>START</span>
          </button>
          <button
            type="button"
            onClick={handleToggle}
            disabled={playDisabled}
            aria-label={displayIsPlaying ? 'Pause' : 'Play'}
            title={displayIsPlaying ? 'Pause' : 'Play'}
            className={`${transportPlayKey} ${playDisabled ? transportPlayDead : displayIsPlaying ? transportPlayOn : transportPlayRest}`}
          >
            {displayIsPlaying
              ? <Glyph d={GLYPH_PAUSE} className="w-4 h-4" />
              : <Glyph d={GLYPH_PLAY} className="w-4 h-4 ml-0.5" />}
            {/* The legend flips with the glyph so the printed word stays inside
                the accessible name (label-in-name). */}
            <span aria-hidden="true" className={keyLabel}>{displayIsPlaying ? 'PAUSE' : 'PLAY'}</span>
          </button>
          <button
            type="button"
            onClick={() => seekByFraction(1)}
            disabled={!hasTrack}
            aria-label="Jump to end"
            title="Jump to end"
            className={`${transportKey} ${hasTrack ? transportKeyOff : transportKeyDead}`}
          >
            <Glyph d={GLYPH_TO_END} className="w-3.5 h-3.5" />
            <span aria-hidden="true" className={keyLabel}>END</span>
          </button>
          <button
            type="button"
            onClick={() => setIsShuffle((v) => !v)}
            aria-label={isShuffle ? 'Random order on' : 'Random order off'}
            aria-pressed={isShuffle}
            title="Random order: any other library track plays next"
            className={`${transportKey} ${isShuffle ? transportKeyOn : transportKeyOff}`}
          >
            <Shuffle className="w-3.5 h-3.5" strokeWidth={1.5} absoluteStrokeWidth strokeLinecap="square" strokeLinejoin="miter" />
            <span aria-hidden="true" className={keyLabel}>RAND</span>
          </button>
        </div>

        {/* 3. Up Next (mirrors Now Playing) + Utilities, right-aligned in the
            right track. */}
        <div className="flex items-center gap-4 min-w-0 justify-end">
          {/* Up Next — mirror of the Now Playing block, right-aligned. Click loads
              the next track (no formal queue yet, so it's the next library entry —
              or a random other one while RAND is on, which the title says).
              Hidden below xl: at 1024px the right track is 382px and the
              utilities alone take 340 of them, so at lg it collapsed to 0px and
              its second row spilled over the plate. */}
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
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-500 font-mono">
                {nextEntry ? formatDuration(nextEntry.duration) : '--:--'}
              </span>
              <span className="text-[9px] text-emerald-400 font-mono uppercase tracking-widest border border-emerald-500/20 px-1 rounded-xs bg-emerald-500/5">
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
              {/* Fullscreen — a window utility, so it sits here rather than on the
                  transport plate (handler, aria-label, title and icon unchanged). */}
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label="Toggle fullscreen"
                title="Toggle fullscreen"
                className={iconButton}
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
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
