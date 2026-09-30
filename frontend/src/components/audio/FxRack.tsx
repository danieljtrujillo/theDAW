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

import { Blocks, ChevronUp, ChevronDown, RotateCw, SlidersHorizontal, X } from 'lucide-react';
import { RACK_EFFECTS, getRackEffect } from '../../lib/rackEffects';
import { liveVstStatus } from '../../lib/sabSupport';
import { vstEntryName } from '../../state/vstEditorStore';
import { entryLatencySec, useVstLiveStore, type VstLiveEntryState } from '../../state/vstLiveStore';
import { vstSessions } from '../../lib/vstLive/sessionRegistry';
import type { ChainEntry } from '../../state/effectChainStore';
import { liveBadge } from './fxRackBadge';

/** Reconnect an entry's live plugin host now instead of waiting out the
 *  client's backoff. The session object is the rack's to reach: it is keyed by
 *  `ChainEntry.id`, which is exactly what this row already has. */
const retryLiveVst = (entry: ChainEntry): void => vstSessions.retry(entry.id);
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
  /** The gesture boundary of an entry's panel — every panel the rack renders
   *  reports one: the bespoke ones (spatializer / owlpad / chop / gater) and the
   *  schema-driven EffectControls alike. One start before the first
   *  `onUpdateParams` of a drag / key press / wheel burst on that entry's
   *  surface, one end after its last; the end may carry no change at all. The
   *  boundary is per ENTRY, not per param key, because one surface writes
   *  several keys (an OWL-Pad drag moves x and y). Absent, a consumer recording
   *  a gesture falls back to its own deadline. See lib/gestureTracker.ts. */
  onParamsGestureStart?: (entryId: string) => void;
  onParamsGestureEnd?: (entryId: string) => void;
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
  /** Override the retry the error badge offers. Absent, the row reconnects the
   *  entry's own live session, which is what every caller wants — the prop is
   *  here for a host that owns the session differently. */
  onRetryVst?: (entry: ChainEntry) => void;
}

/* ── live VST status badge ──────────────────────────────────────────────────
   One `vst3` row's live state, rendered from vstLiveStore. Plain text, not a
   control, except for the retry — so it carries no label and needs none; the
   retry is a real <button> with its own aria-label. */

interface VstBadge {
  text: string;
  title: string;
  /** Full-sentence explanation for assistive tech. Rendered as a visually
   *  hidden sibling of the pill, not as `aria-label` on it: the pill is a
   *  plain <span>, whose implicit ARIA role is `generic`, and `aria-label` is
   *  prohibited on `generic` (axe-core aria-prohibited-attr). */
  label: string;
  /** Tailwind classes for the pill. */
  tone: string;
}

/** What the row says, given the entry's session state and the host's status. */
export function vstLiveBadge(
  live: VstLiveEntryState | undefined,
  host: { available: boolean | null; reason: string },
): VstBadge {
  const status = live?.status ?? 'off';
  const usingDefaults = status === 'live' && live?.stateOrigin === 'state-rejected';
  // The pill's short text (and a generic `label` sentence for assistive tech)
  // live in fxRackBadge.ts so the pill can't regress back into a whole
  // sentence; `title` below stays the rich, entry-specific explanation for the
  // mouse. `label` is carried on `VstBadge` and rendered as a visually hidden
  // sibling at the call site, so shortening the pill never costs assistive
  // tech the story the old long pill text used to carry.
  const { text, label } = liveBadge(status, usingDefaults);
  if (usingDefaults) {
    // The plugin IS processing — but at its factory defaults, because the HOST
    // reported that it could not restore this entry's saved state. Every saved
    // state is sent, whichever editor wrote it, so this is a real failure of
    // this plugin with this blob, not a category of state we decline to try.
    // Saying "LIVE · 4.2 ms" here would be a lie by omission: the user would
    // hear something their saved settings do not describe, with no way to know
    // why. The blob is NOT thrown away — the render still uses it — so the
    // honest offer is: re-dial it live, or leave it for the render.
    const why = live?.stateReason ?? 'the plugin refused the saved state';
    return {
      text,
      title: `${why} — open the GUI and re-dial, or keep the saved settings for render only`,
      label,
      tone: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
    };
  }
  if (status === 'live') {
    const ms = entryLatencySec(live) * 1000;
    const clamped = live?.clamped ? ' · latency exceeds compensation' : '';
    return {
      text: `${text} · ${ms.toFixed(1)} ms`,
      title:
        `${live?.plugin?.name ?? 'plugin'} is processing this signal live — ` +
        `${ms.toFixed(1)} ms of latency, compensated by the mixer${clamped}`,
      label,
      tone: live?.clamped
        ? 'border-amber-400/40 bg-amber-400/10 text-amber-300'
        : 'border-teal-400/40 bg-teal-400/10 text-teal-300',
    };
  }
  if (status === 'starting') {
    return {
      text,
      title: 'opening the plugin host — the signal passes through untouched until it is ready',
      label,
      tone: 'border-sky-400/30 bg-sky-400/10 text-sky-300/80',
    };
  }
  if (status === 'error') {
    const why = live?.reason ?? 'the plugin host stopped';
    return {
      text,
      title: `${why} — the signal passes through untouched; reconnecting`,
      label,
      tone: 'border-red-400/40 bg-red-400/10 text-red-300',
    };
  }
  // 'off' and 'unavailable' are the same thing to a listener: the plugin only
  // prints at freeze/bounce. The reason differs, so the title does.
  return {
    text,
    title: `${live?.reason ?? host.reason} — this plugin applies at freeze/bounce, not live`,
    label,
    tone: 'border-amber-400/30 bg-amber-400/10 text-amber-300/70',
  };
}

