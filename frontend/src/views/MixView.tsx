import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  Upload, X, Eye, EyeOff, ChevronLeft, ChevronRight, Trash2,
  Download, Send, Sparkles, Plus, Gauge, History, Library, LayoutList, Grid3x3,
  Plug, RefreshCw, Loader2, Play, Pause, Square, Blocks, FolderOpen, SlidersHorizontal,
  Maximize2, Minimize2,
} from 'lucide-react';
import { useEffectChainStore, EFFECT_LABELS, EFFECT_DEFAULTS, MIX_RACK_IDS } from '../state/effectChainStore';
import { useVstStore } from '../state/vstStore';
import { vstApi, getNativeWindowHandle, getContentBounds, type Vst3PluginInfo } from '../lib/vstClient';
import { useStatusBarStore } from '../state/statusBarStore';
import { useAdvancedEditorSourceStore } from '../state/advancedEditorStore';
import { useStudioStore } from '../state/studioStore';
import { useLibraryStore } from '../state/libraryStore';
import { usePlayerStore, getAnalyser } from '../state/playerStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useAppUiStore } from '../state/appUiStore';
import { SlideKnob } from '../components/audio/SlideKnob';
import { SlideRow } from '../components/audio/SlideRow';
import { MixVizRow, type MixVizMode } from '../components/audio/MixVizRow';
import { EffectsVizPanel } from './EffectsVizPanel';
import { EffectGuiStage } from '../components/audio/EffectGuiStage';
import { TheOwl } from '../components/audio/TheOwl';
import { ModuleThumb } from '../components/audio/ModuleThumb';
import { ControlSurface } from '../components/surface/ControlSurface';
import { attachMixLiveRack } from '../state/mixLiveRack';
import { RACK_EFFECTS, getRackEffect } from '../lib/rackEffects';
import type { WidgetRegistry } from '../components/surface/widgetTypes';
import type { SurfaceLayout } from '../state/surfaceLayoutStore';
import { EFFECT_CATALOG, PARAM_BOUNDS, CATEGORY_META, fxToCategory, fxPreview, vstPreviewKey, type CategoryMeta } from '../lib/effectCatalog';
import { STUDIO_MODULES, moduleById, effectToModuleId, type StudioModule } from '../lib/moduleCatalog';
import { MAGENTA_TOOLS, magentaToolById, type MagentaTool } from '../lib/magentaToolCatalog';
import { MagentaToolStage } from '../components/audio/MagentaToolStage';
import { GanPluginStage } from '../components/audio/GanPluginStage';
import { useGanStore } from '../state/ganStore';
import { ganApi, type GanPluginSummary } from '../lib/ganClient';
import { GAN_FILTER } from '../lib/fileFilters';
import { pickFile } from '../lib/storageClient';
import { Boxes, Headphones, Music } from 'lucide-react';
import '../components/layout/track-controls.css';

/* ── Psychoacoustic effects shown as Studio-style tiles ──────────────────────
   The 11 real-time psychoacoustic rack effects, surfaced in the effects library
   as tiles (the old standalone "Psychoacoustic Rack" panel is gone). Each tile
   gets a Studio-matching canvas thumbnail keyed by effect group; selecting one
   adds it to the rack engine and opens the rack in the Effect Stage. */
interface PsychoModule { id: string; name: string; color: string; desc: string; preview: string; }
const PSYCHO_GROUP_STYLE: Record<string, { color: string; preview: string }> = {
  Spatial: { color: '#ab47bc', preview: 'psy-spatial' },
  'Low end': { color: '#f59e0b', preview: 'psy-lowend' },
  Tone: { color: '#ef5350', preview: 'psy-tone' },
  Performance: { color: '#8b5cf6', preview: 'psy-performance' },
};
// Only the rack-only ids (MIX_RACK_IDS excludes the 4 that collide with backend
// effect ids), so the Psychoacoustics browser never offers a rack variant of an
// effect that also exists as a backend tile (delay/highpass/lowpass/stereo widener).
const PSYCHO_MODULES: PsychoModule[] = RACK_EFFECTS.filter((fx) => MIX_RACK_IDS.has(fx.id) && fx.id !== 'ares').map((fx) => {
  const s = PSYCHO_GROUP_STYLE[fx.group] ?? { color: '#a855f7', preview: 'psy-spatial' };
  return { id: fx.id, name: fx.label, color: s.color, desc: fx.description, preview: s.preview };
});

/* ── Ares control surface -> the 'ares' composite effect ──────────────────────
   Each Ares .gan control id maps onto one param of the single 'ares' chain effect
   (all normalized 0..1). The XY Kaoss pad is handled separately: its X / Y / Z
   drive the three macro params below. Ids come from the bundled Ares project.json:
   the five knobs, the WET/DRY slider, Freeze, the filter-type selector, and the
   five blade on/off toggles all drive the effect. */
const ARES_CTRL_PARAM: Record<string, string> = {
  '38c6p1p': 'filterCutoff', // lad_cutoff (on-blade knob)
  '9frddyr': 'delayTime', // lad_time
  ydmrzl8: 'reverbSize', // lad_size
  qwf45ly: 'grainsDensity', // lad_density
  n9rdt84: 'gateRate', // lad_rate
  t4uakcb: 'wetDry', // ares_sword_mix_slider
  p32cjjl: 'freeze', // ares_freeze_btn
  '5lf2jcc': 'filterType', // sel_filter
  tgfilter: 'filterOn', // ares_tgl_filter (blade icon on/off)
  tgdelay: 'delayOn', // ares_tgl_delay
  tgreverb: 'reverbOn', // ares_tgl_reverb
  tggrains: 'grainsOn', // ares_tgl_grains
  tggate: 'gateOn', // ares_tgl_gate
};
// XY pad: X sweeps the filter, Y drives the overall wet amount (obvious impact),
// Z the grain density.
const ARES_PAD_AXES = ['filterCutoff', 'wetDry', 'grainsDensity'] as const;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
if (import.meta.env.DEV) {
  const uncovered = [...new Set(RACK_EFFECTS.map((fx) => fx.group))].filter((g) => !(g in PSYCHO_GROUP_STYLE));
  if (uncovered.length) console.warn('[MixView] psychoacoustic groups with no tile style (fallback used):', uncovered);
}

