/**
 * Unified per-effect control windows for the EDIT tab.
 *
 * ONE model for every effect kind — built-in rack effects, VST3s, and .gan
 * surfaces (Ares) are the same thing: a ChainEntry. The FX list (FxChainList)
 * shows a chain as compact rows; clicking a row opens THAT entry's control
 * window. Exactly one window can exist per entry id — reopening focuses it.
 *
 * Each window hosts the SAME control UI MIX's Effect Stage uses:
 *   - entry.vst        → VstEmbedHost (native GUI) while this entry owns the
 *                        one app-wide embed session, else MIX's "Open plugin
 *                        GUI" action card (no auto-reopen — deliberate parity
 *                        with MixView's stage).
 *   - entry 'ares'     → GanPluginStage while this entry owns the one active
 *                        gan session, else a "Take over surface" card.
 *   - built-in effects → the shared FxRack tile (same sliders/pads the rest
 *                        of the app edits params with), rendered solo.
 *
 * Windows are draggable floating cards portaled to document.body (outside the
 * .dense-layout zoom), stacked by click order. Window state lives in a
 * module-scope store so it survives EDIT's unmount on tab switch; the native
 * VST / gan sessions do close on tab switch (existing app-wide rules) and
 * their windows degrade to the reopen card.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import {
  Blocks, ChevronDown, ChevronUp, Eye, EyeOff, Loader2, Plug, Plus, RefreshCw,
  SlidersHorizontal, X,
} from 'lucide-react';
import { FxRack } from './FxRack';
import { VstEmbedHost } from './VstEmbedHost';
import { GanPluginStage } from './GanPluginStage';
import { useEditorStore } from '../../state/editorStore';
import { useVstEditorStore } from '../../state/vstEditorStore';
import { useGanStore } from '../../state/ganStore';
import { EFFECT_LABELS, type ChainEntry } from '../../state/effectChainStore';
import { getRackEffect, RACK_EFFECTS } from '../../lib/rackEffects';
import { registerAresBridge, ARES_XY_PAD_FALLBACK_ID } from '../../lib/aresBridge';
import type { Vst3PluginInfo } from '../../lib/vstClient';

// ── Scopes ───────────────────────────────────────────────────────────────────

export type FxScope =
  | { kind: 'master' }
  | { kind: 'masterVst' }
  | { kind: 'track'; trackId: string };

const scopeKey = (s: FxScope): string => (s.kind === 'track' ? `track:${s.trackId}` : s.kind);

export function chainForScope(scope: FxScope): ChainEntry[] {
  const st = useEditorStore.getState();
  if (scope.kind === 'master') return st.masterFxChain;
  if (scope.kind === 'masterVst') return st.masterVstChain;
  return st.tracks.find((t) => t.id === scope.trackId)?.fxChain ?? [];
}

/** One label resolver for every effect kind — mirrors MIX's chain cards. */
export function effectEntryLabel(entry: ChainEntry): string {
  if (entry.vst) return entry.vst.plugin_name;
  return EFFECT_LABELS[entry.effect] || getRackEffect(entry.effect)?.label || entry.label || entry.effect;
}

const entryKind = (entry: ChainEntry): 'vst' | 'gan' | 'fx' =>
  entry.vst ? 'vst' : entry.effect === 'ares' ? 'gan' : 'fx';

// ── Window store (module-scope; survives EDIT unmount) ───────────────────────

interface EffectWindowRec {
  entryId: string;
  scope: FxScope;
  z: number;
  /** Viewport px; null until first drag → cascaded default position. */
  x: number | null;
  y: number | null;
}

interface EffectWindowState {
  windows: EffectWindowRec[];
  topZ: number;
  /** The 'ares' entry currently driving the one app-wide gan session. */
  aresOwnerEntryId: string | null;
  aresOwnerScope: FxScope | null;
  open: (scope: FxScope, entryId: string) => void;
  close: (entryId: string) => void;
  bringToFront: (entryId: string) => void;
  move: (entryId: string, x: number, y: number) => void;
  setAresOwner: (scope: FxScope | null, entryId: string | null) => void;
}

