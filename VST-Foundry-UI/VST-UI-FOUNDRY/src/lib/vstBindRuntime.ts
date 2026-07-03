/**
 * Preview runtime for the built-in VST bind catalog (src/lib/vstBinds.ts).
 *
 * Owns the LIVE state behind every `preview: true` catalog entry so designs
 * animate with no theDAW and no audio engine:
 *
 *   - Macros 1–8       virtual knobs (write → held → re-published to listeners)
 *   - LFO 1–4          free-running oscillators; rate/depth/shape writable
 *   - Random S&H       clocked sample-and-hold noise
 *   - Local transport  play/stop/record/loop/metronome/tempo/tap; publishes
 *                      playing state, beat phase, bar phase (4/4), playhead
 *
 * Wiring: dawControlBus routes every write to a `vst:` id here (via
 * setVstWriteHandler) BEFORE forwarding the same frame over the XR bus, and
 * this module publishes live values back through publishLocalDawValue — so
 * the existing subscribeDawValue LISTEN path (Meters / Waveforms /
 * CustomCode params) works identically for built-in binds and live theDAW
 * targets. Ids with no local meaning (MIDI, presets, plugin master) are
 * ignored here: the bus forward and the exported shell own those.
 *
 * The rAF loop starts with startVstBindRuntime() (idempotent, browser-only)
 * and publishes only ids somebody is listening to (hasDawValueListeners).
 */
import {
  hasDawValueListeners,
  publishLocalDawValue,
  setVstWriteHandler,
  type DawControlValue,
} from "./dawControlBus";
import { VST_LFO_COUNT, VST_LFO_SHAPES, VST_MACRO_COUNT } from "./vstBinds";

// ---------------------------------------------------------------------------
// Pure signal math (exported for tests + reused verbatim by the exported UI).
// ---------------------------------------------------------------------------

export type LfoShape = (typeof VST_LFO_SHAPES)[number];

/**
 * One LFO sample: phase 0..1 → 0..100, centered at 50 and scaled by depth
 * (0..100). "s&h" is handled by the caller (it needs held state); here it
 * falls back to a square so a stateless caller still gets motion.
 */
export function lfoValue(shape: LfoShape, phase01: number, depth0to100: number): number {
  const p = ((phase01 % 1) + 1) % 1;
  let bipolar: number; // -1..1
  switch (shape) {
    case "triangle":
      bipolar = 4 * Math.abs(p - 0.5) - 1;
      break;
    case "saw":
      bipolar = p * 2 - 1;
      break;
    case "square":
    case "s&h":
      bipolar = p < 0.5 ? 1 : -1;
      break;
    case "sine":
    default:
      bipolar = Math.sin(p * Math.PI * 2);
      break;
  }
  const depth = Math.max(0, Math.min(100, depth0to100)) / 100;
  return 50 + bipolar * 50 * depth;
}

