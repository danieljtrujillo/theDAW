/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, useCallback } from 'react';
import { Shell } from './components/layout/Shell';
import { PlayerFooter } from './components/audio/PlayerFooter';
import { GantasmoOrb } from './orb-kit/react/GantasmoOrb';
import { AssistantPanel } from './orb-kit/AssistantPanel';
import { logInfo } from './state/logStore';
import { handleStableDAWAction } from './orb-kit/actionHandlers';

import './orb-kit/styles/gantasmo-orb.css';
import './orb-kit/chat/orb-chat.css';

export default function App() {
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [orbPosition, setOrbPosition] = useState({ x: 20, y: 500 });

  useEffect(() => {
    logInfo('system', 'StableDAW UI initialized');
  }, []);

  const handleAssistantAction = useCallback((action: { type: string; payload?: any }) => {
    const result = handleStableDAWAction(action);
    logInfo('assistant', `Action: ${action.type} → ${result}`);
  }, []);

  return (
    <>
      <Shell />
      <PlayerFooter />
      <GantasmoOrb
        isActive={isAssistantOpen}
        onToggle={() => setIsAssistantOpen(prev => !prev)}
        onPositionChange={setOrbPosition}
      />
      <AssistantPanel
        isOpen={isAssistantOpen}
        onClose={() => setIsAssistantOpen(false)}
        onExecuteAction={handleAssistantAction}
        orbPosition={orbPosition}
      />
    </>
  );
}
