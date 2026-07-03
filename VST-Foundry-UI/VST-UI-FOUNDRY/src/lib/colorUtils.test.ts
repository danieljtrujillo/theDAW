import { describe, it, expect } from "vitest";
import { getArchetype, getDefaultColors } from "./colorUtils";

// Characterization: current variant -> archetype -> palette mapping.
describe("getArchetype", () => {
  it("maps known variants to their archetype", () => {
    expect(getArchetype("Bauhaus")).toBe("Brutalist");
    expect(getArchetype("Neumorphic")).toBe("Neumorphic");
    expect(getArchetype("3D")).toBe("3D");
    expect(getArchetype("Thin")).toBe("Minimal");
    expect(getArchetype("Classic")).toBe("Classic");
    expect(getArchetype("CellShaded")).toBe("CellShaded");
  });

  it("falls back to Modern for unknown/undefined", () => {
    expect(getArchetype(undefined)).toBe("Modern");
    expect(getArchetype("Nonexistent")).toBe("Modern");
    expect(getArchetype("Modernism")).toBe("Modern");
  });
});

describe("getDefaultColors", () => {
  it("returns the CellShaded palette", () => {
    expect(getDefaultColors("CellShaded")).toEqual({
      baseColor: "#facc15",
      activeColor: "#22d3ee",
      textColor: "#000000",
      borderColor: "#000000",
    });
  });

  it("returns the Brutalist palette", () => {
    expect(getDefaultColors("Bauhaus")).toEqual({
      baseColor: "#000000",
      activeColor: "#ffffff",
      textColor: "#ffffff",
      borderColor: "#ffffff",
    });
  });

  it("returns the default (Modern) palette for unknown variants", () => {
    expect(getDefaultColors(undefined)).toEqual({
      baseColor: "#121116",
      activeColor: "#a855f7",
      textColor: "#f8fafc",
      borderColor: "#221f2e",
    });
  });
});
