import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHistory } from "./useHistory";
import type { UIElement } from "../types";

const el = (id: string): UIElement => ({ id }) as UIElement;
const ids = (arr: UIElement[]) => arr.map((e) => e.id);

// Characterization of the CURRENT full-snapshot undo model. The rethink will
// replace this (zundo + buffered atomic undo); these tests define the behavior
// that migration must preserve for manual edits.
describe("useHistory", () => {
  it("starts at the initial present with no undo/redo", () => {
    const { result } = renderHook(() => useHistory([el("a")]));
    expect(ids(result.current.elements)).toEqual(["a"]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("setElements records history and enables undo", () => {
    const { result } = renderHook(() => useHistory([el("a")]));
    act(() => result.current.setElements([el("a"), el("b")]));
    expect(ids(result.current.elements)).toEqual(["a", "b"]);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("undo restores the previous state; redo re-applies it", () => {
    const { result } = renderHook(() => useHistory([el("a")]));
    act(() => result.current.setElements([el("a"), el("b")]));
    act(() => result.current.undo());
    expect(ids(result.current.elements)).toEqual(["a"]);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(ids(result.current.elements)).toEqual(["a", "b"]);
  });

  it("setElementsWithoutHistory does NOT record an undo step", () => {
    const { result } = renderHook(() => useHistory([el("a")]));
    act(() => result.current.setElementsWithoutHistory([el("a"), el("z")]));
    expect(ids(result.current.elements)).toEqual(["a", "z"]);
    expect(result.current.canUndo).toBe(false);
  });

  it("clearHistory resets past and future", () => {
    const { result } = renderHook(() => useHistory([el("a")]));
    act(() => result.current.setElements([el("b")]));
    act(() => result.current.clearHistory([el("c")]));
    expect(ids(result.current.elements)).toEqual(["c"]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
