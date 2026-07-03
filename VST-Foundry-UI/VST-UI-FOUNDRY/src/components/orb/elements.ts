import type { ElementType } from "../../types";

// Canonical ElementType names keyed by lowercased, separator-stripped aliases.
// The addElements client tool tolerates loose type names from the model.
export const ELEMENT_TYPE_ALIASES: Record<string, ElementType> = {
  button: "Button",
  knob: "Knob",
  slider: "Slider",
  fader: "Slider",
  label: "Label",
  text: "Label",
  select: "Select",
  dropdown: "Select",
  toggle: "Toggle",
  switch: "Toggle",
  image: "Image",
  group: "Group",
  waveform: "Waveform",
  meter: "Meter",
  xypad: "XYPad",
  spatial3d: "Spatial3D",
  waveshaper: "WaveShaper",
  shaper: "WaveShaper",
  distortion: "WaveShaper",
  adsr: "Envelope",
  envelope: "Envelope",
  stepsequencer: "StepSequencer",
  sequencer: "StepSequencer",
  stepseq: "StepSequencer",
  keyboard: "Keyboard",
  piano: "Keyboard",
  frame: "Frame",
  panel: "Frame",
  backplate: "Frame",
  plate: "Frame",
  customcode: "CustomCode",
};

export function normalizeElementType(type: unknown): ElementType {
  if (typeof type === "string") {
    const key = type.toLowerCase().replace(/[\s_-]/g, "");
    if (ELEMENT_TYPE_ALIASES[key]) return ELEMENT_TYPE_ALIASES[key];
  }
  return "Knob";
}

// Top-level numeric UIElement fields the model may send as strings (for JSON
// schema validity). Coerced to real numbers before storage so default-value
// math (e.g. value = (min + max) / 2) and geometry never string-concatenate.
export const NUMERIC_ELEMENT_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "value",
  "min",
  "max",
  "rotation",
  "valueX",
  "valueY",
  "cornerRadius",
] as const;

// Mutate `obj` in place: coerce each numeric field to a finite number, dropping
// values that aren't numeric so downstream defaults still apply.
export function coerceNumericElementFields(obj: Record<string, any>): void {
  for (const f of NUMERIC_ELEMENT_FIELDS) {
    if (obj[f] === undefined) continue;
    const n = Number(obj[f]);
    if (Number.isFinite(n)) obj[f] = n;
    else delete obj[f];
  }
}
