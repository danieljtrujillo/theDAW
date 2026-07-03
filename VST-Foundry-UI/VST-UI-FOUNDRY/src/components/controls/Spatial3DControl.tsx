import React from "react";
import type { UIElement } from "../../types";
import { ControlContainerRef } from "./shared";
import { styleParam } from "./controlParams";

interface Spatial3DControlProps {
  el: UIElement;
  isPreview: boolean;
  xVal: number;
  yVal: number;
  containerRef: ControlContainerRef;
}

export default function Spatial3DControl({
  el,
  isPreview,
  xVal,
  yVal,
  containerRef,
}: Spatial3DControlProps) {
  if (el.variant === "Blank") {
    // Minimal neutral field: plain --base-color disc (hairline border) with
    // concentric rings (count via gridDivisions) and a flat --active-color dot
    // (dotSize). No glow, no spinning sweep — flat by design. This control is
    // not passed a normalized `variant`, so the Blank case keys off el.variant
    // (which the dispatcher passes through unchanged for unmapped variants).
    const gridDivisions = Math.max(
      0,
      Math.round(styleParam(el, "gridDivisions", 3)),
    );
    const dotSize = styleParam(el, "dotSize", 8);
    return (
      <div
        ref={containerRef}
        className={`w-full h-full rounded-full border relative overflow-hidden flex items-center justify-center ${isPreview ? "cursor-crosshair" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "color-mix(in srgb, var(--text-color) 15%, transparent)",
        }}
      >
        {Array.from({ length: Math.max(0, gridDivisions - 1) }, (_, idx) => {
          const i = idx + 1;
          const pct = (i / gridDivisions) * 100;
          return (
            <div
              key={i}
              className="rounded-full border absolute pointer-events-none"
              style={{
                width: `${pct}%`,
                height: `${pct}%`,
                borderColor:
                  "color-mix(in srgb, var(--text-color) 15%, transparent)",
              }}
            />
          );
        })}
        <div
          className="rounded-full absolute pointer-events-none -translate-x-1/2 -translate-y-1/2"
          style={{
            width: `${dotSize}px`,
            height: `${dotSize}px`,
            top: `${100 - yVal}%`,
            left: `${xVal}%`,
            backgroundColor: "var(--active-color)",
          }}
        />
      </div>
    );
  }

  // Concentric range rings evenly spaced from centre to edge (i/divisions).
  // divisions === 3 reproduces the original 1/3 + 2/3 ring pair exactly.
  const gridDivisions = Math.max(
    0,
    Math.round(styleParam(el, "gridDivisions", 3)),
  );
  const dotSize = styleParam(el, "dotSize", 8);
  // Glow scales relative to the original look (which corresponds to 60).
  const glowFactor = styleParam(el, "glowStrength", 60) / 60;

  return (
    <div
      ref={containerRef}
      className={`w-full h-full rounded-full border relative overflow-hidden flex items-center justify-center ${isPreview ? "cursor-crosshair" : ""}`}
      style={{
        backgroundColor: "var(--base-color)",
        borderColor: "var(--active-color)",
      }}
    >
      {Array.from({ length: Math.max(0, gridDivisions - 1) }, (_, idx) => {
        const i = idx + 1;
        const pct = (i / gridDivisions) * 100;
        return (
          <div
            key={i}
            className="rounded-full border absolute pointer-events-none"
            style={{
              width: `${pct}%`,
              height: `${pct}%`,
              borderColor: "var(--active-color)",
              opacity: 0.3,
            }}
          />
        );
      })}
      <div
        className="absolute top-1/2 left-1/2 w-1/2 h-1/2 origin-top-left animate-[spin_4s_linear_infinite] pointer-events-none"
        style={{
          background: `linear-gradient(to bottom right, var(--active-color), transparent)`,
        }}
      />
      <div
        className="rounded-full absolute pointer-events-none -translate-x-1/2 -translate-y-1/2"
        style={{
          width: `${dotSize}px`,
          height: `${dotSize}px`,
          top: `${100 - yVal}%`,
          left: `${xVal}%`,
          backgroundColor: "var(--active-color)",
          boxShadow: `0 0 ${8 * glowFactor}px var(--active-color)`,
        }}
      />
    </div>
  );
}
