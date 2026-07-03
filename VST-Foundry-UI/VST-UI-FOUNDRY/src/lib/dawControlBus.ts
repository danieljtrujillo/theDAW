/**
 * theDAW control-bus client (Feature A: bind Foundry controls to theDAW).
 *
 * Connects to theDAW's XR control relay (`/api/xr/control/ws` on the theDAW
 * backend, port 8600) as a CONTROLLER peer — the same role a theDAW-XR headset
 * plays. theDAW's browser tab (which hosts this app in an iframe) is the HOST
 * peer: it owns the manifest of bindable targets and applies inbound
 * `control-set` frames by routing them to the registered source that owns the
 * id. The relay is transport-only and fans every frame out to all other peers.
 *
 * Wire contract (mirrors theDAW frontend/src/state/xrControlClient.ts —
 * verified against that file; do not change one side without the other):
 *   us   -> host : {"type":"request-controls"}
 *                  {"type":"control-set","id":string,"value":number|boolean}
 *   host -> us   : {"type":"manifest","version":N,"entries":[DawTarget...]}
 *                  {"type":"control-changed","id":string,"value":...}
 *
 * The host re-publishes the manifest on connect and whenever a new control
 * source registers, so the target list stays current as theDAW gains
 * functions — no polling needed beyond the initial `request-controls`.
 */
import type { CustomParam, ElementType, UIElement } from "../types";
import { getVstBind, isVstBindId } from "./vstBinds";

export type DawControlValue = number | boolean;

/** One bindable target from theDAW's manifest (mirror of XrManifestEntry). */
export interface DawTarget {
  id: string;
  area: string;
  group: string;
  label: string;
  /** knob | fader | button | toggle | crossfader | select | xy | xyz | jog | grid | pad */
  kind: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  unit?: string;
  value?: DawControlValue;
  /** Input-only source (sway/pose publish state but cannot be set) — never bindable. */
  readonly?: boolean;
}

export interface DawBusSnapshot {
  connected: boolean;
  targets: DawTarget[];
  version: number;
}

const RECONNECT_MS = 2000;

let ws: WebSocket | null = null;
let running = false;
let reconnectTimer = 0;
let everConnected = false;

let snapshot: DawBusSnapshot = { connected: false, targets: [], version: 0 };
const listeners = new Set<() => void>();

// Live-value store for LISTEN bindings. Kept OUT of the React snapshot on
// purpose: sway/pose stream at up to 60fps, so we fan each frame only to the
// per-id listeners that care instead of re-rendering every snapshot consumer.
const liveValues = new Map<string, DawControlValue>();
const valueListeners = new Map<string, Set<(v: DawControlValue) => void>>();

// Local write handler for built-in `vst:` binds. Registered by
// vstBindRuntime at module load (setVstWriteHandler) — a plain function slot
// rather than an import so this module never depends on the runtime at load
// time. setDawTarget calls it BEFORE forwarding the frame on the bus.
let vstWriteHandler: ((id: string, value: DawControlValue) => void) | null = null;

/** Register the local handler for writes to `vst:` bind ids. */
export function setVstWriteHandler(
  fn: (id: string, value: DawControlValue) => void,
): void {
  vstWriteHandler = fn;
}

/**
 * Record a target's latest value and fan it out to that id's listeners only
 * (O(listeners-for-that-id)). Called from control-changed frames and from
 * manifest seeding.
 */
function pushDawValue(id: string, value: DawControlValue): void {
  liveValues.set(id, value);
  const set = valueListeners.get(id);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(value);
    } catch {
      /* a listener that throws never breaks the bus */
    }
  }
}

function wsUrl(): string {
  // theDAW backend runs on :8600 next to this app (Foundry sidecar :5472,
  // theDAW SPA :5173 — all same hostname). Direct WS: no iframe origin bridge
  // needed; the relay accepts any peer.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.hostname}:8600/api/xr/control/ws`;
}

function emit(next: Partial<DawBusSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a listener that throws never breaks the bus */
    }
  }
}

function scheduleReconnect(): void {
  if (!running || reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    connect();
  }, RECONNECT_MS);
}