export const useEffectWindowStore = create<EffectWindowState>((set, get) => ({
  windows: [],
  topZ: 80,
  aresOwnerEntryId: null,
  aresOwnerScope: null,
  open: (scope, entryId) => {
    const s = get();
    if (s.windows.some((w) => w.entryId === entryId)) {
      s.bringToFront(entryId);
      return;
    }
    set({
      windows: [...s.windows, { entryId, scope, z: s.topZ + 1, x: null, y: null }],
      topZ: s.topZ + 1,
    });
  },
  close: (entryId) => {
    const s = get();
    if (s.aresOwnerEntryId === entryId) {
      useGanStore.getState().close();
      set({ aresOwnerEntryId: null, aresOwnerScope: null });
    }
    const entry = findWindowEntry(entryId);
    if (entry?.vst && useVstEditorStore.getState().entryId === entryId) {
      useVstEditorStore.getState().close();
    }
    set({ windows: get().windows.filter((w) => w.entryId !== entryId) });
  },
  bringToFront: (entryId) => {
    const s = get();
    const win = s.windows.find((w) => w.entryId === entryId);
    if (!win || win.z === s.topZ) return;
    set({
      windows: s.windows.map((w) => (w.entryId === entryId ? { ...w, z: s.topZ + 1 } : w)),
      topZ: s.topZ + 1,
    });
  },
  move: (entryId, x, y) =>
    set({ windows: get().windows.map((w) => (w.entryId === entryId ? { ...w, x, y } : w)) }),
  setAresOwner: (scope, entryId) => set({ aresOwnerScope: scope, aresOwnerEntryId: entryId }),
}));

function findWindowEntry(entryId: string): ChainEntry | undefined {
  const win = useEffectWindowStore.getState().windows.find((w) => w.entryId === entryId);
  if (!win) return undefined;
  return chainForScope(win.scope).find((e) => e.id === entryId);
}

/** Make an 'ares' entry the surface's target: package/open the .gan and route
 *  its controls onto this entry (the bridge itself is registered by the Host). */
export function takeAresOwnership(scope: FxScope, entryId: string): void {
  useEffectWindowStore.getState().setAresOwner(scope, entryId);
  void (async () => {
    const gan = useGanStore.getState();
    if (!gan.plugins.some((p) => p.id === 'ares')) await gan.ensureAres();
    await useGanStore.getState().openById('ares');
  })();
}

/** The single entry point the FX lists use: open (or focus) the entry's
 *  window and kick the kind-specific session (native VST GUI / gan surface). */
export function openEffectWindow(
  scope: FxScope,
  entry: ChainEntry,
  openVst: (scope: FxScope, entry: ChainEntry) => void,
): void {
  useEffectWindowStore.getState().open(scope, entry.id);
  if (entry.vst) openVst(scope, entry);
  else if (entry.effect === 'ares') takeAresOwnership(scope, entry.id);
}

// ── Host props (WaveformEditor supplies its automation-aware param plumbing) ─

export interface EffectWindowsHostProps {
  writeParams: (scope: { kind: 'master' } | { kind: 'track'; trackId: string }, entryId: string, params: Record<string, number>) => void;
  displayParams: (scope: { kind: 'master' } | { kind: 'track'; trackId: string }, entryId: string) => Record<string, number> | undefined;
  openVst: (scope: FxScope, entry: ChainEntry) => void;
  projectBpm: number;
}

// ── Scope-aware chain mutations (shared by list + windows) ───────────────────

function removeEntry(scope: FxScope, entryId: string): void {
  const st = useEditorStore.getState();
  if (scope.kind === 'master') st.removeMasterEffect(entryId);
  else if (scope.kind === 'masterVst') st.removeMasterVst(entryId);
  else st.removeTrackEffect(scope.trackId, entryId);
  useEffectWindowStore.getState().close(entryId);
}

function toggleEntry(scope: FxScope, entryId: string): void {
  const st = useEditorStore.getState();
  if (scope.kind === 'master') st.toggleMasterEffect(entryId);
  else if (scope.kind === 'track') st.toggleTrackEffect(scope.trackId, entryId);
  // masterVst entries have no enable toggle (the frozen render applies all).
}

function reorderEntry(scope: FxScope, from: number, to: number): void {
  const st = useEditorStore.getState();
  if (scope.kind === 'master') st.reorderMasterEffect(from, to);
  else if (scope.kind === 'masterVst') st.reorderMasterVst(from, to);
  else st.reorderTrackEffect(scope.trackId, from, to);
}

// ── The floating window card ─────────────────────────────────────────────────

