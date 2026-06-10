import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Zap, Brain, Activity, Terminal, Layers, Cpu, Database, BarChart3, UploadCloud } from 'lucide-react';
import { Section } from '../components/ui/Section';
import { useTrainingStore } from '../state/trainingStore';
import { ControlSurface } from '../components/surface/ControlSurface';
import type { WidgetRegistry } from '../components/surface/widgetTypes';
import type { SurfaceLayout } from '../state/surfaceLayoutStore';

/* ═══ TRAIN tab on the Control-Surface editor ════════════════════════════════
   The LoRA workshop sections become drag-arrangeable pinned panels (like DJ/MIX):
     banner · TARGET ARCHITECTURE · DATASOURCES · AUTOENCODER · TELEMETRY · CONSOLE */

interface TrainParams {
  moduleName: string; targetModule: string; epochs: number; clusters: number; rank: number; alpha: number; datasetPath: string;
}

const TRAIN_LAYOUT_VERSION = 1;
const defaultTrainLayout: SurfaceLayout = {
  version: TRAIN_LAYOUT_VERSION,
  root: 'root',
  nodes: {
    root: { id: 'root', type: 'container', axis: 'column', children: ['bannerP', 'body'], fr: { bannerP: 0.9, body: 7 } },
    bannerP: { id: 'bannerP', type: 'panel', title: 'Workshop', flow: 'row', widgets: [], pinned: 'banner' },
    body: { id: 'body', type: 'container', axis: 'row', children: ['col1', 'col2'], fr: { col1: 1, col2: 1 } },
    col1: { id: 'col1', type: 'container', axis: 'column', children: ['configP', 'datasetP', 'aeP'], fr: { configP: 1.4, datasetP: 1.4, aeP: 1 } },
    col2: { id: 'col2', type: 'container', axis: 'column', children: ['telemetryP', 'consoleP'], fr: { telemetryP: 1.6, consoleP: 1.4 } },
    configP: { id: 'configP', type: 'panel', title: 'Architecture', flow: 'row', widgets: [], pinned: 'config' },
    datasetP: { id: 'datasetP', type: 'panel', title: 'Datasources', flow: 'row', widgets: [], pinned: 'dataset' },
    aeP: { id: 'aeP', type: 'panel', title: 'Autoencoder', flow: 'row', widgets: [], pinned: 'autoencoder' },
    telemetryP: { id: 'telemetryP', type: 'panel', title: 'Telemetry', flow: 'row', widgets: [], pinned: 'telemetry' },
    consoleP: { id: 'consoleP', type: 'panel', title: 'Console', flow: 'row', widgets: [], pinned: 'console' },
  },
};

interface TrainRegArgs {
  params: TrainParams; setParams: (p: TrainParams) => void;
  isTraining: boolean; error: string | null; logs: string[];
  modelInfo: { device?: string } | null;
  encodedLatentsBase64: string | null; decodedAudioUrl: string | null;
  onEncodeClick: () => void; onDecode: () => void; onClearDecoded: () => void;
}

