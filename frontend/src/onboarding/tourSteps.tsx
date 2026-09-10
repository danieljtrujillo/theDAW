/**
 * Feature-tour step definitions, grouped into chapters.
 *
 * Each step optionally names a `targetSelector` (a `[data-tour=...]` hook or
 * any stable selector on the real control) and a `tab` the tour switches to
 * before measuring, so the spotlight lands on the right on-screen element. A
 * step whose target lives in a collapsible panel (library rail, bottom dock)
 * carries a `prepare` hook that opens the panel and returns an undo, so the
 * tour never rearranges the workspace permanently. A target that cannot be
 * found still renders as a centred card — never a blank spotlight.
 *
 * Why chapters. The app has thirteen workspaces, eleven dock panels and a
 * dozen pieces of shell chrome; walking all of it is forty-one steps, and that is
 * not a sitting. It is also not a thing the overlay can draw — the progress bar
 * gives every step an equal slice, so forty-one slices are a pixel wide each. And
 * it is not a thing a first-run machine should be marched through: the center
 * panel warm-mounts DJ, VJ, SWAY, FOUNDRY, UNDERFIT, NODEFI, LOOM, LEARN and
 * TOUR permanently the first time each is visited, so one linear pass would
 * start a WebGL visuals engine, a map, a 3D graph and four sidecar iframes on a
 * machine whose owner has not made a sound yet. Chapters mean you mount what
 * you opened and nothing else.
 *
 * Two invariants this file has to keep:
 *
 *   - **TOUR_STEPS stays ordered so each chapter is one contiguous run.**
 *     {@link chapterRange} converts a chapter to a start/end index pair, and
 *     everything else — the picker, the progress bar, "next chapter" — is built
 *     on that pair. Interleaving two chapters would silently swallow steps.
 *   - **a selector here is a DOM contract.** Nothing fails loudly when a hook
 *     goes away; the spotlight just quietly finds nothing and the step degrades
 *     to a centred card. `tourSteps.test.ts` reads the source tree back and
 *     fails when a named `data-tour` hook no longer exists. It cannot do the
 *     same for the aria-label and id selectors used here (Score view mode, Sing
 *     tab layout, Tour planner, the drawing canvas, `#lyric-studio-editor-pane`,
 *     `data-keyscope`) — reword one of those labels and the step goes quiet.
 *
 * A step whose subject lives inside an iframe (VJ, SWAY, FOUNDRY, UNDERFIT)
 * points at the tab's own React-owned toolbar instead: the overlay measures
 * through `document.querySelectorAll`, which cannot see into a frame, and
 * spotlighting the frame itself rings a black rectangle.
 *
 * Copy rules: short, concrete, second-person, no marketing; one idea per step,
 * about two sentences. The overlay swallows clicks, so a step SHOWS a control —
 * it never asks you to operate one.
 */
import React from 'react';
import { type CenterTab } from '../state/appUiStore';
import { type BottomPanelTab, type SingPane, useBottomPanelStore } from '../state/bottomPanelStore';
import { ChimeraSpliceMotif } from './ChimeraSpliceMotif';
import { openLibraryRail } from './featureReveal';

/** Chapter ids, in walkthrough order. */
export type ChapterId = 'basics' | 'make' | 'shape' | 'stage' | 'words' | 'deep';

export interface TourChapter {
  id: ChapterId;
  /** Shown in the picker and in the card header. */
  title: string;
  /** One line under the title: what is inside, in the app's own words. */
  blurb: string;
}

export const TOUR_CHAPTERS: TourChapter[] = [
  {
    id: 'basics',
    title: 'Getting started',
    blurb: 'The shell: workspaces, library, the dock, the transport, the menu',
  },
  {
    id: 'make',
    title: 'Making music',
    blurb: 'Prompts, models, starting from audio, Chimera, DRAW and SEQUENCE',
  },
  {
    id: 'shape',
    title: 'Editing and mixing',
    blurb: 'The timeline, the effect rack, meters, spectrum and track details',
  },
  {
    id: 'stage',
    title: 'Performing',
    blurb: 'PERFORM, DJ, VJ, SWAY and the SLIDE control surface',
  },
  {
    id: 'words',
    title: 'Words and notes',
    blurb: 'Score, karaoke, lyric analysis, the rhyme web and the piano roll',
  },
  {
    id: 'deep',
    title: 'The deep end',
    blurb: 'LOOM, NodeF.I., FOUNDRY, UNDERFIT, the assistant, LEARN and TOUR',
  },
];

