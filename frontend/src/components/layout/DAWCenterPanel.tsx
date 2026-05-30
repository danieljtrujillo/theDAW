import React, { useEffect, useState } from 'react';
import { WaveformEditor } from '../audio/WaveformEditor';
import { AdvancedView } from '../../views/AdvancedView';
import { AdvancedEditorPanel } from '../../views/AdvancedEditorPanel';
import { StudioView } from '../../views/StudioView';
import { TrainingView } from '../../views/TrainingView';
import { LineageView } from '../library/LineageModal';
import { VJView } from '../../views/VJView';
import { DJView } from '../../views/DJView';
import { CenterTabBar } from './CenterTabBar';
import { useAppUiStore } from '../../state/appUiStore';

/**
 * The center workspace — CenterTabBar at the top + the active tab's
 * view filling the rest. The bottom multi-tab panel was extracted to
 * BottomMultiTabPanel.tsx and now lives in the global footer
 * (Shell.tsx) side-by-side with ProcessingLog. Each panel has its
 * own independent height (multiHeight / logHeight in bottomPanelStore)
 * and its own resize handle.
 *
 * DJ / VJ persistence: these two tabs host live performance state (a
 * 2-deck mixer + an embedded WebGL VJ iframe). Unmounting them on every
 * tab switch tore down that state and — for VJ — reloaded the whole
 * iframe + GPU pipeline. To make the workspace robust for live use we
 * keep DJ and VJ MOUNTED once first visited ("warmed"), toggling only
 * their CSS visibility. The VJ iframe is told to pause its render loop
 * while hidden (see VJView's sa3-vj/visibility bridge) so a backgrounded
 * VJ tab costs ~0% GPU instead of unmounting + cold-reloading.
 */
export const DAWCenterPanel: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
  const centerTab = useAppUiStore((s) => s.centerTab);
  const setCenterTab = useAppUiStore((s) => s.setCenterTab);
  const isRightPanelOpen = useAppUiStore((s) => s.isRightPanelOpen);
  const setRightPanelOpen = useAppUiStore((s) => s.setRightPanelOpen);

  // Track which heavy live-performance tabs have been opened at least
  // once. We only mount DJ / VJ after first visit (so a user who never
  // touches them pays nothing), then keep them mounted permanently and
  // toggle visibility — preserving deck state + the warm VJ iframe.
  const [warmedTabs, setWarmedTabs] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (centerTab === 'dj' || centerTab === 'vj') {
      setWarmedTabs((prev) => {
        if (prev.has(centerTab)) return prev;
        const next = new Set(prev);
        next.add(centerTab);
        return next;
      });
    }
  }, [centerTab]);

  return (
    <div className="flex-1 h-full flex flex-col pt-0 px-0 pb-0 gap-2 bg-[#0a080f]/40 relative z-0 min-h-0">

      <CenterTabBar
        activeTab={centerTab}
        onTabChange={setCenterTab}
        isRightPanelOpen={isRightPanelOpen}
        onToggleRightPanel={() => setRightPanelOpen(!isRightPanelOpen)}
      />

      {/* Main workspace — fills below the tab bar; the active center
          tab takes the whole area. Bottom panel is rendered globally
          in Shell.tsx, no longer inside this card. */}
      <div className="flex-1 min-h-0 hardware-card flex flex-col mx-2 pt-1">
        <div className="flex-1 min-h-0 relative">
          {centerTab === 'train' && (
            <div className="absolute inset-0 overflow-y-auto">
              <TrainingView />
            </div>
          )}
          {centerTab === 'make' && (
            <div className="absolute inset-0 overflow-hidden">
              <AdvancedView />
            </div>
          )}
          {centerTab === 'edit' && (
            <WaveformEditor onSwitchTab={onSwitchTab} />
          )}
          {centerTab === 'mix' && (
            // PROCESS → MIX content move. Whole MIX column is now
            // wrapped at max-w-5xl mx-auto so it doesn't stretch
            // edge-to-edge on ultra-wide monitors. StudioView's
            // macros + process history sit at the top (natural
            // height, in the outer scroll); AdvancedEditorPanel
            // takes the remaining viewport height below.
            <div className="absolute inset-0 overflow-y-auto">
              <div className="max-w-5xl mx-auto w-full px-4 flex flex-col gap-2">
                <StudioView />
                <div className="shrink-0" style={{ minHeight: '720px' }}>
                  <AdvancedEditorPanel />
                </div>
              </div>
            </div>
          )}
          {centerTab === 'learn' && (
            <LineageView rootEntryId={null} />
          )}

          {/* DJ + VJ stay mounted once warmed; visibility toggles with
              the active tab so their live state (decks, VJ iframe) is
              preserved across tab switches. */}
          {warmedTabs.has('dj') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'dj' ? undefined : 'none' }}
            >
              <DJView />
            </div>
          )}
          {warmedTabs.has('vj') && (
            <div
              className="absolute inset-0"
              style={{ display: centerTab === 'vj' ? undefined : 'none' }}
            >
              <VJView />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

