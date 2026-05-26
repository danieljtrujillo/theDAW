import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
  ChevronUp, ChevronDown, X, Upload, Eye, EyeOff, Zap, Trash2,
  Download, Layers, Activity, Clock, Eraser, Music, LayoutList, Grid3x3, SlidersHorizontal,
} from 'lucide-react';
import {
  useEffectChainStore,
  EFFECT_LABELS,
} from '../state/effectChainStore';
import { useAdvancedEditorSourceStore } from '../state/advancedEditorStore';
import { useStudioStore } from '../state/studioStore';
import { useLibraryStore } from '../state/libraryStore';
import { usePlayerStore } from '../state/playerStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { WaveformPreview } from '../components/audio/WaveformPreview';

/* ── Param bounds ──────────────────────────────────────────────────── */
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
    { id: 'delay', name: 'Stereo Delay', desc: 'Independent left/right channel delay in milliseconds', params: 2 },
    { id: 'echo', name: 'Echo', desc: 'Echo with adjustable delay time and decay', params: 2 },
    { id: 'fade', name: 'Fade In/Out', desc: 'Linear fade-in and fade-out over configurable durations', params: 2 },
  ],
  eq: [
    { id: 'highpass', name: 'High-Pass', desc: 'Remove frequencies below cutoff — rolls off mud and rumble', params: 1 },
    { id: 'lowpass', name: 'Low-Pass', desc: 'Remove frequencies above cutoff — tame harshness', params: 1 },
    { id: 'eq_mid', name: 'Parametric EQ', desc: 'Bell-shaped boost or cut at a center frequency', params: 3 },
  ],
  tempo: [
    { id: 'tempo', name: 'Time Stretch', desc: 'Change tempo without affecting pitch', params: 1 },
    { id: 'pitch_shift', name: 'Pitch Shift', desc: 'Shift pitch up or down in cents', params: 1 },
  ],
  cleanup: [
    { id: 'denoise', name: 'Noise Reduction', desc: 'Spectral subtraction to reduce broadband noise', params: 1 },
    { id: 'declick', name: 'Click Removal', desc: 'Remove clicks and pops from recordings', params: 1 },
    { id: 'silence_remove', name: 'Silence Remove', desc: 'Strip leading silence below a dB threshold', params: 1 },
  ],
  export: [
    { id: 'export_mp3', name: 'MP3 Encoder', desc: 'Lossy MP3 at configurable bitrate', params: 1 },
    { id: 'export_flac', name: 'FLAC Encoder', desc: 'Lossless FLAC with configurable compression level', params: 1 },
    { id: 'export_aac', name: 'AAC Encoder', desc: 'AAC (M4A) at configurable bitrate', params: 1 },
    { id: 'export_opus', name: 'Opus Encoder', desc: 'Opus at configurable bitrate — best quality/size ratio', params: 1 },
  ],
};

const CATEGORY_META = [
  { id: 'stacks',   label: 'Stacks',   icon: Layers,             count: 7, tile: { bg: 'bg-purple-950',  text: 'text-purple-200',  border: 'border-purple-500/50', ring: 'ring-purple-400/50', glow: 'bg-purple-500/20' } },
  { id: 'dynamics', label: 'Dynamics', icon: Activity,            count: 6, tile: { bg: 'bg-blue-950',    text: 'text-blue-200',    border: 'border-blue-500/50',   ring: 'ring-blue-400/50',   glow: 'bg-blue-500/20' } },
  { id: 'eq',       label: 'EQ',       icon: SlidersHorizontal,   count: 3, tile: { bg: 'bg-teal-950',    text: 'text-teal-200',    border: 'border-teal-500/50',   ring: 'ring-teal-400/50',   glow: 'bg-teal-500/20' } },
  { id: 'tempo',    label: 'Tempo',    icon: Clock,               count: 2, tile: { bg: 'bg-cyan-950',    text: 'text-cyan-200',    border: 'border-cyan-500/50',   ring: 'ring-cyan-400/50',   glow: 'bg-cyan-500/20' } },
  { id: 'cleanup',  label: 'Cleanup',  icon: Eraser,              count: 3, tile: { bg: 'bg-emerald-950', text: 'text-emerald-200', border: 'border-emerald-500/50',ring: 'ring-emerald-400/50',glow: 'bg-emerald-500/20' } },
  { id: 'export',   label: 'Export',   icon: Download,            count: 4, tile: { bg: 'bg-orange-950',  text: 'text-orange-200',  border: 'border-orange-500/50', ring: 'ring-orange-400/50', glow: 'bg-orange-500/20' } },
];

