import React from "react";
import type { UIElement } from "../../types";
import { ControlContainerRef } from "./shared";
import { styleParam } from "./controlParams";

interface XYPadControlProps {
  el: UIElement;
  /**
   * Normalized variant resolved by the dispatcher. Optional so the control
   * keeps rendering its original pad when no variant (or an unknown one such
   * as "Kaoss" / "Radar") is supplied — those fall through to the default
   * render. "Crosshair" opts into the premium glass pad.
   */
  variant?: string;
  isPreview: boolean;
  xVal: number;
  yVal: number;
  containerRef: ControlContainerRef;
}

/**
 * Shared reference grid. `divisions` internal lines are spaced evenly across
 * the pad (i/divisions); any line landing on the 50% centre is drawn heavier
 * as an axis. Rendered nothing when divisions < 1.
 */
function PadGrid({
  divisions,
  color,
  baseOpacity,
  axisOpacity,
}: {
  divisions: number;
  color: string;
  baseOpacity: number;
  axisOpacity: number;
}) {
  if (divisions < 1) return null;
  const lines: number[] = [];
  for (let i = 1; i < divisions; i++) lines.push((i / divisions) * 100);
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {lines.map((p) => {
        const isAxis = Math.abs(p - 50) < 0.001;
        return (
          <React.Fragment key={p}>
            <line
              x1={p}
              y1={0}
              x2={p}
              y2={100}
              stroke={color}
              strokeOpacity={isAxis ? axisOpacity : baseOpacity}
              strokeWidth={isAxis ? 1 : 0.5}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={0}
              y1={p}
              x2={100}
              y2={p}
              stroke={color}
              strokeOpacity={isAxis ? axisOpacity : baseOpacity}
              strokeWidth={isAxis ? 1 : 0.5}
              vectorEffect="non-scaling-stroke"
            />
          </React.Fragment>
        );
      })}
    </svg>
  );
}

