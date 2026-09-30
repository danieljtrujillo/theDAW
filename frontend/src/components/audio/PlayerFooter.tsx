import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Volume, Volume2, Download, Share2, Heart, Repeat, Repeat1, Shuffle, VolumeX, Cast, Check, Activity, Circle, Headphones, Speaker, Triangle } from 'lucide-react';
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
  keyLabel,
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
import {
  COUNT_IN_CHOICES,
  initMetronome,
  metronomeCountIn,
  useMetronomeStore,
  type CountInBars,
} from '../../state/metronomeStore';
import { CLICK_MODES, CLICK_MODE_LABEL, CLICK_MODE_TITLE, asClickMode, type ClickMode } from '../../lib/metronome';
import {
  PUNCH_CHOICES,
  initRecording,
  useRecordingPrefs,
  useRecordingStore,
  type PunchMode,
  type RecordingStatus,
} from '../../state/recordingStore';
import { ContextMenu, menuAnchorFromEvent, usePopoverShell, type ContextMenuPosition } from '../ui/ContextMenu';
import { postStatus } from '../../state/statusNoticeStore';
import { keyBelongsToFocusedControl } from '../../lib/keyTargets';

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

/** Why the RECORD key is dead. Shown on the key and on its plate — see there. */
const RECORD_NEEDS_ARM = 'Record: arm a track first - the red dot in its header';

/** The punch window, on the key's NAME and title and in its select — and, from
 *  T26, the way to CHANGE it at any width. `off` names no window because a key
 *  that says nothing about punch is a key that is not punching, but every mode
 *  including `off` carries the right-click hint: the menu is the only way in
 *  below 2xl, and an affordance nothing mentions is one nobody finds. It rides
 *  the `aria-label` as well as the title for the reason the dead key's does
 *  (see RecordKey): a title is mouse-only, and a disabled key takes no hover. */
const PUNCH_TITLE: Record<PunchMode, string> = {
  off: ' - right-click for punch',
  in: ' (punch in) - right-click for punch',
  out: ' (punch out) - right-click for punch',
  'in-out': ' (punch in-out) - right-click for punch',
};

/** The select's own option texts. Short because the footer row is 48px and this
 *  select sits beside the count-in one; the sr-only label says which is which. */
const PUNCH_OPTION: Record<PunchMode, string> = {
  off: 'Off',
  in: 'In',
  out: 'Out',
  'in-out': 'In/Out',
};

/** The right-click menu's own row texts. Each one starts with the word PUNCH
 *  the menu is titled with, so a speech command that reads a row off the screen
 *  finds it, and each says the whole mode rather than the select's abbreviation
 *  — the menu has the width the footer row has not. */
const PUNCH_MENU_LABEL: Record<PunchMode, string> = {
  off: 'Punch off',
  in: 'Punch in',
  out: 'Punch out',
  'in-out': 'Punch in-out',
};

/** What each mode actually does to a take, on the row's own tooltip. The window
 *  is the editor's LOOP region in every one of them. */
const PUNCH_MENU_TITLE: Record<PunchMode, string> = {
  off: 'Record the whole pass - no window',
  in: 'Start the take at the loop region and run on past its end',
  out: 'Keep the take from where it started and cut it at the loop region end',
  'in-out': 'Keep only what falls inside the loop region',
};

/**
 * The RECORD key, on a matte plate of its own — PLAY's grammar, the way the
 * workspace action key has one.
 *
 * It is rendered at TWO homes and is never in the tree at both: `hidden` is
 * display:none, so exactly one is in the accessibility tree at any width. Why
 * two, measured at the widths the footer actually has to survive (Chrome, the
 * EDIT tab, the numbers are getBoundingClientRect):
 *
 *   - 960px, the desktop app's minimum. The grid is 318.4 · 275.1 · 318.4 and
 *     the right track's utilities are 312px of that 318.4 — 6.4px spare. A
 *     48px key plus the track's 16px gap overflowed it by 57.6px and, with
 *     `justify-end` pinning the right edge, landed the key at 568–616px: ON the
 *     transport plate (342.4–617.6), covering RAND. Icon-only at 32px only
 *     brings that back to 33.6px of overlap — there is no width of key that
 *     fits. So below xl the key goes in the LEFT track instead, beside the
 *     click controls, where the now-playing block is `flex-1 min-w-0` and gives
 *     the room. Measured there: the key sits at 302.4–334.4, 8px clear of the
 *     plate, with 0px of row and footer overflow, and the cost is the
 *     now-playing title, 68.4px -> 32.4px. That is the trade, and it is the
 *     cheap side of it: the title truncates, where the right-track key was
 *     unreachable under RAND.
 *   - 1024px, the same home: key at 334.4–366.4, title 64.4px, no overflow.
 *   - 1280px (xl) and up, the right track has room once the utilities are
 *     placed (measured: key at 793.6–841.6, 16px — the track's own gap — off
 *     the plate, "Up Next" still 70.4px), so the key sits at the plate's right
 *     edge with its legend. The left track cannot host it there: the orb bubble
 *     takes 192px of it from xl and the now-playing title is already down to
 *     8.4px without any key. That is why the two homes are the two sides of xl
 *     and not one side with a narrower key.
 *
 * PLAY is unmoved by either: both tracks are `minmax(0,1fr)`, so the middle
 * `auto` column — and the plate centred in it — never shifts. Measured
 * plate-centre offset from the viewport centre: 0px at 960, 1024, 1280 and
 * 1536, and 0px of footer overflow at all four.
 *
 * A custom control (CLAUDE.md rule 3): the name and the state ride on the
 * BUTTON (aria-label + aria-pressed), never a wrapping <label>. The reason a
 * DEAD key is dead rides in the NAME rather than only in a title, because a
 * disabled key takes no hover of its own (`transportKey` ends in
 * `disabled:pointer-events-none`) and a title on the plate is mouse-only.
 *
 * THE PUNCH MENU (T26). The mode is a persisted preference, and its `<select>`
 * is `hidden 2xl:flex` — below 1536px a mode set on a wide screen could be read
 * off the key's title but not changed. So the key's PLATE takes a right-click
 * and opens a four-item radio menu. The listener is on the plate <div> and not
 * on the button for the reason the dead key's title is: `transportKey` ends in
 * `disabled:pointer-events-none`, so a dead button receives no contextmenu at
 * all — and the dead key is exactly when a user is most likely to be setting up
 * a punch before arming.
 *
 * NO `aria-haspopup` on the button. The button's action is RECORD; a menu that
 * opens from the plate's secondary gesture is not what the primary action does,
 * and announcing "has popup menu" on a key that records would be a lie about
 * what pressing it will do. The affordance travels in the NAME instead — every
 * `PUNCH_TITLE` ends in "right-click for punch", on the aria-label as well as
 * the title, so a screen-reader user hears it and a mouse user sees it.
 *
 * The keyboard opener (Shift+F10 and the Menu key, the platform's own gesture
 * for "context menu on the focused thing") sits on the plate too and catches
 * the keydown bubbling off the focused button. From there the menu drives
 * itself: ContextMenu focuses its first row on open, Arrow Up/Down and Home/End
 * move between the four, Enter or Space picks one, Escape closes — and on close
 * focus comes back to this RECORD button, so the gesture starts and ends on the
 * same key. It works on a LIVE key only: a disabled button is not focusable, so
 * no key event originates there. The 2xl select and a right-click are the two
 * ways in for that case; below 2xl a dead key's punch is mouse-only. Making the
 * plate itself focusable would put a new stop in the footer's tab order, which
 * is not this ticket's to spend.
 */