const KIND_TINT: Record<'vst' | 'gan' | 'fx', { border: string; text: string }> = {
  vst: { border: 'border-teal-500/30', text: 'text-teal-300' },
  gan: { border: 'border-indigo-500/30', text: 'text-indigo-300' },
  fx: { border: 'border-purple-500/30', text: 'text-purple-300' },
};

const EffectWindowCard: React.FC<{
  win: EffectWindowRec;
  index: number;
  host: EffectWindowsHostProps;
}> = ({ win, index, host }) => {
  // Subscribe to the owning chain so the window re-renders with param edits
  // and auto-closes when the entry (or its track) is removed elsewhere.
  const entry = useEditorStore((s) => {
    if (win.scope.kind === 'master') return s.masterFxChain.find((e) => e.id === win.entryId);
    if (win.scope.kind === 'masterVst') return s.masterVstChain.find((e) => e.id === win.entryId);
    return s.tracks.find((t) => t.id === (win.scope as { trackId: string }).trackId)?.fxChain?.find((e) => e.id === win.entryId);
  });
  const close = useEffectWindowStore((s) => s.close);
  const bringToFront = useEffectWindowStore((s) => s.bringToFront);
  const move = useEffectWindowStore((s) => s.move);
  const aresOwnerEntryId = useEffectWindowStore((s) => s.aresOwnerEntryId);

  const vstSessionEntryId = useVstEditorStore((s) => s.entryId);
  const vstSessionPath = useVstEditorStore((s) => s.pluginPath);
  const vstSessionName = useVstEditorStore((s) => s.pluginName);
  const vstSessionError = useVstEditorStore((s) => s.error);
  const vstSessionOwnerTab = useVstEditorStore((s) => s.ownerTab);
  const ganActiveUrl = useGanStore((s) => s.activeUrl);
  const ganActiveName = useGanStore((s) => s.activeName);

  // Natural VST editor size (CSS px) so the window fits the plugin.
  const [vstNatural, setVstNatural] = useState<{ w: number; h: number } | null>(null);
  const onVstNaturalSize = useCallback((w: number, h: number) => {
    setVstNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!entry) close(win.entryId);
  }, [entry, close, win.entryId]);
  if (!entry) return null;

  const kind = entryKind(entry);
  const tint = KIND_TINT[kind];
  const label = effectEntryLabel(entry);

  const vstOwnsSession = !!entry.vst && vstSessionEntryId === entry.id && vstSessionOwnerTab === 'edit' && !!vstSessionPath;
  const aresOwnsSession = kind === 'gan' && aresOwnerEntryId === entry.id && !!ganActiveUrl;

  // Sizing per kind (viewport px; the card is portaled outside the zoom).
  const size: React.CSSProperties =
    kind === 'vst'
      ? vstOwnsSession && vstNatural
        ? { width: `min(${vstNatural.w + 20}px, 92vw)`, height: `min(${vstNatural.h + 74}px, 85vh)` }
        : vstOwnsSession
          ? { width: 'min(640px, 92vw)', height: 'min(480px, 72vh)' }
          : { width: 'min(360px, 92vw)' }
      : kind === 'gan'
        ? aresOwnsSession
          ? { width: 'min(720px, 92vw)', height: 'min(520px, 72vh)' }
          : { width: 'min(360px, 92vw)' }
        : { width: 'min(380px, 92vw)', maxHeight: '70vh' };

  const defaultX = 110 + (index % 6) * 40;
  const defaultY = 96 + (index % 6) * 34;

  const startDrag = (e: React.PointerEvent) => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const w = el.offsetWidth;
      const x = Math.max(4, Math.min(window.innerWidth - Math.min(w, 160), ev.clientX - d.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 40, ev.clientY - d.dy));
      move(win.entryId, x, y);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const paramScope =
    win.scope.kind === 'track'
      ? ({ kind: 'track', trackId: win.scope.trackId } as const)
      : ({ kind: 'master' } as const);

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`${label} controls`}
      className={`fixed hardware-card bg-black/95 border ${tint.border} rounded-lg shadow-2xl flex flex-col overflow-hidden`}
      style={{ left: win.x ?? defaultX, top: win.y ?? defaultY, zIndex: win.z, ...size }}
      onMouseDown={() => bringToFront(win.entryId)}
    >
      {/* Title bar — the drag handle. Same chrome for every effect kind. */}
      <div
        className="flex items-center gap-2 border-b border-white/10 px-3 py-2 shrink-0 cursor-grab active:cursor-grabbing select-none"
        onPointerDown={startDrag}
      >
        {kind === 'vst' ? <Plug className={`w-3.5 h-3.5 ${tint.text}`} />
          : kind === 'gan' ? <Blocks className={`w-3.5 h-3.5 ${tint.text}`} />
            : <SlidersHorizontal className={`w-3.5 h-3.5 ${tint.text}`} />}
        <span className={`text-[10px] font-mono uppercase tracking-wider truncate ${tint.text}`}>{label}</span>
        {win.scope.kind !== 'masterVst' && kind !== 'vst' && (
          <button
            onClick={() => toggleEntry(win.scope, entry.id)}
            aria-pressed={entry.enabled}
            aria-label={entry.enabled ? `Bypass ${label}` : `Enable ${label}`}
            title={entry.enabled ? 'Bypass' : 'Enable'}
            className={`p-0.5 rounded ${entry.enabled ? 'text-emerald-300 hover:text-emerald-200' : 'text-zinc-600 hover:text-zinc-400'}`}
          >
            {entry.enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
          </button>
        )}
        <button
          onClick={() => close(win.entryId)}
          aria-label={`Close ${label} window`}
          className="ml-auto p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body — exactly what MIX's Effect Stage renders for this kind. */}
      {kind === 'vst' ? (
        vstOwnsSession ? (
          <div className="flex-1 min-h-0">
            <VstEmbedHost
              pluginPath={vstSessionPath!}
              pluginName={vstSessionName ?? label}
              error={vstSessionError ?? undefined}
              onClose={() => useVstEditorStore.getState().close()}
              onNaturalSize={onVstNaturalSize}
            />
          </div>
        ) : (
          <div className="p-4 flex flex-col items-center gap-2 text-center">
            <Plug className="w-5 h-5 text-teal-300/60" />
            <span className="text-[10px] font-mono text-zinc-400">
              {entry.vst?.raw_state ? 'Custom settings saved.' : 'Native editor closed.'}
            </span>
            <button
              onClick={() => host.openVst(win.scope, entry)}
              className="px-3 py-1.5 rounded border border-teal-500/40 bg-teal-500/15 text-teal-200 hover:bg-teal-500/25 text-[9px] font-black uppercase tracking-widest"
            >
              Open plugin GUI
            </button>
          </div>
        )
      ) : kind === 'gan' ? (
        aresOwnsSession ? (
          <div className="flex-1 min-h-0">
            <GanPluginStage url={ganActiveUrl} name={ganActiveName ?? label} />
          </div>
        ) : (
          <div className="p-4 flex flex-col items-center gap-2 text-center">
            <Blocks className="w-5 h-5 text-indigo-300/60" />
            <span className="text-[10px] font-mono text-zinc-400">
              {aresOwnerEntryId ? 'The surface is driving another Ares insert.' : 'Surface closed.'}
            </span>
            <button
              onClick={() => takeAresOwnership(win.scope, entry.id)}
              className="px-3 py-1.5 rounded border border-indigo-500/40 bg-indigo-500/15 text-indigo-200 hover:bg-indigo-500/25 text-[9px] font-black uppercase tracking-widest"
            >
              {aresOwnerEntryId ? 'Take over surface' : 'Open surface'}
            </button>
          </div>
        )
      ) : (
        <div className="p-2 overflow-y-auto min-h-0">
          <FxRack
            chain={[entry]}
            idPrefix={`fxwin-${entry.id}`}
            hideAdd
            onAdd={() => undefined}
            onRemove={(id) => removeEntry(win.scope, id)}
            onReorder={() => undefined}
            onToggle={(id) => toggleEntry(win.scope, id)}
            onUpdateParams={(id, p) => host.writeParams(paramScope, id, p)}
            projectBpm={host.projectBpm}
            displayParams={(id) => host.displayParams(paramScope, id)}
          />
        </div>
      )}
    </div>,
    document.body,
  );
};