export function FxRack({
  chain,
  idPrefix,
  onAdd,
  onRemove,
  onReorder,
  onToggle,
  onUpdateParams,
  onParamsGestureStart,
  onParamsGestureEnd,
  projectBpm,
  displayParams,
  hideAdd,
  onOpenVst,
  onOpenSurface,
  layout = 'compact',
  onRetryVst,
}: FxRackProps) {
  const addId = `${idPrefix}-add`;
  const expanded = layout === 'expanded';
  // Whether this machine can host plugins at all. SUBSCRIBED, not read once:
  // the answer starts as "not probed yet" and the first chain build resolves
  // it, so a row rendered before the probe has to re-render after it.
  const vstStatus = liveVstStatus(useVstLiveStore((s) => s.host));
  // Per-entry session state. One subscription for the whole rack, so a row is
  // not a separate store listener.
  const vstLive = useVstLiveStore((s) => s.entries);

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
            className="form-select px-2 py-1 font-sans text-xs font-bold"
            style={{ colorScheme: 'dark' }}
            title="Add a psychoacoustic insert effect to this chain"
          >
            <option value="">+ Add effect…</option>
            {RACK_EFFECTS.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
          {chain.length === 0 && (
            <span className="font-display text-xs font-bold text-zinc-500 uppercase tracking-wider">no inserts</span>
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
          // A VST row is named after the PLUGIN, never after the hosting
          // format: falling through to `entry.effect` would label it 'vst3',
          // which names the library that loads it rather than the effect.
          const label = entry.vst
            ? vstEntryName(entry.vst.plugin_name, entry.vst.plugin_path)
            : entry.label || entry.effect;
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
                  <span className="font-display text-xs font-bold uppercase tracking-wider text-amber-300/80 shrink-0">IMP</span>
                  <span className="font-sans text-xs font-bold text-zinc-300 flex-1 truncate" title={`${label} — preserved from import (not rendered live on this track yet)`}>
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
                    onGestureStart={onParamsGestureStart && (() => onParamsGestureStart(entry.id))}
                    onGestureEnd={onParamsGestureEnd && (() => onParamsGestureEnd(entry.id))}
                  />
                </div>
              </div>
            );
          }
          // A hosted plugin that is actually processing is not a dimmed,
          // preserved artefact — it is part of the sound. Only the rows that
          // really do nothing live keep the faded treatment.
          const vstSounding = entry.effect === 'vst3' && vstLive[entry.id]?.status === 'live';
          return (
            <div
              key={entry.id}
              className={`grow basis-60 max-w-xs rounded border bg-black/30 p-2 flex items-center gap-1.5 ${
                vstSounding ? 'border-teal-400/20' : 'border-white/5 opacity-60'
              }`}
            >
              <span
                className={`font-display text-xs font-bold uppercase tracking-wider shrink-0 ${
                  vstSounding ? 'text-teal-300/80' : 'text-amber-300/80'
                }`}
              >
                {entry.effect === 'vst3' ? 'VST' : 'IMP'}
              </span>
              <span
                className="font-sans text-xs font-bold text-zinc-300 flex-1 truncate"
                title={
                  vstSounding
                    ? `${label} — hosted live on this track`
                    : `${label} — preserved from import (not rendered live on this track yet)`
                }
              >
                {label}
              </span>
              {/* What this plugin is doing to the signal RIGHT NOW: processing
                  it live (with the latency the mixer is compensating), opening,
                  failed, or render-only. Plain text, not a control, so there is
                  no wrapping <label> — but a <span> is role="generic", and
                  aria-label is prohibited on generic (axe-core
                  aria-prohibited-attr), so the full sentence for assistive
                  tech renders as a sr-only sibling instead; `title` still
                  carries it for the mouse. The retry beside it IS a control
                  and carries its own accessible name. */}
              {entry.effect === 'vst3' && (() => {
                const live = vstLive[entry.id];
                const badge = vstLiveBadge(live, vstStatus);
                return (
                  <>
                    <span
                      title={badge.title}
                      className={`shrink-0 rounded-sm border px-1 py-px font-sans text-[10px] font-bold uppercase tracking-wide ${badge.tone}`}
                    >
                      {badge.text}
                    </span>
                    <span className="sr-only">{badge.label}</span>
                    {(live?.xruns ?? 0) > 0 && (
                      <span
                        title={`${live?.xruns} audio block${live?.xruns === 1 ? '' : 's'} arrived too late to play and were dropped — the plugin is not keeping up`}
                        className="shrink-0 rounded-sm border border-amber-400/30 bg-amber-400/10 px-1 py-px font-mono text-[10px] font-bold text-amber-300/80"
                      >
                        {live?.xruns} xrun
                      </span>
                    )}
                    {live?.status === 'error' && (
                      <button
                        onClick={() => (onRetryVst ?? retryLiveVst)(entry)}
                        aria-label={`Retry the live plugin host for ${label}`}
                        title={`Retry: ${live.reason ?? 'the plugin host stopped'}`}
                        className="p-0.5 rounded text-red-300 hover:text-red-200 hover:bg-red-500/10 shrink-0"
                      >
                        <RotateCw className="w-3 h-3" />
                      </button>
                    )}
                  </>
                );
              })()}
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
              <span className="font-sans text-xs font-bold text-zinc-200 flex-1 truncate" title={def.description}>
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
                  onGestureStart={onParamsGestureStart && (() => onParamsGestureStart(entry.id))}
                  onGestureEnd={onParamsGestureEnd && (() => onParamsGestureEnd(entry.id))}
                />
              </div>
            ) : entry.effect === 'owlpad' ? (
              <div className="pl-4">
                <OwlPad
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                  onGestureStart={onParamsGestureStart && (() => onParamsGestureStart(entry.id))}
                  onGestureEnd={onParamsGestureEnd && (() => onParamsGestureEnd(entry.id))}
                />
              </div>
            ) : entry.effect === 'chop' ? (
              <div className="pl-4">
                <ChopControls
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                  onGestureStart={onParamsGestureStart && (() => onParamsGestureStart(entry.id))}
                  onGestureEnd={onParamsGestureEnd && (() => onParamsGestureEnd(entry.id))}
                />
              </div>
            ) : entry.effect === 'gater' ? (
              <div className="pl-4">
                <GaterControls
                  params={shown}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  projectBpm={projectBpm}
                  onChange={(p) => onUpdateParams(entry.id, p)}
                  onGestureStart={onParamsGestureStart && (() => onParamsGestureStart(entry.id))}
                  onGestureEnd={onParamsGestureEnd && (() => onParamsGestureEnd(entry.id))}
                />
              </div>
            ) : (
              /* Every other effect (and Ares while its surface is closed):
                 the schema-driven panel — grouped knobs/sliders/toggles/
                 selects, XY pads, presets, mix, units, double-click reset. It
                 reports the same per-entry gesture boundary as the bespoke
                 panels, so a rack knob's automation pass ends on release. */
              <div className="pl-4">
                <EffectControls
                  schema={schemaForRackEffect(def)}
                  params={entry.params}
                  display={displayParams?.(entry.id)}
                  idPrefix={`${idPrefix}-${entry.id}`}
                  layout={layout}
                  hideHeader
                  onChange={(p) => onUpdateParams(entry.id, p)}
                  onGestureStart={onParamsGestureStart && (() => onParamsGestureStart(entry.id))}
                  onGestureEnd={onParamsGestureEnd && (() => onParamsGestureEnd(entry.id))}
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
