/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Play, Square, Volume2, Music, 
  Trash2, Copy, Layers, Target,
  ChevronRight, Sparkles, Plus, Activity
} from 'lucide-react';

interface Track {
  id: string;
  name: string;
  steps: boolean[];
  color: string;
  gain: number;
}

export const StepSequencer: React.FC = () => {
  const [tracks, setTracks] = useState<Track[]>([
    { id: '1', name: 'Kick_Synth', steps: Array(16).fill(false).map((_, i) => i % 4 === 0), color: '#ef4444', gain: 0.8 },
    { id: '2', name: 'Glitch_Perc', steps: Array(16).fill(false).map((_, i) => Math.random() > 0.7), color: '#3b82f6', gain: 0.6 },
    { id: '3', name: 'Atmo_Pad', steps: Array(16).fill(false).map((_, i) => i === 0), color: '#8b5cf6', gain: 0.4 },
    { id: '4', name: 'Neural_Lead', steps: Array(16).fill(false), color: '#10b981', gain: 0.7 },
  ]);

  const [currentStep, setCurrentStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(128);

  const toggleStep = (trackId: string, stepIndex: number) => {
    setTracks(tracks.map(t => 
      t.id === trackId 
        ? { ...t, steps: t.steps.map((s, i) => i === stepIndex ? !s : s) } 
        : t
    ));
  };

  return (
    <div className="hardware-card h-full flex flex-col bg-black/40">
      <div className="flex items-center justify-between p-2 border-b border-white/5 bg-black/20">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            <span className="mono-label">Patt-Sequencer / Grid</span>
          </div>
          
          <div className="h-4 w-px bg-white/10" />
          
          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <span className="text-[7px] font-mono text-zinc-600 uppercase leading-none">Tempo</span>
              <input 
                type="number" 
                value={bpm} 
                onChange={(e) => setBpm(parseInt(e.target.value))}
                className="bg-transparent border-none outline-none text-[12px] font-mono text-cyan-500 w-12 font-black"
              />
            </div>
            <div className="flex gap-1.5">
               <button 
                 onClick={() => setIsPlaying(!isPlaying)}
                 className={`p-1.5 rounded transition-all ${isPlaying ? 'bg-red-500/20 text-red-400' : 'bg-cyan-500/20 text-cyan-400'}`}
               >
                 {isPlaying ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
               </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
           <button className="btn-ghost flex items-center gap-1.5 py-1 text-[9px]"><Sparkles className="w-3 h-3 text-purple-400" /> AI AUTO-FILL</button>
           <button className="p-1 px-2 border border-white/5 rounded hover:bg-white/5"><Plus className="w-3 h-3" /></button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]">
        {tracks.map((track) => (
          <div key={track.id} className="flex gap-2 group">
            {/* Track Info */}
            <div className="w-32 flex-shrink-0 flex flex-col bg-black/40 rounded p-1.5 border border-white/5 group-hover:border-white/10 transition-colors">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[9px] font-black uppercase text-zinc-300 truncate" style={{ color: track.color }}>{track.name}</span>
                <Volume2 className="w-2.5 h-2.5 text-zinc-700" />
              </div>
              <div className="h-0.5 bg-zinc-800 rounded-full w-full mt-auto">
                 <div className="h-full bg-zinc-600 rounded-full" style={{ width: `${track.gain * 100}%` }} />
              </div>
            </div>

            {/* Grid */}
            <div className="flex-1 grid grid-cols-16 gap-1">
              {track.steps.map((active, i) => (
                <button
                  key={i}
                  onClick={() => toggleStep(track.id, i)}
                  className={`relative aspect-square rounded-sm border transition-all
                    ${active ? 'shadow-[0_0_10px]' : 'border-white/5 hover:border-white/20 bg-white/[0.02]'}
                    ${i === currentStep && isPlaying ? 'ring-1 ring-white z-10 scale-105' : ''}
                    ${i % 4 === 0 ? 'opacity-100' : 'opacity-60'}
                  `}
                  style={{ 
                    backgroundColor: active ? track.color : undefined,
                    borderColor: active ? track.color : undefined,
                    boxShadow: active ? `0 0 10px ${track.color}44` : undefined
                  }}
                >
                  {i % 4 === 0 && !active && <div className="absolute top-0.5 left-0.5 w-0.5 h-0.5 rounded-full bg-zinc-800" />}
                </button>
              ))}
            </div>

            {/* Track Actions */}
            <div className="w-8 flex flex-col items-center justify-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
               <button className="text-zinc-700 hover:text-white"><Target className="w-3 h-3" /></button>
               <button className="text-zinc-700 hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
            </div>
          </div>
        ))}

        {/* Step Indicator */}
        <div className="flex gap-2 mt-1">
          <div className="w-32 flex-shrink-0" />
          <div className="flex-1 grid grid-cols-16 gap-1">
            {Array.from({ length: 16 }).map((_, i) => (
              <div key={i} className="flex justify-center">
                <div className={`w-1 h-1 rounded-full transition-all ${i === currentStep && isPlaying ? 'bg-cyan-500 scale-125' : 'bg-zinc-800'}`} />
              </div>
            ))}
          </div>
          <div className="w-8" />
        </div>
      </div>

      <div className="h-6 border-t border-white/5 bg-black/60 flex items-center justify-between px-3">
         <div className="flex items-center gap-4">
            <span className="text-[7px] font-mono text-zinc-600 uppercase flex items-center gap-1.5">
               <Activity className="w-2.5 h-2.5" /> MIDI LINK ACTIVE
            </span>
            <span className="text-[7px] font-mono text-zinc-600 uppercase tracking-tighter">Clock: EXT // 48k</span>
         </div>
         <div className="flex items-center gap-2">
            <span className="text-[7px] font-mono text-cyan-500/80 uppercase">Pattern_A01</span>
            <ChevronRight className="w-2.5 h-2.5 text-zinc-700" />
         </div>
      </div>
    </div>
  );
};
