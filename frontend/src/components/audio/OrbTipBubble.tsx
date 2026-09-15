import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useStatusNotice,
  useStatusNoticeStore,
  type StatusLevel,
  type StatusNotice,
} from '../../state/statusNoticeStore';
import { noticeLift } from './noticeLift';

/**
 * The assistant orb's speech bubble.
 *
 * Sits in the footer slot the G-Search field held and cycles short tips about
 * the orb itself and about theDAW. It never steals focus and never opens
 * anything on its own: clicking a tip advances to the next one, and the caller
 * can wire onOpen to raise the assistant panel.
 *
 * Tips rotate on a timer that PAUSES on hover, so a tip can be read before it
 * changes.
 *
 * Status notices (state/statusNoticeStore.ts: every useStatusBarStore.setText
 * line) take the bubble over for a few seconds, in failure colours when they
 * report a failure, and the bubble then returns to the tip it showed. A notice
 * draws in a wider panel on the theme's opaque popup surface, anchored to the
 * bottom of the slot and growing upward to four lines, so the footer row and
 * the now-playing title keep their places and a failure keeps its ending.
 * Hovering holds a notice as it holds a tip; clicking a notice lets it go and
 * opens the LOG (onOpenLog). The notice text is also written to a polite live
 * region beside the bubble, which stays in the accessibility tree at the widths
 * where the bubble itself is hidden.
 */

/**
 * The opening line. Shown first on every launch and held for GREETING_MS —
 * long enough to actually be noticed — before the how-to tips start cycling.
 */
const GREETING = 'click me for assistance';

/**
 * How to OPERATE theDAW: each one is an action the user can take right now.
 * Kept short so the bubble stays one or two lines.
 */
const TIPS: string[] = [
  'type a description in MAKE, then hit CREATE',
  'drop audio on MAKE to render from your own sound',
  'paint a region, then CREATE to redo just that part',
  'stack 2+ clips in CHIMERA to blend them',
  'drag a clip to the EDIT timeline to arrange it',
  'use the cut tool to split a clip, then drag its edge to fade',
  'hit MIXDOWN to bounce the arrangement to one file',
  'drag effects into the MIX chain to reorder them',
  'load a deck, press SYNC, then move the crossfader',
  'pull a stem fader to drop the vocal mid-track',
  'press LEARN in SWAY, then move a control to bind it',
  'drag controls onto the FOUNDRY canvas to build a panel',
  'click a node in NODEFI, then press RUN',
  'search a region in TOUR to find venues, then build a route',
  'open LEARN to see what any track was made from',
  'open SCORE to read a track as sheet music or tab',
  'right-click a library row for stems, MIDI and export',
  'ctrl-k opens the library',
  'click me once, then drag me anywhere — i stay put',
];

const ROTATE_MS = 9000;
const GREETING_MS = 20000;

export type BubbleTone = 'tip' | StatusLevel;

export interface BubbleToneClasses {
  border: string;
  /** Translucent fill, for a tip on the footer's own surface. */
  fill: string;
  hover: string;
  tailHover: string;
  /** Gradient stops of the same tint, laid over an opaque surface (noticeSurface). */
  layer: string;
  text: string;
  /** The dot a notice wears; tips wear none. */
  dot: string;
}

const ACCENT: BubbleToneClasses = {
  border: 'border-[rgb(var(--et-accent)/0.35)]',
  fill: 'bg-[rgb(var(--et-accent)/0.1)]',
  hover: 'hover:bg-[rgb(var(--et-accent)/0.18)]',
  tailHover: 'group-hover/tip:bg-[rgb(var(--et-accent)/0.18)]',
  layer: 'from-[rgb(var(--et-accent)/0.14)] to-[rgb(var(--et-accent)/0.14)]',
  // The theme's primary ink (index.css @utility et-ink). The light-theme rules
  // re-point zinc text inside a gradient surface to the inverse ink, which drew
  // white on the notice panel; they never touch this utility.
  text: 'et-ink',
  dot: '',
};

/**
 * Classes per tone. Tips and info notices take the theme accent (--et-accent);
 * warn and error take amber and red, which the theme scope in index.css
 * re-points for light themes. No shadow and no glow.
 */
export const BUBBLE_TONE: Record<BubbleTone, BubbleToneClasses> = {
  tip: ACCENT,
  info: { ...ACCENT, dot: 'bg-[rgb(var(--et-accent))]' },
  warn: {
    border: 'border-amber-500/60',
    fill: 'bg-amber-500/15',
    hover: 'hover:bg-amber-500/25',
    tailHover: 'group-hover/tip:bg-amber-500/25',
    layer: 'from-amber-500/15 to-amber-500/15',
    text: 'text-amber-200',
    dot: 'bg-amber-500',
  },
  error: {
    border: 'border-red-500/60',
    fill: 'bg-red-500/15',
    hover: 'hover:bg-red-500/25',
    tailHover: 'group-hover/tip:bg-red-500/25',
    layer: 'from-red-500/15 to-red-500/15',
    text: 'text-red-200',
    dot: 'bg-red-500',
  },
};

