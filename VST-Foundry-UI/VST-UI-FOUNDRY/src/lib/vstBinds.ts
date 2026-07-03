/**
 * Built-in VST bind catalog — "anything a VST UI element can be coded to do."
 *
 * theDAW's XR manifest only publishes targets theDAW implements TODAY. This
 * catalog adds a large, always-available vocabulary of classic VST-plugin
 * bind targets that exist AHEAD of native theDAW support: MIDI (every CC,
 * every note, pitch bend, aftertouch, program change), host transport,
 * plugin-level controls (bypass / dry-wet / gain / pan), preset actions,
 * macro knobs, LFOs, modulation and metering sources.
 *
 * Entries are DawTarget-shaped (same picker/dispatch/scaling seams as live
 * manifest targets) with ids namespaced `vst:`. Where each bind is HONORED:
 *
 *   preview  — src/lib/vstBindRuntime.ts computes it live inside Foundry
 *              (LFOs, macros, random S&H, local transport). Marked
 *              `preview: true`.
 *   daw      — every `vst:` write is ALSO forwarded over the XR control bus
 *              as a normal control-set frame, so theDAW can implement
 *              handlers progressively without Foundry changing. Unknown ids
 *              are ignored by today's host — by design.
 *   shell    — the exported FoundryShell honors the MIDI family natively
 *              (SendMidiMsg), applies plugin gain/pan in its DSP, and pushes
 *              transport/meter listen values from the host's ITimeInfo and
 *              its own RMS metering (see manifest `bindings` in
 *              vst3Export.ts). Binds the shell does not implement yet are
 *              carried in the manifest and ignored — never an error.
 *
 * LISTEN sources marked `readonly` can never be written (isWritableTarget
 * excludes them); `listen: true` marks entries the ListenPicker offers as a
 * display element's live source. Entries that currently have NO live
 * publisher anywhere (spectrum bands, gain reduction) still exist — that is
 * the point of the catalog — and simply read 0 until a publisher lands.
 *
 * NOTE: `import type` only — this module must stay import-cycle-free at
 * runtime because dawControlBus imports it for target resolution.
 */
import type { DawTarget } from "./dawControlBus";

/** Namespace prefix for every built-in bind id. */
export const VST_BIND_PREFIX = "vst:";

/** True when a target id names a built-in VST bind (vs a live theDAW id). */
export function isVstBindId(id: string | undefined): boolean {
  return !!id && id.startsWith(VST_BIND_PREFIX);
}

/** One catalog entry: a DawTarget plus catalog-only metadata. */
export interface VstBindTarget extends DawTarget {
  /** Offered by the ListenPicker as a display element's live source. */
  listen?: boolean;
  /** Animated live by the in-app preview runtime (vstBindRuntime). */
  preview?: boolean;
}

// ---------------------------------------------------------------------------
// MIDI — every CC, every note, pitch bend, aftertouch, program change.
// ---------------------------------------------------------------------------

// Standard MIDI CC names (General MIDI / MIDI 1.0 spec conventions). CCs not
// listed are labeled plain "CC n". 32–63 are the LSB pair of 0–31 and are
// still bindable — a synth may listen on them directly.
const CC_NAMES: Record<number, string> = {
  0: "Bank Select",
  1: "Mod Wheel",
  2: "Breath",
  4: "Foot Controller",
  5: "Portamento Time",
  6: "Data Entry MSB",
  7: "Channel Volume",
  8: "Balance",
  10: "Pan",
  11: "Expression",
  12: "Effect Ctrl 1",
  13: "Effect Ctrl 2",
  16: "General Purpose 1",
  17: "General Purpose 2",
  18: "General Purpose 3",
  19: "General Purpose 4",
  64: "Sustain Pedal",
  65: "Portamento On/Off",
  66: "Sostenuto",
  67: "Soft Pedal",
  68: "Legato",
  69: "Hold 2",
  70: "Sound Variation",
  71: "Resonance",
  72: "Release Time",
  73: "Attack Time",
  74: "Cutoff / Brightness",
  75: "Decay Time",
  76: "Vibrato Rate",
  77: "Vibrato Depth",
  78: "Vibrato Delay",
  80: "General Purpose 5",
  81: "General Purpose 6",
  82: "General Purpose 7",
  83: "General Purpose 8",
  84: "Portamento Control",
  88: "Hi-Res Velocity",
  91: "Reverb Send",
  92: "Tremolo Depth",
  93: "Chorus Send",
  94: "Detune",
  95: "Phaser Depth",
  96: "Data Increment",
  97: "Data Decrement",
  98: "NRPN LSB",
  99: "NRPN MSB",
  100: "RPN LSB",
  101: "RPN MSB",
  120: "All Sound Off",
  121: "Reset All Controllers",
  122: "Local Control",
  123: "All Notes Off",
  124: "Omni Off",
  125: "Omni On",
  126: "Mono Mode",
  127: "Poly Mode",
};

