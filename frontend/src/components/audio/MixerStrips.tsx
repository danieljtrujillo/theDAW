/**
 * MixerStrips — the mixer drawer: one strip per track, one per bus, plus the
 * master.
 *
 * Batch 6 gave the document a real routing graph (`editorStore.routing`,
 * `editorStore.buses`) and wired the LIVE mixer to it, but nothing in the UI
 * called any of it: there was no way to make a bus, point a track at one, or
 * ride a send. This drawer is that surface. It deliberately does NOT touch the
 * EDIT timeline's track-header column — the header stays the lane's controls
 * (name, arm, mute, solo, FX, fader, pan) and the drawer is where SIGNAL FLOW
 * lives, which is also the only place a bus can have a strip at all.
 *
 * Ownership rules this file obeys:
 *  - No document state is mirrored into React state. Every strip reads the
 *    store and writes through the store's actions; the only local state is the
 *    drawer's own open/height and a two-click delete arm, neither of which is
 *    part of the document.
 *  - Master volume has ONE owner, `playbackStore` (the footer's fader and the
 *    engine's master gain both already read it). The master strip binds that
 *    same pair — it does not introduce a second master level.
 *  - Feedback is refused at the MODEL boundary (`routingGraph.wouldCycle`), so
 *    an option that would close a loop is disabled here rather than offered and
 *    then rejected. A refusal that still gets through — the store is the only
 *    authority — is surfaced as a notice rather than swallowed.
 *
 * Ardour's mixer strip (`gtk2_ardour/mixer_strip.cc`, GPL-2.0-or-later) is
 * cited only for the CONVENTIONAL control order — name, output, sends, fader,
 * mute/solo — that every DAW user already has muscle memory for. It was not
 * read and not copied while writing this file; no code, snippet or comment from
 * it or from any other reference DAW is present here.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, SlidersHorizontal, Volume2, VolumeX, X } from 'lucide-react';
import {
  beginUndoStep,
  useEditorStore,
  type EditorBus,
} from '../../state/editorStore';
import {
  CONN_OUTPUT,
  CONN_SIDECHAIN,
  MASTER_ID,
  outputOf,
  sendsFrom,
  wouldCycle,
  type RoutingGraph,
  type RoutingRefusal,
} from '../../state/routingGraph';
import { usePlaybackStore } from '../../state/playbackStore';
import { disposeMeter, ensureMeter, sampleChannelLevels } from '../../state/levelsStore';
import {
  disposeStripMeters,
  ensureStripMeters,
  sampleStripLevels,
} from '../../state/stripMeters';
import { requireFeature } from '../../notices/featureGateStore';
import { BarMeter, dbToNorm, fmtLevel } from './levels/meterModel';
import { SlideTrack } from './SlideTrack';
import { FxChainList, openEffectWindow, openVstEditorForScope, type FxScope } from './EffectWindows';
import { PopoverPortal } from './PopoverPortal';
import { useVstStore } from '../../state/vstStore';
import type { ChainEntry } from '../../state/effectChainStore';
import type { Vst3PluginInfo } from '../../lib/vstClient';

/* ────────────────────────────────────────────────────────────────────────────
   Model helpers — pure, exported for MixerStrips.test.ts. Nothing below this
   block may derive a list in JSX; the two things that silently rot (an offered
   option that would feed back, a send row that disagrees with the graph) are
   computed here and tested without React.
   ──────────────────────────────────────────────────────────────────────────── */

/** One entry of an output / send-target `<select>`. */
export interface RoutePickOption {
  id: string;
  label: string;
  /** True when choosing it would be refused; `title` says why. */
  disabled: boolean;
  title?: string;
}

/** One send leaving a node, as the drawer renders it. */
export interface SendRow {
  /** Destination node id — the row's identity, since one send exists per pair. */
  to: string;
  label: string;
  gain: number;
}

/**
 * The strips `nodeId` KEYS: the display name of every node one of its
 * `CONN_SIDECHAIN` edges lands on, deduplicated and in edge order.
 *
 * Pure and exported for the same reason `outputOptions` and `sendRows` are —
 * nothing in the JSX below may derive a list — though unlike those two it has no
 * test of its own: `MixerStrips.test.ts` is outside this ticket's write set, so
 * this is covered by the typechecker and by the model beneath it and nothing
 * more. It is one filter and a `Set` for exactly that reason.
 */
export function keyTargetNames(
  graph: RoutingGraph,
  buses: readonly EditorBus[],
  nodeId: string,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const e of graph.edges) {
    if (e.connType !== CONN_SIDECHAIN || e.from !== nodeId || seen.has(e.to)) continue;
    seen.add(e.to);
    names.push(nodeLabel(graph, buses, e.to));
  }
  return names;
}

/** A node's display name: its bus strip's if it has one, else the graph node's. */
function nodeLabel(graph: RoutingGraph, buses: readonly EditorBus[], id: string): string {
  if (id === MASTER_ID) return 'Master';
  const strip = buses.find((b) => b.id === id);
  if (strip) return strip.name;
  return graph.nodes.find((n) => n.id === id)?.name ?? id;
}

