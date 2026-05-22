import React, { useState, useRef, useMemo, useEffect } from 'react';
import { 
  ChevronUp, ChevronDown, X, Upload, Eye, EyeOff, Zap, Trash2, 
  Download, Layers, Activity, Clock, Eraser, Music 
} from 'lucide-react';
import {
  useEffectChainStore,
  EFFECT_LABELS,
} from '../state/effectChainStore';
import { useAdvancedEditorSourceStore } from '../state/advancedEditorStore';
import { useStudioStore } from '../state/studioStore';
import { useLibraryStore } from '../state/libraryStore';
import { WaveformPreview } from '../components/audio/WaveformPreview';

/* ── Param bounds: [min, max, step] ───────────────────────────────── */
const PARAM_BOUNDS: Record<string, Record<string, [number, number, number]>> = {
  mastering_chain: { lowBoost: [-6, 6, 0.5], highBoost: [-6, 6, 0.5], limiterCeiling: [0.8, 1, 0.01], targetLUFS: [-24, -8, 0.5] },
  compression: { attack: [0.01, 1, 0.01], decay: [0.1, 2, 0.1] },
  highpass: { frequency: [20, 1000, 1] },
  volume: { level: [0, 3, 0.01] },
  tempo: { rate: [0.5, 2, 0.05] },
  vocal_processing: { highpassFreq: [40, 200, 1], presenceBoost: [-6, 6, 0.5], targetLUFS: [-24, -8, 0.5] },
  lofi_vinyl: { degradation: [0, 10, 0.5], lowpassFreq: [2000, 16000, 100] },
  stereo_widener: { delayMs: [1, 40, 1] },
  reverb_delay: { delayMs: [100, 2000, 10], decay: [0.1, 0.9, 0.01], reverbDecay: [0.1, 0.9, 0.01] },
  sub_exciter: { subBoost: [0, 12, 0.5], trebleBoost: [0, 8, 0.5] },
  phase_isolation: { cancelAmount: [0.5, 1, 0.01] },
  eq_mid: { frequency: [20, 20000, 1], width: [50, 5000, 10], gain: [-12, 12, 0.5] },
  loudnorm: { targetLUFS: [-30, -8, 0.5], truePeak: [-6, 0, 0.1] },
  lowpass: { frequency: [500, 20000, 100] },
  pitch_shift: { shift: [-4800, 4800, 100] },
  delay: { leftMs: [0, 2000, 10], rightMs: [0, 2000, 10] },
  echo: { delayMs: [100, 3000, 10], decay: [0.1, 0.8, 0.01] },
  fade: { fadeInDuration: [0, 10, 0.1], fadeOutDuration: [0, 10, 0.1] },
  denoise: { noiseReduction: [5, 50, 1] },
  declick: { windowSize: [10, 100, 1] },
  silence_remove: { threshold: [-80, -20, 1] },
  export_flac: { compressionLevel: [0, 12, 1] },
  export_mp3: { bitrate: [128, 320, 8] },
  export_aac: { bitrate: [128, 320, 8] },
  export_opus: { bitrate: [64, 256, 8] },
};

