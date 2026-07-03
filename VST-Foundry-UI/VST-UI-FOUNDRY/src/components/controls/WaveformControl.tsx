import React from "react";
import type { UIElement } from "../../types";
import { styleParam } from "./controlParams";

interface WaveformControlProps {
  el: UIElement;
  variant: string;
  /**
   * LISTEN binding (0–100): a live theDAW value that scales the scope's
   * amplitude for a breathing wave. Undefined = static render, byte-identical
   * to the pre-LISTEN output (scaleAmp returns the amplitude untouched).
   */
  liveVal?: number;
}

/**
 * Scale a static amplitude by a live LISTEN value. When `liveVal` is undefined
 * the amplitude is returned unchanged (no float op) so unbound scopes render
 * byte-identically; when present, amplitude breathes with liveVal/100.
 */
const scaleAmp = (amp: number, liveVal: number | undefined) =>
  liveVal === undefined ? amp : amp * (liveVal / 100);

/**
 * Deterministic bar-height seed for the "Modern" bar visualizer. Tiling this by
 * `i % length` reproduces the original hardcoded 10-bar look exactly when
 * barCount === 10 and grows deterministically for any other count (no
 * Math.random at render — identical output every mount).
 */
const BAR_SEED = [1, 3, 5, 2, 4, 6, 3, 2, 1, 4];
const BAR_SEED_MAX = 6;

// LFO scope drawing space. Height 50 with the trace centred on y = 25.
const VB_W = 100;
const VB_H = 50;
const VB_CY = VB_H / 2;

// Fixed Sample & Hold levels in [-1, 1]. A FIXED seed array (never
// Math.random) so the "random-looking" stepped trace renders identically on
// every mount and export.
const SH_SEED = [
  0.3, -0.7, 0.9, -0.2, 0.6, -0.9, 0.15, 0.75, -0.45, 0.5, -0.6, 0.2, 0.85,
  -0.35, 0.65, -0.8,
];
const SH_STEPS_PER_CYCLE = 4;

type LfoShape = "sine" | "triangle" | "saw" | "square" | "sh";

const LFO_SHAPES: Record<string, LfoShape> = {
  "LFO Sine": "sine",
  "LFO Triangle": "triangle",
  "LFO Saw": "saw",
  "LFO Square": "square",
  "LFO S&H": "sh",
};

const frac = (n: number) => n - Math.floor(n);
const wrapIndex = (i: number, len: number) => ((i % len) + len) % len;

/**
 * Build the SVG path `d` for one LFO shape. Points are generated in phase
 * space and slightly overscanned past the visible window (the enclosing SVG
 * viewport clips them), which yields crisp vertical edges for saw/square/S&H
 * without any endpoint interpolation. Fully deterministic.
 */
function buildLfoPath(
  shape: LfoShape,
  cycles: number,
  phaseFrac: number,
  amp: number,
): string {
  const A = (amp / 100) * (VB_H / 2);
  const margin = 0.06;
  const pStart = -margin * cycles + phaseFrac;
  const pEnd = (1 + margin) * cycles + phaseFrac;
  const toFx = (P: number) => (P - phaseFrac) / cycles;

  // Collect [fx, value] pairs (value in [-1, 1]).
  const pts: Array<[number, number]> = [];

  if (shape === "sine") {
    const n = Math.max(64, Math.ceil(cycles * 64));
    for (let i = 0; i <= n; i++) {
      const fx = -margin + (i / n) * (1 + 2 * margin);
      const P = fx * cycles + phaseFrac;
      pts.push([fx, Math.sin(2 * Math.PI * frac(P))]);
    }
  } else if (shape === "sh") {
    const s = SH_STEPS_PER_CYCLE;
    const mStart = Math.floor(pStart * s);
    const mEnd = Math.ceil(pEnd * s);
    for (let m = mStart; m <= mEnd; m++) {
      const level = SH_SEED[wrapIndex(m, SH_SEED.length)];
      pts.push([toFx(m / s), level]); // hold start
      pts.push([toFx((m + 1) / s), level]); // hold end (vertical jump to next)
    }
  } else {
    const cA = Math.floor(pStart);
    const cB = Math.ceil(pEnd);
    for (let c = cA; c <= cB; c++) {
      if (shape === "triangle") {
        pts.push([toFx(c), -1]);
        pts.push([toFx(c + 0.5), 1]);
      } else if (shape === "saw") {
        pts.push([toFx(c), -1]);
        pts.push([toFx(c + 1), 1]);
      } else {
        // square
        pts.push([toFx(c), 1]);
        pts.push([toFx(c + 0.5), 1]);
        pts.push([toFx(c + 0.5), -1]);
        pts.push([toFx(c + 1), -1]);
      }
    }
  }

  return pts
    .map(([fx, v], i) => {
      const x = fx * VB_W;
      const y = VB_CY - v * A;
      return `${i === 0 ? "M" : "L"}${x.toFixed(3)},${y.toFixed(3)}`;
    })
    .join(" ");
}

