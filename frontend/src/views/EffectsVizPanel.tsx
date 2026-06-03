import React from 'react';
import { Activity } from 'lucide-react';
import { EFFECT_LABELS } from '../state/effectChainStore';

/* ── EffectsVizPanel ───────────────────────────────────────────────────
   Reserved bottom-center region of the MIX tab for effects visualization
   (real EQ-curve, transfer-function / scope display, etc.). This is a
   structured PLACEHOLDER with a stable props contract — drop the real
   visualization in here later; it already receives the active effect +
   its live params. Per DESIGN_PRINCIPLES §6 a visual carries no heading;
   the effect name sits as a faint corner tag only.

   Props:
     effect — the currently-selected/active effect id (e.g. 'eq_mid')
     params — that effect's live params (the future viz reads these) */
export interface EffectsVizPanelProps {
  effect: string | null;
  params: Record<string, number>;
  className?: string;
}

export const EffectsVizPanel: React.FC<EffectsVizPanelProps> = ({ effect, params, className }) => {
  const label = effect ? EFFECT_LABELS[effect] || effect : null;
  // Surface a couple of the live param values so the placeholder reflects
  // the selection (and the wiring is visibly real before the scope lands).
  const paramPairs = Object.entries(params).slice(0, 4);

  return (
    <div
      className={`relative h-full w-full overflow-hidden rounded-lg border border-white/8 bg-[#0a080f] ${className ?? ''}`}
    >
      {/* ambient field */}
      <div className="absolute inset-0 opacity-40 pointer-events-none bg-[radial-gradient(circle_at_50%_60%,rgba(168,85,247,0.18),transparent_65%)]" />

      {/* idle baseline scope line — a calm, persistent curve so the region
          reads as "visualization" rather than empty (replaced by the real
          transfer-function display later). */}
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full text-purple-400/30">
        <path d="M0,30 Q15,30 25,24 T45,16 T65,12 T85,18 T100,24" fill="none" stroke="currentColor" strokeWidth="0.6" />
        <line x1="0" y1="30" x2="100" y2="30" stroke="currentColor" strokeWidth="0.2" strokeDasharray="1 2" opacity="0.4" />
      </svg>

      {/* corner tag — faint, no big heading */}
      <div className="absolute top-2 left-2 flex items-center gap-1.5 text-zinc-600">
        <Activity className="w-3 h-3" />
        <span className="text-[8px] font-black uppercase tracking-widest">
          {label ? label : 'Effects Visualization'}
        </span>
      </div>

      {/* live params readout (placeholder content; the real viz supersedes this) */}
      {paramPairs.length > 0 && (
        <div className="absolute bottom-2 left-2 right-2 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {paramPairs.map(([k, v]) => (
            <span key={k} className="flex items-center gap-1">
              <span className="text-[8px] font-mono text-zinc-600 uppercase">{k}</span>
              <span className="text-[9px] font-mono text-purple-300/80 tabular-nums">{v}</span>
            </span>
          ))}
        </div>
      )}

      {!label && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <span className="text-[9px] font-mono text-zinc-700">select an effect to visualize</span>
        </div>
      )}
    </div>
  );
};
