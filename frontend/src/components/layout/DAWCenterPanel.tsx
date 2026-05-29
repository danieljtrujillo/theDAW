import React from 'react';
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
 */
export const DAWCenterPanel: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
  const centerTab = useAppUiStore((s) => s.centerTab);
  const setCenterTab = useAppUiStore((s) => s.setCenterTab);
  const isRightPanelOpen = useAppUiStore((s) => s.isRightPanelOpen);
  const setRightPanelOpen = useAppUiStore((s) => s.setRightPanelOpen);

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
            // PROCESS → MIX content move (Pass 3): StudioView's macros
            // + process history sit at the top (natural height, in the
            // outer scroll); AdvancedEditorPanel's full effects-chain
            // editor takes the remaining viewport height below.
            <div className="absolute inset-0 overflow-y-auto flex flex-col gap-2">
              <StudioView />
              <div className="shrink-0" style={{ minHeight: '720px' }}>
                <AdvancedEditorPanel />
              </div>
            </div>
          )}
          {centerTab === 'learn' && (
            <LineageView rootEntryId={null} />
          )}
          {centerTab === 'dj' && (
            <DJView />
          )}
          {centerTab === 'vj' && (
            <VJView />
          )}
        </div>
      </div>
    </div>
  );
};
