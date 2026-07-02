import React, { useEffect, useRef, useState, useCallback } from 'react';
import { LayoutGrid, Pause, Play } from 'lucide-react';
import type { StudioModule } from '../../lib/moduleCatalog';

/* ── EffectGuiStage ──────────────────────────────────────────────────────────
   Mounts the selected effect's EXACT GUI (the self-contained instrument from
   /edit-modules/<file>) in an <iframe> and lets it FILL the whole effect stage.
   Rather than scale a fixed 780×504 frame (which leaves dead margins), we inject
   a tiny stylesheet that makes the module's frame fill 100%×100% — the instrument
   is natively responsive (its canvases redraw to the new size via their own rAF
   loops), so a wider stage reads a longer waveform / wider spectrum, exactly as
   each effect intends. The instrument keeps its own header — this host adds only
   a slim transport row with a single play/pause toggle.
   Audio is fed over the postMessage('thedaw-audio') protocol every module
   listens for; the module loads it WITHOUT starting playback, so mounting the
   stage never autoplays. Playback is driven by 'thedaw-transport' messages from
   the toggle, and each module echoes 'thedaw-transport-state' whenever its
   playback starts or stops (including via its own LOAD/TONE/PROCESS buttons),
   which keeps the toggle truthful. */

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
  const [playing, setPlaying] = useState(false);

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

  // The preview defaults to paused and re-pauses whenever the instrument or the
  // source file changes; the module side loads new audio without starting it.
  useEffect(() => { setPlaying(false); }, [module?.id, sourceFile]);

  // Modules echo 'thedaw-transport-state' whenever their playback starts or
  // stops (including via their own LOAD/TONE/PROCESS buttons), so the toggle
  // stays truthful even for playback the host did not initiate.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { type?: string; playing?: boolean } | null;
      if (data && data.type === 'thedaw-transport-state' && typeof data.playing === 'boolean') {
        setPlaying(data.playing);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const togglePlay = () => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    if (playing) {
      // Pause always succeeds, so it is reflected immediately; the module's
      // state echo confirms it.
      win.postMessage({ type: 'thedaw-transport', action: 'pause' }, '*');
      setPlaying(false);
    } else {
      // Play is confirmed by the module's state echo once audio actually
      // starts, so a play sent before any audio is loaded stays paused.
      win.postMessage({ type: 'thedaw-transport', action: 'play' }, '*');
    }
  };

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
    <div className={`h-full w-full min-h-0 overflow-hidden bg-[#07080c] flex flex-col ${className ?? ''}`}>
      <div className="h-6 shrink-0 flex items-center px-1.5 bg-[#0a0c14] border-b border-[#1a1d28]">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? 'Pause preview' : 'Play preview'}
          aria-pressed={playing}
          className="w-5 h-5 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-100 hover:bg-white/5"
        >
          {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
      </div>
      <iframe
        ref={iframeRef}
        key={module.id}
        src={`/edit-modules/${module.file}`}
        title={module.name}
        onLoad={handleLoad}
        allow="autoplay"
        className="w-full flex-1 min-h-0 border-0 block"
      />
    </div>
  );
};