/** Coerce a bus value (scaled number or boolean) into an on/off. */
export function truthyControl(v: DawControlValue): boolean {
  return typeof v === "boolean" ? v : v >= 0.5;
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

interface LfoState {
  rate: number; // Hz
  depth: number; // 0..100
  shape: number; // index into VST_LFO_SHAPES
  phase: number; // 0..1
  held: number; // current S&H output (0..100)
}

const lfos: LfoState[] = Array.from({ length: VST_LFO_COUNT }, () => ({
  rate: 1,
  depth: 100,
  shape: 0,
  phase: 0,
  held: 50,
}));

const macros: number[] = Array.from({ length: VST_MACRO_COUNT }, () => 0);

const random = { rate: 2, phase: 0, value: 50 };

const transport = {
  playing: false,
  recording: false,
  loop: false,
  metronome: false,
  tempo: 120,
  playheadSec: 0,
  tapTimes: [] as number[],
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Write handling — the local half of setDawTarget for `vst:` ids.
// ---------------------------------------------------------------------------

/**
 * Apply a write to a built-in bind's local state. Called by dawControlBus for
 * every `vst:` control-set (the frame is ALSO forwarded to theDAW; that path
 * is not this module's concern). Unknown / non-local ids are ignored.
 */
export function handleVstBindWrite(id: string, value: DawControlValue): void {
  const num = typeof value === "boolean" ? (value ? 1 : 0) : value;

  const macroMatch = /^vst:macro\.(\d+)$/.exec(id);
  if (macroMatch) {
    const n = parseInt(macroMatch[1], 10);
    if (n >= 1 && n <= VST_MACRO_COUNT) {
      macros[n - 1] = clamp(num, 0, 100);
      publishLocalDawValue(id, macros[n - 1]);
    }
    return;
  }

  const lfoMatch = /^vst:lfo\.(\d+)\.(rate|depth|shape)$/.exec(id);
  if (lfoMatch) {
    const n = parseInt(lfoMatch[1], 10);
    if (n >= 1 && n <= VST_LFO_COUNT) {
      const lfo = lfos[n - 1];
      if (lfoMatch[2] === "rate") lfo.rate = clamp(num, 0.05, 20);
      else if (lfoMatch[2] === "depth") lfo.depth = clamp(num, 0, 100);
      else lfo.shape = clamp(Math.round(num), 0, VST_LFO_SHAPES.length - 1);
    }
    return;
  }

  switch (id) {
    case "vst:mod.random.rate":
      random.rate = clamp(num, 0.1, 20);
      return;
    case "vst:transport.play":
      transport.playing = truthyControl(value);
      publishLocalDawValue("vst:transport.playing", transport.playing);
      return;
    case "vst:transport.stop":
      // Momentary pad: any press stops (release edges are 0 and harmless).
      if (truthyControl(value)) {
        transport.playing = false;
        publishLocalDawValue("vst:transport.playing", false);
      }
      return;
    case "vst:transport.rtz":
      if (truthyControl(value)) transport.playheadSec = 0;
      return;
    case "vst:transport.record":
      transport.recording = truthyControl(value);
      return;
    case "vst:transport.loop":
      transport.loop = truthyControl(value);
      return;
    case "vst:transport.metronome":
      transport.metronome = truthyControl(value);
      return;
    case "vst:transport.tempo":
      transport.tempo = clamp(num, 20, 300);
      publishLocalDawValue(id, transport.tempo);
      return;
    case "vst:transport.tap": {
      if (!truthyControl(value)) return;
      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      // Drop stale taps (>3s gap = a new tap sequence), keep the last 4.
      const taps = transport.tapTimes.filter((t) => now - t < 3000);
      taps.push(now);
      transport.tapTimes = taps.slice(-4);
      if (transport.tapTimes.length >= 2) {
        const ts = transport.tapTimes;
        const avgMs = (ts[ts.length - 1] - ts[0]) / (ts.length - 1);
        transport.tempo = clamp(60000 / avgMs, 20, 300);
        publishLocalDawValue("vst:transport.tempo", transport.tempo);
      }
      return;
    }
    default:
      // MIDI / presets / plugin master: no preview-local state. The bus
      // forward (theDAW) and the exported shell own these — by design.
      return;
  }
}

// Register with the bus as soon as this module loads. dawControlBus stores the
// function without calling it, so the (type-erased) import cycle is safe.
setVstWriteHandler(handleVstBindWrite);

// ---------------------------------------------------------------------------
// The tick — advance oscillators + transport, publish to active listeners.
// ---------------------------------------------------------------------------

/**
 * Advance all runtime state by dt seconds and publish live values. Exported
 * for tests; production calls it from the rAF loop.
 */
export function tickVstBindRuntime(dtSec: number): void {
  const dt = clamp(dtSec, 0, 0.25); // a background-tab pause never jumps state

  for (let i = 0; i < lfos.length; i++) {
    const lfo = lfos[i];
    const prevPhase = lfo.phase;
    lfo.phase = (lfo.phase + dt * lfo.rate) % 1;
    if (VST_LFO_SHAPES[lfo.shape] === "s&h") {
      // New hold value on every phase wrap.
      if (lfo.phase < prevPhase) {
        const bipolar = Math.random() * 2 - 1;
        lfo.held = 50 + bipolar * 50 * (clamp(lfo.depth, 0, 100) / 100);
      }
    } else {
      lfo.held = lfoValue(VST_LFO_SHAPES[lfo.shape] ?? "sine", lfo.phase, lfo.depth);
    }
    const id = `vst:lfo.${i + 1}`;
    if (hasDawValueListeners(id)) publishLocalDawValue(id, lfo.held);
  }

  const prevRandomPhase = random.phase;
  random.phase = (random.phase + dt * random.rate) % 1;
  if (random.phase < prevRandomPhase) {
    random.value = Math.random() * 100;
    if (hasDawValueListeners("vst:mod.random")) {
      publishLocalDawValue("vst:mod.random", random.value);
    }
  }

  if (transport.playing) {
    transport.playheadSec += dt;
    const beats = (transport.playheadSec * transport.tempo) / 60;
    if (hasDawValueListeners("vst:transport.beat")) {
      publishLocalDawValue("vst:transport.beat", beats % 1);
    }
    if (hasDawValueListeners("vst:transport.bar")) {
      publishLocalDawValue("vst:transport.bar", (beats / 4) % 1); // 4/4
    }
    if (hasDawValueListeners("vst:transport.playhead")) {
      publishLocalDawValue("vst:transport.playhead", clamp(transport.playheadSec, 0, 600));
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let running = false;
let rafId = 0;
let lastTs = 0;

/**
 * Start the runtime's rAF loop. Idempotent; browser-only (a jsdom/test import
 * registers the write handler but never animates unless ticked manually).
 */
export function startVstBindRuntime(): void {
  if (running || typeof window === "undefined" || !window.requestAnimationFrame) return;
  running = true;
  lastTs = 0;
  const loop = (ts: number) => {
    if (!running) return;
    if (lastTs > 0) tickVstBindRuntime((ts - lastTs) / 1000);
    lastTs = ts;
    rafId = window.requestAnimationFrame(loop);
  };
  rafId = window.requestAnimationFrame(loop);
}

/** Stop the loop (tests / teardown). State is kept. */
export function stopVstBindRuntime(): void {
  running = false;
  if (rafId && typeof window !== "undefined") window.cancelAnimationFrame(rafId);
  rafId = 0;
}

/** Test-only view of the internal state (read-only use). */
export function __vstRuntimeState() {
  return { lfos, macros, random, transport };
}
