/**
 * Feature-tour step definitions.
 *
 * Each step optionally names a `targetSelector` (a `[data-tour=...]` hook the
 * shell tags onto the real control) and a `tab` the tour switches to before
 * measuring, so the spotlight lands on the right on-screen element. The
 * Chimera step ships a lightweight, self-contained CSS "splice" motif instead
 * of embedding the full WebGL DNA scene — it stays cheap and always animates.
 */
import React, { useEffect, useRef } from 'react';
import { type CenterTab } from '../state/appUiStore';

export interface TourStep {
  id: string;
  title: string;
  body: React.ReactNode;
  /** CSS selector for the element to spotlight; centered card when absent/missing. */
  targetSelector?: string;
  /** Center tab to switch to before measuring the target. */
  tab?: CenterTab;
  /** Optional visual shown in the card (e.g. the Chimera splice motif). */
  media?: React.ReactNode;
}

/**
 * Small DNA-splice animation: two colored strands of beads slide in from the
 * sides and interleave at the center, evoking the Chimera CRISPR splice. Pure
 * CSS, self-contained, and it holds still under prefers-reduced-motion.
 */
// Two colored strands (purple A slides left->right, emerald B right->left) that
// interleave at center. Driven by the Web Animations API rather than a CSS
// @keyframes rule so it CANNOT be silently frozen by a `prefers-reduced-motion`
// media rule (the earlier CSS version did nothing on machines with reduce-motion
// on). Cadence per request: play the splice to the end, HOLD, play again, HOLD,
// forever.
const SPLICE_MS = 1400;
const SPLICE_HOLD_MS = 650;
const FRAMES_A: Keyframe[] = [
  { transform: 'translateX(-46px)', opacity: 0.15 },
  { transform: 'translateX(0) translateY(-6px)', opacity: 1, offset: 0.45 },
  { transform: 'translateX(0) translateY(6px)', opacity: 1, offset: 0.55 },
  { transform: 'translateX(46px)', opacity: 0.15 },
];
const FRAMES_B: Keyframe[] = [
  { transform: 'translateX(46px)', opacity: 0.15 },
  { transform: 'translateX(0) translateY(6px)', opacity: 1, offset: 0.45 },
  { transform: 'translateX(0) translateY(-6px)', opacity: 1, offset: 0.55 },
  { transform: 'translateX(-46px)', opacity: 0.15 },
];

const DnaSpliceMotif: React.FC = () => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const beads = Array.from({ length: 9 });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-strand]'));
    if (!els.length || typeof els[0].animate !== 'function') return; // no WAAPI

    // One paused animation per bead; the last frame is held (fill:both) so the
    // "hold" between plays shows the completed splice, not a snap back.
    const anims = els.map((el) => {
      const a = el.animate(el.dataset.strand === 'a' ? FRAMES_A : FRAMES_B, {
        duration: SPLICE_MS,
        easing: 'ease-in-out',
        fill: 'both',
      });
      a.pause();
      return a;
    });

    let cancelled = false;
    let timer: number | undefined;
    const cycle = () => {
      if (cancelled) return;
      anims.forEach((a) => {
        a.currentTime = 0;
        a.play();
      });
      anims[0]
        .finished.then(() => {
          if (cancelled) return;
          timer = window.setTimeout(cycle, SPLICE_HOLD_MS); // HOLD, then replay
        })
        .catch(() => {
          /* cancelled mid-play on unmount */
        });
    };
    cycle();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      anims.forEach((a) => a.cancel());
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="relative h-16 w-full overflow-hidden rounded bg-black/40 border border-white/5"
    >
      <div className="absolute inset-0 flex items-center justify-center gap-1.5">
        {beads.map((_, i) => (
          <div key={i} className="relative flex flex-col items-center gap-3">
            <span
              data-strand="a"
              className="w-2 h-2 rounded-full bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.7)]"
            />
            <span
              data-strand="b"
              className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]"
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'settings',
    title: 'Start here: Settings',
    body: (
      <>
        Open the app menu (top right) and go to Settings. If a feature looks dead or something seems
        missing, enable or download the models and modules it needs there. Most "nothing happens"
        moments are just a disabled module.
      </>
    ),
    targetSelector: '[data-tour="app-menu"]',
  },
  {
    id: 'make',
    title: 'Make music',
    body: <>Type a prompt in MAKE and the AI models generate audio from it. This is the fastest way in.</>,
    targetSelector: '[data-tour="tab-make"]',
    tab: 'make',
  },
  {
    id: 'chimera',
    title: 'Splice sounds with Chimera',
    body: (
      <>
        Chimera braids two or more sounds into one, splicing their chunks together like DNA strands.
        Add clips to the Chimera stack in MAKE and generate the blend.
      </>
    ),
    targetSelector: '[data-tour="tab-make"]',
    tab: 'make',
    media: <DnaSpliceMotif />,
  },
  {
    id: 'draw',
    title: 'Draw sound',
    body: (
      <>
        The DRAW panel turns a sketch into generative music you can play and record straight into the
        library or EDIT.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-draw"]',
  },
  {
    id: 'stems',
    title: 'Stems anywhere',
    body: (
      <>
        Right-click any track in the library and choose <span className="text-zinc-200">Separate stems</span> to
        split it into parts. You can also turn on auto-stems in Settings.
      </>
    ),
    targetSelector: '[data-tour="library"]',
  },
  {
    id: 'underfit',
    title: 'Train your own',
    body: (
      <>
        Train a custom LoRA on your own audio in UNDERFIT, then generate in your own style. It runs as
        its own trainer dashboard inside the app.
      </>
    ),
    targetSelector: '[data-tour="tab-underfit"]',
    tab: 'underfit',
  },
  {
    id: 'tour',
    title: 'Book the road',
    body: (
      <>
        TOUR finds venues and promoters by region so you can plan a run. Search a city, add stops
        across as many towns as you like, then optimize the drive order or lay the stops out on a
        calendar with per-leg drive times.
      </>
    ),
    targetSelector: '[data-tour="tab-tour"]',
    tab: 'tour',
  },
];
