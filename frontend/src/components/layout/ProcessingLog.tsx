import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Trash2, Download, CircleAlert } from 'lucide-react';
import { useLogStore, type LogLevel, type LogEntry } from '../../state/logStore';
import { useLibraryStore } from '../../state/libraryStore';
import { buildGenerateParamsFromState, useGenerateStore } from '../../state/generateStore';
import { useGenerateParamsStore } from '../../state/generateParamsStore';
import { useStudioStore } from '../../state/studioStore';
import { useTrainingStore } from '../../state/trainingStore';
import { useSetlistStore } from '../../state/setlistStore';
import { sendSetToVj, isVjSetTargetActive, type VjSetItem } from '../../state/vjSetBus';
import { useAppUiStore } from '../../state/appUiStore';
import { useStatusBarStore } from '../../state/statusBarStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GpuStat {
  index: number;
  name: string;
  vram_used_gb: number;
  vram_total_gb: number;
  util_pct: number | null;
  temp_c: number | null;
}

interface SystemStats {
  /** Primary device (cuda:0), kept for older backends. */
  gpu_util_pct: number | null;
  gpu_temp_c: number | null;
  vram_used_gb: number;
  vram_total_gb: number;
  /** Every GPU in the machine; the chips summarise across them. */
  gpus?: GpuStat[];
  gpu_count?: number;
  cpu_pct: number | null;
  ram_used_gb: number | null;
  ram_total_gb: number | null;
}

// Multi-GPU: the chips show the busiest card (max utilisation / temperature and
// that card's memory) with the count in the label, and the tooltip lists every
// GPU by index so a two-card rig never reads as one.
const gpuList = (s: SystemStats): GpuStat[] => (s.gpus && s.gpus.length ? s.gpus : []);
const gpuCount = (s: SystemStats): number => s.gpu_count ?? gpuList(s).length;
const gpuLabel = (s: SystemStats, base: string): string => (gpuCount(s) > 1 ? `${base}x${gpuCount(s)}` : base);
const gpuUtil = (s: SystemStats): number | null => {
  const g = gpuList(s);
  return g.length ? Math.max(...g.map((x) => x.util_pct ?? 0)) : s.gpu_util_pct;
};
const gpuTemp = (s: SystemStats): number | null => {
  const g = gpuList(s);
  return g.length ? Math.max(...g.map((x) => x.temp_c ?? 0)) : s.gpu_temp_c;
};
const gpuVram = (s: SystemStats): { used: number; total: number } => {
  const g = gpuList(s);
  if (!g.length) return { used: s.vram_used_gb, total: s.vram_total_gb };
  const busiest = g.reduce((a, b) => (b.vram_used_gb > a.vram_used_gb ? b : a));
  return { used: busiest.vram_used_gb, total: busiest.vram_total_gb };
};
const gpuTitle = (s: SystemStats): string | undefined => {
  const g = gpuList(s);
  if (!g.length) return undefined;
  return g.map((x) => `GPU ${x.index}: ${x.name}  ${x.util_pct ?? '-'}%  ${x.temp_c ?? '-'}C  ${x.vram_used_gb}/${x.vram_total_gb} GB`).join(String.fromCharCode(10));
};

// ─── Action-button tab config ────────────────────────────────────────────────
// Labels only — the button's skin is the shared neutral/high-contrast pair
// below (per user mandate: never a bright brand color; theme-derivative idle).