/* ── Effect catalog for UI ─────────────────────────────────────────── */
const EFFECT_CATALOG: Record<string, Array<{ id: string; name: string; desc: string; params: number }>> = {
  stacks: [
    { id: 'mastering_chain', name: 'Mastering Chain', desc: 'EQ → Compression → Limiter → Loudness Normalization → 24-bit', params: 4 },
    { id: 'vocal_processing', name: 'Vocal Processing', desc: 'Highpass → EQ → Compression → Loudness Normalization', params: 3 },
    { id: 'lofi_vinyl', name: 'Lo-Fi / Vinyl', desc: 'Downsample → Highpass → Lowpass → Chorus for vintage character', params: 2 },
    { id: 'stereo_widener', name: 'Stereo Widener', desc: 'Haas effect — microscopic delay on right channel', params: 1 },
    { id: 'reverb_delay', name: 'Reverb + Delay', desc: 'Ping-pong delay cascade with long-decay ambient echo', params: 3 },
    { id: 'sub_exciter', name: 'Club EQ', desc: 'Sub bass boost + treble exciter for club-ready sound', params: 2 },
    { id: 'phase_isolation', name: 'Vocal Removal', desc: 'Phase cancellation to remove center-panned material', params: 1 },
  ],
  dynamics: [
    { id: 'compression', name: 'Compressor', desc: 'Dynamic range compression with adjustable attack and release', params: 2 },
    { id: 'loudnorm', name: 'Loudness Norm', desc: 'Normalize loudness to broadcast standards', params: 2 },
    { id: 'volume', name: 'Volume', desc: 'Simple volume gain control', params: 1 },
    { id: 'limiter', name: 'Limiter', desc: 'Brick-wall limiting to prevent clipping', params: 1 },
    { id: 'gate', name: 'Gate', desc: 'Noise gate to silence audio below threshold', params: 2 },
    { id: 'expander', name: 'Expander', desc: 'Upward expander for increasing dynamic range', params: 2 },
  ],
  tempo: [
    { id: 'tempo', name: 'Time Stretch', desc: 'Change tempo without affecting pitch', params: 1 },
    { id: 'pitch_shift', name: 'Pitch Shift', desc: 'Shift pitch up or down in semitones', params: 1 },
    { id: 'bpm_detect', name: 'BPM Detect', desc: 'Automatically detect tempo of audio', params: 0 },
    { id: 'tempo_sync', name: 'Tempo Sync', desc: 'Sync audio to project tempo', params: 1 },
    { id: 'beat_quantize', name: 'Beat Quantize', desc: 'Snap audio to nearest beat grid', params: 1 },
  ],
  cleanup: [
    { id: 'denoise', name: 'Noise Reduction', desc: 'AI-powered noise reduction for clean audio', params: 1 },
    { id: 'declick', name: 'Click Removal', desc: 'Remove clicks and pops from recordings', params: 1 },
    { id: 'hum_filter', name: 'Hum Filter', desc: 'Remove 50/60Hz hum and harmonics', params: 1 },
  ],
  export: [
    { id: 'export_wav', name: 'WAV Encoder', desc: 'Export as uncompressed WAV file', params: 1 },
    { id: 'export_mp3', name: 'MP3 Encoder', desc: 'Export as MP3 with variable bitrate', params: 1 },
    { id: 'export_flac', name: 'FLAC Encoder', desc: 'Export as lossless FLAC file', params: 1 },
    { id: 'export_ogg', name: 'OGG Encoder', desc: 'Export as Ogg Vorbis file', params: 1 },
  ],
};

const CATEGORY_META = [
  { id: 'stacks', label: 'Stacks', icon: Layers, count: 7 },
  { id: 'dynamics', label: 'Dynamics', icon: Activity, count: 6 },
  { id: 'tempo', label: 'Tempo', icon: Clock, count: 5 },
  { id: 'cleanup', label: 'Cleanup', icon: Eraser, count: 3 },
  { id: 'export', label: 'Export', icon: Download, count: 4 },
];

function fileFromDrop(e: React.DragEvent): File | null {
  const libId = e.dataTransfer.getData('application/x-stabledaw-library-id');
  if (libId) {
    const entry = useLibraryStore.getState().entries.find((en) => en.id === libId);
    if (entry) return new File([entry.audioBlob], `${entry.title.slice(0, 40)}.wav`, { type: entry.mimeType || 'audio/wav' });
  }
  return e.dataTransfer.files[0] || null;
}

/* ── Param slider ──────────────────────────────────────────────────── */
function ParamSlider({ label, value, onChange, effect, paramKey }: {
  label: string; value: number; onChange: (v: number) => void; effect: string; paramKey: string;
}) {
  const [min, max, step] = PARAM_BOUNDS[effect]?.[paramKey] || [0, 1, 0.01];
  return (
    <div className="flex items-center gap-2">
      <span className="mono-label shrink-0 w-20 truncate" title={label}>{label}</span>
      <input type="range" className="pro-slider flex-1" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} title={label} />
      <input type="number" className="compact-input w-16 text-center" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} title={label} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */

