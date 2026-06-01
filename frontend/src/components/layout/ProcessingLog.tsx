import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Trash2, Download, X, Zap } from 'lucide-react';
import { useLogStore, type LogLevel, type LogEntry } from '../../state/logStore';
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

// ─── Action-button tab config (mirrors GlobalGenerateBar) ────────────────────

const TAB_CONFIG = {
  create:  { idle: 'CREATE',  active: 'ABORT', idleColor: 'bg-purple-600 hover:bg-purple-500 text-white',           activeColor: 'bg-red-600/30 text-red-300 hover:bg-red-600/50' },
  edit:    { idle: 'PROCESS', active: 'ABORT', idleColor: 'bg-blue-700 hover:bg-blue-600 text-white',               activeColor: 'bg-blue-600/30 text-blue-300 hover:bg-blue-600/50' },
  train:   { idle: 'TRAIN',   active: 'ABORT', idleColor: 'bg-rose-700 hover:bg-rose-600 text-white',               activeColor: 'bg-rose-600/30 text-rose-300 hover:bg-rose-600/50' },
  library: { idle: 'CREATE',  active: 'ABORT', idleColor: 'bg-purple-600/60 hover:bg-purple-500/60 text-white/70',  activeColor: 'bg-red-600/30 text-red-300 hover:bg-red-600/50' },
  advanced:{ idle: 'CREATE',  active: 'ABORT', idleColor: 'bg-purple-600/60 hover:bg-purple-500/60 text-white/70',  activeColor: 'bg-red-600/30 text-red-300 hover:bg-red-600/50' },
} as const;

type TabKey = keyof typeof TAB_CONFIG;

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

const fmtEst = (ms: number): string => {
  if (ms <= 0) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s`;
};

// ─── LogBody ─────────────────────────────────────────────────────────────────
// Just the entries + telemetry overlay + small download/clear toolbar.
// Mounted above the strip when the LOG is expanded.

export const LogBody: React.FC = () => {
  const entries = useLogStore((s) => s.entries);
  const clear   = useLogStore((s) => s.clear);
  const bodyRef = useRef<HTMLDivElement>(null);

  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  const [stats, setStats] = useState<SystemStats | null>(null);

  const isGenerating  = useGenerateStore((s) => s.isGenerating);
  const progressPct   = useGenerateStore((s) => s.progressPct);

  const genStartRef = useRef<number | null>(null);
  const [now, setNow] = useState(Date.now());

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

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div className="h-full flex flex-col min-h-0 bg-black/40">
      {/* Thin toolbar at the top of the body for download/clear. */}
      <div className="shrink-0 flex items-center justify-end gap-1 px-2 py-1 border-b border-white/5 bg-purple-500/4">
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

      <div className="relative flex-1 min-h-0">
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
    </div>
  );
};

// ─── LogActionButton ─────────────────────────────────────────────────────────
// The chunky CREATE / PROCESS / TRAIN / ABORT button. Lives in the
// footer strip on the right (taking the right 60% of the LOG section
// per user spec), independent of the LOG body's open/closed state so
// the affordance is always one click away.

export const LogActionButton: React.FC = () => {
  const activeView    = useAppUiStore((s) => s.activeView);
  const setActiveView = useAppUiStore((s) => s.setActiveView);
  const isGenerating  = useGenerateStore((s) => s.isGenerating);
  const progressPct   = useGenerateStore((s) => s.progressPct);
  const statusLabel   = useGenerateStore((s) => s.statusLabel);
  const submitGeneration = useGenerateStore((s) => s.submitGeneration);
  const cancelPolling = useGenerateStore((s) => s.cancelPolling);
  const model         = useGenerateParamsStore((s) => s.model);
  const isProcessing  = useStudioStore((s) => s.isProcessing);
  const isTraining    = useTrainingStore((s) => s.isTraining);

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

  return (
    <button
      type="button"
      onClick={handleAction}
      className={`relative w-full h-full overflow-hidden font-black uppercase tracking-widest text-[11px] flex items-center justify-center gap-2 transition-colors ${
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
  );
};

// ─── LogStripCompactInfo ────────────────────────────────────────────────────
// Live hardware telemetry shown in the strip's LOG header — CPU · GPU · TEMP ·
// VRAM · RAM, in that exact order. Replaces the old `>_` terminal glyph and the
// `[N]` entry-count badges. Each stat is a labelled chip that hides itself when
// its datum is unavailable; the row truncates gracefully in a narrow LOG column.

const TEMP_CLASS = (c: number) =>
  c > 80 ? 'text-red-400' : c > 65 ? 'text-amber-400' : 'text-zinc-300';

const Stat: React.FC<{ label: string; value: string; valueClass?: string }> = ({ label, value, valueClass }) => (
  <span className="flex items-baseline gap-0.5 shrink-0">
    <span className="text-[7px] font-mono text-zinc-600 uppercase">{label}</span>
    <span className={`text-[9px] font-mono tabular-nums ${valueClass ?? 'text-zinc-300'}`}>{value}</span>
  </span>
);

export const LogStripCompactInfo: React.FC = () => {
  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    if (!isBackendReady) return;
    const fetchStats = async () => {
      try {
        const r = await fetch('/api/system-stats');
        if (r.ok) setStats(await r.json() as SystemStats);
      } catch { /* non-fatal */ }
    };
    void fetchStats();
    const t = setInterval(() => void fetchStats(), 5000);
    return () => clearInterval(t);
  }, [isBackendReady]);

  if (!stats) return null;

  return (
    <span className="flex items-center gap-2 overflow-hidden whitespace-nowrap">
      {stats.cpu_pct != null && (
        <Stat label="CPU" value={`${stats.cpu_pct}%`} valueClass="text-emerald-400" />
      )}
      {stats.gpu_util_pct != null && (
        <Stat label="GPU" value={`${stats.gpu_util_pct}%`} valueClass="text-purple-300" />
      )}
      {stats.gpu_temp_c != null && (
        <Stat label="TEMP" value={`${stats.gpu_temp_c}°C`} valueClass={TEMP_CLASS(stats.gpu_temp_c)} />
      )}
      {stats.vram_used_gb != null && stats.vram_total_gb > 0 && (
        <Stat label="VRAM" value={`${stats.vram_used_gb}/${stats.vram_total_gb}G`} />
      )}
      {stats.ram_used_gb != null && stats.ram_total_gb != null && stats.ram_total_gb > 0 && (
        <Stat label="RAM" value={`${stats.ram_used_gb}/${stats.ram_total_gb}G`} />
      )}
    </span>
  );
};

// Re-export the store hook here so consumers (Shell, BottomMultiTabPanel)
// don't need to know about the underlying state library.
export { useBottomPanelStore };
export { useLogStore };