export interface TourStep {
  id: string;
  /**
   * Which chapter the step belongs to. Optional on the type because the solo
   * spotlight builds a synthetic step out of a registry entry and belongs to no
   * chapter; every entry in {@link TOUR_STEPS} has one, and the test enforces it.
   */
  chapter?: ChapterId;
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
  /**
   * This step IS the chapter picker: the card lists the chapters instead of
   * hiding them behind the header button, and shows no per-step progress.
   */
  chapterPicker?: boolean;
}

/** A real tour step — one that belongs to a chapter. */
export type ChapteredStep = TourStep & { chapter: ChapterId };

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="inline-block rounded border border-white/15 bg-white/5 px-1 font-mono text-[9px] leading-4 text-zinc-300">
    {children}
  </kbd>
);

const Em: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="font-bold text-zinc-100">{children}</span>
);

/**
 * Show a tab in the bottom dock for a step, and put the dock back the way it
 * was once the tour is finished with it.
 *
 * Deliberately not featureReveal's `openDockTab`: that one is written for a
 * single isolated reveal and hands its undo back per step. React runs the
 * outgoing step's cleanup before the incoming step's prepare, so a chapter of
 * six consecutive dock steps would close the dock and reopen it on every Next —
 * a visible slam — and every step after the first would record "the dock was
 * shut" as the state to hand back at the end. The baseline is captured once, by
 * whichever step opens the dock first, and only restored when a step that does
 * not want the dock takes over. That check is deferred to a microtask because
 * it has to see the incoming prepare, which has not run yet at cleanup time.
 */
let dockBaseline: { wasOpen: boolean; prevTab: BottomPanelTab } | null = null;
let dockHolders = 0;

const openDock =
  (tab: BottomPanelTab) =>
  (): (() => void) => {
    const dock = useBottomPanelStore.getState();
    // `dockBaseline === null` and not just `dockHolders === 0`: React's
    // development double-invoke tears an effect down and sets it straight back
    // up, and the second pass would otherwise record the dock we have already
    // opened as the state to hand back.
    if (dockHolders === 0 && dockBaseline === null) {
      dockBaseline = { wasOpen: dock.isOpen, prevTab: dock.activeTab };
    }
    dockHolders += 1;
    dock.showTab(tab);
    return () => {
      dockHolders -= 1;
      queueMicrotask(() => {
        if (dockHolders > 0 || !dockBaseline) return;
        const { wasOpen, prevTab } = dockBaseline;
        dockBaseline = null;
        const d = useBottomPanelStore.getState();
        if (!wasOpen) d.setOpen(false);
        d.setActiveTab(prevTab);
      });
    };
  };

/** SING with one of its four layouts showing; the dock follows the rule above. */
const openSingPane =
  (pane: SingPane) =>
  (): (() => void) => {
    const undoDock = openDock('sing')();
    const prevPane = useBottomPanelStore.getState().singPane;
    useBottomPanelStore.getState().setSingPane(pane);
    return () => {
      useBottomPanelStore.getState().setSingPane(prevPane);
      undoDock();
    };
  };

