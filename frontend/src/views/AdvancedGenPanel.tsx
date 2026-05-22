import React, { useRef, useMemo, useEffect, useState, useCallback } from 'react';
import {
  Play, Pause, Square, RefreshCw, X, Plus,
  Music, Scissors, Mic2, Search, ChevronDown,
  LayoutList, Grid3x3, AudioWaveform, Volume2, Sliders,
  Wand2, Loader2, Save, BookOpen,
} from 'lucide-react';
import { useGenerateParamsStore, GenerateParamsState } from '../state/generateParamsStore';
import { useGenerateStore } from '../state/generateStore';
import { useLibraryStore } from '../state/libraryStore';
import { useAdvancedEditorSourceStore } from '../state/advancedEditorStore';
import { useEditorStore } from '../state/editorStore';
import { WaveformPreview } from '../components/audio/WaveformPreview';
import { uuid } from '../orb-kit/utils';
import { HoverTip, InfoTip } from '../components/ui/Tooltip';
import { RICH_TOOLTIPS, HOVER_TOOLTIPS } from '../components/ui/tooltips';
import { GENERATION_PRESETS, type GenerationPreset } from '../data/generationPresets';
import { enhanceStableAudioPrompt } from '../orb-kit/promptEnhancer';

/* ── SField: label / slider / number / default ────────────────────── */
function SField({ label, value, onChange, min, max, step = 0.01, hint, defaultValue, tipKey }: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step?: number; hint?: string; defaultValue?: number; tipKey?: string;
}) {
  const tip = tipKey ? HOVER_TOOLTIPS[tipKey] : undefined;
  const labelEl = (
    <div className="flex flex-col min-w-0">
      <span className="text-[10px] text-zinc-300 truncate">{label}</span>
      {hint && <span className="text-[8px] text-zinc-500 font-mono">{hint}</span>}
    </div>
  );
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 w-[70px]">{tip ? <HoverTip text={tip}>{labelEl}</HoverTip> : labelEl}</div>
        <input type="range" className="pro-slider flex-1" min={min} max={max} step={step}
          value={value} onChange={(e) => onChange(+e.target.value)} />
        <input type="number" className="compact-input w-14 text-center text-[10px] tabular-nums shrink-0"
          min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value || 0)} />
      </div>
      {defaultValue !== undefined && (
        <span className="text-[8px] text-zinc-500 ml-[78px]">Default: {defaultValue.toFixed(1)}</span>
      )}
    </div>
  );
}

