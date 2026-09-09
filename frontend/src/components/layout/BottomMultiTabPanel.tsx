/**
 * Bottom multi-tab panel body — Visualize / Piano / Sequence / Details
 * / Media / SLIDE. Mounted above the dock strip when isOpen=true. The strip
 * itself (Shell.tsx ShellBottomDock) handles the open/close toggle,
 * so this component only renders the body shape: a tabs row + the
 * active tab's content. Height is the column's own `multiHeight`
 * from bottomPanelStore — independent of the LOG's `logHeight`.
 */
import React, { useState, lazy, Suspense } from 'react';
import {
  Activity, Info, Piano, Layers, FolderOpen, SlidersVertical, ExternalLink, Maximize2, Minimize2,
  FileMusic, Waves, Brush, Gauge, Radio, MicVocal, NotebookPen,
} from 'lucide-react';
import { AdvancedVisualizer } from '../audio/AdvancedVisualizer';
import { StepSequencer } from '../audio/StepSequencer';
import { DetailsMediaView } from './DetailsMediaView';
import { ScoreView } from './ScoreView';
import { SlidePanel } from './SlidePanel';
import { SwayPanel } from './SwayPanel';
import { LevelsPanel } from '../audio/levels/LevelsPanel';
// Lazy: the MIDI tab (piano roll + vocal2midi) drags in @google/genai
// (AI compose + gemini vocal services). Keep it out of first paint; the chunk
// loads only when the user first opens the MIDI tab.
const MidiPanel = lazy(() => import('./MidiPanel').then((m) => ({ default: m.MidiPanel })));
// The SING tab body: the karaoke lyrics, the SCORE tab, or both side by side.
// It lazy-loads both panes itself, so the pitch lane and mic capture still only
// arrive when the tab is opened.
import { SingScoreView } from './sing/SingScoreView';
// The LYRIC tab (writing surface + the analysis pane beside it) is its own
// chunk: nothing else imports the notebook, and the analysis pane it mounts is
// already lazy in SING.
const LyricStudioView = lazy(() =>
  import('./lyricstudio/LyricStudioView').then((m) => ({ default: m.LyricStudioView })),
);
import { DrawPanel } from './DrawPanel';
import { DetachableWindow } from './DetachableWindow';
import { XrBusPanel } from '../dev/XrBusTester';
import { useBottomPanelStore, type BottomPanelTab } from '../../state/bottomPanelStore';
import { useSlideStore } from '../../state/slideStore';

const TAB_DEFS: Array<{ id: BottomPanelTab; label: string; desc: string; icon: React.ComponentType<{ className?: string }>; colorActive: string }> = [
  { id: 'levels',     label: 'Levels',     desc: 'Master loudness, peak, dynamics and stereo metering (LUFS / true-peak)',  icon: Gauge,      colorActive: 'border-teal-500 text-teal-300' },
  { id: 'spectral',   label: 'Visualize',  desc: 'Live spectrum + waveform visualizer of the playing audio',                 icon: Activity,   colorActive: 'border-purple-500 text-purple-300' },
  { id: 'midi',       label: 'MIDI',       desc: 'Piano roll: sing in, record or analyze notes, edit them, export MIDI',     icon: Piano,      colorActive: 'border-cyan-500 text-cyan-300' },
  { id: 'step-seq',   label: 'Sequence',   desc: 'Program drum and note patterns step by step on a grid',                    icon: Layers,     colorActive: 'border-cyan-500 text-cyan-300' },
  { id: 'draw',       label: 'DRAW',       desc: 'Draw to play generative music; record it to the library or EDIT',          icon: Brush,      colorActive: 'border-purple-500 text-purple-300' },
  { id: 'score',      label: 'Score',      desc: 'Sheet music + tabs for the selection; convert and arrange notation',       icon: FileMusic,  colorActive: 'border-emerald-500 text-emerald-300' },
  { id: 'sing',       label: 'Sing',       desc: 'Karaoke: lyrics follow the track word by word; paste, extract, align, tap-time and export LRC', icon: MicVocal, colorActive: 'border-rose-500 text-rose-300' },
  { id: 'lyric',      label: 'Lyric',      desc: 'Write, edit and analyse lyrics with no song attached; save a draft into a song when it is ready', icon: NotebookPen, colorActive: 'border-rose-500 text-rose-300' },
  { id: 'details',    label: 'Details',    desc: 'The selected library item (metadata, prompt, analysis) and the media bucket for staging clips and files', icon: Info, colorActive: 'border-emerald-500 text-emerald-300' },
  { id: 'slide',      label: 'SLIDE',      desc: 'Control surface: map sliders and pads to parameters',                      icon: SlidersVertical, colorActive: 'border-pink-500 text-pink-300' },
  { id: 'sway',       label: 'SWAY',       desc: 'Pose control: drive music and effects from body movement',                 icon: Waves,      colorActive: 'border-fuchsia-500 text-fuchsia-300' },
  // Dev-only: the simulated XR/phone controller that drives the control bus.
  // Registered here (not floating over the footer) so it reads as the
  // diagnostics tab it is; stripped from production builds with the DEV flag.
  ...(import.meta.env.DEV
    ? [{ id: 'xrbus' as BottomPanelTab, label: 'XR Bus', desc: 'Dev: simulated XR/phone controller driving the control bus', icon: Radio, colorActive: 'border-cyan-500 text-cyan-300' }]
    : []),
];

