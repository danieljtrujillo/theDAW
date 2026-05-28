import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Terminal, ChevronDown, ChevronUp, Trash2, Download,
  Play, Pause, FileDown, X, Cpu, Thermometer, Zap, Clock,
} from 'lucide-react';
import { useLogStore, type LogLevel, type LogEntry } from '../../state/logStore';
import { usePlayerStore } from '../../state/playerStore';
import { useLibraryStore } from '../../state/libraryStore';
import { useGenerateStore } from '../../state/generateStore';
import { useGenerateParamsStore } from '../../state/generateParamsStore';
import { useStudioStore } from '../../state/studioStore';
import { useTrainingStore } from '../../state/trainingStore';
import { useAppUiStore } from '../../state/appUiStore';
import { useStatusBarStore } from '../../state/statusBarStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SystemStats {
  gpu_util_pct: number | null;
  gpu_temp_c: number | null;
  vram_used_gb: number;
  vram_total_gb: number;
  cpu_pct: number | null;
  ram_used_gb: number | null;
  ram_total_gb: number | null;
}

// ─── Tab config (mirrors GlobalGenerateBar) ──────────────────────────────────

const TAB_CONFIG = {
  create:  { idle: 'CREATE',  active: 'ABORT', idleColor: 'bg-purple-600 hover:bg-purple-500 text-white',           activeColor: 'bg-red-600/30 text-red-300 hover:bg-red-600/50' },
  edit:    { idle: 'PROCESS', active: 'ABORT', idleColor: 'bg-blue-700 hover:bg-blue-600 text-white',               activeColor: 'bg-blue-600/30 text-blue-300 hover:bg-blue-600/50' },
  train:   { idle: 'TRAIN',   active: 'ABORT', idleColor: 'bg-rose-700 hover:bg-rose-600 text-white',               activeColor: 'bg-rose-600/30 text-rose-300 hover:bg-rose-600/50' },
  library: { idle: 'CREATE',  active: 'ABORT', idleColor: 'bg-purple-600/60 hover:bg-purple-500/60 text-white/70',  activeColor: 'bg-red-600/30 text-red-300 hover:bg-red-600/50' },
  advanced:{ idle: 'CREATE',  active: 'ABORT', idleColor: 'bg-purple-600/60 hover:bg-purple-500/60 text-white/70',  activeColor: 'bg-red-600/30 text-red-300 hover:bg-red-600/50' },
} as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const levelStyles: Record<LogLevel, string> = {
  info:  'text-zinc-300 border-l-2 border-purple-500/60',
  warn:  'text-amber-300 border-l-2 border-amber-500/70',
  error: 'text-red-300   border-l-2 border-red-500/70',
  debug: 'text-zinc-500  border-l-2 border-zinc-700',
};

const fmtTime = (ts: number): string => {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => n.toString().padStart(2, '0')).join(':');
};

