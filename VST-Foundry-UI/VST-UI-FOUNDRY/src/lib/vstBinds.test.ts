/**
 * Built-in VST bind catalog + preview runtime tests.
 *
 * Covers the catalog's structural invariants (unique namespaced ids, full
 * MIDI coverage, kind vocabulary), the bus integration (catalog fallback in
 * getDawTarget, local dispatch from setDawTarget), and the runtime's signal
 * math (LFO shapes, macro writes, transport phase publishing).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  getVstBind,
  isVstBindId,
  midiNoteName,
  VST_BINDS,
  vstListenBinds,
  vstWriteBinds,
} from "./vstBinds";
import {
  getDawTarget,
  getDawValue,
  setDawTarget,
  subscribeDawValue,
} from "./dawControlBus";
import {
  __vstRuntimeState,
  handleVstBindWrite,
  lfoValue,
  tickVstBindRuntime,
  truthyControl,
} from "./vstBindRuntime";

// Kinds the pickers understand (bindableKindsFor / listenKindsFor filter on
// these) — a catalog entry outside this set would be invisible everywhere.
const KNOWN_KINDS = new Set(["knob", "fader", "button", "toggle", "pad"]);

describe("VST_BINDS catalog", () => {
  it("has unique, vst:-namespaced ids and known kinds throughout", () => {
    const seen = new Set<string>();
    for (const t of VST_BINDS) {
      expect(isVstBindId(t.id)).toBe(true);
      expect(seen.has(t.id)).toBe(false);
      seen.add(t.id);
      expect(KNOWN_KINDS.has(t.kind)).toBe(true);
      expect(t.area.length).toBeGreaterThan(0);
      expect(t.group.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it("covers the full MIDI CC and note ranges", () => {
    for (let n = 0; n <= 127; n++) {
      expect(getVstBind(`vst:midi.cc.${n}`)).toBeDefined();
      expect(getVstBind(`vst:midi.note.${n}`)).toBeDefined();
    }
    // Named CCs carry their conventional names.
    expect(getVstBind("vst:midi.cc.74")!.label).toContain("Cutoff");
    expect(getVstBind("vst:midi.cc.1")!.label).toContain("Mod Wheel");
  });

  it("is 'tons': several hundred entries across all areas", () => {
    expect(VST_BINDS.length).toBeGreaterThan(300);
    const areas = new Set(VST_BINDS.map((t) => t.area));
    for (const a of [
      "MIDI",
      "MIDI Notes",
      "Transport",
      "Plugin",
      "Presets",
      "Macros",
      "LFOs",
      "Metering",
    ]) {
      expect(areas.has(a)).toBe(true);
    }
  });

  it("partitions write vs listen correctly", () => {
    for (const t of vstWriteBinds()) expect(t.readonly).toBeFalsy();
    for (const t of vstListenBinds()) expect(t.listen).toBe(true);
    // Listen sources include the signal generators.
    const listenIds = new Set(vstListenBinds().map((t) => t.id));
    expect(listenIds.has("vst:lfo.1")).toBe(true);
    expect(listenIds.has("vst:macro.1")).toBe(true);
    expect(listenIds.has("vst:transport.beat")).toBe(true);
    expect(listenIds.has("vst:meter.out.l")).toBe(true);
    // Write targets include the classics.
    const writeIds = new Set(vstWriteBinds().map((t) => t.id));
    expect(writeIds.has("vst:midi.cc.74")).toBe(true);
    expect(writeIds.has("vst:transport.play")).toBe(true);
    expect(writeIds.has("vst:plugin.bypass")).toBe(true);
    expect(writeIds.has("vst:preset.next")).toBe(true);
  });

  it("names MIDI notes in C-2 origin convention", () => {
    expect(midiNoteName(0)).toBe("C-2");
    expect(midiNoteName(60)).toBe("C3");
    expect(midiNoteName(69)).toBe("A3");
    expect(midiNoteName(127)).toBe("G8");
  });
});

describe("dawControlBus integration", () => {
  it("getDawTarget falls back to the catalog for vst: ids", () => {
    const t = getDawTarget("vst:macro.3");
    expect(t).toBeDefined();
    expect(t!.label).toBe("Macro 3");
    expect(getDawTarget("not-a-real-id")).toBeUndefined();
  });

  it("setDawTarget on a vst: id updates the local runtime with no socket", () => {
    setDawTarget("vst:macro.2", 73);
    expect(__vstRuntimeState().macros[1]).toBe(73);
    expect(getDawValue("vst:macro.2")).toBe(73);
  });
});

describe("vstBindRuntime", () => {
  beforeEach(() => {
    const s = __vstRuntimeState();
    s.transport.playing = false;
    s.transport.tempo = 120;
    s.transport.playheadSec = 0;
    s.lfos[0].rate = 1;
    s.lfos[0].depth = 100;
    s.lfos[0].shape = 0;
    s.lfos[0].phase = 0;
  });

  it("lfoValue produces the expected shape samples", () => {
    expect(lfoValue("sine", 0, 100)).toBeCloseTo(50);
    expect(lfoValue("sine", 0.25, 100)).toBeCloseTo(100);
    expect(lfoValue("sine", 0.75, 100)).toBeCloseTo(0);
    expect(lfoValue("triangle", 0, 100)).toBeCloseTo(100);
    expect(lfoValue("triangle", 0.5, 100)).toBeCloseTo(0);
    expect(lfoValue("saw", 0.5, 100)).toBeCloseTo(50);
    expect(lfoValue("square", 0.25, 100)).toBeCloseTo(100);
    expect(lfoValue("square", 0.75, 100)).toBeCloseTo(0);
    // Depth scales around the 50 center.
    expect(lfoValue("sine", 0.25, 50)).toBeCloseTo(75);
    expect(lfoValue("sine", 0.25, 0)).toBeCloseTo(50);
  });

  it("truthyControl accepts booleans and scaled numerics", () => {
    expect(truthyControl(true)).toBe(true);
    expect(truthyControl(false)).toBe(false);
    expect(truthyControl(1)).toBe(true);
    expect(truthyControl(0.4)).toBe(false);
  });

  it("clamps LFO parameter writes into their declared ranges", () => {
    handleVstBindWrite("vst:lfo.1.rate", 999);
    expect(__vstRuntimeState().lfos[0].rate).toBe(20);
    handleVstBindWrite("vst:lfo.1.shape", 2);
    expect(__vstRuntimeState().lfos[0].shape).toBe(2);
    handleVstBindWrite("vst:lfo.1.shape", 99);
    expect(__vstRuntimeState().lfos[0].shape).toBe(4);
  });

  it("runs the transport: play state, tempo write, beat phase publish", () => {
    handleVstBindWrite("vst:transport.tempo", 120);
    handleVstBindWrite("vst:transport.play", true);
    expect(getDawValue("vst:transport.playing")).toBe(true);

    // Beat phase only publishes to active listeners.
    let beat = -1;
    const unsub = subscribeDawValue("vst:transport.beat", (v) => {
      beat = typeof v === "number" ? v : -1;
    });
    tickVstBindRuntime(0.25); // 0.25s @ 120BPM = half a beat
    expect(beat).toBeCloseTo(0.5);
    unsub();

    handleVstBindWrite("vst:transport.stop", 1);
    expect(getDawValue("vst:transport.playing")).toBe(false);
    handleVstBindWrite("vst:transport.rtz", 1);
    expect(__vstRuntimeState().transport.playheadSec).toBe(0);
  });

  it("publishes LFO output to listeners on tick", () => {
    handleVstBindWrite("vst:lfo.1.rate", 1);
    let out = -1;
    const unsub = subscribeDawValue("vst:lfo.1", (v) => {
      out = typeof v === "number" ? v : -1;
    });
    tickVstBindRuntime(0.25); // sine phase 0 → 0.25 = peak
    expect(out).toBeCloseTo(100, 1);
    unsub();
  });

  it("ignores ids with no local meaning (MIDI / presets) without throwing", () => {
    expect(() => handleVstBindWrite("vst:midi.cc.74", 64)).not.toThrow();
    expect(() => handleVstBindWrite("vst:preset.next", 1)).not.toThrow();
  });
});
