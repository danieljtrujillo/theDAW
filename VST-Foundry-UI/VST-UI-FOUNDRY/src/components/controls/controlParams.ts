/**
 * Per-control adjustable parameter schemas (the "make everything customizable"
 * layer). One declaration here does three jobs:
 *   1. The properties panels render an editor per param (number/color/toggle/
 *      select) in a generated "Control Parameters" section.
 *   2. Control components read live values via styleParam(el, key, default).
 *   3. Values persist in el.styleParams — serialized whole with the element,
 *      so autosave / project save / zip export need zero changes.
 *
 * Conventions:
 *   - `variants` limits a param to specific variants of the type (omit = all).
 *   - Percent-ish params use 0–100 numbers; angles are degrees; counts are ints.
 *   - Every param MUST have a default — controls must render identically to
 *     their pre-parameterization look when styleParams is absent.
 */
import type { ElementType, UIElement } from "../../types";

export interface ControlParamDef {
  key: string;
  label: string;
  type: "number" | "color" | "toggle" | "select";
  min?: number;
  max?: number;
  step?: number;
  default: number | string | boolean;
  options?: string[]; // select type
  /** Only show for these variants of the element type (omit = all variants). */
  variants?: string[];
}

export const CONTROL_PARAMS: Partial<Record<ElementType, ControlParamDef[]>> = {
  Knob: [
    { key: "sweepAngle", label: "Sweep Angle", type: "number", min: 90, max: 360, step: 5, default: 270 },
    { key: "capSize", label: "Cap Size %", type: "number", min: 50, max: 100, step: 1, default: 100 },
    { key: "indicatorLength", label: "Indicator Length %", type: "number", min: 20, max: 100, step: 1, default: 60 },
    { key: "indicatorThickness", label: "Indicator Thickness", type: "number", min: 1, max: 10, step: 1, default: 3 },
    { key: "tickCount", label: "Tick Marks", type: "number", min: 0, max: 24, step: 1, default: 0 },
    { key: "showValueArc", label: "Value Arc", type: "toggle", default: true, variants: ["Aluminum"] },
    { key: "arcThickness", label: "Arc Thickness", type: "number", min: 1, max: 10, step: 1, default: 3, variants: ["Aluminum"] },
    { key: "bezelWidth", label: "Bezel Width", type: "number", min: 0, max: 14, step: 1, default: 4, variants: ["Aluminum", "Glass"] },
    { key: "brushIntensity", label: "Brush Intensity %", type: "number", min: 0, max: 100, step: 1, default: 50, variants: ["Aluminum"] },
    { key: "ledSegments", label: "LED Segments", type: "number", min: 6, max: 32, step: 1, default: 15, variants: ["LED Ring"] },
    { key: "ledUnlitOpacity", label: "Unlit LED %", type: "number", min: 0, max: 60, step: 1, default: 15, variants: ["LED Ring"] },
    { key: "pointerWidth", label: "Pointer Width %", type: "number", min: 10, max: 60, step: 1, default: 30, variants: ["Vintage"] },
    { key: "domeOpacity", label: "Dome Opacity %", type: "number", min: 10, max: 100, step: 1, default: 60, variants: ["Glass"] },
    { key: "glowStrength", label: "Glow Strength %", type: "number", min: 0, max: 100, step: 1, default: 50, variants: ["Glass", "LED Ring"] },
    // Image-face params — surfaced only when el.faceSrc is set (the C2 contract;
    // the panel hides face* keys otherwise). The universal trio governs every
    // face-aware type; the two Knob-specific keys pick rotate-vs-static image
    // motion and whether the variant's indicator still draws over the image.
    // Unscoped by design: a face applies to all variants of the type.
    { key: "faceFit", label: "Face Fit", type: "select", options: ["contain", "cover", "fill"], default: "contain" },
    { key: "faceOpacity", label: "Face Opacity %", type: "number", min: 0, max: 100, step: 1, default: 100 },
    { key: "faceHideBase", label: "Hide Base Render", type: "toggle", default: true },
    { key: "faceMode", label: "Face Mode", type: "select", options: ["rotate", "static"], default: "rotate" },
    { key: "faceShowIndicator", label: "Show Indicator", type: "toggle", default: false },
  ],
  Slider: [
    { key: "trackWidth", label: "Track Width %", type: "number", min: 10, max: 100, step: 1, default: 40, variants: ["Blank"] },
    { key: "capWidth", label: "Cap Width %", type: "number", min: 40, max: 100, step: 1, default: 90, variants: ["Blank"] },
    { key: "capHeight", label: "Cap Height", type: "number", min: 8, max: 48, step: 1, default: 20, variants: ["Blank"] },
    { key: "tickCount", label: "Tick Marks", type: "number", min: 0, max: 20, step: 1, default: 0 },
    { key: "showTicks", label: "Show Tick Scale", type: "toggle", default: true, variants: ["Channel Fader"] },
    { key: "railDepth", label: "Rail Depth", type: "number", min: 1, max: 12, step: 1, default: 4, variants: ["Channel Fader"] },
    { key: "glowStrength", label: "Glow Strength %", type: "number", min: 0, max: 100, step: 1, default: 60, variants: ["LED Slider"] },
    { key: "fillFromCenter", label: "Fill From Center", type: "toggle", default: true, variants: ["Bipole"] },
    { key: "wheelGrooves", label: "Wheel Grooves", type: "number", min: 4, max: 20, step: 1, default: 8, variants: ["Mod Wheel", "Pitch Wheel"] },
    { key: "wellDepth", label: "Well Depth", type: "number", min: 1, max: 10, step: 1, default: 4, variants: ["Mod Wheel", "Pitch Wheel"] },
    // Image-face params — surfaced only when el.faceSrc is set (C2). Universal
    // trio + Slider role: "thumb" rides bottom:val% like every fader cap,
    // "track" pins the image and draws the variant's thumb on top. Unscoped.
    { key: "faceFit", label: "Face Fit", type: "select", options: ["contain", "cover", "fill"], default: "contain" },
    { key: "faceOpacity", label: "Face Opacity %", type: "number", min: 0, max: 100, step: 1, default: 100 },
    { key: "faceHideBase", label: "Hide Base Render", type: "toggle", default: true },
    { key: "faceRole", label: "Face Role", type: "select", options: ["thumb", "track"], default: "thumb" },
    { key: "faceThumbSize", label: "Thumb Size %", type: "number", min: 10, max: 100, step: 1, default: 60 },
  ],
  Meter: [
    { key: "segmentCount", label: "Segments", type: "number", min: 6, max: 32, step: 1, default: 14, variants: ["LED Segments"] },
    { key: "segmentGap", label: "Segment Gap", type: "number", min: 0, max: 6, step: 1, default: 1, variants: ["LED Segments"] },
    { key: "yellowStart", label: "Amber Zone Start %", type: "number", min: 30, max: 90, step: 1, default: 60, variants: ["LED Segments"] },
    { key: "redStart", label: "Red Zone Start %", type: "number", min: 60, max: 98, step: 1, default: 85, variants: ["LED Segments"] },
    { key: "zoneGreen", label: "Low Zone Color", type: "color", default: "#22c55e", variants: ["LED Segments"] },
    { key: "zoneAmber", label: "Mid Zone Color", type: "color", default: "#f59e0b", variants: ["LED Segments"] },
    { key: "zoneRed", label: "Hot Zone Color", type: "color", default: "#ef4444", variants: ["LED Segments"] },
    { key: "bezelWidth", label: "Bezel Width", type: "number", min: 0, max: 10, step: 1, default: 1 },
    { key: "needleThickness", label: "Needle Thickness", type: "number", min: 1, max: 8, step: 1, default: 2, variants: ["VU Meter"] },
    // Image-face params — surfaced only when el.faceSrc is set (C2). Universal
    // trio + Meter mode: "fill" clips the image bottom-up by val% (clip-path
    // inset from top), "static" just shows it (routes/LISTEN still drive val).
    { key: "faceFit", label: "Face Fit", type: "select", options: ["contain", "cover", "fill"], default: "contain" },
    { key: "faceOpacity", label: "Face Opacity %", type: "number", min: 0, max: 100, step: 1, default: 100 },
    { key: "faceHideBase", label: "Hide Base Render", type: "toggle", default: true },
    { key: "faceMode", label: "Face Mode", type: "select", options: ["fill", "static"], default: "fill" },
  ],
  Button: [
    { key: "bezelWidth", label: "Bezel Width", type: "number", min: 0, max: 12, step: 1, default: 3, variants: ["LED Push", "Chrome"] },
    { key: "pressDepth", label: "Press Depth", type: "number", min: 1, max: 8, step: 1, default: 2, variants: ["LED Push", "Blank"] },
    { key: "labelSize", label: "Label Size", type: "number", min: 8, max: 24, step: 1, default: 12 },
    { key: "ledStripHeight", label: "LED Strip Height", type: "number", min: 2, max: 12, step: 1, default: 4, variants: ["LED Push"] },
    { key: "glowStrength", label: "Glow Strength %", type: "number", min: 0, max: 100, step: 1, default: 60, variants: ["LED Push", "Chrome"] },
    // Image-face params — surfaced only when el.faceSrc is set (C2). Universal
    // trio + Button pressed-state feedback. facePressedSrc (the swap-image URL)
    // is written into styleParams by code and has no editor here by design; the
    // panel shows a note for it instead.
    { key: "faceFit", label: "Face Fit", type: "select", options: ["contain", "cover", "fill"], default: "contain" },
    { key: "faceOpacity", label: "Face Opacity %", type: "number", min: 0, max: 100, step: 1, default: 100 },
    { key: "faceHideBase", label: "Hide Base Render", type: "toggle", default: true },
    { key: "facePressed", label: "Pressed Effect", type: "select", options: ["brightness", "scale", "offset", "swap"], default: "brightness" },
    { key: "facePressedAmount", label: "Pressed Amount %", type: "number", min: 0, max: 100, step: 1, default: 30 },
  ],
  Toggle: [
    { key: "switchScale", label: "Switch Size %", type: "number", min: 50, max: 100, step: 1, default: 100 },
    { key: "leverAngle", label: "Lever Throw °", type: "number", min: 10, max: 50, step: 1, default: 24, variants: ["Lever"] },
    { key: "showLegends", label: "I/O Legends", type: "toggle", default: true, variants: ["Rocker"] },
    { key: "housingDepth", label: "Housing Depth", type: "number", min: 1, max: 10, step: 1, default: 3, variants: ["Rocker", "Lever"] },
    { key: "glowStrength", label: "On-Glow Strength %", type: "number", min: 0, max: 100, step: 1, default: 50, variants: ["Rocker", "Lever"] },
    // Image-face params — surfaced only when el.faceSrc is set (C2). Universal
    // trio + Toggle on-state feedback. faceOnSrc (the swap-image URL) is a
    // code-set styleParams key with no editor, mirroring Button's facePressedSrc.
    { key: "faceFit", label: "Face Fit", type: "select", options: ["contain", "cover", "fill"], default: "contain" },
    { key: "faceOpacity", label: "Face Opacity %", type: "number", min: 0, max: 100, step: 1, default: 100 },
    { key: "faceHideBase", label: "Hide Base Render", type: "toggle", default: true },
    { key: "faceOn", label: "On Effect", type: "select", options: ["brightness", "tint", "swap"], default: "brightness" },
    { key: "faceOnAmount", label: "On Amount %", type: "number", min: 0, max: 100, step: 1, default: 30 },
  ],
  XYPad: [
    // Legacy: default/Kaoss/Radar pads had NO grid; Crosshair ships with 10.
    { key: "gridDivisions", label: "Grid Divisions", type: "number", min: 0, max: 12, step: 1, default: 0 },
    { key: "gridDivisions", label: "Grid Divisions", type: "number", min: 0, max: 12, step: 1, default: 10, variants: ["Crosshair"] },
    { key: "gridOpacity", label: "Grid Opacity %", type: "number", min: 0, max: 40, step: 1, default: 8, variants: ["Crosshair"] },
    { key: "crosshairOpacity", label: "Crosshair Opacity %", type: "number", min: 0, max: 100, step: 1, default: 40, variants: ["Crosshair"] },
    { key: "dotSize", label: "Dot Size", type: "number", min: 6, max: 32, step: 1, default: 12 },
    { key: "trailEcho", label: "Motion Trail", type: "toggle", default: true, variants: ["Crosshair"] },
    // Blank renders no glow layer by design — scope the editor to the variants
    // that actually draw one so the panel never shows an inert control.
    { key: "glowStrength", label: "Dot Glow %", type: "number", min: 0, max: 100, step: 1, default: 60, variants: ["Kaoss", "Crosshair"] },
    // Image-face params — surfaced only when el.faceSrc is set (C2). Universal
    // trio + XY role: "puck" tracks the dot at left:xVal% / top:(100-yVal)%,
    // "background" fills the pad behind the variant's own puck. Unscoped.
    { key: "faceFit", label: "Face Fit", type: "select", options: ["contain", "cover", "fill"], default: "contain" },
    { key: "faceOpacity", label: "Face Opacity %", type: "number", min: 0, max: 100, step: 1, default: 100 },
    { key: "faceHideBase", label: "Hide Base Render", type: "toggle", default: true },
    { key: "faceRole", label: "Face Role", type: "select", options: ["puck", "background"], default: "puck" },
    { key: "facePuckSize", label: "Puck Size %", type: "number", min: 5, max: 50, step: 1, default: 20 },
  ],
  Waveform: [
    { key: "barCount", label: "Bars", type: "number", min: 8, max: 96, step: 1, default: 10, variants: ["Modern"] },
    { key: "lineThickness", label: "Line Thickness", type: "number", min: 1, max: 8, step: 1, default: 2 },
    // amplitude has per-variant legacy defaults — one def per scope (styleParam
    // and paramsForElement both prefer the variant-scoped def for a key).
    { key: "amplitude", label: "Amplitude %", type: "number", min: 10, max: 100, step: 1, default: 50, variants: ["Oscilloscope"] },
    { key: "amplitude", label: "Amplitude %", type: "number", min: 10, max: 100, step: 1, default: 90, variants: ["Modern"] },
    { key: "amplitude", label: "Amplitude %", type: "number", min: 10, max: 100, step: 1, default: 70, variants: ["LFO Sine", "LFO Triangle", "LFO Saw", "LFO Square", "LFO S&H"] },
    { key: "amplitude", label: "Amplitude %", type: "number", min: 10, max: 100, step: 1, default: 70, variants: ["Blank"] },
    { key: "mirror", label: "Mirror", type: "toggle", default: false, variants: ["Modern"] },
    { key: "cycles", label: "Cycles", type: "number", min: 1, max: 8, step: 1, default: 2, variants: ["LFO Sine", "LFO Triangle", "LFO Saw", "LFO Square", "LFO S&H"] },
    { key: "phase", label: "Phase %", type: "number", min: 0, max: 100, step: 1, default: 0, variants: ["LFO Sine", "LFO Triangle", "LFO Saw", "LFO Square", "LFO S&H"] },
  ],
  Label: [
    // Legacy looks: Standard 12px/left, Mono ("Retrofuturism" palette entry)
    // 10px/uppercase, LCD 16px/center. Variant-scoped defs carry the split.
    { key: "fontSize", label: "Font Size", type: "number", min: 8, max: 64, step: 1, default: 12 },
    { key: "fontSize", label: "Font Size", type: "number", min: 8, max: 64, step: 1, default: 10, variants: ["Retrofuturism"] },
    { key: "fontSize", label: "Font Size", type: "number", min: 8, max: 64, step: 1, default: 16, variants: ["LCD"] },
    { key: "fontWeight", label: "Weight", type: "select", options: ["normal", "medium", "bold"], default: "normal", variants: ["Blank", "Scandinavian Modern", "Retrofuturism", "Mid-century Modern"] },
    { key: "align", label: "Align", type: "select", options: ["left", "center", "right"], default: "left" },
    { key: "align", label: "Align", type: "select", options: ["left", "center", "right"], default: "center", variants: ["LCD"] },
    // letterSpacing legacy split: Retrofuturism (Mono) tracks at 1.6px, the other
    // text variants at 0. The Retrofuturism-scoped def is declared first so it
    // wins scoped-first resolution; LCD is excluded (its tracking is hard-coded).
    { key: "letterSpacing", label: "Letter Spacing", type: "number", min: 0, max: 12, step: 0.1, default: 1.6, variants: ["Retrofuturism"] },
    { key: "letterSpacing", label: "Letter Spacing", type: "number", min: 0, max: 12, step: 1, default: 0, variants: ["Blank", "Scandinavian Modern", "Mid-century Modern"] },
    { key: "uppercase", label: "Uppercase", type: "toggle", default: false, variants: ["Blank", "Scandinavian Modern", "Mid-century Modern"] },
    { key: "uppercase", label: "Uppercase", type: "toggle", default: true, variants: ["Retrofuturism"] },
    { key: "lcdGlow", label: "LCD Glow %", type: "number", min: 0, max: 100, step: 1, default: 40, variants: ["LCD"] },
  ],
  Select: [
    { key: "fontSize", label: "Font Size", type: "number", min: 8, max: 24, step: 1, default: 12 },
    { key: "chevronSize", label: "Chevron Size", type: "number", min: 4, max: 16, step: 1, default: 8 },
  ],
  Spatial3D: [
    // Legacy: two rings at 1/3 + 2/3 = 3 divisions; dot was 8px.
    { key: "gridDivisions", label: "Grid Divisions", type: "number", min: 0, max: 12, step: 1, default: 3 },
    { key: "dotSize", label: "Dot Size", type: "number", min: 6, max: 32, step: 1, default: 8 },
    // Blank renders no glow layer — editor scoped to the glowing variant only.
    { key: "glowStrength", label: "Dot Glow %", type: "number", min: 0, max: 100, step: 1, default: 60, variants: ["Radar"] },
  ],
  WaveShaper: [
    { key: "symmetry", label: "Symmetry %", type: "number", min: 0, max: 100, step: 1, default: 50, variants: ["Tube Drive"] },
    { key: "gridOpacity", label: "Grid Opacity %", type: "number", min: 0, max: 40, step: 1, default: 10 },
    { key: "curveThickness", label: "Curve Thickness", type: "number", min: 1, max: 8, step: 1, default: 3 },
    { key: "fillUnderCurve", label: "Fill Under Curve", type: "toggle", default: true },
  ],
  Envelope: [
    { key: "attack", label: "Attack", type: "number", min: 0, max: 100, step: 1, default: 15 },
    { key: "decay", label: "Decay", type: "number", min: 0, max: 100, step: 1, default: 30 },
    { key: "sustain", label: "Sustain", type: "number", min: 0, max: 100, step: 1, default: 70 },
    { key: "release", label: "Release", type: "number", min: 0, max: 100, step: 1, default: 25 },
    { key: "curveTension", label: "Curve Tension", type: "number", min: 0, max: 100, step: 1, default: 30 },
    { key: "showGrid", label: "Show Grid", type: "toggle", default: true },
  ],
  StepSequencer: [
    { key: "rows", label: "Rows", type: "number", min: 1, max: 8, step: 1, default: 4 },
    { key: "steps", label: "Steps", type: "number", min: 4, max: 32, step: 1, default: 16 },
    { key: "cellGap", label: "Cell Gap", type: "number", min: 0, max: 6, step: 1, default: 2 },
    { key: "accentEvery", label: "Accent Every", type: "number", min: 2, max: 8, step: 1, default: 4 },
  ],
  Keyboard: [
    { key: "octaves", label: "Octaves", type: "number", min: 1, max: 4, step: 1, default: 2 },
    { key: "showLabels", label: "Show Labels", type: "toggle", default: false },
  ],
};

