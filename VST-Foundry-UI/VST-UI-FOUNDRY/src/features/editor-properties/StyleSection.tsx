import React from "react";
import type { PropertySectionProps } from "./types";
import { CollapsibleSection } from "./PanelLayout";
import CustomSelect from "../../components/CustomSelect";
import { getDefaultColors } from "../../lib/colorUtils";

export function StyleSection({ selectedElement, onUpdateElements, handleChange, isContext }: PropertySectionProps) {
  const defaultColors = getDefaultColors(selectedElement.variant);
  const getBaseColorLabel = (type: string) => {
    switch (type) {
      case "Label":
        return "Text Color";
      case "Button":
        return "Background Color";
      default:
        return "Base/Background Color";
    }
  };

  const getActiveColorLabel = (type: string) => {
    switch (type) {
      case "Label":
        return "Highlight Color";
      case "Button":
        return "Text/Accent Color";
      default:
        return "Active/Accent Color";
    }
  };

  return (
    <CollapsibleSection title="Style" defaultOpen={true}>
      <div className="space-y-3">
        <div>
          <div className="flex justify-between mb-1">
            <label className="text-[10px] text-app-muted font-medium">
              Opacity
            </label>
            <span className="text-[10px] text-app-muted">
              {selectedElement.opacity ?? 100}%
            </span>
          </div>
          <input
            type="range"
            name="opacity"
            min="0"
            max="100"
            value={selectedElement.opacity ?? 100}
            onChange={handleChange}
            disabled={selectedElement.isLocked}
            className="w-full accent-app-main disabled:opacity-50"
          />
        </div>
    
        {selectedElement.type === "Image" && (
          <div>
            <label className="text-[10px] text-app-muted font-medium mb-1 block">
              Layer Blend Mode
            </label>
            <CustomSelect
              value={selectedElement.blendMode || "normal"}
              onChange={(val) =>
                onUpdateElements([selectedElement.id], { blendMode: val })
              }
              disabled={selectedElement.isLocked}
              options={[
                { value: "normal", label: "Normal" },
                { value: "multiply", label: "Multiply" },
                { value: "screen", label: "Screen" },
                { value: "overlay", label: "Overlay" },
                { value: "darken", label: "Darken" },
                { value: "lighten", label: "Lighten" },
                { value: "color-dodge", label: "Color Dodge" },
                { value: "color-burn", label: "Color Burn" },
                { value: "hard-light", label: "Hard Light" },
                { value: "soft-light", label: "Soft Light" },
                { value: "difference", label: "Difference" },
                { value: "exclusion", label: "Exclusion" },
                { value: "hue", label: "Hue" },
                { value: "saturation", label: "Saturation" },
                { value: "color", label: "Color" },
                { value: "luminosity", label: "Luminosity" },
              ]}
            />
          </div>
        )}
    
        <div>
          <label className="text-[10px] text-app-muted font-medium mb-1 block">
            Colors
          </label>
          <div className="flex items-center gap-2 mb-2">
            <input
              type="checkbox"
              id="transparentBackground"
              name="transparentBackground"
              checked={selectedElement.transparentBackground || false}
              onChange={(event) =>
                onUpdateElements([selectedElement.id], {
                  transparentBackground: event.target.checked,
                })
              }
              disabled={selectedElement.isLocked}
              className="w-3.5 h-3.5 rounded border-app-border bg-app-surface neu-panel-inset text-app-main focus:ring-app-main focus:ring-offset-gray-900"
            />
            <label
              htmlFor="transparentBackground"
              className="text-[10px] text-app-muted cursor-pointer select-none"
            >
              Transparent Background
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-app-muted block mb-1">
                {getBaseColorLabel(selectedElement.type)}
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="color"
                  name="baseColor"
                  value={
                    selectedElement.baseColor ||
                    defaultColors.baseColor
                  }
                  onChange={handleChange}
                  disabled={
                    selectedElement.isLocked ||
                    selectedElement.transparentBackground
                  }
                  className="w-6 h-6 rounded cursor-pointer bg-app-surface neu-panel-inset border border-app-border disabled:opacity-50 p-0.5 shrink-0"
                />
                <input
                  type="text"
                  name="baseColor"
                  value={
                    selectedElement.baseColor ||
                    defaultColors.baseColor
                  }
                  onChange={handleChange}
                  placeholder="default"
                  disabled={
                    selectedElement.isLocked ||
                    selectedElement.transparentBackground
                  }
                  className={`flex-1 bg-app-surface neu-panel-inset border border-app-border rounded px-1.5 py-1 ${isContext ? "text-[9px]" : "text-xs"} text-app-main w-full min-w-0 disabled:opacity-50 font-mono`}
                />
              </div>
            </div>
            <div>
              <label className="text-[10px] text-app-muted block mb-1">
                {getActiveColorLabel(selectedElement.type)}
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="color"
                  name="activeColor"
                  value={
                    selectedElement.activeColor ||
                    defaultColors.activeColor
                  }
                  onChange={handleChange}
                  disabled={selectedElement.isLocked}
                  className="w-6 h-6 rounded cursor-pointer bg-app-surface neu-panel-inset border border-app-border disabled:opacity-50 p-0.5 shrink-0"
                />
                <input disabled={selectedElement.isLocked}
                  type="text"
                  name="activeColor"
                  value={
                    selectedElement.activeColor ||
                    defaultColors.activeColor
                  }
                  onChange={handleChange}
                  placeholder="default"
                  className={`flex-1 bg-app-surface neu-panel-inset border border-app-border rounded px-1.5 py-1 ${isContext ? "text-[9px]" : "text-xs"} text-app-main w-full min-w-0 disabled:opacity-50 font-mono`}
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            {["Label", "Button", "ValueBox"].includes(
              selectedElement.type,
            ) && (
              <div>
                <label className="text-[10px] text-app-muted block mb-1">
                  Text Color
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    name="textColor"
                    value={
                      selectedElement.textColor ||
                      defaultColors.textColor
                    }
                    onChange={handleChange}
                    disabled={selectedElement.isLocked}
                    className="w-6 h-6 rounded cursor-pointer bg-app-surface neu-panel-inset border border-app-border disabled:opacity-50 p-0.5 shrink-0"
                  />
                  <input disabled={selectedElement.isLocked}
                    type="text"
                    name="textColor"
                    value={
                      selectedElement.textColor ||
                      defaultColors.textColor
                    }
                    onChange={handleChange}
                    placeholder="default"
                    className={`flex-1 bg-app-surface neu-panel-inset border border-app-border rounded px-1.5 py-1 ${isContext ? "text-[9px]" : "text-xs"} text-app-main w-full min-w-0 disabled:opacity-50 font-mono`}
                  />
                </div>
              </div>
            )}
            <div>
              <label className="text-[10px] text-app-muted block mb-1">
                Border Color
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="color"
                  name="borderColor"
                  value={
                    selectedElement.borderColor ||
                    defaultColors.borderColor
                  }
                  onChange={handleChange}
                  disabled={selectedElement.isLocked}
                  className="w-6 h-6 rounded cursor-pointer bg-app-surface neu-panel-inset border border-app-border disabled:opacity-50 p-0.5 shrink-0"
                />
                <input disabled={selectedElement.isLocked}
                  type="text"
                  name="borderColor"
                  value={
                    selectedElement.borderColor ||
                    defaultColors.borderColor
                  }
                  onChange={handleChange}
                  placeholder="default"
                  className={`flex-1 bg-app-surface neu-panel-inset border border-app-border rounded px-1.5 py-1 ${isContext ? "text-[9px]" : "text-xs"} text-app-main w-full min-w-0 disabled:opacity-50 font-mono`}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
}
