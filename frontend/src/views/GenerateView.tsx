import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, Command, Layers,
  Mic2, FileAudio,
  Plus, X, Settings2, RefreshCw, Scissors,
} from 'lucide-react';
import { Section } from '../components/ui/Section';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { WaveformPreview } from '../components/audio/WaveformPreview';
import { enhanceStableAudioPrompt, type PromptEnhancementTarget } from '../orb-kit/promptEnhancer';

export const GenerateView: React.FC = () => {
  const initAudioInputRef = useRef<HTMLInputElement | null>(null);
  const inpaintAudioInputRef = useRef<HTMLInputElement | null>(null);
  const [enhancingPrompt, setEnhancingPrompt] = useState<PromptEnhancementTarget | null>(null);

  const p = useGenerateParamsStore();
  const setField = p.setField;
  const patch = p.patch;

  const inpaintAudioUrl = useMemo(
    () => (p.inpaintAudioFile ? URL.createObjectURL(p.inpaintAudioFile) : null),
    [p.inpaintAudioFile],
  );
  useEffect(() => {
    return () => {
      if (inpaintAudioUrl) URL.revokeObjectURL(inpaintAudioUrl);
    };
  }, [inpaintAudioUrl]);

  const handleModelChange = (model: string) => {
    const isRf = model.endsWith('-rf');
    patch({
      model,
      // Follow docs defaults: ARC -> 8/1, RF -> 50/7.
      steps: isRf ? 50 : 8,
      cfg: isRf ? 7.0 : 1.0,
    });
  };

  const handleMagicPrompt = async (target: PromptEnhancementTarget) => {
    if (enhancingPrompt) return;
    setEnhancingPrompt(target);
    try {
      const enhanced = await enhanceStableAudioPrompt({
        target,
        positivePrompt: p.prompt,
        negativePrompt: p.negativePrompt,
      });
      if (target === 'positive') {
        setField('prompt', enhanced);
      } else {
        setField('negativePrompt', enhanced);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Prompt enhancement failed.';
      window.dispatchEvent(new CustomEvent('stabledaw:assistant-error', { detail: { message } }));
      console.error('[Prompt Wand]', message);
    } finally {
      setEnhancingPrompt(null);
    }
  };

  const isEnhancingPositive = enhancingPrompt === 'positive';
  const isEnhancingNegative = enhancingPrompt === 'negative';

  return (
    <div className="flex flex-col gap-2 h-full text-[11px] pb-0 px-2 pt-2">

      <Section title="PRIMARY SYNTHESIS / PROMPT" icon={Command} defaultOpen={true} rightNode={<span className="mono-tag bg-purple-600/20! border-purple-500/30! text-purple-300!">RF-ENGINE</span>}>
         <div className="bg-black/40 rounded border border-white/5 focus-within:border-purple-500/50 transition-colors relative group flex flex-col flex-1">
            <textarea
              className="w-full flex-1 bg-transparent border-none outline-none resize-none p-3 text-[12px] text-zinc-200 placeholder:text-zinc-600 min-h-20"
              placeholder="PROMPT / Describe your soundscape, instrument, or atmosphere..."
              value={p.prompt}
              onChange={(e) => setField('prompt', e.target.value)}
            />
            <button
              type="button"
              onClick={() => handleMagicPrompt('positive')}
              disabled={!!enhancingPrompt}
              className={`absolute bottom-2 right-2 transition-colors ${isEnhancingPositive ? 'text-purple-300 animate-pulse' : 'text-zinc-600 group-focus-within:text-purple-500 hover:text-purple-400 disabled:opacity-50'}`}
              title="Enhance positive prompt using the current orb provider"
              aria-label="Enhance positive prompt using the current orb provider"
            >
               <Sparkles className="w-3 h-3" />
            </button>
         </div>
         <div className="relative group">
           <input
             type="text"
             className="compact-input w-full pr-8"
             placeholder="NEGATIVE PROMPT / Avoid specific frequencies, instruments..."
             value={p.negativePrompt}
             onChange={(e) => setField('negativePrompt', e.target.value)}
             title="Negative prompt"
           />
           <button
             type="button"
             onClick={() => handleMagicPrompt('negative')}
             disabled={!!enhancingPrompt}
             className={`absolute right-2 top-1/2 -translate-y-1/2 transition-colors ${isEnhancingNegative ? 'text-purple-300 animate-pulse' : 'text-zinc-600 group-focus-within:text-purple-500 hover:text-purple-400 disabled:opacity-50'}`}
             title="Enhance negative prompt using the current orb provider"
             aria-label="Enhance negative prompt using the current orb provider"
           >
             <Sparkles className="w-3 h-3" />
           </button>
         </div>
      </Section>

      <Section title="GENERATION PARAMETERS" icon={Settings2} defaultOpen={false}>
         <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1">
               <label className="mono-label">Model</label>
               <select
                 className="compact-input w-full"
                 value={p.model}
                 onChange={(e) => handleModelChange(e.target.value)}
               >
                 <option value="small">Small</option>
                 <option value="medium">Medium</option>
                 <option value="small-rf">Small-RF</option>
                 <option value="medium-rf">Medium-RF</option>
               </select>
            </div>
            <div className="flex flex-col gap-1">
               <label className="mono-label">Duration (s)</label>
               <input
                 type="number"
                 className="compact-input w-full"
                 value={p.duration}
                 onChange={(e) => setField('duration', parseInt(e.target.value) || 0)}
               />
            </div>
            <div className="flex flex-col gap-1">
               <label className="mono-label">Batch</label>
               <input
                 type="number"
                 className="compact-input w-full"
                 value={p.batch}
                 onChange={(e) => setField('batch', parseInt(e.target.value) || 1)}
               />
            </div>
            <div className="flex flex-col gap-1">
               <label className="mono-label">Steps</label>
               <input
                 type="number"
                 className="compact-input w-full"
                 value={p.steps}
                 onChange={(e) => setField('steps', parseInt(e.target.value) || 0)}
               />
            </div>
            <div className="flex flex-col gap-1">
               <label className="mono-label">CFG</label>
               <input
                 type="number"
                 step="0.1"
                 className="compact-input w-full"
                 value={p.cfg}
                 onChange={(e) => setField('cfg', parseFloat(e.target.value) || 0)}
               />
            </div>
            <div className="flex flex-col gap-1">
              <label className="mono-label">Seed</label>
              <div className="flex gap-1">
                 <input
                   type="text"
                   className="compact-input flex-1 min-w-0"
                   value={p.seed}
                   onChange={(e) => setField('seed', parseInt(e.target.value) || 0)}
                 />
                 <button
                   className="p-1 bg-white/5 hover:bg-white/10 rounded text-zinc-500 shrink-0"
                   onClick={() => setField('seed', Math.floor(Math.random() * 100000000))}
                   title="Random seed"
                 >
                   <RefreshCw className="w-2.5 h-2.5" />
                 </button>
              </div>
           </div>
         </div>
      </Section>

      <Section title="INIT SIGNAL / CONDITIONING" icon={Mic2} defaultOpen={false} rightNode={<span className="mono-tag text-zinc-500!">BYPASS</span>}>
         <div className="relative border border-dashed border-white/10 rounded p-4 flex flex-col items-center justify-center gap-2 hover:border-purple-500/30 hover:bg-purple-500/5 transition-all">
            <input
              ref={initAudioInputRef}
              type="file"
              accept="audio/*"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                setField('initAudioFile', file);
                // Reset so re-picking the same file re-fires onChange.
                event.target.value = '';
              }}
              title={p.initAudioFile ? 'Replace init audio' : 'Choose init audio'}
            />
            <FileAudio className="w-5 h-5 text-zinc-600 pointer-events-none" />
            <span className="text-[9px] text-zinc-500 font-mono tracking-widest uppercase pointer-events-none">
              {p.initAudioFile ? `Loaded: ${p.initAudioFile.name}` : 'Drop or click to load source audio'}
            </span>
            {p.initAudioFile && (
              <button
                type="button"
                onClick={() => setField('initAudioFile', null)}
                className="absolute top-1 right-1 z-20 p-0.5 rounded bg-black/40 hover:bg-red-500/40 text-zinc-400 hover:text-red-300 transition-colors"
                title="Clear init audio"
              >
                <X className="w-3 h-3" />
              </button>
            )}
         </div>
         <div className="mt-1.5 grid grid-cols-2 gap-2 pt-1.5 border-t border-white/5">
           <div>
              <p className="mono-label mb-0.5 flex justify-between">Init Noise <span className="text-zinc-600">{p.initNoise}</span></p>
              <input
                type="range"
                className="pro-slider"
                min="0" max="1" step="0.01"
                value={p.initNoise}
                onChange={(e) => setField('initNoise', parseFloat(e.target.value))}
              />
           </div>
           <div>
               <p className="mono-label mb-0.5">Type</p>
               <select
                 className="compact-input w-full font-mono text-[9px] uppercase"
                 value={p.initType}
                 onChange={(e) => setField('initType', e.target.value)}
               >
                 <option>Audio</option>
                 <option value="RF-Inversion">RF-Inversion</option>
               </select>
           </div>
        </div>
      </Section>

      <Section
        title="INPAINTING / REGEN REGION"
        icon={Scissors}
        defaultOpen={false}
        rightNode={
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setField('inpaintEnabled', !p.inpaintEnabled);
            }}
            className={`mono-tag ${p.inpaintEnabled ? 'bg-purple-600/30! text-purple-200! border-purple-500/50!' : 'bg-white/5! text-zinc-500! border-white/5!'}`}
          >
            {p.inpaintEnabled ? 'ON' : 'OFF'}
          </button>
        }
      >
         <div className="flex items-center gap-2 mb-1">
           <span className="text-[9px] font-mono text-purple-200 flex-1 truncate">
             {p.inpaintAudioFile ? p.inpaintAudioFile.name : 'No file loaded'}
           </span>
           {p.inpaintAudioFile && (
             <button
               type="button"
               className="p-0.5 text-zinc-500 hover:text-red-400"
               onClick={() => patch({ inpaintAudioFile: null, inpaintEnabled: false, maskStart: 0, maskEnd: 0 })}
               title="Clear inpaint source"
             >
               <X className="w-3 h-3" />
             </button>
           )}
         </div>
         {inpaintAudioUrl ? (
           <div className="rounded overflow-hidden">
             <WaveformPreview
               audioUrl={inpaintAudioUrl}
               height={48}
               enableRegions
               regionStart={p.maskStart}
               regionEnd={p.maskEnd}
               onRegionChange={(start, end) => patch({ maskStart: start, maskEnd: end })}
             />
             <div className="flex justify-between text-[9px] font-mono text-purple-300 mt-1 px-0.5">
               <span>Start: {p.maskStart.toFixed(2)}s</span>
               <span>End: {p.maskEnd.toFixed(2)}s</span>
               <span className="text-zinc-600">
                 {p.maskEnd > p.maskStart ? `Region: ${(p.maskEnd - p.maskStart).toFixed(2)}s` : 'Drag to select region'}
               </span>
             </div>
           </div>
         ) : (
           <div className="relative border border-dashed border-white/10 rounded p-3 flex flex-col items-center justify-center gap-1.5 hover:border-purple-500/30 hover:bg-purple-500/5 transition-all">
             <input
               ref={inpaintAudioInputRef}
               type="file"
               accept="audio/*"
               className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
               onChange={(event) => {
                 const file = event.target.files?.[0] ?? null;
                 patch({
                   inpaintAudioFile: file,
                   inpaintEnabled: file ? true : p.inpaintEnabled,
                   maskStart: 0,
                   maskEnd: 0,
                 });
                 event.target.value = '';
               }}
               title="Choose inpaint source"
             />
             <Scissors className="w-4 h-4 text-zinc-600 pointer-events-none" />
             <span className="text-[9px] text-zinc-500 font-mono tracking-widest uppercase pointer-events-none">Drop source to inpaint</span>
             <span className="text-[8px] text-zinc-700 font-mono pointer-events-none">Drag a purple region on the waveform to mark the regen window</span>
           </div>
         )}
      </Section>

      <Section title="LORA / ADAPTIVE LAYERS" icon={Layers} defaultOpen={false} rightNode={
        <button className="flex items-center gap-1 px-1 bg-white/5 hover:bg-white/10 rounded text-[8px] uppercase font-bold">
          <Plus className="w-2.5 h-2.5" /> Add
        </button>
      }>
        <div className="space-y-1 mb-2">
           {p.loras.map((lora, i) => (
             <div key={i} className="flex items-center gap-2 bg-black/20 p-1.5 rounded border border-white/5">
                <span className="text-[8px] font-mono text-zinc-400 truncate uppercase w-20">{lora.name}</span>
                <input
                  type="range"
                  className="pro-slider flex-1"
                  min="0" max="1" step="0.01"
                  value={lora.weight}
                  onChange={(e) => {
                    const newLoras = p.loras.map((l, idx) => idx === i ? { ...l, weight: parseFloat(e.target.value) } : l);
                    setField('loras', newLoras);
                  }}
                />
                <button
                  className="text-zinc-700 hover:text-red-500"
                  onClick={() => setField('loras', p.loras.filter((_, idx) => idx !== i))}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
             </div>
           ))}
        </div>
        <button
          className="w-full py-1 border border-dashed border-white/10 rounded text-[8px] uppercase font-bold text-zinc-500 hover:text-zinc-300"
          onClick={() => setField('loras', [...p.loras, { name: `Slot_${p.loras.length + 1}`, weight: 1.0, file: null }])}
        >
          Add LoRA Slot
        </button>
      </Section>

      {/* RUN button + Output Status Monitor are now rendered by the Shell as pinned strips above the Processing Log. */}

    </div>
  );
};
