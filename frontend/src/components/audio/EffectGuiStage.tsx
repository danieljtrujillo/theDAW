import React, { useEffect, useRef, useState, useCallback } from 'react';
import { LayoutGrid } from 'lucide-react';
import type { StudioModule } from '../../lib/moduleCatalog';

/* ── EffectGuiStage ──────────────────────────────────────────────────────────
   Mounts the selected effect's EXACT GUI (the self-contained instrument from
   /edit-modules/<file>) in an <iframe> and lets it FILL the whole effect stage.
   Rather than scale a fixed 780×504 frame (which leaves dead margins), we inject
   a tiny stylesheet that makes the module's frame fill 100%×100% — the instrument
   is natively responsive (its canvases redraw to the new size via their own rAF
   loops), so a wider stage reads a longer waveform / wider spectrum, exactly as
   each effect intends. The instrument keeps its own header — this host adds none.
   Audio is fed over the postMessage('thedaw-audio') protocol every module
   listens for, so the live Web-Audio preview tracks the MIX source. */

const FILL_CSS = `
  html,body{width:100%!important;height:100%!important;margin:0!important;padding:0!important;display:block!important;overflow:hidden!important;background:#07080c!important;position:relative!important}
  .module-frame{position:absolute!important;inset:0!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;border-radius:0!important;border:0!important}
`;

export const EffectGuiStage: React.FC<{
  module: StudioModule | null;
  sourceFile: File | null;
  className?: string;
}> = ({ module, sourceFile, className }) => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Push the current source into the iframe (the module decodes + previews it).
  const sendAudio = useCallback(async () => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !sourceFile) return;
    try {
      const buffer = await sourceFile.arrayBuffer();
      win.postMessage({ type: 'thedaw-audio', buffer, name: sourceFile.name }, '*');
    } catch { /* non-fatal — the instrument has its own Load Audio button */ }
  }, [sourceFile]);

  const handleLoad = () => {
    // Make the instrument fill the stage (responsive), then feed audio.
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc && !doc.querySelector('style[data-thedaw="fill"]')) {
        const style = doc.createElement('style');
        style.setAttribute('data-thedaw', 'fill');
        style.textContent = FILL_CSS;
        doc.head?.appendChild(style);
        // nudge a resize so canvas draw loops re-measure immediately
        try { doc.defaultView?.dispatchEvent(new Event('resize')); } catch { /* ignore */ }
      }
    } catch { /* cross-origin guard — same-origin in practice */ }
    setLoaded(true);
  };

  useEffect(() => { if (loaded) void sendAudio(); }, [loaded, sendAudio]);
  useEffect(() => { setLoaded(false); }, [module?.id]);

  if (!module) {
    return (
      <div className={`h-full w-full min-h-0 flex flex-col items-center justify-center gap-2 text-center px-4 ${className ?? ''}`}>
        <LayoutGrid className="w-6 h-6 text-zinc-700" />
        <span className="text-[11px] text-zinc-500">Pick a Studio Module or chain effect to open its instrument here.</span>
        <span className="text-[9px] font-mono text-zinc-600">14 pro-grade instruments · live preview</span>
      </div>
    );
  }

  return (
    <div className={`h-full w-full min-h-0 overflow-hidden bg-[#07080c] ${className ?? ''}`}>
      <iframe
        ref={iframeRef}
        key={module.id}
        src={`/edit-modules/${module.file}`}
        title={module.name}
        onLoad={handleLoad}
        className="w-full h-full border-0 block"
      />
    </div>
  );
};