/* ── Spin: label + number + up/down arrows ────────────────────────── */
function Spin({ label, value, onChange, min, max, step = 1, tipKey }: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step?: number; tipKey?: string;
}) {
  const tip = tipKey ? HOVER_TOOLTIPS[tipKey] : undefined;
  const labelEl = <span className="text-[10px] text-zinc-300 truncate">{label}</span>;
  return (
    <div className="flex items-center justify-between gap-1 min-w-0">
      <div className="truncate min-w-0 flex-1">{tip ? <HoverTip text={tip}>{labelEl}</HoverTip> : labelEl}</div>
      <div className="flex items-center shrink-0">
        <input type="number" className="compact-input w-14 text-center text-[10px]"
          value={value} onChange={(e) => onChange(+e.target.value || 0)} min={min} max={max} step={step} />
        <div className="flex flex-col">
          <button onClick={() => onChange(Math.min(max, value + step))} className="text-zinc-500 hover:text-purple-300 cursor-pointer p-0.5">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
          <button onClick={() => onChange(Math.max(min, value - step))} className="text-zinc-500 hover:text-purple-300 cursor-pointer p-0.5">
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Inline number+slider row (for Controls section) ──────────────── */
function CtrlRow({ label, value, onChange, min, max, step = 1, suffix, tipKey, onRandomize }: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step?: number; suffix?: string; tipKey?: string; onRandomize?: () => void;
}) {
  const tip = tipKey ? HOVER_TOOLTIPS[tipKey] : undefined;
  const labelEl = <span className="text-[11px] text-zinc-300">{label}</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 shrink-0">{tip ? <HoverTip text={tip}>{labelEl}</HoverTip> : labelEl}</div>
      <input type="range" className="pro-slider flex-1" min={min} max={max} step={step}
        value={value} onChange={(e) => onChange(+e.target.value)} />
      <input type="number" className="compact-input w-14 text-center tabular-nums shrink-0"
        min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value || 0)} />
      {suffix && <span className="text-[9px] text-zinc-600 w-2 shrink-0">{suffix}</span>}
      {onRandomize && (
        <button className="btn-ghost cursor-pointer p-1 shrink-0" onClick={onRandomize}>
          <RefreshCw className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

/* ── Full audio player (OUTPUT row) ───────────────────────────────── */
function FullAudioPlayer({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(1);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <div className="flex items-center gap-2 px-1">
      <audio ref={ref} src={src} preload="metadata"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setTime(ref.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDur(ref.current?.duration ?? 0)} />
      <button onClick={() => { if (!ref.current) return; playing ? ref.current.pause() : ref.current.play(); }}
        className="text-purple-400 hover:text-purple-300 cursor-pointer w-6 h-6 rounded-full bg-purple-500/10 flex items-center justify-center shrink-0">
        {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
      </button>
      <button onClick={() => { if (ref.current) { ref.current.pause(); ref.current.currentTime = 0; } }}
        className="text-zinc-400 hover:text-zinc-200 cursor-pointer shrink-0">
        <Square className="w-3.5 h-3.5" />
      </button>
      <span className="text-[10px] font-mono text-zinc-400 tabular-nums shrink-0">{fmt(time)} / {fmt(dur)}</span>
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden cursor-pointer"
        onClick={(e) => { if (!ref.current || !dur) return; ref.current.currentTime = ((e.clientX - e.currentTarget.getBoundingClientRect().left) / e.currentTarget.offsetWidth) * dur; }}>
        <div className="h-full bg-purple-500 rounded-full" style={{ width: `${dur ? (time / dur) * 100 : 0}%` }} />
      </div>
      <Volume2 className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
      <input type="range" min={0} max={1} step={0.01} value={vol}
        onChange={(e) => { const v = +e.target.value; setVol(v); if (ref.current) ref.current.volume = v; }}
        className="pro-slider w-16 shrink-0" />
    </div>
  );
}

/* ── Saved Prompts Dropdown ───────────────────────────────────────── */
function SavedPromptsDropdown({ type, value, onChange }: {
  type: 'positive' | 'negative'; value: string; onChange: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const storageKey = `stabledaw.savedPrompts.${type}`;
  const [saved, setSaved] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch { return []; }
  });
  useEffect(() => { localStorage.setItem(storageKey, JSON.stringify(saved)); }, [saved, storageKey]);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  const handleSave = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!saved.includes(trimmed)) setSaved([trimmed, ...saved]);
  };
  return (
    <div className="relative flex items-center gap-1" ref={ref}>
      <button className="btn-ghost flex items-center gap-1 cursor-pointer text-[9px]" onClick={() => setOpen(!open)}>
        <ChevronDown className="w-3 h-3" /> SAVED ({saved.length})
      </button>
      <button className="btn-ghost cursor-pointer p-1" onClick={handleSave} title="Save current">
        <Plus className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute z-30 top-full right-0 mt-1 bg-[var(--panel)] border border-[var(--panel-border)] rounded shadow-2xl min-w-[220px] max-h-[180px] overflow-hidden flex flex-col">
          <div className="flex-1 overflow-y-auto">
            {saved.length === 0 ? (
              <div className="px-3 py-2 text-[9px] text-zinc-600 text-center">No saved prompts</div>
            ) : saved.map((item, i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 cursor-pointer group"
                onClick={() => { onChange(item); setOpen(false); }}>
                <span className="text-[9px] text-zinc-300 truncate flex-1">{item.slice(0, 40)}{item.length > 40 ? '...' : ''}</span>
                <button className="text-zinc-700 hover:text-red-400 opacity-0 group-hover:opacity-100 cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); setSaved(saved.filter((s) => s !== item)); }}>
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Templates Panel ──────────────────────────────────────────────── */
interface Template { id: string; name: string; createdAt: string; params: Partial<GenerateParamsState>; }

function TemplatesPanel() {
  const p = useGenerateParamsStore();
  const [templates, setTemplates] = useState<Template[]>(() => {
    try { return JSON.parse(localStorage.getItem('stabledaw.templates') || '[]'); } catch { return []; }
  });
  const [searchQuery, setSearchQuery] = useState('');
  useEffect(() => { localStorage.setItem('stabledaw.templates', JSON.stringify(templates)); }, [templates]);
  const handleSave = () => {
    const name = window.prompt('Template name:');
    if (!name?.trim()) return;
    const params: Partial<GenerateParamsState> = {
      prompt: p.prompt, negativePrompt: p.negativePrompt, model: p.model, duration: p.duration,
      steps: p.steps, cfg: p.cfg, seed: p.seed, batch: p.batch, samplerType: p.samplerType,
      sigmaMax: p.sigmaMax, durationPaddingSec: p.durationPaddingSec, apgScale: p.apgScale,
      cfgRescale: p.cfgRescale, cfgNormThreshold: p.cfgNormThreshold, cfgIntervalMin: p.cfgIntervalMin,
      cfgIntervalMax: p.cfgIntervalMax, shiftMode: p.shiftMode, logsnrAnchorLength: p.logsnrAnchorLength,
      logsnrAnchorLogsnr: p.logsnrAnchorLogsnr, logsnrRate: p.logsnrRate, logsnrEnd: p.logsnrEnd,
      fluxMinLen: p.fluxMinLen, fluxMaxLen: p.fluxMaxLen, fluxAlphaMin: p.fluxAlphaMin,
      fluxAlphaMax: p.fluxAlphaMax, fullBaseShift: p.fullBaseShift, fullMaxShift: p.fullMaxShift,
      fullMinLen: p.fullMinLen, fullMaxLen: p.fullMaxLen, initNoise: p.initNoise, initType: p.initType,
      initAudioEnabled: p.initAudioEnabled, inversionSteps: p.inversionSteps,
      inversionGamma: p.inversionGamma, inversionUnconditional: p.inversionUnconditional,
      inpaintEnabled: p.inpaintEnabled, maskStart: p.maskStart, maskEnd: p.maskEnd,
      fileFormat: p.fileFormat, fileNaming: p.fileNaming, cutToDuration: p.cutToDuration,
      autoplay: p.autoplay, autoDownload: p.autoDownload,
    };
    setTemplates([{ id: uuid(), name: name.trim(), createdAt: new Date().toISOString(), params }, ...templates]);
  };
  const filtered = templates.filter((t) => t.name.toLowerCase().includes(searchQuery.toLowerCase()));
  return (
    <div className="hardware-card flex flex-col">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">TEMPLATES</span>
        <button className="btn-ghost cursor-pointer p-1" onClick={handleSave} title="Save current">
          <Plus className="w-3 h-3" />
        </button>
      </div>
      <div className="flex items-center gap-1 mb-1.5">
        <Search className="w-3 h-3 text-zinc-600 flex-shrink-0" />
        <input className="compact-input flex-1 text-[9px]" placeholder="Search templates..." value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)} />
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {filtered.length === 0 ? (
          <div className="text-center py-1"><span className="text-[9px] text-zinc-600 font-mono">No templates</span></div>
        ) : (
          <div className="space-y-0.5">
            {filtered.map((t) => (
              <div key={t.id} className="flex items-center gap-1 px-1.5 py-0.5 bg-black/20 rounded hover:bg-white/5 cursor-pointer group">
                <span className="text-[9px] text-zinc-300 flex-1 truncate" onClick={() => p.patch(t.params)}>{t.name}</span>
                <button className="text-zinc-700 hover:text-red-400 opacity-0 group-hover:opacity-100 cursor-pointer"
                  onClick={(e) => { e.stopPropagation(); setTemplates(templates.filter((x) => x.id !== t.id)); }}>
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */

export const AdvancedGenPanel: React.FC<{
  onAddTo?: (target: 'timeline' | 'editor' | 'sequencer' | 'newTrack') => void;
}> = ({ onAddTo }) => {
  const p = useGenerateParamsStore();
  const sf = p.setField;
  const patch = p.patch;

  const isGenerating = useGenerateStore((s) => s.isGenerating);
  const lastAudioUrl = useGenerateStore((s) => s.lastAudioUrl);
  const lastFilename = useGenerateStore((s) => s.lastFilename);
  const submitGeneration = useGenerateStore((s) => s.submitGeneration);
  const libraryEntries = useLibraryStore((s) => s.entries);
  const setEditorSource = useAdvancedEditorSourceStore((s) => s.setSource);
  const addTrack = useEditorStore((s) => s.addTrack);
  const addClip = useEditorStore((s) => s.addClipToTrack);

  const initRef = useRef<HTMLInputElement>(null);
  const inpaintRef = useRef<HTMLInputElement>(null);

  // Prompt enhance state
  const [enhancingPositive, setEnhancingPositive] = useState(false);
  const [enhancingNegative, setEnhancingNegative] = useState(false);

  // Presets dropdown
  const [presetsOpen, setPresetsOpen] = useState(false);
  const applyPreset = useCallback((preset: GenerationPreset) => {
    patch(preset.params);
    setPresetsOpen(false);
  }, [patch]);

  // Spectrogram state
  const [spectrograms, setSpectrograms] = useState<{mel:string,stft:string,chromagram:string,cqt:string}|null>(null);
  const [specTab, setSpecTab] = useState<'mel'|'stft'|'chromagram'|'cqt'>('mel');
  const [specLoading, setSpecLoading] = useState(false);

  useEffect(() => {
    if (!lastAudioUrl) { setSpectrograms(null); setSpecLoading(false); return; }
    let cancelled = false;
    setSpecLoading(true);
    setSpectrograms(null);
    (async () => {
      try {
        const audioRes = await fetch(lastAudioUrl);
        if (!audioRes.ok) throw new Error(`audio fetch failed: ${audioRes.status}`);
        const blob = await audioRes.blob();
        if (cancelled) return;
        const form = new FormData();
        form.append('audio_file', blob, 'output.wav');
        const res = await fetch('/api/spectrogram', {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`/api/spectrogram ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setSpectrograms(data);
      } catch (e) {
        if (cancelled) return;
        console.error('[spectrogram] failed:', e);
        setSpectrograms({ mel: '', stft: '', chromagram: '', cqt: '' });
      } finally {
        if (!cancelled) setSpecLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [lastAudioUrl]);

  const fileFromDrop = useCallback((e: React.DragEvent): File | null => {
    const libId = e.dataTransfer.getData('application/x-stabledaw-library-id');
    if (libId) {
      const entry = libraryEntries.find((en) => en.id === libId);
      if (entry) return new File([entry.audioBlob], `${entry.title.slice(0, 40)}.wav`, { type: entry.mimeType || 'audio/wav' });
    }
    return e.dataTransfer.files[0] || null;
  }, [libraryEntries]);

  const initAudioUrl = useMemo(() => p.initAudioFile ? URL.createObjectURL(p.initAudioFile) : null, [p.initAudioFile]);
  const inpaintAudioUrl = useMemo(() => p.inpaintAudioFile ? URL.createObjectURL(p.inpaintAudioFile) : null, [p.inpaintAudioFile]);
  useEffect(() => () => { if (initAudioUrl) URL.revokeObjectURL(initAudioUrl); }, [initAudioUrl]);
  useEffect(() => () => { if (inpaintAudioUrl) URL.revokeObjectURL(inpaintAudioUrl); }, [inpaintAudioUrl]);

  const handleGenerate = () => {
    if (isGenerating) return;
    void submitGeneration({
      prompt: p.prompt, negativePrompt: p.negativePrompt, model: p.model,
      duration: p.duration, steps: p.steps, cfg: p.cfg, seed: p.seed, batch: p.batch,
      initNoise: p.initNoise, initType: p.initType, initAudioFile: p.initAudioFile,
      inpaintAudioFile: p.inpaintAudioFile, inpaintEnabled: p.inpaintEnabled,
      maskStart: p.maskStart, maskEnd: p.maskEnd,
    });
  };

  const handleSendToDaw = async () => {
    if (!lastAudioUrl) return;
    const blob = await (await fetch(lastAudioUrl)).blob();
    const trackId = addTrack({ name: p.prompt.slice(0, 30) || 'Generated' });
    const audio = new Audio(lastAudioUrl);
    await new Promise<void>((r) => { audio.onloadedmetadata = () => r(); audio.onerror = () => r(); });
    addClip({ trackId, label: p.prompt.slice(0, 40) || 'Generated Audio', audioBlob: blob,
      mimeType: blob.type || 'audio/wav', sourceDuration: audio.duration || p.duration,
      offsetIntoSource: 0, durationSec: audio.duration || p.duration, startSec: 0,
      color: '#8b5cf6', sourceKind: 'audio' });
  };

  const handleSendToEditor = async () => {
    if (!lastAudioUrl) return;
    const blob = await (await fetch(lastAudioUrl)).blob();
    setEditorSource(new File([blob], lastFilename || 'output.wav', { type: blob.type }));
  };

  const handleSendToInit = async () => {
    if (!lastAudioUrl) return;
    const blob = await (await fetch(lastAudioUrl)).blob();
    const file = new File([blob], lastFilename || 'output.wav', { type: blob.type || 'audio/wav' });
    patch({ initAudioFile: file, initAudioEnabled: true });
  };

  const handleSendToInpaint = async () => {
    if (!lastAudioUrl) return;
    const blob = await (await fetch(lastAudioUrl)).blob();
    const file = new File([blob], lastFilename || 'output.wav', { type: blob.type || 'audio/wav' });
    patch({ inpaintAudioFile: file, inpaintEnabled: true, maskStart: 0, maskEnd: 0 });
  };

  type QuickTarget = 'daw' | 'init' | 'inpaint' | 'effects';
  const handleQuickAction = (target: QuickTarget) => {
    if (target === 'daw') { void handleSendToDaw(); return; }
    if (target === 'init') { void handleSendToInit(); return; }
    if (target === 'inpaint') { void handleSendToInpaint(); return; }
    if (target === 'effects' && onAddTo) { onAddTo('editor'); return; }
  };

  /* ────────────────────────────────────────────────────────────────── */

  return (
    <div className="h-full overflow-hidden text-[11px]">
    <div className="h-full grid grid-cols-[1fr_280px] gap-2 p-2">

      {/* ═══ LEFT MAIN COLUMN ═══ */}
      <div className="overflow-y-auto flex flex-col gap-2 pr-1">

      {/* ═══ ROW 1: PROMPTING | TEMPLATES+LORA | CONTROLS+GENERATE | OUTPUT SETTINGS ═══ */}
      <div className="grid grid-cols-[1.4fr_220px_280px_240px] gap-2">

        {/* PROMPTING (Prompt + Negative SIDE BY SIDE) */}
        <div className="hardware-card flex flex-col">
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 mb-2">PROMPTING</span>
          <div className="grid grid-cols-2 gap-3 flex-1">
            {/* Prompt */}
            <div className="flex flex-col">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-zinc-300 flex items-center gap-1.5">Prompt <InfoTip {...RICH_TOOLTIPS.prompt} /></span>
                <div className="flex items-center gap-1.5">
                  <SavedPromptsDropdown type="positive" value={p.prompt} onChange={(v) => sf('prompt', v)} />
                  <button
                    onClick={async () => {
                      if (enhancingPositive || !p.prompt.trim()) return;
                      setEnhancingPositive(true);
                      try {
                        const result = await enhanceStableAudioPrompt({ target: 'positive', positivePrompt: p.prompt, negativePrompt: p.negativePrompt });
                        if (result) sf('prompt', result);
                      } catch { /* non-fatal */ }
                      finally { setEnhancingPositive(false); }
                    }}
                    disabled={enhancingPositive || !p.prompt.trim()}
                    className="p-1 rounded hover:bg-purple-500/20 text-zinc-500 hover:text-purple-300 transition-colors disabled:opacity-30"
                    title="AI-enhance prompt"
                  >
                    {enhancingPositive ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
              <div className="relative flex-1">
                <textarea
                  className="compact-input w-full resize-none h-full min-h-[80px]"
                  placeholder="120 BPM house loop, deep sub bass, crispy hi-hats, minimal percussion..."
                  value={p.prompt}
                  onChange={(e) => sf('prompt', e.target.value)}
                  maxLength={1000} />
                <span className="absolute bottom-1 right-2 text-[9px] text-zinc-500">{p.prompt.length}/1000</span>
              </div>
            </div>
            {/* Negative Prompt */}
            <div className="flex flex-col">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-zinc-300 flex items-center gap-1.5">Negative Prompt <InfoTip {...RICH_TOOLTIPS.negativePrompt} /></span>
                <div className="flex items-center gap-1.5">
                  <SavedPromptsDropdown type="negative" value={p.negativePrompt} onChange={(v) => sf('negativePrompt', v)} />
                  <button
                    onClick={async () => {
                      if (enhancingNegative || !p.negativePrompt.trim()) return;
                      setEnhancingNegative(true);
                      try {
                        const result = await enhanceStableAudioPrompt({ target: 'negative', positivePrompt: p.prompt, negativePrompt: p.negativePrompt });
                        if (result) sf('negativePrompt', result);
                      } catch { /* non-fatal */ }
                      finally { setEnhancingNegative(false); }
                    }}
                    disabled={enhancingNegative || !p.negativePrompt.trim()}
                    className="p-1 rounded hover:bg-purple-500/20 text-zinc-500 hover:text-purple-300 transition-colors disabled:opacity-30"
                    title="AI-enhance negative prompt"
                  >
                    {enhancingNegative ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
              <div className="relative flex-1">
                <textarea
                  className="compact-input w-full resize-none h-full min-h-[80px]"
                  placeholder="vocals, speech, distortion, harshness..."
                  value={p.negativePrompt}
                  onChange={(e) => sf('negativePrompt', e.target.value)}
                  maxLength={500} />
                <span className="absolute bottom-1 right-2 text-[9px] text-zinc-500">{p.negativePrompt.length}/500</span>
              </div>
            </div>
          </div>
        </div>

        {/* TEMPLATES + LORA stacked */}
        <div className="flex flex-col gap-2 min-h-0">
          <TemplatesPanel />
          <div className="hardware-card flex flex-col">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 flex items-center gap-1.5">LORA <InfoTip {...RICH_TOOLTIPS.lora} /></span>
              <button className="btn-ghost cursor-pointer p-1"
                onClick={() => sf('loras', [...p.loras, { name: '', weight: 1.0, file: null }])}>
                <Plus className="w-3 h-3" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 max-h-[80px]">
              {p.loras.length > 0 ? p.loras.map((lora, i) => (
                <div key={i} className="flex items-center gap-1 bg-purple-500/5 rounded px-1.5 py-1 border border-purple-500/10 mb-1">
                  {lora.file ? (
                    <span className="text-[9px] text-purple-200 flex-1 truncate">{lora.file.name}</span>
                  ) : (
                    <button className="btn-ghost cursor-pointer text-[9px]" onClick={() => {
                      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.safetensors,.pt,.bin';
                      inp.onchange = () => { if (inp.files?.[0]) { const u = p.loras.map((l, idx) => idx === i ? { ...l, file: inp.files![0], name: inp.files![0].name } : l); sf('loras', u); } };
                      inp.click();
                    }}>File</button>
                  )}
                  <input type="number" className="compact-input w-10 text-center text-[9px]" value={lora.weight} step={0.05} min={0} max={2}
                    onChange={(e) => { const u = p.loras.map((l, idx) => idx === i ? { ...l, weight: +e.target.value } : l); sf('loras', u); }} />
                  <button className="text-zinc-500 hover:text-red-400 cursor-pointer" onClick={() => sf('loras', p.loras.filter((_, idx) => idx !== i))}><X className="w-3 h-3" /></button>
                </div>
              )) : <span className="text-[9px] text-zinc-600 font-mono">No LoRAs added</span>}
            </div>
          </div>
        </div>

        {/* CONTROLS + GENERATE button */}
        <div className="hardware-card flex flex-col">
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 mb-2">CONTROLS</span>
          <div className="flex flex-col gap-1.5 mb-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-zinc-300 w-16 shrink-0">Model</span>
              <select className="compact-input flex-1" value={p.model} onChange={(e) => {
                const m = e.target.value;
                const isRf = m.endsWith('-rf');
                patch({ model: m, steps: isRf ? 50 : 8, cfg: isRf ? 7.0 : 1.0 });
              }}>
                <option value="small">Small (ARC)</option>
                <option value="medium">Medium (ARC)</option>
                <option value="small-rf">Small-RF</option>
                <option value="medium-rf">Medium-RF</option>
              </select>
            </div>
            <CtrlRow label="Duration" value={p.duration} onChange={(v) => sf('duration', v)} min={0.5} max={512} step={0.5} suffix="s" tipKey="duration" />
            <CtrlRow label="Steps" value={p.steps} onChange={(v) => sf('steps', v)} min={1} max={500} step={1} tipKey="steps" />
            <CtrlRow label="CFG" value={p.cfg} onChange={(v) => sf('cfg', v)} min={0} max={25} step={0.1} tipKey="cfg" />
            <CtrlRow label="Seed" value={p.seed} onChange={(v) => sf('seed', v)} min={-1} max={2147483647} step={1} tipKey="seed"
              onRandomize={() => sf('seed', Math.floor(Math.random() * 2147483647))} />
          </div>
          <button className="btn-primary flex items-center justify-center gap-2 cursor-pointer py-2.5 mt-auto"
            disabled={isGenerating || !p.prompt.trim()} onClick={handleGenerate}>
            <Sliders className="w-3.5 h-3.5" />{isGenerating ? 'Generating...' : 'GENERATE'}
          </button>
        </div>

        {/* OUTPUT SETTINGS */}
        <div className="hardware-card flex flex-col">
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 mb-2">OUTPUT SETTINGS</span>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className="text-[10px] text-zinc-300 flex items-center gap-1.5">Format <InfoTip {...RICH_TOOLTIPS.outputFormat} /></label>
              <select className="compact-input w-full mt-0.5" value={p.fileFormat} onChange={(e) => sf('fileFormat', e.target.value)}>
                <option value="wav">WAV</option><option value="flac">FLAC</option><option value="ogg">OGG</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-zinc-300 flex items-center gap-1.5">Naming <InfoTip {...RICH_TOOLTIPS.fileNaming} /></label>
              <select className="compact-input w-full mt-0.5" value={p.fileNaming} onChange={(e) => sf('fileNaming', e.target.value)}>
                <option value="verbose">Verbose</option><option value="prompt">Prompt</option><option value="seed">Seed</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-300 cursor-pointer mb-0.5"><input type="checkbox" checked={p.cutToDuration} onChange={(e) => sf('cutToDuration', e.target.checked)} className="accent-purple-500" /> Cut to duration</label>
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-300 cursor-pointer mb-0.5"><input type="checkbox" checked={p.autoplay} onChange={(e) => sf('autoplay', e.target.checked)} className="accent-purple-500" /> Autoplay</label>
          <label className="flex items-center gap-1.5 text-[10px] text-zinc-300 cursor-pointer"><input type="checkbox" checked={p.autoDownload} onChange={(e) => sf('autoDownload', e.target.checked)} className="accent-purple-500" /> Auto download</label>
        </div>
      </div>

      {/* ═══ ROW 2: INIT AUDIO | INPAINTING (large waveforms) ═══ */}
      <div className="grid grid-cols-2 gap-2">

        {/* INIT AUDIO */}
        <div className="hardware-card flex flex-col"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={(e) => { e.preventDefault(); const f = fileFromDrop(e); if (f) patch({ initAudioFile: f, initAudioEnabled: true }); }}>
          <div className="flex items-center gap-1.5 mb-2">
            <Mic2 className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 flex items-center gap-1.5">INIT AUDIO <InfoTip {...RICH_TOOLTIPS.initAudio} /></span>
            <span className="text-[10px] text-purple-200 truncate ml-2 flex-1">{p.initAudioFile ? p.initAudioFile.name : 'Drop audio or click Load'}</span>
            <button onClick={() => sf('initAudioEnabled', !p.initAudioEnabled)}
              className={`mono-tag cursor-pointer ${p.initAudioEnabled ? 'bg-purple-600/30 text-purple-200 border-purple-500/50' : ''}`}>
              {p.initAudioEnabled ? 'ON' : 'OFF'}
            </button>
            {p.initAudioFile ? (
              <button className="btn-ghost cursor-pointer" onClick={() => patch({ initAudioFile: null, initAudioEnabled: false })}><X className="w-3 h-3" /></button>
            ) : (
              <button className="btn-ghost cursor-pointer text-[9px]" onClick={() => initRef.current?.click()}>LOAD</button>
            )}
            <input ref={initRef} type="file" accept="audio/*" className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) patch({ initAudioFile: e.target.files[0], initAudioEnabled: true }); e.target.value = ''; }} />
          </div>
          {initAudioUrl ? (
            <div className="rounded overflow-hidden border border-white/5 bg-black/40 h-[110px] mb-2">
              <WaveformPreview audioUrl={initAudioUrl} height={110} />
            </div>
          ) : (
            <div className="rounded border border-dashed border-white/10 bg-zinc-900/50 h-[110px] mb-2 flex items-center justify-center">
              <span className="text-[9px] text-zinc-600">No audio loaded</span>
            </div>
          )}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-zinc-400">Type</span>
              <select className="compact-input w-24" value={p.initType} onChange={(e) => sf('initType', e.target.value)}>
                <option value="Audio">Audio</option><option value="RF-Inversion">RF-Inversion</option>
              </select>
            </div>
            <div className="flex-1">
              <SField label="Init noise" hint="[0-1]" value={p.initNoise} onChange={(v) => sf('initNoise', v)} min={0} max={1} defaultValue={0.7} tipKey="initNoise" />
            </div>
          </div>
          {p.initType === 'RF-Inversion' && (
            <div className="flex flex-wrap gap-2 mt-1.5 pt-1.5 border-t border-white/5">
              <div className="flex items-center gap-1"><span className="text-[10px] text-zinc-300">Steps</span><input type="number" className="compact-input w-12 text-center" value={p.inversionSteps} onChange={(e) => sf('inversionSteps', +e.target.value)} min={1} max={100} /></div>
              <div className="flex items-center gap-1"><span className="text-[10px] text-zinc-300">Gamma</span><input type="number" className="compact-input w-12 text-center" value={p.inversionGamma} onChange={(e) => sf('inversionGamma', +e.target.value)} min={0} max={1} step={0.05} /></div>
              <label className="flex items-center gap-1 text-[10px] text-zinc-300 cursor-pointer"><input type="checkbox" checked={p.inversionUnconditional} onChange={(e) => sf('inversionUnconditional', e.target.checked)} className="accent-purple-500" /> Uncond</label>
            </div>
          )}
        </div>

        {/* INPAINTING */}
        <div className="hardware-card flex flex-col"
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
          onDrop={(e) => { e.preventDefault(); const f = fileFromDrop(e); if (f) patch({ inpaintAudioFile: f, inpaintEnabled: true, maskStart: 0, maskEnd: 0 }); }}>
          <div className="flex items-center gap-1.5 mb-2">
            <Scissors className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 flex items-center gap-1.5">INPAINTING <InfoTip {...RICH_TOOLTIPS.inpainting} /></span>
            <span className="text-[10px] text-purple-200 truncate ml-2 flex-1">{p.inpaintAudioFile ? p.inpaintAudioFile.name : 'Drop audio or click Load'}</span>
            <button onClick={() => sf('inpaintEnabled', !p.inpaintEnabled)}
              className={`mono-tag cursor-pointer ${p.inpaintEnabled ? 'bg-purple-600/30 text-purple-200 border-purple-500/50' : ''}`}>
              {p.inpaintEnabled ? 'ON' : 'OFF'}
            </button>
            {p.inpaintAudioFile ? (
              <button className="btn-ghost cursor-pointer" onClick={() => patch({ inpaintAudioFile: null, inpaintEnabled: false, maskStart: 0, maskEnd: 0 })}><X className="w-3 h-3" /></button>
            ) : (
              <button className="btn-ghost cursor-pointer text-[9px]" onClick={() => inpaintRef.current?.click()}>LOAD</button>
            )}
            <input ref={inpaintRef} type="file" accept="audio/*" className="hidden"
              onChange={(e) => { if (e.target.files?.[0]) patch({ inpaintAudioFile: e.target.files[0], inpaintEnabled: true, maskStart: 0, maskEnd: 0 }); e.target.value = ''; }} />
          </div>
          {inpaintAudioUrl ? (
            <>
              <div className="rounded overflow-hidden border border-white/5 bg-black/40 h-[110px] mb-2">
                <WaveformPreview audioUrl={inpaintAudioUrl} height={110} enableRegions regionStart={p.maskStart} regionEnd={p.maskEnd}
                  onRegionChange={(s, e) => patch({ maskStart: s, maskEnd: e })} />
              </div>
              <div className="text-[10px] font-mono text-purple-300">Start: {p.maskStart.toFixed(2)}s  End: {p.maskEnd.toFixed(2)}s</div>
            </>
          ) : (
            <div className="rounded border border-dashed border-white/10 bg-zinc-900/50 h-[110px] flex items-center justify-center">
              <span className="text-[9px] text-zinc-600">No file loaded</span>
            </div>
          )}
        </div>
      </div>

      {/* ═══ ROW 3: SAMPLING & GENERATION PARAMETERS (single big card, 4 horizontal sections) ═══ */}
      <div className="hardware-card flex flex-col">
        <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 mb-2">SAMPLING &amp; GENERATION PARAMETERS</span>
        <div className="grid grid-cols-[1fr_1fr_1fr_2.4fr] gap-4">

          {/* SAMPLER */}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300/80">SAMPLER</span>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-zinc-300 w-10 shrink-0">Core</label>
              <select className="compact-input flex-1" value={p.samplerType} onChange={(e) => sf('samplerType', e.target.value)}>
                <option value="pingpong">pingpong</option><option value="euler">euler</option>
                <option value="rk4">rk4</option><option value="dpmpp">dpmpp</option>
              </select>
            </div>
            <SField label="Sigma max" hint="[0-1]" value={p.sigmaMax} onChange={(v) => sf('sigmaMax', v)} min={0} max={1} defaultValue={1.0} tipKey="sigmaMax" />
            <SField label="Dur pad" hint="[0-30s]" value={p.durationPaddingSec} onChange={(v) => sf('durationPaddingSec', v)} min={0} max={30} step={0.1} defaultValue={6.0} tipKey="durationPadding" />
          </div>

          {/* GUIDANCE */}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300/80">GUIDANCE</span>
            <SField label="APG" hint="[0-1]" value={p.apgScale} onChange={(v) => sf('apgScale', v)} min={0} max={1} defaultValue={1.0} tipKey="apg" />
            <SField label="Rescale" hint="[0-1]" value={p.cfgRescale} onChange={(v) => sf('cfgRescale', v)} min={0} max={1} defaultValue={0.0} tipKey="cfgRescale" />
          </div>

          {/* CONDITIONAL CFG */}
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300/80">CONDITIONAL CFG</span>
            <SField label="CFG min" hint="[0-1]" value={p.cfgIntervalMin} onChange={(v) => sf('cfgIntervalMin', v)} min={0} max={1} defaultValue={0.0} tipKey="cfgIntervalMin" />
            <SField label="CFG max" hint="[0-1]" value={p.cfgIntervalMax} onChange={(v) => sf('cfgIntervalMax', v)} min={0} max={1} defaultValue={1.0} tipKey="cfgIntervalMax" />
            <SField label="Norm thr." hint="[0-100]" value={p.cfgNormThreshold} onChange={(v) => sf('cfgNormThreshold', v)} min={0} max={100} step={0.1} defaultValue={0.0} tipKey="cfgNormThreshold" />
          </div>

          {/* SAMPLING SCHEDULE SHIFT */}
          <div className="flex flex-col gap-2 min-w-0">
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300/80">SAMPLING SCHEDULE SHIFT</span>
            <div className="grid grid-cols-[1fr_1fr_1fr_70px] gap-2">
              {/* LogSNR */}
              <div onClick={(e) => { if (!(e.target as HTMLElement).closest('input, button')) sf('shiftMode', 'LogSNR'); }}
                className={`cursor-pointer rounded-lg p-2 border transition-all ${p.shiftMode === 'LogSNR' ? 'bg-purple-600/10 border-purple-500/30' : 'bg-black/20 border-transparent hover:border-white/10'}`}>
                <div className={`text-[10px] font-bold mb-1.5 ${p.shiftMode === 'LogSNR' ? 'text-purple-300' : 'text-zinc-400'}`}>LogSNR</div>
                <div className="flex flex-col gap-1">
                  <Spin label="Anchor length" value={p.logsnrAnchorLength} onChange={(v) => sf('logsnrAnchorLength', v)} min={100} max={10000} step={100} tipKey="logsnrAnchorLength" />
                  <Spin label="Anchor logSNR" value={p.logsnrAnchorLogsnr} onChange={(v) => sf('logsnrAnchorLogsnr', v)} min={-12} max={0} step={0.1} tipKey="logsnrAnchorLogsnr" />
                  <Spin label="Rate" value={p.logsnrRate} onChange={(v) => sf('logsnrRate', v)} min={-2} max={2} step={0.05} tipKey="logsnrRate" />
                  <Spin label="logSNR end" value={p.logsnrEnd} onChange={(v) => sf('logsnrEnd', v)} min={-2} max={6} step={0.1} tipKey="logsnrEnd" />
                </div>
              </div>
              {/* Flux */}
              <div onClick={(e) => { if (!(e.target as HTMLElement).closest('input, button')) sf('shiftMode', 'Flux'); }}
                className={`cursor-pointer rounded-lg p-2 border transition-all ${p.shiftMode === 'Flux' ? 'bg-purple-600/10 border-purple-500/30' : 'bg-black/20 border-transparent hover:border-white/10'}`}>
                <div className={`text-[10px] font-bold mb-1.5 ${p.shiftMode === 'Flux' ? 'text-purple-300' : 'text-zinc-400'}`}>Flux</div>
                <div className="flex flex-col gap-1">
                  <Spin label="Min seq len" value={p.fluxMinLen} onChange={(v) => sf('fluxMinLen', v)} min={1} max={10000} tipKey="fluxMinLen" />
                  <Spin label="Max seq len" value={p.fluxMaxLen} onChange={(v) => sf('fluxMaxLen', v)} min={1} max={10000} tipKey="fluxMaxLen" />
                  <Spin label="Alpha min" value={p.fluxAlphaMin} onChange={(v) => sf('fluxAlphaMin', v)} min={0.1} max={20} step={0.1} tipKey="fluxAlphaMin" />
                  <Spin label="Alpha max" value={p.fluxAlphaMax} onChange={(v) => sf('fluxAlphaMax', v)} min={0.1} max={20} step={0.1} tipKey="fluxAlphaMax" />
                </div>
              </div>
              {/* Full */}
              <div onClick={(e) => { if (!(e.target as HTMLElement).closest('input, button')) sf('shiftMode', 'Full'); }}
                className={`cursor-pointer rounded-lg p-2 border transition-all ${p.shiftMode === 'Full' ? 'bg-purple-600/10 border-purple-500/30' : 'bg-black/20 border-transparent hover:border-white/10'}`}>
                <div className={`text-[10px] font-bold mb-1.5 ${p.shiftMode === 'Full' ? 'text-purple-300' : 'text-zinc-400'}`}>Full</div>
                <div className="flex flex-col gap-1">
                  <Spin label="Base shift" value={p.fullBaseShift} onChange={(v) => sf('fullBaseShift', v)} min={0} max={5} step={0.1} tipKey="fullBaseShift" />
                  <Spin label="Max shift" value={p.fullMaxShift} onChange={(v) => sf('fullMaxShift', v)} min={0} max={5} step={0.1} tipKey="fullMaxShift" />
                  <Spin label="Min length" value={p.fullMinLen} onChange={(v) => sf('fullMinLen', v)} min={1} max={10000} tipKey="fullMinLen" />
                  <Spin label="Max length" value={p.fullMaxLen} onChange={(v) => sf('fullMaxLen', v)} min={1} max={10000} tipKey="fullMaxLen" />
                </div>
              </div>
              {/* None */}
              <div onClick={() => sf('shiftMode', 'None')}
                className={`cursor-pointer rounded-lg p-2 border transition-all flex flex-col items-center justify-center ${p.shiftMode === 'None' ? 'bg-purple-600/10 border-purple-500/30' : 'bg-black/20 border-transparent hover:border-white/10'}`}>
                <div className={`text-[10px] font-bold mb-1.5 ${p.shiftMode === 'None' ? 'text-purple-300' : 'text-zinc-400'}`}>None</div>
                <Sliders className="w-4 h-4 text-zinc-600" />
              </div>
            </div>
          </div>

        </div>
      </div>

      </div>{/* end LEFT MAIN COLUMN */}

      {/* ═══ RIGHT SIDEBAR: OUTPUT | SPECTROGRAM | QUICK ACTIONS ═══ */}
      <div className="overflow-y-auto flex flex-col gap-2">

        {/* PRESETS DROPDOWN */}
        <div className="relative">
          <button
            onClick={() => setPresetsOpen(!presetsOpen)}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-white/10 bg-white/5 hover:bg-purple-500/15 hover:border-purple-500/30 text-zinc-300 hover:text-white transition-colors"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span className="text-[10px] font-black uppercase tracking-widest">Presets</span>
            <ChevronDown className={`w-3 h-3 transition-transform ${presetsOpen ? 'rotate-180' : ''}`} />
          </button>
          {presetsOpen && (
            <div className="absolute left-0 top-full mt-1 z-50 w-full max-h-80 overflow-y-auto rounded border border-white/10 bg-[#0c0a12] shadow-2xl">
              {GENERATION_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => applyPreset(preset)}
                  className="w-full text-left px-3 py-2 hover:bg-purple-500/15 border-b border-white/5 last:border-0 transition-colors group"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: preset.color }} />
                    <span className="text-[11px] font-bold text-zinc-200 group-hover:text-white">{preset.name}</span>
                  </div>
                  <p className="text-[9px] text-zinc-500 mt-0.5 leading-tight pl-4">{preset.description}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* OUTPUT */}
        <div className="hardware-card flex flex-col">
          <div className="flex items-center gap-1.5 mb-2">
            <Play className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">OUTPUT (GENERATED AUDIO)</span>
            <span className={`mono-tag ml-auto ${lastAudioUrl ? 'bg-purple-600/30 text-purple-200 border-purple-500/50' : ''}`}>
              {lastAudioUrl ? 'ON' : 'OFF'}
            </span>
          </div>
          {lastAudioUrl ? (
            <>
              <div className="mb-2"><FullAudioPlayer src={lastAudioUrl} /></div>
              <div className="rounded overflow-hidden border border-white/5 bg-black/40 h-[110px]">
                <WaveformPreview audioUrl={lastAudioUrl} height={110} />
              </div>
            </>
          ) : (
            <div className="rounded border border-dashed border-white/10 bg-zinc-900/50 h-[140px] flex flex-col items-center justify-center gap-1">
              <Music className="w-5 h-5 text-zinc-700" />
              <span className="text-[10px] text-zinc-600">Generate audio to view</span>
            </div>
          )}
        </div>

        {/* SPECTROGRAM */}
        <div className="hardware-card flex flex-col">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">SPECTROGRAM</span>
            <div className="flex gap-0.5 ml-2">
              {(['mel','stft','chromagram','cqt'] as const).map(tab => (
                <button key={tab} onClick={() => setSpecTab(tab)}
                  className={`px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider transition-all
                    ${specTab === tab ? 'bg-purple-600/30 text-purple-300 border border-purple-500/40' : 'text-zinc-600 hover:text-zinc-400 border border-transparent'}`}>
                  {tab === 'mel' ? 'Mel' : tab === 'stft' ? 'STFT' : tab === 'chromagram' ? 'Chroma' : 'CQT'}
                </button>
              ))}
            </div>
            {specLoading && <span className="text-[8px] text-zinc-600 ml-auto animate-pulse font-mono">computing...</span>}
          </div>
          <div className="flex gap-1.5 h-[140px]">
            <div className="flex-1 rounded overflow-hidden bg-black/60 border border-white/5 flex items-center justify-center">
              {spectrograms && spectrograms[specTab] ? (
                <img src={`data:image/png;base64,${spectrograms[specTab]}`} alt={`${specTab} spectrogram`} className="w-full h-full object-cover" />
              ) : (
                <span className="text-[10px] text-zinc-600 font-mono opacity-40">
                  {specLoading ? 'generating...' : spectrograms && !spectrograms[specTab] ? 'unavailable' : lastAudioUrl ? 'failed to load' : 'generate audio to view'}
                </span>
              )}
            </div>
            <div className="flex items-stretch gap-1 shrink-0">
              <div className="w-3 rounded-sm" style={{ background: 'linear-gradient(to bottom, #f9f871, #35b779, #31688e, #443983, #440154)' }} />
              <div className="flex flex-col justify-between py-1">
                {[120,100,80,60,50].map(v => <span key={v} className="text-[7px] text-zinc-500 font-mono leading-none">{v}</span>)}
              </div>
            </div>
          </div>
        </div>

        {/* QUICK ACTIONS */}
        <div className="hardware-card flex flex-col">
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 mb-2">QUICK ACTIONS</span>
          <div className="flex flex-col gap-1.5">
            {([
              { label: 'DAW', icon: LayoutList, target: 'daw' as QuickTarget, desc: 'Send to timeline as new track' },
              { label: 'Init', icon: Mic2, target: 'init' as QuickTarget, desc: 'Load into Init Audio module' },
              { label: 'Inpaint', icon: Scissors, target: 'inpaint' as QuickTarget, desc: 'Load into Inpainting module' },
              { label: 'Effects', icon: Sliders, target: 'effects' as QuickTarget, desc: 'Send to Effects tab' },
            ] as const).map(({ label, icon: Icon, target, desc }) => (
              <button key={label}
                disabled={!lastAudioUrl}
                onClick={() => handleQuickAction(target)}
                title={desc}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded border transition-all
                  ${lastAudioUrl
                    ? 'border-purple-900/40 bg-purple-950/20 hover:bg-purple-900/30 hover:border-purple-700/50 cursor-pointer'
                    : 'border-white/5 bg-white/3 opacity-30 cursor-not-allowed'}`}>
                <Icon className={`w-3.5 h-3.5 ${lastAudioUrl ? 'text-purple-400' : 'text-zinc-600'}`} />
                <span className={`text-[10px] font-semibold ${lastAudioUrl ? 'text-zinc-300' : 'text-zinc-600'}`}>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>{/* end RIGHT SIDEBAR */}

    </div>
    </div>
  );
};
