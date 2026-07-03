import React from "react";
import type { UIElement } from "../../types";
import { styleParam } from "./controlParams";

interface LabelControlProps {
  el: UIElement;
  variant: string;
  /**
   * INBOUND element route → live readout text. When set it REPLACES the label
   * text in every variant; when undefined the render is byte-identical to the
   * static form (falls back to el.label || the variant's placeholder).
   */
  liveText?: string;
}

const FONT_WEIGHTS: Record<string, number> = {
  normal: 400,
  medium: 500,
  bold: 700,
};

/** Shared text-style params consumed by every Label variant. */
function textStyle(
  el: UIElement,
  fallbacks: {
    fontSize: number;
    align: string;
    letterSpacing: number;
    uppercase: boolean;
  },
): React.CSSProperties {
  const fontSize = styleParam(el, "fontSize", fallbacks.fontSize);
  const fontWeight = styleParam(el, "fontWeight", "normal");
  const align = styleParam(el, "align", fallbacks.align);
  const letterSpacing = styleParam(el, "letterSpacing", fallbacks.letterSpacing);
  const uppercase = styleParam(el, "uppercase", fallbacks.uppercase);
  return {
    fontSize: `${fontSize}px`,
    fontWeight: FONT_WEIGHTS[fontWeight] ?? 400,
    textAlign: align as React.CSSProperties["textAlign"],
    letterSpacing: `${letterSpacing}px`,
    textTransform: uppercase ? "uppercase" : "none",
  };
}

export default function LabelControl({
  el,
  variant,
  liveText,
}: LabelControlProps) {
  if (variant === "LCD") {
    // LCD / segmented readout: dark green-black inset screen, monospace text
    // with an --active-color tinted glow, scanline overlay and a bezel frame.
    const glow = styleParam(el, "lcdGlow", 40);
    const g = glow / 100;
    const fontSize = styleParam(el, "fontSize", 16);
    const align = styleParam(el, "align", "center");
    return (
      <div
        className="w-full h-full relative overflow-hidden rounded"
        style={{
          background:
            "linear-gradient(180deg, #0c1a0c 0%, #050c05 100%)",
          boxShadow:
            "inset 0 0 0 1px rgba(0,0,0,0.6), inset 0 0 6px rgba(0,0,0,0.8), 0 0 0 1px color-mix(in srgb, var(--active-color) 25%, transparent)",
        }}
      >
        <div
          className="absolute inset-0 flex items-center px-2 font-mono truncate"
          style={{
            fontSize: `${fontSize}px`,
            textAlign: align as React.CSSProperties["textAlign"],
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: "color-mix(in srgb, var(--active-color) 82%, #eaffea)",
            textShadow: `0 0 ${(2 + g * 8).toFixed(2)}px color-mix(in srgb, var(--active-color) ${Math.round(
              30 + g * 60,
            )}%, transparent), 0 0 ${(1 + g * 3).toFixed(2)}px color-mix(in srgb, var(--active-color) 90%, transparent)`,
          }}
        >
          <span className="w-full truncate">
            {liveText ?? (el.label || "88:88")}
          </span>
        </div>
        {/* Subtle CRT-style scanline overlay. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, transparent 1px, transparent 3px)",
            opacity: 0.5,
          }}
        />
      </div>
    );
  }

  if (variant === "Mono") {
    return (
      <div
        className="w-full h-full flex items-center font-mono truncate px-1"
        style={{ color: "var(--active-color)" }}
      >
        <span
          className="w-full truncate"
          style={textStyle(el, {
            fontSize: 10,
            align: "left",
            letterSpacing: 1.6,
            uppercase: true,
          })}
        >
          {liveText ?? (el.label || "SYS_RDY")}
        </span>
      </div>
    );
  }

  if (variant === "Blank") {
    // Bare text, no container styling at all. Text color comes from
    // --text-color; typography is driven entirely by the shared textStyle
    // helper with Standard-like fallbacks (12 / left / 0 / false).
    return (
      <div className="w-full h-full flex items-center truncate">
        <span
          className="w-full truncate"
          style={{
            color: "var(--text-color)",
            ...textStyle(el, {
              fontSize: 12,
              align: "left",
              letterSpacing: 0,
              uppercase: false,
            }),
          }}
        >
          {liveText ?? (el.label || "Label Text")}
        </span>
      </div>
    );
  }

  // Default (Standard)
  return (
    <div
      className="w-full h-full flex items-center font-sans truncate px-1"
      style={{ color: "var(--base-color)" }}
    >
      <span
        className="w-full truncate"
        style={textStyle(el, {
          fontSize: 12,
          align: "left",
          letterSpacing: 0,
          uppercase: false,
        })}
      >
        {liveText ?? (el.label || "Label Text")}
      </span>
    </div>
  );
}