const TAB_CONFIG = {
  create:  { idle: 'CREATE',  active: 'ABORT' },
  edit:    { idle: 'PROCESS', active: 'ABORT' },
  train:   { idle: 'TRAIN',   active: 'ABORT' },
  library: { idle: 'CREATE',  active: 'ABORT' },
  advanced:{ idle: 'CREATE',  active: 'ABORT' },
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
  const a = Object.assign(document.createElement('a'), { href: url, download: `thedaw-log-${fmtTs()}.txt` });
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
  const verbose = useBottomPanelStore((s) => s.logVerbose);
  const setLogVerbose = useBottomPanelStore((s) => s.setLogVerbose);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Only auto-scroll to the newest line when the user is already parked at the
  // bottom. Once they scroll up, new entries no longer yank the view back.
  const pinnedRef = useRef(true);

  // Show only error lines when on, so failures are readable without scrolling.
  const [errorsOnly, setErrorsOnly] = useState(false);
  const errorCount = useMemo(() => entries.reduce((n, e) => n + (e.level === 'error' ? 1 : 0), 0), [entries]);

  // SIMPLE mode hides debug entries and folds consecutive identical
  // level+source+msg runs into one row. The row keeps the FIRST entry of the
  // run so its React key stays stable while the count grows in place.
  const displayRows = useMemo<Array<{ entry: LogEntry; count: number }>>(() => {
    const src = errorsOnly ? entries.filter((e) => e.level === 'error') : entries;
    if (verbose) return src.map((entry) => ({ entry, count: 1 }));
    const rows: Array<{ entry: LogEntry; count: number }> = [];
    for (const entry of src) {
      if (entry.level === 'debug') continue;
      const last = rows[rows.length - 1];
      if (last && last.entry.level === entry.level && last.entry.source === entry.source && last.entry.msg === entry.msg) {
        last.count += 1;
      } else {
        rows.push({ entry, count: 1 });
      }
    }
    return rows;
  }, [entries, verbose, errorsOnly]);

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

  // Auto-scroll to the newest line ONLY when the user is pinned to the bottom;
  // if they have scrolled up to read, their position is preserved. Keyed on the
  // raw entries (not the folded view) so collapsed repeats still autoscroll;
  // verbose/errorsOnly are included so switching modes re-pins after the list
  // height changes.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, verbose, errorsOnly]);

  // Track whether the view is parked at (or near) the bottom.
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  return (
    <div className="h-full flex flex-col min-h-0 bg-black/40">
      {/* Thin toolbar at the top of the body for mode toggle + download/clear. */}
      <div className="shrink-0 flex items-center justify-between gap-1 px-2 py-0.5 border-b border-white/5 bg-purple-500/4">
        <button
          type="button"
          onClick={() => setLogVerbose(!verbose)}
          aria-pressed={verbose}
          aria-label="Toggle verbose log"
          className={`uppercase text-[8px] font-mono font-black tracking-widest transition-colors ${
            verbose ? 'text-purple-300' : 'text-zinc-600 hover:text-purple-300'
          }`}
          title={verbose
            ? 'VERBOSE: every entry with timestamp and source. Click for SIMPLE (repeats folded, debug hidden).'
            : 'SIMPLE: repeats folded, debug hidden. Click for VERBOSE (every entry with timestamp and source).'}
        >
          {verbose ? 'VERBOSE' : 'SIMPLE'}
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setErrorsOnly((v) => !v)}
            aria-pressed={errorsOnly}
            aria-label={errorsOnly ? 'Show all log entries' : 'Show only errors'}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded uppercase text-[8px] font-mono font-black tracking-widest transition-colors ${
              errorsOnly
                ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                : errorCount > 0
                  ? 'text-red-400 hover:text-red-300 border border-transparent'
                  : 'text-zinc-600 hover:text-red-300 border border-transparent'
            }`}
            title={errorsOnly ? 'Showing errors only — click to show all entries' : 'Show only error entries'}
          >
            <CircleAlert className="w-3 h-3" />
            Errors{errorCount > 0 ? ` ${errorCount}` : ''}
          </button>
          <button
            type="button"
            onClick={() => downloadLog(entries)}
            aria-label="Download log"
            className="p-1 text-zinc-600 hover:text-purple-300 transition-colors"
            title="Download log"
          >
            <Download className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => clear()}
            aria-label="Clear log"
            className="p-1 text-zinc-600 hover:text-red-400 transition-colors"
            title="Clear log"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div
          ref={bodyRef}
          onScroll={onBodyScroll}
          className="log-scroll h-full overflow-y-auto px-2 py-1 font-mono text-[9px] space-y-0.5 pr-22"
        >
          {displayRows.length === 0
            ? <p className="text-zinc-700 italic">{errorsOnly ? 'No errors.' : 'Waiting for signal...'}</p>
            : displayRows.map(({ entry: e, count }) => verbose
                ? (
                  <p key={e.id} className={`pl-2 ${levelStyles[e.level]}`}>
                    <span className="text-zinc-600">{fmtTime(e.ts)}</span>{' '}
                    <span className="text-zinc-500 uppercase">[{e.source}]</span>{' '}
                    <span>{e.msg}</span>
                  </p>
                )
                : (
                  <p key={e.id} className={`pl-2 ${levelStyles[e.level]}`}>
                    <span>{e.msg}</span>
                    {count > 1 && <span className="text-zinc-600"> x{count}</span>}
                  </p>
                ))
          }
        </div>

        {/* Telemetry overlay — right side, like spectral Hz/RMS/peak */}
        <div className="absolute right-0 top-0 bottom-0 w-20 pointer-events-none flex flex-col justify-end pb-2"
             style={{ background: 'linear-gradient(to left, rgba(0,0,0,0.85) 60%, transparent)' }}>
          <div className="flex flex-col gap-1 pr-2 items-end">
            {stats && gpuUtil(stats) != null && (
              <div className="flex flex-col items-end leading-none" title={gpuTitle(stats)}>
                <span className="text-[7px] font-mono text-zinc-600 uppercase">{gpuLabel(stats, 'GPU')}</span>
                <span className="text-[10px] font-mono text-purple-300">{gpuUtil(stats)}%</span>
              </div>
            )}
            {stats?.cpu_pct != null && (
              <div className="flex flex-col items-end leading-none">
                <span className="text-[7px] font-mono text-zinc-600 uppercase">CPU</span>
                <span className="text-[10px] font-mono text-emerald-400">{stats.cpu_pct}%</span>
              </div>
            )}
            {stats && gpuTemp(stats) != null && (() => { const t = gpuTemp(stats) as number; return (
              <div className="flex flex-col items-end leading-none" title={gpuTitle(stats)}>
                <span className="text-[7px] font-mono text-zinc-600 uppercase">HEAT</span>
                <span className={`text-[10px] font-mono ${t > 80 ? 'text-red-400' : t > 65 ? 'text-amber-400' : 'text-zinc-300'}`}>
                  {t}°C
                </span>
              </div>
            ); })()}
            {stats && gpuVram(stats).total > 0 && (() => { const v = gpuVram(stats); return (
              <div className="flex flex-col items-end leading-none" title={gpuTitle(stats)}>
                <span className="text-[7px] font-mono text-zinc-600 uppercase">{gpuLabel(stats, 'VRAM')}</span>
                <span className="text-[10px] font-mono text-zinc-300">{v.used}/{v.total}G</span>
              </div>
            ); })()}
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

// Shared footer-button skin. Deliberately NOT a bright brand color: idle is a
// muted translucent chip whose classes the edit-theme scope remaps, so it
// derives from whatever theme is active; while running it flips to a
// high-contrast inverse (light chip, dark text) so state is unmissable.
const ACTION_BASE =
  'relative w-full h-full overflow-hidden rounded-lg border font-black uppercase tracking-widest text-[9px] leading-tight flex items-center justify-center text-center px-1 transition-colors disabled:cursor-not-allowed';
const ACTION_IDLE = 'bg-white/8 hover:bg-white/15 border-white/15 text-zinc-200';
const ACTION_HOT = 'bg-zinc-100 hover:bg-white border-white/80 text-black';

export const LogActionButton: React.FC = () => {
  const centerTab     = useAppUiStore((s) => s.centerTab);
  const isGenerating  = useGenerateStore((s) => s.isGenerating);
  const progressPct   = useGenerateStore((s) => s.progressPct);
  const statusLabel   = useGenerateStore((s) => s.statusLabel);
  const submitGeneration = useGenerateStore((s) => s.submitGeneration);
  const cancelPolling = useGenerateStore((s) => s.cancelPolling);
  const model         = useGenerateParamsStore((s) => s.model);
  const isProcessing  = useStudioStore((s) => s.isProcessing);
  const isChainProcessing = useStudioStore((s) => s.isChainProcessing);
  const isTraining    = useTrainingStore((s) => s.isTraining);

  // The WORKSPACE decides the action: EDIT processes the arrangement, UNDERFIT
  // trains, everything else CREATEs. Derived from centerTab — the real tab
  // state — never the legacy activeView, which the tab bar historically did
  // not write (so the footer fired text-to-audio on EDIT, and one assistant
  // navigate('train') left a dead TRAIN button for the whole session).
  const tab: TabKey = centerTab === 'edit' ? 'edit' : centerTab === 'underfit' ? 'train' : 'create';
  const cfg = TAB_CONFIG[tab];
  const isActive = tab === 'create' ? isGenerating : tab === 'edit' ? isProcessing : isTraining;

  // On the DJ tab the action button is SEND TO VJ (CREATE/PROCESS make no sense
  // there) — pushes the active setlist to the VJ performance.
  const sendActiveSetToVj = () => {
    const { setlists, activeId } = useSetlistStore.getState();
    const activeSet = activeId ? setlists[activeId] : null;
    if (!activeSet || activeSet.entries.length === 0) return;
    const entries = useLibraryStore.getState().entries;
    const items: VjSetItem[] = activeSet.entries.map((e) => {
      const entry = e.entryId ? entries.find((x) => x.id === e.entryId) ?? null : null;
      return { entryId: e.entryId, label: e.label, url: entry?.audioUrl ?? e.url, kind: e.kind ?? 'audio' };
    });
    sendSetToVj({ setId: activeSet.id, name: activeSet.name, items });
  };

  if (centerTab === 'dj') {
    return (
      <button
        type="button"
        onClick={sendActiveSetToVj}
        className={`${ACTION_BASE} ${ACTION_IDLE}`}
        title={isVjSetTargetActive() ? 'Send the active setlist to the VJ performance' : 'Queue the active setlist — delivers when the VJ tab opens'}
      >
        <span className="relative z-10">Send to VJ</span>
      </button>
    );
  }

  // On the MIX tab the action button runs the effect CHAIN over the source
  // (the tab itself has no Process button — the footer is the transport, per
  // DESIGN_PRINCIPLES §6). Orange echoes the MIX tab accent.
  if (centerTab === 'mix') {
    return (
      <button
        type="button"
        onClick={() => { void useStudioStore.getState().processChain(); }}
        disabled={isChainProcessing}
        className={`${ACTION_BASE} ${isChainProcessing ? ACTION_HOT : ACTION_IDLE}`}
        title={isChainProcessing ? 'Processing the effect chain…' : 'Process the effect chain over the source audio'}
      >
        <span className="relative z-10">{isChainProcessing ? 'PROCESSING…' : 'PROCESS CHAIN'}</span>
      </button>
    );
  }

  const handleAction = () => {
    if (tab === 'create') {
      if (isGenerating) { cancelPolling(); return; }
      // Build the full param set (includes Magenta style/notes/seed/extend and
      // initAudioEnabled) via the shared selector so CREATE and the assistant
      // stay in sync instead of drifting from a hand-maintained field list.
      const p = useGenerateParamsStore.getState();
      void submitGeneration(buildGenerateParamsFromState(p));
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
      className={`${ACTION_BASE} ${isActive ? ACTION_HOT : ACTION_IDLE}`}
      title={
        tab === 'create' ? (isGenerating ? 'Abort generation' : `Submit ${model.toUpperCase()} to /api/generate-jobs`) :
        tab === 'edit'   ? (isProcessing ? 'Cancel processing' : 'Process audio') :
        tab === 'train'  ? (isTraining   ? 'Abort training'   : 'Submit LoRA job') :
        'Switch to CREATE'
      }
    >
      {tab === 'create' && isGenerating && (
        <div
          className="absolute inset-y-0 left-0 bg-black/20 transition-[width] duration-200"
          style={{ width: `${Math.max(2, progressPct)}%` }}
        />
      )}
      <span className="relative z-10 flex flex-col items-center">
        {isActive
          ? (tab === 'create' ? `ABORT ${progressPct}%` : cfg.active)
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

const Stat: React.FC<{ label: string; value: string; valueClass?: string; title?: string }> = ({ label, value, valueClass, title }) => (
  <span className="flex items-baseline gap-0.5 shrink-0" title={title}>
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
      {gpuUtil(stats) != null && (
        <Stat label={gpuLabel(stats, 'GPU')} value={`${gpuUtil(stats)}%`} valueClass="text-purple-300" title={gpuTitle(stats)} />
      )}
      {gpuTemp(stats) != null && (
        <Stat label="TEMP" value={`${gpuTemp(stats)}°C`} valueClass={TEMP_CLASS(gpuTemp(stats) as number)} title={gpuTitle(stats)} />
      )}
      {gpuVram(stats).total > 0 && (
        <Stat label={gpuLabel(stats, 'VRAM')} value={`${gpuVram(stats).used}/${gpuVram(stats).total}G`} title={gpuTitle(stats)} />
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