export default function XYPadControl({
  el,
  variant,
  isPreview,
  xVal,
  yVal,
  containerRef,
}: XYPadControlProps) {
  // Image-face branch: when el.faceSrc is set the pad wears a cutout. Two roles
  // (C2): "puck" rides the image as the position marker over a neutral (Blank)
  // pad surface; "background" paints the image across the whole pad with the
  // default glowing dot on top. Both keep drag live via containerRef on the
  // root and honor faceFit / faceOpacity. Gated on faceSrc so every default
  // (unset) render below stays byte-identical to today.
  if (el.faceSrc) {
    const faceFit = styleParam(
      el,
      "faceFit",
      "contain",
    ) as React.CSSProperties["objectFit"];
    const faceOpacity = styleParam(el, "faceOpacity", 100) / 100;
    const faceRole = styleParam<string>(el, "faceRole", "puck");
    if (faceRole === "background") {
      // Face fills the pad; the default dot (with its glow) rides on top at the
      // value coordinate — identical marker math to the default render.
      const dotSize = styleParam(el, "dotSize", 12);
      const glowFactor = styleParam(el, "glowStrength", 60) / 60;
      return (
        <div
          ref={containerRef}
          className={`w-full h-full border rounded relative overflow-hidden ${isPreview ? "cursor-crosshair" : ""}`}
          style={{
            backgroundColor: "var(--base-color)",
            borderColor: "color-mix(in srgb, var(--text-color) 15%, transparent)",
          }}
        >
          <img
            src={el.faceSrc}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ objectFit: faceFit, opacity: faceOpacity }}
          />
          {/* default puck on top */}
          <div
            className="absolute rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{
              width: `${dotSize}px`,
              height: `${dotSize}px`,
              left: `${xVal}%`,
              top: `${100 - yVal}%`,
              backgroundColor: "var(--active-color)",
              boxShadow: `0 0 ${10 * glowFactor}px var(--active-color)`,
            }}
          />
        </div>
      );
    }
    // "puck" (default): neutral Blank pad with the cutout as the marker, sized to
    // facePuckSize% of the pad's smaller dimension and centred on the value
    // coordinate (translate(-50%,-50%) like every existing dot).
    const facePuckSize = styleParam(el, "facePuckSize", 20);
    const minDim = Math.min(el.width ?? 0, el.height ?? 0);
    const puckPx = (facePuckSize / 100) * minDim;
    return (
      <div
        ref={containerRef}
        className={`w-full h-full border rounded relative overflow-hidden ${isPreview ? "cursor-crosshair" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "color-mix(in srgb, var(--text-color) 15%, transparent)",
        }}
      >
        <img
          src={el.faceSrc}
          alt=""
          draggable={false}
          className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{
            width: `${puckPx}px`,
            height: `${puckPx}px`,
            left: `${xVal}%`,
            top: `${100 - yVal}%`,
            objectFit: faceFit,
            opacity: faceOpacity,
          }}
        />
      </div>
    );
  }

  if (variant === "Crosshair") {
    const gridDivisions = Math.max(
      0,
      Math.round(styleParam(el, "gridDivisions", 10)),
    );
    const gridOpacity = styleParam(el, "gridOpacity", 8) / 100;
    const crosshairOpacity = styleParam(el, "crosshairOpacity", 40) / 100;
    const trailEcho = styleParam(el, "trailEcho", true);
    const dotSize = styleParam(el, "dotSize", 12);
    // Glow scales relative to the original look (which corresponds to 60).
    const glowFactor = styleParam(el, "glowStrength", 60) / 60;
    const echoSize = dotSize * (10 / 12);

    // Percent-based dot position — identical math to the default render so the
    // pad stays fully size-responsive.
    const dotLeft = xVal;
    const dotTop = 100 - yVal;
    const echo1Left = dotLeft + (50 - dotLeft) * 0.06;
    const echo1Top = dotTop + (50 - dotTop) * 0.06;
    const echo2Left = dotLeft + (50 - dotLeft) * 0.12;
    const echo2Top = dotTop + (50 - dotTop) * 0.12;

    return (
      <div
        ref={containerRef}
        className={`w-full h-full rounded relative overflow-hidden ${isPreview ? "cursor-crosshair" : ""}`}
        style={{
          background: `
            radial-gradient(80% 55% at 50% -12%, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0) 60%),
            radial-gradient(120% 120% at 50% 50%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.55) 100%),
            linear-gradient(180deg,
              color-mix(in srgb, var(--base-color) 82%, #000) 0%,
              color-mix(in srgb, var(--base-color) 62%, #000) 100%)
          `,
        }}
      >
        {/* Fine reference grid — textColor at gridOpacity, heavier centre axes. */}
        <PadGrid
          divisions={gridDivisions}
          color="var(--text-color)"
          baseOpacity={gridOpacity}
          axisOpacity={gridOpacity * 2}
        />

        {/* Full-height crosshair line tracking X. */}
        <div
          className="absolute top-0 bottom-0 w-px pointer-events-none"
          style={{
            left: `${dotLeft}%`,
            backgroundColor: "var(--active-color)",
            opacity: crosshairOpacity,
            boxShadow:
              "0 0 6px color-mix(in srgb, var(--active-color) 35%, transparent)",
          }}
        />
        {/* Full-width crosshair line tracking Y. */}
        <div
          className="absolute left-0 right-0 h-px pointer-events-none"
          style={{
            top: `${dotTop}%`,
            backgroundColor: "var(--active-color)",
            opacity: crosshairOpacity,
            boxShadow:
              "0 0 6px color-mix(in srgb, var(--active-color) 35%, transparent)",
          }}
        />

        {/* Echo trail (rendered before the core so the core paints on top). */}
        {trailEcho && (
          <>
            <div
              className="absolute rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"
              style={{
                width: `${echoSize}px`,
                height: `${echoSize}px`,
                left: `${echo2Left}%`,
                top: `${echo2Top}%`,
                backgroundColor: "var(--active-color)",
                opacity: 0.12,
                filter: "blur(1px)",
              }}
            />
            <div
              className="absolute rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"
              style={{
                width: `${echoSize}px`,
                height: `${echoSize}px`,
                left: `${echo1Left}%`,
                top: `${echo1Top}%`,
                backgroundColor: "var(--active-color)",
                opacity: 0.26,
                filter: "blur(0.5px)",
              }}
            />
          </>
        )}

        {/* Glowing position dot: hot core + layered soft halo. */}
        <div
          className="absolute rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{
            width: `${dotSize}px`,
            height: `${dotSize}px`,
            left: `${dotLeft}%`,
            top: `${dotTop}%`,
            background: `radial-gradient(circle,
              #ffffff 0%,
              var(--active-color) 42%,
              color-mix(in srgb, var(--active-color) 55%, transparent) 100%)`,
            boxShadow: `
              inset 0 0 2px rgba(255,255,255,0.85),
              0 0 ${6 * glowFactor}px color-mix(in srgb, var(--active-color) 90%, transparent),
              0 0 ${14 * glowFactor}px color-mix(in srgb, var(--active-color) 70%, transparent),
              0 0 ${28 * glowFactor}px color-mix(in srgb, var(--active-color) 45%, transparent),
              0 0 ${46 * glowFactor}px color-mix(in srgb, var(--active-color) 25%, transparent)
            `,
          }}
        />

        {/* Thin metallic bezel frame (bevel via layered inset shadows). */}
        <div
          className="absolute inset-0 rounded-[inherit] pointer-events-none"
          style={{
            boxShadow: `
              inset 0 1px 0 rgba(255,255,255,0.16),
              inset 0 -1px 1px rgba(0,0,0,0.6),
              inset 0 0 0 1px rgba(255,255,255,0.06),
              inset 0 0 0 2px rgba(0,0,0,0.35)
            `,
          }}
        />

        {/* Label — consistent with the existing control label style. */}
        {el.label && (
          <div
            className="absolute bottom-1 left-1.5 text-[9px] font-mono tracking-widest uppercase truncate pointer-events-none max-w-[80%]"
            style={{ color: "var(--text-color)", opacity: 0.7 }}
          >
            {el.label}
          </div>
        )}
      </div>
    );
  }

  if (variant === "Blank") {
    // Minimal neutral pad: plain --base-color panel with a hairline border and
    // a flat --active-color dot. gridDivisions (reusing PadGrid) + dotSize are
    // wired; no glow layer is rendered at all (flat by design).
    const gridDivisions = Math.max(
      0,
      Math.round(styleParam(el, "gridDivisions", 0)),
    );
    const dotSize = styleParam(el, "dotSize", 12);
    return (
      <div
        ref={containerRef}
        className={`w-full h-full border rounded relative overflow-hidden ${isPreview ? "cursor-crosshair" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "color-mix(in srgb, var(--text-color) 15%, transparent)",
        }}
      >
        <PadGrid
          divisions={gridDivisions}
          color="var(--text-color)"
          baseOpacity={0.1}
          axisOpacity={0.18}
        />
        <div
          className="absolute rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{
            width: `${dotSize}px`,
            height: `${dotSize}px`,
            left: `${xVal}%`,
            top: `${100 - yVal}%`,
            backgroundColor: "var(--active-color)",
          }}
        />
      </div>
    );
  }

  // Default (original) render — grid added for all variants per spec.
  const gridDivisions = Math.max(
    0,
    Math.round(styleParam(el, "gridDivisions", 0)),
  );
  const dotSize = styleParam(el, "dotSize", 12);
  const glowFactor = styleParam(el, "glowStrength", 60) / 60;
  return (
    <div
      ref={containerRef}
      className={`w-full h-full border rounded relative overflow-hidden ${isPreview ? "cursor-crosshair" : ""}`}
      style={{
        backgroundColor: "var(--base-color)",
        borderColor: "var(--active-color)",
      }}
    >
      <PadGrid
        divisions={gridDivisions}
        color="var(--active-color)"
        baseOpacity={0.1}
        axisOpacity={0.18}
      />
      <div
        className="absolute top-0 bottom-0 w-px"
        style={{
          left: `${xVal}%`,
          backgroundColor: "var(--active-color)",
          opacity: 0.3,
        }}
      />
      <div
        className="absolute left-0 right-0 h-px"
        style={{
          top: `${100 - yVal}%`,
          backgroundColor: "var(--active-color)",
          opacity: 0.3,
        }}
      />
      <div
        className="absolute rounded-full -translate-x-1/2 -translate-y-1/2"
        style={{
          width: `${dotSize}px`,
          height: `${dotSize}px`,
          left: `${xVal}%`,
          top: `${100 - yVal}%`,
          backgroundColor: "var(--active-color)",
          boxShadow: `0 0 ${10 * glowFactor}px var(--active-color)`,
        }}
      />
    </div>
  );
}
