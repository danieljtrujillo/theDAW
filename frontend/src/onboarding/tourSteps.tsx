/**
 * Feature-tour step definitions.
 *
 * Each step optionally names a `targetSelector` (a `[data-tour=...]` hook or
 * any stable selector on the real control) and a `tab` the tour switches to
 * before measuring, so the spotlight lands on the right on-screen element. A
 * step whose target lives in a collapsible panel (library rail, bottom dock)
 * carries a `prepare` hook that opens the panel and returns an undo, so the
 * tour never rearranges the workspace permanently. A target that cannot be
 * found still renders as a centred card — never a blank spotlight.
 *
 * Copy rules: short, benefit-first, no internal jargon; one idea per step.
 */
import React from 'react';
import { type CenterTab, useAppUiStore } from '../state/appUiStore';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { ChimeraSpliceMotif } from './ChimeraSpliceMotif';

export interface TourStep {
  id: string;
  title: string;
  body: React.ReactNode;
  /** Smaller secondary line under the body ("Tip: ..."). */
  tip?: React.ReactNode;
  /** CSS selector for the element to spotlight; centred card when absent/missing. */
  targetSelector?: string;
  /** `first` (default) spotlights the first match; `union` the bounding box of all matches. */
  targetMode?: 'first' | 'union';
  /** Center tab to switch to before measuring the target. */
  tab?: CenterTab;
  /**
   * Runs when the step becomes active (after the tab switch). May return an
   * undo that runs when the step is left or the tour closes.
   */
  prepare?: () => (() => void) | void;
  /** Optional visual shown in the card (e.g. the Chimera splice motif). */
  media?: React.ReactNode;
  /** Label for the primary button on this step (defaults to Next / Finish). */
  primaryLabel?: string;
  /** Tab to land on when the tour finishes from this step. */
  finishTab?: CenterTab;
}

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-block rounded border border-white/15 bg-white/5 px-1 font-mono text-[9px] leading-4 text-zinc-300">
    {children}
  </kbd>
);

const Em: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="font-bold text-zinc-100">{children}</span>
);

/** Open the library rail for the step; close it again afterwards if we opened it. */
const openLibraryRail = (): (() => void) | void => {
  const ui = useAppUiStore.getState();
  if (ui.isRightPanelOpen) return;
  ui.setRightPanelOpen(true);
  return () => useAppUiStore.getState().setRightPanelOpen(false);
};

/** Show the DRAW tab in the bottom dock; restore the dock exactly as it was afterwards. */
const openDrawDock = (): (() => void) | void => {
  const dock = useBottomPanelStore.getState();
  const wasOpen = dock.isOpen;
  const prevTab = dock.activeTab;
  dock.showTab('draw');
  return () => {
    const d = useBottomPanelStore.getState();
    if (!wasOpen) d.setOpen(false);
    d.setActiveTab(prevTab);
  };
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to theDAW',
    body: (
      <>
        Make music from a text prompt, splice sounds together, then edit, mix and perform — all in one
        place. This one-minute tour shows you where everything is.
      </>
    ),
    tip: (
      <>
        <Kbd>→</Kbd> next · <Kbd>←</Kbd> back · <Kbd>Esc</Kbd> leave. Replay it any time from HOME or
        the <Em>☰</Em> menu.
      </>
    ),
    primaryLabel: 'Start tour',
  },
  {
    id: 'workspaces',
    title: 'One tab per job',
    body: (
      <>
        <Em>MAKE</Em> generates audio, <Em>EDIT</Em> arranges it, <Em>MIX</Em> polishes it, and{' '}
        <Em>PERFORM</Em>, <Em>DJ</Em> and <Em>VJ</Em> play it live. Switch any time — nothing is lost.
      </>
    ),
    targetSelector: '[data-tour^="tab-"]',
    targetMode: 'union',
  },
  {
    id: 'make',
    title: 'Describe a sound',
    body: (
      <>
        Type what you want to hear — <span className="italic text-zinc-300">“warm lo-fi beat, vinyl
        crackle, 90 BPM”</span> — then press <Em>CREATE</Em> in the bottom-right corner. The result lands
        in your library.
      </>
    ),
    tip: <>The first run downloads a model; the download dock shows progress.</>,
    targetSelector: 'textarea[name="gen-prompt"]',
    tab: 'make',
  },
  {
    id: 'chimera',
    title: 'Splice sounds with Chimera',
    body: (
      <>
        Drop two or more clips into the Chimera stack. Chimera cuts them into chunks and splices them
        into one new sound — like combining DNA strands.
      </>
    ),
    targetSelector: '[data-crispr-output]',
    tab: 'make',
    media: <ChimeraSpliceMotif className="h-24 w-full" />,
  },
  {
    id: 'library',
    title: 'Your library',
    body: (
      <>
        Everything you make or import shows up here. It is empty right now — your first generation
        fills it. Right-click any track for stems, MIDI and export.
      </>
    ),
    tip: <>Drag tracks from here into EDIT, DJ or the Chimera stack.</>,
    targetSelector: '[data-tour="library"]',
    prepare: openLibraryRail,
  },
  {
    id: 'draw',
    title: 'Draw to play',
    body: (
      <>
        The bottom dock holds live tools. <Em>DRAW</Em> turns a sketch into generative music you can
        record straight into the library.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-draw"]',
    prepare: openDrawDock,
  },
  {
    id: 'settings',
    title: 'Models & settings',
    body: (
      <>
        The <Em>☰</Em> menu opens <Em>Settings</Em>, where models and modules are downloaded and switched
        on. If a feature seems to do nothing, check here first.
      </>
    ),
    tip: <>The menu also replays this tour and opens HOME.</>,
    targetSelector: '[data-tour="app-menu"]',
  },
  {
    id: 'done',
    title: 'You’re ready',
    body: (
      <>
        Start in <Em>MAKE</Em>: type a prompt and press <Em>CREATE</Em>. When you want more,{' '}
        <Em>UNDERFIT</Em> trains a model on your own audio and <Em>TOUR</Em> plans venues for a run.
      </>
    ),
    primaryLabel: 'Go to MAKE',
    finishTab: 'make',
  },
];
