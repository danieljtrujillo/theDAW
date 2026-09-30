import { StrictMode, useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractedElement } from "../../lib/extractor/types";
import { useExtractorSelection } from "./useExtractorSelection";
import { completeMarquee } from "./canvasSelection";

afterEach(cleanup);

const captures: ExtractedElement[] = [
  { id: "first", label: "First", xmin: 0.1, xmax: 0.3, ymin: 0.1, ymax: 0.3, displayMode: "rect", status: "pending" },
  { id: "second", label: "Second", xmin: 0.5, xmax: 0.7, ymin: 0.5, ymax: 0.7, displayMode: "rect", status: "labeled" },
];

describe("extractor selection", () => {
  it("bulk deletion releases only selected captures once under StrictMode", () => {
    const releaseElement = vi.fn();
    const { result } = renderHook(() => {
      const [elements, setElements] = useState(captures);
      return { elements, ...useExtractorSelection({ elements, setElements, releaseElement }) };
    }, { wrapper: StrictMode });
    act(() => result.current.selectElement("first", false));
    act(() => result.current.deleteSelected());
    expect(result.current.elements).toEqual([captures[1]]);
    expect(releaseElement).toHaveBeenCalledExactlyOnceWith(captures[0]);
    expect(result.current.selectedIds.size).toBe(0);
    act(() => result.current.deleteSelected());
    expect(releaseElement).toHaveBeenCalledTimes(1);
  });

  it("merges additive marquees, clears blank clicks, and selects every capture", () => {
    const { result } = renderHook(() => useExtractorSelection({ elements: captures, setElements: vi.fn(), releaseElement: vi.fn() }));
    act(() => result.current.selectElement("first", false));
    act(() => result.current.marqueeSelect(["second"], true));
    expect([...result.current.selectedIds]).toEqual(["first", "second"]);
    act(() => result.current.marqueeSelect([], true));
    expect(result.current.selectedIds.size).toBe(2);
    act(() => result.current.marqueeSelect([], false));
    expect(result.current.selectedIds.size).toBe(0);
    act(() => result.current.selectAllElements());
    expect(result.current.selectedIds.size).toBe(2);
    act(() => result.current.clearSelection());
    expect(result.current.selectedIds.size).toBe(0);
  });

  it("normalizes reverse drags and ignores empty or zero-sized geometry", () => {
    const onSelect = vi.fn();
    completeMarquee({ x: 80, y: 80 }, { x: 40, y: 40 }, { width: 100, height: 100 }, captures, true, onSelect);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(["second"], true);
    onSelect.mockClear();
    completeMarquee({ x: 20, y: 20 }, { x: 20, y: 20 }, { width: 100, height: 100 }, captures, true, onSelect);
    completeMarquee({ x: 0, y: 0 }, { x: 20, y: 20 }, { width: 0, height: 0 }, captures, false, onSelect);
    expect(onSelect).not.toHaveBeenCalled();
    completeMarquee({ x: 20, y: 20 }, { x: 20, y: 20 }, { width: 100, height: 100 }, captures, false, onSelect);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith([], false);
  });
});