function buildTrainRegistry(p: TrainRegArgs): WidgetRegistry {
  const reg: WidgetRegistry = {};
  const pinned = (id: string, label: string, node: React.ReactNode) => {
    reg[id] = { id, label, group: 'Panels', kind: 'fixed', source: 'builtin', render: () => <div className="h-full w-full min-h-0 overflow-y-auto px-1 py-1 text-[11px]">{node}</div> };
  };

  pinned('banner', 'Workshop', (
    <div className="relative overflow-hidden rounded border border-cyan-500/25 bg-linear-to-br from-cyan-900/15 via-[#0c0a14] to-purple-900/10 px-4 py-3 h-full">
      <div className="flex items-center gap-3 h-full">
        <motion.div
          animate={{ boxShadow: p.isTraining ? ['0 0 0 0 rgba(34,211,238,0.45)', '0 0 0 14px rgba(34,211,238,0)'] : '0 0 0 0 rgba(34,211,238,0)' }}
          transition={{ duration: 1.6, repeat: p.isTraining ? Infinity : 0 }}
          className="w-10 h-10 rounded-full border border-cyan-500/40 bg-cyan-500/10 flex items-center justify-center shrink-0">
          <Brain className="w-5 h-5 text-cyan-300" />
        </motion.div>
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-black uppercase tracking-widest text-cyan-100">Train Workshop</span>
            <span className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border ${p.isTraining ? 'border-cyan-400/50 bg-cyan-400/15 text-cyan-200 animate-pulse' : p.modelInfo?.device ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-white/10 bg-white/3 text-zinc-500'}`}>
              {p.isTraining ? 'TRAINING' : p.modelInfo?.device ? `READY · ${p.modelInfo.device}` : 'IDLE'}
            </span>
          </div>
          <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">LoRA fine-tuning · Autoencoder test bench · Live telemetry</span>
        </div>
        <div className="hidden md:flex flex-col gap-1 shrink-0 text-right">
          <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">Pending</span>
          <span className="text-[10px] font-mono text-cyan-200">{p.params.moduleName || '—'}</span>
          <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">{p.params.epochs} ep · rank {p.params.rank}</span>
        </div>
      </div>
    </div>
  ));

  pinned('config', 'Architecture', (
    <Section title="TARGET ARCHITECTURE" icon={Layers} defaultOpen={true} rightNode={<span className="mono-tag bg-blue-600/20! border-blue-500/30! text-blue-300!">L4-ACCEL</span>}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="train-module-name" className="mono-label">New Lora Identity</label>
          <input id="train-module-name" name="train-module-name" type="text" className="compact-input w-full" value={p.params.moduleName} onChange={(e) => p.setParams({ ...p.params, moduleName: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="train-target-module" className="mono-label">Target Module</label>
            <select id="train-target-module" name="train-target-module" className="compact-input w-full uppercase font-mono" value={p.params.targetModule} onChange={(e) => p.setParams({ ...p.params, targetModule: e.target.value })}>
              <option value="attn_kv">ATTN_KV</option>
              <option value="mlp">MLP_LAYERS</option>
              <option value="to_q">TO_Q_PROJ</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="train-epochs" className="mono-label">Epochs</label>
            <input id="train-epochs" name="train-epochs" type="number" className="compact-input w-full" value={p.params.epochs} onChange={(e) => p.setParams({ ...p.params, epochs: parseInt(e.target.value) || 0 })} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="train-rank" className="mono-label">Rank</label>
            <input id="train-rank" name="train-rank" type="number" className="compact-input w-full" value={p.params.rank} onChange={(e) => p.setParams({ ...p.params, rank: parseInt(e.target.value) || 0 })} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="train-alpha" className="mono-label">Alpha</label>
            <input id="train-alpha" name="train-alpha" type="number" className="compact-input w-full" value={p.params.alpha} onChange={(e) => p.setParams({ ...p.params, alpha: parseInt(e.target.value) || 0 })} />
          </div>
        </div>
      </div>
    </Section>
  ));

  pinned('dataset', 'Datasources', (
    <Section title="CLUSTER QUEUE / DATASOURCES" icon={Database} defaultOpen={true}>
      <div className="border border-dashed border-white/10 rounded p-4 flex flex-col items-center justify-center gap-2 hover:border-orange-500/30 hover:bg-orange-500/5 transition-all cursor-pointer">
        <UploadCloud className="w-5 h-5 text-zinc-600" />
        <span className="text-[9px] text-zinc-500 font-mono tracking-widest uppercase">Load Dataset (.zip / folder)</span>
      </div>
      <input type="text" name="train-dataset-path" className="compact-input w-full mt-2" placeholder="Dataset path on local machine (required by /api/jobs/train-lora)" value={p.params.datasetPath} onChange={(e) => p.setParams({ ...p.params, datasetPath: e.target.value })} />
      <div className="mt-2 space-y-1">
        <div className="flex items-center justify-between p-1.5 bg-white/5 rounded"><span className="text-zinc-400">techno_kicks_2024</span><span className="text-[8px] font-mono text-zinc-600">128 samples</span></div>
        <div className="flex items-center justify-between p-1.5 bg-white/5 rounded opacity-50"><span className="text-zinc-400">ambient_pads_raw</span><span className="text-[8px] font-mono text-zinc-600">Waiting...</span></div>
      </div>
    </Section>
  ));

  pinned('autoencoder', 'Autoencoder', (
    <Section title="AUTOENCODER TEST" icon={BarChart3} defaultOpen={true}>
      <div className="grid grid-cols-2 gap-2">
        <button className="btn-ghost text-[9px] py-1.5" onClick={p.onEncodeClick}>ENCODE AUDIO</button>
        <button className="btn-ghost text-[9px] py-1.5" onClick={p.onDecode}>DECODE LATENTS</button>
      </div>
      <p className="text-[8px] font-mono text-zinc-600 mt-2">{p.encodedLatentsBase64 ? 'Latents ready in memory' : 'No latents encoded yet'}</p>
      {p.decodedAudioUrl && (
        <div className="mt-2 space-y-2">
          <audio controls src={p.decodedAudioUrl} className="w-full" />
          <button className="btn-ghost text-[9px] py-1.5" onClick={p.onClearDecoded}>CLEAR DECODED AUDIO</button>
        </div>
      )}
    </Section>
  ));

  pinned('telemetry', 'Telemetry', (
    <Section title="LIVE TELEMETRY" icon={Activity} defaultOpen={true}>
      <div className="space-y-4 py-2">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between"><div className="flex items-center gap-1.5"><Brain className="w-3 h-3 text-purple-400" /><span className="mono-label">Loss Strategy</span></div><span className="text-[9px] font-mono text-zinc-400">0.024 RMS</span></div>
          <div className="h-16 bg-black/40 rounded border border-white/5 relative overflow-hidden">
            <motion.svg viewBox="0 0 100 40" className="w-full h-full text-purple-500" preserveAspectRatio="none">
              <motion.path initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 10, repeat: Infinity }} d="M0,35 L10,30 L20,32 L30,22 L40,25 L50,15 L60,18 L70,10 L80,12 L90,5 L100,8" fill="none" stroke="currentColor" strokeWidth="1" />
            </motion.svg>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5"><Cpu className="w-3 h-3 text-emerald-400" /><span className="mono-label">GPU Load</span></div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden"><motion.div animate={{ width: p.isTraining ? '88%' : '4%' }} transition={{ duration: 1 }} className="h-full bg-emerald-500" /></div>
            <span className="text-[8px] font-mono text-zinc-600 uppercase">{p.isTraining ? 'Processing clusters' : p.modelInfo?.device ? `Idle // ${p.modelInfo.device}` : 'Idle'}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5"><Zap className="w-3 h-3 text-orange-400" /><span className="mono-label">VRAM Usage</span></div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden"><motion.div animate={{ width: p.isTraining ? '92%' : '12%' }} transition={{ duration: 1 }} className="h-full bg-orange-500" /></div>
            <span className="text-[8px] font-mono text-zinc-600 uppercase">live during training</span>
          </div>
        </div>
      </div>
    </Section>
  ));

  pinned('console', 'Console', (
    <Section title="ENGINE CONSOLE" icon={Terminal} defaultOpen={true}>
      <div className="h-32 bg-[#0a080f] rounded border border-white/5 p-2 font-mono text-[9px] text-zinc-500 overflow-y-auto">
        <p className="text-zinc-600">[ready] System ready for training</p>
        {p.error && <p className="text-red-400">ERROR: {p.error}</p>}
        {p.logs.slice(-20).map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}
        {p.isTraining && <p className="text-zinc-600 mt-2 animate-pulse">Polling job status...</p>}
      </div>
    </Section>
  ));

  return reg;
}

/* ═══════════════════════════════ TrainView ═════════════════════════════════ */

export const TrainView: React.FC = () => {
  const aeFileRef = useRef<HTMLInputElement | null>(null);
  const isTraining = useTrainingStore((s) => s.isTraining);
  const error = useTrainingStore((s) => s.error);
  const logs = useTrainingStore((s) => s.logs);
  const modelInfo = useTrainingStore((s) => s.modelInfo);
  const encodedLatentsBase64 = useTrainingStore((s) => s.encodedLatentsBase64);
  const decodedAudioUrl = useTrainingStore((s) => s.decodedAudioUrl);
  const refreshMetadata = useTrainingStore((s) => s.refreshMetadata);
  const encodeAudioToLatents = useTrainingStore((s) => s.encodeAudioToLatents);
  const decodeLatentsToAudio = useTrainingStore((s) => s.decodeLatentsToAudio);
  const clearDecodedAudio = useTrainingStore((s) => s.clearDecodedAudio);

  const [params, setParams] = useState<TrainParams>({
    moduleName: 'My_Sonic_Lora', targetModule: 'attn_kv', epochs: 200, clusters: 12, rank: 16, alpha: 32, datasetPath: '',
  });

  useEffect(() => { void refreshMetadata(); }, [refreshMetadata]);
  useEffect(() => {
    useTrainingStore.getState().setPendingTrainingPayload({
      modelName: 'medium-rf', dataDir: params.datasetPath, outputDir: params.moduleName || 'lora_out',
      rank: params.rank, alpha: params.alpha, steps: params.epochs,
    });
  }, [params]);

  const registry = buildTrainRegistry({
    params, setParams, isTraining, error, logs, modelInfo,
    encodedLatentsBase64, decodedAudioUrl,
    onEncodeClick: () => aeFileRef.current?.click(),
    onDecode: () => void decodeLatentsToAudio({ modelName: 'same-l', fileFormat: 'wav' }),
    onClearDecoded: clearDecodedAudio,
  });

  return (
    <div className="relative h-full w-full overflow-hidden text-zinc-200">
      <ControlSurface surfaceId="train" registry={registry} defaultLayout={defaultTrainLayout} className="p-1.5" />
      <input
        ref={aeFileRef} type="file" name="train-ae-encode-file" accept="audio/*" className="hidden"
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void encodeAudioToLatents({ modelName: 'same-l', audioFile: file }); }}
        title="Encode audio file"
      />
    </div>
  );
};
