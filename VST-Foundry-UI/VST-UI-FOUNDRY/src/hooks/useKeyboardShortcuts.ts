import { useEffect } from "react";
import { UIElement } from "../types";

type SetElements = (
  updater: UIElement[] | ((prev: UIElement[]) => UIElement[]),
) => void;
type SetSelectedIds = (
  value: string[] | ((prev: string[]) => string[]),
) => void;
type SetActiveTool = (
  value: "select" | "pan" | ((prev: "select" | "pan") => "select" | "pan"),
) => void;

interface UseKeyboardShortcutsArgs {
  elements: UIElement[];
  selectedElementIds: string[];
  setElements: SetElements;
  setSelectedElementIds: SetSelectedIds;
  setActiveTool: SetActiveTool;
  undo: () => void;
  redo: () => void;
  copyFromKeyboard: () => void;
  pasteFromKeyboard: () => void;
  cutSelection: () => void;
}

// Global keydown handler: tool switch (v/h), undo/redo, copy/paste (delegated to
// useClipboard), group (Cmd/Ctrl+G), delete, and arrow-key nudging. Copy uses
// e.key === "c"/"v" (case-sensitive) while tool/undo use e.key.toLowerCase() —
// preserved exactly as the original.
export function useKeyboardShortcuts({
  elements,
  selectedElementIds,
  setElements,
  setSelectedElementIds,
  setActiveTool,
  undo,
  redo,
  copyFromKeyboard,
  pasteFromKeyboard,
  cutSelection,
}: UseKeyboardShortcutsArgs) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      )
        return;

      if (e.key.toLowerCase() === "v" && !e.metaKey && !e.ctrlKey) {
        setActiveTool("select");
      } else if (e.key.toLowerCase() === "h" && !e.metaKey && !e.ctrlKey) {
        setActiveTool("pan");
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (e.shiftKey) redo();
        else undo();
        e.preventDefault();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "c") {
        copyFromKeyboard();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "v") {
        pasteFromKeyboard();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "x") {
        cutSelection();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "g") {
        e.preventDefault();
        if (selectedElementIds.length > 1) {
          const toGroup = elements.filter(
            (el) => selectedElementIds.includes(el.id) && !el.groupId,
          );
          if (toGroup.length > 1) {
            const minX = Math.min(...toGroup.map((el) => el.x));
            const minY = Math.min(...toGroup.map((el) => el.y));
            const maxX = Math.max(...toGroup.map((el) => el.x + el.width));
            const maxY = Math.max(...toGroup.map((el) => el.y + el.height));

            const groupId = Math.random().toString(36).substring(2, 9);

            const groupElement: UIElement = {
              id: groupId,
              name: `Group_${elements.length + 1}`,
              type: "Group",
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
              childrenIds: toGroup.map((el) => el.id),
            };

            setElements((prev) => {
              const next = [...prev];
              toGroup.forEach((tg) => {
                const idx = next.findIndex((n) => n.id === tg.id);
                if (idx !== -1) {
                  next[idx] = {
                    ...next[idx],
                    groupId,
                    x: next[idx].x - minX,
                    y: next[idx].y - minY,
                  };
                }
              });
              return [...next, groupElement];
            });
            setSelectedElementIds([groupId]);
          }
        }
      } else if (e.key === "Backspace" || e.key === "Delete") {
        if (selectedElementIds.length > 0) {
          setElements((prev) => {
            const idsToDelete = new Set(selectedElementIds);
            const toDelete = prev.filter((el) => idsToDelete.has(el.id));
            toDelete.forEach((el) => {
              if (el.type === "Group" && el.childrenIds) {
                el.childrenIds.forEach((id) => idsToDelete.add(id));
              }
            });
            return prev
              .filter((el) => !idsToDelete.has(el.id))
              .map((el) =>
                el.type === "Group" && el.childrenIds
                  ? {
                      ...el,
                      childrenIds: el.childrenIds.filter(
                        (id) => !idsToDelete.has(id),
                      ),
                    }
                  : el,
              );
          });
          setSelectedElementIds([]);
        }
      } else if (e.key.startsWith("Arrow") && selectedElementIds.length > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        setElements((prev) =>
          prev.map((el) => {
            if (!selectedElementIds.includes(el.id)) return el;
            let newX = el.x;
            let newY = el.y;
            if (e.key === "ArrowUp") newY -= step;
            if (e.key === "ArrowDown") newY += step;
            if (e.key === "ArrowLeft") newX -= step;
            if (e.key === "ArrowRight") newX += step;
            return { ...el, x: newX, y: newY };
          }),
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    selectedElementIds,
    undo,
    redo,
    setElements,
    setSelectedElementIds,
    setActiveTool,
    elements,
    copyFromKeyboard,
    pasteFromKeyboard,
    cutSelection,
  ]);
}
