import { useCallback, useState } from "react";
import { UIElement } from "../types";
import {
  remapCopiedElements,
  collectWithGroupChildren,
} from "../lib/remapElements";

type SetElements = (
  updater: UIElement[] | ((prev: UIElement[]) => UIElement[]),
) => void;
type SetSelectedIds = (
  value: string[] | ((prev: string[]) => string[]),
) => void;

interface UseClipboardArgs {
  elements: UIElement[];
  selectedElementIds: string[];
  setElements: SetElements;
  setSelectedElementIds: SetSelectedIds;
}

// Owns the copy/paste clipboard and the five distinct copy/paste/duplicate
// operations wired up in App. Keyboard and context-menu variants are kept
// separate on purpose: they differ in selection behaviour and in whether they
// use a functional or closure-based setElements update, and each mirrors its
// original call site verbatim.
export function useClipboard({
  elements,
  selectedElementIds,
  setElements,
  setSelectedElementIds,
}: UseClipboardArgs) {
  const [clipboard, setClipboard] = useState<UIElement[]>([]);

  // Ctrl+C
  const copyFromKeyboard = useCallback(() => {
    if (selectedElementIds.length > 0) {
      const finalToCopy = collectWithGroupChildren(elements, selectedElementIds);
      setClipboard(finalToCopy);
    }
  }, [elements, selectedElementIds]);

  // Ctrl+V — selects only the pasted root elements (children ride along).
  const pasteFromKeyboard = useCallback(() => {
    if (clipboard.length > 0) {
      const newElements = remapCopiedElements(clipboard);
      setElements((prev) => [...prev, ...newElements]);
      setSelectedElementIds(
        newElements.filter((el) => !el.groupId).map((el) => el.id),
      );
    }
  }, [clipboard, setElements, setSelectedElementIds]);

  // Context-menu Copy — guarded on the collected result being non-empty.
  const copyFromMenu = useCallback(() => {
    const finalToCopy = collectWithGroupChildren(elements, selectedElementIds);
    if (finalToCopy.length) setClipboard(finalToCopy);
  }, [elements, selectedElementIds]);

  // Context-menu Paste — selects all pasted elements.
  const pasteFromMenu = useCallback(() => {
    const newEls = remapCopiedElements(clipboard);
    setElements([...elements, ...newEls]);
    setSelectedElementIds(newEls.map((e) => e.id));
  }, [clipboard, elements, setElements, setSelectedElementIds]);

  // Context-menu Duplicate — clones in place without touching the clipboard.
  const duplicateFromMenu = useCallback(() => {
    const source = collectWithGroupChildren(elements, selectedElementIds);
    const newEls = remapCopiedElements(source);
    setElements([...elements, ...newEls]);
  }, [elements, selectedElementIds, setElements]);

  // Cut (Ctrl+X and context menu) — copy the selection (group children ride
  // along), then remove exactly that copied set so paste restores what was cut.
  // Group childrenIds referencing a cut child are cleaned up like delete does.
  const cutSelection = useCallback(() => {
    const finalToCut = collectWithGroupChildren(elements, selectedElementIds);
    if (!finalToCut.length) return;
    setClipboard(finalToCut);
    const idsToDelete = new Set(finalToCut.map((el) => el.id));
    setElements((prev) =>
      prev
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
        ),
    );
    setSelectedElementIds([]);
  }, [elements, selectedElementIds, setElements, setSelectedElementIds]);

  return {
    clipboard,
    copyFromKeyboard,
    pasteFromKeyboard,
    copyFromMenu,
    pasteFromMenu,
    duplicateFromMenu,
    cutSelection,
  };
}