const fmtTs = (): string => {
  const d = new Date(), p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const entryToLine = (e: LogEntry) =>
  `${new Date(e.ts).toISOString()} [${e.level.toUpperCase().padEnd(5)}] [${e.source}] ${e.msg}`;

const downloadLog = (entries: LogEntry[]) => {
  if (!entries.length) return;
  const blob = new Blob([entries.map(entryToLine).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `stabledaw-log-${fmtTs()}.txt` });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const downloadCurrentTrack = () => {
  const player = usePlayerStore.getState();
  if (!player.hasTrack) return;
  const entry = (player.currentEntryId
    ? useLibraryStore.getState().entries.find((e) => e.id === player.currentEntryId)
    : useLibraryStore.getState().entries[0]);
  if (!entry) return;
  const url = useLibraryStore.getState().getAudioUrl(entry);
  const a = Object.assign(document.createElement('a'), { href: url, download: entry.title });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
};

const fmtEst = (ms: number): string => {
  if (ms <= 0) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
};

// ─── Component ───────────────────────────────────────────────────────────────

export const ProcessingLog: React.FC = () => {
  // Log
  const entries   = useLogStore((s) => s.entries);
  const clear     = useLogStore((s) => s.clear);
  // Open/closed state lives in the shared bottomPanelStore so the
  // ShellBottomDock can sync heights with the BottomMultiTabPanel —
  // both surfaces' "expanded" state contributes to whether the dock
  // is at full height or just the toggle row.
  const isOpen      = useBottomPanelStore((s) => s.isLogOpen);
  const setIsOpen   = useBottomPanelStore((s) => s.setLogOpen);
  const bodyRef   = useRef<HTMLDivElement>(null);

  // Player
  const hasTrack  = usePlayerStore((s) => s.hasTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggle    = usePlayerStore((s) => s.toggle);

  // Active tab
  const activeView    = useAppUiStore((s) => s.activeView);
  const setActiveView = useAppUiStore((s) => s.setActiveView);

  // CREATE
  const isGenerating  = useGenerateStore((s) => s.isGenerating);
  const progressPct   = useGenerateStore((s) => s.progressPct);
  const statusLabel   = useGenerateStore((s) => s.statusLabel);
  const submitGeneration = useGenerateStore((s) => s.submitGeneration);
  const cancelPolling = useGenerateStore((s) => s.cancelPolling);
  const model         = useGenerateParamsStore((s) => s.model);

  // EDIT / TRAIN
  const isProcessing  = useStudioStore((s) => s.isProcessing);
  const isTraining    = useTrainingStore((s) => s.isTraining);

  // Telemetry
  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const genStartRef = useRef<number | null>(null);
  const [now, setNow]   = useState(Date.now());

  // EST TIME tracking
  useEffect(() => {
    if (isGenerating && genStartRef.current === null) genStartRef.current = Date.now();
    if (!isGenerating) genStartRef.current = null;
  }, [isGenerating]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const estMs = (() => {
    if (!isGenerating || !genStartRef.current || progressPct <= 0) return -1;
    const elapsed = now - genStartRef.current;
    return (elapsed / progressPct) * (100 - progressPct);
  })();

  // Poll system stats every 5 s — only after the backend is reachable
  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch('/api/system-stats');
      if (r.ok) setStats(await r.json() as SystemStats);
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    if (!isBackendReady) return;
    void fetchStats();
    const t = setInterval(() => void fetchStats(), 5000);
    return () => clearInterval(t);
  }, [fetchStats, isBackendReady]);

  // Auto-scroll
  useEffect(() => {
    if (!isOpen) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, isOpen]);

  // Action button
  type TabKey = keyof typeof TAB_CONFIG;
  const tab = (activeView in TAB_CONFIG ? activeView : 'create') as TabKey;
  const cfg = TAB_CONFIG[tab];
  const isActive = tab === 'create' ? isGenerating : tab === 'edit' ? isProcessing : tab === 'train' ? isTraining : false;

  const handleAction = () => {
    if (tab === 'create' || tab === 'library' || tab === 'advanced') {
      if (tab !== 'create') setActiveView('create');
      if (isGenerating) { cancelPolling(); return; }
      const p = useGenerateParamsStore.getState();
      void submitGeneration({
        prompt: p.prompt, negativePrompt: p.negativePrompt, model: p.model,
        duration: p.duration, steps: p.steps, cfg: p.cfg, seed: p.seed, batch: p.batch,
        initNoise: p.initNoise, initType: p.initType, initAudioFile: p.initAudioFile,
        inpaintAudioFile: p.inpaintAudioFile, inpaintEnabled: p.inpaintEnabled,
        maskStart: p.maskStart, maskEnd: p.maskEnd,
        samplerType: p.samplerType, sigmaMax: p.sigmaMax, durationPaddingSec: p.durationPaddingSec,
        apgScale: p.apgScale, cfgRescale: p.cfgRescale, cfgNormThreshold: p.cfgNormThreshold,
        cfgIntervalMin: p.cfgIntervalMin, cfgIntervalMax: p.cfgIntervalMax,
        shiftMode: p.shiftMode, logsnrAnchorLength: p.logsnrAnchorLength,
        logsnrAnchorLogsnr: p.logsnrAnchorLogsnr, logsnrRate: p.logsnrRate, logsnrEnd: p.logsnrEnd,
        fluxMinLen: p.fluxMinLen, fluxMaxLen: p.fluxMaxLen, fluxAlphaMin: p.fluxAlphaMin,
        fluxAlphaMax: p.fluxAlphaMax, fullBaseShift: p.fullBaseShift, fullMaxShift: p.fullMaxShift,
        fullMinLen: p.fullMinLen, fullMaxLen: p.fullMaxLen,
        inversionSteps: p.inversionSteps, inversionGamma: p.inversionGamma,
        inversionUnconditional: p.inversionUnconditional,
        fileFormat: p.fileFormat, fileNaming: p.fileNaming, cutToDuration: p.cutToDuration,
        loras: p.loras,
      });
    } else if (tab === 'edit') {
      void useStudioStore.getState().triggerPendingProcess();
    } else if (tab === 'train') {
      void useTrainingStore.getState().triggerTraining();
    }
  };

  // Compact telemetry string for collapsed state
  const compactTelemetry = (() => {
    const parts: string[] = [];
    if (stats?.gpu_util_pct != null) parts.push(`${stats.gpu_util_pct}%`);
    if (stats?.gpu_temp_c != null)   parts.push(`${stats.gpu_temp_c}°`);
    if (stats?.vram_used_gb != null && stats.vram_total_gb)
      parts.push(`${stats.vram_used_gb}/${stats.vram_total_gb}G`);
    return parts.join(' ');
  })();

  return (
    // Outer fills the ShellBottomDock's right column. When isOpen the
    // body section takes the available flex space; when closed only
    // the section header + action button remain visible.
    <div className="h-full flex flex-col min-h-0">
      {/* Section-style header at top — Terminal icon, LOG label,
          entry-count chip, body controls when open, collapse arrow.
          Matches the visual rhythm of other section headers in the
          right-rail / DAW so the log doesn't look like a stranger. */}
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-purple-500/20 bg-purple-500/4 shrink-0">
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="flex items-center gap-1.5 group flex-1 min-w-0 text-left"
          title={isOpen ? 'Collapse log' : 'Expand log'}
        >
          <Terminal className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-200">LOG</span>
          <span className="text-[9px] font-mono text-zinc-600">[{entries.length}]</span>
          {!isOpen && compactTelemetry && (
            <span className="text-[8px] font-mono text-zinc-600 ml-1 truncate">{compactTelemetry}</span>
          )}
          <span className="ml-auto text-zinc-500 group-hover:text-purple-200 transition-colors">
            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </span>
        </button>
        {/* Body controls — only visible when expanded. */}
        {isOpen && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => downloadLog(entries)}
              className="p-1 text-zinc-600 hover:text-purple-300 transition-colors"
              title="Download log"
            >
              <Download className="w-3 h-3" />
            </button>
            <button
              onClick={() => clear()}
              className="p-1 text-zinc-600 hover:text-red-400 transition-colors"
              title="Clear log"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Body — flex-1 fills the LOG column's height (driven by
          bottomPanelStore.logHeight, independent of the multi-tab
          panel's height). Hidden when the log is collapsed. */}
      {isOpen && (
        <div className="relative bg-black/40 flex-1 min-h-0">
          <div
            ref={bodyRef}
            className="h-full overflow-y-auto px-2 py-1 font-mono text-[9px] space-y-0.5 pr-22"
          >
            {entries.length === 0
              ? <p className="text-zinc-700 italic">Waiting for signal...</p>
              : entries.map((e) => (
                  <p key={e.id} className={`pl-2 ${levelStyles[e.level]}`}>
                    <span className="text-zinc-600">{fmtTime(e.ts)}</span>{' '}
                    <span className="text-zinc-500 uppercase">[{e.source}]</span>{' '}
                    <span>{e.msg}</span>
                  </p>
                ))
            }
          </div>

          {/* Telemetry overlay — right side, like spectral Hz/RMS/peak */}
          <div className="absolute right-0 top-0 bottom-0 w-20 pointer-events-none flex flex-col justify-end pb-2"
               style={{ background: 'linear-gradient(to left, rgba(0,0,0,0.85) 60%, transparent)' }}>
            <div className="flex flex-col gap-1 pr-2 items-end">
              {stats?.gpu_util_pct != null && (
                <div className="flex flex-col items-end leading-none">
                  <span className="text-[7px] font-mono text-zinc-600 uppercase">GPU</span>
                  <span className="text-[10px] font-mono text-purple-300">{stats.gpu_util_pct}%</span>
                </div>
              )}
              {stats?.cpu_pct != null && (
                <div className="flex flex-col items-end leading-none">
                  <span className="text-[7px] font-mono text-zinc-600 uppercase">CPU</span>
                  <span className="text-[10px] font-mono text-emerald-400">{stats.cpu_pct}%</span>
                </div>
              )}
              {stats?.gpu_temp_c != null && (
                <div className="flex flex-col items-end leading-none">
                  <span className="text-[7px] font-mono text-zinc-600 uppercase">HEAT</span>
                  <span className={`text-[10px] font-mono ${stats.gpu_temp_c > 80 ? 'text-red-400' : stats.gpu_temp_c > 65 ? 'text-amber-400' : 'text-zinc-300'}`}>
                    {stats.gpu_temp_c}°C
                  </span>
                </div>
              )}
              {stats?.vram_used_gb != null && stats.vram_total_gb > 0 && (
                <div className="flex flex-col items-end leading-none">
                  <span className="text-[7px] font-mono text-zinc-600 uppercase">VRAM</span>
                  <span className="text-[10px] font-mono text-zinc-300">{stats.vram_used_gb}/{stats.vram_total_gb}G</span>
                </div>
              )}
              {isGenerating && estMs > 0 && (
                <div className="flex flex-col items-end leading-none">
                  <span className="text-[7px] font-mono text-zinc-600 uppercase">EST</span>
                  <span className="text-[10px] font-mono text-cyan-400">{fmtEst(estMs)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom-pinned group — track controls (if any) + action button.
          `mt-auto` pins this to the bottom of the LOG column whether
          the log body is open or collapsed, so the LOG side's
          baseline always aligns with the dock's bottom edge. */}
      <div className="mt-auto shrink-0 flex flex-col">
      {hasTrack && (
        <div className="flex items-center gap-1 px-2 py-1 border-t border-white/5 shrink-0 bg-black/20">
          <button
            type="button"
            onClick={() => toggle()}
            className={`p-1 transition-colors ${isPlaying ? 'text-purple-300 hover:text-purple-200' : 'text-zinc-500 hover:text-purple-300'}`}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 fill-current" />}
          </button>
          <button
            type="button"
            onClick={() => downloadCurrentTrack()}
            className="p-1 text-zinc-500 hover:text-purple-300 transition-colors"
            title="Download current track"
          >
            <FileDown className="w-3 h-3" />
          </button>
        </div>
      )}

      <div className="flex shrink-0">
        <button
          type="button"
          onClick={handleAction}
          className={`relative flex-1 overflow-hidden font-black uppercase tracking-widest text-[11px] flex items-center justify-center gap-2 transition-colors py-2 ${
            isActive ? cfg.activeColor : cfg.idleColor
          }`}
          title={
            tab === 'create' ? (isGenerating ? 'Abort generation' : `Submit ${model.toUpperCase()} to /api/generate-jobs`) :
            tab === 'edit'   ? (isProcessing ? 'Cancel processing' : 'Process audio') :
            tab === 'train'  ? (isTraining   ? 'Abort training'   : 'Submit LoRA job') :
            'Switch to CREATE'
          }
        >
          {tab === 'create' && isGenerating && (
            <div
              className="absolute inset-y-0 left-0 bg-red-500/25 transition-[width] duration-200"
              style={{ width: `${Math.max(2, progressPct)}%` }}
            />
          )}
          <span className="relative z-10 flex items-center gap-2">
            {isActive ? <X className="w-3.5 h-3.5" /> : <Zap className="w-3.5 h-3.5" />}
            {isActive
              ? (tab === 'create' ? `ABORT (${progressPct}%)` : cfg.active)
              : cfg.idle}
            {tab === 'create' && !isGenerating && statusLabel !== 'READY' && (
              <span className="text-[8px] font-mono opacity-60 normal-case tracking-normal">{statusLabel}</span>
            )}
          </span>
        </button>
      </div>
      </div>
    </div>
  );
};
