import type { CSSProperties } from "react";

// Universal material "skins" — a layer of CSS-recipe material any element can
// wear, independent of its variant. A skin is expressed purely as CSS: an
// optional style applied to the element container itself (`containerStyle`) plus
// zero or more full-cover overlay layers (`overlayStyles`). The consuming
// dispatcher renders each overlay as an absolutely-positioned, full-cover div
// with `pointerEvents: "none"` and `borderRadius: "inherit"`, so the recipes
// here supply ONLY the visual properties (background, boxShadow, opacity,
// mixBlendMode, outline, …) and never positioning.
//
// Every recipe tints itself to the host element via CSS `color-mix()` using the
// element's base/active colors, so the same skin reads differently on a purple
// knob than on an amber button. Keep each recipe to 2–4 layers.

export interface SkinDef {
  id: string;
  label: string;
}

export interface SkinLayers {
  containerStyle?: CSSProperties;
  overlayStyles: CSSProperties[];
}

// Skin picklist. The "none" entry MUST stay first — settings UIs use it as the
// default / "no skin" option.
export const SKINS: SkinDef[] = [
  { id: "none", label: "None" },
  { id: "aluminum", label: "Aluminum" },
  { id: "chrome", label: "Chrome" },
  { id: "glass", label: "Glass" },
  { id: "bakelite", label: "Bakelite" },
  { id: "carbon", label: "Carbon Fiber" },
  { id: "matte", label: "Matte" },
  { id: "leather", label: "Leather" },
  { id: "led-glow", label: "LED Glow" },
];

// color-mix helper: blend `a` toward `b` by `pct`% of `a`. Use "transparent" as
// `b` to fade a color to nothing while preserving its hue.
const mix = (a: string, pct: number, b: string): string =>
  `color-mix(in srgb, ${a} ${pct}%, ${b})`;

const EMPTY: SkinLayers = { overlayStyles: [] };

/**
 * Resolve a skin id + the host element's colors into concrete CSS layers.
 * Returns `{ overlayStyles: [] }` for "none", undefined, or any unknown id.
 */