const RecordKey: React.FC<{
  status: RecordingStatus;
  armedCount: number;
  /** The punch window this press would write into — named in the title so the
   *  key never records less than the user expected without saying so. */
  punch: PunchMode;
  /** Pick a mode from the plate's right-click menu. */
  onSetPunch: (mode: PunchMode) => void;
  onPress: () => void;
  /** No legend, 32px — the below-xl form. */
  compact?: boolean;
  className?: string;
  tourId?: string;
}> = ({ status, armedCount, punch, onSetPunch, onPress, compact = false, className = '', tourId }) => {
  const dead = status === 'idle' && armedCount === 0;
  const live = status === 'counting' || status === 'recording';
  // The menu is per-key state: the two homes are never both displayed, so
  // neither can hold a menu the other opened.
  const [punchMenu, setPunchMenu] = useState<ContextMenuPosition | null>(null);
  const plateRef = useRef<HTMLDivElement | null>(null);
  const punchSuffix = PUNCH_TITLE[punch];
  const title = (dead
    ? RECORD_NEEDS_ARM
    : status === 'counting'
      ? 'Counting in - press to cancel'
      : status === 'idle'
        ? `Record a take on ${armedCount} armed track${armedCount === 1 ? '' : 's'} (R)`
        : 'Stop recording (R)') + punchSuffix;
  return (
    <div
      ref={plateRef}
      data-tour={tourId}
      title={dead ? RECORD_NEEDS_ARM + punchSuffix : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        setPunchMenu(menuAnchorFromEvent(e));
      }}
      onKeyDown={(e) => {
        // The platform's own "context menu here" gestures, caught as they
        // bubble off the focused button. ContextMenu clamps the anchor into
        // the viewport, so the plate's top-left is a safe one from a footer.
        if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return;
        e.preventDefault();
        const rect = plateRef.current?.getBoundingClientRect();
        setPunchMenu({ x: rect?.left ?? 0, y: rect?.top ?? 0 });
      }}
      className={`shrink-0 ${compact ? 'w-8' : 'w-12'} ${transportPlate} ${className}`}
    >
      <button
        type="button"
        onClick={onPress}
        disabled={dead}
        aria-label={
          (dead ? RECORD_NEEDS_ARM : status === 'idle' ? 'Record' : 'Stop recording') + punchSuffix
        }
        aria-pressed={status !== 'idle'}
        title={title}
        className={`${transportKey} w-full ${
          status === 'idle' ? (dead ? transportKeyDead : transportKeyOff) : transportKeyOn
        }`}
      >
        {/* The dot is red in every state and every theme — a record light is not
            the accent's to take. It pulses while the key is counting in or
            rolling, and the dead key's *:opacity-40 dims it with the legend. */}
        <Circle
          className={`w-3.5 h-3.5 fill-current text-red-500 ${live ? 'animate-pulse' : ''}`}
          strokeWidth={1.5}
          absoluteStrokeWidth
        />
        {/* Dropped in the compact form: the key is the dot, and its name still
            says Record. */}
        {!compact && <span aria-hidden="true" className={keyLabel}>REC</span>}
      </button>
      {/* Four settings of ONE thing, so every row is a `menuitemradio` carrying
          `aria-checked` and the live one is tinted and ticked. The tick is a
          fixed-width spacer on the other three so the labels stay on one
          column. The menu portals to <body>, so it costs the footer no layout:
          the plate's measured numbers at 960/1024/1280/1536 are untouched. */}
      <ContextMenu
        position={punchMenu}
        onClose={() => setPunchMenu(null)}
        title="Punch"
        minWidth="11rem"
        items={PUNCH_CHOICES.map((m) => ({
          type: 'item' as const,
          label: PUNCH_MENU_LABEL[m],
          title: PUNCH_MENU_TITLE[m],
          checked: m === punch,
          icon: <Check aria-hidden="true" className={`w-3 h-3 ${m === punch ? '' : 'opacity-0'}`} />,
          onSelect: () => onSetPunch(m),
        }))}
      />
    </div>
  );
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
        className={missing ? `${iconButtonBase} text-amber-400 hover:text-amber-300 hover:bg-white/5` : iconButton}
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
      {/* One quiet icon key the size of its neighbours: the pulse icon and the
          effect count in the accent. It opens the panel, which lists what is
          on the insert and holds Show in MIX and Bypass all. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Master FX: ${count} effect${plural} live on the output`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="master-fx-detail"
        title={`${count} effect${plural} on the master insert${takers > 0 ? ', some of which take level' : ''}`}
        className="p-1.5 rounded-md flex items-center gap-0.5 text-[rgb(var(--et-accent))] hover:bg-white/5 transition-colors"
      >
        <Activity className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="font-sans font-bold text-xs leading-4 tabular-nums" aria-hidden="true">{count}</span>
      </button>
      {open && (
        <div
          id="master-fx-detail"
          role="dialog"
          aria-label="Master FX"
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
const iconButtonBase = 'p-1.5 rounded-md transition-colors';
const iconButton = `${iconButtonBase} text-zinc-500 hover:text-white hover:bg-white/5`;
/** The same key while it cannot act: greyed, and carrying no hover utilities
 *  at all, because the theme scope re-points hover:text-* with unlayered rules
 *  that a disabled: variant cannot beat. */
const iconButtonOff = `${iconButtonBase} text-zinc-500 opacity-30 cursor-default`;
/** The Like key while liked: pink, with no zinc text utilities to fight. */
const iconButtonLiked = `${iconButtonBase} text-pink-500 hover:text-pink-400 hover:bg-white/5`;
const iconButtonLikedOff = `${iconButtonBase} text-pink-500 opacity-30 cursor-default`;

/** The visible legend beside each picker in the audio-output panel: Orbitron bold at 12px. */
const AUDIO_OUT_LEGEND = 'font-display font-bold text-xs leading-4 uppercase text-zinc-400 shrink-0';

/** The two info blocks either side of the transport share one width (192px,
 *  256px from 2xl), so the row is symmetric about PLAY and a long title never
 *  moves anything. It is a basis, not a fixed width: when a narrow window or
 *  the Master FX pill leaves less room, the block gives way and its title
 *  truncates, where a fixed width pushed CREATE off the screen and the
 *  now-playing block onto LOOP. */
const INFO_BLOCK = 'basis-48 2xl:basis-64 shrink min-w-0 overflow-hidden flex-col gap-0.5';

/** The word under the title: what the transport is doing, in a fixed-width
 *  box so PLAYING, PAUSED and IDLE all take the same room. */
const STATE_WORD = 'w-20 shrink-0 text-center font-display font-bold text-xs leading-4 uppercase rounded-xs border px-1';

/**
 * The click's level. `metronomeStore.setVolume` had no caller before this —
 * the click was stuck at its persisted default with no way to turn it down
 * against the mix. A custom SlideTrack, same as the master Volume control
 * elsewhere in this footer, so it carries its own aria-label and is never
 * wrapped in a <label>.
 *
 * Exported and props-only (no store read inside it) so it can be rendered in
 * isolation in a test, the same way `MixerStrips.tsx` exports `BusNameField`
 * to avoid standing up the whole drawer just to prove a control's wiring.
 * `volume` is the store's 0..1 scale; the 0..100 SlideTrack scale is the
 * footer's own convention (see the master Volume control below).
 */
export function MetronomeVolumeControl({ volume, onChange }: { volume: number; onChange: (v: number) => void }) {
  return (
    <SlideTrack
      min={0}
      max={100}
      step={1}
      value={Math.round(volume * 100)}
      onChange={(v) => onChange(v / 100)}
      className="w-10"
      ariaLabel="Metronome volume"
    />
  );
}

/**
 * The metronome level's below-2xl home. `MetronomeVolumeControl` itself is
 * gated `hidden 2xl:flex` beside the metronome toggle (see that wrapper's
 * comment), so below 2xl the only way to `setVolume` is a second gesture on
 * the toggle button itself — right-click, Shift+F10, or the Menu key, same
 * three openers RecordKey's plate documents for PUNCH. The toggle carries no
 * `disabled:pointer-events-none` (it is never disabled), so unlike RecordKey
 * the listener sits directly on the button rather than needing a wrapping
 * plate.
 *
 * Not built on `ContextMenu`: that primitive is a list of discrete items,
 * and this hosts one continuous control (`MetronomeVolumeControl`'s
 * `SlideTrack`), not a set of rows to choose between. This panel is a
 * smaller sibling that shares ContextMenu's contract — portal to <body>,
 * clamp into the viewport, dismiss on outside click / Escape / wheel-scroll,
 * and hand focus to its one control on open and back to the opener on close
 * — rather than reusing its item-rendering internals.
 */
export const MetronomeLevelPopover: React.FC<{
  position: ContextMenuPosition | null;
  onClose: () => void;
  volume: number;
  onChange: (v: number) => void;
  /** What each bar's clicks fall on (metronomeStore.clickMode): the piano roll's Beat select, the same setting. */
  clickMode?: ClickMode;
  onChangeClickMode?: (mode: ClickMode) => void;
}> = ({ position, onClose, volume, onChange, clickMode, onChangeClickMode }) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Focus the slider on open, and hand focus back to whatever opened the
  // panel on close — same contract as ContextMenu's first-row focus. Stable
  // identity: it closes only over the ref, never over props.
  const focusSlider = useCallback(
    () => panelRef.current?.querySelector<HTMLElement>('[role="slider"]') ?? null,
    [],
  );
  // Clamp into the viewport, outside-click/Escape/wheel dismiss (guarded
  // against the popover's own hosted slider — finding 1, T25b edit B
  // re-audit), and the open/close focus round trip — shared with ContextMenu
  // via `usePopoverShell`.
  const adjusted = usePopoverShell({ position, onClose, panelRef, focusOnOpen: focusSlider });

  // The panel portals to <body>, outside the Shell's `.edit-theme-scope`,
  // same reason ContextMenu carries this wrapper (finding 4, T25b edit B
  // re-audit) — without it, `et-ink-2` on the "Level" label below has no
  // `--et-*` value in scope and silently falls back to body ink.
  const editThemeId = useEditThemeStore((s) => s.themeId);
  const editThemeImage = useEditThemeStore((s) => s.customImage);
  const editTheme = React.useMemo(() => {
    const { vars, light } = resolveEditThemeVars(editThemeId, editThemeImage);
    const scopeVars = Object.fromEntries(Object.entries(vars).filter(([name]) => name !== '--et-root-bg'));
    return { vars: scopeVars, light };
  }, [editThemeId, editThemeImage]);

  if (!position) return null;
  const pos = adjusted ?? { x: -9999, y: -9999 };

  return createPortal(
    <div
      className="edit-theme-scope contents"
      data-et-light={editTheme.light ? '1' : undefined}
      style={editTheme.vars as React.CSSProperties}
    >
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Metronome level and beat"
      className="fixed z-10000 bg-[#0a080f] border border-purple-500/40 rounded shadow-[0_8px_24px_rgba(0,0,0,0.6)] px-3 py-2 flex flex-wrap items-center gap-2 font-sans text-xs font-bold select-none"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span className="et-ink-2 uppercase tracking-wider">Level</span>
      <MetronomeVolumeControl volume={volume} onChange={onChange} />
      {/* The EDIT click's Beat: the piano roll's Beat select, the same one
          setting (metronomeStore.clickMode), so 7/8 3+2+2 clicks its three
          group starts and 6/8 its dotted beats on the timeline as well. A
          native select with its own id, name and <label htmlFor>. */}
      {clickMode !== undefined && onChangeClickMode && (
        <span className="flex items-center gap-1.5" title={CLICK_MODE_TITLE[clickMode]}>
          <label htmlFor="metronome-click-mode" className="et-ink-2 uppercase tracking-wider">Beat</label>
          <select
            id="metronome-click-mode"
            name="metronomeClickMode"
            value={clickMode}
            onChange={(e) => onChangeClickMode(asClickMode(e.target.value))}
            className="rounded-md bg-white/5 border border-white/10 px-1 py-0.5 text-xs font-bold text-zinc-200 hover:text-white focus:outline-hidden focus:ring-1 focus:ring-[rgb(var(--et-accent))]"
            style={{ colorScheme: 'dark' }}
          >
            {CLICK_MODES.map((m) => (
              <option key={m} value={m} title={CLICK_MODE_TITLE[m]}>{CLICK_MODE_LABEL[m]}</option>
            ))}
          </select>
        </span>
      )}
    </div>
    </div>,
    document.body,
  );
};