/** "C-2".."G8" note naming (MIDI 0 = C-2 convention, 60 = C3, 69 = A3). */
export function midiNoteName(n: number): string {
  const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return `${NAMES[n % 12]}${Math.floor(n / 12) - 2}`;
}

function midiBinds(): VstBindTarget[] {
  const out: VstBindTarget[] = [];
  for (let n = 0; n <= 127; n++) {
    const name = CC_NAMES[n];
    out.push({
      id: `vst:midi.cc.${n}`,
      area: "MIDI",
      group: "Control Change",
      label: name ? `CC ${n} — ${name}` : `CC ${n}`,
      kind: "knob",
      min: 0,
      max: 127,
      step: 1,
    });
  }
  out.push(
    {
      id: "vst:midi.pitchbend",
      area: "MIDI",
      group: "Performance",
      label: "Pitch Bend",
      kind: "knob",
      min: -100,
      max: 100,
      unit: "%",
    },
    {
      id: "vst:midi.aftertouch",
      area: "MIDI",
      group: "Performance",
      label: "Channel Aftertouch",
      kind: "knob",
      min: 0,
      max: 127,
      step: 1,
    },
    {
      id: "vst:midi.program",
      area: "MIDI",
      group: "Performance",
      label: "Program Change",
      kind: "knob",
      min: 0,
      max: 127,
      step: 1,
    },
    {
      id: "vst:midi.panic",
      area: "MIDI",
      group: "Performance",
      label: "MIDI Panic (all sound + notes off)",
      kind: "pad",
    },
  );
  // Every playable note as a momentary pad (Button-bindable). Velocity is the
  // shaped route value at press time; release sends note-off.
  for (let n = 0; n <= 127; n++) {
    out.push({
      id: `vst:midi.note.${n}`,
      area: "MIDI Notes",
      group: `Octave ${Math.floor(n / 12) - 2}`,
      label: `Note ${midiNoteName(n)} (${n})`,
      kind: "pad",
      min: 0,
      max: 127,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transport — write requests + listen sources. Preview runs a LOCAL transport
// (play/tempo/beat phase) so designs animate offline; inside theDAW the same
// writes are forwarded on the bus; in the exported shell the LISTEN side is
// fed by the host's real ITimeInfo (a plugin cannot WRITE host transport in
// plain VST3 — those writes are daw-forwarded only).
// ---------------------------------------------------------------------------

function transportBinds(): VstBindTarget[] {
  return [
    { id: "vst:transport.play", area: "Transport", group: "Control", label: "Play / Pause", kind: "toggle", preview: true },
    { id: "vst:transport.stop", area: "Transport", group: "Control", label: "Stop", kind: "pad", preview: true },
    { id: "vst:transport.record", area: "Transport", group: "Control", label: "Record Arm", kind: "toggle", preview: true },
    { id: "vst:transport.loop", area: "Transport", group: "Control", label: "Loop", kind: "toggle", preview: true },
    { id: "vst:transport.metronome", area: "Transport", group: "Control", label: "Metronome", kind: "toggle", preview: true },
    { id: "vst:transport.rtz", area: "Transport", group: "Control", label: "Return to Zero", kind: "pad", preview: true },
    { id: "vst:transport.tap", area: "Transport", group: "Control", label: "Tap Tempo", kind: "pad", preview: true },
    { id: "vst:transport.tempo", area: "Transport", group: "Control", label: "Tempo", kind: "knob", min: 20, max: 300, unit: "BPM", listen: true, preview: true },
    // Listen-only signals (readonly ⇒ excluded from the write picker).
    { id: "vst:transport.playing", area: "Transport", group: "Signals", label: "Playing (state)", kind: "toggle", readonly: true, listen: true, preview: true },
    { id: "vst:transport.beat", area: "Transport", group: "Signals", label: "Beat Phase (ramp)", kind: "knob", min: 0, max: 1, readonly: true, listen: true, preview: true },
    { id: "vst:transport.bar", area: "Transport", group: "Signals", label: "Bar Phase (ramp)", kind: "knob", min: 0, max: 1, readonly: true, listen: true, preview: true },
    { id: "vst:transport.playhead", area: "Transport", group: "Signals", label: "Playhead (seconds)", kind: "knob", min: 0, max: 600, unit: "s", readonly: true, listen: true, preview: true },
  ];
}

// ---------------------------------------------------------------------------
// Plugin-level controls — the classic plugin header strip. gain.out / pan are
// applied by the exported shell's DSP; bypass / dry-wet ship in the manifest
// (meaningful once the shell hosts non-passthrough DSP) and daw-forward.
// ---------------------------------------------------------------------------

function pluginBinds(): VstBindTarget[] {
  return [
    { id: "vst:plugin.bypass", area: "Plugin", group: "Master", label: "Bypass", kind: "toggle" },
    { id: "vst:plugin.drywet", area: "Plugin", group: "Master", label: "Dry / Wet", kind: "knob", min: 0, max: 100, unit: "%" },
    { id: "vst:plugin.gain.in", area: "Plugin", group: "Master", label: "Input Gain", kind: "knob", min: -24, max: 24, unit: "dB" },
    { id: "vst:plugin.gain.out", area: "Plugin", group: "Master", label: "Output Gain", kind: "knob", min: -60, max: 12, unit: "dB" },
    { id: "vst:plugin.pan", area: "Plugin", group: "Master", label: "Pan", kind: "knob", min: -100, max: 100 },
  ];
}

// ---------------------------------------------------------------------------
// Preset actions — momentary pads (plus the A/B latch). No preview-local
// meaning (Foundry has no preset bank); daw-forwarded now, shell-honored when
// the shell grows preset slots.
// ---------------------------------------------------------------------------

function presetBinds(): VstBindTarget[] {
  return [
    { id: "vst:preset.next", area: "Presets", group: "Navigate", label: "Next Preset", kind: "pad" },
    { id: "vst:preset.prev", area: "Presets", group: "Navigate", label: "Previous Preset", kind: "pad" },
    { id: "vst:preset.save", area: "Presets", group: "Manage", label: "Save Preset", kind: "pad" },
    { id: "vst:preset.init", area: "Presets", group: "Manage", label: "Init / Reset Params", kind: "pad" },
    { id: "vst:preset.random", area: "Presets", group: "Manage", label: "Randomize Params", kind: "pad" },
    { id: "vst:preset.ab", area: "Presets", group: "Compare", label: "A/B Compare", kind: "toggle" },
    { id: "vst:preset.copyab", area: "Presets", group: "Compare", label: "Copy A → B", kind: "pad" },
  ];
}

// ---------------------------------------------------------------------------
// Macros — 8 virtual knobs held by the runtime. Write from any control, listen
// from any display: the mod-matrix hub (knob → macro → many destinations).
// ---------------------------------------------------------------------------

export const VST_MACRO_COUNT = 8;

function macroBinds(): VstBindTarget[] {
  const out: VstBindTarget[] = [];
  for (let n = 1; n <= VST_MACRO_COUNT; n++) {
    out.push({
      id: `vst:macro.${n}`,
      area: "Macros",
      group: "Macros",
      label: `Macro ${n}`,
      kind: "knob",
      min: 0,
      max: 100,
      listen: true,
      preview: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// LFOs + modulation sources — real oscillators in the preview runtime (and in
// the exported UI's injected runtime), so bound meters/scopes breathe with no
// audio engine at all.
// ---------------------------------------------------------------------------

export const VST_LFO_COUNT = 4;

/** Shape index → waveform, shared with vstBindRuntime + the exported UI. */
export const VST_LFO_SHAPES = ["sine", "triangle", "saw", "square", "s&h"] as const;

function lfoBinds(): VstBindTarget[] {
  const out: VstBindTarget[] = [];
  for (let n = 1; n <= VST_LFO_COUNT; n++) {
    out.push(
      { id: `vst:lfo.${n}`, area: "LFOs", group: `LFO ${n}`, label: `LFO ${n} Output`, kind: "knob", min: 0, max: 100, readonly: true, listen: true, preview: true },
      { id: `vst:lfo.${n}.rate`, area: "LFOs", group: `LFO ${n}`, label: `LFO ${n} Rate`, kind: "knob", min: 0.05, max: 20, unit: "Hz", preview: true },
      { id: `vst:lfo.${n}.depth`, area: "LFOs", group: `LFO ${n}`, label: `LFO ${n} Depth`, kind: "knob", min: 0, max: 100, unit: "%", preview: true },
      { id: `vst:lfo.${n}.shape`, area: "LFOs", group: `LFO ${n}`, label: `LFO ${n} Shape (${VST_LFO_SHAPES.join("/")})`, kind: "knob", min: 0, max: VST_LFO_SHAPES.length - 1, step: 1, preview: true },
    );
  }
  out.push(
    { id: "vst:mod.random", area: "LFOs", group: "Random", label: "Random S&H", kind: "knob", min: 0, max: 100, readonly: true, listen: true, preview: true },
    { id: "vst:mod.random.rate", area: "LFOs", group: "Random", label: "Random Rate", kind: "knob", min: 0.1, max: 20, unit: "Hz", preview: true },
    // Envelope follower: fed by the exported shell from its input RMS. No
    // audio in Foundry preview ⇒ silent there by design (never faked).
    { id: "vst:mod.envfollow", area: "LFOs", group: "Follower", label: "Envelope Follower (input)", kind: "knob", min: 0, max: 100, readonly: true, listen: true },
  );
  return out;
}

// ---------------------------------------------------------------------------
// Metering — listen sources. in/out RMS + peak + clip are computed by the
// exported shell's DSP and pushed to the UI; gain reduction and the spectrum
// bands have no publisher yet (they exist so designs can bind TODAY and light
// up the moment theDAW or the shell publishes them).
// ---------------------------------------------------------------------------

export const VST_METER_BAND_COUNT = 8;

function meterBinds(): VstBindTarget[] {
  const out: VstBindTarget[] = [
    { id: "vst:meter.in.l", area: "Metering", group: "Input", label: "In Level L", kind: "knob", min: 0, max: 100, readonly: true, listen: true },
    { id: "vst:meter.in.r", area: "Metering", group: "Input", label: "In Level R", kind: "knob", min: 0, max: 100, readonly: true, listen: true },
    { id: "vst:meter.out.l", area: "Metering", group: "Output", label: "Out Level L", kind: "knob", min: 0, max: 100, readonly: true, listen: true },
    { id: "vst:meter.out.r", area: "Metering", group: "Output", label: "Out Level R", kind: "knob", min: 0, max: 100, readonly: true, listen: true },
    { id: "vst:meter.out.peak", area: "Metering", group: "Output", label: "Out Peak", kind: "knob", min: 0, max: 100, readonly: true, listen: true },
    { id: "vst:meter.clip", area: "Metering", group: "Output", label: "Clip Indicator", kind: "toggle", readonly: true, listen: true },
    { id: "vst:meter.gr", area: "Metering", group: "Dynamics", label: "Gain Reduction", kind: "knob", min: 0, max: 100, readonly: true, listen: true },
  ];
  for (let n = 1; n <= VST_METER_BAND_COUNT; n++) {
    out.push({
      id: `vst:meter.band.${n}`,
      area: "Metering",
      group: "Spectrum",
      label: `Spectrum Band ${n}`,
      kind: "knob",
      min: 0,
      max: 100,
      readonly: true,
      listen: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The catalog.
// ---------------------------------------------------------------------------

/** Every built-in bind target, in stable display order. */
export const VST_BINDS: VstBindTarget[] = [
  ...transportBinds(),
  ...pluginBinds(),
  ...macroBinds(),
  ...lfoBinds(),
  ...presetBinds(),
  ...meterBinds(),
  ...midiBinds(),
];

// id → entry lookup (built once; the catalog is immutable).
const BY_ID = new Map<string, VstBindTarget>(VST_BINDS.map((t) => [t.id, t]));

/** Catalog lookup by id (undefined for live-manifest / unknown ids). */
export function getVstBind(id: string | undefined): VstBindTarget | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Writable catalog entries (the route browser's built-in section). */
export function vstWriteBinds(): VstBindTarget[] {
  return VST_BINDS.filter((t) => !t.readonly);
}

/** Listen-source catalog entries (the ListenPicker's built-in section). */
export function vstListenBinds(): VstBindTarget[] {
  return VST_BINDS.filter((t) => t.listen);
}