/**
 * The output picker's entries for `fromId`: the master, then every bus except
 * `fromId` itself.
 *
 * The cycle probe runs on the graph with `fromId`'s EXISTING output edge
 * removed, because that is exactly what `routingGraph.setOutput` does before it
 * checks — without it a node's own current output would report as a loop and
 * the user would find the option they are already using greyed out.
 *
 * A current output pointing at a node with NO bus strip (a drifted or
 * hand-edited project file — `validateGraph` reports it, but the mixer still
 * has to draw) is appended as a disabled "(missing bus)" entry, so the
 * `<select>` always owns the value it is parked on instead of rendering blank.
 */
export function outputOptions(
  graph: RoutingGraph,
  buses: readonly EditorBus[],
  fromId: string,
): RoutePickOption[] {
  const probe: RoutingGraph = {
    nodes: graph.nodes,
    edges: graph.edges.filter((e) => !(e.from === fromId && e.connType === CONN_OUTPUT)),
  };
  const fromName = nodeLabel(graph, buses, fromId);
  const entry = (id: string): RoutePickOption => {
    const label = nodeLabel(graph, buses, id);
    if (!wouldCycle(probe, fromId, id)) return { id, label, disabled: false };
    return {
      id,
      label,
      disabled: true,
      title: `${label} already feeds ${fromName}, so this would loop back on itself`,
    };
  };
  const options = [entry(MASTER_ID), ...buses.filter((b) => b.id !== fromId).map((b) => entry(b.id))];
  const current = outputOf(graph, fromId);
  if (current !== null && !options.some((o) => o.id === current)) {
    options.push({
      id: current,
      label: `${nodeLabel(graph, buses, current)} (missing bus)`,
      disabled: true,
      title: 'This output points at a bus that has no strip — pick another destination',
    });
  }
  return options;
}

/** Every send leaving `fromId`, in graph order, labelled and carrying its gain. */
export function sendRowsFor(
  graph: RoutingGraph,
  buses: readonly EditorBus[],
  fromId: string,
): SendRow[] {
  return sendsFrom(graph, fromId).map((e) => ({
    to: e.to,
    label: nodeLabel(graph, buses, e.to),
    gain: e.gain,
  }));
}

/**
 * Candidate destinations for a NEW send from `fromId`.
 *
 * There is deliberately no retarget: an existing send's destination is fixed,
 * because moving it would be `removeSend` + `addSend` — two undo steps passing
 * through a state the user never asked for, and the store has no transaction to
 * fuse them. Removing the send and adding another is one honest step each.
 */
export function sendTargetOptions(
  graph: RoutingGraph,
  buses: readonly EditorBus[],
  fromId: string,
): RoutePickOption[] {
  const taken = new Set(sendsFrom(graph, fromId).map((e) => e.to));
  const fromName = nodeLabel(graph, buses, fromId);
  return buses
    .filter((b) => b.id !== fromId)
    .map((b) => {
      if (taken.has(b.id)) {
        return { id: b.id, label: b.name, disabled: true, title: `${fromName} already sends to ${b.name}` };
      }
      if (wouldCycle(graph, fromId, b.id)) {
        return {
          id: b.id,
          label: b.name,
          disabled: true,
          title: `${b.name} already feeds ${fromName}, so this would loop back on itself`,
        };
      }
      return { id: b.id, label: b.name, disabled: false };
    });
}

/** The name the store itself would pick for the next bus. */
export function nextBusName(buses: readonly EditorBus[]): string {
  return `Bus ${buses.length + 1}`;
}