export default function WaveformControl({
  el,
  variant,
  liveVal,
}: WaveformControlProps) {
  // ---- LFO shape scopes -------------------------------------------------
  const lfoShape = LFO_SHAPES[variant];
  if (lfoShape) {
    const cycles = Math.max(1, Math.round(styleParam(el, "cycles", 2)));
    // phase: 0-100 maps to 0-360° (one full cycle).
    const phaseFrac = frac(styleParam(el, "phase", 0) / 100);
    const amplitude = styleParam(el, "amplitude", 70);
    const lineThickness = styleParam(el, "lineThickness", 2);
    const d = buildLfoPath(lfoShape, cycles, phaseFrac, scaleAmp(amplitude, liveVal));

    return (
      <div
        className="w-full h-full rounded relative overflow-hidden"
        style={{
          background:
            "radial-gradient(120% 130% at 50% 50%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.55) 100%), linear-gradient(180deg, #0b0f0b 0%, #050705 100%)",
          boxShadow:
            "inset 0 0 0 1px color-mix(in srgb, var(--active-color) 40%, transparent), inset 0 1px 2px rgba(0,0,0,0.7)",
        }}
      >
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {/* Faint reference grid. */}
          {[25, 50, 75].map((x) => (
            <line
              key={`v${x}`}
              x1={x}
              y1={0}
              x2={x}
              y2={VB_H}
              stroke="var(--active-color)"
              strokeOpacity={x === 50 ? 0.18 : 0.08}
              strokeWidth={x === 50 ? 1 : 0.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {[12.5, 25, 37.5].map((y) => (
            <line
              key={`h${y}`}
              x1={0}
              y1={y}
              x2={VB_W}
              y2={y}
              stroke="var(--active-color)"
              strokeOpacity={y === 25 ? 0.18 : 0.08}
              strokeWidth={y === 25 ? 1 : 0.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* The LFO trace: crisp stroke + soft glow via CSS drop-shadow. */}
          <path
            d={d}
            fill="none"
            stroke="var(--active-color)"
            strokeWidth={lineThickness}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{
              filter:
                "drop-shadow(0 0 1.5px var(--active-color)) drop-shadow(0 0 4px color-mix(in srgb, var(--active-color) 55%, transparent))",
            }}
          />
        </svg>
      </div>
    );
  }

  // ---- Blank ------------------------------------------------------------
  if (variant === "Blank") {
    // Single flat polyline in --active-color on a plain --base-color panel
    // (hairline border). A deterministic sample loop draws a fixed 2-cycle
    // sine — no glow, no grid, no gradient. lineThickness + amplitude wired.
    const lineThickness = styleParam(el, "lineThickness", 2);
    const amplitude = styleParam(el, "amplitude", 70);
    const CYCLES = 2;
    const SAMPLES = 64;
    const A = (scaleAmp(amplitude, liveVal) / 100) * (VB_H / 2);
    let d = "";
    for (let i = 0; i <= SAMPLES; i++) {
      const x = (i / SAMPLES) * VB_W;
      const y = VB_CY - Math.sin((i / SAMPLES) * Math.PI * 2 * CYCLES) * A;
      d += `${i === 0 ? "M" : "L"}${x.toFixed(3)},${y.toFixed(3)} `;
    }
    return (
      <div
        className="w-full h-full border rounded relative overflow-hidden"
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "color-mix(in srgb, var(--text-color) 15%, transparent)",
        }}
      >
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d={d.trim()}
            fill="none"
            stroke="var(--active-color)"
            strokeWidth={lineThickness}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    );
  }

  // ---- Oscilloscope -----------------------------------------------------
  if (variant === "Oscilloscope") {
    const lineThickness = styleParam(el, "lineThickness", 2);
    const amplitude = styleParam(el, "amplitude", 50);
    // Control-point Y so the quadratic's actual peak sits `offset` above centre
    // (peak = 12.5 + 0.5*cpY on this geometry). offset = 25 * amplitude/100.
    const offset = (scaleAmp(amplitude, liveVal) / 100) * (VB_H / 2);
    const cpY = VB_CY - 2 * offset;
    const d = `M0,${VB_CY} Q12.5,${cpY.toFixed(3)} 25,${VB_CY} T50,${VB_CY} T75,${VB_CY} T100,${VB_CY}`;
    return (
      <div
        className="w-full h-full bg-black border rounded flex items-center justify-center overflow-hidden"
        style={{ borderColor: "var(--active-color)" }}
      >
        <svg
          className="w-full h-full opacity-80"
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          style={{ color: "var(--active-color)" }}
        >
          <path
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={lineThickness}
          />
        </svg>
      </div>
    );
  }

  // ---- Modern (bars) ----------------------------------------------------
  const barCount = Math.max(1, Math.round(styleParam(el, "barCount", 10)));
  const amplitude = styleParam(el, "amplitude", 90);
  const mirror = styleParam(el, "mirror", false);
  const heights = Array.from({ length: barCount }, (_, i) => {
    const seed = BAR_SEED[i % BAR_SEED.length];
    return Math.min(100, (seed / BAR_SEED_MAX) * scaleAmp(amplitude, liveVal));
  });

  if (mirror) {
    return (
      <div
        className="w-full h-full border rounded flex items-stretch justify-center overflow-hidden gap-0.5 px-1 py-1"
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "rgba(255,255,255,0.1)",
        }}
      >
        {heights.map((barH, i) => (
          <div
            key={i}
            className="flex-1 flex flex-col items-center justify-center"
          >
            <div
              className="w-full rounded-t-full"
              style={{
                height: `${barH / 2}%`,
                backgroundColor: "var(--active-color)",
              }}
            />
            <div
              className="w-full rounded-b-full"
              style={{
                height: `${barH / 2}%`,
                backgroundColor: "var(--active-color)",
                opacity: 0.4,
              }}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="w-full h-full border rounded flex items-center justify-center overflow-hidden gap-0.5 px-1 py-1"
      style={{
        backgroundColor: "var(--base-color)",
        borderColor: "rgba(255,255,255,0.1)",
      }}
    >
      {heights.map((barH, i) => (
        <div
          key={i}
          className="flex-1 rounded-full"
          style={{
            height: `${barH}%`,
            backgroundColor: "var(--active-color)",
          }}
        />
      ))}
    </div>
  );
}
