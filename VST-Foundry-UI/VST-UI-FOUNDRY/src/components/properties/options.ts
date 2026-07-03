import { UIElement } from "../../types";

/**
 * Shared select-option data used by both PropertiesPanel and
 * CompactElementProperties. These arrays were byte-for-byte duplicated across
 * the two panels; they are centralised here so the CustomSelect call sites stay
 * identical while removing the duplication.
 */

export interface SelectOption {
  value: string;
  label: string;
}

/** Full CSS mix-blend-mode set (used for element layer blending). */
export const BLEND_MODE_OPTIONS: SelectOption[] = [
  { value: "normal", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "color-dodge", label: "Color Dodge" },
  { value: "color-burn", label: "Color Burn" },
  { value: "hard-light", label: "Hard Light" },
  { value: "soft-light", label: "Soft Light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
  { value: "hue", label: "Hue" },
  { value: "saturation", label: "Saturation" },
  { value: "color", label: "Color" },
  { value: "luminosity", label: "Luminosity" },
];

/** Reduced blend-mode set used for texture blending (no hue/sat/color/lum). */
export const TEXTURE_BLEND_MODE_OPTIONS: SelectOption[] = [
  { value: "normal", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "color-dodge", label: "Color Dodge" },
  { value: "color-burn", label: "Color Burn" },
  { value: "hard-light", label: "Hard Light" },
  { value: "soft-light", label: "Soft Light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
];

/** Animation-effect options shared by both panels. */
export const EFFECT_OPTIONS: SelectOption[] = [
  { value: "none", label: "None" },
  { value: "pulsing", label: "Pulsing (Continuous)" },
  { value: "breathing", label: "Breathing (Slow Pulse)" },
  { value: "flickering", label: "Flicker (Neon Flicker)" },
  { value: "orbital", label: "Orbital Glow" },
  { value: "floating", label: "Floating / Bobbing" },
  { value: "audioReactive", label: "Audio Reactive (Simulated)" },
];

/**
 * Collapse the stored `glowStyle` (which may hold legacy values) down to the
 * three options actually exposed in the glow-style selects. Extracted verbatim
 * from the identical inline expression in both panels.
 */
export function normalizeGlowStyle(
  glowStyle: UIElement["glowStyle"],
): string {
  return glowStyle === "solid" || glowStyle === "neon"
    ? "outer"
    : glowStyle === "radial"
      ? "center"
      : glowStyle || "outer";
}