/** A sentence for every refusal the routing actions can return. */
export function refusalMessage(reason: RoutingRefusal): string {
  switch (reason) {
    case 'cycle':
      return 'That connection would feed the signal back into itself, which silences the whole path.';
    case 'missing-node':
      return 'One end of that connection no longer exists — reopen the mixer and try again.';
    case 'master-output':
      return 'The master is the end of the chain; it cannot be routed anywhere else.';
    case 'duplicate':
      return 'That connection is already there.';
    case 'missing-entry':
      return 'That connection needs an effect to key, and none was named.';
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   The drawer
   ──────────────────────────────────────────────────────────────────────────── */

const STRIP =
  'shrink-0 w-44 rounded-lg border border-white/10 bg-black/30 p-2 flex flex-col gap-2';
const SELECT =
  'w-full rounded-md bg-white/5 border border-white/10 px-1 py-0.5 text-xs text-zinc-300 hover:text-white focus:outline-hidden focus:ring-1 focus:ring-[rgb(var(--et-accent))]';
const MINI_BTN =
  'w-4 h-4 rounded font-display text-xs font-bold leading-none flex items-center justify-center border';
const OFF_BTN = 'bg-black/40 text-zinc-500 border-white/5 hover:text-white';

/**
 * "KEY → <strip>" on a strip whose output is keying a sidechain effect somewhere
 * else, and nothing at all on one that is not.
 *
 * ON THE SOURCE STRIP, pointing at the destination. A key is the one connection
 * a mixer cannot show with a fader: it leaves the strip, it is set from a
 * window buried in another lane's rack, and it is inaudible on this strip. The
 * arrow points the way the signal goes, which is the same direction the output
 * picker and the send rows above it read.
 *
 * Static text, no control: a `<span>` with a `title`, so there is no label or
 * ARIA relationship to get wrong (CLAUDE.md rule 3 is about controls). The key
 * is EDITED where it is owned — the effect's own window — and duplicating that
 * choice here would be a second owner of one piece of document state.
 */
const KeyBadge: React.FC<{
  graph: RoutingGraph;
  buses: readonly EditorBus[];
  nodeId: string;
  name: string;
}> = ({ graph, buses, nodeId, name }) => {
  const targets = keyTargetNames(graph, buses, nodeId);
  if (targets.length === 0) return null;
  const list = targets.join(', ');
  return (
    <span
      className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 font-display text-xs font-bold uppercase tracking-wider text-amber-300 truncate"
      title={`${name} keys a sidechain effect on ${list}`}
    >
      {`KEY → ${list}`}
    </span>
  );
};

/**
 * The bus name — a real, always-editable native `<input>` bound straight to
 * `updateBus`, matching the track header's own name field
 * (`WaveformEditor.tsx`'s `#editor-track-name-<id>` input): the store
 * supported renaming a bus (`editorStore.ts:831`) since batch 6, but nothing
 * in this drawer ever called it, so a bus was stuck with whatever name
 * `addBus` gave it. `updateBus` records no undo step of its own (see its
 * doc comment) — same as a fader ride, a rename coalesces under the 300 ms
 * window rather than cutting one step per keystroke.
 *
 * Exported so it can be rendered and driven in isolation
 * (`MixerStrips.b12.test.tsx`) without mounting the whole drawer, which pulls
 * in the strip meters' AudioContext taps.
 */
export const BusNameField: React.FC<{
  busId: string;
  name: string;
  onRename: (name: string) => void;
}> = ({ busId, name, onRename }) => {
  // Local draft rather than a fully-controlled `value={name}`: the user must
  // be able to select-all and delete while typing a replacement without the
  // field being yanked back to the last COMMITTED name on every keystroke.
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    setDraft(name);
  }, [name]);

  return (
    <>
      <label htmlFor={`mixer-bus-name-${busId}`} className="sr-only">{`Bus ${name} name`}</label>
      <input
        id={`mixer-bus-name-${busId}`}
        name={`mixerBusName-${busId}`}
        type="text"
        value={draft}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          // `editorStore.updateBus` treats a falsy `name` as "no rename" for
          // the ROUTING GRAPH, but unconditionally spreads `updates` onto the
          // strip object regardless — so writing an empty/whitespace value
          // through would blank the strip while the routing picker kept
          // showing the OLD name. Never let the two disagree: only a real
          // name reaches the store.
          if (next.trim()) onRename(next);
        }}
        onBlur={() => {
          // Left blank: snap the FIELD back to the committed name — nothing
          // was ever written through for an empty value, so there is nothing
          // to undo, only a local display to correct.
          if (!draft.trim()) setDraft(name);
        }}
        title={name}
        className="min-w-0 flex-1 truncate rounded bg-transparent px-1 -mx-1 text-xs font-bold text-purple-200 outline-hidden hover:bg-white/5 focus:bg-white/5"
      />
    </>
  );
};