function connect(): void {
  if (!running || ws) return;
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    everConnected = true;
    emit({ connected: true });
    // Ask the host to (re)publish its manifest for us.
    try {
      sock.send(JSON.stringify({ type: "request-controls" }));
    } catch {
      /* socket died between open and send — reconnect path handles it */
    }
  };
  sock.onmessage = (e) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof e.data === "string" ? e.data : "");
    } catch {
      return; // ignore malformed frame
    }
    if (!parsed || typeof parsed !== "object") return;
    const m = parsed as {
      type?: unknown;
      entries?: unknown;
      version?: unknown;
      id?: unknown;
      value?: unknown;
    };
    if (m.type === "manifest" && Array.isArray(m.entries)) {
      const targets = (m.entries as unknown[]).filter(
        (t): t is DawTarget =>
          !!t &&
          typeof t === "object" &&
          typeof (t as DawTarget).id === "string" &&
          typeof (t as DawTarget).kind === "string" &&
          // Consumers sort/display on these — validate what we dereference.
          typeof (t as DawTarget).group === "string" &&
          typeof (t as DawTarget).label === "string",
        // Input-only sources (sway/pose) are KEPT now: they carry `readonly`
        // and are the star LISTEN sources for display elements. The write path
        // excludes them via isWritableTarget(); the listen path welcomes them.
      );
      emit({
        targets,
        version: typeof m.version === "number" ? m.version : snapshot.version + 1,
      });
      // Seed the live-value store from any inline `value`s the host published
      // so a display element bound before the first control-changed frame
      // arrives can paint immediately.
      for (const t of targets) {
        if (t.value !== undefined) pushDawValue(t.id, t.value);
      }
      return;
    }
    // control-changed frames (host mirroring its own live moves, incl. sway/pose
    // at up to 60fps) drive the live-value store — NOT the React snapshot — so a
    // 60fps stream re-renders only the elements subscribed to that id.
    if (
      m.type === "control-changed" &&
      typeof m.id === "string" &&
      (typeof m.value === "number" || typeof m.value === "boolean")
    ) {
      pushDawValue(m.id, m.value);
      return;
    }
  };
  sock.onerror = () => {
    try {
      sock.close();
    } catch {
      /* already closing */
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (everConnected) emit({ connected: false });
    scheduleReconnect();
  };
}

/** Open (and keep open) the bus. Safe to call repeatedly. */
export function startDawControlBus(): void {
  if (running) return;
  running = true;
  connect();
}

/** Close the bus and stop reconnecting. */
export function stopDawControlBus(): void {
  running = false;
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    ws = null;
  }
  emit({ connected: false });
}

/** Subscribe to snapshot changes (useSyncExternalStore-compatible). */
export function subscribeDawBus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current snapshot (stable identity between changes). */
export function getDawBusSnapshot(): DawBusSnapshot {
  return snapshot;
}

/** Look up one target by id: the live manifest first (a theDAW entry may
 * shadow/implement a `vst:` id one day), then the built-in catalog. */
export function getDawTarget(id: string | undefined): DawTarget | undefined {
  if (!id) return undefined;
  return snapshot.targets.find((t) => t.id === id) ?? getVstBind(id);
}

/**
 * Subscribe to one target's live value stream (LISTEN path). The callback fires
 * synchronously on every control-changed frame for `id` (and on manifest
 * seeding). Returns an unsubscribe fn. NOT routed through React state — display
 * elements drive their own local state from this so a 60fps id re-renders only
 * its own dispatcher.
 */
export function subscribeDawValue(
  id: string,
  cb: (v: DawControlValue) => void,
): () => void {
  let set = valueListeners.get(id);
  if (!set) {
    set = new Set();
    valueListeners.set(id, set);
  }
  set.add(cb);
  return () => {
    const s = valueListeners.get(id);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) valueListeners.delete(id);
  };
}

/** Latest known live value for a target id, or undefined if none seen yet. */
export function getDawValue(id: string): DawControlValue | undefined {
  return liveValues.get(id);
}

/** True when at least one LISTEN subscription exists for this id. Lets the
 * bind runtime skip 60fps publishes nobody is watching. */
export function hasDawValueListeners(id: string): boolean {
  return (valueListeners.get(id)?.size ?? 0) > 0;
}

/** Publish a LOCALLY-computed live value (built-in bind runtime: LFOs,
 * macros, transport phase) into the same store control-changed frames feed,
 * so subscribeDawValue consumers treat both sources identically. */
export function publishLocalDawValue(id: string, value: DawControlValue): void {
  pushDawValue(id, value);
}

/**
 * Drive one target. Values: scaled number, or boolean for toggles.
 *
 * Built-in `vst:` ids dispatch to the local bind runtime first (LFOs, macros,
 * local transport), then the SAME frame is forwarded on the bus — theDAW may
 * implement handlers for `vst:` ids over time without Foundry changing, and
 * unknown ids are ignored by today's host. Live theDAW ids keep the original
 * bus-only path.
 */
export function setDawTarget(id: string, value: DawControlValue): void {
  if (isVstBindId(id) && vstWriteHandler) {
    try {
      vstWriteHandler(id, value);
    } catch {
      /* a runtime bug never breaks the bus path */
    }
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "control-set", id, value }));
  } catch {
    /* dropped frame on a dying socket — reconnect path handles it */
  }
}

// ---------------------------------------------------------------------------
// Binding helpers shared by the picker UI and the runtime dispatch seam.
// ---------------------------------------------------------------------------

