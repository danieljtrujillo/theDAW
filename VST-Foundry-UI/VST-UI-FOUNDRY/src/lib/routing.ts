/**
 * Routing engine helpers — pure functions for the modulation-stack feature.
 *
 * A route takes the source control's normalized value (0–100), shapes it
 * (depth/invert → response curve → output range), and delivers it to either
 * a theDAW target (via dawControlBus.setDawTarget) or another canvas element
 * (via elementSignalBus.publishElementSignal). This module owns the shaping
 * math, the legacy-binding migration, and the element-compatibility map the
 * route browser uses.
 */
import type { ElementRoute, ElementType, RouteCurve, UIElement } from "../types";

/** Shape a normalized 0–100 source value through one route's processing. */
export function applyRoute(norm0to100: number, route: ElementRoute): number {
  const src = Math.max(0, Math.min(100, norm0to100)) / 100; // 0..1
  // Depth: -100..100. Negative inverts around the source's travel.
  const amount = (route.amount ?? 100) / 100;
  let v = amount >= 0 ? src * amount : (1 - src) * -amount;
  // Response curve on the shaped 0..1 signal.
  v = applyCurve(v, route.curve ?? "linear");
  // Output range mapping (0..100 clamps).
  const lo = Math.max(0, Math.min(100, route.rangeMin ?? 0));
  const hi = Math.max(0, Math.min(100, route.rangeMax ?? 100));
  const out = lo + v * (hi - lo);
  return Math.max(0, Math.min(100, out));
}

function applyCurve(v01: number, curve: RouteCurve): number {
  const v = Math.max(0, Math.min(1, v01));
  switch (curve) {
    case "exp":
      return v * v * v; // fast late — classic exponential feel
    case "log":
      return 1 - (1 - v) * (1 - v) * (1 - v); // fast early
    case "scurve":
      return v * v * (3 - 2 * v); // smoothstep
    case "linear":
    default:
      return v;
  }
}

/**
 * The element's effective route stack: explicit `routes` plus legacy
 * single-target fields migrated on the fly (never persisted — saving the
 * element keeps whatever the user actually set). Display elements' listen
 * source (Meter/Waveform `targetId`) is NOT a route and is excluded.
 */
export function routesOf(el: UIElement): ElementRoute[] {
  const routes = [...(el.binding?.routes ?? [])];
  const b = el.binding;
  if (!b) return routes;
  const isListenType = el.type === "Meter" || el.type === "Waveform";
  // Dedup is AXIS-AWARE (review finding): an explicit route to the same
  // target on a different axis must not suppress the legacy migration.
  const has = (targetId: string, axis: "value" | "x" | "y") =>
    routes.some((r) => r.dest === "daw" && r.targetId === targetId && (r.axis ?? "value") === axis);
  if (b.targetId && !isListenType && !has(b.targetId, "value")) {
    routes.push({ id: `legacy-${b.targetId}`, dest: "daw", targetId: b.targetId, axis: "value" });
  }
  if (b.xTargetId && !has(b.xTargetId, "x")) {
    routes.push({ id: `legacy-x-${b.xTargetId}`, dest: "daw", targetId: b.xTargetId, axis: "x" });
  }
  if (b.yTargetId && !has(b.yTargetId, "y")) {
    routes.push({ id: `legacy-y-${b.yTargetId}`, dest: "daw", targetId: b.yTargetId, axis: "y" });
  }
  return routes;
}

/** Which source axes an element type emits ("value" for most controls). */
export function sourceAxesFor(type: ElementType): Array<"value" | "x" | "y"> {
  switch (type) {
    case "XYPad":
    case "Spatial3D":
      return ["x", "y"];
    case "Knob":
    case "Slider":
    case "WaveShaper":
    case "Toggle":
    case "Button":
      return ["value"];
    default:
      return [];
  }
}

/**
 * Element-to-element compatibility: which properties of a DESTINATION element
 * a numeric 0–100 signal can drive. Used by the route browser to list
 * compatible canvas elements and by the destination dispatcher to subscribe.
 */
export function elementDestProps(type: ElementType): Array<{ prop: string; label: string }> {
  switch (type) {
    case "Knob":
    case "Slider":
    case "Meter":
    case "WaveShaper":
      return [{ prop: "value", label: "Value" }];
    case "XYPad":
    case "Spatial3D":
      return [
        { prop: "valueX", label: "X" },
        { prop: "valueY", label: "Y" },
      ];
    case "Label":
      return [{ prop: "text", label: "Readout" }];
    case "Toggle":
      return [{ prop: "on", label: "State" }];
    case "Waveform":
      return [{ prop: "value", label: "Amplitude" }];
    default:
      return [];
  }
}

/** True when the element type can be a route SOURCE (has outbound axes). */
export function isRouteSource(type: ElementType): boolean {
  return sourceAxesFor(type).length > 0;
}

/** Stable route id generator (context-independent, collision-safe enough). */
export function newRouteId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
