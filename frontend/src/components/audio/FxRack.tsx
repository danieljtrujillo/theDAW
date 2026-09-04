/**
 * FxRack — UI for a real-time insert-effect chain (the psychoacoustic rack).
 *
 * Presentational + a11y only: it renders the add control, per-effect enable /
 * reorder / remove, and each effect's controls (a bespoke pad/panel where one
 * exists, else the schema-driven EffectControls panel), and calls back into the
 * store. The same component drives the master bus (Phase A), per-track chains
 * (Phase B), DRAW's chain and the EDIT floating windows; the caller supplies the
 * chain array and the mutators.
 */

import { Blocks, ChevronUp, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { RACK_EFFECTS, getRackEffect } from '../../lib/rackEffects';
import type { ChainEntry } from '../../state/effectChainStore';
import { SpatializerPad } from './SpatializerPad';
import { OwlPad } from './OwlPad';
import { ChopControls } from './ChopControls';
import { GaterControls } from './GaterControls';
import { EffectControls, type EffectControlsLayout } from './effects/EffectControls';
import { schemaForBackendEffect, schemaForRackEffect } from './effects/effectSchema';

interface FxRackProps {
  chain: ChainEntry[];
  /** Stable prefix for input ids (must be unique per rack instance). */
  idPrefix: string;
  onAdd: (effectId: string) => void;
  onRemove: (entryId: string) => void;
  onReorder: (from: number, to: number) => void;
  onToggle: (entryId: string) => void;
  onUpdateParams: (entryId: string, params: Record<string, number>) => void;
  /** Project tempo, forwarded to the Gater's tempo-sync controls. */
  projectBpm?: number;
  /** During playback, returns the automation-sampled param overrides for an entry
   *  at the current playhead, so a control's displayed value follows its lane.
   *  Display-only: edits still write the stored params. */
  displayParams?: (entryId: string) => Record<string, number> | undefined;
  /** Hide the built-in "+ Add effect" select (the caller supplies its own add UI,
   *  e.g. DRAW's colored effect palette). The chain rows still render. */
  hideAdd?: boolean;
  /** When provided, VST entries get a GUI-open button that (re)opens the
   *  plugin's native editor (teal once a captured raw_state is stored). Absent
   *  (e.g. DRAW), VST tiles stay inert exactly as before. */
  onOpenVst?: (entry: ChainEntry) => void;
  /** When provided, the 'ares' composite entry gets an open-surface button
   *  that opens its .gan control surface. */
  onOpenSurface?: (entry: ChainEntry) => void;
  /** Control-panel density for the schema-driven tiles: `compact` (default)
   *  for rails and racks, `expanded` for floating windows / stages. */
  layout?: EffectControlsLayout;
}

export function FxRack({
  chain,
  idPrefix,
  onAdd,
  onRemove,
  onReorder,
  onToggle,
  onUpdateParams,
  projectBpm,
  displayParams,
  hideAdd,
  onOpenVst,
  onOpenSurface,
  layout = 'compact',
}: FxRackProps) {
  const addId = `${idPrefix}-add`;
  const expanded = layout === 'expanded';

  return (
    <div className="flex flex-col gap-2">
      {!hideAdd && (
        <div className="flex items-center gap-2">
          <label htmlFor={addId} className="sr-only">Add insert effect</label>
          <select
            id={addId}
            name={addId}
            value=""
            onChange={(e) => {
              if (e.target.value) onAdd(e.target.value);
            }}
            className="form-select px-2 py-1 text-[11px] font-mono"
            style={{ colorScheme: 'dark' }}
            title="Add a psychoacoustic insert effect to this chain"
          >
            <option value="">+ Add effect…</option>
            {RACK_EFFECTS.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
          {chain.length === 0 && (
            <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-wider">no inserts</span>
          )}
        </div>
      )}

      {/* Effects tile and wrap (capped width) so they use horizontal space
          instead of one full-width column of stretched sliders. */}
      <div className="flex flex-wrap gap-2 items-start">
      {chain.map((entry, i) => {
        const def = getRackEffect(entry.effect);
        // Entries with no live rack definition are imported VST3 plugins or a
        // source-DAW effect theDAW preserves but can't render live per-track.
        // Show them as a labelled, inert tile (toggle/remove) so nothing is
        // hidden; they stay out of the live audio graph (buildEffectChain skips
        // anything not in the rack).
        if (!def) {
          const label = entry.vst?.plugin_name || entry.label || entry.effect;
          // A preserved source-DAW device that maps onto a backend effect id
          // (lofi_vinyl, pitch_shift, …) has a real parameter schema: show
          // its controls (edits persist with the project) with an honest note
          // that the track does not render it live.
          const preserved = entry.vst ? null : schemaForBackendEffect(entry.effect, 'preserved');
          if (preserved) {
            return (
              <div
                key={entry.id}
                className={`${expanded ? 'grow basis-full' : 'grow basis-60 max-w-xs'} rounded border border-white/5 bg-black/30 p-2 flex flex-col gap-1.5`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] font-black uppercase tracking-wider text-amber-300/80 shrink-0">IMP</span>
                  <span className="text-[10px] font-mono text-zinc-300 flex-1 truncate" title={`${label} — preserved from import (not rendered live on this track yet)`}>
                    {label}
                  </span>
                  <button
                    onClick={() => onRemove(entry.id)}
                    aria-label={`Remove ${label}`}
                    title="Remove this imported effect"
                    className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                <div className="pl-1">
                  <EffectControls
                    schema={preserved}
                    params={entry.params}
                    idPrefix={`${idPrefix}-${entry.id}`}
                    layout={layout}
                    hideHeader
                    onChange={(p) => onUpdateParams(entry.id, p)}
                  />
                </div>
              </div>
            );
          }
          return (
            <div
              key={entry.id}
              className="grow basis-60 max-w-xs rounded border border-white/5 bg-black/30 p-2 flex items-center gap-1.5 opacity-60"
            >
              <span className="text-[8px] font-black uppercase tracking-wider text-amber-300/80 shrink-0">
                {entry.effect === 'vst3' ? 'VST' : 'IMP'}
              </span>
              <span
                className="text-[10px] font-mono text-zinc-300 flex-1 truncate"
                title={`${label} — preserved from import (not rendered live on this track yet)`}
              >
                {label}
              </span>
              {entry.vst && onOpenVst && (
                <button
                  onClick={() => onOpenVst(entry)}
                  aria-label={`Open ${label} plugin GUI`}
                  title={entry.vst.raw_state ? 'Edit plugin GUI (custom settings saved)' : "Open the plugin's native GUI"}
                  className={`p-0.5 rounded hover:bg-white/5 shrink-0 ${entry.vst.raw_state ? 'text-teal-400 hover:text-teal-300' : 'text-zinc-500 hover:text-teal-300'}`}
                >
                  <SlidersHorizontal className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={() => onRemove(entry.id)}
                aria-label={`Remove ${label}`}
                title="Remove this imported effect"
                className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        }
        // While a lane plays back, show the sampled value so the control follows
        // the automation; edits still write the stored params (onUpdateParams).
        const shown = displayParams ? { ...entry.params, ...(displayParams(entry.id) ?? {}) } : entry.params;
        const sizing = expanded
          ? 'grow basis-full'
          : entry.effect === 'spatializer' || entry.effect === 'ares' || entry.effect === 'kargyraa'
            ? 'grow basis-80 max-w-md'
            : 'grow basis-60 max-w-xs';
        return (
          <div
            key={entry.id}
            className={`${sizing} rounded border border-white/5 bg-black/30 p-2 flex flex-col gap-1.5 transition-opacity ${entry.enabled ? '' : 'opacity-50'}`}
          >
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onToggle(entry.id)}
                aria-pressed={entry.enabled}
                aria-label={`${def.label} ${entry.enabled ? 'enabled' : 'bypassed'}`}
                title={entry.enabled ? 'Bypass this effect' : 'Enable this effect'}
                className={`w-2.5 h-2.5 rounded-full shrink-0 transition-colors ${entry.enabled ? 'bg-purple-400' : 'bg-zinc-700'}`}
              />
              <span className="text-[10px] font-mono text-zinc-200 flex-1 truncate" title={def.description}>
                {def.label}
              </span>
              {entry.effect === 'ares' && onOpenSurface && (
                <button
                  onClick={() => onOpenSurface(entry)}
                  aria-label="Open the Ares control surface"
                  title="Open the Ares control surface"
                  className="p-0.5 rounded text-zinc-500 hover:text-indigo-300 hover:bg-white/5 shrink-0"
                >
                  <Blocks className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={() => onReorder(i, i - 1)}
                disabled={i === 0}
                aria-label={`Move ${def.label} earlier`}
                title="Move earlier in the chain"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-20 disabled:pointer-events-none"
              >
                <ChevronUp className="w-3 h-3" />
              </button>
              <button
                onClick={() => onReorder(i, i + 1)}
                disabled={i === chain.length - 1}
                aria-label={`Move ${def.label} later`}
                title="Move later in the chain"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/5 disabled:opacity-20 disabled:pointer-events-none"
              >
                <ChevronDown className="w-3 h-3" />
              </button>
              <button
                onClick={() => onRemove(entry.id)}
                aria-label={`Remove ${def.label}`}
                title="Remove this effect"
                className="p-0.5 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {entry.effect === 'spatializer' ? (
              <div className="pl-4">
                <SpatializerPad
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                />
              </div>
            ) : entry.effect === 'owlpad' ? (
              <div className="pl-4">
                <OwlPad
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                />
              </div>
            ) : entry.effect === 'chop' ? (
              <div className="pl-4">
                <ChopControls
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                />
              </div>
            ) : entry.effect === 'gater' ? (
              <div className="pl-4">
                <GaterControls
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  projectBpm={projectBpm}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                />
              </div>
            ) : (
              /* Every other effect (and Ares while its surface is closed):
                 the schema-driven panel — grouped knobs/sliders/toggles/
                 selects, XY pads, presets, mix, units, double-click reset. */
              <div className="pl-4">
                <EffectControls
                  schema={schemaForRackEffect(def)}
                  params={entry.params}
                  display={displayParams?.(entry.id)}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  layout={layout}
                  hideHeader
                  onChange={(p) => onUpdateParams(entry.id, p)}
                />
              </div>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