/**
 * Which manifest kinds a Foundry control type may bind to. `null` = the
 * element type is not bindable. XYPad/Spatial3D bind one continuous target
 * per axis (theDAW publishes no native xy target today).
 */
export function bindableKindsFor(type: ElementType): string[] | null {
  // NOTE (audit): theDAW's host maps crossfader→"fader" before publishing, so
  // "crossfader" never appears in a manifest — filter on "fader" instead.
  // Button→"toggle" is excluded: a momentary press-release would set the
  // toggle true-then-false (never latches), which reads as broken.
  switch (type) {
    case "Knob":
      return ["knob", "fader"];
    case "Slider":
      return ["fader", "knob"];
    // Meter is LISTEN-ONLY now (see listenKindsFor): a display element is driven
    // BY a target's live value, it never writes one. A write dropdown here made
    // no sense.
    case "Meter":
      return null;
    case "WaveShaper":
      return ["knob", "fader"];
    case "Toggle":
      return ["toggle"];
    case "Button":
      return ["button", "pad"];
    case "XYPad":
    case "Spatial3D":
      return ["knob", "fader"];
    default:
      return null;
  }
}

/**
 * CustomCode has no single element value, so it binds theDAW targets PER
 * PARAMETER instead of through the element-level routing stack (bindableKindsFor
 * is null for it). Its NUMERIC params are the bindable/listenable set, and the
 * binding is bidirectional: theDAW's live value is pushed into the iframe as
 * that param (LISTEN) and iframe-side changes to a bound param dispatch back out
 * to theDAW (WRITE) — so one numeric set serves both directions. Returns [] for
 * any non-CustomCode element (or one with no numeric params), so callers gate on
 * `.length`.
 */
export function customCodeBindableParams(el: UIElement): CustomParam[] {
  if (el.type !== "CustomCode") return [];
  return (el.params ?? []).filter((p) => p.type === "number");
}

/**
 * Continuous theDAW kinds a CustomCode numeric param may bind to — the same
 * writable continuous set a Knob uses (a param is normalized 0–100 like any
 * other source). crossfader→"fader" on theDAW's side, so it is covered.
 */
export function customCodeParamKinds(): string[] {
  return ["knob", "fader"];
}

/**
 * Map a Foundry preview value (0–100, the dispatcher's clamped range) onto a
 * target's declared min..max. Targets without bounds get the 0..1 fraction.
 */
export function scaleToTarget(val0to100: number, target: DawTarget | undefined): number {
  const frac = Math.max(0, Math.min(1, val0to100 / 100));
  if (!target) return frac;
  const min = typeof target.min === "number" ? target.min : 0;
  const max = typeof target.max === "number" ? target.max : 1;
  return min + frac * (max - min);
}

/**
 * Which manifest kinds a Foundry DISPLAY element may LISTEN to (animate from).
 * Unlike the write path, this welcomes readonly sources (sway/pose) — those are
 * the star signals for live meters/scopes. `null` = the element type is not a
 * listener in v1.
 */
export function listenKindsFor(type: ElementType): string[] | null {
  // NOTE: no "crossfader" here — theDAW's host maps crossfader→"fader" before
  // publishing, so that kind never appears in a manifest (same reasoning as
  // bindableKindsFor; review finding).
  switch (type) {
    // Meter animates its level from a continuous target's live value.
    // "toggle" joins the set for boolean state sources (built-in
    // vst:transport.playing / vst:meter.clip, or any theDAW toggle) —
    // scaleFromTarget collapses booleans to 0/100, i.e. an LED-style meter.
    case "Meter":
      return ["knob", "fader", "toggle"];
    // Waveform (LFO / Oscilloscope / Modern / Blank variants) breathes its
    // amplitude from a continuous target's live value.
    case "Waveform":
      return ["knob", "fader", "toggle"];
    default:
      return null;
  }
}

/**
 * True when a target may be DRIVEN (written) by a control. Input-only sources
 * (sway/pose) carry `readonly` and are excluded from the write picker — sending
 * them control-set is a silent no-op — but remain available to the listen path.
 */
export function isWritableTarget(t: DawTarget): boolean {
  return !t.readonly;
}

/**
 * Inverse of scaleToTarget: map a target's live value on its declared min..max
 * onto the Foundry 0–100 display range. Booleans collapse to 0/100; a target
 * without bounds is treated as 0..1. Result is clamped to 0–100.
 */
export function scaleFromTarget(
  v: DawControlValue,
  target: DawTarget | undefined,
): number {
  if (typeof v === "boolean") return v ? 100 : 0;
  const min = typeof target?.min === "number" ? target.min : 0;
  const max = typeof target?.max === "number" ? target.max : 1;
  if (max === min) return 0;
  const pct = ((v - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, pct));
}