const catById = Object.fromEntries(CATEGORY_META.map((c) => [c.id, c]));
const fxToCategory: Record<string, typeof CATEGORY_META[0]> = {};
Object.entries(EFFECT_CATALOG).forEach(([catId, fxs]) => {
  fxs.forEach((fx) => { fxToCategory[fx.id] = catById[catId] ?? CATEGORY_META[0]; });
});

async function fileFromDrop(e: React.DragEvent): Promise<File | null> {
  const libId = e.dataTransfer.getData('application/x-stabledaw-library-id');
  if (libId) {
    const entry = useLibraryStore.getState().entries.find((en) => en.id === libId);
    if (entry) {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      return new File(
        [blob],
        `${entry.title.slice(0, 40)}.wav`,
        { type: entry.mimeType || 'audio/wav' },
      );
    }
  }
  return e.dataTransfer.files[0] || null;
}

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

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-[9px] font-mono text-zinc-600 uppercase">{label}</span>
      <span className="text-[10px] font-mono text-zinc-300">{value}</span>
    </span>
  );
}

function ChainParamSlider({ label, value, onChange, effect, paramKey }: {
  label: string; value: number; onChange: (v: number) => void; effect: string; paramKey: string;
}) {
  const [min, max, step] = PARAM_BOUNDS[effect]?.[paramKey] || [0, 1, 0.01];
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-1">
        <span className="text-[9px] font-mono text-zinc-500 truncate leading-none">{label}</span>
        <input type="number" className="compact-input w-14 text-center text-[9px]" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} title={label} />
      </div>
      <input type="range" className="pro-slider w-full" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} title={label} />
    </div>
  );
}

/* ── Column resize handle ──────────────────────────────────────────── */
function ColResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      className="w-2 shrink-0 cursor-col-resize flex items-center justify-center group"
      onMouseDown={onMouseDown}
    >
      <div className="w-px h-full bg-white/5 group-hover:bg-purple-400/50 transition-colors" />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */

