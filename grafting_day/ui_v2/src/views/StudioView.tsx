import React, { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Sliders, Waves, Share2, 
  Settings, Zap, Layers, Link,
   ChevronDown, Settings2, SlidersHorizontal, Activity, Move, Plus, X, Heart, UploadCloud
} from 'lucide-react';
import { Section } from '../components/ui/Section';
import { useStudioStore } from '../state/studioStore';

export const StudioView: React.FC = () => {
   const fileInputRef = useRef<HTMLInputElement | null>(null);
   const sourceFile = useStudioStore((state) => state.sourceFile);
   const outputUrl = useStudioStore((state) => state.outputUrl);
   const isProcessing = useStudioStore((state) => state.isProcessing);
   const error = useStudioStore((state) => state.error);
   const processHistory = useStudioStore((state) => state.processHistory);
   const setSourceFile = useStudioStore((state) => state.setSourceFile);
   const processAudio = useStudioStore((state) => state.processAudio);
   const reuseOutputAsSource = useStudioStore((state) => state.reuseOutputAsSource);
   const clearOutput = useStudioStore((state) => state.clearOutput);

   const [macros, setMacros] = useState({
    drive: 24,
    width: 60,
    air: 15,
    punch: 40
  });

   const [fxChain, setFxChain] = useState([
      { name: 'mastering_chain', label: 'Mastering Chain', active: true, colorClass: 'bg-blue-500' },
      { name: 'compression', label: 'Compressor', active: true, colorClass: 'bg-purple-500' },
      { name: 'lowpass', label: 'Lowpass', active: false, colorClass: 'bg-zinc-500' },
   ]);
   const [selectedFxIndex, setSelectedFxIndex] = useState(0);

    const selectedEffect = fxChain[selectedFxIndex]?.name || 'mastering_chain';

    const buildEffectParams = (effect: string): Record<string, number> => {
         if (effect === 'compression') {
            return {
               attack: Math.max(0.01, macros.drive / 100),
               decay: Math.max(0.1, macros.width / 50),
            };
         }
         if (effect === 'lowpass') {
            return {
               frequency: 500 + Math.round((macros.air / 100) * 16000),
            };
         }
         return {
            lowBoost: (macros.punch - 50) / 8,
            highBoost: (macros.air - 50) / 8,
            limiterCeiling: 0.92,
            targetLUFS: -14,
         };
    };

   const handleProcess = () => {
      void processAudio({
         effect: selectedEffect,
         params: buildEffectParams(selectedEffect),
      });
   };

  return (
    <div className="flex flex-col gap-2 h-full text-[11px] pb-4 px-2 pt-2">
      
      <Section title="STUDIO MACROS" icon={SlidersHorizontal} defaultOpen={true}>
             <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(event) => {
                   const file = event.target.files?.[0] ?? null;
                   setSourceFile(file);
                }}
             />
         <div className="space-y-4">
             <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between"><span className="mono-label !text-[9px]">Global Drive</span><span className="mono-label !text-[9px] text-zinc-400">{macros.drive}%</span></div>
                <input 
                  type="range" 
                  className="pro-slider accent-blue-500" 
                  value={macros.drive}
                  onChange={(e) => setMacros({...macros, drive: parseInt(e.target.value)})}
                />
             </div>
             <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between"><span className="mono-label !text-[9px]">Stereo Width</span><span className="mono-label !text-[9px] text-zinc-400">{macros.width + 100}%</span></div>
                <input 
                  type="range" 
                  className="pro-slider accent-blue-500" 
                  value={macros.width}
                  onChange={(e) => setMacros({...macros, width: parseInt(e.target.value)})}
                />
             </div>
             <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between"><span className="mono-label !text-[9px]">Spectral Air</span><span className="mono-label !text-[9px] text-zinc-400">{macros.air}%</span></div>
                <input 
                  type="range" 
                  className="pro-slider accent-blue-500" 
                  value={macros.air}
                  onChange={(e) => setMacros({...macros, air: parseInt(e.target.value)})}
                />
             </div>
             <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between"><span className="mono-label !text-[9px]">Transient Punch</span><span className="mono-label !text-[9px] text-zinc-400">{macros.punch}%</span></div>
                <input 
                  type="range" 
                  className="pro-slider accent-blue-500" 
                  value={macros.punch}
                  onChange={(e) => setMacros({...macros, punch: parseInt(e.target.value)})}
                />
             </div>
         </div>
         <div className="grid grid-cols-2 gap-2 mt-2">
                  <button className="btn-ghost text-[9px] py-1.5 flex items-center justify-center gap-1.5" onClick={() => {
                     setMacros({ drive: 24, width: 60, air: 15, punch: 40 });
                  }}>
               <RefreshCw className="w-3 h-3" /> RESET ALL
            </button>
            <button className="btn-ghost text-[9px] py-1.5 flex items-center justify-center gap-1.5 text-blue-400 border-blue-500/20 bg-blue-500/5" onClick={handleProcess} disabled={isProcessing || !sourceFile}>
               <Heart className="w-3 h-3" /> {isProcessing ? 'PROCESSING...' : 'PROCESS AUDIO'}
            </button>
         </div>
         <button className="btn-ghost text-[9px] py-1.5 flex items-center justify-center gap-1.5 mt-2" onClick={() => fileInputRef.current?.click()}>
            <UploadCloud className="w-3 h-3" /> {sourceFile ? 'CHANGE SOURCE' : 'LOAD SOURCE'}
         </button>
         {sourceFile && <p className="text-[9px] font-mono text-zinc-500 mt-2">SOURCE: {sourceFile.name}</p>}
         {error && <p className="text-[9px] font-mono text-red-400 mt-2">{error}</p>}
      </Section>

      <Section title="INSERT EFFECTS [FX-01]" icon={Layers} defaultOpen={true} rightNode={<span className="text-[8px] font-mono text-zinc-600 uppercase">3 SLOTS</span>}>
         <div className="flex flex-col gap-1.5">
                  {fxChain.map((fx, i) => (
                      <div
                         key={`${fx.name}-${i}`}
                         className={`flex items-center justify-between p-2 rounded bg-black/40 border group cursor-pointer transition-colors relative overflow-hidden ${selectedFxIndex === i ? 'border-blue-500/60' : 'border-white/5 hover:border-white/10'}`}
                         onClick={() => setSelectedFxIndex(i)}
                      >
                           {fx.active && <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${fx.colorClass} shadow-[0_0_8px_rgba(59,130,246,0.5)]`} />}
                  <div className="flex items-center gap-2">
                               <div className={`w-1.5 h-1.5 rounded-full ${fx.active ? fx.colorClass : 'bg-zinc-800'}`} />
                               <span className={`text-[10px] font-bold ${fx.active ? 'text-zinc-200' : 'text-zinc-600'}`}>{fx.label}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                               <button
                                  className="p-1 hover:bg-white/10 rounded transition-colors"
                                  onClick={(event) => {
                                     event.stopPropagation();
                                     setFxChain((prev) => prev.map((item, idx) => (idx === i ? { ...item, active: !item.active } : item)));
                                  }}
                                  title="Toggle effect"
                               >
                                  <Settings2 className="w-3 h-3 text-zinc-500 hover:text-white" />
                               </button>
                               <button
                                  className="p-1 hover:bg-white/10 rounded transition-colors"
                                  onClick={(event) => {
                                     event.stopPropagation();
                                     setFxChain((prev) => {
                                        const next = prev.filter((_, idx) => idx !== i);
                                        if (next.length === 0) {
                                           return prev;
                                        }
                                        setSelectedFxIndex((current) => Math.max(0, Math.min(current, next.length - 1)));
                                        return next;
                                     });
                                  }}
                                  title="Remove effect"
                               >
                                  <X className="w-3 h-3 text-zinc-700 hover:text-red-500" />
                               </button>
                  </div>
               </div>
            ))}
                  <button
                     className="w-full flex items-center justify-center gap-2 py-2 border border-dashed border-white/5 rounded text-zinc-600 hover:text-zinc-400 hover:border-white/10 transition-all text-[9px] font-black uppercase tracking-widest mt-1"
                     onClick={() => {
                        const additions = [
                           { name: 'mastering_chain', label: 'Mastering Chain', colorClass: 'bg-blue-500' },
                           { name: 'compression', label: 'Compressor', colorClass: 'bg-purple-500' },
                           { name: 'lowpass', label: 'Lowpass', colorClass: 'bg-zinc-500' },
                        ];
                        const next = additions[(fxChain.length + 1) % additions.length];
                        setFxChain((prev) => [...prev, { ...next, active: true }]);
                     }}
                  >
               <Plus className="w-3 h-3" /> Add Effect Hook
            </button>
         </div>
      </Section>

      <Section title="SELECTED PARAMS" icon={Settings2} defaultOpen={true} rightNode={<span className="mono-tag text-blue-500/80!">LINEAR EQ</span>}>
         <div className="grid grid-cols-2 gap-2 mb-2">
             <div className="flex flex-col gap-1">
                <label className="mono-label">Low Cut</label>
                <input type="text" className="compact-input w-full" defaultValue="45 Hz" />
             </div>
             <div className="flex flex-col gap-1">
                <label className="mono-label">High Shelf</label>
                <input type="text" className="compact-input w-full" defaultValue="-1.2 dB" />
             </div>
         </div>
         <div className="w-full h-24 bg-[#0a080f] rounded border border-white/5 relative overflow-hidden group cursor-crosshair">
            <svg viewBox="0 0 100 40" className="w-full h-full opacity-40 text-blue-500 mix-blend-screen" preserveAspectRatio="none">
               <path d="M0,35 Q10,35 20,30 T40,20 T60,15 T80,10 T100,20" fill="none" stroke="currentColor" strokeWidth="1" />
               <circle cx="20" cy="30" r="1.5" fill="currentColor" className="animate-pulse" />
               <circle cx="50" cy="18" r="1.5" fill="currentColor" />
               <circle cx="85" cy="12" r="1.5" fill="currentColor" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
               <span className="text-[8px] font-mono font-black tracking-[0.2em] text-blue-400">EQ CURVE RESPONSE</span>
            </div>
         </div>
         <div className="flex flex-col gap-1 mt-2">
            <div className="flex items-center justify-between"><span className="mono-label !text-[9px]">Filter Reso</span><span className="mono-label !text-[9px] text-zinc-500">0.42</span></div>
            <input type="range" className="pro-slider accent-blue-500" defaultValue="42" />
         </div>
             {outputUrl && (
                <div className="mt-3 border-t border-white/10 pt-2 space-y-2">
                   <audio controls src={outputUrl} className="w-full" />
                   <div className="grid grid-cols-3 gap-2">
                      <a href={outputUrl} download="studio-output.wav" className="btn-ghost text-[9px] py-1.5 text-center">DOWNLOAD</a>
                      <button className="btn-ghost text-[9px] py-1.5" onClick={() => void reuseOutputAsSource()}>REUSE</button>
                      <button className="btn-ghost text-[9px] py-1.5" onClick={clearOutput}>CLEAR</button>
                   </div>
                </div>
             )}
      </Section>

         <Section title="PROCESS HISTORY" icon={Activity} defaultOpen={false}>
            <div className="space-y-1">
               {processHistory.length === 0 && <p className="text-[9px] font-mono text-zinc-600">No process jobs yet.</p>}
               {processHistory.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between p-1.5 bg-white/5 rounded">
                     <span className="text-[9px] font-mono text-zinc-300 uppercase">{entry.effect}</span>
                     <span className="text-[8px] font-mono text-zinc-600">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                  </div>
               ))}
            </div>
         </Section>

    </div>
  );
};

const RefreshCw = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M3 21v-5h5" /></svg>
);
