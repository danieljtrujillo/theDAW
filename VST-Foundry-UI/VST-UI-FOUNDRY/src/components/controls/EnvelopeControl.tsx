import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { UIElement } from "../../types";
import { styleParam } from "./controlParams";

/**
 * EnvelopeControl — a draggable ADSR envelope editor (the classic synth
 * envelope panel) rendered on a dark scope-glass surface with a faint grid,
 * a metallic bezel, a translucent filled under-curve and a glowing outline.
 *
 * The four stage values live in styleParams (0-100 each) and are read via
 * styleParam() with the fallbacks below (a concurrent agent adds the matching
 * "Envelope" schema entries + ElementType union member — those same defaults
 * are used as fallbacks here so the control renders identically before the
 * schema lands):
 *   attack (15) · decay (30) · sustain (70) · release (25)
 *   showGrid (true) · curveTension (30, 0-100 -> linear..exponential curves)
 *
 * Geometry: the x-axis is split so the sustain PLATEAU takes a fixed share and
 * the remaining "budget" is divided between A/D/R proportionally to their
 * values. Peak sits at the top, the sustain level at `sustain`%.
 *
 * FOUR drag nodes recompute stage values:
 *   1. attack peak  (horizontal -> attack)
 *   2. decay corner (horizontal -> decay, vertical -> sustain)
 *   3. plateau end  (vertical only -> sustain)
 *   4. release end  (horizontal -> release; the ramp start tracks the cursor)
 *
 * Nodes are draggable in BOTH preview and editor modes (this is an editor —
 * nothing is gated on isPreview). Edits are previewed locally with useState
 * during the gesture and committed to onStyleParams ONCE on pointerup, so undo
 * history records a single entry per drag. Window move/up listeners are tracked
 * in a ref and torn down on pointerup AND on unmount (including mid-drag).
 */
export interface EnvelopeControlProps {
  el: UIElement;
  variant: string;
  isPreview: boolean;
  /** Persists node edits — called once per gesture on pointerup. */
  onStyleParams?: (patch: Record<string, number | string | boolean>) => void;
}

/** Which value(s) a node controls. */
type NodeKind = "attack" | "decay" | "sustain" | "release";

/** The four live stage values (0-100 each) used both for render and drag math. */
interface EnvValues {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

// --- Fixed layout constants (SVG user units, viewBox 0..100 both axes) --------
// Endpoints are inset from the edges so the drag nodes are never clipped by the
// panel's overflow-hidden rounding.
const X_MIN = 6;
const X_MAX = 94;
const X_SPAN = X_MAX - X_MIN; // 88
const PLATEAU_W = X_SPAN * 0.2; // ~17.6 — the fixed sustain plateau share
const BUDGET_W = X_SPAN - PLATEAU_W; // ~70.4 — split A/D/R proportionally
const PEAK_Y = 12; // top (full amplitude)
const BASE_Y = 86; // baseline (zero amplitude)
const PLOT_H = BASE_Y - PEAK_Y; // 74

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
const clamp100 = (v: number): number => clamp(v, 0, 100);

/** Format a coordinate for a deterministic SVG path string. */
const f = (n: number): number => Math.round(n * 100) / 100;

/**
 * Invert the proportional layout for one stage: given the rendered pixel width
 * `w` of a stage and the summed values of the OTHER two stages, return the
 * stage value (0-100) that reproduces that width. Derived from
 *   w = value / (value + others) * BUDGET_W
 * solved for `value`. Guarded against the degenerate denominators.
 */
function valueFromWidth(w: number, others: number): number {
  if (others <= 0) return clamp100((w / BUDGET_W) * 100);
  const denom = BUDGET_W - w;
  if (denom <= 0.001) return 100;
  return clamp100((w * others) / denom);
}

/** Convert an SVG y (0-100) to an amplitude value (0-100), top = full. */
function yToAmp(py: number): number {
  return clamp100(((BASE_Y - py) / PLOT_H) * 100);
}

/** Rendered stage widths from the live values (equal split if all zero). */
function widths(v: EnvValues): { wA: number; wD: number; wR: number } {
  const sum = v.attack + v.decay + v.release;
  if (sum <= 0) {
    const third = BUDGET_W / 3;
    return { wA: third, wD: third, wR: third };
  }
  return {
    wA: (v.attack / sum) * BUDGET_W,
    wD: (v.decay / sum) * BUDGET_W,
    wR: (v.release / sum) * BUDGET_W,
  };
}

/** All node points + the outline/fill path strings for a set of values. */
function buildGeometry(v: EnvValues, tension: number) {
  const { wA, wD, wR } = widths(v);
  const x1 = X_MIN + wA; // attack peak
  const x2 = x1 + wD; // decay -> sustain corner
  const x3 = x2 + PLATEAU_W; // plateau end (release start)
  const x4 = x3 + wR; // release end (== X_MAX)
  const ySus = BASE_Y - (clamp100(v.sustain) / 100) * PLOT_H;

  const p0 = { x: X_MIN, y: BASE_Y };
  const p1 = { x: x1, y: PEAK_Y };
  const p2 = { x: x2, y: ySus };
  const p3 = { x: x3, y: ySus };
  const p4 = { x: x4, y: BASE_Y };

  // Quadratic control point pulling the segment toward its "exponential" elbow
  // E = (A.x, B.y). tension 0 -> control at the midpoint (linear); tension 1 ->
  // control at the elbow (strong fast-then-slow curvature).
  const t = clamp(tension / 100, 0, 1);
  const cp = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x * (1 + t) + b.x * (1 - t)) / 2,
    y: (a.y * (1 - t) + b.y * (1 + t)) / 2,
  });
  const cA = cp(p0, p1);
  const cD = cp(p1, p2);
  const cR = cp(p3, p4);

  const outlineD =
    `M ${f(p0.x)} ${f(p0.y)} ` +
    `Q ${f(cA.x)} ${f(cA.y)} ${f(p1.x)} ${f(p1.y)} ` +
    `Q ${f(cD.x)} ${f(cD.y)} ${f(p2.x)} ${f(p2.y)} ` +
    `L ${f(p3.x)} ${f(p3.y)} ` +
    `Q ${f(cR.x)} ${f(cR.y)} ${f(p4.x)} ${f(p4.y)}`;
  // Close along the baseline back to the start for the translucent fill.
  const fillD = `${outlineD} Z`;

  return { p1, p2, p3, p4, ySus, outlineD, fillD };
}

