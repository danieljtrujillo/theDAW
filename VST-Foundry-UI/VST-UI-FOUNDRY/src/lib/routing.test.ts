import { describe, expect, it } from "vitest";
import { applyRoute, elementDestProps, routesOf, sourceAxesFor } from "./routing";
import { scaleFromTarget, scaleToTarget } from "./dawControlBus";
import type { DawTarget } from "./dawControlBus";
import type { ElementRoute, UIElement } from "../types";

const route = (over: Partial<ElementRoute> = {}): ElementRoute => ({
  id: "r1",
  dest: "daw",
  targetId: "dj.eqHi.A",
  ...over,
});

const el = (over: Partial<UIElement> = {}): UIElement => ({
  id: "e1",
  name: "Knob 1",
  type: "Knob",
  x: 0,
  y: 0,
  width: 64,
  height: 64,
  ...over,
});

describe("applyRoute", () => {
  it("is identity at defaults (amount 100, linear, full range)", () => {
    expect(applyRoute(0, route())).toBe(0);
    expect(applyRoute(50, route())).toBe(50);
    expect(applyRoute(100, route())).toBe(100);
  });

  it("scales by positive depth", () => {
    expect(applyRoute(100, route({ amount: 50 }))).toBe(50);
    expect(applyRoute(50, route({ amount: 50 }))).toBe(25);
  });

  it("inverts with negative depth", () => {
    expect(applyRoute(0, route({ amount: -100 }))).toBe(100);
    expect(applyRoute(100, route({ amount: -100 }))).toBe(0);
    expect(applyRoute(25, route({ amount: -100 }))).toBe(75);
  });

  it("amount 0 pins the output at rangeMin", () => {
    expect(applyRoute(100, route({ amount: 0 }))).toBe(0);
    expect(applyRoute(100, route({ amount: 0, rangeMin: 20 }))).toBe(20);
  });

  it("maps into the output range", () => {
    expect(applyRoute(0, route({ rangeMin: 20, rangeMax: 80 }))).toBe(20);
    expect(applyRoute(100, route({ rangeMin: 20, rangeMax: 80 }))).toBe(80);
    expect(applyRoute(50, route({ rangeMin: 20, rangeMax: 80 }))).toBe(50);
  });

  it("supports an inverted output range (rangeMin > rangeMax)", () => {
    expect(applyRoute(0, route({ rangeMin: 80, rangeMax: 20 }))).toBe(80);
    expect(applyRoute(100, route({ rangeMin: 80, rangeMax: 20 }))).toBe(20);
  });

  it("clamps out-of-bounds source values", () => {
    expect(applyRoute(-50, route())).toBe(0);
    expect(applyRoute(150, route())).toBe(100);
  });

  it("applies curves with fixed endpoints", () => {
    for (const curve of ["exp", "log", "scurve"] as const) {
      expect(applyRoute(0, route({ curve }))).toBe(0);
      expect(applyRoute(100, route({ curve }))).toBe(100);
    }
    // exp is below linear at midpoint, log above, scurve exactly at.
    expect(applyRoute(50, route({ curve: "exp" }))).toBeLessThan(50);
    expect(applyRoute(50, route({ curve: "log" }))).toBeGreaterThan(50);
    expect(applyRoute(50, route({ curve: "scurve" }))).toBe(50);
  });
});

describe("scaleToTarget / scaleFromTarget", () => {
  const target: DawTarget = {
    id: "t",
    area: "dj",
    group: "EQ",
    label: "Hi A",
    kind: "knob",
    min: -12,
    max: 12,
  };

  it("maps 0-100 onto target min..max and back (round trip)", () => {
    expect(scaleToTarget(0, target)).toBe(-12);
    expect(scaleToTarget(50, target)).toBe(0);
    expect(scaleToTarget(100, target)).toBe(12);
    for (const v of [0, 25, 50, 75, 100]) {
      expect(scaleFromTarget(scaleToTarget(v, target), target)).toBeCloseTo(v, 6);
    }
  });

  it("treats a missing target as the 0..1 fraction", () => {
    expect(scaleToTarget(50, undefined)).toBe(0.5);
    expect(scaleFromTarget(0.5, undefined)).toBe(50);
  });

  it("maps booleans to 0/100 on the listen side", () => {
    expect(scaleFromTarget(true, target)).toBe(100);
    expect(scaleFromTarget(false, target)).toBe(0);
  });
});

describe("routesOf legacy migration", () => {
  it("returns explicit routes untouched", () => {
    const r = route({ id: "explicit" });
    expect(routesOf(el({ binding: { routes: [r] } }))).toEqual([r]);
  });

  it("migrates legacy targetId into a value-axis route", () => {
    const routes = routesOf(el({ binding: { targetId: "dj.gain.A" } }));
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ dest: "daw", targetId: "dj.gain.A", axis: "value" });
  });

  it("migrates x/y legacy fields with their axes", () => {
    const routes = routesOf(
      el({ type: "XYPad", binding: { xTargetId: "a", yTargetId: "b" } }),
    );
    expect(routes.map((r) => [r.targetId, r.axis])).toEqual([
      ["a", "x"],
      ["b", "y"],
    ]);
  });

  it("dedups against an explicit route on the SAME axis only", () => {
    const explicit = route({ id: "explicit", targetId: "T", axis: "value" });
    // Same target, same axis -> legacy suppressed.
    expect(
      routesOf(el({ binding: { targetId: "T", routes: [explicit] } })),
    ).toHaveLength(1);
    // Same target, DIFFERENT axis -> legacy x-route still migrates.
    const routes = routesOf(
      el({ type: "XYPad", binding: { xTargetId: "T", routes: [explicit] } }),
    );
    expect(routes).toHaveLength(2);
    expect(routes[1]).toMatchObject({ targetId: "T", axis: "x" });
  });

  it("does NOT migrate a display element's listen source into a route", () => {
    expect(routesOf(el({ type: "Meter", binding: { targetId: "sway.strike" } }))).toEqual([]);
    expect(routesOf(el({ type: "Waveform", binding: { targetId: "sway.strike" } }))).toEqual([]);
  });
});

describe("compatibility maps", () => {
  it("source axes: XY emits x/y, knob emits value, displays emit nothing", () => {
    expect(sourceAxesFor("XYPad")).toEqual(["x", "y"]);
    expect(sourceAxesFor("Knob")).toEqual(["value"]);
    expect(sourceAxesFor("Meter")).toEqual([]);
    expect(sourceAxesFor("Label")).toEqual([]);
  });

  it("destinations: Label takes text, XY takes both axes, Select takes nothing", () => {
    expect(elementDestProps("Label").map((p) => p.prop)).toEqual(["text"]);
    expect(elementDestProps("XYPad").map((p) => p.prop)).toEqual(["valueX", "valueY"]);
    expect(elementDestProps("Select")).toEqual([]);
  });
});
