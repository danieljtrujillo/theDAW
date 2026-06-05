/**
 * Floating Design-Mode toolbar (generalized from the DJ DesignToolbar). Out of
 * Design Mode it's a single "Edit Layout" button; in Design Mode it offers Add
 * Panel, Copy (layout JSON to clipboard, to bake a new default), Reset, and
 * Done. Reads/writes the surface's own store instance through context.
 */
import React, { useState } from 'react';
import { LayoutGrid, Plus, Copy, RotateCcw, Check, Move } from 'lucide-react';
import { useSurface } from './surfaceContext';

export const SurfaceToolbar: React.FC = () => {
  const { store } = useSurface();
  const design = store((s) => s.designMode);
  const [copied, setCopied] = useState(false);

  const addPanel = () => {
    const { layout, addPanel: add, splitPanel } = store.getState();
    const root = layout.nodes[layout.root];
    if (root && root.type === 'container') add(layout.root, root.children.length);
    else splitPanel(layout.root, 'row');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(store.getState().exportJSON());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  if (!design) {
    return (
      <button
        onClick={() => store.getState().setDesignMode(true)}
        title="Edit Layout — drag controls and panels to move them, drag borders to resize"
        className="absolute top-1.5 right-2 z-60 flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-black/60 text-zinc-400 hover:text-purple-200 hover:border-purple-400/50 text-[9px] font-black uppercase tracking-widest transition-colors"
      >
        <LayoutGrid className="w-3 h-3" /> Edit Layout
      </button>
    );
  }

  return (
    <div className="absolute top-1.5 right-2 z-60 flex items-center gap-1.5 px-2 py-1 rounded border border-purple-400/50 bg-[#150f22]/95 shadow-xl">
      <span className="flex items-center gap-1 text-[9px] font-black uppercase tracking-widest text-purple-200">
        <Move className="w-3 h-3" /> Design
      </span>
      <span className="text-[8px] font-mono text-zinc-500 max-w-44 leading-tight">
        drag controls + panels · drag borders to resize
      </span>
      <button
        onClick={addPanel}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-purple-200 hover:border-purple-400/50 text-[8px] font-bold uppercase tracking-wider"
        title="Add an empty panel"
      >
        <Plus className="w-3 h-3" /> Panel
      </button>
      <button
        onClick={() => void copy()}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-cyan-200 hover:border-cyan-400/50 text-[8px] font-bold uppercase tracking-wider"
        title="Copy layout JSON (to bake in as the default)"
      >
        <Copy className="w-3 h-3" /> {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        onClick={() => store.getState().reset()}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 text-zinc-300 hover:text-rose-300 hover:border-rose-400/50 text-[8px] font-bold uppercase tracking-wider"
        title="Reset to the default layout"
      >
        <RotateCcw className="w-3 h-3" /> Reset
      </button>
      <button
        onClick={() => store.getState().setDesignMode(false)}
        className="flex items-center gap-1 px-2 py-0.5 rounded border border-emerald-400/50 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 text-[8px] font-black uppercase tracking-wider"
        title="Exit Design Mode"
      >
        <Check className="w-3 h-3" /> Done
      </button>
    </div>
  );
};