/** Tab id → display label, for surfaces that name the active tab without
 *  mounting the panel (the dock strip's PANELS toggle). */
export const BOTTOM_TAB_LABELS: Record<string, string> = Object.fromEntries(
  TAB_DEFS.map((t) => [t.id, t.label]),
);

export const BottomMultiTabPanel: React.FC = () => {
  const activeTab = useBottomPanelStore((s) => s.activeTab);
  const setActiveTab = useBottomPanelStore((s) => s.setActiveTab);
  const multiMaximized = useBottomPanelStore((s) => s.multiMaximized);
  const toggleMultiMaximized = useBottomPanelStore((s) => s.toggleMultiMaximized);
  // SLIDE can detach into its own window (second-monitor performance). The
  // window is opened in the click handler below — browsers block window.open
  // that runs from an effect (outside the gesture), which was the original
  // "pop-out does nothing" bug. Session state only — never auto-reopen on reload.
  const [slideWin, setSlideWin] = useState<Window | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);

  const toggleSlideDetach = () => {
    if (slideWin) {
      setSlideWin(null); // pop back in — unmounting DetachableWindow closes it
      return;
    }
    const w = window.open(
      '',
      'theDAW_SLIDE',
      'width=560,height=860,menubar=no,toolbar=no,location=no,status=no',
    );
    if (!w) {
      setPopupBlocked(true);
      return;
    }
    setPopupBlocked(false);
    setSlideWin(w);
  };

  return (
    <div className="h-full flex flex-col bg-purple-500/2 min-h-0">
      {/* Tabs row. When SLIDE is active its AUDIO/VISUAL content toggle lives
          here (right side) so the panel body gets full height for the lanes. */}
      <div className="flex items-center justify-between border-b border-white/5 shrink-0 bg-black/30">
        <div className="flex overflow-x-auto no-scrollbar">
          {TAB_DEFS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                data-tour={`bottom-tab-${t.id}`}
                onClick={() => setActiveTab(t.id)}
                className={`px-3 py-1 flex items-center gap-1.5 border-b-2 text-[9px] uppercase tracking-widest font-black transition-colors whitespace-nowrap ${active ? t.colorActive : 'border-transparent et-ink-2 hover:et-ink'}`}
                title={t.desc}
              >
                <Icon className="w-3 h-3" /> {t.label}
              </button>
            );
          })}
        </div>
        {/* Right cluster — SLIDE-only controls (when active) + the always-on
            maximize toggle so any tab can fill the window. */}
        {/* pr-5 keeps the Maximize toggle clear of the shell's library pull
            handle (14px wide, right edge, vertically centred). */}
        <div className="flex items-center gap-1 pr-5 shrink-0">
          {activeTab === 'details' && <DetailsPaneToggle />}
          {activeTab === 'sing' && <SingPaneToggle />}
          {activeTab === 'slide' && (
            <>
              <SlideContentToggle />
              <button
                onClick={toggleSlideDetach}
                className={`p-1 rounded border text-[9px] flex items-center gap-1 ${
                  slideWin
                    ? 'border-pink-500/50 bg-pink-500/15 text-pink-200'
                    : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/25'
                }`}
                title={slideWin ? 'Pop SLIDE back into the app' : 'Pop SLIDE out into its own window (second monitor)'}
                aria-label="Detach SLIDE window"
              >
                <ExternalLink className="w-3 h-3" />
              </button>
            </>
          )}
          <button
            onClick={toggleMultiMaximized}
            className={`p-1 rounded border ${
              multiMaximized
                ? 'border-purple-500/50 bg-purple-500/15 text-purple-200'
                : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/25'
            }`}
            title={multiMaximized ? 'Restore panel size' : 'Maximize panel to fill the window'}
            aria-label={multiMaximized ? 'Restore panel' : 'Maximize panel'}
          >
            {multiMaximized ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 relative">
        {activeTab === 'levels' && (
          <div className="absolute inset-0">
            <LevelsPanel />
          </div>
        )}
        {activeTab === 'spectral' && (
          <div className="absolute inset-0 p-1">
            <AdvancedVisualizer />
          </div>
        )}
        {activeTab === 'details' && (
          <div className="absolute inset-0">
            <DetailsMediaView />
          </div>
        )}
        {activeTab === 'midi' && (
          <div className="absolute inset-0">
            <Suspense fallback={null}>
              <MidiPanel />
            </Suspense>
          </div>
        )}
        {activeTab === 'draw' && (
          <div className="absolute inset-0">
            <DrawPanel />
          </div>
        )}
        {activeTab === 'step-seq' && (
          <div className="absolute inset-0 overflow-y-auto">
            <StepSequencer />
          </div>
        )}
        {activeTab === 'score' && (
          <div className="absolute inset-0">
            <ScoreView />
          </div>
        )}
        {activeTab === 'sing' && (
          <div className="absolute inset-0">
            <SingScoreView />
          </div>
        )}
        {activeTab === 'lyric' && (
          <div className="absolute inset-0">
            <Suspense fallback={null}>
              <LyricStudioView />
            </Suspense>
          </div>
        )}
        {activeTab === 'sway' && (
          <div className="absolute inset-0">
            <SwayPanel />
          </div>
        )}
        {activeTab === 'xrbus' && import.meta.env.DEV && (
          <div className="absolute inset-0">
            <XrBusPanel />
          </div>
        )}
        {activeTab === 'slide' && (
          <div className="absolute inset-0">
            {slideWin ? (
              <>
                <div className="h-full flex flex-col items-center justify-center gap-3 text-pink-200">
                  <ExternalLink className="w-5 h-5" />
                  <span className="text-[10px] font-mono uppercase tracking-widest">
                    SLIDE is in a separate window
                  </span>
                  <button
                    onClick={() => setSlideWin(null)}
                    className="px-3 py-1.5 rounded border border-pink-500/40 bg-pink-500/15 text-pink-200 hover:bg-pink-500/25 text-[9px] font-black uppercase tracking-widest"
                  >
                    Pop back in
                  </button>
                </div>
                <DetachableWindow win={slideWin} title="theDAW — SLIDE" onClose={() => setSlideWin(null)}>
                  <SlidePanel />
                </DetachableWindow>
              </>
            ) : (
              <>
                {popupBlocked && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded border border-amber-500/50 bg-amber-500/15 text-amber-200 text-[9px] font-mono">
                    Pop-up blocked — allow pop-ups for this site, then click the ⤢ button again.
                  </div>
                )}
                <SlidePanel />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * DETAILS / BOTH / MEDIA layout toggle for the merged DETAILS tab, in the
 * tab row like the SLIDE toggle. Drives bottomPanelStore.detailsPane.
 */
const DetailsPaneToggle: React.FC = () => {
  const pane = useBottomPanelStore((s) => s.detailsPane);
  const setPane = useBottomPanelStore((s) => s.setDetailsPane);
  const btn = 'px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.18em] transition-colors';
  const on = 'bg-emerald-500/15 text-emerald-200 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.5)]';
  const off = 'text-zinc-500 hover:text-zinc-200';
  return (
    <div className="flex items-center pr-2 shrink-0" role="group" aria-label="Details tab layout">
      <div className="flex rounded-md border border-white/10 overflow-hidden">
        <button onClick={() => setPane('details')} className={`${btn} ${pane === 'details' ? on : off}`} title="Only the selected item's details" aria-pressed={pane === 'details'}>
          <span className="inline-flex items-center gap-1"><Info className="w-3 h-3" /> Details</span>
        </button>
        <button onClick={() => setPane('split')} className={`${btn} ${pane === 'split' ? on : off}`} title="Details and the media bucket side by side" aria-pressed={pane === 'split'}>
          Both
        </button>
        <button onClick={() => setPane('media')} className={`${btn} ${pane === 'media' ? on : off}`} title="Only the media bucket" aria-pressed={pane === 'media'}>
          <span className="inline-flex items-center gap-1"><FolderOpen className="w-3 h-3" /> Media</span>
        </button>
      </div>
    </div>
  );
};

/**
 * LYRICS / BOTH / SCORE / STUDY layout toggle for the SING tab, beside the
 * DETAILS one. Drives bottomPanelStore.singPane; SingScoreView reads it.
 * STUDY is also a split — the literary analysis only means anything with the
 * words it describes next to it.
 */
const SingPaneToggle: React.FC = () => {
  const pane = useBottomPanelStore((s) => s.singPane);
  const setPane = useBottomPanelStore((s) => s.setSingPane);
  const btn = 'px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.18em] transition-colors';
  const on = 'bg-rose-500/15 text-rose-200 shadow-[inset_0_0_0_1px_rgba(244,63,94,0.5)]';
  const off = 'text-zinc-500 hover:text-zinc-200';
  return (
    <div className="flex items-center pr-2 shrink-0" role="group" aria-label="Sing tab layout">
      <div className="flex rounded-md border border-white/10 overflow-hidden">
        <button onClick={() => setPane('sing')} className={`${btn} ${pane === 'sing' ? on : off}`} title="Only the karaoke lyrics" aria-pressed={pane === 'sing'}>
          <span className="inline-flex items-center gap-1"><MicVocal className="w-3 h-3" /> Lyrics</span>
        </button>
        <button onClick={() => setPane('split')} className={`${btn} ${pane === 'split' ? on : off}`} title="Lyrics and the score side by side" aria-pressed={pane === 'split'}>
          Both
        </button>
        <button onClick={() => setPane('score')} className={`${btn} ${pane === 'score' ? on : off}`} title="Only the score" aria-pressed={pane === 'score'}>
          <span className="inline-flex items-center gap-1"><FileMusic className="w-3 h-3" /> Score</span>
        </button>
        <button onClick={() => setPane('analysis')} className={`${btn} ${pane === 'analysis' ? on : off}`} title="Lyrics and the rhyme / literary analysis side by side" aria-pressed={pane === 'analysis'}>
          Study
        </button>
      </div>
    </div>
  );
};

/**
 * AUDIO / VISUAL content toggle for the SLIDE tab — hoisted into the tab row
 * (per the user's layout) instead of living inside the panel body. Drives
 * slideStore.content; AUDIO is emerald, VISUAL is pink to match the surface.
 */
const SlideContentToggle: React.FC = () => {
  const content = useSlideStore((s) => s.content);
  const setContent = useSlideStore((s) => s.setContent);
  const btn = 'px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.18em] transition-colors';
  return (
    <div className="flex items-center pr-2 shrink-0">
      <div className="flex rounded-md border border-white/10 overflow-hidden">
        <button
          onClick={() => setContent('audio')}
          className={`${btn} ${content === 'audio' ? 'bg-emerald-500/15 text-emerald-200 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.5)]' : 'text-zinc-500 hover:text-zinc-200'}`}
        >
          Audio
        </button>
        <button
          onClick={() => setContent('visual')}
          className={`${btn} ${content === 'visual' ? 'bg-pink-500/15 text-pink-200 shadow-[inset_0_0_0_1px_rgba(236,72,153,0.5)]' : 'text-zinc-500 hover:text-zinc-200'}`}
        >
          Visual
        </button>
      </div>
    </div>
  );
};