export const AdvancedEditorPanel: React.FC = () => {
  const sourceFile = useAdvancedEditorSourceStore((s) => s.sourceFile);
  const outputUrl = useAdvancedEditorSourceStore((s) => s.outputUrl);
  const setSource = useAdvancedEditorSourceStore((s) => s.setSource);
  const setOutputUrl = useAdvancedEditorSourceStore((s) => s.setOutputUrl);

  const chain = useEffectChainStore((s) => s.chain);
  const addEffect = useEffectChainStore((s) => s.addEffect);
  const removeEffect = useEffectChainStore((s) => s.removeEffect);
  const updateParams = useEffectChainStore((s) => s.updateParams);
  const toggleEnabled = useEffectChainStore((s) => s.toggleEnabled);
  const reorder = useEffectChainStore((s) => s.reorder);
  const clearChain = useEffectChainStore((s) => s.clearChain);

  const [activeCategory, setActiveCategory] = useState('stacks');
  const [processing, setProcessing] = useState(false);
  const [outputFormat, setOutputFormat] = useState('wav');
  const [dragOverSource, setDragOverSource] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sourceUrl = useMemo(() => sourceFile ? URL.createObjectURL(sourceFile) : null, [sourceFile]);
  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverSource(false);
    const file = fileFromDrop(e);
    if (file) {
      setSource(file);
      useStudioStore.getState().setSourceFile(file);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setSource(f);
      useStudioStore.getState().setSourceFile(f);
    }
    e.target.value = '';
  };

  const handleProcess = async () => {
    const source = useAdvancedEditorSourceStore.getState().sourceFile;
    if (!source) return;
    const enabled = chain.filter((e) => e.enabled);
    if (enabled.length === 0) return;
    setProcessing(true);
    let currentFile = source;
    for (const entry of enabled) {
      useStudioStore.getState().setSourceFile(currentFile);
      useStudioStore.getState().setOutputFormat(outputFormat);
      await useStudioStore.getState().processAudio({ effect: entry.effect, params: entry.params });
      const url = useStudioStore.getState().outputUrl;
      if (!url) break;
      const blob = await (await fetch(url)).blob();
      currentFile = new File([blob], `chain-${entry.effect}.${outputFormat}`, { type: blob.type });
    }
    const finalUrl = useStudioStore.getState().outputUrl;
    if (finalUrl) setOutputUrl(finalUrl);
    setProcessing(false);
  };

  const handleDownload = () => {
    if (!outputUrl) return;
    const a = document.createElement('a');
    a.href = outputUrl;
    a.download = `processed.${outputFormat}`;
    a.click();
  };

  const activeEffects = EFFECT_CATALOG[activeCategory as keyof typeof EFFECT_CATALOG] || [];
  const chainIds = new Set(chain.map((e) => e.id));

  return (
    <div className="flex flex-col gap-2 p-3 h-full overflow-y-auto ring-2 ring-purple-900/40 rounded-lg bg-[#0c0c0d]">
      {/* ═══ HEADER ═══════════════════════════════════════════════════ */}
      <div className="flex items-center gap-2 pb-2 border-b border-purple-500/20">
        <Zap className="w-3.5 h-3.5 text-purple-400" />
        <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">EFFECTS PROCESSOR</span>
      </div>

      {/* ═══ ROW 1: SOURCE + OUTPUT ═══════════════════════════════════ */}
      <div className="grid grid-cols-2 gap-2 h-50">
        {/* SOURCE AUDIO */}
        <div className="hardware-card">
          <div className="flex items-center gap-1.5 mb-2">
            <Music className="w-3.5 h-3.5 text-purple-400" />
            <span className="mono-label text-purple-300">SOURCE AUDIO</span>
          </div>
          <div
            className={`flex-1 border-2 border-dashed rounded flex flex-col items-center justify-center gap-1.5 cursor-pointer transition-colors ${
              dragOverSource ? 'border-purple-500 bg-purple-500/10' : 'border-zinc-700 hover:border-purple-500/50'
            }`}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOverSource(true); }}
            onDragLeave={() => setDragOverSource(false)}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="w-6 h-6 text-zinc-500" />
            <span className="text-sm text-zinc-300">Drop audio file here</span>
            <span className="text-xs text-zinc-500">or click to browse</span>
            {sourceFile && (
              <div className="mt-2 text-[10px] text-purple-300 font-mono max-w-full truncate px-2">
                {sourceFile.name}
              </div>
            )}
          </div>
          <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileSelect} title="Upload audio file" />
        </div>

        {/* OUTPUT */}
        <div className="hardware-card">
          <div className="flex items-center gap-1.5 mb-2">
            <Download className="w-3.5 h-3.5 text-green-400" />
            <span className="mono-label text-green-300">OUTPUT</span>
          </div>
          {outputUrl ? (
            <div className="flex-1 flex flex-col gap-2 min-h-0">
              <div className="flex-1 rounded overflow-hidden border border-white/5">
                <WaveformPreview audioUrl={outputUrl} height={120} />
              </div>
              <button 
                className="btn-ghost flex items-center justify-center gap-1 cursor-pointer text-xs"
                onClick={handleDownload}
              >
                <Download className="w-3 h-3" /> Download
              </button>
            </div>
          ) : (
            <div className="flex-1 border-2 border-dashed border-zinc-700 rounded flex flex-col items-center justify-center gap-1.5">
              <span className="text-4xl text-zinc-700">+</span>
              <span className="text-sm text-zinc-300">Output will appear here</span>
              <span className="text-xs text-zinc-500">Select an effect and process your audio</span>
            </div>
          )}
        </div>
      </div>

      {/* ═══ ROW 2: SIDEBAR + GRID ════════════════════════════════════ */}
      <div className="flex-1 flex gap-2 min-h-0">
        {/* LEFT SIDEBAR */}
        <div className="hardware-card shrink-0 w-35">
          <div className="flex items-center gap-1.5 mb-2">
            <Layers className="w-3.5 h-3.5 text-purple-400" />
            <span className="mono-label text-purple-300">EFFECTS</span>
          </div>
          <div className="flex flex-col gap-0.5">
            {CATEGORY_META.map((cat) => {
              const Icon = cat.icon;
              const active = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-all ${
                    active
                      ? 'text-purple-300 bg-purple-500/5 border-l-2 border-purple-400'
                      : 'text-zinc-400 hover:text-zinc-200 border-l-2 border-transparent'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-[10px] font-bold flex-1 text-left">{cat.label}</span>
                  <span className="text-[9px] text-zinc-500 font-mono">{cat.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* RIGHT: GRID + CHAIN + BOTTOM BAR */}
        <div className="flex-1 flex flex-col gap-2 min-h-0">
          {/* EFFECT CARDS GRID */}
          <div className="hardware-card flex-1 overflow-y-auto">
            <div className="grid grid-cols-4 gap-3 content-start">
              {activeEffects.map((fx) => {
                const inChain = Array.from(chainIds).some((id) => chain.find((e) => e.id === id)?.effect === fx.id);
                return (
                  <div
                    key={fx.id}
                    onClick={() => addEffect(fx.id)}
                    className={`border rounded p-3 cursor-pointer transition-all hover:border-purple-500/50 ${
                      inChain ? 'border-purple-400/40 bg-purple-500/5 ring-1 ring-purple-400/40' : 'border-zinc-800 hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-1">
                      <span className="text-sm font-semibold text-zinc-100">{fx.name}</span>
                      <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-green-500/15 text-green-400">
                        READY
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 line-clamp-2 mb-2">{fx.desc}</p>
                    <span className="text-[9px] text-zinc-500 font-mono">{fx.params} params</span>
                    {inChain && (
                      <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-purple-400 ml-auto" />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ACTIVE CHAIN */}
          {chain.length > 0 && (
            <div className="hardware-card max-h-50 overflow-y-auto">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">ACTIVE CHAIN</span>
                <button className="btn-ghost flex items-center gap-1 cursor-pointer text-zinc-500 hover:text-red-400" onClick={clearChain} title="Clear chain">
                  <Trash2 className="w-3 h-3" /> Clear
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {chain.map((entry, index) => (
                  <div key={entry.id} className={`border border-zinc-800 rounded p-2 transition-opacity ${!entry.enabled ? 'opacity-40' : ''}`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="flex flex-col shrink-0">
                        <button
                          className="text-zinc-600 hover:text-purple-400 cursor-pointer disabled:opacity-20"
                          disabled={index === 0}
                          onClick={() => reorder(index, index - 1)}
                          title="Move up"
                        >
                          <ChevronUp className="w-3 h-3" />
                        </button>
                        <button
                          className="text-zinc-600 hover:text-purple-400 cursor-pointer disabled:opacity-20"
                          disabled={index === chain.length - 1}
                          onClick={() => reorder(index, index + 1)}
                          title="Move down"
                        >
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      </div>
                      <span className="text-[10px] font-mono text-purple-300 font-bold flex-1 truncate">{EFFECT_LABELS[entry.effect] || entry.effect}</span>
                      <button className="text-zinc-500 hover:text-purple-400 cursor-pointer" onClick={() => toggleEnabled(entry.id)} title="Toggle enabled">
                        {entry.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                      </button>
                      <button className="text-zinc-600 hover:text-red-400 cursor-pointer" onClick={() => removeEffect(entry.id)} title="Remove effect">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {Object.keys(entry.params).length > 0 && (
                      <div className="flex flex-col gap-1.5 pl-6">
                        {Object.entries(entry.params).map(([key, val]) => (
                          <ParamSlider
                            key={key}
                            label={key}
                            value={val}
                            effect={entry.effect}
                            paramKey={key}
                            onChange={(v) => updateParams(entry.id, { ...entry.params, [key]: v })}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* BOTTOM BAR */}
          <div className="flex items-center gap-3 p-2 rounded-md bg-zinc-900/60 border border-zinc-800">
            <select className="compact-input w-20" value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)} title="Output format">
              <option value="wav">WAV</option>
              <option value="flac">FLAC</option>
              <option value="mp3">MP3</option>
              <option value="ogg">OGG</option>
            </select>
            <button
              className="flex-1 h-10 rounded-md bg-purple-600 hover:bg-purple-500 text-white font-bold uppercase tracking-wider text-sm flex items-center justify-center gap-2 disabled:bg-purple-900/40 disabled:text-zinc-500 cursor-pointer disabled:cursor-not-allowed"
              disabled={processing || !sourceFile || chain.filter((e) => e.enabled).length === 0}
              onClick={handleProcess}
            >
              <Zap className="w-4 h-4" />
              {processing ? 'Processing...' : 'Process Chain'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
