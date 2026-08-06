import React, { useState, useEffect } from 'react';
import { AdvancedGenPanel } from './AdvancedGenPanel';
// CHANGED: a cloud provider (model='suno' | 'lyria') swaps the whole Make panel
// to that provider's panel. Every panel stays MOUNTED once first shown and
// toggles via display:none, so switching model doesn't unmount any of them
// (preserving in-progress state, active poll timers, local useState, etc.).
// For Lyria that warm-mount also keeps its iframe alive, so its Express sidecar
// isn't re-fetched and its in-app state survives a round trip to SA3.
import { SunoGenPanel } from '../suno/SunoGenPanel';
import { LyriaPanel } from './LyriaPanel';
import { useGenerateParamsStore } from '../state/generateParamsStore';

export const AdvancedView: React.FC = () => {
  const model = useGenerateParamsStore((s) => s.model);
  // CHANGED: keep each cloud panel mounted once it's been opened (same
  // warm-mount pattern as DJ/VJ in DAWCenterPanel). First visit mounts it;
  // subsequent model toggles just flip CSS visibility. AdvancedGenPanel is
  // always mounted.
  const [sunoWarmed, setSunoWarmed] = useState(false);
  const [lyriaWarmed, setLyriaWarmed] = useState(false);
  useEffect(() => {
    if (model === 'suno' && !sunoWarmed) setSunoWarmed(true);
    if (model === 'lyria' && !lyriaWarmed) setLyriaWarmed(true);
  }, [model, sunoWarmed, lyriaWarmed]);

  const isSuno = model === 'suno';
  const isLyria = model === 'lyria';
  // The local SA3/Magenta panel hides whenever ANY cloud provider is active.
  const isCloud = isSuno || isLyria;
  return (
    <div className="h-full w-full overflow-hidden relative">
      <div className="absolute inset-0" style={{ display: isCloud ? 'none' : undefined }}>
        <AdvancedGenPanel />
      </div>
      {sunoWarmed && (
        <div className="absolute inset-0" style={{ display: isSuno ? undefined : 'none' }}>
          <SunoGenPanel />
        </div>
      )}
      {lyriaWarmed && (
        <div className="absolute inset-0" style={{ display: isLyria ? undefined : 'none' }}>
          <LyriaPanel />
        </div>
      )}
    </div>
  );
};
