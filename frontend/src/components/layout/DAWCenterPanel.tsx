import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useAppUiStore } from '../../state/appUiStore';
import { TabErrorBoundary } from './TabErrorBoundary';
// Session tab is eager (not code-split): keeps it robust against lazy-chunk
// load failures and it is light (an Ableton session grid over existing stores).
import { SessionView } from '../../views/SessionView';

/**
 * The center workspace — CenterTabBar at the top + the active tab's
 * view filling the rest. The bottom multi-tab panel was extracted to
 * BottomMultiTabPanel.tsx and now lives in the global footer
 * (Shell.tsx) side-by-side with ProcessingLog. Each panel has its
 * own independent height (multiHeight / logHeight in bottomPanelStore)
 * and its own resize handle.
 *
 * Each tab view is code-split (React.lazy) so its JS — and its heavy
 * deps (wavesurfer, the force-graph engine, the chimera/effect stacks,
 * the VJ bridge) — only download when that tab is first opened, not in
 * the initial bundle. Each tab renders inside its OWN Suspense boundary
 * so a not-yet-loaded tab can't blank out a sibling.
 *
 * DJ / VJ persistence: these two tabs host live performance state (a
 * 2-deck mixer + an embedded WebGL VJ iframe). Unmounting them on every
 * tab switch tore down that state and — for VJ — reloaded the whole
 * iframe + GPU pipeline. To make the workspace robust for live use we
 * keep DJ and VJ MOUNTED once first visited ("warmed"), toggling only
 * their CSS visibility. The VJ iframe is told to pause its render loop
 * while hidden (see VJView's sa3-vj/visibility bridge) so a backgrounded
 * VJ tab costs ~0% GPU instead of unmounting + cold-reloading. Their own
 * Suspense boundary means resolving another tab never disturbs them.
 */
const WaveformEditor = lazy(() => import('../audio/WaveformEditor').then((m) => ({ default: m.WaveformEditor })));
const AdvancedView = lazy(() => import('../../views/AdvancedView').then((m) => ({ default: m.AdvancedView })));
const MixView = lazy(() => import('../../views/MixView').then((m) => ({ default: m.MixView })));
// LEARN is hosted by LearnHost: on a small library it renders the classic graph
// from ../library/LineageModal exactly as before; on a large one (where that graph
// asks for the whole library and cannot load) it opens the scale-safe view instead.
const LineageView = lazy(() => import('../../lineagescale/LearnHost').then((m) => ({ default: m.LineageView })));
const VJView = lazy(() => import('../../views/VJView').then((m) => ({ default: m.VJView })));
const DJView = lazy(() => import('../../views/DJView').then((m) => ({ default: m.DJView })));
const SwayView = lazy(() => import('../../views/SwayView').then((m) => ({ default: m.SwayView })));
const FoundryView = lazy(() => import('../../views/FoundryView').then((m) => ({ default: m.FoundryView })));
const UnderfitView = lazy(() => import('../../views/UnderfitView').then((m) => ({ default: m.UnderfitView })));
const NodefiView = lazy(() => import('../../views/NodefiView').then((m) => ({ default: m.NodefiView })));
const LoomView = lazy(() => import('../../views/LoomView').then((m) => ({ default: m.LoomView })));
const TourView = lazy(() => import('../../views/TourView').then((m) => ({ default: m.TourView })));
// The mixer drawer — one strip per track and per bus, plus the master: output
// pickers, sends and faders over `editorStore.routing`. Lazy like the views, so
// its chunk only downloads the first time the drawer is opened.
const MixerStrips = lazy(() => import('../audio/MixerStrips').then((m) => ({ default: m.MixerStrips })));

const MIXER_MIN_PX = 120;
const MIXER_MAX_PX = 520;
const clampMixer = (px: number): number => Math.max(MIXER_MIN_PX, Math.min(MIXER_MAX_PX, px));

const TabFallback: React.FC = () => (
  <div className="absolute inset-0 grid place-items-center">
    <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 animate-pulse">loading…</span>
  </div>
);