// ── Host: renders every window + owns the Ares bridge ────────────────────────

export const EffectWindowsHost: React.FC<EffectWindowsHostProps> = (props) => {
  const windows = useEffectWindowStore((s) => s.windows);
  const aresOwnerEntryId = useEffectWindowStore((s) => s.aresOwnerEntryId);
  const aresOwnerScope = useEffectWindowStore((s) => s.aresOwnerScope);

  // While an EDIT entry owns the surface, EDIT owns the ONE app-wide Ares
  // bridge; releasing ownership lets MIX re-register on mount.
  useEffect(() => {
    if (!aresOwnerEntryId || !aresOwnerScope) return;
    const scope = aresOwnerScope;
    const entryId = aresOwnerEntryId;
    return registerAresBridge({
      getXyPadId: () => {
        const ares = useGanStore.getState().plugins.find((pl) => pl.id === 'ares');
        return ares?.controls.find((c) => c.name === 'ares_xy_kaoss_pad')?.id ?? ARES_XY_PAD_FALLBACK_ID;
      },
      findEntry: () => chainForScope(scope).find((e) => e.id === entryId) ?? null,
      updateParams: (id, params) => {
        const st = useEditorStore.getState();
        if (scope.kind === 'track') st.updateTrackEffectParams(scope.trackId, id, params);
        else st.updateMasterEffectParams(id, params);
      },
    });
  }, [aresOwnerEntryId, aresOwnerScope]);

  // EDIT unmounts on tab switch; the app-wide gan session must not stay bound
  // to an EDIT entry (it would hijack MIX's Effect Stage). Windows persist.
  useEffect(() => () => {
    const s = useEffectWindowStore.getState();
    if (s.aresOwnerEntryId) {
      useGanStore.getState().close();
      s.setAresOwner(null, null);
    }
  }, []);

  return (
    <>
      {windows.map((w, i) => (
        <EffectWindowCard key={w.entryId} win={w} index={i} host={props} />
      ))}
    </>
  );
};