/** Surface a refusal on the app's notice stack. */
function toastRefusal(what: string, reason: RoutingRefusal): void {
  requireFeature({
    id: 'routing:refused',
    kind: 'error',
    title: `${what} was refused`,
    message: refusalMessage(reason),
    autoDismissMs: 6000,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
   Strip meters

   Until now the only thing metered in this app was the post-sum master, which
   can say that something is loud but never WHICH strip. `state/stripMeters`
   publishes one reading per live strip, tapped off the end of that strip's own
   chain (see that file for why it has to be the end); the drawer turns those
   readings into bars.

   ONE rAF loop for the whole drawer, owned by `MixerStrips`, writing widths
   straight onto the DOM. Not one loop per strip, and not React state: a mixer
   with twenty strips would otherwise re-render the entire drawer sixty times a
   second, and every fader, select and send row in it.
   ──────────────────────────────────────────────────────────────────────────── */

/** ~60 fps ceiling, as in the Levels panel — a 120 Hz display would otherwise
 *  paint twice as often for no visible gain. */
const MAX_FPS_INTERVAL_MS = 1000 / 60 - 1;
/** ARIA is refreshed 10x a second, not 60. `role="meter"` is not a live region
 *  so nothing is announced either way, but rewriting two attributes per strip
 *  per frame is DOM churn for a number no reader can follow at that rate. */
const ARIA_INTERVAL_MS = 100;

/** The two bars one strip paints, plus its root (which carries the ARIA value). */
interface StripMeterEls {
  root: HTMLDivElement;
  fill: HTMLElement;
  tick: HTMLElement;
}

/** Every mounted strip meter, keyed by strip id: written by the components,
 *  read by the single paint loop in `MixerStrips`. */
type StripMeterRegistry = React.RefObject<Map<string, StripMeterEls>>;

/**
 * One strip's meter: an RMS fill for the body of the signal and a thin peak
 * tick, so a strip that is clipping reads before the fill catches up.
 *
 * Presentational and inert. It renders once, registers its three elements, and
 * never re-renders — the drawer's loop writes the widths onto the DOM directly,
 * so a moving meter costs no React work and cannot re-render the controls
 * underneath it.
 *
 * Rule 3: a meter is a CUSTOM control, so it carries `role="meter"` with its own
 * `aria-label` and value attributes and is never wrapped in a `<label>` (a
 * `<label>` does not associate with a non-native control). The shape and the
 * classes are the take meter's from `WaveformEditor.tsx`'s `TrackInputMeter`, so
 * the two meters in this app read as the same object.
 */
const StripMeter: React.FC<{
  stripId: string;
  name: string;
  registry: StripMeterRegistry;
}> = ({ stripId, name, registry }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLElement>(null);
  const tickRef = useRef<HTMLElement>(null);

  // A stable effect rather than inline `ref` callbacks: an inline arrow is a new
  // function identity on every render, so React would detach and re-attach every
  // strip's elements on each keystroke of a fader ride — the same reason the
  // focus effect further down queries the container instead.
  useEffect(() => {
    const map = registry.current;
    const root = rootRef.current;
    const fill = fillRef.current;
    const tick = tickRef.current;
    if (!map || !root || !fill || !tick) return;
    map.set(stripId, { root, fill, tick });
    return () => {
      map.delete(stripId);
    };
  }, [registry, stripId]);

  return (
    <div
      ref={rootRef}
      role="meter"
      aria-label={`${name} level`}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={0}
      aria-valuetext="-∞ dBFS"
      className="relative h-1 w-full overflow-hidden rounded-xs bg-white/10"
    >
      <i ref={fillRef} className="absolute inset-y-0 left-0 block bg-red-500/60" style={{ width: '0%' }} />
      <i ref={tickRef} className="absolute inset-y-0 w-0.5 bg-red-400" style={{ left: 'calc(0% - 1px)' }} />
    </div>
  );
};

/** Volume fader + mute, shared by the track, bus and master strips. */
const LevelRow: React.FC<{
  name: string;
  volume: number;
  max: number;
  step: number;
  defaultValue: number;
  muted: boolean;
  onVolume: (v: number) => void;
  onMute: () => void;
}> = ({ name, volume, max, step, defaultValue, muted, onVolume, onMute }) => (
  <div className="flex items-center gap-1.5">
    <button
      type="button"
      onClick={onMute}
      aria-label={`Mute ${name}`}
      aria-pressed={muted}
      title={muted ? 'Unmute' : 'Mute'}
      className={`${MINI_BTN} ${muted ? 'bg-red-500/20 text-red-400 border-red-500/50' : OFF_BTN}`}
    >
      {muted ? <VolumeX className="w-2.5 h-2.5" /> : <Volume2 className="w-2.5 h-2.5" />}
    </button>
    <SlideTrack
      min={0}
      max={max}
      step={step}
      defaultValue={defaultValue}
      value={volume}
      onChange={onVolume}
      className="flex-1"
      ariaLabel={`${name} volume`}
    />
  </div>
);

/** The output `<select>` — a native control, so a real id/name + `<label htmlFor>`. */
const OutputPicker: React.FC<{
  nodeId: string;
  name: string;
  options: RoutePickOption[];
  value: string;
  onPick: (toId: string) => void;
}> = ({ nodeId, name, options, value, onPick }) => (
  <div>
    <label htmlFor={`mixer-out-${nodeId}`} className="sr-only">{`${name} output`}</label>
    <select
      id={`mixer-out-${nodeId}`}
      name={`mixerOut-${nodeId}`}
      value={value}
      onChange={(e) => onPick(e.target.value)}
      title={`Where ${name} sends its main output`}
      className={SELECT}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id} disabled={o.disabled} title={o.title}>
          {o.disabled ? `${o.label} (loops)` : o.label}
        </option>
      ))}
    </select>
  </div>
);

/**
 * A bus's insert rack: the FX key on its strip and the rack it opens, the same
 * list every EDIT rack uses (built-in effects, VST3s, the Ares surface), so a
 * bus takes a VST3 exactly as a track does: add it from the scan, open its own
 * editor, bypass, reorder, remove. Live, the bus strip hosts it; a freeze and
 * every export print it at its place in the bus chain.
 */
