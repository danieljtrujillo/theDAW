import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * The assistant orb's speech bubble.
 *
 * Sits in the footer slot the G-Search field used to occupy and cycles short
 * tips about the orb itself and about theDAW. Purely ambient: it never steals
 * focus and never opens anything on its own — clicking it advances to the next
 * tip, and the caller can wire onOpen to raise the assistant panel.
 *
 * Tips rotate on a timer that PAUSES on hover, so a tip can actually be read
 * rather than vanishing mid-sentence.
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
  'hit COMMIT EDIT to bounce the arrangement to one file',
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
  'drag me anywhere — i stay put after that',
];

const ROTATE_MS = 9000;
const GREETING_MS = 20000;

interface OrbTipBubbleProps {
  /** Raise the assistant panel. Optional — without it the bubble is inert. */
  onOpen?: () => void;
  className?: string;
}

export const OrbTipBubble: React.FC<OrbTipBubbleProps> = ({ onOpen, className }) => {
  // -1 is the greeting; 0..n index into TIPS. Every launch opens on the
  // greeting, then enters the tip rotation at a random point so it is not the
  // same three lines each session.
  const firstTip = useMemo(() => Math.floor(Math.random() * TIPS.length), []);
  const [index, setIndex] = useState(-1);
  const [visible, setVisible] = useState(true);
  const paused = useRef(false);

  const text = index < 0 ? GREETING : TIPS[index];

  const swap = (next: (i: number) => number, fade = 420) => {
    setVisible(false);
    window.setTimeout(() => {
      setIndex(next);
      setVisible(true);
    }, fade);
  };

  useEffect(() => {
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
  }, [index, firstTip]);

  const advance = () => swap((i) => (i < 0 ? firstTip : (i + 1) % TIPS.length), 200);

  return (
    <button
      type="button"
      aria-live="polite"
      aria-label={`Assistant tip: ${text}. Activate for the next tip.`}
      onMouseEnter={() => { paused.current = true; }}
      onMouseLeave={() => { paused.current = false; }}
      onClick={() => (onOpen ? onOpen() : advance())}
      className={[
        // FIXED width, not max-width: the now-playing title, duration and
        // sample rate sit immediately to the right, and a bubble that resized
        // with its text dragged them back and forth on every rotation.
        'group/tip relative shrink-0 w-56 text-left',
        'rounded-2xl rounded-bl-sm border border-purple-500/25 bg-purple-500/8',
        'px-3 py-1.5 hover:bg-purple-500/15 hover:border-purple-400/40',
        'transition-colors cursor-pointer',
        className || '',
      ].join(' ')}
    >
      {/* Bubble tail, bottom-left, so it reads as speech rather than a chip. */}
      <span
        aria-hidden="true"
        className="absolute -bottom-1 left-2 h-2 w-2 rotate-45 border-b border-l border-purple-500/25 bg-purple-500/8 group-hover/tip:bg-purple-500/15"
      />
      {/* Wraps and grows DOWNWARD; never truncates. The footer is 56px tall and
          the bubble is vertically centred in it, so extra lines expand evenly
          without pushing the transport off-centre. */}
      <span
        className={[
          'block whitespace-normal wrap-break-word font-mono text-[9px] leading-relaxed tracking-wide text-purple-100/85',
          'transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0',
        ].join(' ')}
      >
        {text}
      </span>
    </button>
  );
};

export default OrbTipBubble;