export function getSkinLayers(
  skinId: string | undefined,
  colors: { base: string; active: string },
): SkinLayers {
  const { base, active } = colors;

  switch (skinId) {
    // Brushed metal: fine vertical microlines + a soft vertical sheen, sitting
    // on a base-tinted metal gradient, finished with an inset edge bevel.
    case "aluminum":
      return {
        containerStyle: {
          background: `linear-gradient(180deg, ${mix(base, 55, "#c8ccd2")}, ${mix(base, 72, "#6a6e76")})`,
        },
        overlayStyles: [
          {
            background:
              "repeating-linear-gradient(90deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 1px, rgba(0,0,0,0.05) 1px, rgba(0,0,0,0.05) 2px)",
            mixBlendMode: "overlay",
            opacity: 0.85,
          },
          {
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 45%, rgba(0,0,0,0.16) 100%)",
          },
          {
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.3), inset 0 -1px 0 rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,255,255,0.05)",
          },
        ],
      };

    // High-polish chrome: a base "horizon" gradient, sweeping conic sheen bands,
    // a hard specular streak, and a dark edge ring for that mirror-metal read.
    case "chrome":
      return {
        containerStyle: {
          background: `linear-gradient(180deg, ${mix(base, 30, "#e8ecf2")} 0%, ${mix(base, 50, "#9aa0aa")} 45%, ${mix(base, 35, "#d0d5dd")} 55%, ${mix(base, 55, "#5a5f67")} 100%)`,
        },
        overlayStyles: [
          {
            background:
              "conic-gradient(from 210deg at 50% 40%, rgba(255,255,255,0) 0deg, rgba(255,255,255,0.35) 70deg, rgba(255,255,255,0) 150deg, rgba(255,255,255,0.28) 250deg, rgba(255,255,255,0) 330deg)",
            mixBlendMode: "screen",
            opacity: 0.6,
          },
          {
            background:
              "linear-gradient(120deg, rgba(255,255,255,0) 32%, rgba(255,255,255,0.85) 48%, rgba(255,255,255,0) 60%)",
            mixBlendMode: "screen",
            opacity: 0.7,
          },
          {
            boxShadow:
              "inset 0 0 0 1px rgba(0,0,0,0.5), inset 0 2px 3px rgba(255,255,255,0.55), inset 0 -3px 6px rgba(0,0,0,0.45)",
          },
        ],
      };

    // Translucent gloss: a top highlight ellipse over a low-opacity white film,
    // with an inner glow tinted to the element's active color.
    case "glass":
      return {
        overlayStyles: [
          {
            background:
              "radial-gradient(120% 80% at 50% -20%, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.08) 40%, rgba(255,255,255,0) 62%)",
          },
          {
            background: "rgba(255,255,255,0.06)",
            boxShadow: `inset 0 0 18px ${mix(active, 45, "transparent")}, inset 0 1px 0 rgba(255,255,255,0.4), inset 0 -6px 12px rgba(0,0,0,0.18)`,
          },
        ],
      };

    // Warm dark plastic: a radial warm-brown tint over the base, a fine speckle,
    // and a glossy top light.
    case "bakelite":
      return {
        overlayStyles: [
          {
            background: `radial-gradient(120% 120% at 50% 30%, ${mix(base, 55, "#3a2418")} 0%, ${mix(base, 40, "#1a0f08")} 100%)`,
          },
          {
            background:
              "radial-gradient(rgba(255,220,180,0.1) 0.5px, transparent 1px)",
            backgroundSize: "4px 4px",
            opacity: 0.5,
          },
          {
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 35%)",
          },
        ],
      };

    // Carbon fiber: two crossed repeating-linear-gradients form the twill weave
    // over a dark base tint, with a subtle diagonal sheen.
    case "carbon":
      return {
        containerStyle: {
          background: mix(base, 60, "#0a0a0c"),
        },
        overlayStyles: [
          {
            background:
              "repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 2px, transparent 2px, transparent 4px), repeating-linear-gradient(-45deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 2px, transparent 2px, transparent 4px)",
          },
          {
            background:
              "linear-gradient(105deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0) 40%)",
            mixBlendMode: "screen",
            opacity: 0.5,
          },
        ],
      };

    // Flat soft-touch: a desaturating dark film that kills gloss, plus a very
    // soft inner shadow for a hint of depth.
    case "matte":
      return {
        overlayStyles: [
          {
            background: mix(base, 40, "#0c0c0e"),
            mixBlendMode: "multiply",
            opacity: 0.55,
          },
          {
            boxShadow:
              "inset 0 0 12px rgba(0,0,0,0.35), inset 0 1px 1px rgba(255,255,255,0.04)",
          },
        ],
      };

    // Grain leather: a warm radial tint, layered radial-speckle pores, and a
    // dashed inset outline that suggests edge stitching.
    case "leather":
      return {
        overlayStyles: [
          {
            background: `radial-gradient(130% 130% at 50% 20%, ${mix(base, 45, "#5a3a22")} 0%, ${mix(base, 55, "#2a1810")} 100%)`,
          },
          {
            background:
              "radial-gradient(rgba(0,0,0,0.18) 0.5px, transparent 1.5px), radial-gradient(rgba(255,240,220,0.06) 0.5px, transparent 1.5px)",
            backgroundSize: "5px 5px, 7px 7px",
            backgroundPosition: "0 0, 2px 3px",
            opacity: 0.7,
          },
          {
            outline: `2px dashed ${mix(active, 40, "#d9c7a0")}`,
            outlineOffset: "-6px",
            opacity: 0.6,
          },
        ],
      };

    // Rim light: no fill film — just a strong inner + outer glow ring in the
    // element's active color.
    case "led-glow":
      return {
        overlayStyles: [
          {
            boxShadow: `inset 0 0 8px ${mix(active, 70, "transparent")}, inset 0 0 0 1.5px ${mix(active, 85, "transparent")}, 0 0 12px ${mix(active, 60, "transparent")}, 0 0 24px ${mix(active, 35, "transparent")}`,
          },
        ],
      };

    case "none":
    case undefined:
    default:
      return EMPTY;
  }
}
