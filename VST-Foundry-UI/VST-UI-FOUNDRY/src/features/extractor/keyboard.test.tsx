import { useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import type { UIElement } from "../../types";
import { useExtractorKeyboard } from "./useExtractorKeyboard";

afterEach(cleanup);

const designElement: UIElement = {
  id: "design-knob", name: "Design knob", type: "Knob",
  x: 10, y: 10, width: 40, height: 40,
};

function useDesignKeyboard(enabled?: boolean) {
  const [elements, setElements] = useState([designElement]);
  const [selectedElementIds, setSelectedElementIds] = useState([designElement.id]);
  useKeyboardShortcuts({
    enabled, elements, selectedElementIds, setElements, setSelectedElementIds,
    setActiveTool: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    copyFromKeyboard: vi.fn(), pasteFromKeyboard: vi.fn(), cutSelection: vi.fn(),
  });
  return elements;
}

describe("canvas keyboard enable contract", () => {
  it("keeps the default canvas shortcut enabled", () => {
    const { result } = renderHook(() => useDesignKeyboard());
    fireEvent.keyDown(window, { key: "Delete" });
    expect(result.current).toEqual([]);
  });

  it.each(["Delete", "Backspace"])("excludes editable descendants from extractor %s", (key) => {
    const deleteSelected = vi.fn();
    function EditableWorkspace() {
      const elements = useDesignKeyboard(false);
      const { dialogRef, onKeyDown } = useExtractorKeyboard({ isOpen: true, selectionCount: 1, deleteSelected, isEditingMask: false });
      return <div ref={dialogRef} tabIndex={-1} onKeyDown={onKeyDown}>
        <output data-testid="count">{elements.length}</output>
        <input aria-label="Label" /><textarea aria-label="Notes" />
        <div contentEditable suppressContentEditableWarning><span data-testid="editable">Editable label</span></div>
        <button>Capture</button>
      </div>;
    }
    render(<EditableWorkspace />);
    for (const target of [screen.getByLabelText("Label"), screen.getByLabelText("Notes"), screen.getByTestId("editable")]) {
      expect(fireEvent.keyDown(target, { key })).toBe(true);
    }
    expect(deleteSelected).not.toHaveBeenCalled();
    expect(screen.getByTestId("count").textContent).toBe("1");
    fireEvent.keyDown(screen.getByRole("button", { name: "Capture" }), { key });
    expect(deleteSelected).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it.each(["Delete", "Backspace"])("disables %s while extractor owns keyboard", (key) => {
    const { result } = renderHook(() => useDesignKeyboard(false));
    fireEvent.keyDown(window, { key });
    expect(result.current).toEqual([designElement]);
  });

  it("retains default behavior and unregisters across opening and closing", () => {
    const { result, rerender, unmount } = renderHook(
      ({ enabled }: { enabled?: boolean }) => useDesignKeyboard(enabled),
      { initialProps: { enabled: undefined } },
    );
    rerender({ enabled: false });
    fireEvent.keyDown(window, { key: "Delete" });
    expect(result.current).toEqual([designElement]);
    rerender({ enabled: true });
    act(() => fireEvent.keyDown(window, { key: "Delete" }));
    expect(result.current).toEqual([]);
    unmount();
  });
});
