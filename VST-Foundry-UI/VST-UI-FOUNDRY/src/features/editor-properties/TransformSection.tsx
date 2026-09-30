import React from "react";
import type { PropertySectionProps } from "./types";
import { CollapsibleSection } from "./PanelLayout";

export function TransformSection({ selectedElement, handleChange, isContext }: PropertySectionProps) {
  return (
    <CollapsibleSection title="Transform" defaultOpen={true}>
      <div
        className={`grid ${isContext ? "grid-cols-4 gap-1" : "grid-cols-2 gap-2"}`}
      >
        <div className="space-y-1">
          <label className="text-[10px] text-app-muted font-medium">
            {isContext ? "X" : "X Position"}
          </label>
          <input
            type="number"
            name="x"
            value={selectedElement.x}
            onChange={handleChange}
            disabled={selectedElement.isLocked}
            className={`w-full bg-app-surface neu-panel-inset border border-app-border rounded-md px-1 py-1 ${isContext ? "text-[10px]" : "text-sm"} text-app-main focus:outline-none focus:border-app-main font-mono disabled:opacity-50`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] text-app-muted font-medium">
            {isContext ? "Y" : "Y Position"}
          </label>
          <input
            type="number"
            name="y"
            value={selectedElement.y}
            onChange={handleChange}
            disabled={selectedElement.isLocked}
            className={`w-full bg-app-surface neu-panel-inset border border-app-border rounded-md px-1 py-1 ${isContext ? "text-[10px]" : "text-sm"} text-app-main focus:outline-none focus:border-app-main font-mono disabled:opacity-50`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] text-app-muted font-medium">
            {isContext ? "W" : "Width"}
          </label>
          <input
            type="number"
            name="width"
            value={selectedElement.width}
            onChange={handleChange}
            disabled={selectedElement.isLocked}
            className={`w-full bg-app-surface neu-panel-inset border border-app-border rounded-md px-1 py-1 ${isContext ? "text-[10px]" : "text-sm"} text-app-main focus:outline-none focus:border-app-main font-mono disabled:opacity-50`}
          />
        </div>
        <div className="space-y-1">
          <label className="text-[10px] text-app-muted font-medium">
            {isContext ? "H" : "Height"}
          </label>
          <input
            type="number"
            name="height"
            value={selectedElement.height}
            onChange={handleChange}
            disabled={selectedElement.isLocked}
            className={`w-full bg-app-surface neu-panel-inset border border-app-border rounded-md px-1 py-1 ${isContext ? "text-[10px]" : "text-sm"} text-app-main focus:outline-none focus:border-app-main font-mono disabled:opacity-50`}
          />
        </div>
        <div
          className={`space-y-1 ${isContext ? "col-span-4" : "col-span-2"}`}
        >
          <label className="text-[10px] text-app-muted font-medium flex justify-between">
            <span>Rotation (°)</span>
            <span className="font-mono">
              {selectedElement.rotation || 0}°
            </span>
          </label>
          <div className="flex gap-2 items-center">
            <input
              type="range"
              name="rotation"
              min="0"
              max="359"
              value={selectedElement.rotation || 0}
              onChange={handleChange}
              disabled={selectedElement.isLocked}
              className="w-full accent-app-main disabled:opacity-50"
            />
            <input
              type="number"
              name="rotation"
              value={selectedElement.rotation || 0}
              onChange={handleChange}
              disabled={selectedElement.isLocked}
              className="w-16 bg-app-surface neu-panel-inset border border-app-border rounded-md px-2 py-1 text-xs text-app-main focus:outline-none focus:border-app-main font-mono disabled:opacity-50"
            />
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
}
