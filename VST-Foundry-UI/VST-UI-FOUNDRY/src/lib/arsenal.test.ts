import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for IndexedDB: a single Map plays the role of idb-keyval's
// backing store so the Arsenal logic can be exercised without a browser DB.
// vi.hoisted runs BEFORE the vi.mock factory (and before the arsenal import),
// so the map exists when the mocked get/set close over it. beforeEach clears it
// between cases for isolation.
const { mockStore } = vi.hoisted(() => ({ mockStore: new Map<string, unknown>() }));

vi.mock("idb-keyval", () => ({
  get: vi.fn(async (key: string) => mockStore.get(key)),
  set: vi.fn(async (key: string, value: unknown) => {
    mockStore.set(key, value);
  }),
}));

import { addToArsenal, loadArsenal, removeFromArsenal, type ArsenalEntry } from "./arsenal";

// A full ArsenalEntry with sensible defaults; `over` patches individual fields
// per case (mirrors the el()/route() factories in the sibling lib tests).
const entry = (over: Partial<ArsenalEntry> = {}): ArsenalEntry => ({
  id: "a1",
  name: "Big Red",
  type: "Button",
  defaultWidth: 80,
  defaultHeight: 40,
  presetData: { variant: "Blank", baseColor: "#ff0000" },
  previewUrl: "/textures/red.png",
  createdAt: 1000,
  ...over,
});

beforeEach(() => {
  mockStore.clear();
  vi.clearAllMocks();
});

describe("loadArsenal", () => {
  it("returns [] when nothing has been saved", async () => {
    expect(await loadArsenal()).toEqual([]);
  });

  it("returns [] when the stored value is malformed (defensive)", async () => {
    mockStore.set("vst-arsenal", { not: "an array" });
    expect(await loadArsenal()).toEqual([]);
  });

  it("reads back a previously stored list", async () => {
    const list = [entry()];
    mockStore.set("vst-arsenal", list);
    expect(await loadArsenal()).toEqual(list);
  });
});

describe("addToArsenal", () => {
  it("appends to an empty Arsenal and returns the updated list", async () => {
    const result = await addToArsenal(entry());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Big Red");
    // Persisted under the global key, not project state.
    expect(await loadArsenal()).toEqual(result);
  });

  it("appends a second entry with a fresh name", async () => {
    await addToArsenal(entry({ id: "a1", name: "Big Red" }));
    const result = await addToArsenal(entry({ id: "a2", name: "Green Knob", type: "Knob" }));
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.name)).toEqual(["Big Red", "Green Knob"]);
  });

  it("overwrites in place when the name already exists (same-name semantics)", async () => {
    await addToArsenal(entry({ id: "a1", name: "Big Red", createdAt: 1000 }));
    const result = await addToArsenal(
      entry({ id: "a2", name: "Big Red", createdAt: 2000, previewUrl: "/textures/red2.png" }),
    );
    // Same slot replaced, not duplicated — length stays 1, new fields win.
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a2");
    expect(result[0].createdAt).toBe(2000);
    expect(result[0].previewUrl).toBe("/textures/red2.png");
    expect(await loadArsenal()).toEqual(result);
  });

  it("preserves order when overwriting a middle entry", async () => {
    await addToArsenal(entry({ id: "a1", name: "One" }));
    await addToArsenal(entry({ id: "a2", name: "Two" }));
    await addToArsenal(entry({ id: "a3", name: "Three" }));
    const result = await addToArsenal(entry({ id: "a2b", name: "Two", defaultWidth: 999 }));
    expect(result.map((e) => e.name)).toEqual(["One", "Two", "Three"]);
    expect(result[1].id).toBe("a2b");
    expect(result[1].defaultWidth).toBe(999);
  });
});

describe("removeFromArsenal", () => {
  it("removes the entry with the given id and returns the updated list", async () => {
    await addToArsenal(entry({ id: "a1", name: "One" }));
    await addToArsenal(entry({ id: "a2", name: "Two" }));
    const result = await removeFromArsenal("a1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a2");
    expect(await loadArsenal()).toEqual(result);
  });

  it("is a no-op when the id is absent", async () => {
    await addToArsenal(entry({ id: "a1", name: "One" }));
    const result = await removeFromArsenal("does-not-exist");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a1");
  });

  it("returns [] when removing the last entry", async () => {
    await addToArsenal(entry({ id: "a1", name: "One" }));
    expect(await removeFromArsenal("a1")).toEqual([]);
  });
});
