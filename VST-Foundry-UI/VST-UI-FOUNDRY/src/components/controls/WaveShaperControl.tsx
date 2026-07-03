import React from "react";
import type { UIElement } from "../../types";
import { styleParam } from "./controlParams";

/**
 * WaveShaperControl — a distortion transfer-curve display (the classic
 * waveshaper panel found on saturation / drive plugins). Renders y = f(x) for
 * x in [-1, 1] on a dark scope-glass panel with a faint grid, centre axes, and
 * a glowing curve drawn in the active colour.
 *
 * The curve shape is selected by `variant` and animated by drive: the
 * dispatcher owns a vertical drag that feeds `val` (0-100), which maps to a
 * drive amount `d = 0.05 + (val/100)*0.95`. All per-panel styling is read via
 * styleParam() so the properties panel can tune it live; a concurrent agent
 * adds the matching schema entries (same defaults used as fallbacks here).
 *
 * `containerRef` is attached to the ROOT div only — the dispatcher wires the
 * vertical-drag listeners there. Every child is pointer-events-none so drag
 * hit-testing always lands on the root.
 */
export interface WaveShaperControlProps {
  el: UIElement;
  variant: string;
  isPreview: boolean;
  /** 0-100 drive amount (dispatcher-owned drag, like knobs). */
  val: number;
  /** Attach to the ROOT div — dispatcher wires vertical-drag -> val. */
  containerRef?: React.Ref<HTMLDivElement>;
}

/** Clamp a number into [-1, 1]. */
function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Transfer function f(x) for x in [-1, 1], returning a value in [-1, 1].
 * `posMul` / `negMul` are the per-side drive multipliers used only by
 * "Tube Drive" (derived from the symmetry param). All shapes are driven by the
 * normalized drive `d`.
 */
function transfer(
  variant: string,
  x: number,
  d: number,
  posMul: number,
  negMul: number,
): number {
  switch (variant) {
    case "Sine Fold":
      // Folds increasingly as drive rises (sin naturally reflects past its peak).
      return Math.sin(x * (0.5 + d * 4) * (Math.PI / 2));
    case "Hard Fold": {
      // Triangle-fold: scale then reflect back into [-1, 1] with period 4.
      const v = x * (1 + d * 5);
      return Math.abs((((v - 1) % 4) + 4) % 4 - 2) - 1;
    }
    case "Tube Drive": {
      // Asymmetric soft clip, each half normalized to its own endpoint so the
      // curve stays in [-1, 1] while the two halves keep different gain.
      if (x >= 0) {
        const k = 1 + d * posMul;
        return Math.tanh(x * k) / Math.tanh(k);
      }
      const k = 1 + d * negMul;
      return Math.tanh(x * k) / Math.tanh(k);
    }
    case "Tanh":
    default: {
      // Symmetric soft clip, normalized so f(1) = 1.
      const k = 1 + d * 9;
      return Math.tanh(x * k) / Math.tanh(k);
    }
  }
}

