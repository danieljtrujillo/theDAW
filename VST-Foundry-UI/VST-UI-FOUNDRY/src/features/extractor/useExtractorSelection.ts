import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ExtractedElement } from "../../lib/extractor/types";

interface SelectionOptions {
  elements: ExtractedElement[];
  setElements: Dispatch<SetStateAction<ExtractedElement[]>>;
  releaseElement: (element: ExtractedElement) => void;
}

export function useExtractorSelection({ elements, setElements, releaseElement }: SelectionOptions) {
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectElement = (id: string, additive: boolean) => {
    setSelectedIds((previous) => {
      if (!additive) return new Set([id]);
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const marqueeSelect = (ids: string[], additive: boolean) => {
    setSelectedIds((previous) => new Set(additive ? [...previous, ...ids] : ids));
  };

  const removeElements = (ids: ReadonlySet<string>) => {
    elements.filter((element) => ids.has(element.id)).forEach((element) => releaseElement(element));
    setElements((previous) => previous.filter((element) => !ids.has(element.id)));
    setSelectedIds((previous) => new Set([...previous].filter((id) => !ids.has(id))));
  };

  return {
    selectMode, setSelectMode, selectedIds, clearSelection, selectElement, marqueeSelect,
    selectAllElements: () => setSelectedIds(new Set(elements.map((element) => element.id))),
    deleteElement: (id: string) => removeElements(new Set([id])),
    deleteSelected: () => { if (selectedIds.size > 0) removeElements(selectedIds); },
  };
}
