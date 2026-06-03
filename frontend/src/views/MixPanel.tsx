import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  Upload, Music, X, Eye, EyeOff, ChevronUp, ChevronDown, Trash2,
  Download, LayoutList, Grid3x3, Send, Sparkles, Plus, Gauge, History, Library,
} from 'lucide-react';
import {
  useEffectChainStore, EFFECT_LABELS, EFFECT_DEFAULTS,
} from '../state/effectChainStore';
import { useAdvancedEditorSourceStore } from '../state/advancedEditorStore';
import { useStudioStore } from '../state/studioStore';
import { useLibraryStore } from '../state/libraryStore';
import { usePlayerStore, getMasterGain } from '../state/playerStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useAppUiStore } from '../state/appUiStore';
import { WaveformPreview } from '../components/audio/WaveformPreview';
import { FooterScrubWave } from '../components/audio/FooterScrubWave';
import { SlideKnob } from '../components/audio/SlideKnob';
import { SlideRow } from '../components/audio/SlideRow';
import { VisualizerPanel } from '../components/audio/VisualizerPanelLazy';
import { EffectsVizPanel } from './EffectsVizPanel';
import {
  EFFECT_CATALOG, PARAM_BOUNDS, CATEGORY_META, fxToCategory,
} from '../lib/effectCatalog';
import '../components/layout/track-controls.css';

/* ═══ MIX (PROCESS) tab ═══════════════════════════════════════════════
   Gold-standard band layout (see docs/DESIGN_PRINCIPLES.md), unifying the
   real effect-chain workflow into one no-scroll screen:
     TOP    — source drop + waveform + stats (inputs up top)
     UPPER  — [category rail + Quick Master] | effect library | active chain
     BOTTOM — output waveform | EFFECTS-VIZ (reserved) | scope/cymatics
   The footer (GlobalGenerateBar) is the PROCESS CHAIN transport. */

const sectionTitle = 'text-[10px] font-black uppercase tracking-widest text-purple-300';

/* Short, column-friendly labels for the per-effect param sliders so the
   fixed-width SlideRow label slot never overflows. Fallback = trimmed key. */
const PARAM_LABELS: Record<string, string> = {
  lowBoost: 'Low', highBoost: 'High', limiterCeiling: 'Ceil', targetLUFS: 'LUFS',
  attack: 'Atk', decay: 'Dec', frequency: 'Freq', level: 'Lvl', rate: 'Rate',
  highpassFreq: 'HP', presenceBoost: 'Pres', degradation: 'Degr', lowpassFreq: 'LP',
  delayMs: 'Delay', reverbDecay: 'Verb', subBoost: 'Sub', trebleBoost: 'Treb',
  cancelAmount: 'Cancel', width: 'Width', gain: 'Gain', truePeak: 'Peak',
  shift: 'Shift', leftMs: 'Left', rightMs: 'Right', fadeInDuration: 'In',
  fadeOutDuration: 'Out', noiseReduction: 'Noise', windowSize: 'Win',
  threshold: 'Thr', compressionLevel: 'Lvl', bitrate: 'Rate',
};
const prettyParam = (k: string) => PARAM_LABELS[k] ?? (k.length > 6 ? k.slice(0, 6) : k);

interface AudioStats { peakDb: number; rmsDb: number; sampleRate: number; duration: number; }

function analyzeAudio(source: File | string): Promise<AudioStats> {
  return new Promise((resolve, reject) => {
    const ctx = new AudioContext();
    const load = typeof source === 'string'
      ? fetch(source).then((r) => r.arrayBuffer())
      : source.arrayBuffer();
    load.then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => {
        const ch = decoded.getChannelData(0);
        let peak = 0, sumSq = 0;
        for (let i = 0; i < ch.length; i++) {
          const a = Math.abs(ch[i]);
          if (a > peak) peak = a;
          sumSq += ch[i] * ch[i];
        }
        const rms = Math.sqrt(sumSq / ch.length);
        ctx.close();
        resolve({
          peakDb: parseFloat((20 * Math.log10(Math.max(peak, 1e-10))).toFixed(1)),
          rmsDb:  parseFloat((20 * Math.log10(Math.max(rms,  1e-10))).toFixed(1)),
          sampleRate: decoded.sampleRate,
          duration: decoded.duration,
        });
      })
      .catch((e) => { ctx.close(); reject(e); });
  });
}

