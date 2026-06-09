import React, { useState, useEffect } from 'react';
import { AdvancedGenPanel } from './AdvancedGenPanel';
// CHANGED: model='suno' swaps the whole Make panel to the Suno cloud panel.
// Both panels stay MOUNTED once first shown and toggle via display:none, so
// switching model doesn't unmount either panel (preserving in-progress state,
// active poll timers, local useState, etc.).
import { SunoGenPanel } from '../suno/SunoGenPanel';
import { useGenerateParamsStore } from '../state/generateParamsStore';

export const AdvancedView: React.FC = () => {
  const model = useGenerateParamsStore((s) => s.model);
  // CHANGED: keep the Suno panel mounted once it's been opened (same warm-mount
  // pattern as DJ/VJ in DAWCenterPanel). First visit mounts it; subsequent model
  // toggles just flip CSS visibility. AdvancedGenPanel is always mounted.
  const [sunoWarmed, setSunoWarmed] = useState(false);
  useEffect(() => {
    if (model === 'suno' && !sunoWarmed) setSunoWarmed(true);
  }, [model, sunoWarmed]);

  const isSuno = model === 'suno';
  return (
    <div className="h-full w-full overflow-hidden relative">
      <div className="absolute inset-0" style={{ display: isSuno ? 'none' : undefined }}>
        <AdvancedGenPanel />
      </div>
      {sunoWarmed && (
        <div className="absolute inset-0" style={{ display: isSuno ? undefined : 'none' }}>
          <SunoGenPanel />
        </div>
      )}
    </div>
  );
};