// ── FxChainList: the compact unified chain rows + one add menu ───────────────

export interface FxChainListProps {
  scope: FxScope;
  /** Open (or focus) an entry's control window. */
  onOpenEntry: (scope: FxScope, entry: ChainEntry) => void;
  /** Add a built-in rack effect (undefined hides the rack-add select). */
  onAddEffect?: (effectId: string) => void;
  /** Add a VST3 (undefined hides the plugin browser). */
  onAddVst?: (plugin: Vst3PluginInfo) => void;
  vstPlugins?: Vst3PluginInfo[];
  vstScanning?: boolean;
  onRescanVst?: () => void;
  emptyHint?: string;
}

export const FxChainList: React.FC<FxChainListProps> = ({
  scope,
  onOpenEntry,
  onAddEffect,
  onAddVst,
  vstPlugins = [],
  vstScanning = false,
  onRescanVst,
  emptyHint = 'No effects yet — add one below.',
}) => {
  // Subscribe so rows live-update with the chain.
  const chain = useEditorStore((s) => {
    if (scope.kind === 'master') return s.masterFxChain;
    if (scope.kind === 'masterVst') return s.masterVstChain;
    return s.tracks.find((t) => t.id === scope.trackId)?.fxChain ?? [];
  });
  const openWindows = useEffectWindowStore((s) => s.windows);
  const [showVstBrowser, setShowVstBrowser] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      {chain.length === 0 ? (
        <p className="text-[9px] text-zinc-600 italic">{emptyHint}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {chain.map((entry, i) => {
            const kind = entryKind(entry);
            const tint = KIND_TINT[kind];
            const isOpen = openWindows.some((w) => w.entryId === entry.id);
            return (
              <div
                key={entry.id}
                className={`flex items-center gap-1.5 rounded border px-1.5 py-1 transition-colors ${
                  isOpen ? 'border-purple-500/40 bg-purple-500/10' : 'border-white/5 bg-black/40 hover:bg-white/5'
                }`}
              >
                {scope.kind !== 'masterVst' && (
                  <button
                    onClick={() => toggleEntry(scope, entry.id)}
                    aria-pressed={entry.enabled}
                    aria-label={entry.enabled ? `Bypass ${effectEntryLabel(entry)}` : `Enable ${effectEntryLabel(entry)}`}
                    title={entry.enabled ? 'Bypass' : 'Enable'}
                    className={`w-2.5 h-2.5 rounded-full shrink-0 border ${
                      entry.enabled
                        ? 'bg-purple-400 border-purple-300 shadow-[0_0_6px_rgba(192,132,252,0.7)]'
                        : 'bg-transparent border-zinc-600'
                    }`}
                  />
                )}
                {/* Row body — clicking opens the entry's control window. */}
                <button
                  onClick={() => onOpenEntry(scope, entry)}
                  title={`Open ${effectEntryLabel(entry)} controls`}
                  className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                >
                  <span className="flex-1 min-w-0 text-[9px] font-mono text-zinc-200 truncate">
                    {effectEntryLabel(entry)}
                  </span>
                  <span className={`shrink-0 text-[7px] font-black uppercase tracking-widest px-1 rounded border ${tint.border} ${tint.text} bg-black/40`}>
                    {kind === 'vst' ? 'VST' : kind === 'gan' ? 'GAN' : 'FX'}
                  </span>
                </button>
                <button
                  onClick={() => reorderEntry(scope, i, i - 1)}
                  disabled={i === 0}
                  aria-label="Move up"
                  className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-30 shrink-0"
                >
                  <ChevronUp className="w-3 h-3" />
                </button>
                <button
                  onClick={() => reorderEntry(scope, i, i + 1)}
                  disabled={i === chain.length - 1}
                  aria-label="Move down"
                  className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-30 shrink-0"
                >
                  <ChevronDown className="w-3 h-3" />
                </button>
                <button
                  onClick={() => removeEntry(scope, entry.id)}
                  aria-label={`Remove ${effectEntryLabel(entry)}`}
                  className="p-0.5 text-zinc-500 hover:text-red-300 shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ONE add area: built-ins and VSTs together, no separate sections. */}
      {(onAddEffect || onAddVst) && (
        <div className="flex flex-col gap-1 border-t border-white/10 pt-1.5">
          <div className="flex items-center gap-1.5">
            {onAddEffect && (
              <select
                value=""
                aria-label="Add effect"
                onChange={(e) => {
                  if (e.target.value) onAddEffect(e.target.value);
                  e.target.value = '';
                }}
                className="form-select flex-1 min-w-0 px-1.5 py-1 text-[10px]"
              >
                <option value="">+ Add effect…</option>
                {RACK_EFFECTS.map((def) => (
                  <option key={def.id} value={def.id}>{def.label}</option>
                ))}
              </select>
            )}
            {onAddVst && (
              <button
                onClick={() => setShowVstBrowser((v) => !v)}
                aria-pressed={showVstBrowser}
                title="Add a VST3 plugin"
                className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border text-[9px] font-black uppercase tracking-widest transition-colors ${
                  showVstBrowser ? 'border-teal-500/40 bg-teal-500/15 text-teal-200' : 'border-white/10 text-zinc-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Plug className="w-3 h-3" /> VST
              </button>
            )}
          </div>
          {onAddVst && showVstBrowser && (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center justify-between">
                <span className="mono-label">Plugins ({vstPlugins.length})</span>
                {onRescanVst && (
                  <button
                    onClick={onRescanVst}
                    disabled={vstScanning}
                    className="btn-ghost inline-flex items-center gap-1 disabled:opacity-40"
                    title="Rescan VST3 folders"
                  >
                    {vstScanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  </button>
                )}
              </div>
              {vstPlugins.length === 0 ? (
                <p className="text-[8px] font-mono text-zinc-600 leading-relaxed">
                  {vstScanning ? 'Scanning…' : 'No VST3 plugins found. Set your plugin folders in Settings, then rescan.'}
                </p>
              ) : (
                <div className="max-h-32 overflow-y-auto flex flex-col gap-0.5">
                  {vstPlugins.map((pl) => {
                    const inChain = chain.some((e) => e.vst?.plugin_path === pl.path);
                    return (
                      <button
                        key={pl.path}
                        onClick={() => onAddVst(pl)}
                        title={inChain ? `Open ${pl.name} controls` : `Insert ${pl.name}`}
                        className={`flex items-center gap-1.5 text-left px-1.5 py-1 rounded text-[9px] font-mono truncate transition-colors border ${
                          inChain ? 'bg-teal-500/15 text-teal-300 border-teal-500/30' : 'text-zinc-400 hover:bg-white/5 hover:text-white border-transparent'
                        }`}
                      >
                        <Plug className="w-3 h-3 text-teal-300 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{pl.name}</span>
                        {!inChain && <Plus className="w-3 h-3 text-zinc-500 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
