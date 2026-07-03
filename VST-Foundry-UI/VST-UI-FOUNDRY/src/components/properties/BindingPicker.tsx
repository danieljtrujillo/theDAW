/**
 * BindingPicker — the modulation-routing panel for a Foundry control.
 *
 * Rebuilt from the old single-dropdown binder into a full modulation STACK:
 * one control can drive MANY destinations at once — theDAW functions (dest
 * "daw") and other canvas layers (dest "element", e.g. knob → Label readout,
 * XY axis → two knobs, anything → Meter). It has two views inside the Bind tab:
 *
 *   VIEW A (stack)   — the list of routes this control owns. Each route is a
 *                      compact card: destination + a live amount slider, with an
 *                      expander for response curve, output range, and (for XY
 *                      sources) the source axis. Legacy single-target bindings
 *                      (targetId / xTargetId / yTargetId) render as read-only
 *                      cards with a one-click "convert to route".
 *   VIEW B (browser) — a searchable, grouped picker of everything this control
 *                      can route to: theDAW targets by area, then OTHER canvas
 *                      elements by compatible property.
 *
 * Display types (Meter / Waveform) have no outbound stack — they keep the
 * simple LISTEN source select (they are driven BY a target's live value).
 *
 * All shaping math + the compatibility maps live in src/lib/routing.ts; the
 * theDAW manifest comes from the live bus via useDawBindings().
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Plus, Search, X } from "lucide-react";
import { useDawBindings } from "../../hooks/useDawBindings";
import type { DawTarget } from "../../lib/dawControlBus";
import {
  bindableKindsFor,
  customCodeBindableParams,
  customCodeParamKinds,
  isWritableTarget,
  listenKindsFor,
} from "../../lib/dawControlBus";
import {
  elementDestProps,
  isRouteSource,
  newRouteId,
  sourceAxesFor,
} from "../../lib/routing";
import {
  getVstBind,
  vstListenBinds,
  vstWriteBinds,
  type VstBindTarget,
} from "../../lib/vstBinds";
import type {
  CustomParam,
  ElementBinding,
  ElementRoute,
  ElementType,
  RouteCurve,
  UIElement,
} from "../../types";
import { SelectField } from "./fields";
import type { UpdateElementsFn } from "./useElementField";

type Axis = "value" | "x" | "y";

interface BindingPickerProps {
  element: UIElement;
  /** All canvas elements — the element-destination browser lists the others. */
  elements: UIElement[];
  onUpdateElements: UpdateElementsFn;
  /** Render the built-in header + boxed frame. Default true. */
  showHeader?: boolean;
}

const NUM_CLS =
  "w-full bg-app-base border border-app-border rounded px-1.5 py-1 text-[11px] text-app-main outline-none focus:border-app-accent disabled:opacity-50";

/** Deterministic per-area hue so each theDAW area reads as its own colour dot. */
function areaTint(area: string): string {
  let h = 0;
  for (let i = 0; i < area.length; i++) h = (h * 31 + area.charCodeAt(i)) % 360;
  return `hsl(${h} 68% 55%)`;
}

