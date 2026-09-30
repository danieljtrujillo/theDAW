import { BoxSelect, CheckSquare, Trash2 } from "lucide-react";
import type { useExtractorSelection } from "./useExtractorSelection";

type SelectionControlsProps = Pick<ReturnType<typeof useExtractorSelection>,
  "selectMode" | "setSelectMode" | "selectedIds" | "selectAllElements" | "deleteSelected"
> & { elementCount: number };

export function SelectionControls({ selectMode, setSelectMode, selectedIds, selectAllElements, deleteSelected, elementCount }: SelectionControlsProps) {
  return <>
    <button type="button" aria-pressed={selectMode} onClick={() => setSelectMode((previous) => !previous)}
      title="Select mode — drag a marquee to multi-select boxes (click a box to select; Shift/Ctrl-click to add)"
      className={`text-sm font-medium py-1.5 px-3 rounded border transition-colors flex items-center gap-2 ${selectMode ? "border-app-accent text-app-accent bg-app-surface" : "border-app-border text-app-muted bg-app-surface hover:bg-app-surface-hover"}`}>
      <BoxSelect className="w-4 h-4" />Select
    </button>
    {elementCount > 0 && <button type="button" onClick={selectAllElements} title="Select every capture box"
      className="text-sm font-medium py-1.5 px-3 rounded border border-app-border text-app-muted bg-app-surface hover:bg-app-surface-hover transition-colors flex items-center gap-2">
      <CheckSquare className="w-4 h-4" />All
    </button>}
    {selectedIds.size > 0 && <button type="button" onClick={deleteSelected} title="Delete selected boxes (Delete / Backspace)"
      className="text-sm font-medium py-1.5 px-3 rounded border border-red-500/50 text-red-400 bg-app-surface hover:bg-red-500/10 transition-colors flex items-center gap-2">
      <Trash2 className="w-4 h-4" />Delete ({selectedIds.size})
    </button>}
  </>;
}