/**
 * Params applicable to an element (type + variant filtered). When a key has
 * both a variant-scoped def and an unscoped def (per-variant legacy defaults,
 * e.g. Waveform amplitude), the variant-scoped def wins so the panel shows the
 * default that variant actually renders with.
 */
export function paramsForElement(el: Pick<UIElement, "type" | "variant">): ControlParamDef[] {
  const defs = CONTROL_PARAMS[el.type];
  if (!defs) return [];
  const applicable = defs.filter(
    (d) => !d.variants || (el.variant !== undefined && d.variants.includes(el.variant)),
  );
  const byKey = new Map<string, ControlParamDef>();
  for (const d of applicable) {
    const prev = byKey.get(d.key);
    if (!prev || (d.variants && !prev.variants)) byKey.set(d.key, d);
  }
  return applicable.filter((d) => byKey.get(d.key) === d);
}

/**
 * Read one param. Resolution order:
 *   1. stored value (el.styleParams)
 *   2. variant-scoped schema default (matches el.variant)
 *   3. the CALLER's fallback — components pass their variant's legacy value,
 *      which must beat a generic unscoped schema default
 *   4. unscoped schema default
 * This ordering is what keeps every variant pixel-identical at defaults while
 * still letting the panel edit everything.
 */
export function styleParam<T extends number | string | boolean>(
  el: UIElement,
  key: string,
  fallback?: T,
): T {
  const stored = el.styleParams?.[key];
  if (stored !== undefined) return stored as T;
  const defs = CONTROL_PARAMS[el.type];
  if (defs) {
    const scoped = defs.find(
      (d) => d.key === key && d.variants && el.variant !== undefined && d.variants.includes(el.variant),
    );
    if (scoped) return scoped.default as T;
    if (fallback !== undefined) return fallback;
    const unscoped = defs.find((d) => d.key === key && !d.variants);
    if (unscoped) return unscoped.default as T;
  }
  return fallback as T;
}