export default function WaveShaperControl({
  el,
  variant,
  isPreview,
  val,
  containerRef,
}: WaveShaperControlProps) {
  // Drive amount driven by the dispatcher's vertical drag (0-100 -> 0.05-1.0).
  const d = 0.05 + (Math.max(0, Math.min(100, val)) / 100) * 0.95;

  // Panel style params (fallbacks match the schema a concurrent agent adds).
  const gridOpacity = styleParam<number>(el, "gridOpacity", 10) / 100;
  const curveThickness = styleParam<number>(el, "curveThickness", 3);
  const fillUnderCurve = styleParam<boolean>(el, "fillUnderCurve", true);
  const symmetry = styleParam<number>(el, "symmetry", 50);

  // Symmetry skews the two Tube Drive gains: 50 = as-given (pos=6, neg=3);
  // toward 0 skews the negative side, toward 100 the positive side.
  const skew = symmetry / 100 - 0.5; // -0.5 .. 0.5
  const posMul = 6 + skew * 6; // 3 .. 9
  const negMul = 3 - skew * 6; // 6 .. 0

  // Sample the transfer curve into a viewBox 0..100 path (~64 segments).
  const SAMPLES = 64;
  const pts: string[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const x = -1 + (i / SAMPLES) * 2; // -1 .. 1
    const y = clamp1(transfer(variant, x, d, posMul, negMul));
    const sx = ((x + 1) / 2) * 100; // -1 -> 0, 1 -> 100
    const sy = 50 - y * 50; // f=1 -> top (0), f=-1 -> bottom (100)
    pts.push(`${sx.toFixed(2)} ${sy.toFixed(2)}`);
  }
  const curvePath = `M ${pts.join(" L ")}`;
  // Area between the curve and the centre axis, for the translucent fill.
  const fillPath = `${curvePath} L 100 50 L 0 50 Z`;

  // Faint reference grid; the centre lines (50) render as heavier axes.
  const grid = [12.5, 25, 37.5, 50, 62.5, 75, 87.5];

  return (
    <div
      ref={containerRef}
      className={`w-full h-full rounded relative overflow-hidden ${isPreview ? "cursor-ns-resize" : ""}`}
      style={{
        // Dark scope glass: dimmed base colour, a soft top specular sheen and a
        // radial vignette darkening the edges.
        background: `
          radial-gradient(80% 55% at 50% -12%, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 60%),
          radial-gradient(120% 120% at 50% 50%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.6) 100%),
          linear-gradient(180deg,
            color-mix(in srgb, var(--base-color) 80%, #000) 0%,
            color-mix(in srgb, var(--base-color) 58%, #000) 100%)
        `,
      }}
    >
      {/* Grid + centre axes. */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {grid.map((p) => {
          const isAxis = p === 50;
          return (
            <React.Fragment key={p}>
              <line
                x1={p}
                y1={0}
                x2={p}
                y2={100}
                stroke="var(--text-color)"
                strokeOpacity={isAxis ? 0.18 : gridOpacity}
                strokeWidth={isAxis ? 1 : 0.5}
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1={0}
                y1={p}
                x2={100}
                y2={p}
                stroke="var(--text-color)"
                strokeOpacity={isAxis ? 0.18 : gridOpacity}
                strokeWidth={isAxis ? 1 : 0.5}
                vectorEffect="non-scaling-stroke"
              />
            </React.Fragment>
          );
        })}
      </svg>

      {/* Transfer curve (+ optional translucent fill under it). */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {fillUnderCurve && (
          <path
            d={fillPath}
            fill="var(--active-color)"
            fillOpacity={0.12}
            stroke="none"
          />
        )}
        <path
          d={curvePath}
          fill="none"
          stroke="var(--active-color)"
          strokeWidth={curveThickness}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{
            filter:
              "drop-shadow(0 0 2px color-mix(in srgb, var(--active-color) 80%, transparent)) drop-shadow(0 0 5px color-mix(in srgb, var(--active-color) 45%, transparent))",
          }}
        />
      </svg>

      {/* Drive readout (top-right corner). */}
      <div
        className="absolute top-1 right-1.5 text-[9px] font-mono tabular-nums pointer-events-none"
        style={{ color: "var(--text-color)", opacity: 0.75 }}
      >
        {Math.round(val)}%
      </div>

      {/* Thin metallic bezel (bevel via layered inset shadows). */}
      <div
        className="absolute inset-0 rounded-[inherit] pointer-events-none"
        style={{
          boxShadow: `
            inset 0 1px 0 rgba(255,255,255,0.14),
            inset 0 -1px 1px rgba(0,0,0,0.6),
            inset 0 0 0 1px rgba(255,255,255,0.06),
            inset 0 0 0 2px rgba(0,0,0,0.35)
          `,
        }}
      />

      {/* Label — consistent with the other controls. */}
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