/**
 * Apply a pointer position (SVG 0-100 coords) to `cur` for the dragged node and
 * return the next values. The primary axis of each node tracks the cursor
 * exactly; coupled stages rebalance proportionally.
 */
function applyDrag(kind: NodeKind, px: number, py: number, cur: EnvValues): EnvValues {
  const { wA } = widths(cur);
  switch (kind) {
    case "attack": {
      const w = clamp(px - X_MIN, 0, BUDGET_W);
      return { ...cur, attack: valueFromWidth(w, cur.decay + cur.release) };
    }
    case "decay": {
      const x1 = X_MIN + wA;
      const w = clamp(px - x1, 0, BUDGET_W);
      return {
        ...cur,
        decay: valueFromWidth(w, cur.attack + cur.release),
        sustain: yToAmp(py),
      };
    }
    case "sustain":
      return { ...cur, sustain: yToAmp(py) };
    case "release": {
      // The release ramp starts at the cursor; its width runs to X_MAX.
      const w = clamp(X_MAX - px, 0, BUDGET_W);
      return { ...cur, release: valueFromWidth(w, cur.attack + cur.decay) };
    }
    default:
      return cur;
  }
}

export default function EnvelopeControl({
  el,
  variant,
  isPreview,
  onStyleParams,
}: EnvelopeControlProps) {
  // Committed values (fallbacks match the schema a concurrent agent adds).
  const committed: EnvValues = {
    attack: clamp100(styleParam<number>(el, "attack", 15)),
    decay: clamp100(styleParam<number>(el, "decay", 30)),
    sustain: clamp100(styleParam<number>(el, "sustain", 70)),
    release: clamp100(styleParam<number>(el, "release", 25)),
  };
  const showGrid = styleParam<boolean>(el, "showGrid", true);
  const curveTension = styleParam<number>(el, "curveTension", 30);

  // Live drag override (null when not dragging) — commits once on pointerup.
  const [drag, setDrag] = useState<EnvValues | null>(null);
  const values = drag ?? committed;

  const containerRef = useRef<HTMLDivElement>(null);
  // Active window listeners, tracked so they can be removed on pointerup AND on
  // unmount (including an unmount that happens mid-drag).
  const listenersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
  } | null>(null);

  const detach = useCallback(() => {
    const l = listenersRef.current;
    if (l) {
      window.removeEventListener("pointermove", l.move);
      window.removeEventListener("pointerup", l.up);
      window.removeEventListener("pointercancel", l.up);
      listenersRef.current = null;
    }
  }, []);

  // Tear down any live drag if the control unmounts mid-gesture.
  useEffect(() => detach, [detach]);

  const startDrag = useCallback(
    (kind: NodeKind, e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      // Stop the canvas from starting an element move/selection on the node.
      e.stopPropagation();
      detach(); // guard against a stuck prior gesture

      const start: EnvValues = { ...committed };
      let current: EnvValues = { ...start };
      setDrag(current);

      const toSvg = (clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return null;
        return {
          px: clamp(((clientX - rect.left) / rect.width) * 100, 0, 100),
          py: clamp(((clientY - rect.top) / rect.height) * 100, 0, 100),
        };
      };

      const move = (ev: PointerEvent) => {
        const pt = toSvg(ev.clientX, ev.clientY);
        if (!pt) return;
        current = applyDrag(kind, pt.px, pt.py, current);
        setDrag({ ...current });
      };

      const up = () => {
        detach();
        // Commit only the stage values that actually changed (rounded to ints),
        // as a single patch -> one undo entry for the whole gesture.
        const rounded: EnvValues = {
          attack: Math.round(current.attack),
          decay: Math.round(current.decay),
          sustain: Math.round(current.sustain),
          release: Math.round(current.release),
        };
        const patch: Record<string, number> = {};
        (Object.keys(rounded) as (keyof EnvValues)[]).forEach((k) => {
          if (rounded[k] !== Math.round(start[k])) patch[k] = rounded[k];
        });
        if (Object.keys(patch).length > 0) onStyleParams?.(patch);
        setDrag(null);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      listenersRef.current = { move, up };
    },
    // committed is recreated each render; capturing it here is intentional so a
    // gesture snapshots the values live at pointerdown.
    [committed, detach, onStyleParams],
  );

  const geo = buildGeometry(values, curveTension);
  const fillId = `env-fill-${el.id}`;

  // Node descriptors: percentage position + role + a11y metadata.
  const nodes: {
    kind: NodeKind;
    cx: number;
    cy: number;
    label: string;
    value: number;
    orientation: "horizontal" | "vertical";
  }[] = [
    { kind: "attack", cx: geo.p1.x, cy: geo.p1.y, label: "Attack", value: values.attack, orientation: "horizontal" },
    { kind: "decay", cx: geo.p2.x, cy: geo.p2.y, label: "Decay / Sustain", value: values.decay, orientation: "horizontal" },
    { kind: "sustain", cx: geo.p3.x, cy: geo.p3.y, label: "Sustain", value: values.sustain, orientation: "vertical" },
    { kind: "release", cx: geo.p4.x, cy: geo.p4.y, label: "Release", value: values.release, orientation: "horizontal" },
  ];

  const gridLines = [20, 40, 60, 80];

  return (
    <div
      ref={containerRef}
      data-variant={variant}
      data-preview={isPreview ? "1" : "0"}
      className="w-full h-full rounded relative overflow-hidden select-none"
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
      {/* Faint reference grid. */}
      {showGrid && (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {gridLines.map((p) => (
            <g key={p}>
              <line
                x1={p}
                y1={0}
                x2={p}
                y2={100}
                stroke="var(--text-color)"
                strokeOpacity={0.08}
                strokeWidth={0.5}
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1={0}
                y1={p}
                x2={100}
                y2={p}
                stroke="var(--text-color)"
                strokeOpacity={0.08}
                strokeWidth={0.5}
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          {/* Baseline (zero-amplitude) reference. */}
          <line
            x1={0}
            y1={BASE_Y}
            x2={100}
            y2={BASE_Y}
            stroke="var(--text-color)"
            strokeOpacity={0.16}
            strokeWidth={0.75}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}

      {/* Envelope fill + glowing outline. */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--active-color)" stopOpacity={0.32} />
            <stop offset="100%" stopColor="var(--active-color)" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <path d={geo.fillD} fill={`url(#${fillId})`} stroke="none" />
        <path
          d={geo.outlineD}
          fill="none"
          stroke="var(--active-color)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{
            filter:
              "drop-shadow(0 0 2px color-mix(in srgb, var(--active-color) 80%, transparent)) drop-shadow(0 0 5px color-mix(in srgb, var(--active-color) 45%, transparent))",
          }}
        />
      </svg>

      {/* Drag nodes — circular handles positioned by percentage so they stay
          round regardless of the panel aspect ratio. Interactive in both modes. */}
      {nodes.map((n) => (
        <div
          key={n.kind}
          role="slider"
          aria-label={`${n.label}${el.label ? ` (${el.label})` : ""}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(n.value)}
          aria-orientation={n.orientation}
          tabIndex={-1}
          onPointerDown={(e) => startDrag(n.kind, e)}
          className="absolute w-2.5 h-2.5 rounded-full -translate-x-1/2 -translate-y-1/2 cursor-grab active:cursor-grabbing"
          style={{
            left: `${n.cx}%`,
            top: `${n.cy}%`,
            touchAction: "none",
            background: `radial-gradient(circle,
              #ffffff 0%,
              var(--active-color) 45%,
              color-mix(in srgb, var(--active-color) 60%, transparent) 100%)`,
            boxShadow: `
              inset 0 0 2px rgba(255,255,255,0.85),
              0 0 5px color-mix(in srgb, var(--active-color) 90%, transparent),
              0 0 11px color-mix(in srgb, var(--active-color) 55%, transparent)
            `,
          }}
        />
      ))}

      {/* Stage readouts (top-left, mono). */}
      <div
        className="absolute top-1 left-1.5 flex gap-2 text-[9px] font-mono tabular-nums pointer-events-none"
        style={{ color: "var(--text-color)" }}
      >
        {(
          [
            ["A", values.attack],
            ["D", values.decay],
            ["S", values.sustain],
            ["R", values.release],
          ] as const
        ).map(([k, val]) => (
          <span key={k}>
            <span style={{ opacity: 0.5 }}>{k} </span>
            <span style={{ opacity: 0.9 }}>{Math.round(val)}</span>
          </span>
        ))}
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
