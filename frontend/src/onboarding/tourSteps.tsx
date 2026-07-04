/**
 * Feature-tour step definitions.
 *
 * Each step optionally names a `targetSelector` (a `[data-tour=...]` hook the
 * shell tags onto the real control) and a `tab` the tour switches to before
 * measuring, so the spotlight lands on the right on-screen element. The
 * Chimera step ships a lightweight, self-contained CSS "splice" motif instead
 * of embedding the full WebGL DNA scene — it stays cheap and always animates.
 */
import React from 'react';
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
const DnaSpliceMotif: React.FC = () => {
  const beads = Array.from({ length: 9 });
  const css = `
@keyframes tour-splice-a {
  0%   { transform: translateX(-46px) translateY(0); opacity: 0.15; }
  45%  { transform: translateX(0) translateY(-6px); opacity: 1; }
  55%  { transform: translateX(0) translateY(6px); opacity: 1; }
  100% { transform: translateX(46px) translateY(0); opacity: 0.15; }
}
@keyframes tour-splice-b {
  0%   { transform: translateX(46px) translateY(0); opacity: 0.15; }
  45%  { transform: translateX(0) translateY(6px); opacity: 1; }
  55%  { transform: translateX(0) translateY(-6px); opacity: 1; }
  100% { transform: translateX(-46px) translateY(0); opacity: 0.15; }
}
.tour-splice-bead { animation-duration: 2.2s; animation-iteration-count: infinite; animation-timing-function: ease-in-out; }
@media (prefers-reduced-motion: reduce) {
  .tour-splice-bead { animation: none !important; opacity: 0.9 !important; transform: none !important; }
}`;
  return (
    <div className="relative h-16 w-full overflow-hidden rounded bg-black/40 border border-white/5">
      <style>{css}</style>
      <div className="absolute inset-0 flex items-center justify-center gap-1.5">
        {beads.map((_, i) => (
          <div key={i} className="relative flex flex-col items-center gap-3">
            <span
              className="tour-splice-bead w-1.5 h-1.5 rounded-full bg-purple-400 shadow-[0_0_6px_rgba(168,85,247,0.7)]"
              style={{ animationName: 'tour-splice-a', animationDelay: `${i * 0.12}s` }}
            />
            <span
              className="tour-splice-bead w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]"
              style={{ animationName: 'tour-splice-b', animationDelay: `${i * 0.12}s` }}
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
];