/**
 * Whether a keydown on the metronome toggle should open
 * `MetronomeLevelPopover` — the platform's own "context menu here" gestures
 * (Shift+F10, the Menu/ContextMenu key), same predicate RecordKey's plate
 * uses inline for PUNCH. Exported and unit-tested on its own (finding 2,
 * T25b edit B re-audit) so `MetronomeToggle`'s onKeyDown below can never
 * drift from what the tests assert.
 */
export const opensLevelPopover = (e: { key: string; shiftKey: boolean }): boolean =>
  e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);

/**
 * The metronome toggle button plus its below-2xl level-popover opener,
 * split out from `PlayerFooter`'s body (finding 2, T25b edit B re-audit) so
 * the toggle -> popover wiring — the single route to `setVolume` below
 * 1536px — is renderable and testable without standing up the whole footer
 * and its store graph.
 */
export const MetronomeToggle: React.FC<{
  metronomeOn: boolean;
  onToggle: () => void;
  volume: number;
  onChangeVolume: (v: number) => void;
  clickMode?: ClickMode;
  onChangeClickMode?: (mode: ClickMode) => void;
  className?: string;
}> = ({ metronomeOn, onToggle, volume, onChangeVolume, clickMode, onChangeClickMode, className = '' }) => {
  const [levelPopover, setLevelPopover] = useState<ContextMenuPosition | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      {/* A custom control, so it carries its own accessible name and its
          state in aria-pressed — never a wrapping <label>. It is also the
          below-2xl opener for the level popover (right-click / Shift+F10 /
          Menu key) — see MetronomeVolumeControl's wrapper and
          MetronomeLevelPopover's own comment for why. The button carries no
          `disabled:pointer-events-none` (it is never disabled), so the
          listener sits on it directly rather than needing RecordKey's
          wrapping plate. */}
      <button
        ref={btnRef}
        type="button"
        onClick={onToggle}
        onContextMenu={(e) => {
          e.preventDefault();
          setLevelPopover(menuAnchorFromEvent(e));
        }}
        onKeyDown={(e) => {
          if (!opensLevelPopover(e)) return;
          e.preventDefault();
          const rect = btnRef.current?.getBoundingClientRect();
          setLevelPopover({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
        }}
        aria-label={`Metronome click ${metronomeOn ? 'on' : 'off'} - right-click for level and beat`}
        aria-pressed={metronomeOn}
        title={`Metronome click ${metronomeOn ? 'on' : 'off'} - the EDIT timeline's count${clickMode ? `, on ${CLICK_MODE_LABEL[clickMode].toLowerCase()}` : ''} - right-click for level and beat`}
        className={`${iconButton} ${metronomeOn ? 'text-[rgb(var(--et-accent))] bg-white/5' : ''} ${className}`}
      >
        <Triangle className="w-3.5 h-3.5" strokeWidth={1.5} absoluteStrokeWidth />
      </button>
      <MetronomeLevelPopover
        position={levelPopover}
        onClose={() => setLevelPopover(null)}
        volume={volume}
        onChange={onChangeVolume}
        clickMode={clickMode}
        onChangeClickMode={onChangeClickMode}
      />
    </>
  );
};

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
  // The heart belongs to the track it was pressed on; a new track starts
  // unliked. A stem or a render has no entry id, so its label counts too.
  useEffect(() => {
    setIsLiked(false);
  }, [currentEntryId, engineLabel]);

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

  // The transport click. `initMetronome` only subscribes (idempotent, so
  // StrictMode's double mount is free); the scheduler runs off the audio clock
  // and schedules nothing until EDIT plays with the metronome on.
  const metronomeOn = useMetronomeStore((s) => s.enabled);
  const toggleMetronome = useMetronomeStore((s) => s.toggle);
  const metronomeVolume = useMetronomeStore((s) => s.volume);
  const setMetronomeVolume = useMetronomeStore((s) => s.setVolume);
  const countInBars = useMetronomeStore((s) => s.countInBars);
  const setCountInBars = useMetronomeStore((s) => s.setCountInBars);
  const clickMode = useMetronomeStore((s) => s.clickMode);
  const setClickMode = useMetronomeStore((s) => s.setClickMode);
  useEffect(() => { initMetronome(); }, []);
  // A count-in in flight: the cancel that stops its clicks without ever having
  // moved the playhead. Cleared the moment the transport is released.
  const countInRef = useRef<(() => void) | null>(null);
  const [countingIn, setCountingIn] = useState(false);
  useEffect(() => () => { countInRef.current?.(); }, []);

  /* ── RECORD ──────────────────────────────────────────────────────────────
     state/recordingStore.ts owns the press, the count-in, the arming mirror
     and where a take lands; this key and the R shortcut are its only UI here
     (the arm button and the take meter live in the track header — T12b-b).
     `initRecording` only subscribes, so StrictMode's double mount is free and
     no input is opened until a press. */
  const recStatus = useRecordingStore((s) => s.status);
  const recArmedCount = useRecordingStore((s) => s.armedTrackIds.length);
  const recError = useRecordingStore((s) => s.lastError);
  const recNotice = useRecordingStore((s) => s.lastNotice);
  const recordPress = useRecordingStore((s) => s.recordPress);
  // The punch window is the editor's LOOP region; this only picks which of its
  // edges the pass may cross. `recordingStore` owns the crop.
  const recPunch = useRecordingPrefs((s) => s.punch);
  const setRecPunch = useRecordingPrefs((s) => s.setPunch);
  useEffect(() => { initRecording(); }, []);
  // A failure surfaces through the app's ONE status channel — the orb bubble
  // this footer already draws (statusNoticeStore -> OrbTipBubble), which also
  // files it in the LOG. "RECORD FAILED" reads as an error level from its
  // label, so the bubble draws it in the failure colours.
  useEffect(() => {
    if (!recError) return;
    postStatus(`RECORD FAILED: ${recError.message}`, { source: 'recording' });
  }, [recError]);
  // The INFORMATIONAL half of the same channel: a press that is proceeding
  // normally but has something to say (a punch mode with no loop region to
  // punch into). "RECORD" is the whole label — `statusNoticeStore.statusLevel`
  // reads the text before the first ": " and matches no error or warn word in
  // it — so this lands at info, where "RECORD FAILED" lands at error.
  useEffect(() => {
    if (!recNotice) return;
    postStatus(`RECORD: ${recNotice.text}`, { source: 'recording' });
  }, [recNotice]);
  /**
   * R toggles record, on EDIT only. The EDIT timeline's own bare-letter keys
   * are v / c / s / m / l and Shift+F (WaveformEditor's EDIT_SHORTCUTS list);
   * r is free there and everywhere else — the only other footer binding is
   * Ctrl/Cmd+K. Bound HERE rather than on the timeline because `inEditorMode`
   * is what gates the key, and because the press belongs to the transport.
   * The field exclusions are the timeline handler's, SELECT included, so a
   * bare letter never steals type-to-jump inside a dropdown.
   */
  useEffect(() => {
    if (!inEditorMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      // Shift is rejected above, so the uppercase arm is reached only with CAPS
      // LOCK on — where `key` is 'R' and `shiftKey` is false. It is not dead
      // code; dropping it would silently lose the shortcut for those users.
      if (e.key !== 'r' && e.key !== 'R') return;
      if (keyBelongsToFocusedControl(e)) return; // an "r" typed into a field; a focused fader does not count
      e.preventDefault();
      // Unconditional, unlike the key itself: with nothing armed the store
      // raises `nothing-armed` and the bubble says so, which beats a shortcut
      // that silently does nothing.
      useRecordingStore.getState().recordPress();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inEditorMode]);

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

  // A count-in holds a deferred "now start" that was decided for THIS surface
  // and this transport state. If something else starts playback, or the user
  // moves to a tab where PLAY means the DJ/VJ master instead, that release is
  // stale — drop it (and its clicks) rather than fire it somewhere it no longer
  // belongs. Nothing was moved during the count, so there is nothing to undo.
  useEffect(() => {
    if (!countingIn || !(isPlaying || isDjMode || isVjMode)) return;
    countInRef.current?.();
    countInRef.current = null;
    setCountingIn(false);
  }, [countingIn, isPlaying, isDjMode, isVjMode]);

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
    const startTransport = () => {
      if (inEditorMode && currentEntryId !== 'editor-timeline') {
        callEditorPlay();
      } else {
        toggle();
      }
    };
    // A second press during the count-in cancels it. Nothing has moved — the
    // playhead is where it was and no pass was recorded — so there is nothing
    // to undo, just the clicks to silence.
    if (countInRef.current) {
      countInRef.current();
      countInRef.current = null;
      setCountingIn(false);
      return;
    }
    // Pausing goes straight through; only STARTING counts in.
    if (isPlaying) { startTransport(); return; }
    setCountingIn(true);
    // metronomeCountIn releases the transport itself when there is no count-in
    // to play, in which case `done` is already true and there is nothing to
    // cancel — never store that no-op, or the next press would be swallowed.
    let done = false;
    const cancel = metronomeCountIn(() => {
      done = true;
      countInRef.current = null;
      setCountingIn(false);
      startTransport();
    }, { editor: inEditorMode, playing: isPlaying });
    countInRef.current = done ? null : cancel;
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

  // What the transport is doing, under the title: PLAYING while anything
  // plays, PAUSED with a track or a live surface held, IDLE with nothing.
  const stateWord = displayIsPlaying ? 'Playing' : hasTrack || isVjMode ? 'Paused' : 'Idle';
  // Like and Share are greyed out while nothing is playing. Share has no
  // action yet.
  const likeShareOff = !displayIsPlaying;

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
        {/* 1. The left track: the orb's speech bubble at the outer edge, the
            now-playing block against the transport. The orb is pinned flush
            to the bottom-left corner (0 to 112px) and overlaps the footer, so
            the track pads past it: the grid's 24px plus pl-24 puts the bubble
            8px off the orb. */}
        <div className="flex items-center gap-3 min-w-0 pl-28 2xl:pl-24">
          {/* The orb's speech bubble, from 2xl up, left of the scrub strip.
              The strip is w-3/5 mx-auto, so it starts at 20% of the window
              (307px at 1536, 360px at 1800, 384px at 1920) and the bubble,
              starting at 120px, has to end before that: 176px wide ends at
              296px, 224px from 1800px wide ends at 344px. Below 2xl there is
              no room beside the orb, so the bubble is hidden and
              OrbStatusFloat (App.tsx) shows notices by the orb. Status notices
              show in the bubble, and a click on one opens the LOG. */}
          <OrbTipBubble
            className="hidden 2xl:block"
            widthClass="w-44 min-[1800px]:w-56"
            onOpenLog={() => useBottomPanelStore.getState().setLogOpen(true)}
          />
          <div className="flex-1" />
          {/* Like and Share, always on screen beside the now-playing block,
              greyed out while nothing is playing. aria-disabled, not disabled:
              a key that greys under the keyboard focus (a track ending) keeps
              the focus instead of dropping it to the page. Like keeps one name
              and reports its state in aria-pressed. */}
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => {
                if (!likeShareOff) setIsLiked(!isLiked);
              }}
              aria-disabled={likeShareOff}
              aria-label="Like"
              aria-pressed={isLiked}
              title={likeShareOff ? 'Like: play a track first' : 'Like'}
              className={isLiked ? (likeShareOff ? iconButtonLikedOff : iconButtonLiked) : (likeShareOff ? iconButtonOff : iconButton)}
            >
              <Heart className={`w-3.5 h-3.5 ${isLiked ? 'fill-current' : ''}`} />
            </button>
            <button
              type="button"
              aria-disabled={likeShareOff}
              aria-label="Share"
              title={likeShareOff ? 'Share: play a track first' : 'Share'}
              className={likeShareOff ? iconButtonOff : iconButton}
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>
          </div>
          {/* Now playing, right-aligned against the transport: the mirror of
              Next on the other side. A label, not a heading: it heads no
              section. */}
          <div className={`flex ${INFO_BLOCK} items-end text-right`}>
            <span
              className="block w-full text-[13px] font-bold text-zinc-100 truncate tracking-tight leading-tight"
              title={displayLabel ?? undefined}
            >
              {displayLabel ?? 'No output loaded'}
            </span>
            <div className="flex min-w-0 max-w-full items-center gap-2 whitespace-nowrap">
              {isVjMode && vjSetCount > 0 && (
                <span
                  className={`flex min-w-0 overflow-hidden items-center gap-1 px-1.5 rounded border font-display font-bold text-xs leading-4 uppercase ${
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
                  {vjSetAcked ? <Check className="w-3 h-3 shrink-0" /> : <Cast className="w-3 h-3 shrink-0" />}
                  <span className="truncate">VJ {vjSetCount}</span>
                </span>
              )}
              <span className="shrink-0 font-sans font-bold text-xs leading-4 tabular-nums text-zinc-400">
                {displayDuration > 0 ? formatDuration(displayDuration) : '--:--'}
              </span>
              <span
                className={`${STATE_WORD} ${
                  displayIsPlaying
                    ? 'text-[rgb(var(--et-accent))] border-[rgb(var(--et-accent)/0.4)] bg-[rgb(var(--et-accent)/0.1)]'
                    : 'text-zinc-400 border-white/10'
                }`}
              >
                {stateWord}
              </span>
            </div>
          </div>
          {/* The click track, immediately left of the transport plate. It sits
              in THIS track rather than on the plate because the plate's key
              count (2 + PLAY + 2) is what holds PLAY on the viewport centre —
              a sixth key would push it off. The left track is 1fr either way,
              and the now-playing block beside it is flex-1 min-w-0, so the pair
              stays glued to the plate at every width without moving it. RECORD
              is in the RIGHT track for the same reason; see the plate comment
              below for why no sixth key can balance. */}
          <div className="flex shrink-0 items-center gap-1">
            {/* Toggle + below-2xl level-popover opener, in one component so
                the wiring between them is testable on its own — see
                MetronomeToggle's comment. */}
            <MetronomeToggle
              metronomeOn={metronomeOn}
              onToggle={toggleMetronome}
              volume={metronomeVolume}
              onChangeVolume={setMetronomeVolume}
              clickMode={clickMode}
              onChangeClickMode={setClickMode}
            />
            {/* MetronomeVolumeControl: gated `hidden 2xl:flex`, the count-in
                select's own PUNCH-select neighbour's pattern. This is a
                w-10 SlideTrack, 40px plus the same 4px gap — 44px, against
                the 960px measurements this file records above (RECORD's
                comment): 40.4px of slack
                before the plate, so 44px lands the compact RECORD key's right
                edge at 346.0 against the plate's left edge at 342.4, 3.6px of
                overlap — the same failure the rejected 68px PUNCH experiment
                caused (see the removed-experiment comment below), just
                smaller. So this renders nothing below 2xl, and the metronome
                TOGGLE button above takes the second gesture instead — same
                model as RecordKey's plate right-click for PUNCH — so
                `setVolume` stays reachable at every width, not only
                >=1536px. */}
            <div className="hidden 2xl:flex shrink-0 items-center gap-1">
              <MetronomeVolumeControl volume={metronomeVolume} onChange={setMetronomeVolume} />
            </div>
            {/* A native select, so it needs a real id/name and a <label htmlFor>.
                The label is sr-only: the footer row is 48px and the three option
                texts already say what the control is on screen. */}
            <label htmlFor="metronome-count-in" className="sr-only">Count-in bars</label>
            <select
              id="metronome-count-in"
              name="metronomeCountIn"
              value={countInBars}
              onChange={(e) => setCountInBars(Number(e.target.value) as CountInBars)}
              title="Bars of clicks before the transport starts"
              className="w-16 rounded-md bg-white/5 border border-white/10 px-1 py-0.5 text-xs text-zinc-300 hover:text-white focus:outline-hidden focus:ring-1 focus:ring-[rgb(var(--et-accent))]"
            >
              {COUNT_IN_CHOICES.map((n) => (
                <option key={n} value={n}>{n === 0 ? 'Off' : `${n} bar${n === 1 ? '' : 's'}`}</option>
              ))}
            </select>
            {/* PUNCH is NOT here, beside the count-in select it copies. It was,
                and it cost the whole now-playing title AND put RECORD on the
                transport plate: measured at 960px (Chrome, EDIT tab,
                getBoundingClientRect) a w-16 select plus the row's 4px gap took
                the title from batch 7's 32.4px to 0.4px — it is `flex-1
                min-w-0`, so it collapses silently rather than overflowing — and
                slid the
                compact RECORD key to 338-370, 27.6px INSIDE the plate
                (342.4-617.6), which is the exact failure RecordKey's comment
                below was written about. This track has no room at any width:
                from xl the orb bubble takes 192px of it and the title is down
                to 8.4px before any key. So the SELECT lives in the RIGHT track
                from 2xl — see there — and every width below it changes the mode
                through the RECORD key's own right-click menu, which costs the
                footer no layout at all (it portals to <body>). */}
            {/* RECORD's below-xl home, glued to the plate's LEFT edge — see
                RecordKey for the 960px measurement that put it here. Hidden
                from xl, where the copy at the plate's right edge takes over. */}
            {inEditorMode && (
              <RecordKey
                compact
                className="xl:hidden"
                status={recStatus}
                armedCount={recArmedCount}
                punch={recPunch}
                onSetPunch={setRecPunch}
                onPress={recordPress}
              />
            )}
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
            key count is what keeps PLAY dead centre.

            RECORD is NOT on this plate, for the same reason, and no spacer key
            was added to make room for it: PLAY is centred only while the keys
            either side of it pair up in width, and 12·12·14·14 (the four keys
            that are not PLAY) cannot be split into two equal halves once a
            fifth width joins them — 26 units a side is the only split, which
            leaves RECORD exactly 0 units. (Algebraically: with RECORD at r the
            half is 26 + r/2, so its own side must carry 26 - r/2 of
            {12,12,14,14}; the reachable subset sums are 0/12/14/24/26/28/…, so
            r is 0, or 4 — a 16px key. No key fits.) A blank sixth slot would
            balance it at the price of a dead tile on the plate AND 98px of
            plate width, which the 960px desktop minimum has not got: the side
            tracks are 318px there against 312px of utilities. So RECORD sits
            on a plate of its OWN, outside this one — at this plate's right
            edge from xl, and beside the click controls on its left below xl
            (the 960px right track has 6.4px spare against 312px of utilities;
            see RecordKey for the measurement). The middle grid column is
            untouched either way, both side columns are minmax(0,1fr), so this
            plate — and PLAY on its centre — stays on the viewport centre:
            measured 0px off centre at 960, 1280 and 1536. */}
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
            aria-label={countingIn ? 'Counting in - press to cancel' : displayIsPlaying ? 'Pause' : 'Play'}
            title={countingIn ? 'Counting in - press to cancel' : displayIsPlaying ? 'Pause' : 'Play'}
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

        {/* 3. The right track, mirroring the left: Next against the transport,
            the utilities and the action key at the outer edge. justify-end:
            if the utilities ever outgrow the track, they overflow toward the
            transport, never off the right edge of the window. */}
        <div className="flex items-center justify-end gap-3 min-w-0">
          {/* RECORD's xl-and-up home: at the transport plate's right edge and
              outside its centred group — see the plate comment above for why it
              cannot be a sixth key, and RecordKey for why this copy starts at
              xl. `mr-auto` is what glues it to the plate: "Up Next" is
              `flex-1`, so from xl it has already absorbed the track's free
              space and the margin resolves to 0. EDIT only (`inEditorMode`) —
              off EDIT there is no timeline to record onto, so neither copy is
              rendered and this row is byte-for-byte what it was. */}
          {inEditorMode && (
            <RecordKey
              tourId="record"
              className="hidden xl:flex"
              status={recStatus}
              armedCount={recArmedCount}
              punch={recPunch}
              onSetPunch={setRecPunch}
              onPress={recordPress}
            />
          )}
          {/* PUNCH, beside the RECORD key it belongs to, and from 2xl only —
              NOT xl, and not beside the count-in select it copies. A native
              select, so it keeps a real id/name and an sr-only <label htmlFor>
              (CLAUDE.md rule 3); the WINDOW itself is the editor's loop region,
              and this only picks which of its edges a take may cross.

              A w-16 select costs 68px wherever it goes (64 + the track's gap),
              and 2xl is the first width that HAS 68px. Measured in Chrome on
              the EDIT tab, getBoundingClientRect, this build:
                - 960:  in the LEFT track it took the now-playing title from
                        32.4px to 0.4px — 32.4 being what batch 7 left after
                        the compact RECORD key took the track's 68.4px title
                        down — and pushed that key to 338-370, ON the transport
                        plate (342.4-617.6), 27.6px of overlap. Not rendered
                        now: title back to 32.4px, RECORD 302.4-334.4, 8px
                        clear of the plate.
                - 1024: not rendered. Title 64.4px, RECORD 334.4-366.4, 8px
                        clear. Both widths: plate 0px off centre, 0px overflow.
                - 1280: in THIS track it took "Up Next" from 70.4px to 0px and
                        squeezed RECORD's clearance from 16px to 6.4px (the key
                        slid 793.6->784). Not rendered now: RECORD back at
                        793.6-841.6, 16px off the plate, "Up Next" 70.4px —
                        this width is byte-for-byte what T12b-a measured.
                - 1536: rendered, 985.6-1049.6, 16px right of the RECORD key
                        (921.6-969.6, still 16px off the plate). "Up Next"
                        126.4px -> 46.4px, which it can afford. Plate 0px off
                        centre, 0px footer overflow.
              Below 2xl this select is not rendered, and until T26 that meant a
              persisted mode could be READ off the RECORD key's title but not
              changed. Now the key's plate takes a right-click at every width
              and opens the same four choices (see RecordKey), so this select is
              the WIDE-screen convenience rather than the only way in — the two
              read and write the one `useRecordingPrefs.punch`, so whichever the
              user reaches for, the other shows it. */}
          {inEditorMode && (
            <div className="hidden 2xl:flex shrink-0 items-center gap-1">
              <label htmlFor="record-punch" className="sr-only">Punch recording window</label>
              <select
                id="record-punch"
                name="recordPunch"
                value={recPunch}
                onChange={(e) => setRecPunch(e.target.value as PunchMode)}
                title="Punch: record only inside the loop region"
                className="w-16 rounded-md bg-white/5 border border-white/10 px-1 py-0.5 text-xs text-zinc-300 hover:text-white focus:outline-hidden focus:ring-1 focus:ring-[rgb(var(--et-accent))]"
              >
                {PUNCH_CHOICES.map((m) => (
                  <option key={m} value={m}>{PUNCH_OPTION[m]}</option>
                ))}
              </select>
            </div>
          )}
          {/* Next, left-aligned against the transport: the mirror of now
              playing. Click loads it (no formal queue yet, so it is the next
              library entry, or a random other one while RAND is on, which the
              title says). From xl. Phrasing content only inside the button. */}
          <button
            type="button"
            onClick={loadNext}
            disabled={!nextEntry}
            title={nextEntry ? `Play next${isShuffle ? ' (random)' : ''}: ${nextEntry.title}` : 'Nothing queued'}
            className={`group/next hidden xl:flex mr-auto ${INFO_BLOCK} items-start text-left disabled:cursor-default`}
          >
            <span className="block w-full text-[13px] font-bold text-zinc-300 group-hover/next:text-white transition-colors truncate tracking-tight leading-tight">
              {nextEntry?.title ?? 'Nothing queued'}
            </span>
            <span className="flex items-center gap-2 whitespace-nowrap">
              <span className={`${STATE_WORD} text-zinc-400 border-white/10`}>Next</span>
              <span className="shrink-0 font-sans font-bold text-xs leading-4 tabular-nums text-zinc-400">
                {nextEntry ? formatDuration(nextEntry.duration) : '--:--'}
              </span>
            </span>
          </button>
          {/* The utilities, right-aligned at the outer edge: save and more,
              then the output (the Master FX pill, the output device, mute and
              volume), then the action key. The pill sits beside the volume
              because that is where the level it takes shows. Without the pill
              the set is 286px below xl (6px gaps, a 48px volume track), 296px
              at xl and 354px from 2xl (10px gaps, 96px), which leaves Next its
              192px at 1280 and its 256px at 1536; the pill, when a rack is
              live, takes its width out of Next. */}
          <div className="flex items-center gap-1.5 xl:gap-2 2xl:gap-2.5 shrink-0">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleDownload}
                disabled={!canSaveCopy}
                aria-label="Save a copy of the current track"
                title={saveCopyTitle}
                className={canSaveCopy ? iconButton : iconButtonOff}
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
                aria-label="Mute"
                aria-pressed={isMuted}
                title="Mute"
                className={iconButton}
              >
                {/* The crossed speaker means muted, and only that; a volume of
                    zero shows the bare speaker, so the icon and aria-pressed
                    never disagree. */}
                {isMuted
                  ? <VolumeX className="w-4 h-4 text-red-400" />
                  : volume === 0
                    ? <Volume className="w-4 h-4" />
                    : <Volume2 className="w-4 h-4" />}
              </button>
              <SlideTrack min={0} max={100} step={1} value={volume}
                onChange={(v) => setVolume(v)} className="w-12 2xl:w-24" ariaLabel="Volume" />
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