export const AdvancedEditorPanel: React.FC = () => {
  const sourceFile   = useAdvancedEditorSourceStore((s) => s.sourceFile);
  const outputUrl    = useAdvancedEditorSourceStore((s) => s.outputUrl);
  const setSource    = useAdvancedEditorSourceStore((s) => s.setSource);
  const setOutputUrl = useAdvancedEditorSourceStore((s) => s.setOutputUrl);

  const chain         = useEffectChainStore((s) => s.chain);
  const addEffect     = useEffectChainStore((s) => s.addEffect);
  const removeEffect  = useEffectChainStore((s) => s.removeEffect);
  const updateParams  = useEffectChainStore((s) => s.updateParams);
  const toggleEnabled = useEffectChainStore((s) => s.toggleEnabled);
  const reorder       = useEffectChainStore((s) => s.reorder);
  const clearChain    = useEffectChainStore((s) => s.clearChain);

  const [activeCategory, setActiveCategory] = useState('stacks');
  const [viewMode, setViewMode] = useState<'list' | 'tile'>('tile');
  const [processing, setProcessing] = useState(false);
  const [outputFormat, setOutputFormat] = useState('wav');
  const [dragOverSource, setDragOverSource] = useState(false);
  const [srcStats, setSrcStats] = useState<AudioStats | null>(null);
  const [outStats, setOutStats] = useState<AudioStats | null>(null);

  // Column widths
  const [sidebarWidth, setSidebarWidth] = useState(150);
  const [chainWidth, setChainWidth] = useState(230);
  const resizingCol = useRef<'sidebar' | 'chain' | null>(null);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const sourceUrl = useMemo(() => sourceFile ? URL.createObjectURL(sourceFile) : null, [sourceFile]);
  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);

  useEffect(() => {
    if (!sourceFile) { setSrcStats(null); return; }
    analyzeAudio(sourceFile).then(setSrcStats).catch(() => setSrcStats(null));
  }, [sourceFile]);

  useEffect(() => {
    if (!outputUrl) { setOutStats(null); return; }
    analyzeAudio(outputUrl).then(setOutStats).catch(() => setOutStats(null));
  }, [outputUrl]);

  // Column resize mouse handling
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const col = resizingCol.current;
      if (!col) return;
      const dx = e.clientX - resizeStartX.current;
      if (col === 'sidebar') setSidebarWidth(Math.max(100, Math.min(280, resizeStartW.current + dx)));
      else setChainWidth(Math.max(160, Math.min(400, resizeStartW.current - dx)));
    };
    const onUp = () => { resizingCol.current = null; document.body.style.cursor = ''; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, []);

  const startResize = useCallback((col: 'sidebar' | 'chain', clientX: number, currentW: number) => {
    resizingCol.current = col;
    resizeStartX.current = clientX;
    resizeStartW.current = currentW;
    document.body.style.cursor = 'col-resize';
  }, []);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOverSource(false);
    const file = await fileFromDrop(e);
    if (file) { setSource(file); useStudioStore.getState().setSourceFile(file); }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setSource(f); useStudioStore.getState().setSourceFile(f); }
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
      await useStudioStore.getState().processAudio({ effect: entry.effect, params: entry.params, skipLibrary: true });
      const url = useStudioStore.getState().outputUrl;
      if (!url) break;
      const blob = await (await fetch(url)).blob();
      currentFile = new File([blob], `chain-${entry.effect}.${outputFormat}`, { type: blob.type });
    }
    const finalUrl = useStudioStore.getState().outputUrl;
    if (finalUrl) {
      setOutputUrl(finalUrl);
      try {
        const finalBlob = await fetch(finalUrl).then((r) => r.blob());
        const chainLabel = enabled.map((e) => EFFECT_LABELS[e.effect] || e.effect).join(' → ');
        const title = `chain-${Date.now()}.${outputFormat}`;
        const entry = await useLibraryStore.getState().importEntry({
          blob: finalBlob,
          filename: title,
          mimeType: finalBlob.type || 'audio/wav',
          metadata: {
            title,
            prompt: chainLabel,
            source: 'studio',
            tags: ['effects-chain'],
          },
        });
        await usePlayerStore.getState().load(finalBlob, { label: title, entryId: entry.id });
      } catch { /* non-fatal */ }
    }
    setProcessing(false);
  };

  const handleDownload = () => {
    if (!outputUrl) return;
    const a = document.createElement('a');
    a.href = outputUrl; a.download = `processed.${outputFormat}`; a.click();
  };

  const handleSendToDAW = async () => {
    if (outputUrl) {
      try {
        const blob = await fetch(outputUrl).then((r) => r.blob());
        await usePlayerStore.getState().load(blob, { label: `processed.${outputFormat}` });
      } catch { /* non-fatal */ }
    }
    window.dispatchEvent(new CustomEvent('stabledaw:navigate', { detail: { tab: 'edit' } }));
  };

  const handleInitInpaint = async () => {
    if (outputUrl) {
      try {
        const blob = await fetch(outputUrl).then((r) => r.blob());
        const file = new File([blob], `processed.${outputFormat}`, { type: blob.type });
        useGenerateParamsStore.getState().patch({ inpaintAudioFile: file, inpaintEnabled: true, maskStart: 0, maskEnd: 0 });
      } catch { /* non-fatal */ }
    }
    window.dispatchEvent(new CustomEvent('stabledaw:navigate', { detail: { tab: 'create' } }));
  };

  const activeEffects  = EFFECT_CATALOG[activeCategory as keyof typeof EFFECT_CATALOG] || [];
  const chainEffectIds = new Set(chain.map((e) => e.effect));
  const fmtDur = (s: number) => s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s.toFixed(1)}s`;

  return (
    <div className="flex flex-col gap-2 p-2 h-full overflow-hidden ring-1 ring-purple-900/30 rounded-lg bg-[#0c0c0d]">

      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 pb-1.5 border-b border-purple-500/20 shrink-0">
        <Zap className="w-3.5 h-3.5 text-purple-400" />
        <span className="text-xs font-black uppercase tracking-widest text-purple-300">Effects Processor</span>
      </div>

      {/* ── Source row ───────────────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-3">
        <div
          className={`flex items-center gap-2 px-2 py-1.5 rounded border border-dashed cursor-pointer transition-colors w-72 shrink-0 ${
            dragOverSource ? 'border-purple-500 bg-purple-500/10' : 'border-zinc-700/60 hover:border-purple-500/40 bg-black/20'
          }`}
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOverSource(true); }}
          onDragLeave={() => setDragOverSource(false)}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="w-3 h-3 text-zinc-500 shrink-0" />
          <Music className="w-3 h-3 text-purple-400/60 shrink-0" />
          <span className={`text-[10px] font-mono flex-1 truncate ${sourceFile ? 'text-purple-300' : 'text-zinc-500'}`}>
            {sourceFile ? sourceFile.name : 'Drop audio or click to browse'}
          </span>
          {sourceFile && (
            <span role="button" tabIndex={0} className="text-zinc-600 hover:text-red-400 transition-colors shrink-0"
              onClick={(e) => { e.stopPropagation(); setSource(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setSource(null); } }}>
              <X className="w-3 h-3" />
            </span>
          )}
        </div>
        {srcStats && (
          <div className="flex items-center gap-3">
            <StatPill label="SR"   value={`${(srcStats.sampleRate / 1000).toFixed(1)}kHz`} />
            <span className="text-zinc-700">·</span>
            <StatPill label="Peak" value={`${srcStats.peakDb}dBFS`} />
            <span className="text-zinc-700">·</span>
            <StatPill label="RMS"  value={`${srcStats.rmsDb}dB`} />
            <span className="text-zinc-700">·</span>
            <StatPill label="Dur"  value={fmtDur(srcStats.duration)} />
          </div>
        )}
      </div>
      <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleFileSelect} title="Upload audio file" />

      {/* ── Middle: [sidebar] | [library] | [chain] — all resizable ─ */}
      <div className="flex-1 flex min-h-0 overflow-hidden">

        {/* Category sidebar */}
        <div
          className="shrink-0 flex flex-col gap-0.5 bg-[#0a0a0c] border border-white/5 rounded-lg p-1.5 overflow-y-auto"
          style={{ width: sidebarWidth }}
        >
          {CATEGORY_META.map((cat) => {
            const Icon = cat.icon;
            const active = activeCategory === cat.id;
            return (
              <button key={cat.id} onClick={() => setActiveCategory(cat.id)}
                className={`flex items-center gap-2 px-2 py-2 rounded w-full transition-colors border-l-2 text-left ${
                  active ? 'border-purple-400 text-purple-200 bg-purple-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="text-[11px] font-semibold flex-1 truncate">{cat.label}</span>
                <span className="text-[9px] font-mono text-zinc-600 shrink-0">{cat.count}</span>
              </button>
            );
          })}
        </div>

        {/* Resize handle: sidebar | library */}
        <ColResizeHandle onMouseDown={(e) => startResize('sidebar', e.clientX, sidebarWidth)} />

        {/* Effect library */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-[#0a0a0c] border border-white/5 rounded-lg p-2 overflow-hidden">
          {/* Library header + view toggle */}
          <div className="flex items-center justify-between mb-2 shrink-0">
            <span className="text-[11px] font-semibold text-zinc-300">
              {CATEGORY_META.find((c) => c.id === activeCategory)?.label ?? 'Effects'}
            </span>
            <div className="flex items-center gap-0.5 bg-black/40 rounded p-0.5">
              <button onClick={() => setViewMode('list')}
                className={`p-1 rounded transition-colors ${viewMode === 'list' ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}
                title="List view"><LayoutList className="w-3 h-3" /></button>
              <button onClick={() => setViewMode('tile')}
                className={`p-1 rounded transition-colors ${viewMode === 'tile' ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}
                title="Icon view"><Grid3x3 className="w-3 h-3" /></button>
            </div>
          </div>

          {/* LIST view */}
          {viewMode === 'list' && (
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
          )}

          {/* TILE view — desktop icons with name */}
          {viewMode === 'tile' && (
            <div className="flex-1 overflow-y-auto">
              <div className="flex flex-wrap gap-3 content-start p-1">
                {activeEffects.map((fx) => {
                  const inChain = chainEffectIds.has(fx.id);
                  const cat = fxToCategory[fx.id] ?? CATEGORY_META[0];
                  const Icon = cat.icon;
                  return (
                    <div key={fx.id} onClick={() => addEffect(fx.id)}
                      className={`relative flex flex-col items-center justify-start gap-1.5 rounded border cursor-pointer transition-all overflow-hidden p-2 ${cat.tile.bg} ${
                        inChain
                          ? `${cat.tile.border} ring-2 ${cat.tile.ring}`
                          : 'border-white/8 hover:border-white/20 hover:brightness-110'
                      }`}
                      style={{ width: 72, height: 80 }}
                    >
                      {/* ambient glow */}
                      <div className={`absolute inset-0 ${cat.tile.glow} blur-xl pointer-events-none opacity-70`} />
                      {/* icon */}
                      <div className="relative z-10 flex items-center justify-center w-8 h-8 mt-1">
                        <Icon className={`w-6 h-6 ${cat.tile.text}`} />
                      </div>
                      {/* name */}
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

        {/* Resize handle: library | chain */}
        <ColResizeHandle onMouseDown={(e) => startResize('chain', e.clientX, chainWidth)} />

        {/* Active chain + controls */}
        <div
          className="shrink-0 flex flex-col min-h-0 bg-[#0a0a0c] border border-white/5 rounded-lg p-2 overflow-hidden"
          style={{ width: chainWidth }}
        >
          <div className="flex items-center justify-between mb-2 shrink-0">
            <span className="text-[11px] font-semibold text-purple-300">Chain</span>
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
                <div key={entry.id}
                  className={`border border-zinc-800 rounded p-1.5 transition-opacity shrink-0 ${!entry.enabled ? 'opacity-40' : ''}`}
                >
                  <div className="flex items-center gap-1">
                    <div className="flex flex-col shrink-0">
                      <button className="text-zinc-600 hover:text-purple-400 disabled:opacity-20" disabled={index === 0} onClick={() => reorder(index, index - 1)}>
                        <ChevronUp className="w-2.5 h-2.5" />
                      </button>
                      <button className="text-zinc-600 hover:text-purple-400 disabled:opacity-20" disabled={index === chain.length - 1} onClick={() => reorder(index, index + 1)}>
                        <ChevronDown className="w-2.5 h-2.5" />
                      </button>
                    </div>
                    <span className="text-[10px] font-mono text-purple-300 font-semibold flex-1 truncate">{EFFECT_LABELS[entry.effect] || entry.effect}</span>
                    <button className="text-zinc-500 hover:text-purple-400 shrink-0" onClick={() => toggleEnabled(entry.id)}>
                      {entry.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    </button>
                    <button className="text-zinc-600 hover:text-red-400 shrink-0" onClick={() => removeEffect(entry.id)}>
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  {Object.keys(entry.params).length > 0 && (
                    <div className="flex flex-col gap-1 pl-4 mt-1">
                      {Object.entries(entry.params).map(([key, val]) => (
                        <ChainParamSlider key={key} label={key} value={val} effect={entry.effect} paramKey={key}
                          onChange={(v) => updateParams(entry.id, { ...entry.params, [key]: v })} />
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Chain controls */}
          <div className="shrink-0 flex flex-col gap-1.5 pt-2 border-t border-white/5 mt-2">
            <select className="compact-input w-full text-[10px]" value={outputFormat} onChange={(e) => setOutputFormat(e.target.value)}>
              <option value="wav">WAV</option>
              <option value="flac">FLAC</option>
              <option value="mp3">MP3</option>
              <option value="ogg">OGG</option>
            </select>
            <button
              className="w-full rounded bg-purple-600 hover:bg-purple-500 text-white font-bold text-[10px] flex items-center justify-center gap-1.5 py-1.5 disabled:bg-purple-900/40 disabled:text-zinc-500 transition-colors disabled:cursor-not-allowed"
              disabled={processing || !sourceFile || chain.filter((e) => e.enabled).length === 0}
              onClick={handleProcess}
            >
              <Zap className="w-3 h-3" />
              {processing ? 'Running...' : 'Process Chain'}
            </button>
            <button
              className="w-full rounded border border-zinc-700 hover:border-purple-500/50 text-zinc-300 hover:text-purple-200 font-medium text-[10px] py-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={!outputUrl} onClick={() => void handleSendToDAW()}
            >Send to DAW</button>
            <button
              className="w-full rounded border border-zinc-700 hover:border-cyan-500/50 text-zinc-300 hover:text-cyan-200 font-medium text-[10px] py-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              disabled={!outputUrl} onClick={() => void handleInitInpaint()}
            >Init / Inpaint</button>
            {outputUrl && (
              <button className="w-full rounded border border-zinc-700 hover:border-green-500/50 text-zinc-300 hover:text-green-200 font-medium text-[10px] flex items-center justify-center gap-1.5 py-1.5 transition-colors" onClick={handleDownload}>
                <Download className="w-3 h-3" /> Download
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Output: full width, h-56 ──────────────────────────────── */}
      <div className="shrink-0 h-56 flex flex-col">
        <div className="flex items-center gap-2 mb-1 shrink-0">
          <Download className="w-3 h-3 text-green-400" />
          <span className="text-[11px] font-semibold text-green-300">Output</span>
          {outStats && (
            <div className="flex items-center gap-2 ml-2">
              <StatPill label="SR"   value={`${(outStats.sampleRate / 1000).toFixed(1)}kHz`} />
              <span className="text-zinc-700">·</span>
              <StatPill label="Peak" value={`${outStats.peakDb}dBFS`} />
              <span className="text-zinc-700">·</span>
              <StatPill label="RMS"  value={`${outStats.rmsDb}dB`} />
              <span className="text-zinc-700">·</span>
              <StatPill label="Dur"  value={fmtDur(outStats.duration)} />
            </div>
          )}
        </div>
        <div className="flex-1 min-h-0">
          {outputUrl ? (
            <div className="h-full rounded overflow-hidden border border-white/5">
              <WaveformPreview audioUrl={outputUrl} height={188} />
            </div>
          ) : (
            <div className="h-full border border-dashed border-zinc-700/40 rounded flex items-center justify-center">
              <span className="text-[10px] text-zinc-600">Output will appear after processing</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
