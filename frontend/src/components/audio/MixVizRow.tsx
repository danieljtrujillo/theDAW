/**
 * MixVizRow — one of the two MIX visualization rows (input / output), shown up
 * top like the DJ hero waveforms. Each row toggles between a static waveform of
 * its own audio and the live spectral visualizer, and can overlay the OTHER
 * row's waveform on top for a before/after A/B comparison.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AudioWaveform, Activity, Layers } from 'lucide-react';
import { SemanticWave } from './SemanticWave';
import { AdvancedVisualizer } from './AdvancedVisualizer';
import { usePlayerStore } from '../../state/playerStore';

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
  /** Player-store label this row plays under (e.g. "MIX Input"), for the playhead. */
  playLabel?: string;
}

const tabBtn = (active: boolean) =>
  `p-1 rounded transition-colors ${active ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`;

export const MixVizRow: React.FC<MixVizRowProps> = ({
  label, url, overlayUrl, accent, overlayAccent, mode, onMode, overlay, onToggleOverlay, placeholder, headerExtra, playLabel,
}) => {
  // The semantic canvas needs a pixel height; measure the card so the wave fills it.
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

  // Playhead / scrub, driven by the shared transport when THIS row is the
  // active track (matched by label). Purely visual otherwise.
  const currentLabel = usePlayerStore((s) => s.currentLabel);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const isActive = playLabel != null && currentLabel === playLabel;
  const progress = isActive && duration > 0 ? currentTime / duration : null;
  const onSeek = isActive ? (frac: number) => usePlayerStore.getState().seekByFraction(frac) : undefined;

  return (
    <div
      ref={bodyRef}
      className="h-full w-full min-h-0 relative overflow-hidden rounded-lg border bg-black/40 shadow-[inset_0_0_24px_rgba(0,0,0,0.6)]"
      style={{ borderColor: `${accent}55` }}
    >
      {/* body — fills the whole card; header floats on top */}
      <div className="absolute inset-0 bg-[#060509]">
        {mode === 'live' ? (
          <AdvancedVisualizer />
        ) : url ? (
          <div className="absolute inset-0">
            <SemanticWave audioUrl={url} height={bodyH} progress={progress} onSeek={onSeek} ariaLabel={`${label} waveform`} />
            {overlay && overlayUrl && (
              <div className="absolute inset-0 opacity-50 pointer-events-none mix-blend-screen">
                <SemanticWave audioUrl={overlayUrl} height={bodyH} transparentBg />
              </div>
            )}
          </div>
        ) : (
          <div className="h-full grid place-items-center">
            <span className="text-[10px] font-mono text-zinc-600">{placeholder}</span>
          </div>
        )}
      </div>

      {/* header: transparent overlay — label · view toggle · overlay · extra,
          floated over the waveform with a scrim + text-shadow for legibility */}
      <div className="absolute top-0 inset-x-0 z-40 flex items-center gap-2 px-2 py-1 bg-linear-to-b from-black/70 to-transparent **:drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
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
          className={`p-1 rounded transition-colors shrink-0 ${overlay ? 'text-cyan-300 bg-cyan-500/20' : 'text-zinc-400 hover:text-zinc-100'}`}
        >
          <Layers className="w-3 h-3" />
        </button>
        <div className="ml-auto min-w-0 flex items-center gap-2">{headerExtra}</div>
      </div>
    </div>
  );
};
