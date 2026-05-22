/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Database, Search, Layers, Activity, Clock, 
  Trash2, Download, Plus, ChevronRight, Sliders,
  Waves, Cpu, Zap, Headphones, Settings
} from 'lucide-react';

const CATEGORIES = [
  { id: 'stacks', label: 'Stacks', icon: Layers, color: 'text-purple-400' },
  { id: 'dynamics', label: 'Dynamics', icon: Activity, color: 'text-blue-400' },
  { id: 'tempo', label: 'Tempo', icon: Clock, color: 'text-emerald-400' },
  { id: 'cleanup', label: 'Cleanup', icon: Trash2, color: 'text-red-400' },
];

const EFFECTS = {
  stacks: [
    { id: 'master', name: 'Master Chain', type: 'DSP' },
    { id: 'vocal', name: 'Vocal Pro', type: 'VST' },
    { id: 'lofi', name: 'Vinyl Dust', type: 'VST' },
  ],
  dynamics: [
    { id: 'comp', name: 'Tube Comp', type: 'DSP' },
    { id: 'eq', name: 'B-EQ 800', type: 'DSP' },
  ],
  tempo: [
    { id: 'stretch', name: 'Elastique', type: 'LIB' },
  ],
  cleanup: [
    { id: 'denoise', name: 'AI-Clear', type: 'NEU' },
  ]
};

export const ModuleSidebar: React.FC = () => {
  const [activeCat, setActiveCat] = useState('stacks');
  const [search, setSearch] = useState('');

  return (
    <div className="flex flex-col h-full bg-[#0d0b16] border-l border-white/5 w-[240px] z-20 shadow-2xl">
      <div className="p-3 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-2 mb-3">
          <Database className="w-3.5 h-3.5 text-purple-500" />
          <span className="text-[10px] font-black uppercase tracking-widest text-zinc-300">Module Browser</span>
        </div>
        
        <div className="relative group">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600 group-focus-within:text-purple-500 transition-colors" />
          <input 
            type="text" 
            placeholder="Search plugins..." 
            className="w-full bg-black/40 border border-white/5 rounded px-7 py-1.5 text-[10px] font-mono text-white outline-none focus:border-purple-500/50 transition-all placeholder:text-zinc-800"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-1.5 py-3 space-y-4">
        {CATEGORIES.map(cat => (
          <div key={cat.id} className="space-y-1">
            <button 
              onClick={() => setActiveCat(activeCat === cat.id ? '' : cat.id)}
              className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded transition-all group
                ${activeCat === cat.id ? 'bg-white/5 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              <cat.icon className={`w-3.5 h-3.5 ${activeCat === cat.id ? cat.color : 'opacity-40 group-hover:opacity-100'}`} />
              <span className="text-[10px] font-bold flex-1 text-left uppercase tracking-tighter">{cat.label}</span>
              <ChevronRight className={`w-2.5 h-2.5 transition-transform ${activeCat === cat.id ? 'rotate-90' : 'opacity-20'}`} />
            </button>

            <AnimatePresence>
              {activeCat === cat.id && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden pl-5 space-y-0.5"
                >
                  {(EFFECTS[cat.id as keyof typeof EFFECTS] || []).map(fx => (
                    <button 
                      key={fx.id}
                      className="w-full text-left px-2 py-1.5 rounded hover:bg-white/5 text-[9px] font-mono text-zinc-500 hover:text-purple-300 transition-colors flex items-center justify-between group/fx"
                    >
                      <span className="truncate">{fx.name}</span>
                      <span className="text-[7px] opacity-0 group-hover/fx:opacity-40 uppercase">{fx.type}</span>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>

      <div className="p-3 border-t border-white/5 bg-black/10">
         <div className="space-y-2">
            <div className="flex justify-between items-center px-1">
               <span className="text-[8px] font-mono text-zinc-600 uppercase">Engine Status</span>
               <div className="flex items-center gap-1.5">
                  <div className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />
                  <span className="text-[8px] font-mono text-green-500/80 uppercase">Optimized</span>
               </div>
            </div>
            <div className="p-2 bg-black/40 rounded border border-white/5">
                <div className="flex items-center gap-2 mb-1.5">
                   <div className="w-5 h-5 rounded bg-purple-500/20 flex items-center justify-center">
                      <Cpu className="w-2.5 h-2.5 text-purple-400" />
                   </div>
                   <div className="flex flex-col">
                      <span className="text-[9px] font-black text-zinc-400 uppercase leading-none">Sonic_Core</span>
                      <span className="text-[7px] font-mono text-zinc-700 italic">Load: 12.4ms</span>
                   </div>
                </div>
                <div className="h-0.5 bg-zinc-800 rounded-full overflow-hidden">
                   <div className="h-full bg-purple-500 w-[45%]" />
                </div>
            </div>
         </div>
      </div>
    </div>
  );
};
