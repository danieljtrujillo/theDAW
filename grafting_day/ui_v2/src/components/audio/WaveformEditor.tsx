/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import { motion } from 'motion/react';
import { 
  Scissors, Play, Square, ZoomIn, ZoomOut, 
  ChevronLeft, ChevronRight, Magnet, Split,
  Trash2, Move, Copy, RotateCcw, Plus, Volume2
} from 'lucide-react';

interface AudioClip {
  id: string;
  start: number;
  duration: number;
  color: string;
  label: string;
  waveformType?: number;
}

interface Track {
  id: string;
  name: string;
  volume: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  clips: AudioClip[];
}

export const WaveformEditor: React.FC = () => {
  const [tracks, setTracks] = useState<Track[]>([
    {
      id: 't1',
      name: 'Synth Lead',
      volume: 80,
      pan: 0,
      mute: false,
      solo: false,
      clips: [{ id: '1', start: 10, duration: 25, color: '#8b5cf6', label: 'Generated_Main', waveformType: 1 }]
    },
    {
      id: 't2',
      name: 'Transients',
      volume: 65,
      pan: -20,
      mute: false,
      solo: false,
      clips: [{ id: '2', start: 45, duration: 15, color: '#a855f7', label: 'Hit_02', waveformType: 2 }]
    }
  ]);
  
  const [zoom, setZoom] = useState(1);
  const [scroll, setScroll] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Mock global wave shapes for different types
  const getWaveData = (seed: number) => {
     return Array.from({ length: 100 }, (_, i) => Math.abs(Math.sin(i * 0.1 * seed)) * 0.8 + 0.1);
  };

  const addTrack = () => {
    setTracks([...tracks, {
      id: `t${Date.now()}`,
      name: `Track ${tracks.length + 1}`,
      volume: 75,
      pan: 0,
      mute: false,
      solo: false,
      clips: []
    }]);
  };

  const updateTrack = (id: string, updates: Partial<Track>) => {
    setTracks(tracks.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  const toggleSolo = (id: string) => {
    const track = tracks.find(t => t.id === id);
    if (!track) return;
    const isSoloing = !track.solo;
    
    setTracks(tracks.map(t => ({
      ...t,
      solo: t.id === id ? isSoloing : (isSoloing ? false : t.solo)
    })));
  };

  return (
    <div className="hardware-card h-full flex flex-col bg-black/40 overflow-hidden">
      {/* Editor Toolbar */}
      <div className="flex items-center justify-between p-2 border-b border-white/5 bg-black/20 flex-shrink-0">
        <div className="flex items-center gap-4">
          <button 
             onClick={addTrack}
             className="btn-primary flex items-center gap-1.5 !bg-purple-600/20 !border-purple-500/30 !text-purple-400 !px-2 !py-0.5 text-[9px]"
          >
            <Plus className="w-3 h-3" /> ADD TRACK
          </button>
          
          <div className="h-4 w-px bg-white/10" />
          
          <div className="flex bg-black/40 p-0.5 rounded border border-white/5 gap-0.5">
            <button className="p-1 px-2 rounded hover:bg-white/5 transition-colors text-zinc-500 hover:text-white group">
              <Move className="w-3 h-3" />
            </button>
            <button className="p-1 px-2 rounded bg-purple-600/20 text-purple-400 border border-purple-500/30">
              <Scissors className="w-3 h-3" />
            </button>
            <button className="p-1 px-2 rounded hover:bg-white/5 transition-colors text-zinc-500 hover:text-white">
              <Split className="w-3 h-3" />
            </button>
          </div>

          <div className="flex items-center gap-2 px-2 py-0.5 bg-black/40 border border-white/5 rounded">
            <Magnet className="w-3 h-3 text-zinc-600" />
            <span className="text-[9px] font-mono text-zinc-400 uppercase tracking-tighter">Snap: 1/16</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <button onClick={() => setZoom(z => Math.max(0.5, z - 0.1))} className="p-1 hover:bg-white/5 rounded text-zinc-600"><ZoomOut className="w-3 h-3" /></button>
            <span className="text-[9px] font-mono text-zinc-500 w-8 text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom(z => Math.min(4, z + 0.1))} className="p-1 hover:bg-white/5 rounded text-zinc-600"><ZoomIn className="w-3 h-3" /></button>
          </div>
          <div className="h-4 w-px bg-white/10" />
          <button className="p-1.5 hover:bg-white/10 rounded text-zinc-400 hover:text-red-400" title="Delete Clip">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Timeline Ruler */}
      <div className="h-5 border-b border-white/5 bg-black/40 relative overflow-hidden flex flex-shrink-0">
        <div className="w-[180px] bg-black/20 border-r border-white/5 flex-shrink-0" />
        <div className="flex-1 relative overflow-hidden">
          <div 
            className="absolute inset-0 flex"
            style={{ transform: `translateX(-${scroll}px)`, width: `${100 * zoom}%` }}
          >
            {Array.from({ length: 50 }).map((_, i) => (
              <div key={i} className="flex-shrink-0 w-12 border-l border-white/5 h-full flex items-center px-1">
                <span className="text-[7px] font-mono text-zinc-700">{i}:00</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Waveform Track Container */}
      <div 
        ref={containerRef}
        className="flex-1 relative overflow-auto bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] cursor-crosshair group flex flex-col"
      >
        {tracks.map(track => (
          <div key={track.id} className="flex h-24 border-b border-white/5 group/track min-w-max">
            {/* Track Header */}
            <div className="w-[180px] bg-[#0c0a12] border-r border-[#1a1528] p-2 flex flex-col gap-1.5 flex-shrink-0 sticky left-0 z-10 shadow-[2px_0_10px_rgba(0,0,0,0.5)]">
               <div className="flex justify-between items-center">
                  <input 
                    type="text" 
                    value={track.name} 
                    onChange={(e) => updateTrack(track.id, { name: e.target.value })}
                    className="bg-transparent border-none outline-none text-[10px] font-bold text-zinc-300 w-24 hover:bg-white/5 px-1 rounded -ml-1 transition-colors" 
                  />
                  <div className="flex gap-1">
                     <button 
                       onClick={() => updateTrack(track.id, { mute: !track.mute })}
                       className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center transition-colors ${track.mute ? 'bg-red-500/20 text-red-500 border border-red-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                     >M</button>
                     <button 
                       onClick={() => toggleSolo(track.id)}
                       className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center transition-colors ${track.solo ? 'bg-yellow-500/20 text-yellow-500 border border-yellow-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                     >S</button>
                  </div>
               </div>

               <div className="flex items-center gap-2 mt-auto">
                  <Volume2 className="w-3 h-3 text-zinc-600 flex-shrink-0" />
                  <input 
                    type="range" 
                    min="0" max="100" 
                    value={track.volume} 
                    onChange={(e) => updateTrack(track.id, { volume: parseInt(e.target.value) })}
                    className="flex-1 accent-purple-500 h-1 bg-black rounded appearance-none" 
                  />
               </div>
               
               <div className="flex items-center gap-2">
                  <span className="text-[7px] font-mono text-zinc-600 uppercase w-3">Pan</span>
                  <input 
                    type="range" 
                    min="-50" max="50" 
                    value={track.pan} 
                    onChange={(e) => updateTrack(track.id, { pan: parseInt(e.target.value) })}
                    className="flex-1 accent-blue-500 h-1 bg-black rounded appearance-none" 
                  />
                  <span className="text-[7px] font-mono text-zinc-600 text-right w-4">{track.pan > 0 ? 'R'+track.pan : track.pan < 0 ? 'L'+Math.abs(track.pan) : 'C'}</span>
               </div>
            </div>

            {/* Track Timeline */}
            <div 
               className="flex-1 relative cursor-crosshair overflow-hidden group/timeline w-[2000px]"
               style={{ width: `${2000 * zoom}px` }}
            >
              {/* Grid Lines */}
              <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.02)_1px,transparent_1px)]" style={{ backgroundSize: `${48 * zoom}px 100%` }} />

              {track.clips.map((clip) => {
                const wave = getWaveData(clip.waveformType || 1);
                return (
                  <motion.div
                    key={clip.id}
                    onClick={() => setSelection(clip.id)}
                    className={`absolute top-2 bottom-2 rounded border transition-all cursor-move group/clip overflow-hidden
                      ${selection === clip.id ? 'border-white z-10 shadow-[0_0_20px_rgba(255,255,255,0.1)]' : 'border-white/10 hover:border-white/30'}`}
                    style={{ 
                      left: `${clip.start * zoom}%`, 
                      width: `${clip.duration * zoom}%`,
                      backgroundColor: `${clip.color}22`,
                    }}
                  >
                    <div className="absolute inset-0 flex items-center gap-[0.5px] px-1 opacity-80 group-hover/clip:opacity-100 transition-opacity">
                        {wave.map((v, i) => (
                          <div key={i} className="flex-1 rounded-sm" style={{ height: `${v * (selection === clip.id ? 80 : 60)}%`, backgroundColor: clip.color }} />
                        ))}
                    </div>
                    
                    <div className="absolute top-0 left-0 right-0 p-1 bg-black/40 backdrop-blur-sm border-b border-white/5 flex justify-between items-center opacity-0 group-hover/clip:opacity-100 transition-opacity">
                      <span className="text-[8px] font-mono text-white truncate max-w-[80px] uppercase tracking-tighter shadow-black drop-shadow-md">{clip.label}</span>
                      <span className="text-[7px] font-mono text-zinc-300">{(clip.duration / 10).toFixed(1)}s</span>
                    </div>

                    <div className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-white/40 transition-colors" />
                    <div className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-white/40 transition-colors" />
                    
                    <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/clip:opacity-100 pointer-events-none">
                        <Scissors className="w-4 h-4 text-white/20" />
                    </div>
                  </motion.div>
                )
              })}
            </div>
          </div>
        ))}
        {/* Playhead Overlay */}
        <div 
          className="absolute top-0 bottom-0 w-[1px] bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)] z-20 pointer-events-none"
          style={{ left: `calc(180px + ${(playhead * zoom) - scroll}px)` }}
        >
          <div className="absolute top-0 -left-1 w-2 h-2 rotate-45 bg-red-500" />
        </div>
      </div>

      {/* Transport & Metadata Bar */}
      <div className="h-8 border-t border-white/5 bg-black/60 flex items-center justify-between px-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <button className="hover:text-purple-400 transition-colors"><RotateCcw className="w-3 h-3 text-zinc-600" /></button>
            <div className="h-3 w-px bg-white/10" />
            <button className="text-purple-500 hover:text-purple-400 transition-colors"><Play className="w-3.5 h-3.5 fill-current" /></button>
          </div>
          <span className="text-[10px] font-mono text-zinc-500 tabular-nums">00:00:12:45 / 00:01:00:00</span>
        </div>

        <div className="flex items-center gap-4">
           <div className="flex flex-col items-end">
              <span className="text-[7px] font-mono text-zinc-600 uppercase">Region</span>
              <span className="text-[8px] font-mono text-purple-400 tracking-tighter">SELECT_01 // 4.5s</span>
           </div>
           <button className="btn-primary !py-0.5 !px-2 rounded-sm text-[9px]">COMMIT EDIT</button>
        </div>
      </div>
    </div>
  );
};
