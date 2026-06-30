/**
 * MixVizRow — one of the two MIX visualization rows (input / output), shown up
 * top like the DJ hero waveforms. Each row toggles between a static waveform of
 * its own audio and the live spectral visualizer, and can overlay the OTHER
 * row's waveform on top for a before/after A/B comparison.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AudioWaveform, Activity, Layers } from 'lucide-react';
import { WaveformPreview } from './WaveformPreview';
import { AdvancedVisualizer } from './AdvancedVisualizer';

export type MixVizMode = 'wave' | 'live';

interface MixVizRowProps {
  label: string;
  /** This row's audio (source for input, processed output for output). */
  url: string | null;
  /** The other row's audio, drawn faintly behind when overlay is on. */
  overlayUrl?: string | null;
  accent: string;        // wave colour for this row
  overlayAccent: string; // wave colour for the overlaid comparison
  mode: MixVizMode;
  onMode: (m: MixVizMode) => void;
  overlay: boolean;
  onToggleOverlay: () => void;
  placeholder: string;
  /** Extra header content (drop affordance for input, result actions for output). */
  headerExtra?: React.ReactNode;
}

const tabBtn = (active: boolean) =>
  `p-1 rounded transition-colors ${active ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`;

export const MixVizRow: React.FC<MixVizRowProps> = ({
  label, url, overlayUrl, accent, overlayAccent, mode, onMode, overlay, onToggleOverlay, placeholder, headerExtra,
}) => {
  // Wavesurfer needs a pixel height; measure the body so the wave fills the row.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyH, setBodyH] = useState(80);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect?.height;
      if (h && h > 8) setBodyH(Math.round(h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      className="h-full w-full min-h-0 flex flex-col overflow-hidden rounded-lg border bg-black/40 shadow-[inset_0_0_24px_rgba(0,0,0,0.6)]"
      style={{ borderColor: `${accent}55` }}
    >
      {/* header: label · view toggle · overlay · extra (DJ deck-slot style) */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-white/10 bg-black/50">
        <span className="text-[10px] font-black uppercase tracking-[0.18em] shrink-0" style={{ color: accent }}>{label}</span>
        <div className="flex items-center gap-0.5 bg-black/40 rounded p-0.5 shrink-0">
          <button onClick={() => onMode('wave')} title="Waveform" className={tabBtn(mode === 'wave')}>
            <AudioWaveform className="w-3 h-3" />
          </button>
          <button onClick={() => onMode('live')} title="Live spectrum / scope" className={tabBtn(mode === 'live')}>
            <Activity className="w-3 h-3" />
          </button>
        </div>
        <button
          onClick={onToggleOverlay}
          title="Overlay the other row for A/B comparison"
          className={`p-1 rounded transition-colors shrink-0 ${overlay ? 'text-cyan-300 bg-cyan-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          <Layers className="w-3 h-3" />
        </button>
        <div className="ml-auto min-w-0 flex items-center gap-2">{headerExtra}</div>
      </div>

      {/* body */}
      <div ref={bodyRef} className="flex-1 min-h-0 relative bg-[#060509]">
        {mode === 'live' ? (
          <AdvancedVisualizer />
        ) : url ? (
          <div className="absolute inset-0">
            <WaveformPreview audioUrl={url} height={bodyH} interact={false} waveColor={accent} progressColor={accent} />
            {overlay && overlayUrl && (
              <div className="absolute inset-0 opacity-50 pointer-events-none mix-blend-screen">
                <WaveformPreview audioUrl={overlayUrl} height={bodyH} interact={false} waveColor={overlayAccent} progressColor={overlayAccent} transparentBg />
              </div>
            )}
          </div>
        ) : (
          <div className="h-full grid place-items-center">
            <span className="text-[10px] font-mono text-zinc-600">{placeholder}</span>
          </div>
        )}
      </div>
    </div>
  );
};