/* ── "All" browser cells — shared by the list and tile (icon) views ──────────── */
const AllHeader: React.FC<{ icon: React.ComponentType<{ className?: string }>; color: string; label: string; count: number }> = ({ icon: Icon, color, label, count }) => (
  <div className="flex items-center gap-1.5 px-1 pt-0.5">
    <Icon className={`w-3 h-3 shrink-0 ${color}`} />
    <span className={`text-[9px] font-black uppercase tracking-widest ${color}`}>{label}</span>
    <span className="text-[8px] font-mono text-zinc-600">{count}</span>
  </div>
);
// A Studio module / psychoacoustic effect cell (color is a hex accent).
const ModuleRow: React.FC<{ name: string; desc: string; color: string; marked: boolean; onClick: () => void }> = ({ name, desc, color, marked, onClick }) => (
  <div onClick={onClick} className={`flex items-center gap-2 border rounded px-3 py-2 cursor-pointer transition-all ${marked ? 'border-white/30 bg-white/5' : 'border-zinc-800 hover:border-white/25 hover:bg-white/5'}`}>
    <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
    <div className="flex-1 min-w-0">
      <span className="text-[11px] font-medium block truncate" style={{ color }}>{name}</span>
      <p className="text-[9px] text-zinc-500 truncate mt-0.5">{desc}</p>
    </div>
    {marked && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />}
  </div>
);
const ModuleTile: React.FC<{ name: string; color: string; marked: boolean; onClick: () => void; preview?: string; seed?: string }> = ({ name, color, marked, onClick, preview, seed }) => (
  <div onClick={onClick} title={name} style={{ width: 90, height: 98 }} className={`relative rounded border cursor-pointer transition-all overflow-hidden ${marked ? 'border-white/30 ring-1 ring-white/20' : 'border-white/8 hover:border-white/20 hover:brightness-110'}`}>
    <div className="absolute inset-0 bg-[#0a0c14]">
      {preview
        ? <ModuleThumb preview={preview} seed={seed} className="w-full h-full" />
        : <span className="absolute left-1/2 top-9 -translate-x-1/2 w-7 h-7 rounded-full" style={{ background: color, boxShadow: `0 0 10px ${color}80` }} />}
    </div>
    <div className="absolute inset-x-0 bottom-0 px-1 pt-3 pb-1 bg-linear-to-t from-black/95 to-transparent">
      <span className="text-[9px] font-medium leading-tight line-clamp-2 block" style={{ color }}>{name}</span>
    </div>
  </div>
);
// A backend effect cell (color comes from its category classes).
const FxRow: React.FC<{ name: string; desc: string; cat: CategoryMeta; inChain: boolean; onClick: () => void }> = ({ name, desc, cat, inChain, onClick }) => (
  <div onClick={onClick} className={`flex items-center gap-2 border rounded px-3 py-2 cursor-pointer transition-all ${inChain ? 'border-white/30 bg-white/5' : 'border-zinc-800 hover:border-white/25 hover:bg-white/5'}`}>
    <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${cat.dot}`} />
    <div className="flex-1 min-w-0">
      <span className={`text-[11px] font-medium block truncate ${cat.tile.text}`}>{name}</span>
      <p className="text-[9px] text-zinc-500 truncate mt-0.5">{desc}</p>
    </div>
    {inChain && <span className={`w-2 h-2 rounded-full shrink-0 ${cat.dot}`} />}
  </div>
);
const FxTile: React.FC<{ name: string; cat: CategoryMeta; inChain: boolean; onClick: () => void; preview?: string }> = ({ name, cat, inChain, onClick, preview }) => {
  const Icon = cat.icon;
  return (
    <div onClick={onClick} title={name} style={{ width: 90, height: 98 }} className={`relative rounded border cursor-pointer transition-all overflow-hidden ${inChain ? `${cat.tile.border} ring-2 ${cat.tile.ring}` : 'border-white/8 hover:border-white/20 hover:brightness-110'}`}>
      <div className="absolute inset-0 bg-[#0a0c14]">
        {preview
          ? <ModuleThumb preview={preview} className="w-full h-full" />
          : <div className="grid place-items-center h-full"><Icon className={`w-7 h-7 ${cat.tile.text}`} /></div>}
      </div>
      <div className="absolute inset-x-0 bottom-0 px-1 pt-3 pb-1 bg-linear-to-t from-black/95 to-transparent">
        <span className={`text-[9px] font-medium leading-tight line-clamp-2 block ${cat.tile.text}`}>{name}</span>
      </div>
      {inChain && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-white z-10" />}
    </div>
  );
};

// Host box for an EMBEDDED native VST3 editor. The backend sidecar pins the
// plugin's real OS window (owned by Electron, positioned over this box) and CLIPS
// it to the box, so an oversized editor keeps its natural size and is reachable by
// SCROLLING this container (the inner spacer is sized to the plugin). EXPAND grows
// the box to a large overlay for big GUIs. We only REPORT geometry + scroll here;
// the editor is closed explicitly (Close / its own window), NEVER on React unmount
// — so StrictMode / panel re-renders can't kill it.
const VstEmbedHost: React.FC<{ pluginPath: string; pluginName: string; error?: string; onClose: () => void }> = ({ pluginPath, pluginName, error, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Plugin's natural size in CSS px (from the backend, which knows the real
  // window size); drives the scrollable inner spacer.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || error) return; // a load failure has no window to track
    let alive = true;
    const report = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      void getContentBounds().then((cb) => {
        if (!alive) return;
        // Viewport origin in absolute physical screen px (content-area screen
        // origin (DIP) + element offset (CSS px ≈ DIP), scaled by dpr). Use the
        // client box (excludes the scrollbar) so the native window doesn't cover
        // the scrollbar; pass the scroll offset so it pans as we scroll.
        const ox = cb ? cb.x : 0;
        const oy = cb ? cb.y : 0;
        void vstApi.editorRect(pluginPath, {
          x: (ox + r.left) * dpr,
          y: (oy + r.top) * dpr,
          w: el.clientWidth * dpr,
          h: el.clientHeight * dpr,
          sx: el.scrollLeft * dpr,
          sy: el.scrollTop * dpr,
          dpr: 1, // values are already physical px
        });
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    el.addEventListener('scroll', report, { passive: true });
    window.addEventListener('resize', report);
    // Poll so the window follows Electron moves too (a move fires no 'resize').
    const iv = window.setInterval(report, 250);
    return () => {
      alive = false;
      ro.disconnect();
      el.removeEventListener('scroll', report);
      window.removeEventListener('resize', report);
      window.clearInterval(iv);
    };
  }, [pluginPath, error, expanded]);

  // Poll the plugin's natural size so the scroll area matches it (and tracks a
  // plugin that resizes its own window).
  useEffect(() => {
    if (error) return;
    let alive = true;
    const dpr = window.devicePixelRatio || 1;
    const poll = () => {
      vstApi.editorSize(pluginPath)
        .then((res) => {
          if (!alive) return;
          if (res.status === 'ok' && res.w && res.h) {
            setNatural({ w: Math.round(res.w / dpr), h: Math.round(res.h / dpr) });
          }
          if (alive) window.setTimeout(poll, 1000);
        })
        .catch(() => { if (alive) window.setTimeout(poll, 1500); });
    };
    poll();
    return () => { alive = false; };
  }, [pluginPath, error]);

  const shell = expanded
    ? 'fixed inset-6 z-50 bg-[#0c0a14] border border-teal-500/40 rounded-lg shadow-2xl flex flex-col min-h-0 overflow-hidden p-2 gap-2'
    : 'h-full w-full flex flex-col min-h-0 overflow-hidden p-2 gap-2';

  return (
    <div className={shell}>
      <div className="flex items-center gap-2 shrink-0">
        <span className={sectionTitle}>{pluginName}</span>
        <span className="text-[8px] font-mono text-zinc-600">{error ? 'plugin error' : 'native VST GUI'}</span>
        {!error && (
          <button onClick={() => setExpanded((v) => !v)} title={expanded ? 'Collapse' : 'Expand'} className="ml-auto inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-teal-300 transition-colors shrink-0">
            {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />} {expanded ? 'Collapse' : 'Expand'}
          </button>
        )}
        <button onClick={onClose} title="Close the plugin editor" className={`inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-red-400 transition-colors shrink-0 ${error ? 'ml-auto' : ''}`}>
          <X className="w-3.5 h-3.5" /> Close
        </button>
      </div>
      {error ? (
        <div className="flex-1 min-h-0 rounded border border-red-500/30 bg-red-950/20 grid place-items-center p-3">
          <div className="text-center max-w-md">
            <span className="text-[11px] font-semibold text-red-300 block mb-1">This plugin could not be loaded</span>
            <span className="text-[9px] font-mono text-red-200/70 wrap-break-word">{error}</span>
          </div>
        </div>
      ) : (
        <div ref={ref} className="flex-1 min-h-0 overflow-auto rounded border border-teal-500/30 bg-black/60 relative">
          {/* Spacer sized to the plugin so the area scrolls; the native window is
              positioned over the visible viewport by the backend watcher. */}
          <div style={natural ? { width: natural.w, height: natural.h } : { width: '100%', height: '100%' }} />
          {!natural && (
            <span className="absolute inset-0 grid place-items-center text-[10px] font-mono text-zinc-600 pointer-events-none">loading plugin editor…</span>
          )}
        </div>
      )}
    </div>
  );
};

/* ═══ MIX (PROCESS) tab — now on the Control-Surface editor ═══════════════════
   Layout (drag-arrangeable in Design Mode, like DJ):
     TOP    — 2 viz rows: input + output (toggle waveform / live scope, overlay A/B)
     MIDDLE — effect rail (categories + Quick Master) | library | chain
     LOWER  — effectStage (active effect's UI/viz; ModuleShell + hero viz lands here later)
   The footer is the PROCESS-CHAIN transport. */

const sectionTitle = 'text-[10px] font-black uppercase tracking-widest text-purple-300';

/* ── MIX transport — play / pause / stop for a row's audio (input source or
   processed output). Drives the global player engine; the row whose label is
   currently loaded shows the live play/pause state so either can be auditioned
   at any time. ── */
const MixTransport: React.FC<{ url: string | null; label: string }> = ({ url, label }) => {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentLabel = usePlayerStore((s) => s.currentLabel);
  const isActive = currentLabel === label;
  const playing = isActive && isPlaying;

  const toggle = async () => {
    if (!url) return;
    if (isActive) { usePlayerStore.getState().toggle(); return; }
    try {
      const blob = await fetch(url).then((r) => r.blob());
      await usePlayerStore.getState().load(blob, { label });
      usePlayerStore.getState().play();
    } catch { /* non-fatal — load/play errors surface in the player log */ }
  };
  const stop = () => { if (isActive) usePlayerStore.getState().stop(); };

  return (
    <>
      <button
        onClick={() => void toggle()}
        disabled={!url}
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        className="p-1 rounded text-zinc-400 hover:text-purple-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
      </button>
      <button
        onClick={stop}
        disabled={!url || !isActive}
        title="Stop"
        aria-label="Stop"
        className="p-1 rounded text-zinc-400 hover:text-red-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <Square className="w-3 h-3" />
      </button>
    </>
  );
};

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
          rmsDb: parseFloat((20 * Math.log10(Math.max(rms, 1e-10))).toFixed(1)),
          sampleRate: decoded.sampleRate,
          duration: decoded.duration,
        });
      })
      .catch((e) => { ctx.close(); reject(e); });
  });
}

async function fileFromDrop(e: React.DragEvent): Promise<File | null> {
  const libId = e.dataTransfer.getData('application/x-thedaw-library-id');
  if (libId) {
    const entry = useLibraryStore.getState().entries.find((en) => en.id === libId);
    if (entry) {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      return new File([blob], `${entry.title.slice(0, 40)}.wav`, { type: entry.mimeType || 'audio/wav' });
    }
  }
  return e.dataTransfer.files[0] || null;
}

function StatRow({ stats }: { stats: AudioStats }) {
  const fmtDur = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);
  const Pill = ({ label, value }: { label: string; value: string }) => (
    <span className="flex items-center gap-1">
      <span className="text-[8px] font-mono text-zinc-600 uppercase">{label}</span>
      <span className="text-[9px] font-mono text-zinc-300">{value}</span>
    </span>
  );
  return (
    <div className="flex items-center gap-2">
      <Pill label="SR" value={`${(stats.sampleRate / 1000).toFixed(1)}kHz`} />
      <span className="text-zinc-700">·</span>
      <Pill label="Peak" value={`${stats.peakDb}dBFS`} />
      <span className="text-zinc-700">·</span>
      <Pill label="RMS" value={`${stats.rmsDb}dB`} />
      <span className="text-zinc-700">·</span>
      <Pill label="Dur" value={fmtDur(stats.duration)} />
    </div>
  );
}

/* ═══ default layout ═════════════════════════════════════════════════════════ */
/* The user's hand-arranged MIX layout (Design Mode export):
     top    — Input / Output viz rows
     middle — Effects rail · [ Chain over Effect Stage ] · Library
   Version is bumped past any previously-persisted MIX layout so this default
   takes over cleanly. */
const MIX_LAYOUT_VERSION = 6;
const defaultMixLayout: SurfaceLayout = {
  version: MIX_LAYOUT_VERSION,
  root: 'root',
  nodes: {
    root: { id: 'root', type: 'container', axis: 'column', children: ['topViz', 'mid'], fr: { topViz: 1.6506024096385525, mid: 5.349397590361448 } },
    topViz: { id: 'topViz', type: 'container', axis: 'column', children: ['inputVizP', 'outputVizP'], fr: { inputVizP: 1, outputVizP: 1 } },
    inputVizP: { id: 'inputVizP', type: 'panel', title: 'Input', flow: 'row', widgets: [], pinned: 'inputViz' },
    outputVizP: { id: 'outputVizP', type: 'panel', title: 'Output', flow: 'row', widgets: [], pinned: 'outputViz' },
    mid: { id: 'mid', type: 'container', axis: 'row', children: ['railP', 'cont-3-b45ab2a0'], fr: { railP: 0.7625161264148641, 'cont-3-b45ab2a0': 3.652897886323994 }, framed: true },
    railP: { id: 'railP', type: 'panel', title: 'Effects', flow: 'row', widgets: [], pinned: 'effectRail' },
    libraryP: { id: 'libraryP', type: 'panel', title: 'Library', flow: 'row', widgets: [], pinned: 'library' },
    chainP: { id: 'chainP', type: 'panel', title: 'Chain', flow: 'row', widgets: [], pinned: 'chain' },
    stageP: { id: 'stageP', type: 'panel', title: 'Effect Stage', flow: 'row', widgets: [], pinned: 'effectStage' },
    'cont-3-b45ab2a0': { id: 'cont-3-b45ab2a0', type: 'container', axis: 'row', children: ['cont-4-4768bad0', 'libraryP'], fr: { libraryP: 0.45836297448789, 'cont-4-4768bad0': 1.5416370255121108 }, framed: true },
    'cont-4-4768bad0': { id: 'cont-4-4768bad0', type: 'container', axis: 'column', children: ['chainP', 'stageP'], fr: { chainP: 0.6536796536796542, stageP: 1.3463203463203457 }, framed: true },
  },
};

interface ChainEntry { id: string; effect: string; enabled: boolean; params: Record<string, number>; vst?: { plugin_path: string; plugin_name: string; raw_state?: string }; }

interface MixRegArgs {
  // input/output viz
  sourceUrl: string | null; outputUrl: string | null;
  srcStats: AudioStats | null; outStats: AudioStats | null;
  sourceFile: File | null;
  inputMode: MixVizMode; setInputMode: (m: MixVizMode) => void;
  outputMode: MixVizMode; setOutputMode: (m: MixVizMode) => void;
  inputOverlay: boolean; toggleInputOverlay: () => void;
  outputOverlay: boolean; toggleOutputOverlay: () => void;
  dragOverSource: boolean;
  onDrop: (e: React.DragEvent) => void; onDragOver: (e: React.DragEvent) => void; onDragLeave: () => void;
  onClickUpload: () => void; onClearSource: () => void;
  isChainProcessing: boolean;
  onDownload: () => void; onSendToDAW: () => void; onSendToInpaint: () => void;
  // rail
  activeCategory: string; setActiveCategory: (c: string) => void; allEffectCount: number;
  quickMaster: Record<string, number>; setQuickParam: (k: string, v: number) => void;
  applyQuickMaster: () => void; masterEntry: boolean;
  // library
  activeEffects: Array<{ id: string; name: string; desc: string }>; viewMode: 'list' | 'tile';
  setViewMode: (m: 'list' | 'tile') => void; addEffect: (id: string) => void; chainEffectIds: Set<string>;
  // VST3 plugins (hosted via pedalboard) — shown in the effects browser and
  // added to the chain as 'vst3' nodes.
  vstPlugins: Vst3PluginInfo[]; vstScanning: boolean; rescanVst: () => void;
  addVstToChain: (p: Vst3PluginInfo) => void; vstInChain: Set<string>;
  // .gan web-plugins (generic loader): installed list + the one open in the stage.
  ganPlugins: GanPluginSummary[]; ganActiveId: string | null; ganActiveUrl: string | null;
  ganActiveName: string | null; ganBusy: boolean;
  onOpenGan: () => void; onImportGan: () => void; onPickGan: (id: string) => void; onRevealGan: (path: string) => void;
  // studio modules (exact-GUI instruments)
  onPickModule: (id: string) => void; activeModuleId: string | null; activeModule: StudioModule | null;
  // Psychoacoustic effects are first-class members of THE chain (added via
  // onPickPsycho -> addRackEffect); no separate rack store.
  onPickPsycho: (id: string) => void;
  // Ares control surface (bundled .gan) — first-class Studio entry.
  onPickAres: () => void; aresInstalled: boolean;
  // magenta RT2 tools (Collider / Jam / MRT2 — generative instruments)
  onPickMagenta: (id: string) => void; activeMagentaId: string | null; activeMagentaTool: MagentaTool | null;
  // chain
  chain: ChainEntry[]; selectedId: string | null; setSelectedId: (id: string) => void;
  removeEffect: (id: string) => void; updateParams: (id: string, p: Record<string, number>) => void;
  toggleEnabled: (id: string) => void; reorder: (from: number, to: number) => void; clearChain: () => void;
  onEditVst: (entry: ChainEntry) => void;
  vstEmbed: { entryId: string; pluginPath: string; pluginName: string; error?: string } | null;
  onCloseVstEmbed: () => void;
  outputFormat: string; setOutputFormat: (f: string) => void;
  showHistory: boolean; setShowHistory: (v: boolean) => void;
  processHistory: Array<{ id: string; effect: string; createdAt: number }>;
  selectedEntry: ChainEntry | null;
}

function buildMixRegistry(p: MixRegArgs): WidgetRegistry {
  const reg: WidgetRegistry = {};
  const pinned = (id: string, label: string, node: React.ReactNode) => {
    reg[id] = { id, label, group: 'Panels', kind: 'fixed', source: 'builtin', render: () => <div className="h-full w-full min-h-0 overflow-hidden">{node}</div> };
  };

  /* ── INPUT viz row (with drop affordance) ── */
  pinned('inputViz', 'Input', (
    <div
      className={`h-full w-full min-h-0 transition-colors ${p.dragOverSource ? 'ring-1 ring-purple-500/60 bg-purple-500/5' : ''}`}
      onDrop={p.onDrop}
      onDragOver={p.onDragOver}
      onDragLeave={p.onDragLeave}
    >
      <MixVizRow
        label="Input" url={p.sourceUrl} overlayUrl={p.outputUrl} accent="#22d3ee" overlayAccent="#a855f7"
        mode={p.inputMode} onMode={p.setInputMode} overlay={p.inputOverlay} onToggleOverlay={p.toggleInputOverlay}
        placeholder="drop audio or click ⬆ to load"
        headerExtra={
          <>
            {p.srcStats && <StatRow stats={p.srcStats} />}
            <MixTransport url={p.sourceUrl} label="MIX Input" />
            <button onClick={p.onClickUpload} title={p.sourceFile ? 'Replace source' : 'Load source'} className="p-1 rounded text-zinc-400 hover:text-purple-200 hover:bg-white/5">
              <Upload className="w-3 h-3" />
            </button>
            {p.sourceFile && (
              <button onClick={p.onClearSource} title="Clear source" className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-white/5">
                <X className="w-3 h-3" />
              </button>
            )}
          </>
        }
      />
    </div>
  ));

  /* ── OUTPUT viz row (with result actions) ── */
  pinned('outputViz', 'Output', (
    <div className="h-full w-full min-h-0 relative">
      <MixVizRow
        label="Output" url={p.outputUrl} overlayUrl={p.sourceUrl} accent="#a855f7" overlayAccent="#22d3ee"
        mode={p.outputMode} onMode={p.setOutputMode} overlay={p.outputOverlay} onToggleOverlay={p.toggleOutputOverlay}
        placeholder="output appears after processing"
        headerExtra={
          <>
            {p.outStats && <StatRow stats={p.outStats} />}
            <MixTransport url={p.outputUrl} label="MIX Output" />
            <button onClick={p.onDownload} disabled={!p.outputUrl} title="Save" className="p-1 rounded text-zinc-400 hover:text-green-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"><Download className="w-3 h-3" /></button>
            <button onClick={p.onSendToDAW} disabled={!p.outputUrl} title="Send to Edit" className="p-1 rounded text-zinc-400 hover:text-emerald-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"><Send className="w-3 h-3" /></button>
            <button onClick={p.onSendToInpaint} disabled={!p.outputUrl} title="Send to Inpaint" className="p-1 rounded text-zinc-400 hover:text-purple-200 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"><Sparkles className="w-3 h-3" /></button>
          </>
        }
      />
      {p.isChainProcessing && (
        <div className="absolute inset-0 grid place-items-center bg-black/50 backdrop-blur-sm pointer-events-none">
          <span className="text-[10px] font-mono text-purple-300 animate-pulse">processing chain…</span>
        </div>
      )}
    </div>
  ));

  /* ── effect rail: categories + Quick Master ── */
  pinned('effectRail', 'Effects', (
    <div className="h-full w-full flex flex-col min-h-0 overflow-hidden p-1.5 gap-1.5">
      <span className={sectionTitle}>Effects</span>
      <div className="flex flex-col gap-0.5 overflow-y-auto min-h-0">
        <button onClick={() => p.setActiveCategory('all')}
          title="Every effect in MIX, grouped by category"
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'all' ? 'border-purple-400 text-purple-200 bg-purple-500/10' : 'border-transparent text-zinc-300 hover:text-zinc-100 hover:bg-white/5'}`}>
          <Library className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">All</span>
          <span className="text-[8px] font-mono text-zinc-500 shrink-0">{p.allEffectCount}</span>
        </button>
        <button onClick={() => p.setActiveCategory('studio')}
          title="Studio modules, the Ares control surface, and the psychoacoustic effects"
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'studio' ? 'border-cyan-400 text-cyan-200 bg-cyan-500/10' : 'border-transparent text-cyan-400/80 hover:text-cyan-200 hover:bg-cyan-500/5'}`}>
          <Boxes className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">Studio</span>
          <span className="text-[8px] font-mono text-cyan-600 shrink-0">{STUDIO_MODULES.length + PSYCHO_MODULES.length + 1}</span>
        </button>
        <button onClick={() => p.setActiveCategory('magenta')}
          title="Magenta RealTime 2 — generative instruments (Collider · Jam · MRT2)"
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'magenta' ? 'border-sky-400 text-sky-200 bg-sky-500/10' : 'border-transparent text-sky-400/80 hover:text-sky-200 hover:bg-sky-500/5'}`}>
          <Music className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">Magenta</span>
          <span className="text-[8px] font-mono text-sky-600 shrink-0">{MAGENTA_TOOLS.length}</span>
        </button>
        <button onClick={() => p.setActiveCategory('vst')}
          title="VST3 plugins hosted via pedalboard — add them to the chain like any effect"
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'vst' ? 'border-teal-400 text-teal-200 bg-teal-500/10' : 'border-transparent text-teal-400/80 hover:text-teal-200 hover:bg-teal-500/5'}`}>
          <Plug className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">VST</span>
          <span className="text-[8px] font-mono text-teal-600 shrink-0">{p.vstPlugins.length}</span>
        </button>
        <button onClick={() => p.setActiveCategory('plugins')}
          title="GAN web-plugins — open a .gan or import a VST Foundry export; renders in the effect stage"
          className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${p.activeCategory === 'plugins' ? 'border-indigo-400 text-indigo-200 bg-indigo-500/10' : 'border-transparent text-indigo-400/80 hover:text-indigo-200 hover:bg-indigo-500/5'}`}>
          <Blocks className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-bold flex-1 truncate">Plugins</span>
          <span className="text-[8px] font-mono text-indigo-600 shrink-0">{p.ganPlugins.length}</span>
        </button>
        {CATEGORY_META.map((cat) => {
          const Icon = cat.icon;
          const active = p.activeCategory === cat.id;
          return (
            <button key={cat.id} onClick={() => p.setActiveCategory(cat.id)}
              className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded w-full text-left border-l-2 transition-colors ${active ? cat.rail.active : cat.rail.idle}`}>
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="text-[10px] font-semibold flex-1 truncate">{cat.label}</span>
              <span className="text-[8px] font-mono text-zinc-600 shrink-0">{cat.count}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-auto pt-2 border-t border-white/8 shrink-0">
        <div className="flex items-center gap-1 mb-2"><Gauge className="w-3 h-3 text-purple-300" /><span className={sectionTitle}>Quick Master</span></div>
        <div className="grid grid-cols-2 gap-x-1 gap-y-2 place-items-center mb-2">
          <SlideKnob label="Punch" value={p.quickMaster.lowBoost} onChange={(v) => p.setQuickParam('lowBoost', v)} min={-6} max={6} step={0.5} size={34} />
          <SlideKnob label="Air" value={p.quickMaster.highBoost} onChange={(v) => p.setQuickParam('highBoost', v)} min={-6} max={6} step={0.5} size={34} />
          <SlideKnob label="Drive" value={p.quickMaster.targetLUFS} onChange={(v) => p.setQuickParam('targetLUFS', v)} min={-24} max={-8} step={0.5} size={34} />
          <SlideKnob label="Ceil" value={p.quickMaster.limiterCeiling} onChange={(v) => p.setQuickParam('limiterCeiling', v)} min={0.8} max={1} step={0.01} size={34} />
        </div>
        <button onClick={p.applyQuickMaster} className="w-full btn-ghost text-[9px] py-1 flex items-center justify-center gap-1 text-purple-300 border-purple-500/20 bg-purple-500/5">
          <Plus className="w-3 h-3" /> {p.masterEntry ? 'Sync Master' : 'Add Quick Master'}
        </button>
      </div>
    </div>
  ));

  /* ── library ── */
  pinned('library', 'Library', (
    <div className="h-full w-full flex flex-col min-h-0 min-w-0 overflow-hidden p-2">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <span className={sectionTitle}>{p.activeCategory === 'studio' ? 'Studio' : p.activeCategory === 'magenta' ? 'Magenta Tools' : p.activeCategory === 'vst' ? 'VST3 Plugins' : p.activeCategory === 'plugins' ? 'GAN Plugins' : p.activeCategory === 'all' ? 'All Effects' : (CATEGORY_META.find((c) => c.id === p.activeCategory)?.label ?? 'Effects')}</span>
        {p.activeCategory !== 'studio' && p.activeCategory !== 'magenta' && p.activeCategory !== 'vst' && p.activeCategory !== 'plugins' && (
          <div className="flex items-center gap-0.5 bg-black/40 rounded p-0.5">
            <button onClick={() => p.setViewMode('list')} title="List view" className={`p-1 rounded transition-colors ${p.viewMode === 'list' ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}><LayoutList className="w-3 h-3" /></button>
            <button onClick={() => p.setViewMode('tile')} title="Icon view" className={`p-1 rounded transition-colors ${p.viewMode === 'tile' ? 'text-purple-300 bg-purple-500/20' : 'text-zinc-500 hover:text-zinc-300'}`}><Grid3x3 className="w-3 h-3" /></button>
          </div>
        )}
      </div>
      {p.activeCategory === 'magenta' ? (
        <div className="flex-1 overflow-y-auto"><div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
          {MAGENTA_TOOLS.map((m) => {
            const active = p.activeMagentaTool?.id === m.id;
            return (
              <button key={m.id} onClick={() => p.onPickMagenta(m.id)} title={m.desc}
                className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${active ? 'border-cyan-400/60 ring-1 ring-cyan-400/40 bg-cyan-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
                style={{ width: 132 }}>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: m.color, boxShadow: `0 0 5px ${m.color}80` }} />
                  <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">{m.name}</span>
                </div>
                <div className="relative w-full h-20 rounded bg-[#0a0c14] border border-white/5 overflow-hidden">
                  <ModuleThumb preview={m.preview} className="w-full h-full" />
                </div>
                <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{m.desc}</span>
              </button>
            );
          })}
        </div></div>
      ) : p.activeCategory === 'studio' ? (
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
            {/* Ares control surface — first-class bundled plugin, opens in the stage. */}
            <button onClick={p.onPickAres} title="Ares — XY Kaoss control surface"
              className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${p.ganActiveId === 'ares' ? 'border-rose-400/60 ring-1 ring-rose-400/40 bg-rose-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
              style={{ width: 132 }}>
              <div className="flex items-center gap-1.5">
                <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: '#ff3b3b', boxShadow: '0 0 5px #ff3b3b80' }} />
                <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">Ares</span>
                {p.ganActiveId === 'ares' && <span aria-label="Open" className="w-1.5 h-1.5 rounded-full bg-rose-400 shrink-0" />}
              </div>
              <div className="relative w-full h-20 rounded bg-[#0a0c14] border border-white/5 overflow-hidden grid place-items-center">
                <Gauge className="w-7 h-7 text-rose-300/80" />
              </div>
              <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{p.aresInstalled ? 'XY Kaoss control surface' : 'packaging…'}</span>
            </button>
            {STUDIO_MODULES.map((m) => {
              const active = p.activeModule?.id === m.id;
              return (
                <button key={`mod-${m.id}`} onClick={() => p.onPickModule(m.id)} title={m.desc}
                  className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${active ? 'border-cyan-400/60 ring-1 ring-cyan-400/40 bg-cyan-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
                  style={{ width: 132 }}>
                  <div className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: m.color, boxShadow: `0 0 5px ${m.color}80` }} />
                    <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">{m.name}</span>
                  </div>
                  <div className="relative w-full h-20 rounded bg-[#0a0c14] border border-white/5 overflow-hidden">
                    <ModuleThumb preview={m.preview} className="w-full h-full" />
                  </div>
                  <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{m.desc}</span>
                </button>
              );
            })}
            {PSYCHO_MODULES.map((m) => {
              const active = p.selectedEntry?.effect === m.id;
              const inChain = p.chainEffectIds.has(m.id);
              return (
                <button key={`psy-${m.id}`} onClick={() => p.onPickPsycho(m.id)} title={m.desc}
                  className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${active ? 'border-fuchsia-400/60 ring-1 ring-fuchsia-400/40 bg-fuchsia-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
                  style={{ width: 132 }}>
                  <div className="flex items-center gap-1.5">
                    <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: m.color, boxShadow: `0 0 5px ${m.color}80` }} />
                    <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">{m.name}</span>
                    {inChain && <span role="img" aria-label="In chain" className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 shrink-0" />}
                  </div>
                  <div className="relative w-full h-20 rounded bg-[#0a0c14] border border-white/5 overflow-hidden">
                    <ModuleThumb preview={m.preview} className="w-full h-full" />
                  </div>
                  <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{m.desc}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : p.activeCategory === 'vst' ? (
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
          <div className="flex items-center gap-2 px-1.5 pb-1.5 shrink-0">
            <button onClick={p.rescanVst} disabled={p.vstScanning} className="btn-ghost inline-flex items-center gap-1 disabled:opacity-40" title="Rescan the standard VST3 folders">
              {p.vstScanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Rescan
            </button>
            <span className="text-[8px] font-mono text-zinc-600">host: pedalboard</span>
          </div>
          {p.vstPlugins.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center opacity-30 italic gap-2 py-8">
              <Plug className="w-7 h-7" />
              <span className="text-[10px]">{p.vstScanning ? 'Scanning…' : 'No VST3 plugins found. Click Rescan.'}</span>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
              {p.vstPlugins.map((pl) => {
                const inChain = p.vstInChain.has(pl.path);
                return (
                  <button key={pl.path} onClick={() => p.addVstToChain(pl)} title={pl.path}
                    className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${inChain ? 'border-teal-400/60 ring-1 ring-teal-400/40 bg-teal-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
                    style={{ width: 132 }}>
                    <div className="flex items-center gap-1.5">
                      <Plug className="w-3 h-3 text-teal-300 shrink-0" />
                      <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">{pl.name}</span>
                      {inChain && <span aria-label="In chain" className="w-1.5 h-1.5 rounded-full bg-teal-400 shrink-0" />}
                    </div>
                    <div className="relative w-full h-16 rounded bg-[#0a0c14] border border-white/5 overflow-hidden">
                      <ModuleThumb preview={vstPreviewKey(pl.category)} seed={`${pl.name}|${pl.manufacturer}`} className="w-full h-full" />
                    </div>
                    <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{[pl.manufacturer, pl.version].filter(Boolean).join(' · ') || pl.category}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : p.activeCategory === 'plugins' ? (
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
          <div className="flex items-center gap-2 px-1.5 pb-1.5 shrink-0">
            <button onClick={p.onOpenGan} disabled={p.ganBusy} className="btn-ghost inline-flex items-center gap-1 disabled:opacity-40" title="Open a .gan plugin file">
              <FolderOpen className="w-3 h-3" /> Open .gan
            </button>
            <button onClick={p.onImportGan} disabled={p.ganBusy} className="btn-ghost inline-flex items-center gap-1 disabled:opacity-40" title="Import a VST Foundry export (project.json) into a .gan">
              <Plus className="w-3 h-3" /> Import
            </button>
            {p.ganBusy && <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />}
          </div>
          {p.ganPlugins.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center opacity-30 italic gap-2 py-8">
              <Blocks className="w-7 h-7" />
              <span className="text-[10px]">No .gan plugins yet. Open or import one.</span>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
              {p.ganPlugins.map((pl) => {
                const active = p.ganActiveId === pl.id;
                return (
                  <button key={pl.id} onClick={() => p.onPickGan(pl.id)}
                    onContextMenu={(e) => { e.preventDefault(); p.onRevealGan(pl.gan_path); }}
                    title={`${pl.name} — right-click to reveal the .gan in its folder`}
                    className={`group relative flex flex-col gap-1.5 rounded-md border overflow-hidden transition-all p-2 text-left ${active ? 'border-indigo-400/60 ring-1 ring-indigo-400/40 bg-indigo-500/5' : 'border-white/8 bg-black/30 hover:border-white/20 hover:brightness-110'}`}
                    style={{ width: 132 }}>
                    <div className="flex items-center gap-1.5">
                      <Blocks className="w-3 h-3 text-indigo-300 shrink-0" />
                      <span className="text-[10px] font-bold text-zinc-100 truncate flex-1">{pl.name}</span>
                      {active && <span aria-label="Open" className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0" />}
                    </div>
                    <span className="text-[8px] font-mono text-zinc-500 leading-tight line-clamp-2">{pl.description || pl.kind}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : p.activeCategory === 'all' ? (() => {
        // Everything in MIX, in either list or icon view. Order: Studio +
        // Psychoacoustics first, then the backend effect categories.
        const tile = p.viewMode === 'tile';
        const boxCls = tile ? 'flex flex-wrap gap-3 content-start justify-center p-1' : 'flex flex-col gap-1';
        return (
          <div className="flex-1 overflow-y-auto"><div className="flex flex-col gap-2 content-start">
            <div className="flex flex-col gap-1">
              <AllHeader icon={Boxes} color="text-cyan-300" label="Studio" count={STUDIO_MODULES.length + 1} />
              <div className={boxCls}>
                {tile
                  ? <ModuleTile key="ares" name="Ares" color="#ff3b3b" marked={p.ganActiveId === 'ares'} onClick={p.onPickAres} />
                  : <ModuleRow key="ares" name="Ares" desc="XY Kaoss control surface" color="#ff3b3b" marked={p.ganActiveId === 'ares'} onClick={p.onPickAres} />}
                {STUDIO_MODULES.map((m) => (tile
                  ? <ModuleTile key={m.id} name={m.name} color={m.color} marked={p.activeModule?.id === m.id} onClick={() => p.onPickModule(m.id)} preview={m.preview} />
                  : <ModuleRow key={m.id} name={m.name} desc={m.desc} color={m.color} marked={p.activeModule?.id === m.id} onClick={() => p.onPickModule(m.id)} />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <AllHeader icon={Headphones} color="text-fuchsia-300" label="Psychoacoustics" count={PSYCHO_MODULES.length} />
              <div className={boxCls}>
                {PSYCHO_MODULES.map((m) => {
                  const marked = p.selectedEntry?.effect === m.id || p.chainEffectIds.has(m.id);
                  return tile
                    ? <ModuleTile key={m.id} name={m.name} color={m.color} marked={marked} onClick={() => p.onPickPsycho(m.id)} preview={m.preview} />
                    : <ModuleRow key={m.id} name={m.name} desc={m.desc} color={m.color} marked={marked} onClick={() => p.onPickPsycho(m.id)} />;
                })}
              </div>
            </div>
            {p.vstPlugins.length > 0 && (
              <div className="flex flex-col gap-1">
                <AllHeader icon={Plug} color="text-teal-300" label="VST3" count={p.vstPlugins.length} />
                <div className={boxCls}>
                  {p.vstPlugins.map((pl) => {
                    const inChain = p.vstInChain.has(pl.path);
                    const desc = [pl.manufacturer, pl.version].filter(Boolean).join(' · ') || pl.category;
                    return tile
                      ? <ModuleTile key={pl.path} name={pl.name} color="#2dd4bf" marked={inChain} onClick={() => p.addVstToChain(pl)} preview={vstPreviewKey(pl.category)} seed={`${pl.name}|${pl.manufacturer}`} />
                      : <ModuleRow key={pl.path} name={pl.name} desc={desc} color="#2dd4bf" marked={inChain} onClick={() => p.addVstToChain(pl)} />;
                  })}
                </div>
              </div>
            )}
            {CATEGORY_META.map((cat) => {
              const fxs = EFFECT_CATALOG[cat.id] || [];
              if (!fxs.length) return null;
              return (
                <div key={cat.id} className="flex flex-col gap-1">
                  <AllHeader icon={cat.icon} color={cat.tile.text} label={cat.label} count={fxs.length} />
                  <div className={boxCls}>
                    {fxs.map((fx) => {
                      const inChain = p.chainEffectIds.has(fx.id);
                      return tile
                        ? <FxTile key={fx.id} name={fx.name} cat={cat} inChain={inChain} onClick={() => p.addEffect(fx.id)} preview={fxPreview[fx.id]} />
                        : <FxRow key={fx.id} name={fx.name} desc={fx.desc} cat={cat} inChain={inChain} onClick={() => p.addEffect(fx.id)} />;
                    })}
                  </div>
                </div>
              );
            })}
          </div></div>
        );
      })() : p.viewMode === 'list' ? (
        <div className="flex-1 overflow-y-auto"><div className="flex flex-col gap-1 content-start">
          {p.activeEffects.map((fx) => {
            const cat = fxToCategory[fx.id] ?? CATEGORY_META[0];
            const inChain = p.chainEffectIds.has(fx.id);
            return (
              <div key={fx.id} onClick={() => p.addEffect(fx.id)}
                className={`flex items-center gap-2 border rounded px-3 py-2 cursor-pointer transition-all ${inChain ? 'border-white/30 bg-white/5' : 'border-zinc-800 hover:border-white/25 hover:bg-white/5'}`}>
                <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${cat.dot}`} />
                <div className="flex-1 min-w-0">
                  <span className={`text-[11px] font-medium block truncate ${cat.tile.text}`}>{fx.name}</span>
                  <p className="text-[9px] text-zinc-500 truncate mt-0.5">{fx.desc}</p>
                </div>
                {inChain && <span className={`w-2 h-2 rounded-full shrink-0 ${cat.dot}`} />}
              </div>
            );
          })}
        </div></div>
      ) : (
        <div className="flex-1 overflow-y-auto"><div className="flex flex-wrap gap-3 content-start justify-center p-1.5">
          {p.activeEffects.map((fx) => {
            const inChain = p.chainEffectIds.has(fx.id);
            const cat = fxToCategory[fx.id] ?? CATEGORY_META[0];
            return <FxTile key={fx.id} name={fx.name} cat={cat} inChain={inChain} onClick={() => p.addEffect(fx.id)} preview={fxPreview[fx.id]} />;
          })}
        </div></div>
      )}
    </div>
  ));

  /* ── chain — horizontal signal flow, left → right ── */
  pinned('chain', 'Chain', (
    <div className="h-full w-full flex flex-col min-h-0 overflow-hidden p-2">
      <div className="flex items-center gap-2 mb-1.5 shrink-0">
        <span className={sectionTitle}>Chain {p.chain.length > 0 && <span className="text-zinc-600">({p.chain.length})</span>}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[9px] font-mono text-zinc-500 shrink-0">FORMAT</span>
          <select name="mix-output-format" className="compact-input text-[10px] w-20" value={p.outputFormat} onChange={(e) => p.setOutputFormat(e.target.value)}>
            <option value="wav">WAV</option><option value="flac">FLAC</option><option value="mp3">MP3</option><option value="ogg">OGG</option>
          </select>
          <button onClick={() => p.setShowHistory(!p.showHistory)} title="Process history" className={`btn-ghost p-1 shrink-0 ${p.showHistory ? 'text-purple-300' : 'text-zinc-500 hover:text-zinc-300'}`}><History className="w-3.5 h-3.5" /></button>
          {p.chain.length > 0 && <button className="text-zinc-600 hover:text-red-400 transition-colors shrink-0" onClick={p.clearChain} title="Clear chain"><Trash2 className="w-3.5 h-3.5" /></button>}
        </div>
      </div>
      {p.showHistory && (
        <div className="max-h-14 overflow-y-auto flex flex-col gap-0.5 mb-1.5 shrink-0">
          {p.processHistory.length === 0 ? <span className="text-[9px] font-mono text-zinc-600 px-1">No process jobs yet.</span> : p.processHistory.map((h) => (
            <div key={h.id} className="flex items-center justify-between px-1.5 py-0.5 bg-white/5 rounded">
              <span className="text-[9px] font-mono text-zinc-300 uppercase truncate">{EFFECT_LABELS[h.effect] || h.effect}</span>
              <span className="text-[8px] font-mono text-zinc-600 shrink-0">{new Date(h.createdAt).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-x-auto overflow-y-hidden flex flex-row items-stretch gap-0 min-h-0">
        {p.chain.length === 0 ? (
          <div className="flex-1 flex items-center justify-center px-2"><span className="text-[10px] text-zinc-600 text-center">Add effects from the library — they flow left → right</span></div>
        ) : (
          p.chain.map((entry, index) => (
            <React.Fragment key={entry.id}>
              {index > 0 && <div className="self-center px-0.5 text-zinc-700 shrink-0"><ChevronRight className="w-3 h-3" /></div>}
              <div onClick={() => p.setSelectedId(entry.id)}
                className={`rounded p-1.5 border transition-all cursor-pointer shrink-0 w-40 flex flex-col ${p.selectedEntry?.id === entry.id ? 'border-purple-500/60 bg-purple-500/5' : 'border-zinc-800 hover:border-white/10'} ${!entry.enabled ? 'opacity-40' : ''}`}>
                <div className="flex items-center gap-1 shrink-0">
                  <button className="text-zinc-600 hover:text-purple-400 disabled:opacity-20 shrink-0" disabled={index === 0} title="Move earlier" onClick={(e) => { e.stopPropagation(); p.reorder(index, index - 1); }}><ChevronLeft className="w-3 h-3" /></button>
                  <span className="text-[10px] font-mono text-purple-300 font-semibold flex-1 truncate">{entry.vst ? entry.vst.plugin_name : (EFFECT_LABELS[entry.effect] || getRackEffect(entry.effect)?.label || entry.effect)}</span>
                  {entry.vst && (
                    <button
                      className={`shrink-0 ${entry.vst.raw_state ? 'text-teal-400 hover:text-teal-300' : 'text-zinc-500 hover:text-teal-300'}`}
                      title={entry.vst.raw_state ? "Edit plugin GUI (custom settings saved)" : "Open the plugin's native GUI"}
                      onClick={(e) => { e.stopPropagation(); p.onEditVst(entry); }}
                    >
                      <SlidersHorizontal className="w-3 h-3" />
                    </button>
                  )}
                  <button className="text-zinc-500 hover:text-purple-400 shrink-0" onClick={(e) => { e.stopPropagation(); p.toggleEnabled(entry.id); }}>{entry.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}</button>
                  <button className="text-zinc-600 hover:text-red-400 shrink-0" onClick={(e) => { e.stopPropagation(); p.removeEffect(entry.id); }}><X className="w-3 h-3" /></button>
                  <button className="text-zinc-600 hover:text-purple-400 disabled:opacity-20 shrink-0" disabled={index === p.chain.length - 1} title="Move later" onClick={(e) => { e.stopPropagation(); p.reorder(index, index + 1); }}><ChevronRight className="w-3 h-3" /></button>
                </div>
                {Object.keys(entry.params).length > 0 && (
                  <div className="flex flex-col gap-1 mt-1.5 overflow-y-auto min-h-0" onClick={(e) => e.stopPropagation()}>
                    {Object.entries(entry.params).map(([key, val]) => {
                      const rd = getRackEffect(entry.effect)?.params.find((pp) => pp.key === key);
                      const [min, max, step] = PARAM_BOUNDS[entry.effect]?.[key] || (rd ? [rd.min, rd.max, rd.step] : [0, 1, 0.01]);
                      return <SlideRow key={key} label={rd?.label || prettyParam(key)} value={val} min={min} max={max} step={step} onChange={(v) => p.updateParams(entry.id, { ...entry.params, [key]: v })} />;
                    })}
                  </div>
                )}
              </div>
            </React.Fragment>
          ))
        )}
      </div>
    </div>
  ));

  /* ── effect stage — THE LIVE VIEW only. Shows the active plugin/instrument or the
     selected chain entry's live viz. A selected spatializer entry gets The Owl's
     dedicated surface (which drives that entry's params in the ONE chain); every
     other selected entry shows its EffectsVizPanel. No rack editor here. ── */
  const selected = p.selectedEntry;
  pinned('effectStage', 'Effect Stage', (
    p.vstEmbed
      ? <VstEmbedHost pluginPath={p.vstEmbed.pluginPath} pluginName={p.vstEmbed.pluginName} error={p.vstEmbed.error} onClose={p.onCloseVstEmbed} />
    : p.ganActiveUrl
      ? <GanPluginStage url={p.ganActiveUrl} name={p.ganActiveName} />
    : p.activeMagentaTool
      ? <MagentaToolStage tool={p.activeMagentaTool} />
    : p.activeModule
      ? <EffectGuiStage module={p.activeModule} sourceFile={p.sourceFile} />
    : selected && selected.effect === 'spatializer'
      ? <TheOwl params={selected.params} idPrefix={`mix-owl-${selected.id}`} onChange={(np) => p.updateParams(selected.id, np)} />
    : selected
      ? <EffectsVizPanel effect={selected.effect} params={selected.params} className="h-full! border-purple-500/15!" />
      : <EffectGuiStage module={null} sourceFile={p.sourceFile} />
  ));

  return reg;
}

/* ═══════════════════════════════ MixView ═══════════════════════════════════ */

export const MixView: React.FC = () => {
  const sourceFile = useAdvancedEditorSourceStore((s) => s.sourceFile);
  const outputUrl = useAdvancedEditorSourceStore((s) => s.outputUrl);
  const setSource = useAdvancedEditorSourceStore((s) => s.setSource);

  const chain = useEffectChainStore((s) => s.chain) as ChainEntry[];
  const addEffect = useEffectChainStore((s) => s.addEffect);
  // Psychoacoustic effects are first-class members of THE chain (added via
  // addRackEffect so they seed rack defaults, not the backend EFFECT_DEFAULTS).
  const addRackEffect = useEffectChainStore((s) => s.addRackEffect);
  const addVst = useEffectChainStore((s) => s.addVst);
  // VST3 plugins for the effects browser (hosted via pedalboard).
  const vstPlugins = useVstStore((s) => s.plugins);
  const vstScanning = useVstStore((s) => s.scanning);
  const scanVst = useVstStore((s) => s.scan);
  // .gan web-plugins (generic loader) for the MIX effect stage.
  const ganPlugins = useGanStore((s) => s.plugins);
  const ganActiveId = useGanStore((s) => s.activeId);
  const ganActiveUrl = useGanStore((s) => s.activeUrl);
  const ganActiveName = useGanStore((s) => s.activeName);
  const ganBusy = useGanStore((s) => s.busy);
  const ganRefresh = useGanStore((s) => s.refresh);
  const ganOpenPath = useGanStore((s) => s.openPath);
  const ganOpenById = useGanStore((s) => s.openById);
  const ganImportOwl = useGanStore((s) => s.importOwl);
  const ganEnsureAres = useGanStore((s) => s.ensureAres);
  const ganClose = useGanStore((s) => s.close);
  const removeEffect = useEffectChainStore((s) => s.removeEffect);
  const updateParams = useEffectChainStore((s) => s.updateParams);
  const toggleEnabled = useEffectChainStore((s) => s.toggleEnabled);
  const reorder = useEffectChainStore((s) => s.reorder);
  const clearChain = useEffectChainStore((s) => s.clearChain);
  const setVstRawState = useEffectChainStore((s) => s.setVstRawState);
  // The VST chain entry whose native editor is currently embedded in the Effect
  // Stage (Electron only). null = no embedded editor. `error` is set when the
  // plugin fails to load so the host shows it instead of a forever "loading…".
  const [vstEmbed, setVstEmbed] = useState<{ entryId: string; pluginPath: string; pluginName: string; error?: string } | null>(null);

  const outputFormat = useStudioStore((s) => s.outputFormat);
  const setOutputFormat = useStudioStore((s) => s.setOutputFormat);
  const isChainProcessing = useStudioStore((s) => s.isChainProcessing);
  const processHistory = useStudioStore((s) => s.processHistory);

  const [activeCategory, setActiveCategory] = useState('all');
  const [viewMode, setViewMode] = useState<'list' | 'tile'>('tile');
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const [activeModuleId, setActiveModuleId] = useState<string | null>(null);
  // The Magenta RT2 tool focused in the Effect Stage (Collider / Jam / MRT2).
  const [activeMagentaId, setActiveMagentaId] = useState<string | null>(null);
  const [srcStats, setSrcStats] = useState<AudioStats | null>(null);
  const [outStats, setOutStats] = useState<AudioStats | null>(null);
  const [dragOverSource, setDragOverSource] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [inputMode, setInputMode] = useState<MixVizMode>('wave');
  const [outputMode, setOutputMode] = useState<MixVizMode>('wave');
  const [inputOverlay, setInputOverlay] = useState(false);
  const [outputOverlay, setOutputOverlay] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [quickMaster, setQuickMaster] = useState<Record<string, number>>(() => ({ ...EFFECT_DEFAULTS.mastering_chain }));

  const sourceUrl = useMemo(() => (sourceFile ? URL.createObjectURL(sourceFile) : null), [sourceFile]);
  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl); }, [sourceUrl]);

  // Wire the psychoacoustic rack onto the footer's master insert so it is heard
  // LIVE on the transport and is never rebuilt when a new clip is applied. Attached
  // once for the session; an empty rack is a clean passthrough (see mixLiveRack).
  useEffect(() => { attachMixLiveRack(); }, []);

  // Populate the VST3 browser on first open (cached scan — cheap).
  useEffect(() => { void scanVst(false); }, [scanVst]);
  // Populate the installed .gan plugin list on first open, then make sure the
  // bundled Ares control surface is packaged so it shows as a Studio tile.
  useEffect(() => { void ganRefresh().then(() => ganEnsureAres()); }, [ganRefresh, ganEnsureAres]);

  // ── Ares control surface -> live effect params ─────────────────────────────
  // The Ares .gan XY pad postMessages {type:'updateValue', id, valueX, valueY,
  // valueZ}; drive the focused (else first) psychoacoustic chain entry's params
  // from it — its first up-to-three params take X / Y / Z. rAF-coalesced so 60fps
  // input never thrashes the store (mixLiveRack pushes params without a rebuild,
  // so it stays click-free). If no rack effect is in the chain yet, one owlpad is
  // added so the pad always has something audible to move.
  const aresXyId = useMemo(() => {
    const a = ganPlugins.find((pl) => pl.id === 'ares');
    return a?.controls.find((c) => c.name === 'ares_xy_kaoss_pad')?.id ?? 'pf5ixrn';
  }, [ganPlugins]);
  const aresXyIdRef = useRef(aresXyId);
  aresXyIdRef.current = aresXyId;
  // Ares .gan controls -> the single 'ares' composite chain effect. The XY pad's
  // X/Y/Z drive the macro params (ARES_PAD_AXES); every other mapped control sets
  // its own param (ARES_CTRL_PARAM). rAF-coalesced (patches merged per frame) so
  // 60fps pad input never thrashes the store, and mixLiveRack pushes params without
  // a rebuild so it stays click-free.
  useEffect(() => {
    let raf: number | null = null;
    let pendingPatch: Record<string, number> | null = null;
    const flush = () => {
      raf = null;
      const patch = pendingPatch;
      pendingPatch = null;
      if (!patch) return;
      const ares = useEffectChainStore.getState().chain.find((e) => e.effect === 'ares');
      if (!ares) return; // Ares controls act only when the Ares effect is in the chain
      useEffectChainStore.getState().updateParams(ares.id, { ...ares.params, ...patch });
    };
    const handler = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.type !== 'updateValue') return;
      let add: Record<string, number> | null = null;
      if (d.id === aresXyIdRef.current && typeof d.valueX === 'number') {
        const axes = [
          d.valueX,
          typeof d.valueY === 'number' ? d.valueY : 0.5,
          typeof d.valueZ === 'number' ? d.valueZ : 0.5,
        ];
        add = {};
        for (let i = 0; i < ARES_PAD_AXES.length; i += 1) add[ARES_PAD_AXES[i]] = clamp01(axes[i]);
      } else {
        const key = ARES_CTRL_PARAM[d.id];
        if (key && typeof d.value === 'number') add = { [key]: clamp01(d.value) };
      }
      if (!add) return;
      pendingPatch = pendingPatch ? { ...pendingPatch, ...add } : add;
      if (raf == null) raf = requestAnimationFrame(flush);
    };
    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, []);

  // While Ares is open, feed the live master output level into its .gan so its
  // level meter reflects the real signal (pushed down through the runtime relay).
  useEffect(() => {
    if (ganActiveId !== 'ares') return;
    const analyser = getAnalyser();
    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 3);
      const fr = document.getElementById('gan-stage-frame') as HTMLIFrameElement | null;
      fr?.contentWindow?.postMessage({ type: 'level', value: level }, '*');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [ganActiveId]);

  useEffect(() => {
    if (!sourceFile) { setSrcStats(null); return; }
    analyzeAudio(sourceFile).then(setSrcStats).catch(() => setSrcStats(null));
  }, [sourceFile]);
  useEffect(() => {
    if (!outputUrl) { setOutStats(null); return; }
    analyzeAudio(outputUrl).then(setOutStats).catch(() => setOutStats(null));
  }, [outputUrl]);

  const setSourceBoth = (file: File | null) => {
    setSource(file);
    useStudioStore.getState().setSourceFile(file);
    // Bind the MIX working file to the footer transport so pressing Play auditions
    // it LIVE through the master rack. The rack stays put across source swaps, so a
    // new clip starts cleanly without tearing down or restarting the effects.
    if (file) void usePlayerStore.getState().load(file, { label: file.name });
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

  const allEffects = Object.values(EFFECT_CATALOG).flat();
  const activeEffects = activeCategory === 'all' ? allEffects : (EFFECT_CATALOG[activeCategory] || []);
  const chainEffectIds = new Set(chain.map((e) => e.effect));
  const vstInChain = new Set(chain.filter((e) => e.vst).map((e) => e.vst!.plugin_path));
  const addVstToChain = (pl: Vst3PluginInfo) => addVst({ plugin_path: pl.path, plugin_name: pl.name });
  const selectedEntry = chain.find((e) => e.id === selectedChainId) ?? chain[0] ?? null;

  // Open a VST3 plugin's REAL native GUI (pedalboard show_editor in a sidecar
  // process), then poll for the captured state and store it on this chain entry
  // so the dialed-in sound is reused at process time. The editor is a native OS
  // window, so the user tweaks it there and closes it to commit.
  const handleEditVst = (entry: ChainEntry) => {
    if (!entry.vst) return;
    if (vstEmbed?.entryId === entry.id) return; // already open for this entry
    const path = entry.vst.plugin_path;
    const name = entry.vst.plugin_name;
    const rawState = entry.vst.raw_state;
    const status = useStatusBarStore.getState();
    // Dismiss any other embedded editor before opening this one.
    if (vstEmbed && vstEmbed.entryId !== entry.id) {
      void vstApi.editorRect(vstEmbed.pluginPath, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
    }
    const clearEmbed = () => setVstEmbed((cur) => (cur?.entryId === entry.id ? null : cur));
    void (async () => {
      // In Electron, embed the editor in the Effect Stage; in a browser it falls
      // back to a floating native window (no parent handle available).
      const hwnd = await getNativeWindowHandle();
      const embed = hwnd
        ? { parentHwnd: hwnd, rect: { x: 0, y: 0, w: 480, h: 320, dpr: window.devicePixelRatio || 1 } }
        : undefined;
      if (embed) setVstEmbed({ entryId: entry.id, pluginPath: path, pluginName: name });
      try {
        await vstApi.openEditor(path, rawState, embed);
        status.setText(embed
          ? `VST GUI: ${name} embedding in MIX…`
          : `VST GUI: ${name} opened — close the window to save its settings`);
        const startedAt = performance.now();
        const poll = () => {
          vstApi.editorResult(path)
            .then((res) => {
              if (res.status === 'ok' && res.raw_state) {
                setVstRawState(entry.id, res.raw_state);
                status.setText(`VST GUI: ${name} settings captured`);
                clearEmbed();
                return;
              }
              if (res.status === 'error') {
                const msg = res.error || 'editor unavailable';
                status.setText(`VST GUI: ${msg}`);
                // Keep the host visible (Electron) so the failure is on-screen,
                // not just in the status bar; otherwise just clear.
                setVstEmbed((cur) => (cur?.entryId === entry.id ? { ...cur, error: msg } : cur));
                return;
              }
              if (performance.now() - startedAt < 30 * 60 * 1000) window.setTimeout(poll, 1500);
            })
            .catch(() => { if (performance.now() - startedAt < 30 * 60 * 1000) window.setTimeout(poll, 1500); });
        };
        window.setTimeout(poll, 1500);
      } catch (e) {
        clearEmbed();
        status.setText(`VST GUI FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  };

  // Clicking a VST in the browser adds it to the chain (once) AND opens its GUI
  // immediately — no separate "Edit GUI" step. Re-clicking one already in the
  // chain just (re)opens its editor instead of adding a duplicate.
  const addAndEditVst = (pl: Vst3PluginInfo) => {
    let entry = useEffectChainStore.getState().chain.find((e) => e.vst?.plugin_path === pl.path);
    if (!entry) {
      addVstToChain(pl);
      entry = [...useEffectChainStore.getState().chain].reverse().find((e) => e.vst?.plugin_path === pl.path);
    }
    if (entry) handleEditVst(entry as ChainEntry);
  };

  // The instrument shown in the effect stage: an explicitly-picked Studio Module
  // takes priority; otherwise the selected chain effect opens its mapped module.
  const mappedModuleId = selectedEntry ? effectToModuleId[selectedEntry.effect] : undefined;
  const activeModule: StudioModule | null =
    (activeModuleId ? moduleById[activeModuleId] ?? null : null)
    ?? (mappedModuleId ? moduleById[mappedModuleId] ?? null : null);

  // Picking a module from the library toggles its instrument open/closed.
  const handlePickModule = (id: string) => { ganClose(); setActiveMagentaId(null); setActiveModuleId((cur) => (cur === id ? null : id)); };
  // Selecting a chain entry hands the stage back to the effect→module mapping.
  const selectChain = (id: string) => {
    setActiveMagentaId(null); setActiveModuleId(null); setSelectedChainId(id);
    // Ares' real UI is its .gan surface — (re)open it when its entry is selected
    // instead of falling back to the generic viz; any other effect closes the .gan.
    const entry = useEffectChainStore.getState().chain.find((e) => e.id === id);
    if (entry?.effect === 'ares') {
      void (async () => {
        if (!useGanStore.getState().plugins.some((p) => p.id === 'ares')) await ganEnsureAres();
        await ganOpenById('ares');
      })();
    } else {
      ganClose();
    }
  };
  // Picking a psychoacoustic tile adds it to THE chain (seeded with rack defaults)
  // and focuses it, so the effect stage shows its live view. If it is already in
  // the chain, just focus the existing entry.
  const handlePickPsycho = (id: string) => {
    ganClose();
    setActiveModuleId(null);
    setActiveMagentaId(null);
    const existing = useEffectChainStore.getState().chain.find((e) => e.effect === id);
    if (existing) { setSelectedChainId(existing.id); return; }
    addRackEffect(id);
    const next = useEffectChainStore.getState().chain;
    const added = next[next.length - 1];
    if (added) setSelectedChainId(added.id);
  };
  // Picking a Magenta tool opens its generative instrument in the Effect Stage;
  // clicking the focused one again closes it. Mutually exclusive with the above.
  const activeMagentaTool: MagentaTool | null = activeMagentaId ? magentaToolById[activeMagentaId] ?? null : null;
  const handlePickMagenta = (id: string) => {
    ganClose();
    setActiveModuleId(null);
    setActiveMagentaId((cur) => (cur === id ? null : id));
  };
  // .gan loader: pick/import sets the active plugin and yields the stage to it.
  const handleOpenGan = async () => {
    const r = await pickFile({ filter: GAN_FILTER, title: 'Open a .gan plugin' });
    if (!r.path) return;
    setActiveModuleId(null); setActiveMagentaId(null);
    await ganOpenPath(r.path);
  };
  const handleImportGan = async () => {
    const r = await pickFile({ title: 'Select a VST Foundry export (project.json)' });
    if (!r.path) return;
    setActiveModuleId(null); setActiveMagentaId(null);
    await ganImportOwl(r.path);
  };
  const handlePickGan = (id: string) => {
    setActiveModuleId(null); setActiveMagentaId(null);
    void ganOpenById(id);
  };
  const handleRevealGan = (path: string) => { void ganApi.reveal(path).catch(() => {}); };

  // Ares is a first-class Studio entry (bundled .gan). Opening it hands the effect
  // stage to its iframe; package it on demand if the on-mount ensure hasn't landed.
  const aresInstalled = ganPlugins.some((p) => p.id === 'ares');
  const handlePickAres = () => {
    setActiveModuleId(null); setActiveMagentaId(null);
    // Ensure ONE 'ares' composite effect is in the chain and focus it, then open
    // its .gan surface in the Live View.
    const existing = useEffectChainStore.getState().chain.find((e) => e.effect === 'ares');
    if (existing) {
      setSelectedChainId(existing.id);
    } else {
      addRackEffect('ares');
      const next = useEffectChainStore.getState().chain;
      const added = next[next.length - 1];
      if (added) setSelectedChainId(added.id);
    }
    void (async () => {
      if (!useGanStore.getState().plugins.some((p) => p.id === 'ares')) await ganEnsureAres();
      await ganOpenById('ares');
    })();
  };
  // The generic Plugins browser excludes Ares (it lives in Studio as first-class).
  const ganPluginsVisible = ganPlugins.filter((p) => p.id !== 'ares');

  const registry = buildMixRegistry({
    sourceUrl, outputUrl, srcStats, outStats, sourceFile,
    inputMode, setInputMode, outputMode, setOutputMode,
    inputOverlay, toggleInputOverlay: () => setInputOverlay((v) => !v),
    outputOverlay, toggleOutputOverlay: () => setOutputOverlay((v) => !v),
    dragOverSource,
    onDrop: handleDrop,
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOverSource(true); },
    onDragLeave: () => setDragOverSource(false),
    onClickUpload: () => fileInputRef.current?.click(),
    onClearSource: () => setSourceBoth(null),
    isChainProcessing,
    onDownload: handleDownload, onSendToDAW: () => void handleSendToDAW(), onSendToInpaint: () => void handleSendToInpaint(),
    activeCategory, setActiveCategory, allEffectCount: allEffects.length + PSYCHO_MODULES.length + STUDIO_MODULES.length + vstPlugins.length + 1,
    quickMaster, setQuickParam, applyQuickMaster, masterEntry: !!masterEntry,
    activeEffects, viewMode, setViewMode, addEffect, chainEffectIds,
    vstPlugins, vstScanning, rescanVst: () => void scanVst(true), addVstToChain: addAndEditVst, vstInChain,
    ganPlugins: ganPluginsVisible, ganActiveId, ganActiveUrl, ganActiveName, ganBusy,
    onOpenGan: () => void handleOpenGan(), onImportGan: () => void handleImportGan(),
    onPickGan: handlePickGan, onRevealGan: handleRevealGan,
    onPickModule: handlePickModule, activeModuleId, activeModule,
    onPickPsycho: handlePickPsycho,
    onPickAres: handlePickAres, aresInstalled,
    onPickMagenta: handlePickMagenta, activeMagentaId, activeMagentaTool,
    chain, selectedId: selectedChainId, setSelectedId: selectChain,
    removeEffect, updateParams, toggleEnabled, reorder, clearChain, onEditVst: handleEditVst,
    vstEmbed,
    onCloseVstEmbed: () => {
      if (vstEmbed) void vstApi.editorRect(vstEmbed.pluginPath, { x: 0, y: 0, w: 0, h: 0, dpr: 1, close: true });
      setVstEmbed(null);
    },
    outputFormat, setOutputFormat, showHistory, setShowHistory, processHistory,
    selectedEntry,
  });

  return (
    <div className="relative h-full w-full overflow-hidden text-zinc-200 bg-[#07050a]">
      <ControlSurface surfaceId="mix" registry={registry} defaultLayout={defaultMixLayout} className="p-1.5" />
      <input ref={fileInputRef} name="mix-audio-file" type="file" accept="audio/*" className="hidden" onChange={handleFileSelect} title="Upload audio file" />
    </div>
  );
};