/**
 * A notice's surface and border: the theme's opaque popup colour (bg-[#0a080f],
 * re-pointed to --et-popup by the theme scope) with the tone's tint over it, so
 * the text reads over whatever the notice covers.
 */
export function noticeSurface(tone: BubbleToneClasses): string {
  return `bg-[#0a080f] bg-linear-to-b ${tone.layer} ${tone.border}`;
}

/** A notice longer than this whose detail is an absolute path draws the file name. */
const SHORTEN_PATH_OVER = 56;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/**
 * The text a bubble draws for a notice. A long notice whose detail is an
 * absolute path keeps its label and the file name, as `LABEL: …\name.ext`;
 * every other notice is drawn as written. The full text stays in the bubble's
 * title and label, the live region and the LOG.
 */
export function bubbleText(text: string): string {
  if (text.length <= SHORTEN_PATH_OVER) return text;
  const cut = text.indexOf(': ');
  if (cut < 0) return text;
  const detail = text.slice(cut + 2);
  if (!ABSOLUTE_PATH.test(detail)) return text;
  const sep = detail.includes('\\') ? '\\' : '/';
  const name = detail.slice(detail.lastIndexOf(sep) + 1);
  return name ? `${text.slice(0, cut)}: …${sep}${name}` : text;
}

/** What a bubble's button is called while it shows `notice`. */
export function noticeLabel(notice: StatusNotice, opensLog: boolean): string {
  const stop = /[.!?]$/.test(notice.text) ? '' : '.';
  return `Status: ${notice.text}${stop} ${opensLog ? 'Activate to open the LOG.' : 'Activate to dismiss.'}`;
}

/**
 * The notice a bubble draws: the one up now, or while `hovered` the last one
 * that was up, so a notice under the pointer stays until the pointer leaves.
 * The returned function drops the held notice (after a click). A caller whose
 * button can leave the page while hovered must clear `hovered` itself, since
 * that button never gets its mouseleave.
 */
export function useShownNotice(hovered: boolean): [StatusNotice | null, () => void] {
  const current = useStatusNotice();
  const [held, setHeld] = useState<StatusNotice | null>(null);
  useEffect(() => {
    if (!hovered) setHeld(null);
    else if (current) setHeld(current);
  }, [hovered, current]);
  return [current ?? (hovered ? held : null), () => setHeld(null)];
}

interface OrbTipBubbleProps {
  /** Raise the assistant panel. Optional — without it a click on a tip advances it. */
  onOpen?: () => void;
  /** Open the LOG. A click on a status notice calls it. */
  onOpenLog?: () => void;
  className?: string;
  /** The bubble's width utilities (default `w-56`). A fixed width, so what sits beside it never shifts. */
  widthClass?: string;
}

