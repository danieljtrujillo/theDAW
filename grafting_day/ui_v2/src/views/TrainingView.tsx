import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Zap, Brain, Activity, Terminal, 
  Settings2, Layers, Cpu, Database,
  ArrowRight, X, Play, RefreshCw, BarChart3, LineChart, UploadCloud
} from 'lucide-react';
import { Section } from '../components/ui/Section';
import { useTrainingStore } from '../state/trainingStore';

export const TrainingView: React.FC = () => {
   const aeFileRef = useRef<HTMLInputElement | null>(null);
   const isTraining = useTrainingStore((state) => state.isTraining);
   const error = useTrainingStore((state) => state.error);
   const logs = useTrainingStore((state) => state.logs);
   const modelInfo = useTrainingStore((state) => state.modelInfo);
   const encodedLatentsBase64 = useTrainingStore((state) => state.encodedLatentsBase64);
   const decodedAudioUrl = useTrainingStore((state) => state.decodedAudioUrl);
   const refreshMetadata = useTrainingStore((state) => state.refreshMetadata);
   const startLoraTraining = useTrainingStore((state) => state.startLoraTraining);
   const encodeAudioToLatents = useTrainingStore((state) => state.encodeAudioToLatents);
   const decodeLatentsToAudio = useTrainingStore((state) => state.decodeLatentsToAudio);
   const clearDecodedAudio = useTrainingStore((state) => state.clearDecodedAudio);
   const stopPolling = useTrainingStore((state) => state.stopPolling);

  const [params, setParams] = useState({
    moduleName: 'My_Sonic_Lora',
    targetModule: 'attn_kv',
    epochs: 200,
    clusters: 12,
    rank: 16,
      alpha: 32,
      datasetPath: '',
  });

   useEffect(() => {
      void refreshMetadata();
   }, [refreshMetadata]);

   const handleExecute = () => {
      if (isTraining) {
         stopPolling();
         return;
      }

      void startLoraTraining({
         modelName: 'medium-rf',
         dataDir: params.datasetPath,
         outputDir: params.moduleName || 'lora_out',
         rank: params.rank,
         alpha: params.alpha,
         steps: params.epochs,
      });
   };

  return (
    <div className="flex flex-col gap-2 h-full text-[11px] pb-4 px-2 pt-2">
      
      <Section title="TARGET ARCHITECTURE" icon={Layers} defaultOpen={true} rightNode={<span className="mono-tag !bg-blue-600/20 !border-blue-500/30 !text-blue-300">L4-ACCEL</span>}>
         <div className="flex flex-col gap-3">
             <div className="flex flex-col gap-1">
                <label className="mono-label">New Lora Identity</label>
                <input 
                  type="text" 
                  className="compact-input w-full" 
                  value={params.moduleName}
                  onChange={(e) => setParams({...params, moduleName: e.target.value})}
                />
             </div>
             <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                   <label className="mono-label">Target Module</label>
                   <select className="compact-input w-full uppercase font-mono" value={params.targetModule} onChange={(e) => setParams({...params, targetModule: e.target.value})}>
                      <option value="attn_kv">ATTN_KV</option>
                      <option value="mlp">MLP_LAYERS</option>
                      <option value="to_q">TO_Q_PROJ</option>
                   </select>
                </div>
                <div className="flex flex-col gap-1">
                   <label className="mono-label">Epochs</label>
                   <input type="number" className="compact-input w-full" value={params.epochs} onChange={(e) => setParams({...params, epochs: parseInt(e.target.value) || 0})} />
                </div>
             </div>
         </div>
      </Section>

      <Section title="CLUSTER QUEUE / DATASOURCES" icon={Database} defaultOpen={true}>
         <div className="border border-dashed border-white/10 rounded p-4 flex flex-col items-center justify-center gap-2 hover:border-orange-500/30 hover:bg-orange-500/5 transition-all cursor-pointer">
            <UploadCloud className="w-5 h-5 text-zinc-600" />
            <span className="text-[9px] text-zinc-500 font-mono tracking-widest uppercase">Load Dataset (.zip / folder)</span>
         </div>
         <input
           type="text"
           className="compact-input w-full mt-2"
           placeholder="Dataset path on local machine (required by /api/jobs/train-lora)"
           value={params.datasetPath}
           onChange={(e) => setParams({ ...params, datasetPath: e.target.value })}
         />
         <div className="mt-2 space-y-1">
            <div className="flex items-center justify-between p-1.5 bg-white/5 rounded">
               <span className="text-zinc-400">techno_kicks_2024</span>
               <span className="text-[8px] font-mono text-zinc-600">128 samples</span>
            </div>
            <div className="flex items-center justify-between p-1.5 bg-white/5 rounded opacity-50">
               <span className="text-zinc-400">ambient_pads_raw</span>
               <span className="text-[8px] font-mono text-zinc-600">Waiting...</span>
            </div>
         </div>
      </Section>

         <Section title="AUTOENCODER TEST" icon={BarChart3} defaultOpen={false}>
             <input
                ref={aeFileRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(event) => {
                   const file = event.target.files?.[0];
                   if (!file) {
                      return;
                   }
                   void encodeAudioToLatents({ modelName: 'same-l', audioFile: file });
                }}
             />
             <div className="grid grid-cols-2 gap-2">
                  <button className="btn-ghost text-[9px] py-1.5" onClick={() => aeFileRef.current?.click()}>
                     ENCODE AUDIO
                  </button>
                  <button className="btn-ghost text-[9px] py-1.5" onClick={() => void decodeLatentsToAudio({ modelName: 'same-l', fileFormat: 'wav' })}>
                     DECODE LATENTS
                  </button>
             </div>
             <p className="text-[8px] font-mono text-zinc-600 mt-2">
                {encodedLatentsBase64 ? 'Latents ready in memory' : 'No latents encoded yet'}
             </p>
             {decodedAudioUrl && (
                <div className="mt-2 space-y-2">
                   <audio controls src={decodedAudioUrl} className="w-full" />
                   <button className="btn-ghost text-[9px] py-1.5" onClick={clearDecodedAudio}>
                      CLEAR DECODED AUDIO
                   </button>
                </div>
             )}
         </Section>

      <Section title="LIVE TELEMETRY" icon={Activity} defaultOpen={isTraining}>
         <div className="space-y-4 py-2">
             <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                   <div className="flex items-center gap-1.5"><Brain className="w-3 h-3 text-purple-400" /><span className="mono-label">Loss Strategy</span></div>
                   <span className="text-[9px] font-mono text-zinc-400">0.024 RMS</span>
                </div>
                <div className="h-16 bg-black/40 rounded border border-white/5 relative overflow-hidden">
                   <motion.svg viewBox="0 0 100 40" className="w-full h-full text-purple-500" preserveAspectRatio="none">
                      <motion.path 
                        initial={{ pathLength: 0 }} 
                        animate={{ pathLength: 1 }} 
                        transition={{ duration: 10, repeat: Infinity }}
                        d="M0,35 L10,30 L20,32 L30,22 L40,25 L50,15 L60,18 L70,10 L80,12 L90,5 L100,8" 
                        fill="none" 
                        stroke="currentColor" 
                        strokeWidth="1" 
                      />
                   </motion.svg>
                </div>
             </div>

             <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                   <div className="flex items-center gap-1.5"><Cpu className="w-3 h-3 text-emerald-400" /><span className="mono-label">L4 GPU Load</span></div>
                   <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <motion.div animate={{ width: isTraining ? '88%' : '4%' }} transition={{ duration: 1 }} className="h-full bg-emerald-500" />
                   </div>
                   <span className="text-[8px] font-mono text-zinc-600 uppercase">{isTraining ? 'Processing clusters' : modelInfo?.device ? `Idle // ${modelInfo.device}` : 'Idle'}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                   <div className="flex items-center gap-1.5"><Zap className="w-3 h-3 text-orange-400" /><span className="mono-label">VRAM Usage</span></div>
                   <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <motion.div animate={{ width: isTraining ? '92%' : '12%' }} transition={{ duration: 1 }} className="h-full bg-orange-500" />
                   </div>
                   <span className="text-[8px] font-mono text-zinc-600 uppercase">22.4 GB / 24 GB</span>
                </div>
             </div>
         </div>
      </Section>

      <Section title="ENGINE CONSOLE" icon={Terminal} defaultOpen={false}>
         <div className="h-32 bg-[#0a080f] rounded border border-white/5 p-2 font-mono text-[9px] text-zinc-500 overflow-y-auto">
            <p className="text-zinc-600">[{new Date().toLocaleTimeString()}] System ready for training</p>
            {error && <p className="text-red-400">ERROR: {error}</p>}
            {logs.slice(-20).map((line, index) => (
              <p key={`${index}-${line}`}>{line}</p>
            ))}
            {isTraining && <p className="text-zinc-600 mt-2 animate-pulse">Polling job status...</p>}
         </div>
      </Section>

      <Section title="EXECUTION" icon={Settings2} defaultOpen={true}>
         <button 
                onClick={handleExecute}
           className={`w-full py-3 rounded font-black uppercase tracking-widest text-[12px] flex items-center justify-center gap-2 transition-all
             ${isTraining ? 'bg-orange-600/20 border border-orange-500/50 text-orange-500 hover:bg-orange-600/40' : 'btn-primary'}`}
         >
           {isTraining ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
           {isTraining ? 'HALT TRAINING' : 'ENGAGE BACKPROP'}
         </button>
      </Section>

    </div>
  );
};