export default function BindingPicker({
  element,
  elements,
  onUpdateElements,
  showHeader = true,
}: BindingPickerProps) {
  const { connected, targets } = useDawBindings();

  // CustomCode binds theDAW targets PER numeric param (el.paramBindings), not
  // through the element-level routing stack — handled by its own picker.
  if (element.type === "CustomCode") {
    const bindableParams = customCodeBindableParams(element);
    if (bindableParams.length === 0) return null;
    const ccInner = (
      <CustomParamBindingPicker
        element={element}
        params={bindableParams}
        onUpdateElements={onUpdateElements}
        targets={targets}
        connected={connected}
      />
    );
    if (!showHeader) return ccInner;
    return (
      <div className="space-y-2 bg-app-base p-2 rounded border border-app-border">
        <div className="text-[9px] text-app-muted uppercase tracking-wider font-bold">
          theDAW Binding
        </div>
        {ccInner}
      </div>
    );
  }

  const routeSource = isRouteSource(element.type);
  const listenKinds = listenKindsFor(element.type);
  // Neither a modulation source nor a listening display — nothing to render.
  if (!routeSource && listenKinds === null) return null;

  const inner = routeSource ? (
    <RoutingStack
      element={element}
      elements={elements}
      onUpdateElements={onUpdateElements}
      targets={targets}
      connected={connected}
    />
  ) : (
    <ListenPicker
      element={element}
      onUpdateElements={onUpdateElements}
      targets={targets}
      connected={connected}
      listenKinds={listenKinds!}
    />
  );

  if (!showHeader) return inner;

  return (
    <div className="space-y-2 bg-app-base p-2 rounded border border-app-border">
      <div className="text-[9px] text-app-muted uppercase tracking-wider font-bold">
        {routeSource ? "Routing" : "theDAW Binding"}
      </div>
      {inner}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function BusStatus({ connected, empty }: { connected: boolean; empty?: boolean }) {
  return (
    <>
      <div className="flex items-center gap-1.5 text-[10px] text-app-muted pt-0.5">
        <span
          className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-500" : "bg-zinc-600"}`}
          aria-hidden="true"
        />
        <span>
          {connected
            ? "theDAW bus: connected"
            : "theDAW offline — built-in VST binds still work"}
        </span>
      </div>
      {empty && (
        <div className="text-[10px] text-app-muted italic">
          No compatible functions published yet.
        </div>
      )}
    </>
  );
}

function ElInitial({ type }: { type: ElementType }) {
  return (
    <span
      className="w-4 h-4 rounded shrink-0 flex items-center justify-center bg-app-accent/20 text-app-accent text-[9px] font-bold"
      aria-hidden="true"
    >
      {type.charAt(0)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Display elements (Meter / Waveform): simple LISTEN source select.
// ---------------------------------------------------------------------------

function ListenPicker({
  element,
  onUpdateElements,
  targets,
  connected,
  listenKinds,
}: {
  element: UIElement;
  onUpdateElements: UpdateElementsFn;
  targets: DawTarget[];
  connected: boolean;
  listenKinds: string[];
}) {
  const filtered = targets
    .filter((t) => listenKinds.includes(t.kind))
    .sort(
      (a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
    );

  // Built-in listen sources (LFOs, macros, transport phase, meters) — always
  // offered, independent of theDAW's manifest. Labeled by AREA (their groups
  // subdivide areas) so "LFOs — LFO 1 Output" can't collide with theDAW groups.
  const builtin = vstListenBinds().filter((t) => listenKinds.includes(t.kind));

  const options = [
    { value: "", label: "None" },
    ...builtin.map((t) => ({ value: t.id, label: `${t.area} — ${t.label}` })),
    ...filtered.map((t) => ({ value: t.id, label: `${t.group} — ${t.label}` })),
  ];

  const setListen = (v: string) => {
    const next: ElementBinding = { ...element.binding, targetId: v || undefined };
    const hasAny = !!(
      next.targetId ||
      next.xTargetId ||
      next.yTargetId ||
      (next.routes && next.routes.length)
    );
    onUpdateElements([element.id], { binding: hasAny ? next : undefined });
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label className="text-[10px] text-app-muted">Listen to</label>
        <SelectField
          ariaLabel="Listen to theDAW signal"
          value={element.binding?.targetId ?? ""}
          onChange={setListen}
          options={options}
          disabled={element.isLocked}
        />
      </div>
      <BusStatus connected={connected} empty={connected && filtered.length === 0} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CustomCode: one theDAW binding per numeric param (el.paramBindings).
// ---------------------------------------------------------------------------

function CustomParamBindingPicker({
  element,
  params,
  onUpdateElements,
  targets,
  connected,
}: {
  element: UIElement;
  params: CustomParam[];
  onUpdateElements: UpdateElementsFn;
  targets: DawTarget[];
  connected: boolean;
}) {
  const disabled = !!element.isLocked;
  const kinds = customCodeParamKinds();
  const filtered = targets
    .filter((t) => kinds.includes(t.kind) && isWritableTarget(t))
    .sort(
      (a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label),
    );

  // Built-in writable binds a numeric param can drive (MIDI CCs, macros, LFO
  // params, transport tempo, plugin master…). Area-labeled like ListenPicker.
  const builtin = vstWriteBinds().filter((t) => kinds.includes(t.kind));

  const options = [
    { value: "", label: "None" },
    ...builtin.map((t) => ({ value: t.id, label: `${t.area} — ${t.label}` })),
    ...filtered.map((t) => ({ value: t.id, label: `${t.group} — ${t.label}` })),
  ];

  const bindings = element.paramBindings ?? [];
  const targetFor = (key: string) =>
    bindings.find((b) => b.key === key)?.targetId ?? "";

  const setBinding = (key: string, targetId: string) => {
    const rest = bindings.filter((b) => b.key !== key);
    const next = targetId ? [...rest, { key, targetId }] : rest;
    onUpdateElements([element.id], {
      paramBindings: next.length ? next : undefined,
    });
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {params.map((p) => (
          <div key={p.id ?? p.key} className="space-y-1">
            <label className="text-[10px] text-app-muted">
              {p.label || p.key}
            </label>
            <SelectField
              ariaLabel={`Bind parameter ${p.label || p.key} to a theDAW signal`}
              value={targetFor(p.key)}
              onChange={(v) => setBinding(p.key, v)}
              options={options}
              disabled={disabled}
            />
          </div>
        ))}
      </div>
      <BusStatus connected={connected} empty={connected && filtered.length === 0} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route-source elements: the modulation stack + destination browser.
// ---------------------------------------------------------------------------

function RoutingStack({
  element,
  elements,
  onUpdateElements,
  targets,
  connected,
}: {
  element: UIElement;
  elements: UIElement[];
  onUpdateElements: UpdateElementsFn;
  targets: DawTarget[];
  connected: boolean;
}) {
  const [view, setView] = useState<"stack" | "browser">("stack");
  const axes = sourceAxesFor(element.type);
  const [addAxis, setAddAxis] = useState<Axis>(axes[0] ?? "value");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const routes = element.binding?.routes ?? [];
  const b = element.binding;
  const disabled = !!element.isLocked;

  // Legacy single-target fields → read-only "convert me" cards.
  const legacy: Array<{ axis: Axis; targetId: string }> = [];
  if (b?.targetId) legacy.push({ axis: "value", targetId: b.targetId });
  if (b?.xTargetId) legacy.push({ axis: "x", targetId: b.xTargetId });
  if (b?.yTargetId) legacy.push({ axis: "y", targetId: b.yTargetId });

  // Single write path: recompute routes, drop the whole binding when nothing
  // (no routes, no legacy) is left so saved projects never carry an empty shell.
  const writeRoutes = (
    nextRoutes: ElementRoute[],
    extra?: Partial<ElementBinding>,
  ) => {
    const base: ElementBinding = { ...element.binding, ...extra };
    const hasLegacy = !!(base.targetId || base.xTargetId || base.yTargetId);
    if (nextRoutes.length === 0 && !hasLegacy) {
      onUpdateElements([element.id], { binding: undefined });
      return;
    }
    onUpdateElements([element.id], {
      binding: { ...base, routes: nextRoutes.length ? nextRoutes : undefined },
    });
  };

  const updateRoute = (id: string, patch: Partial<ElementRoute>) =>
    writeRoutes(routes.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const removeRoute = (id: string) =>
    writeRoutes(routes.filter((r) => r.id !== id));

  const addRoute = (dest: "daw" | "element", targetId: string, prop?: string) => {
    const newRoute: ElementRoute = {
      id: newRouteId(),
      dest,
      targetId,
      prop,
      axis: addAxis,
      amount: 100,
      curve: "linear",
    };
    writeRoutes([...routes, newRoute]);
    setView("stack");
  };

  const convertLegacy = (axis: Axis, targetId: string) => {
    const cleared: Partial<ElementBinding> =
      axis === "value"
        ? { targetId: undefined }
        : axis === "x"
          ? { xTargetId: undefined }
          : { yTargetId: undefined };
    const newRoute: ElementRoute = {
      id: newRouteId(),
      dest: "daw",
      targetId,
      axis,
      amount: 100,
      curve: "linear",
    };
    writeRoutes([...routes, newRoute], cleared);
  };

  if (view === "browser") {
    return (
      <RouteBrowser
        element={element}
        elements={elements}
        targets={targets}
        connected={connected}
        onBack={() => setView("stack")}
        onAdd={addRoute}
      />
    );
  }

  const isEmpty = routes.length === 0 && legacy.length === 0;

  return (
    <div className="space-y-2">
      {axes.length > 1 && (
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-app-muted uppercase mr-1">
            Add axis
          </span>
          {axes.map((ax) => (
            <button
              key={ax}
              type="button"
              onClick={() => setAddAxis(ax)}
              aria-pressed={addAxis === ax}
              className={`px-2 py-0.5 rounded text-[10px] uppercase border transition-colors ${
                addAxis === ax
                  ? "bg-app-accent text-white border-app-accent"
                  : "border-app-border text-app-muted hover:text-white"
              }`}
            >
              {ax}
            </button>
          ))}
        </div>
      )}

      {isEmpty ? (
        <div className="text-[10px] text-app-muted italic border border-dashed border-app-border rounded p-3 text-center leading-relaxed">
          No routes yet. Send this {element.type.toLowerCase()}&apos;s signal to
          theDAW functions or to other layers on the canvas.
        </div>
      ) : (
        <div className="space-y-1.5">
          {routes.map((route) => (
            <RouteCard
              key={route.id}
              route={route}
              elements={elements}
              targets={targets}
              expanded={expandedId === route.id}
              onToggle={() =>
                setExpandedId(expandedId === route.id ? null : route.id)
              }
              onUpdate={(patch) => updateRoute(route.id, patch)}
              onRemove={() => removeRoute(route.id)}
              showAxis={axes.length > 1}
              disabled={disabled}
            />
          ))}
          {legacy.map((lg) => (
            <LegacyCard
              key={`legacy-${lg.axis}`}
              legacy={lg}
              targets={targets}
              onConvert={() => convertLegacy(lg.axis, lg.targetId)}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => setView("browser")}
        disabled={disabled}
        className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded bg-app-accent text-white text-[11px] font-medium hover:brightness-110 transition disabled:opacity-50"
      >
        <Plus className="w-3.5 h-3.5" /> Add Route
      </button>

      <BusStatus connected={connected} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One route card (VIEW A row).
// ---------------------------------------------------------------------------

interface DestInfo {
  kind: "daw" | "element";
  title: string;
  subtitle: string;
  area?: string;
  typeInitial?: ElementType;
  missing: boolean;
}

function resolveDest(
  route: ElementRoute,
  elements: UIElement[],
  targets: DawTarget[],
): DestInfo {
  if (route.dest === "daw") {
    // Live manifest first, then the always-available built-in catalog — a
    // `vst:` route is never "unavailable" just because theDAW is offline.
    const t =
      targets.find((x) => x.id === route.targetId) ?? getVstBind(route.targetId);
    if (t)
      return {
        kind: "daw",
        title: t.label,
        subtitle: t.group,
        area: t.area,
        missing: false,
      };
    return {
      kind: "daw",
      title: route.targetId,
      subtitle: "unavailable",
      area: "",
      missing: true,
    };
  }
  const el = elements.find((e) => e.id === route.targetId);
  if (el) {
    const propLabel = elementDestProps(el.type).find(
      (p) => p.prop === route.prop,
    )?.label;
    return {
      kind: "element",
      title: el.name || el.type,
      subtitle: propLabel ? `${el.type} · ${propLabel}` : el.type,
      typeInitial: el.type,
      missing: false,
    };
  }
  return {
    kind: "element",
    title: route.targetId,
    subtitle: "missing layer",
    missing: true,
  };
}

function RouteCard({
  route,
  elements,
  targets,
  expanded,
  onToggle,
  onUpdate,
  onRemove,
  showAxis,
  disabled,
}: {
  route: ElementRoute;
  elements: UIElement[];
  targets: DawTarget[];
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (patch: Partial<ElementRoute>) => void;
  onRemove: () => void;
  showAxis: boolean;
  disabled: boolean;
}) {
  const info = resolveDest(route, elements, targets);
  const amount = route.amount ?? 100;
  // Local drafts let the Min/Max fields go momentarily empty mid-edit (e.g.
  // backspacing to retype) without React snapping the committed value back.
  // Blur clears the draft so the field falls back to the saved range value.
  const [minDraft, setMinDraft] = useState<string | null>(null);
  const [maxDraft, setMaxDraft] = useState<string | null>(null);

  return (
    <div className="rounded border border-app-border bg-app-surface">
      {/* Header row: destination + amount readout + expander */}
      <div className="flex items-center gap-2 p-1.5">
        {info.kind === "daw" ? (
          <span
            className={`w-3 h-3 rounded-full shrink-0 ${info.missing ? "ring-1 ring-red-500" : ""}`}
            style={{ background: info.missing ? "#3f3f46" : areaTint(info.area || "") }}
            aria-hidden="true"
          />
        ) : info.typeInitial ? (
          <ElInitial type={info.typeInitial} />
        ) : (
          <span
            className="w-4 h-4 rounded shrink-0 flex items-center justify-center bg-red-500/20 text-red-400 text-[9px] font-bold"
            aria-hidden="true"
          >
            ?
          </span>
        )}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[11px] text-white truncate">{info.title}</div>
          <div
            className={`text-[9px] truncate ${info.missing ? "text-red-400" : "text-app-muted"}`}
          >
            {info.subtitle}
          </div>
        </div>
        <span className="text-[10px] font-mono text-app-muted w-9 text-right shrink-0">
          {amount > 0 ? "+" : ""}
          {amount}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse route options" : "Expand route options"}
          className="shrink-0 p-0.5 rounded text-app-muted hover:text-white hover:bg-app-surface-hover transition"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {/* Amount slider (always visible, centre-notched) */}
      <div className="px-1.5 pb-1.5 flex items-center gap-2">
        <span className="text-[8px] text-app-muted uppercase shrink-0 w-6">Amt</span>
        <div className="relative flex-1 flex items-center">
          <span
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-0 bottom-0 w-px bg-app-border/70"
            aria-hidden="true"
          />
          <input
            type="range"
            name={`route-amount-${route.id}`}
            min={-100}
            max={100}
            value={amount}
            onChange={(e) => onUpdate({ amount: parseInt(e.target.value, 10) })}
            disabled={disabled}
            aria-label={`Amount for route to ${info.title}${amount < 0 ? " (inverted)" : ""}`}
            className="relative w-full accent-app-accent disabled:opacity-50"
          />
        </div>
      </div>

      {/* Expanded: curve, output range, source axis, remove */}
      {expanded && (
        <div className="px-1.5 pb-1.5 pt-1.5 space-y-2 border-t border-app-border/50">
          <div className="space-y-1">
            <label className="text-[9px] text-app-muted uppercase">Curve</label>
            <SelectField
              ariaLabel={`Response curve for route to ${info.title}`}
              value={route.curve ?? "linear"}
              onChange={(v) => onUpdate({ curve: v as RouteCurve })}
              disabled={disabled}
              options={[
                { value: "linear", label: "Linear" },
                { value: "exp", label: "Exponential" },
                { value: "log", label: "Logarithmic" },
                { value: "scurve", label: "S-Curve" },
              ]}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label
                htmlFor={`${route.id}-min`}
                className="text-[9px] text-app-muted uppercase"
              >
                Range Min
              </label>
              <input
                id={`${route.id}-min`}
                name={`${route.id}-min`}
                type="number"
                min={0}
                max={100}
                value={minDraft ?? route.rangeMin ?? 0}
                onChange={(e) => {
                  const raw = e.target.value;
                  setMinDraft(raw);
                  if (raw === "") return;
                  const n = parseInt(raw, 10);
                  if (Number.isNaN(n)) return;
                  onUpdate({ rangeMin: Math.max(0, Math.min(100, n)) });
                }}
                onBlur={() => setMinDraft(null)}
                disabled={disabled}
                className={NUM_CLS}
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor={`${route.id}-max`}
                className="text-[9px] text-app-muted uppercase"
              >
                Range Max
              </label>
              <input
                id={`${route.id}-max`}
                name={`${route.id}-max`}
                type="number"
                min={0}
                max={100}
                value={maxDraft ?? route.rangeMax ?? 100}
                onChange={(e) => {
                  const raw = e.target.value;
                  setMaxDraft(raw);
                  if (raw === "") return;
                  const n = parseInt(raw, 10);
                  if (Number.isNaN(n)) return;
                  onUpdate({ rangeMax: Math.max(0, Math.min(100, n)) });
                }}
                onBlur={() => setMaxDraft(null)}
                disabled={disabled}
                className={NUM_CLS}
              />
            </div>
          </div>

          {showAxis && (
            <div className="space-y-1">
              <label className="text-[9px] text-app-muted uppercase">
                Source Axis
              </label>
              <SelectField
                ariaLabel={`Source axis for route to ${info.title}`}
                value={route.axis ?? "value"}
                onChange={(v) => onUpdate({ axis: v as Axis })}
                disabled={disabled}
                options={[
                  { value: "x", label: "X" },
                  { value: "y", label: "Y" },
                ]}
              />
            </div>
          )}

          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="w-full flex items-center justify-center gap-1 py-1 rounded border border-red-500/40 text-red-400 text-[10px] hover:bg-red-500/10 transition disabled:opacity-50"
          >
            <X className="w-3 h-3" /> Remove Route
          </button>
        </div>
      )}
    </div>
  );
}

function LegacyCard({
  legacy,
  targets,
  onConvert,
  disabled,
}: {
  legacy: { axis: Axis; targetId: string };
  targets: DawTarget[];
  onConvert: () => void;
  disabled: boolean;
}) {
  const t = targets.find((x) => x.id === legacy.targetId);
  const title = t ? t.label : legacy.targetId;
  const suffix = legacy.axis !== "value" ? ` · ${legacy.axis.toUpperCase()} axis` : "";
  const subtitle = t ? `${t.group}${suffix}` : `unavailable${suffix}`;

  return (
    <div className="rounded border border-amber-500/30 bg-amber-500/5 p-1.5 flex items-center gap-2">
      <span
        className="w-3 h-3 rounded-full shrink-0"
        style={{ background: t ? areaTint(t.area) : "#a1a1aa" }}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-[11px] text-white truncate">{title}</div>
        <div className="text-[9px] text-amber-400/80 truncate">
          legacy · {subtitle}
        </div>
      </div>
      <button
        type="button"
        onClick={onConvert}
        disabled={disabled}
        className="shrink-0 px-2 py-1 rounded text-[9px] uppercase border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 transition disabled:opacity-50"
      >
        Convert
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VIEW B: the destination browser.
// ---------------------------------------------------------------------------

function RouteBrowser({
  element,
  elements,
  targets,
  connected,
  onBack,
  onAdd,
}: {
  element: UIElement;
  elements: UIElement[];
  targets: DawTarget[];
  connected: boolean;
  onBack: () => void;
  onAdd: (dest: "daw" | "element", targetId: string, prop?: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Per-area expand/collapse overrides for the BUILT-IN sections. Unset areas
  // fall back to the size default (small areas open, huge ones — MIDI CC /
  // Notes — closed); a live search forces everything open.
  const [areaOverrides, setAreaOverrides] = useState<Record<string, boolean>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const kinds = bindableKindsFor(element.type) ?? [];

  const matchesQuery = (t: DawTarget) =>
    q === "" ||
    t.label.toLowerCase().includes(q) ||
    t.group.toLowerCase().includes(q) ||
    t.area.toLowerCase().includes(q) ||
    t.id.toLowerCase().includes(q);

  const dawTargets = targets.filter(
    (t) => kinds.includes(t.kind) && isWritableTarget(t) && matchesQuery(t),
  );

  const byArea = new Map<string, DawTarget[]>();
  for (const t of dawTargets) {
    const arr = byArea.get(t.area) ?? [];
    arr.push(t);
    byArea.set(t.area, arr);
  }
  const areas = [...byArea.keys()].sort((a, b) => a.localeCompare(b));
  for (const a of areas) {
    byArea
      .get(a)!
      .sort(
        (x, y) => x.group.localeCompare(y.group) || x.label.localeCompare(y.label),
      );
  }

  // Built-in VST binds this control can drive — always offered (no theDAW
  // needed). Grouped by area in CATALOG order (not alphabetical): Transport /
  // Plugin / Macros / LFOs / Presets / MIDI / MIDI Notes.
  const builtinTargets = vstWriteBinds().filter(
    (t) => kinds.includes(t.kind) && matchesQuery(t),
  );
  const builtinByArea = new Map<string, VstBindTarget[]>();
  for (const t of builtinTargets) {
    const arr = builtinByArea.get(t.area) ?? [];
    arr.push(t);
    builtinByArea.set(t.area, arr);
  }
  const builtinAreas = [...builtinByArea.keys()];
  const isAreaOpen = (area: string, count: number) =>
    q !== "" ? true : (areaOverrides[area] ?? count <= 16);
  const toggleArea = (area: string, count: number) =>
    setAreaOverrides((prev) => ({
      ...prev,
      [area]: !isAreaOpen(area, count),
    }));

  const otherEls = elements.filter(
    (e) =>
      e.id !== element.id &&
      elementDestProps(e.type).length > 0 &&
      (q === "" ||
        (e.name || "").toLowerCase().includes(q) ||
        e.type.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q)),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to route stack"
          className="shrink-0 p-1 rounded text-app-muted hover:text-white hover:bg-app-surface-hover transition"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="relative flex-1">
          <Search
            className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-app-muted pointer-events-none"
            aria-hidden="true"
          />
          <label htmlFor="route-search" className="sr-only">
            Search routing destinations
          </label>
          <input
            ref={searchRef}
            id="route-search"
            name="route-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search functions & layers…"
            className="w-full bg-app-base border border-app-border rounded pl-7 pr-2 py-1 text-[11px] text-app-main outline-none focus:border-app-accent"
          />
        </div>
      </div>

      <div className="space-y-3 max-h-96 overflow-y-auto pr-0.5">
        {areas.map((area) => (
          <div key={area} className="space-y-1">
            <div className="text-[9px] text-app-muted uppercase tracking-wider font-bold sticky top-0 bg-app-base py-0.5 z-10">
              {area}
            </div>
            {byArea.get(area)!.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onAdd("daw", t.id)}
                className="w-full flex items-center gap-2 p-1.5 rounded border border-app-border bg-app-surface hover:border-app-accent hover:bg-app-surface-hover text-left transition"
              >
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ background: areaTint(t.area) }}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="text-[11px] text-white truncate">{t.label}</div>
                  <div className="text-[9px] text-app-muted truncate">
                    {t.group}
                    {t.unit ? ` · ${t.unit}` : ""}
                  </div>
                </div>
                <Plus className="w-3 h-3 text-app-muted shrink-0" aria-hidden="true" />
              </button>
            ))}
          </div>
        ))}

        {builtinAreas.map((area) => {
          const entries = builtinByArea.get(area)!;
          const open = isAreaOpen(area, entries.length);
          return (
            <div key={`vst-${area}`} className="space-y-1">
              <button
                type="button"
                onClick={() => toggleArea(area, entries.length)}
                aria-expanded={open}
                className="w-full flex items-center gap-1 text-[9px] text-app-muted uppercase tracking-wider font-bold sticky top-0 bg-app-base py-0.5 z-10 hover:text-white transition text-left"
              >
                {open ? (
                  <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" />
                )}
                <span className="flex-1 truncate">{area}</span>
                <span className="font-mono normal-case">{entries.length}</span>
              </button>
              {open &&
                entries.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onAdd("daw", t.id)}
                    className="w-full flex items-center gap-2 p-1.5 rounded border border-app-border bg-app-surface hover:border-app-accent hover:bg-app-surface-hover text-left transition"
                  >
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ background: areaTint(t.area) }}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="text-[11px] text-white truncate">
                        {t.label}
                      </div>
                      <div className="text-[9px] text-app-muted truncate">
                        {t.group}
                        {t.unit ? ` · ${t.unit}` : ""}
                      </div>
                    </div>
                    <Plus
                      className="w-3 h-3 text-app-muted shrink-0"
                      aria-hidden="true"
                    />
                  </button>
                ))}
            </div>
          );
        })}

        {otherEls.length > 0 && (
          <div className="space-y-1">
            <div className="text-[9px] text-app-muted uppercase tracking-wider font-bold sticky top-0 bg-app-base py-0.5 z-10">
              Elements
            </div>
            {otherEls.map((e) => {
              const props = elementDestProps(e.type);
              const multi = props.length > 1;
              if (multi) {
                return (
                  <div
                    key={e.id}
                    className="rounded border border-app-border bg-app-surface"
                  >
                    <div className="flex items-center gap-2 p-1.5">
                      <ElInitial type={e.type} />
                      <div className="min-w-0 flex-1 leading-tight">
                        <div className="text-[11px] text-white truncate">
                          {e.name || e.type}
                        </div>
                        <div className="text-[9px] text-app-muted truncate">
                          {e.type}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1 px-1.5 pb-1.5">
                      {props.map((p) => (
                        <button
                          key={p.prop}
                          type="button"
                          onClick={() => onAdd("element", e.id, p.prop)}
                          aria-label={`Route to ${e.name || e.type} ${p.label}`}
                          className="px-2 py-0.5 rounded text-[10px] border border-app-border text-app-muted hover:border-app-accent hover:text-white transition"
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              }
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => onAdd("element", e.id, props[0].prop)}
                  className="w-full flex items-center gap-2 p-1.5 rounded border border-app-border bg-app-surface hover:border-app-accent hover:bg-app-surface-hover text-left transition"
                >
                  <ElInitial type={e.type} />
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="text-[11px] text-white truncate">
                      {e.name || e.type}
                    </div>
                    <div className="text-[9px] text-app-muted truncate">
                      {e.type} · {props[0].label}
                    </div>
                  </div>
                  <Plus className="w-3 h-3 text-app-muted shrink-0" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}

        {areas.length === 0 && builtinAreas.length === 0 && otherEls.length === 0 && (
          <div className="text-[10px] text-app-muted italic text-center py-4 leading-relaxed">
            {q
              ? "No matches."
              : "No compatible functions or layers to route to yet."}
          </div>
        )}
      </div>

      <BusStatus connected={connected} />
    </div>
  );
}