async function fileFromDrop(e: React.DragEvent): Promise<File | null> {
  const libId = e.dataTransfer.getData('application/x-stabledaw-library-id');
  if (libId) {
    const entry = useLibraryStore.getState().entries.find((en) => en.id === libId);
    if (entry) {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      return new File([blob], `${entry.title.slice(0, 40)}.wav`, { type: entry.mimeType || 'audio/wav' });
    }
  }
  return e.dataTransfer.files[0] || null;
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-[8px] font-mono text-zinc-600 uppercase">{label}</span>
      <span className="text-[9px] font-mono text-zinc-300">{value}</span>
    </span>
  );
}

function StatRow({ stats }: { stats: AudioStats }) {
  const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);
  return (
    <div className="flex items-center gap-2">
      <StatPill label="SR" value={`${(stats.sampleRate / 1000).toFixed(1)}kHz`} />
      <span className="text-zinc-700">·</span>
      <StatPill label="Peak" value={`${stats.peakDb}dBFS`} />
      <span className="text-zinc-700">·</span>
      <StatPill label="RMS" value={`${stats.rmsDb}dB`} />
      <span className="text-zinc-700">·</span>
      <StatPill label="Dur" value={fmtDur(stats.duration)} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */

export const MixPanel: React.FC = () => {
  // Source + output (advancedEditorStore is the canonical MIX source/output).
  const sourceFile = useAdvancedEditorSourceStore((s) => s.sourceFile);
  const outputUrl  = useAdvancedEditorSourceStore((s) => s.outputUrl);
  const setSource  = useAdvancedEditorSourceStore((s) => s.setSource);

  // Chain.
  const chain         = useEffectChainStore((s) => s.chain);
  const addEffect     = useEffectChainStore((s) => s.addEffect);
  const removeEffect  = useEffectChainStore((s) => s.removeEffect);
  const updateParams  = useEffectChainStore((s) => s.updateParams);
  const toggleEnabled = useEffectChainStore((s) => s.toggleEnabled);
  const reorder       = useEffectChainStore((s) => s.reorder);
  const clearChain    = useEffectChainStore((s) => s.clearChain);

  // Processing (the footer fires processChain; we read flags for status).
  const outputFormat     = useStudioStore((s) => s.outputFormat);
  const setOutputFormat  = useStudioStore((s) => s.setOutputFormat);
  const isChainProcessing = useStudioStore((s) => s.isChainProcessing);
  const processHistory   = useStudioStore((s) => s.processHistory);

  const [activeCategory, setActiveCategory] = useState('all');
  const [viewMode, setViewMode] = useState<'list' | 'tile'>('tile');
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [srcStats, setSrcStats] = useState<AudioStats | null>(null);
  const [outStats, setOutStats] = useState<AudioStats | null>(null);
  const [dragOverSource, setDragOverSource] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Quick Master — the four params of a mastering_chain entry, wired live.
  const [quickMaster, setQuickMaster] = useState<Record<string, number>>(() => ({ ...EFFECT_DEFAULTS.mastering_chain }));

  // Shared player master gain → the cymatics scope reacts to playback.
  const masterAudio = useMemo<AudioNode | null>(() => { try { return getMasterGain(); } catch { return null; } }, []);

  const sourceUrl = useMemo(() => (sourceFile ? URL.createObjectURL(sourceFile) : null), [sourceFile]);
  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);

  useEffect(() => {
    if (!sourceFile) { setSrcStats(null); return; }
    analyzeAudio(sourceFile).then(setSrcStats).catch(() => setSrcStats(null));
  }, [sourceFile]);
  useEffect(() => {
    if (!outputUrl) { setOutStats(null); return; }
    analyzeAudio(outputUrl).then(setOutStats).catch(() => setOutStats(null));
  }, [outputUrl]);

  // Source is mirrored into studioStore so processAudio/processChain see it.
  const setSourceBoth = (file: File | null) => {
    setSource(file);
    useStudioStore.getState().setSourceFile(file);
  };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOverSource(false);
    const file = await fileFromDrop(e);
    if (file) setSourceBoth(file);
  };
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setSourceBoth(f);
    e.target.value = '';
  };

  // Quick Master → a mastering_chain entry (insert once, then live-update).
  const masterEntry = chain.find((e) => e.effect === 'mastering_chain');
  const setQuickParam = (key: string, v: number) => {
    setQuickMaster((qm) => ({ ...qm, [key]: v }));
    const m = useEffectChainStore.getState().chain.find((e) => e.effect === 'mastering_chain');
    if (m) updateParams(m.id, { ...m.params, [key]: v });
  };
  const applyQuickMaster = () => {
    const existing = useEffectChainStore.getState().chain.find((e) => e.effect === 'mastering_chain');
    if (existing) {
      updateParams(existing.id, { ...quickMaster });
      setSelectedChainId(existing.id);
    } else {
      addEffect('mastering_chain');
      const next = useEffectChainStore.getState().chain;
      const added = next[next.length - 1];
      if (added) { updateParams(added.id, { ...quickMaster }); setSelectedChainId(added.id); }
    }
  };

  // Output result actions.
  const handleDownload = () => {
    if (!outputUrl) return;
    const a = document.createElement('a');
    a.href = outputUrl; a.download = `mix-output.${outputFormat}`; a.click();
  };
  const handleSendToDAW = async () => {
    if (!outputUrl) return;
    try {
      const blob = await fetch(outputUrl).then((r) => r.blob());
      await usePlayerStore.getState().load(blob, { label: `mix-output.${outputFormat}` });
    } catch { /* non-fatal */ }
    useAppUiStore.getState().setCenterTab('edit');
  };
  const handleSendToInpaint = async () => {
    if (!outputUrl) return;
    try {
      const blob = await fetch(outputUrl).then((r) => r.blob());
      const file = new File([blob], `mix-output.${outputFormat}`, { type: blob.type });
      useGenerateParamsStore.getState().patch({ inpaintAudioFile: file, inpaintEnabled: true, maskStart: 0, maskEnd: 0 });
    } catch { /* non-fatal */ }
    useAppUiStore.getState().setCenterTab('make');
  };

  const allEffects     = Object.values(EFFECT_CATALOG).flat();
  const activeEffects  = activeCategory === 'all' ? allEffects : (EFFECT_CATALOG[activeCategory] || []);
  const chainEffectIds = new Set(chain.map((e) => e.effect));
  // The effect whose live params feed the reserved effects-viz region.
  const selectedEntry  = chain.find((e) => e.id === selectedChainId) ?? chain[0] ?? null;

  return (
    <div className="h-full w-full overflow-hidden flex flex-col gap-1.5 p-1.5 text-zinc-200">

      {/* ═══ TOP: source — click or drop anywhere in the waveform field ═══ */}
      <div
        className={`shrink-0 hardware-card relative overflow-hidden flex flex-col cursor-pointer transition-colors ${
          dragOverSource ? 'ring-1 ring-purple-500/60 bg-purple-500/5' : ''
        }`}
        style={{ height: 112 }}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOverSource(true); }}
        onDragLeave={() => setDragOverSource(false)}
        onClick={() => fileInputRef.current?.click()}
        title={sourceFile ? 'Click or drop to replace source audio' : 'Click or drop to load source audio'}
      >
        {/* thin header strip: affordance + name + stats + clear */}
        <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-white/5">
          <Upload className="w-3 h-3 text-zinc-500 shrink-0" />
          <Music className="w-3 h-3 text-purple-400/60 shrink-0" />
          <span className={`text-[10px] font-mono truncate ${sourceFile ? 'text-purple-200' : 'text-zinc-500'}`}>
            {sourceFile ? sourceFile.name : 'Drop audio or click to browse'}
          </span>
          {srcStats && <div className="ml-3 shrink-0"><StatRow stats={srcStats} /></div>}
          {sourceFile && (
            <span role="button" tabIndex={0} className="ml-auto text-zinc-600 hover:text-red-400 transition-colors shrink-0"
              onClick={(e) => { e.stopPropagation(); setSourceBoth(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setSourceBoth(null); } }}>
              <X className="w-3 h-3" />
            </span>
          )}
        </div>
        {/* waveform fills the rest; pointer-events-none so clicks/drops hit the field */}
        <div className="flex-1 min-h-0 relative pointer-events-none">
          {sourceUrl ? (
            <WaveformPreview audioUrl={sourceUrl} height={80} />
          ) : (
            <div className="h-full grid place-items-center">
              <span className="text-[10px] font-mono text-zinc-600">click or drop audio here</span>
            </div>
          )}
        </div>
      </div>
      <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileSelect} title="Upload audio file" />

      {/* ═══ UPPER: [category + Quick Master] | library | chain ═══ */}
      <div className="flex-1 min-h-0 grid gap-1.5" style={{ gridTemplateColumns: '150px minmax(0,1fr) 268px' }}>

        {/* LEFT RAIL — categories + Quick Master */}
        <div className="hardware-card flex flex-col min-h-0 overflow-hidden p-1.5 gap-1.5">
          <span className={sectionTitle}>Effects</span>
          <div className="flex flex-col gap-0.5 overflow-y-auto min-h-0">
            <button onClick={() => setActiveCategory('all')}
              className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${
                activeCategory === 'all' ? 'border-purple-400 text-purple-200 bg-purple-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
              }`}
            >
              <Library className="w-3.5 h-3.5 shrink-0" />
              <span className="text-[10px] font-semibold flex-1 truncate">All</span>
              <span className="text-[8px] font-mono text-zinc-600 shrink-0">{allEffects.length}</span>
            </button>
            {CATEGORY_META.map((cat) => {
              const Icon = cat.icon;
              const active = activeCategory === cat.id;
              return (
                <button key={cat.id} onClick={() => setActiveCategory(cat.id)}
                  className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${
                    active ? 'border-purple-400 text-purple-200 bg-purple-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-[10px] font-semibold flex-1 truncate">{cat.label}</span>
                  <span className="text-[8px] font-mono text-zinc-600 shrink-0">{cat.count}</span>
                </button>
              );
            })}
          </div>

          {/* Quick Master pinned at the rail bottom */}
          <div className="mt-auto pt-2 border-t border-white/8 shrink-0">
            <div className="flex items-center gap-1 mb-2">
              <Gauge className="w-3 h-3 text-purple-300" />
              <span className={sectionTitle}>Quick Master</span>
            </div>
            <div className="grid grid-cols-2 gap-x-1 gap-y-2 place-items-center mb-2">
              <SlideKnob label="Punch" value={quickMaster.lowBoost}        onChange={(v) => setQuickParam('lowBoost', v)}       min={-6}  max={6}  step={0.5}  size={34} />
              <SlideKnob label="Air"   value={quickMaster.highBoost}       onChange={(v) => setQuickParam('highBoost', v)}      min={-6}  max={6}  step={0.5}  size={34} />
              <SlideKnob label="Drive" value={quickMaster.targetLUFS}      onChange={(v) => setQuickParam('targetLUFS', v)}     min={-24} max={-8} step={0.5}  size={34} />
              <SlideKnob label="Ceil"  value={quickMaster.limiterCeiling}  onChange={(v) => setQuickParam('limiterCeiling', v)} min={0.8} max={1}  step={0.01} size={34} />
            </div>
            <button onClick={applyQuickMaster}
              className="w-full btn-ghost text-[9px] py-1 flex items-center justify-center gap-1 text-purple-300 border-purple-500/20 bg-purple-500/5">
              <Plus className="w-3 h-3" /> {masterEntry ? 'Sync Master' : 'Add Quick Master'}
            </button>
          </div>
        </div>

        {/* CENTER HERO — effect library */}
        <div className="hardware-card flex flex-col min-h-0 min-w-0 overflow-hidden p-2">
          <div className="flex items-center justify-between mb-2 shrink-0">
            <span className={sectionTitle}>{activeCategory === 'all' ? 'All Effects' : (CATEGORY_META.find((c) => c.id === activeCategory)?.label ?? 'Effects')}</span>
            <div className="flex items-center gap-0.5 bg-black/40 rounded p-0.5">
              <button onClick={() => setViewMode('list')} title="List view"
                className={`p-1 rounded transition-colors ${viewMode === 'list' ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}>
                <LayoutList className="w-3 h-3" />
              </button>
              <button onClick={() => setViewMode('tile')} title="Icon view"
                className={`p-1 rounded transition-colors ${viewMode === 'tile' ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}>
                <Grid3x3 className="w-3 h-3" />
              </button>
            </div>
          </div>

          {viewMode === 'list' ? (
            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-col gap-1 content-start">
                {activeEffects.map((fx) => {
                  const inChain = chainEffectIds.has(fx.id);
                  return (
                    <div key={fx.id} onClick={() => addEffect(fx.id)}
                      className={`flex items-center gap-2 border rounded px-3 py-2 cursor-pointer transition-all ${
                        inChain ? 'border-purple-400/40 bg-purple-500/5' : 'border-zinc-800 hover:border-purple-500/30 hover:bg-white/5'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] font-medium text-zinc-100 block truncate">{fx.name}</span>
                        <p className="text-[9px] text-zinc-500 truncate mt-0.5">{fx.desc}</p>
                      </div>
                      {inChain && <span className="w-2 h-2 rounded-full bg-purple-400 shrink-0" />}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-wrap gap-3 content-start p-1">
                {activeEffects.map((fx) => {
                  const inChain = chainEffectIds.has(fx.id);
                  const cat = fxToCategory[fx.id] ?? CATEGORY_META[0];
                  const Icon = cat.icon;
                  return (
                    <div key={fx.id} onClick={() => addEffect(fx.id)}
                      className={`relative flex flex-col items-center justify-start gap-1.5 rounded border cursor-pointer transition-all overflow-hidden p-2 ${cat.tile.bg} ${
                        inChain ? `${cat.tile.border} ring-2 ${cat.tile.ring}` : 'border-white/8 hover:border-white/20 hover:brightness-110'
                      }`}
                      style={{ width: 72, height: 80 }}
                    >
                      <div className={`absolute inset-0 ${cat.tile.glow} blur-xl pointer-events-none opacity-70`} />
                      <div className="relative z-10 flex items-center justify-center w-8 h-8 mt-1">
                        <Icon className={`w-6 h-6 ${cat.tile.text}`} />
                      </div>
                      <span className={`text-[9px] font-medium text-center leading-tight relative z-10 ${cat.tile.text} px-0.5 line-clamp-2`}>
                        {fx.name}
                      </span>
                      {inChain && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-white z-10" />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT RAIL — active chain */}
        <div className="hardware-card flex flex-col min-h-0 overflow-hidden p-2">
          <div className="flex items-center justify-between mb-2 shrink-0">
            <span className={sectionTitle}>Chain {chain.length > 0 && <span className="text-zinc-600">({chain.length})</span>}</span>
            {chain.length > 0 && (
              <button className="text-zinc-600 hover:text-red-400 transition-colors" onClick={clearChain} title="Clear chain">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
            {chain.length === 0 ? (
              <div className="flex-1 flex items-center justify-center px-2">
                <span className="text-[10px] text-zinc-600 text-center">Add effects from the library</span>
              </div>
            ) : (
              chain.map((entry, index) => (
                <div key={entry.id} onClick={() => setSelectedChainId(entry.id)}
                  className={`rounded p-1.5 border transition-all cursor-pointer shrink-0 ${
                    selectedEntry?.id === entry.id ? 'border-purple-500/60 bg-purple-500/5' : 'border-zinc-800 hover:border-white/10'
                  } ${!entry.enabled ? 'opacity-40' : ''}`}
                >
                  <div className="flex items-center gap-1">
                    <div className="flex flex-col shrink-0">
                      <button className="text-zinc-600 hover:text-purple-400 disabled:opacity-20" disabled={index === 0}
                        onClick={(e) => { e.stopPropagation(); reorder(index, index - 1); }}>
                        <ChevronUp className="w-2.5 h-2.5" />
                      </button>
                      <button className="text-zinc-600 hover:text-purple-400 disabled:opacity-20" disabled={index === chain.length - 1}
                        onClick={(e) => { e.stopPropagation(); reorder(index, index + 1); }}>
                        <ChevronDown className="w-2.5 h-2.5" />
                      </button>
                    </div>
                    <span className="text-[10px] font-mono text-purple-300 font-semibold flex-1 truncate">{EFFECT_LABELS[entry.effect] || entry.effect}</span>
                    <button className="text-zinc-500 hover:text-purple-400 shrink-0" onClick={(e) => { e.stopPropagation(); toggleEnabled(entry.id); }}>
                      {entry.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    </button>
                    <button className="text-zinc-600 hover:text-red-400 shrink-0" onClick={(e) => { e.stopPropagation(); removeEffect(entry.id); }}>
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  {Object.keys(entry.params).length > 0 && (
                    <div className="flex flex-col gap-1 mt-1.5" onClick={(e) => e.stopPropagation()}>
                      {Object.entries(entry.params).map(([key, val]) => {
                        const [min, max, step] = PARAM_BOUNDS[entry.effect]?.[key] || [0, 1, 0.01];
                        return (
                          <SlideRow key={key} label={prettyParam(key)} value={val} min={min} max={max} step={step}
                            onChange={(v) => updateParams(entry.id, { ...entry.params, [key]: v })} />
                        );
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="shrink-0 pt-2 border-t border-white/8 mt-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-zinc-500 shrink-0">FORMAT</span>
              <select className="compact-input flex-1 text-[10px]" value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)}>
                <option value="wav">WAV</option>
                <option value="flac">FLAC</option>
                <option value="mp3">MP3</option>
                <option value="ogg">OGG</option>
              </select>
              <button
                onClick={() => setShowHistory((v) => !v)}
                title="Process history"
                className={`btn-ghost p-1 shrink-0 ${showHistory ? 'text-purple-300' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                <History className="w-3.5 h-3.5" />
              </button>
            </div>
            {showHistory && (
              <div className="max-h-20 overflow-y-auto flex flex-col gap-0.5">
                {processHistory.length === 0 ? (
                  <span className="text-[9px] font-mono text-zinc-600 px-1">No process jobs yet.</span>
                ) : (
                  processHistory.map((h) => (
                    <div key={h.id} className="flex items-center justify-between px-1.5 py-0.5 bg-white/5 rounded">
                      <span className="text-[9px] font-mono text-zinc-300 uppercase truncate">{EFFECT_LABELS[h.effect] || h.effect}</span>
                      <span className="text-[8px] font-mono text-zinc-600 shrink-0">{new Date(h.createdAt).toLocaleTimeString()}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ═══ BOTTOM: output | effects-viz (reserved) | scope ═══ */}
      <div className="shrink-0 grid gap-1.5" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.25fr) minmax(0,1fr)', height: 200 }}>

        {/* OUTPUT */}
        <div className="hardware-card flex flex-col min-h-0 overflow-hidden p-1.5 gap-1">
          <div className="flex items-center justify-between shrink-0">
            <span className={sectionTitle}>Output</span>
            {outStats && <StatRow stats={outStats} />}
          </div>
          <div className="flex-1 min-h-0 rounded overflow-hidden border border-white/5 relative">
            {outputUrl ? (
              <FooterScrubWave src={outputUrl} height={108} />
            ) : (
              <div className="h-full grid place-items-center">
                <span className="text-[10px] font-mono text-zinc-600">output appears after processing</span>
              </div>
            )}
            {isChainProcessing && (
              <div className="absolute inset-0 grid place-items-center bg-black/50 backdrop-blur-sm">
                <span className="text-[10px] font-mono text-purple-300 animate-pulse">processing chain…</span>
              </div>
            )}
          </div>
          <div className="shrink-0 grid grid-cols-3 gap-1">
            <button onClick={handleDownload} disabled={!outputUrl}
              className="btn-ghost text-[9px] py-1 flex items-center justify-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed hover:border-green-500/50! hover:text-green-200!">
              <Download className="w-3 h-3" /> Save
            </button>
            <button onClick={() => void handleSendToDAW()} disabled={!outputUrl}
              className="btn-ghost text-[9px] py-1 flex items-center justify-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed hover:border-emerald-500/50! hover:text-emerald-200!">
              <Send className="w-3 h-3" /> Edit
            </button>
            <button onClick={() => void handleSendToInpaint()} disabled={!outputUrl}
              className="btn-ghost text-[9px] py-1 flex items-center justify-center gap-1 disabled:opacity-30 disabled:cursor-not-allowed hover:border-purple-500/50! hover:text-purple-200!">
              <Sparkles className="w-3 h-3" /> Inpaint
            </button>
          </div>
        </div>

        {/* EFFECTS VISUALIZATION — reserved center region */}
        <EffectsVizPanel effect={selectedEntry?.effect ?? null} params={selectedEntry?.params ?? {}} className="border-purple-500/15!" />

        {/* SCOPE — cymatics for now; reacts to footer playback (future: spectrogram) */}
        <VisualizerPanel initialMode="orb" flipX iconsSide="left" audioNode={masterAudio} className="border border-purple-500/15" />
      </div>
    </div>
  );
};
