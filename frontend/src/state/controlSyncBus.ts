/**
 * Control-sync bus — two-way real-time link between the SLIDE tab's VISUAL
 * lanes and the GANTASMO-LIVE-VJ iframe's controls.
 *
 * Direction & ownership:
 *   - VJ owns the control manifest (key + label + native range). On connect
 *     it sends it; VJView calls `ingestManifest`, which populates slideStore's
 *     `visualControls` so the VISUAL catalog matches the real VJ build.
 *   - OUTBOUND (SLIDE → VJ): a module-level subscription watches slideStore's
 *     visual values/pads. When one moves (and we're not mid-apply), it converts
 *     0..100 → native and calls the registered sink (VJView posts control-set).
 *   - INBOUND (VJ → SLIDE): VJView calls `applyFromVj` when the VJ deck moves a
 *     control; we convert native → 0..100 and write the VISUAL namespace.
 *
 * Echo guard: `applying` is set while we write an inbound change so the
 * outbound subscription ignores it — preventing the SLIDE↔VJ feedback loop.
 * Mirrors the guard proven in sliders/sync-demo.html.
 *
 * Follows the module-level handler pattern of vjPlaybackBus / vjSetBus.
 */
import {
  useSlideStore,
  STACK_PREFIX,
  stackIdFromLabel,
  type VisualControl,
  type StackBinding,
} from './slideStore';
import { sendTrackToVj } from './vjSetBus';

/** Sink the VJView registers — posts `sa3-vj/control-set` into the iframe. */
type ControlSink = (key: string, value: number | boolean) => void;

let sink: ControlSink | null = null;
let applying = false; // true while writing an inbound change (suppresses echo)

/** key → manifest entry, rebuilt whenever a manifest is ingested. */
let byKey: Map<string, VisualControl> = new Map();
/** label → key, for resolving a moved fader (item = label) to its control. */
let byLabel: Map<string, string> = new Map();

/* ----------------------------- conversion ------------------------------- */
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** native value (or boolean) → 0..100 fader percentage. */
export function toPct(entry: VisualControl, native: number | boolean): number {
  if (entry.kind === 'toggle') return native ? 100 : 0;
  const min = entry.min ?? 0;
  const max = entry.max ?? 1;
  if (max === min) return 0;
  return clamp(((Number(native) - min) / (max - min)) * 100, 0, 100);
}

/** 0..100 fader percentage → native value (snapped to step) or boolean. */
export function toNative(entry: VisualControl, pct: number): number | boolean {
  if (entry.kind === 'toggle') return pct >= 50;
  const min = entry.min ?? 0;
  const max = entry.max ?? 1;
  const raw = min + (clamp(pct, 0, 100) / 100) * (max - min);
  const step = entry.step && entry.step > 0 ? entry.step : 0;
  const snapped = step ? Math.round(raw / step) * step : raw;
  // avoid 3.0000000004 noise from float steps
  return Math.round(snapped * 1e6) / 1e6;
}

/* --------------------------- manifest ingest ---------------------------- */
export function ingestManifest(
  controls: VisualControl[],
  values: Record<string, number | boolean> | undefined,
): void {
  byKey = new Map(controls.map((c) => [c.key, c]));
  byLabel = new Map(controls.map((c) => [c.label, c.key]));
  useSlideStore.getState().setVisualControls(controls);

  // Seed the SLIDE lanes with the VJ's current values so faders open at the
  // right position instead of their seeded defaults.
  if (values) {
    applying = true;
    try {
      const store = useSlideStore.getState();
      for (const c of controls) {
        const v = values[c.key];
        if (v === undefined) continue;
        if (c.kind === 'toggle') store.setOnFor('visual', c.label, Boolean(v));
        else store.setValueFor('visual', c.label, toPct(c, v));
      }
    } finally {
      applying = false;
    }
  }
}