export const BusFxRack: React.FC<{ bus: EditorBus }> = ({ bus }) => {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const keyRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const addBusEffect = useEditorStore((s) => s.addBusEffect);
  const addBusVst = useEditorStore((s) => s.addBusVst);
  const vstPlugins = useVstStore((s) => s.plugins);
  const vstScanning = useVstStore((s) => s.scanning);
  const scanVst = useVstStore((s) => s.scan);
  const scope: FxScope = { kind: 'bus', busId: bus.id };
  const panelId = `mixer-bus-fx-${bus.id}`;
  const open = at !== null;

  // Escape, or a press outside the rack, its key and every effect window it
  // opened (each is a dialog of its own), closes the rack.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setAt(null);
      keyRef.current?.focus({ preventScroll: true });
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (panelRef.current?.contains(t) || keyRef.current?.contains(t)) return;
      if (t.closest?.('[role="dialog"]')) return;
      setAt(null);
    };
    const timer = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown);
    }, 0);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openEntry = (sc: FxScope, entry: ChainEntry, origin?: { x: number; y: number }) =>
    openEffectWindow(sc, entry, openVstEditorForScope, origin);

  // Clicking a plugin in the browser inserts it once and opens it; one already
  // on the bus is opened, not added again (EDIT's track rack does the same).
  const addAndOpenVst = (pl: Vst3PluginInfo) => {
    const chainOf = (): ChainEntry[] => useEditorStore.getState().buses.find((b) => b.id === bus.id)?.fxChain ?? [];
    let entry = chainOf().find((e) => e.vst?.plugin_path === pl.path);
    if (!entry) {
      addBusVst(bus.id, { plugin_path: pl.path, plugin_name: pl.name });
      entry = [...chainOf()].reverse().find((e) => e.vst?.plugin_path === pl.path);
    }
    if (entry) openEntry(scope, entry);
  };

  const count = bus.fxChain.length;
  return (
    <>
      <button
        ref={keyRef}
        type="button"
        onClick={() => {
          if (open) { setAt(null); return; }
          const r = keyRef.current?.getBoundingClientRect();
          setAt(r ? { x: Math.round(r.left), y: Math.round(r.bottom) + 4 } : { x: 16, y: 96 });
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${bus.name} inserts${count ? `, ${count}` : ''}`}
        title="The bus's insert rack: built-in effects and VST3 plugins"
        className={`flex items-center justify-center gap-1 rounded-md border px-1.5 py-0.5 font-display text-xs font-bold uppercase tracking-wider ${
          open || count > 0
            ? 'border-purple-500/40 bg-purple-500/15 text-purple-200'
            : 'border-white/10 bg-white/5 text-zinc-400 hover:text-white'
        }`}
      >
        <SlidersHorizontal className="w-3 h-3" />
        FX{count > 0 ? ` ${count}` : ''}
      </button>
      {at && (
        <PopoverPortal
          x={at.x}
          y={at.y}
          innerRef={panelRef}
          maxHeight="70vh"
          className="fixed z-50 w-72 hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3"
        >
          <div id={panelId} role="dialog" aria-label={`${bus.name} inserts`} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400 truncate">
                Bus FX · <span className="text-purple-200">{bus.name}</span>
              </span>
              <button
                type="button"
                onClick={() => setAt(null)}
                aria-label={`Close ${bus.name} inserts`}
                title="Close"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <FxChainList
              scope={scope}
              onOpenEntry={openEntry}
              onAddEffect={(effectId) => addBusEffect(bus.id, effectId)}
              onAddVst={addAndOpenVst}
              vstPlugins={vstPlugins}
              vstScanning={vstScanning}
              onRescanVst={() => void scanVst(true)}
              emptyHint="No inserts on this bus yet — add one below."
            />
          </div>
        </PopoverPortal>
      )}
    </>
  );
};

/** The send list for one node: a destination picker + a gain fader per send. */
const SendList: React.FC<{
  graph: RoutingGraph;
  buses: readonly EditorBus[];
  nodeId: string;
  name: string;
}> = ({ graph, buses, nodeId, name }) => {
  const addSend = useEditorStore((s) => s.addSend);
  const setSendGain = useEditorStore((s) => s.setSendGain);
  const removeSend = useEditorStore((s) => s.removeSend);
  // True between a fader's gesture start and end, so every change inside the
  // ride folds into the one undo step the gesture start cut.
  const ridingRef = useRef(false);

  const rows = useMemo(() => sendRowsFor(graph, buses, nodeId), [graph, buses, nodeId]);
  const fresh = useMemo(() => sendTargetOptions(graph, buses, nodeId), [graph, buses, nodeId]);
  const firstFree = fresh.find((o) => !o.disabled);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400">sends</span>
        <button
          type="button"
          onClick={() => {
            if (!firstFree) return;
            const refusal = addSend(nodeId, firstFree.id, 0.5);
            if (refusal) toastRefusal('That send', refusal);
          }}
          disabled={!firstFree}
          aria-label={`Add a send from ${name}`}
          title={firstFree ? `Send ${name} to ${firstFree.label}` : 'No bus left to send to'}
          className={`${MINI_BTN} ${OFF_BTN} disabled:opacity-40`}
        >
          <Plus className="w-2.5 h-2.5" />
        </button>
      </div>
      {rows.map((row, i) => (
          <div key={row.to} className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <label htmlFor={`mixer-send-${nodeId}-${i}`} className="sr-only">
                {`${name} send ${i + 1} destination`}
              </label>
              {/* A send's destination is FIXED once made: moving it would be a
                  remove + an add, two undo steps through a state the user never
                  asked for. The control stays a labelled native select so the
                  row reads as "destination: <bus>", it is simply not editable —
                  remove the send and add another to change where it goes. */}
              <select
                id={`mixer-send-${nodeId}-${i}`}
                name={`mixerSend-${nodeId}-${i}`}
                value={row.to}
                disabled
                title="A send's destination is fixed — remove it and add another to change it"
                className={`${SELECT} flex-1 disabled:opacity-100`}
              >
                <option value={row.to}>{row.label}</option>
              </select>
              <button
                type="button"
                onClick={() => removeSend(nodeId, row.to)}
                aria-label={`Remove the send from ${name} to ${row.label}`}
                title="Remove this send"
                className={`${MINI_BTN} ${OFF_BTN} hover:text-red-400`}
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
            <SlideTrack
              min={0}
              max={1}
              step={0.01}
              defaultValue={0.5}
              value={row.gain}
              onGestureStart={() => {
                beginUndoStep();
                ridingRef.current = true;
              }}
              onGestureEnd={() => {
                ridingRef.current = false;
              }}
              onChange={(v) => setSendGain(nodeId, row.to, v, { coalesce: ridingRef.current })}
              className="w-full"
              ariaLabel={`Send to ${row.label} level`}
            />
          </div>
      ))}
    </div>
  );
};

export const MixerStrips: React.FC = () => {
  const tracks = useEditorStore((s) => s.tracks);
  const buses = useEditorStore((s) => s.buses);
  const routing = useEditorStore((s) => s.routing);
  const updateTrack = useEditorStore((s) => s.updateTrack);
  const toggleSolo = useEditorStore((s) => s.toggleSolo);
  const updateBus = useEditorStore((s) => s.updateBus);
  const addBus = useEditorStore((s) => s.addBus);
  const removeBus = useEditorStore((s) => s.removeBus);
  const setTrackOutput = useEditorStore((s) => s.setTrackOutput);

  // Master level: playbackStore is the one owner (the footer fader and the
  // engine's master gain already read it). This strip binds that same pair.
  const masterVolume = usePlaybackStore((s) => s.volume);
  const setMasterVolume = usePlaybackStore((s) => s.setVolume);
  const masterMuted = usePlaybackStore((s) => s.muted);
  const toggleMasterMute = usePlaybackStore((s) => s.toggleMute);

  // Local UI only — never the document. `armedDelete` is the two-click confirm
  // (this app has no confirm dialog component); `focusBusId` moves focus onto
  // the strip a fresh "Add bus" just created.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [focusBusId, setFocusBusId] = useState<string | null>(null);
  const stripsRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // Every mounted meter's elements. The drawer is only rendered while it is
  // open, so this map's life is the drawer's.
  const meterEls = useRef(new Map<string, StripMeterEls>());

  // Hold the two taps for as long as the drawer is open. Both are refcounted:
  // `ensureMeter` is the Levels tab's own master tap, so opening and closing the
  // drawer over a live Levels panel must not detach it out from under the panel
  // — and reusing it is also why there is no second analyser on the master.
  //
  // WHAT THE MASTER HOLD COSTS, since it is not only a bar. `ensureMeter`
  // constructs the audio engine if it is not up yet (`levelsStore.setup` ->
  // `playerStore.getEngineCtx`) and attaches the BS.1770 worklet, so opening the
  // drawer STARTS the master meter's LUFS / true-peak integration and keeps it
  // running for as long as the drawer is open. Closing it releases this hold,
  // and if nothing else holds one (no Levels panel open) `levelsStore.disposeMeter`
  // detaches the tap and calls `clearHolds` — which resets the max true-peak and
  // max sample-peak readouts and empties the 60 s short-term history. Opening
  // the Levels tab afterwards therefore starts from a clean integration, not
  // from whatever the drawer accumulated.
  useEffect(() => {
    ensureStripMeters();
    // Async because it may be loading the LUFS worklet. A rejection means the
    // master bar simply sits at silence; the Levels tab is the place that
    // explains why, and the strip bars are unaffected.
    ensureMeter().catch(() => { /* master bar stays at silence */ });
    return () => {
      disposeStripMeters();
      disposeMeter();
    };
  }, []);

  // THE drawer's paint loop. One rAF for every strip, no React state, no store
  // writes: it reads both taps once per frame, advances one `BarMeter` per strip
  // and writes the two widths onto that strip's elements.
  useEffect(() => {
    const els = meterEls.current;
    /** Ballistics per strip — created on first sight, dropped with the strip. */
    const bars = new Map<string, BarMeter>();
    let raf = 0;
    let lastPaint = 0;
    let lastAria = 0;
    let docVisible = typeof document === 'undefined' ? true : !document.hidden;

    const paint = (el: StripMeterEls, bar: BarMeter, aria: boolean): void => {
      const peak = dbToNorm(bar.peakDb);
      el.fill.style.width = `${dbToNorm(bar.rmsDb) * 100}%`;
      el.tick.style.left = `calc(${peak * 100}% - 1px)`;
      if (!aria) return;
      el.root.setAttribute('aria-valuenow', peak.toFixed(3));
      el.root.setAttribute('aria-valuetext', `${fmtLevel(bar.peakDb)} dBFS`);
    };

    const frame = (now: number): void => {
      raf = 0;
      if (!docVisible) return; // paused; the visibility handler restarts it
      raf = requestAnimationFrame(frame);
      if (now - lastPaint < MAX_FPS_INTERVAL_MS) return;
      // Clamped so a frame the browser skipped (a tab that came back, a long
      // task) cannot jump the ballistics; seeded at one frame on the first pass.
      const dt = lastPaint ? Math.min(0.1, (now - lastPaint) / 1000) : 1 / 60;
      lastPaint = now;
      const aria = now - lastAria >= ARIA_INTERVAL_MS;
      if (aria) lastAria = now;

      const strips = sampleStripLevels();
      const master = sampleChannelLevels();

      for (const id of bars.keys()) if (!els.has(id)) bars.delete(id);
      for (const [id, el] of els) {
        let bar = bars.get(id);
        if (!bar) {
          bar = new BarMeter();
          bars.set(id, bar);
        }
        if (id === MASTER_ID) {
          // The master tap is per-channel: show the louder channel's peak over
          // the stereo RMS, the same fold `levelsStore.getLevelsFrame` uses.
          if (master) {
            const rms = Math.sqrt((master.rmsL * master.rmsL + master.rmsR * master.rmsR) * 0.5);
            bar.update(Math.max(master.peakL, master.peakR), rms, dt);
          } else {
            bar.update(0, 0, dt);
          }
        } else {
          // No reading is metered as silence ON PURPOSE: a strip whose session
          // was disposed, or one that has never played, falls away at the normal
          // rate instead of freezing at whatever it last showed.
          const lv = strips?.get(id);
          if (lv) bar.update(lv.peak, lv.rms, dt);
          else bar.update(0, 0, dt);
        }
        paint(el, bar, aria);
      }
    };

    const start = (): void => {
      if (!raf && docVisible) {
        lastPaint = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    const onVisibility = (): void => {
      docVisible = !document.hidden;
      start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const route = (fromId: string, toId: string) => {
    const refusal = setTrackOutput(fromId, toId);
    if (refusal) toastRefusal('That output', refusal);
  };

  // Focus the new bus's output picker once it is in the DOM. One effect on the
  // scroll container rather than an inline `ref` callback per strip: an inline
  // arrow is a new function identity every render, so React would detach and
  // re-attach every bus strip's ref on each keystroke of a fader ride.
  useEffect(() => {
    if (!focusBusId) return;
    stripsRef.current
      ?.querySelector<HTMLSelectElement>(`#mixer-out-${CSS.escape(focusBusId)}`)
      ?.focus();
    setFocusBusId(null);
  }, [focusBusId]);

  // The armed delete must not sit there forever, and the button that arms it
  // unmounts — so focus is moved onto `Confirm` (which is rendered to the RIGHT
  // of the cancel control, never under the pointer that just clicked) and the
  // arming expires on its own after 5s. `onBlur` on the strip de-arms as soon
  // as focus leaves it entirely.
  useEffect(() => {
    if (!armedDelete) return;
    confirmRef.current?.focus();
    const t = setTimeout(() => setArmedDelete(null), 5000);
    return () => clearTimeout(t);
  }, [armedDelete]);

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      {/* The §3.6 step-3 divergence note stood here while the live mixer
          followed the routing graph and the offline bounce did not. T14 gave
          `lib/renderCore` the same `wireRoutingGraph` pass, so buses and sends
          now print exactly as they play and there is nothing to warn about. */}
      <div ref={stripsRef} className="flex-1 min-h-0 flex gap-2 overflow-x-auto overflow-y-hidden pb-1">
        {tracks.map((t) => (
          <div key={t.id} className={STRIP}>
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-xs font-bold" style={{ color: t.color }} title={t.name}>
                {t.name}
              </span>
              {/* Solo only. Mute lives on `LevelRow` below, next to the fader
                  it belongs with — two mute buttons on one strip would make a
                  screen reader enumerate the same control twice. */}
              <div className="flex gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => toggleSolo(t.id)}
                  aria-label={`Solo track ${t.name}`}
                  aria-pressed={t.solo}
                  className={`${MINI_BTN} ${t.solo ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50' : OFF_BTN}`}
                >
                  S
                </button>
              </div>
            </div>
            <OutputPicker
              nodeId={t.id}
              name={t.name}
              options={outputOptions(routing, buses, t.id)}
              value={outputOf(routing, t.id) ?? MASTER_ID}
              onPick={(toId) => route(t.id, toId)}
            />
            <SendList graph={routing} buses={buses} nodeId={t.id} name={t.name} />
            <KeyBadge graph={routing} buses={buses} nodeId={t.id} name={t.name} />
            {/* Above the fader, below the sends: the bar reads the END of the
                strip, so it already includes everything the controls above it
                do and the fader right under it moves it. */}
            <StripMeter stripId={t.id} name={t.name} registry={meterEls} />
            <LevelRow
              name={t.name}
              volume={t.volume}
              max={1}
              step={0.01}
              defaultValue={0.8}
              muted={t.mute}
              onVolume={(v) => updateTrack(t.id, { volume: v })}
              onMute={() => updateTrack(t.id, { mute: !t.mute })}
            />
          </div>
        ))}

        {buses.map((b) => (
          <div
            key={b.id}
            // Focus leaving the strip entirely cancels an armed delete, so an
            // armed strip the user walked away from cannot be confirmed later
            // by a stray Enter.
            onBlur={(e) => {
              if (armedDelete !== b.id) return;
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setArmedDelete(null);
            }}
            className={`${STRIP} border-purple-500/25`}
          >
            <div className="flex items-center justify-between gap-1">
              <BusNameField busId={b.id} name={b.name} onRename={(next) => updateBus(b.id, { name: next })} />
              {armedDelete === b.id ? (
                // Cancel sits where the × was — under the pointer that just
                // clicked — and Confirm is to its RIGHT, so a fast double-click
                // cancels rather than deletes.
                <div className="flex gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setArmedDelete(null)}
                    aria-label={`Keep bus ${b.name}`}
                    title="Keep this bus"
                    className={`${MINI_BTN} ${OFF_BTN}`}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                  <button
                    ref={confirmRef}
                    type="button"
                    onClick={() => {
                      setArmedDelete(null);
                      removeBus(b.id);
                    }}
                    aria-label={`Confirm removing bus ${b.name}`}
                    title="Everything feeding it goes back to the master"
                    className="rounded border border-red-500/50 bg-red-500/20 px-1 text-xs font-bold text-red-300"
                  >
                    Confirm
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setArmedDelete(b.id)}
                  aria-label={`Remove bus ${b.name}`}
                  title="Remove this bus"
                  className={`${MINI_BTN} ${OFF_BTN} shrink-0 hover:text-red-400`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
            {/* Announced when the strip arms — the button that was clicked has
                unmounted by then, so nothing else would say what happened. */}
            <span aria-live="polite" className="sr-only">
              {armedDelete === b.id ? `Remove ${b.name}? Confirm or cancel` : ''}
            </span>
            {/* The inserts come first, as the signal meets them: rack, then fader, then out. */}
            <BusFxRack bus={b} />
            <OutputPicker
              nodeId={b.id}
              name={b.name}
              options={outputOptions(routing, buses, b.id)}
              value={outputOf(routing, b.id) ?? MASTER_ID}
              onPick={(toId) => route(b.id, toId)}
            />
            {/* A bus is a legal key source too — the model treats its output
                like any other node's — so the badge is on both kinds of strip. */}
            <KeyBadge graph={routing} buses={buses} nodeId={b.id} name={b.name} />
            <StripMeter stripId={b.id} name={b.name} registry={meterEls} />
            <LevelRow
              name={b.name}
              volume={b.volume}
              max={1}
              step={0.01}
              defaultValue={0.8}
              muted={b.mute}
              onVolume={(v) => updateBus(b.id, { volume: v })}
              onMute={() => updateBus(b.id, { mute: !b.mute })}
            />
          </div>
        ))}

        <div className={`${STRIP} border-[rgb(var(--et-accent))]/40`}>
          <span className="truncate text-xs font-bold text-zinc-200">Master</span>
          <p className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400">end of chain</p>
          {/* The master reuses the Levels tab's existing post-sum tap rather
              than hanging a second analyser on the same signal — which is also
              why both taps are refcounted. */}
          <StripMeter stripId={MASTER_ID} name="Master" registry={meterEls} />
          <LevelRow
            name="Master"
            volume={masterVolume}
            max={100}
            step={1}
            defaultValue={75}
            muted={masterMuted}
            onVolume={setMasterVolume}
            onMute={toggleMasterMute}
          />
        </div>

        <button
          type="button"
          onClick={() => setFocusBusId(addBus(nextBusName(buses)))}
          aria-label="Add bus"
          title="Add a mix bus"
          className="shrink-0 w-10 rounded-lg border border-dashed border-white/15 text-zinc-500 hover:text-white hover:border-white/30 flex items-center justify-center"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default MixerStrips;