export const TOUR_STEPS: ChapteredStep[] = [
  // ══ Getting started ═══════════════════════════════════════════════════════
  {
    id: 'welcome',
    chapter: 'basics',
    title: 'Welcome to theDAW',
    body: (
      <>
        Make music from a text prompt, splice sounds together, then edit, mix and perform — all in one
        place. The tour comes in six chapters: take them in order, or open the one you need and leave
        the rest for later.
      </>
    ),
    tip: (
      <>
        <Kbd>→</Kbd> next · <Kbd>←</Kbd> back · <Kbd>Esc</Kbd> leave. Replay it any time from HOME or
        the <Em>☰</Em> menu.
      </>
    ),
    primaryLabel: 'Start tour',
    chapterPicker: true,
  },
  {
    id: 'workspaces',
    chapter: 'basics',
    title: 'One tab per job',
    body: (
      <>
        <Em>MAKE</Em> generates audio, <Em>EDIT</Em> arranges it, <Em>MIX</Em> polishes it, and{' '}
        <Em>PERFORM</Em>, <Em>DJ</Em>, <Em>VJ</Em> and <Em>SWAY</Em> play it live. The rest —{' '}
        <Em>LOOM</Em>, <Em>NODEFI</Em>, <Em>FOUNDRY</Em>, <Em>UNDERFIT</Em>, <Em>LEARN</Em>,{' '}
        <Em>TOUR</Em> — build the things you play with.
      </>
    ),
    tip: <>Switch any time; nothing is lost. A tab keeps its state once you have visited it.</>,
    targetSelector: '[data-tour^="tab-"]',
    targetMode: 'union',
  },
  {
    id: 'library',
    chapter: 'basics',
    title: 'Your library',
    body: (
      <>
        Everything you make or import shows up here, and the <Em>LIBRARY</Em> tab on the right edge
        slides the rail in and out. Right-click any track for stems, MIDI, notation, cover art and
        export.
      </>
    ),
    tip: <>Drag tracks from here into EDIT, DJ, LOOM or the Chimera stack.</>,
    targetSelector: '[data-tour="library"]',
    prepare: openLibraryRail,
  },
  {
    id: 'panels',
    chapter: 'basics',
    title: 'The panel dock',
    body: (
      <>
        This strip opens the bottom dock, and the dock holds eleven panels: Levels, Visualize, MIDI,
        Sequence, DRAW, Score, Sing, Lyric, Details, SLIDE and SWAY. They stay put across every
        workspace, so a score or a meter follows you from tab to tab.
      </>
    ),
    targetSelector: '[data-feature-note="panels"]',
  },
  {
    id: 'log',
    chapter: 'basics',
    title: 'What the machine is doing',
    body: (
      <>
        CPU, GPU, temperature, VRAM and RAM read live in this strip, and clicking it opens every job
        the app has run. When a generation looks stuck, this is where it says why.
      </>
    ),
    targetSelector: '[data-feature-note="log"]',
  },
  {
    id: 'transport',
    chapter: 'basics',
    title: 'One transport for everything',
    body: (
      <>
        Play, scrub, loop and volume in the footer drive whatever is loaded — a library track, the EDIT
        arrangement, the DJ master. Nothing else in the app keeps a second master transport.
      </>
    ),
    targetSelector: '[data-tour="transport"]',
  },
  {
    id: 'action',
    chapter: 'basics',
    title: 'The button that starts the work',
    body: (
      <>
        The bottom-right button changes with the workspace: <Em>CREATE</Em> on MAKE,{' '}
        <Em>PROCESS</Em> on EDIT and MIX, <Em>TRAIN</Em> on UNDERFIT, <Em>SEND TO VJ</Em> on DJ. It is
        the one button that starts a job, so it never moves.
      </>
    ),
    targetSelector: '[data-tour="action-button"]',
  },
  {
    id: 'app-menu',
    chapter: 'basics',
    title: 'The ☰ menu',
    body: (
      <>
        Project open and save, DAW import, backup, updates, Edit Layout and <Em>Settings</Em> all live
        here. Settings is where models and modules are downloaded and switched on — if a feature seems
        to do nothing, check there first.
      </>
    ),
    tip: <>The menu also opens HOME and the docs, and replays this tour.</>,
    targetSelector: '[data-tour="app-menu"]',
  },

  // ══ Making music ══════════════════════════════════════════════════════════
  {
    id: 'prompt',
    chapter: 'make',
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
    id: 'gen-controls',
    chapter: 'make',
    title: 'Model and length',
    body: (
      <>
        <Em>Model</Em> picks who generates: a local Stable Audio checkpoint, Magenta, or a cloud
        provider. <Em>Length</Em> is the real output duration — the model builds exactly that many
        seconds rather than making a fixed clip and trimming it.
      </>
    ),
    targetSelector: '[data-tour="gen-controls"]',
    tab: 'make',
  },
  {
    id: 'gen-init-inpaint',
    chapter: 'make',
    title: 'Start from audio you already have',
    body: (
      <>
        Drop a clip into <Em>INIT</Em> and the model takes its style as the starting point; drop one
        into <Em>INPAINT</Em> and it rewrites only the region you mark. Right-click either box to load a
        MIDI file instead, rendered through the chosen instrument.
      </>
    ),
    targetSelector: '[data-tour="gen-init-inpaint"]',
    tab: 'make',
  },
  {
    id: 'gen-lora',
    chapter: 'make',
    title: 'Your own trained styles',
    body: (
      <>
        <Em>LoRA</Em> stacks the finetunes you trained in UNDERFIT on top of the base model, several at
        once, each with its own weight. Nothing shows here until you have trained or imported one.
      </>
    ),
    targetSelector: '[data-tour="gen-lora"]',
    tab: 'make',
  },
  {
    id: 'chimera',
    chapter: 'make',
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
    id: 'downloads',
    chapter: 'make',
    title: 'Model downloads',
    body: (
      <>
        Checkpoints download in the background and report here: speed, size, file count and where they
        landed. When one fails because a repository is gated, the token field is inside the failed row
        itself.
      </>
    ),
    tip: <>The dock only exists while there is something to report, so it may not be on screen yet.</>,
    targetSelector: '[data-dock-root]',
  },
  {
    id: 'draw',
    chapter: 'make',
    title: 'Draw to play',
    body: (
      <>
        The bottom dock holds live tools. <Em>DRAW</Em> turns a sketch into generative music you can
        record straight into the library.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-draw"]',
    prepare: openDock('draw'),
  },
  {
    id: 'sequence',
    chapter: 'make',
    title: 'Program a pattern',
    body: (
      <>
        <Em>SEQUENCE</Em> is a step grid for drums and notes, sixteen steps at a time, with genre fills
        that write a starting pattern for you. Bounce the result into the library or onto an EDIT track.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-step-seq"]',
    prepare: openDock('step-seq'),
  },

  // ══ Editing and mixing ════════════════════════════════════════════════════
  {
    id: 'edit-timeline',
    chapter: 'shape',
    title: 'Arrange it',
    body: (
      <>
        <Em>EDIT</Em> is a multitrack timeline: drag clips in from the library, move and cut them with
        these two tools, draw automation, drop markers and set a loop region. The footer's{' '}
        <Em>PROCESS</Em> button renders what you have built.
      </>
    ),
    targetSelector: '[data-tour="edit-toolbar"]',
    tab: 'edit',
  },
  {
    id: 'mix-rack',
    chapter: 'shape',
    title: 'The effect rack',
    body: (
      <>
        <Em>MIX</Em> chains effects, modules and VST3 plugins over one source and prints the result,
        with the input and output waveforms above so you can hear what changed. Right-click the surface
        and pick Edit Layout to rearrange every control — the DJ console works the same way.
      </>
    ),
    targetSelector: '[data-tour="mix-rack"]',
    tab: 'mix',
  },
  {
    id: 'levels',
    chapter: 'shape',
    title: 'Loudness that means something',
    body: (
      <>
        <Em>LEVELS</Em> is a meter bridge: LUFS momentary, short-term and integrated against a delivery
        target, plus loudness range, true peak, correlation and balance. Set the target for wherever the
        track is going and master to it.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-levels"]',
    prepare: openDock('levels'),
  },
  {
    id: 'visualize',
    chapter: 'shape',
    title: 'See what you are hearing',
    body: (
      <>
        <Em>VISUALIZE</Em> draws the spectrum and waveform of whatever is playing, wherever it is
        playing from. It is the quickest way to find the frequency a mix is fighting over.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-spectral"]',
    prepare: openDock('spectral'),
  },
  {
    id: 'details',
    chapter: 'shape',
    title: 'What a track actually is',
    body: (
      <>
        <Em>DETAILS</Em> shows the selected item's prompt, metadata and analysis, and the media bucket
        beside it stages clips and files you have not filed yet. Select something in the library and
        this fills in.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-details"]',
    prepare: openDock('details'),
  },

  // ══ Performing ════════════════════════════════════════════════════════════
  {
    id: 'perform',
    chapter: 'stage',
    title: 'Launch clips live',
    body: (
      <>
        <Em>PERFORM</Em> opens an Ableton, Sway or <Em>.tasmo</Em> project and hands you its scene and
        clip grid to fire live. Open a project from this strip and the grid fills in below it.
      </>
    ),
    tip: <>The routing carried inside a .tasmo tells each slot what to play.</>,
    targetSelector: '[data-tour="perform-header"]',
    tab: 'session',
  },
  {
    id: 'dj',
    chapter: 'stage',
    title: 'Two decks',
    body: (
      <>
        A full DJ console over a real two-deck engine: jog wheels, EQ and filter, crossfader, hotcues,
        loops, beat jump, stem faders and automix. The browser reads your library or any set you have
        saved.
      </>
    ),
    targetSelector: '[data-tour="dj-console"]',
    tab: 'dj',
  },
  {
    id: 'vj',
    chapter: 'stage',
    title: 'Visuals for the show',
    body: (
      <>
        <Em>VJ</Em> runs a live visuals engine that listens to whatever is playing, with sources,
        effects and an output you can throw at a second screen. DJ's <Em>SEND TO VJ</Em> pushes the
        active setlist straight into it.
      </>
    ),
    targetSelector: '[data-tour="vj-toolbar"]',
    tab: 'vj',
  },
  {
    id: 'sway',
    chapter: 'stage',
    title: 'Play it with your body',
    body: (
      <>
        <Em>SWAY</Em> embeds the SwayCommand cockpit, so pose and gesture drive music and effects
        through theDAW's own MIDI with no second app running. Its routing travels inside a .tasmo, so
        PERFORM inherits the same mapping.
      </>
    ),
    targetSelector: '[data-tour="sway-bar"]',
    tab: 'sway',
  },
  {
    id: 'sway-panel',
    chapter: 'stage',
    title: 'Bind a controller to anything',
    body: (
      <>
        The dock's <Em>SWAY</Em> panel is theDAW's own half of that integration: arm <Em>LEARN</Em> on
        one of the six expressive dimensions, move any control on any MIDI device, and it is bound. The
        VJ's camera-pose channels and the Sway's Ableton pad map route from the same strip.
      </>
    ),
    tip: <>PERFORM reads whatever you bind here, and a .tasmo carries it with the project.</>,
    targetSelector: '[data-tour="bottom-tab-sway"]',
    prepare: openDock('sway'),
  },
  {
    id: 'slide',
    chapter: 'stage',
    title: 'A control surface for anything',
    body: (
      <>
        <Em>SLIDE</Em> mirrors a connected controller's knobs, faders and pads and binds each one to a
        real parameter — VJ effects on VISUAL, stems and tracks on AUDIO. It pops out into its own
        window for a second monitor.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-slide"]',
    prepare: openDock('slide'),
  },

  // ══ Words and notes ═══════════════════════════════════════════════════════
  {
    id: 'score',
    chapter: 'words',
    title: 'Read it as music',
    body: (
      <>
        <Em>SCORE</Em> turns a track into sheet music, tablature or a chord chart, then plays along with
        it four ways: PAGE, STRIP, CHORDS and HIGHWAY. Whichever mode you pick, the cursor follows the
        same audio clock.
      </>
    ),
    tip: <>Export the notation as PDF, SVG, MusicXML or ABC.</>,
    targetSelector: '[data-tour="bottom-tab-score"]',
    prepare: openDock('score'),
  },
  {
    id: 'sing',
    chapter: 'words',
    title: 'Words on the beat',
    body: (
      <>
        <Em>SING</Em> scrolls a track's lyrics word by word as it plays. Paste them, pull them out of
        the vocal, force-align them or tap the timing in by hand — then export an LRC.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-sing"]',
    prepare: openSingPane('sing'),
  },
  {
    id: 'sing-study',
    chapter: 'words',
    title: 'What the writing is doing',
    body: (
      <>
        These four buttons choose SING's layout, and <Em>STUDY</Em> puts the analysis beside the words:
        rhyme classes by vowel colour, assonance, consonance, and the devices it can name with how sure
        it is about each. Confirm or reject any finding, and add marks of your own.
      </>
    ),
    targetSelector: '[role="group"][aria-label="Sing tab layout"]',
    prepare: openSingPane('analysis'),
  },
  {
    id: 'rhyme-web',
    chapter: 'words',
    title: 'The shape of a scheme',
    body: (
      <>
        <Em>WEB</Em> collapses the whole lyric to one node per line and draws every connection as an
        arc, so a callback three verses later reads as one long wire. ARC keeps the distance legible,
        RING trades it for density; both export as SVG or PNG.
      </>
    ),
    targetSelector: '[data-tour="rhyme-web"]',
    prepare: openSingPane('analysis'),
  },
  {
    id: 'lyric',
    chapter: 'words',
    title: 'Words with no song attached',
    body: (
      <>
        The <Em>LYRIC</Em> tab is a plain writing surface with that same analysis pane beside it, for
        drafts that belong to no track yet. When a draft is ready it saves into a song.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-lyric"]',
    prepare: openDock('lyric'),
  },
  {
    id: 'midi',
    chapter: 'words',
    title: 'Notes, not audio',
    body: (
      <>
        The <Em>MIDI</Em> tab is a piano roll: sing a line in and it becomes notes, or convert a track,
        edit the result and export a <Em>.mid</Em>. The same notes can drive the step sequencer.
      </>
    ),
    targetSelector: '[data-tour="bottom-tab-midi"]',
    prepare: openDock('midi'),
  },

  // ══ The deep end ══════════════════════════════════════════════════════════
  {
    id: 'loom',
    chapter: 'deep',
    title: 'Your own catalogue as an instrument',
    body: (
      <>
        <Em>LOOM</Em> cuts your songs into shards — beat-matched, key-labelled, a bar or so each — and
        grows a colony of cells that play them on one shared clock. Turn <Em>grow</Em> up and the colony
        buds, prunes and mutates every bar on its own.
      </>
    ),
    tip: <>BPM, grain and swing here are the clock every shard is matched to.</>,
    targetSelector: '[data-tour="loom-clock"]',
    tab: 'loom',
  },
  {
    id: 'nodefi',
    chapter: 'deep',
    title: 'Wire it up',
    body: (
      <>
        <Em>NodeF.I.</Em> is a node graph: wire generation, effects and library actions into a pipeline
        and render it, or leave it live over the playing stems and rack FX. Every node is one of the
        app's real actions rather than a copy of it.
      </>
    ),
    targetSelector: '[data-tour="nodefi-dock"]',
    tab: 'nodefi',
  },
  {
    id: 'foundry',
    chapter: 'deep',
    title: 'Design a plugin face',
    body: (
      <>
        <Em>FOUNDRY</Em> is a visual builder for VST and plugin interfaces on an infinite canvas, and it
        exports what you draw. Kouhai is the simplified skin and Senpai the full cockpit — no features
        differ between them.
      </>
    ),
    targetSelector: '[role="group"][aria-label="Foundry interface mode"]',
    tab: 'foundry',
  },
  {
    id: 'underfit',
    chapter: 'deep',
    title: 'Train it on your own audio',
    body: (
      <>
        <Em>UNDERFIT</Em> trains a LoRA on a dataset you supply, and that finetune then shows up in
        MAKE's LoRA rail. It runs as its own dashboard on localhost, so the tab waits for that server
        before it shows anything.
      </>
    ),
    targetSelector: '[data-tour="underfit-header"]',
    tab: 'underfit',
  },
  {
    id: 'learn',
    chapter: 'deep',
    title: 'Where every track came from',
    body: (
      <>
        <Em>LEARN</Em> draws your library as a genealogy graph in 2D or 3D: which generation came from
        which prompt, which stem came from which track. Click a node to open the track it stands for.
      </>
    ),
    targetSelector: '[data-tour="view-learn"]',
    tab: 'learn',
  },
  {
    id: 'tour-planner',
    chapter: 'deep',
    title: 'Book the shows',
    body: (
      <>
        <Em>TOUR</Em> finds venues and promoters on a map by region, gathers their booking contacts and
        orders a multi-stop route with drive times. Every third-party call runs on the backend, so no
        key ever reaches the browser.
      </>
    ),
    targetSelector: 'aside[aria-label="Tour planner"]',
    tab: 'tour',
  },
  {
    id: 'assistant',
    chapter: 'deep',
    title: 'Ask the ghost',
    body: (
      <>
        The orb in the corner opens the assistant. It answers from theDAW's own documentation and can
        drive the app for you — switching tabs, filling the prompt, starting a generation.
      </>
    ),
    targetSelector: '.aether-orb-toggle',
  },
  {
    id: 'done',
    chapter: 'deep',
    title: 'You’re ready',
    body: (
      <>
        Start in <Em>MAKE</Em>: type a prompt and press <Em>CREATE</Em>. Every chapter of this tour
        stays in the <Em>☰</Em> menu under Help, and the ones you finished are ticked when you come
        back.
      </>
    ),
    primaryLabel: 'Go to MAKE',
    finishTab: 'make',
  },
];

/**
 * First and last index of a chapter's contiguous run, both inclusive.
 *
 * Built once from TOUR_STEPS rather than re-derived per render: the overlay
 * asks for this on every frame it draws a progress bar, and the picker asks for
 * all six at once.
 */
const RANGES: Record<ChapterId, { start: number; end: number }> = (() => {
  const out = {} as Record<ChapterId, { start: number; end: number }>;
  TOUR_STEPS.forEach((s, i) => {
    const r = out[s.chapter];
    if (r) r.end = i;
    else out[s.chapter] = { start: i, end: i };
  });
  return out;
})();

export const chapterRange = (id: ChapterId): { start: number; end: number } =>
  RANGES[id] ?? { start: 0, end: TOUR_STEPS.length - 1 };

const INDEX_BY_ID = new Map(TOUR_STEPS.map((s, i) => [s.id, i]));

/**
 * Index of a step by its id, for anything that wants to jump to a particular
 * step. Addressing steps by raw number breaks the moment one is inserted — the
 * screenshot harness did exactly that.
 */
export const stepIndexById = (id: string): number => INDEX_BY_ID.get(id) ?? 0;