/* --------------------------- inbound (VJ → SLIDE) ----------------------- */
export function applyFromVj(key: string, native: number | boolean): void {
  const entry = byKey.get(key);
  if (!entry) return;
  applying = true;
  try {
    const store = useSlideStore.getState();
    if (entry.kind === 'toggle') store.setOnFor('visual', entry.label, Boolean(native));
    else store.setValueFor('visual', entry.label, toPct(entry, native));
  } finally {
    applying = false;
  }
}

/* --------------------------- sink registration ------------------------- */
export function registerControlSink(fn: ControlSink): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

export function isControlSinkActive(): boolean {
  return sink !== null;
}

/* --------------------------- outbound (SLIDE → VJ) --------------------- */
function emit(label: string, pctOrBool: number | boolean): void {
  if (!sink) return;
  const key = byLabel.get(label);
  if (!key) return;
  const entry = byKey.get(key);
  if (!entry) return;
  const native = typeof pctOrBool === 'boolean' ? pctOrBool : toNative(entry, pctOrBool);
  sink(key, native);
}

/* --------------------------- stacks (2C) ------------------------------- */
// A stack lane fans ONE slider out to many manifest targets, each on its own
// sub-range. The lane label is `STACK_PREFIX + id`; its value lives under
// `visual/stack:<id>`. Outbound only (one→many can't reconcile inbound).
function driveStackByPct(stack: StackBinding, lanePct: number): void {
  if (!sink) return;
  const t = clamp(lanePct, 0, 100) / 100;
  for (const target of stack.targets) {
    const entry = byKey.get(target.key);
    if (!entry) continue; // manifest not loaded / unknown key
    const from = target.fromPct ?? 0;
    const to = target.toPct ?? 100;
    const targetPct = from + t * (to - from);
    sink(target.key, entry.kind === 'toggle' ? targetPct >= 50 : toNative(entry, targetPct));
  }
}

/** Push a stack's bound media into the VJ (load clip/image). No-op if none. */
export function loadStackMedia(stack: StackBinding): void {
  const m = stack.media;
  if (!m) return;
  sendTrackToVj({ entryId: m.entryId ?? null, label: m.label, url: m.url, kind: m.kind });
}

/** Re-emit a stack at its current lane value (e.g. right after editing targets
 *  or selecting the stack) so the VJ reflects the binding immediately. */
export function refreshStack(stackId: string): void {
  const st = useSlideStore.getState().stacks.find((s) => s.id === stackId);
  if (!st) return;
  const pct = useSlideStore.getState().values[`visual/${STACK_PREFIX}${stackId}`] ?? 0;
  driveStackByPct(st, pct);
}

// Watch slideStore for visual value/pad changes and forward them to the VJ.
// Manifest controls go through emit(); stack lanes (visual/stack:<id>) fan out
// through driveStackByPct(). Never fires while `applying` an inbound change.
const VISUAL_PREFIX = 'visual/';
useSlideStore.subscribe((state, prev) => {
  if (applying || !sink) return;
  // ranges (incl. stack lanes)
  if (state.values !== prev.values) {
    for (const k in state.values) {
      if (!k.startsWith(VISUAL_PREFIX)) continue;
      if (state.values[k] === prev.values[k]) continue;
      const label = k.slice(VISUAL_PREFIX.length);
      const stackId = stackIdFromLabel(label);
      if (stackId) {
        const st = state.stacks.find((s) => s.id === stackId);
        if (st) driveStackByPct(st, state.values[k]);
      } else {
        emit(label, state.values[k]);
      }
    }
  }
  // toggles (stacks are faders, so only manifest toggles here)
  if (state.pads !== prev.pads) {
    for (const k in state.pads) {
      if (!k.startsWith(VISUAL_PREFIX)) continue;
      if (state.pads[k] === prev.pads[k]) continue;
      emit(k.slice(VISUAL_PREFIX.length), state.pads[k]);
    }
  }
});