export const DAWCenterPanel: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
  const centerTab = useAppUiStore((s) => s.centerTab);

  // Track which heavy live-performance tabs have been opened at least
  // once. We only mount DJ / VJ / LEARN after first visit (so a user who
  // never touches them pays nothing), then keep them mounted permanently
  // and toggle visibility — preserving deck state, the warm VJ iframe,
  // and the LEARN genealogy graph's fetch + layout + pan/zoom.
  const [warmedTabs, setWarmedTabs] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (centerTab === 'dj' || centerTab === 'vj' || centerTab === 'sway' || centerTab === 'foundry' || centerTab === 'underfit' || centerTab === 'nodefi' || centerTab === 'loom' || centerTab === 'learn' || centerTab === 'tour') {
      setWarmedTabs((prev) => {
        if (prev.has(centerTab)) return prev;
        const next = new Set(prev);
        next.add(centerTab);
        return next;
      });
    }
  }, [centerTab]);

  // Mixer drawer — collapsed by default, and its height is LOCAL UI state: it
  // is a view preference, not part of the document, so it never reaches
  // editorStore / the project file. It hosts the only strips a BUS can have, so
  // it sits under the timeline rather than inside the EDIT track-header column.
  const [mixerOpen, setMixerOpen] = useState(false);
  const [mixerHeight, setMixerHeight] = useState(220);
  const mixerDragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onMixerResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    mixerDragRef.current = { startY: e.clientY, startH: mixerHeight };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMixerResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = mixerDragRef.current;
    if (!d) return;
    // Dragging the handle UP grows the drawer, so the delta is inverted.
    setMixerHeight(clampMixer(d.startH + (d.startY - e.clientY)));
  };
  const onMixerResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    mixerDragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div className="flex-1 h-full flex flex-col pt-1 px-0 pb-0 gap-2 bg-[#0a080f]/40 relative z-0 min-h-0">

      {/* Main workspace — the tab bar now lives in the global header; the active center
          tab takes the whole area. Bottom panel is rendered globally
          in Shell.tsx, no longer inside this card. */}
      <div className="flex-1 min-h-0 hardware-card flex flex-col mx-2 pt-1">
        <div className="flex-1 min-h-0 relative">
          {centerTab === 'make' && (
            <div className="absolute inset-0 overflow-hidden">
              <TabErrorBoundary tabName="Make">
                <Suspense fallback={<TabFallback />}><AdvancedView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {centerTab === 'edit' && (
            <TabErrorBoundary tabName="Edit">
              <Suspense fallback={<TabFallback />}><WaveformEditor onSwitchTab={onSwitchTab} /></Suspense>
            </TabErrorBoundary>
          )}
          {centerTab === 'session' && (
            <div className="absolute inset-0 overflow-hidden">
              <TabErrorBoundary tabName="Perform"><SessionView /></TabErrorBoundary>
            </div>
          )}
          {centerTab === 'mix' && (
            // PROCESS → MIX. The MIX workspace on the Control-Surface editor
            // (MixView): 2 input/output viz rows up top (toggle waveform / live
            // scope, A/B overlay), the effect-chain workflow (rail + library +
            // chain) in the middle, and the effectStage below. Drag-arrangeable
            // in Design Mode like the DJ console.
            <div className="absolute inset-0 overflow-hidden">
              <TabErrorBoundary tabName="Mix">
                <Suspense fallback={<TabFallback />}><MixView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {/* LEARN stays mounted once warmed (same pattern as DJ/VJ below)
              so tab switches preserve the fetched graph, the computed
              layout, the DOM, and the user's pan/zoom. The `visible` prop
              tells the view when it is re-shown so it can refetch the
              cheap bulk graph endpoint and rebuild only if the library
              actually changed. */}
          {warmedTabs.has('learn') && (
            <div
              data-tour="view-learn"
              className="absolute inset-0"
              style={{ display: centerTab === 'learn' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="Learn">
                <Suspense fallback={<TabFallback />}><LineageView rootEntryId={null} visible={centerTab === 'learn'} /></Suspense>
              </TabErrorBoundary>
            </div>
          )}

          {/* DJ + VJ stay mounted once warmed; visibility toggles with
              the active tab so their live state (decks, VJ iframe) is
              preserved across tab switches. Each has its own Suspense so
              loading a different tab never blanks them. */}
          {warmedTabs.has('dj') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'dj' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="DJ">
                <Suspense fallback={<TabFallback />}><DJView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {warmedTabs.has('vj') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'vj' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="VJ">
                <Suspense fallback={<TabFallback />}><VJView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {/* SWAY hosts the embedded SwayCommand cockpit (WebGL + an rAF
              transport clock), so it follows the DJ/VJ pattern: mount once, then
              toggle visibility. SwayView pushes visible:false to the child so a
              backgrounded cockpit stops rendering instead of burning GPU. */}
          {warmedTabs.has('sway') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'sway' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="Sway">
                <Suspense fallback={<TabFallback />}><SwayView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {warmedTabs.has('foundry') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'foundry' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="Foundry">
                <Suspense fallback={<TabFallback />}><FoundryView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {warmedTabs.has('underfit') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'underfit' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="Underfit">
                <Suspense fallback={<TabFallback />}><UnderfitView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {warmedTabs.has('nodefi') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'nodefi' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="NodeF.I.">
                <Suspense fallback={<TabFallback />}><NodefiView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {warmedTabs.has('loom') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'loom' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="Loom">
                <Suspense fallback={<TabFallback />}><LoomView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
          {warmedTabs.has('tour') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'tour' ? undefined : 'none' }}
            >
              <TabErrorBoundary tabName="Tour">
                <Suspense fallback={<TabFallback />}><TourView /></Suspense>
              </TabErrorBoundary>
            </div>
          )}
        </div>

        {/* Mixer drawer, under the timeline. Mounted on the EDIT tab only: its
            strips are the editor document's tracks and buses, and the tab bar's
            other workspaces (DJ, VJ, FOUNDRY …) carry their own mixers. Being a
            sibling of the tab area — which keeps its `flex-1 min-h-0` — means
            opening the drawer costs no layout change anywhere else. */}
        {centerTab === 'edit' && (
          <div className="shrink-0 flex flex-col border-t border-white/5">
            {mixerOpen && (
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the mixer drawer"
                // A focusable separator is a window splitter, and a splitter
                // reports its position: without these three a screen reader
                // announces a handle that can be moved but never says where it
                // is or how far it can go.
                aria-valuenow={mixerHeight}
                aria-valuemin={MIXER_MIN_PX}
                aria-valuemax={MIXER_MAX_PX}
                tabIndex={0}
                onPointerDown={onMixerResizeDown}
                onPointerMove={onMixerResizeMove}
                onPointerUp={onMixerResizeUp}
                onPointerCancel={onMixerResizeUp}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp') setMixerHeight((h) => clampMixer(h + 16));
                  else if (e.key === 'ArrowDown') setMixerHeight((h) => clampMixer(h - 16));
                  else return;
                  e.preventDefault();
                }}
                className="h-1.5 cursor-row-resize bg-white/5 hover:bg-white/15 focus:outline-hidden focus:bg-[rgb(var(--et-accent))]/40"
                style={{ touchAction: 'none' }}
              />
            )}
            <div className="flex items-center gap-2 px-2 py-1">
              <button
                type="button"
                onClick={() => setMixerOpen((v) => !v)}
                aria-label="Mixer"
                aria-expanded={mixerOpen}
                aria-controls="mixer-strips"
                title="Mixer strips: outputs, buses and sends"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-widest text-zinc-500 hover:text-white hover:bg-white/5 focus:outline-hidden focus:ring-1 focus:ring-[rgb(var(--et-accent))]"
              >
                {mixerOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
                mixer
              </button>
            </div>
            {/* Always rendered so `aria-controls` resolves; `hidden` while
                collapsed, which also keeps the lazy chunk unfetched. */}
            <div id="mixer-strips" hidden={!mixerOpen} style={{ height: mixerOpen ? mixerHeight : undefined }} className="min-h-0 px-2 pb-2">
              {mixerOpen && (
                // Not `TabFallback`: that one is `absolute inset-0`, which in
                // this un-positioned drawer would paint over the timeline.
                <Suspense fallback={<span className="text-[10px] font-mono uppercase tracking-widest text-zinc-600 animate-pulse">loading…</span>}>
                  <MixerStrips />
                </Suspense>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
