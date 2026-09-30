import React from "react";
import { AlignLeft, AlignCenter, AlignRight, ArrowLeftRight, ArrowUpDown, Maximize } from "lucide-react";
import { getAlignmentUpdates, isElementLocked, type Alignment } from "./layout";
import type { AlignmentPanelProps } from "./types";

const controls = [
  { alignment: "left", title: "Align Left", Icon: AlignLeft },
  { alignment: "centerH", title: "Align Horizontal Center", Icon: AlignCenter },
  { alignment: "right", title: "Align Right", Icon: AlignRight },
  { alignment: "top", title: "Align Top", Icon: AlignLeft, vertical: true },
  { alignment: "centerV", title: "Align Vertical Center", Icon: AlignCenter, vertical: true },
  { alignment: "bottom", title: "Align Bottom", Icon: AlignRight, vertical: true },
] as const;

export default function AlignmentPanel({ selectedElements, elements = selectedElements, onUpdateElements, canvasState }: AlignmentPanelProps) {
  if (selectedElements.length === 0) return null;
  const disabled = selectedElements.every((element) => isElementLocked(element, elements));
  const handleAlign = (alignment: Alignment) => {
    const updates = getAlignmentUpdates(selectedElements, elements, canvasState, alignment);
    const ids = Object.keys(updates);
    if (ids.length === 0) return;
    onUpdateElements(ids, selectedElements.length === 1 ? updates[ids[0]] : (element) => updates[element.id] ?? {});
  };
  const buttonClass = "p-1.5 bg-app-surface hover:bg-app-surface-hover rounded text-app-main flex items-center justify-center disabled:opacity-50";
  const centerLabel = selectedElements[0].groupId ? "Center in Group" : "Center on Canvas";
  return (
    <div className="p-4 border-b border-app-border space-y-3">
      <div className="text-xs text-app-muted font-medium">Alignment</div>
      <div className="grid grid-cols-3 gap-2">
        {controls.map((control) => (
          <button key={control.alignment} onClick={() => handleAlign(control.alignment)} disabled={disabled} className={buttonClass} title={control.title}>
            <control.Icon className={`w-4 h-4 ${"vertical" in control ? "rotate-90" : ""}`} />
          </button>
        ))}
      </div>
      {selectedElements.length > 2 && (
        <div className="grid grid-cols-2 gap-2 pt-1 border-t border-app-border">
          <button onClick={() => handleAlign("distributeH")} disabled={disabled} className={`${buttonClass} gap-2 text-xs`} title="Distribute Horizontally">
            <ArrowLeftRight className="w-3.5 h-3.5" /> Distribute H
          </button>
          <button onClick={() => handleAlign("distributeV")} disabled={disabled} className={`${buttonClass} gap-2 text-xs`} title="Distribute Vertically">
            <ArrowUpDown className="w-3.5 h-3.5" /> Distribute V
          </button>
        </div>
      )}
      {selectedElements.length === 1 && (
        <div className="grid grid-cols-1 pt-1 border-t border-app-border">
          <button onClick={() => handleAlign("centerBoth")} disabled={disabled} className={`${buttonClass} gap-2 text-xs`} title={centerLabel}>
            <Maximize className="w-3.5 h-3.5" /> {centerLabel}
          </button>
        </div>
      )}
    </div>
  );
}
