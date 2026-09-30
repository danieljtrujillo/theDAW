import React from "react";
import type { PropertySectionProps } from "./types";

export function IdentitySection({ selectedElement, handleChange, isContext }: PropertySectionProps) {
  return (
    <>
    <div className="flex flex-col gap-1 text-[10px] text-app-muted mb-2 pb-2 border-b border-app-border">
      <div className="flex items-center justify-between">
        <span>
          Type:{" "}
          <strong className="text-white">
            {selectedElement.type}
          </strong>
        </span>
        <span
          className="font-mono text-app-muted truncate w-24 text-right"
          title={selectedElement.id}
        >
          {selectedElement.id.substring(0, 8)}
        </span>
      </div>
    </div>
    
    <div className="space-y-1">
      <label className="text-[10px] text-app-muted font-medium">
        Export Name
      </label>
      <input
        type="text"
        name="name"
        value={selectedElement.name}
        onChange={handleChange}
        disabled={selectedElement.isLocked}
        className={`w-full bg-app-surface neu-panel-inset border border-app-border rounded-md px-2 py-1 ${isContext ? "text-xs" : "text-sm"} text-app-main focus:outline-none focus:border-app-main focus:ring-1 focus:ring-app-main disabled:opacity-50`}
        placeholder="e.g. cutoffKnob"
      />
    </div>
    
    {(selectedElement.type === "Button" ||
      selectedElement.type === "Label" ||
      selectedElement.type === "Toggle") && (
      <div className="space-y-1">
        <label className="text-[10px] text-app-muted font-medium">
          Label Text
        </label>
        <input
          type="text"
          name="label"
          value={selectedElement.label || ""}
          onChange={handleChange}
          disabled={selectedElement.isLocked}
          className={`w-full bg-app-surface neu-panel-inset border border-app-border rounded-md px-2 py-1 ${isContext ? "text-xs" : "text-sm"} text-app-main focus:outline-none focus:border-app-main focus:ring-1 focus:ring-app-main disabled:opacity-50`}
        />
      </div>
    )}
    </>
  );
}