export const OrbTipBubble: React.FC<OrbTipBubbleProps> = ({ onOpen, onOpenLog, className, widthClass = 'w-56' }) => {
  // -1 is the greeting; 0..n index into TIPS. Every launch opens on the
  // greeting, then enters the tip rotation at a random point so it is not the
  // same three lines each session.
  const firstTip = useMemo(() => Math.floor(Math.random() * TIPS.length), []);
  const [index, setIndex] = useState(-1);
  const [visible, setVisible] = useState(true);
  const [hovered, setHovered] = useState(false);
  const paused = useRef(false);
  const fadeTimer = useRef<number | null>(null);
  const live = useStatusNotice();
  const [notice, release] = useShownNotice(hovered);
  const noticeUp = notice !== null;
  const slotRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // A notice taller than the room above the slot rises clear of the scrub
  // strip; see noticeLift. Measured on every layout the panel can change in.
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    if (!noticeUp) {
      setLift(0);
      return;
    }
    const measure = () => {
      const slot = slotRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!slot || !panel) return;
      const strip = document.querySelector('[data-scrub-strip]')?.getBoundingClientRect() ?? null;
      // The lift moves the panel's box and never reflows its text, so the
      // height measured in place is the height it keeps once lifted.
      setLift(noticeLift(slot, panel.height, strip));
    };
    measure();
    // jsdom, and any runtime without it, simply measures once.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (ro && panelRef.current) ro.observe(panelRef.current);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
    // notice, not noticeUp: a new notice of another length re-measures.
  }, [noticeUp, notice]);

  const tip = index < 0 ? GREETING : TIPS[index];

  const swap = (next: (i: number) => number, fade = 420) => {
    setVisible(false);
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => {
      fadeTimer.current = null;
      setIndex(next);
      setVisible(true);
    }, fade);
  };

  useEffect(() => () => {
    if (fadeTimer.current !== null) window.clearTimeout(fadeTimer.current);
  }, []);

  useEffect(() => {
    // A notice stops the rotation, so the bubble comes back to the tip it
    // showed, and that tip gets a full dwell once the notice is gone. A notice
    // that arrives mid-fade cancels the pending swap for the same reason.
    if (noticeUp) {
      if (fadeTimer.current !== null) {
        window.clearTimeout(fadeTimer.current);
        fadeTimer.current = null;
        setVisible(true);
      }
      return;
    }
    // The greeting gets its own longer dwell before the rotation starts.
    const delay = index < 0 ? GREETING_MS : ROTATE_MS;
    let id = window.setTimeout(function tick() {
      // Hovering holds the current tip so it can be read. Re-check shortly
      // rather than returning — returning would abandon the timer and stop the
      // rotation permanently for anyone who happened to hover as it fired.
      if (paused.current) {
        id = window.setTimeout(tick, 800);
        return;
      }
      swap((i) => (i < 0 ? firstTip : (i + 1) % TIPS.length));
    }, delay);
    return () => window.clearTimeout(id);
    // Re-armed on every index change, so each line gets a full dwell.
  }, [index, firstTip, noticeUp]);

  const advance = () => swap((i) => (i < 0 ? firstTip : (i + 1) % TIPS.length), 200);

  const onClick = () => {
    if (notice) {
      // The notice panel collapses to the tip under a pointer that has not
      // moved, so no mouseleave may follow: a hover left set would hold every
      // later notice past its time.
      paused.current = false;
      setHovered(false);
      release();
      useStatusNoticeStore.getState().dismiss();
      onOpenLog?.();
      return;
    }
    if (onOpen) onOpen();
    else advance();
  };

  const tone = BUBBLE_TONE[notice ? notice.level : 'tip'];

  return (
    <>
      {/* FIXED width, not max-width: the now-playing title, duration and sample
          rate sit immediately to the right, and a slot that resized with its
          text dragged them back and forth on every rotation. The slot is a
          two-line bubble tall; a tip centres in it, and a notice panel is
          anchored to its bottom and grows upward. A notice too tall to grow
          inside the footer's own row rises clear of the scrub strip instead of
          over it (noticeLift), so the playhead is never covered. */}
      <div ref={slotRef} className={['relative shrink-0 h-10.5', widthClass, className || ''].join(' ')}>
        <div
          ref={panelRef}
          style={notice && lift > 0 ? { bottom: lift } : undefined}
          className={
            notice
              // -left-8: a notice leaves the slot's indent and sits against the
              // orb, which is what it is speaking for. The slot is inset 168px
              // (the grid's px-6 plus pl-36) to clear the 112px orb, so -32px
              // puts the panel's edge 8px off the orb's.
              ? 'absolute -left-8 bottom-0 z-10 w-72 min-h-full flex flex-col justify-center'
              : 'absolute inset-0 flex flex-col justify-center'
          }
        >
          <button
            type="button"
            aria-label={notice ? noticeLabel(notice, Boolean(onOpenLog)) : `Assistant tip: ${tip}. Activate for the next tip.`}
            title={notice?.text}
            onMouseEnter={() => { paused.current = true; setHovered(true); }}
            onMouseLeave={() => { paused.current = false; setHovered(false); }}
            onClick={onClick}
            className={
              notice
                ? `relative block w-full text-left rounded-2xl border px-3 py-1 cursor-pointer ${noticeSurface(tone)}`
                : [
                    'group/tip relative block w-full text-left',
                    'rounded-2xl rounded-bl-sm border px-3 py-1 transition-colors cursor-pointer',
                    tone.border,
                    tone.fill,
                    tone.hover,
                  ].join(' ')
            }
          >
            {notice ? (
              // A notice's tail sits on its left edge at mid-height, pointing at
              // the orb, so a tall panel never pushes it past the window's edge.
              <span
                aria-hidden="true"
                className={`absolute -left-1 top-1/2 -translate-y-1/2 size-2 rotate-45 border-b border-l ${noticeSurface(tone)}`}
              />
            ) : (
              // Bubble tail, bottom-left, so a tip reads as speech rather than a chip.
              <span
                aria-hidden="true"
                className={`absolute -bottom-1 left-2 size-2 rotate-45 border-b border-l ${tone.border} ${tone.fill} ${tone.tailHover}`}
              />
            )}
            {/* A tip wraps to two lines (16px each) and never truncates. A notice
                stops at four lines (a long path shows its file name, bubbleText),
                and its full text is in the title, the label, the live region and
                the LOG. */}
            <span
              className={[
                'flex items-start gap-1.5 text-xs font-semibold leading-4',
                tone.text,
                'transition-opacity duration-300',
                noticeUp || visible ? 'opacity-100' : 'opacity-0',
              ].join(' ')}
            >
              {notice && <span aria-hidden="true" className={`mt-1 size-2 shrink-0 rounded-full ${tone.dot}`} />}
              <span className={notice ? 'min-w-0 line-clamp-4 wrap-anywhere' : 'min-w-0 whitespace-normal wrap-break-word'}>
                {notice ? bubbleText(notice.text) : tip}
              </span>
            </span>
          </button>
        </div>
      </div>
      <span role="status" className="sr-only">{live?.text ?? ''}</span>
    </>
  );
};

export default OrbTipBubble;
