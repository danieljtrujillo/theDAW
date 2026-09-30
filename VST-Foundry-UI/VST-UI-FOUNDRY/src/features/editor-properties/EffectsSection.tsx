import React from "react";
import type { PropertySectionProps } from "./types";
import { CollapsibleSection } from "./PanelLayout";
import CustomSelect from "../../components/CustomSelect";
import { getDefaultColors } from "../../lib/colorUtils";

export function EffectsSection({ selectedElement, onUpdateElements, handleChange, setChoice }: PropertySectionProps) {
  const defaultColors = getDefaultColors(selectedElement.variant);
  return (
    <CollapsibleSection title="Effects" defaultOpen={false}>
      <div className="flex items-center gap-2 mb-2">
        <input
          type="checkbox"
          id="glow"
          name="glow"
          checked={selectedElement.glow || false}
          onChange={(event) =>
            onUpdateElements([selectedElement.id], {
              glow: event.target.checked,
            })
          }
          disabled={selectedElement.isLocked}
          className="w-3.5 h-3.5 rounded border-app-border bg-app-surface neu-panel-inset text-app-main focus:ring-app-main focus:ring-offset-gray-900"
        />
        <label
          htmlFor="glow"
          className="text-xs text-app-main cursor-pointer select-none"
        >
          Enable Glow
        </label>
      </div>
    
      {selectedElement.glow && (
        <div className="space-y-3 pl-2 border-l-2 border-app-border/50">
          <div className="flex items-center gap-2 mb-1">
            <input
              type="checkbox"
              id="glowActiveOnly"
              name="glowActiveOnly"
              checked={selectedElement.glowActiveOnly || false}
              onChange={(event) =>
                onUpdateElements([selectedElement.id], {
                  glowActiveOnly: event.target.checked,
                })
              }
              disabled={selectedElement.isLocked}
              className="w-3 h-3 rounded border-app-border bg-app-surface neu-panel-inset text-app-main focus:ring-app-main focus:ring-offset-gray-900"
            />
            <label
              htmlFor="glowActiveOnly"
              className="text-[10px] text-app-muted cursor-pointer select-none"
            >
              Only glow when active/pressed
            </label>
          </div>
    
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] text-app-muted">
                Glow Style
              </label>
              <CustomSelect
                value={
                  selectedElement.glowStyle === "solid" || selectedElement.glowStyle === "neon"
                    ? "outer"
                    : selectedElement.glowStyle === "radial"
                      ? "center"
                      : selectedElement.glowStyle || "outer"
                }
                onChange={(val) =>
                  setChoice("glowStyle", val)
                }
                disabled={selectedElement.isLocked}
                options={[
                  { value: "outer", label: "Outer Glow" },
                  { value: "inner", label: "Inner Glow" },
                  { value: "center", label: "Center Glow" },
                ]}
              />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <label className="text-[10px] text-app-muted">
                  Opacity
                </label>
                <span className="text-[10px] text-app-muted font-mono">
                  {selectedElement.glowOpacity ?? 100}%
                </span>
              </div>
              <input
                type="range"
                name="glowOpacity"
                min="0"
                max="100"
                value={selectedElement.glowOpacity ?? 100}
                onChange={handleChange}
                disabled={selectedElement.isLocked}
                className="w-full accent-app-main disabled:opacity-50"
              />
            </div>
          </div>
    
          <div>
            <div className="flex justify-between">
              <label className="text-[10px] text-app-muted">
                Glow Intensity
              </label>
              <span className="text-[10px] text-app-muted font-mono">
                {selectedElement.glowAmount ?? 50}%
              </span>
            </div>
            <input
              type="range"
              name="glowAmount"
              min="0"
              max="200"
              value={selectedElement.glowAmount ?? 50}
              onChange={handleChange}
              disabled={selectedElement.isLocked}
              className="w-full accent-app-main disabled:opacity-50 mt-1"
            />
          </div>
    
          <div>
            <div className="flex justify-between">
              <label className="text-[10px] text-app-muted">
                Glow Spread
              </label>
              <span className="text-[10px] text-app-muted font-mono">
                {selectedElement.glowSpread ?? 10}px
              </span>
            </div>
            <input
              type="range"
              name="glowSpread"
              min="0"
              max="100"
              value={selectedElement.glowSpread ?? 10}
              onChange={handleChange}
              disabled={selectedElement.isLocked}
              className="w-full accent-app-main disabled:opacity-50 mt-1"
            />
          </div>
    
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[10px] text-app-muted block">
                Glow Color
              </label>
              <div className="flex items-center gap-1">
                <input
                  type="color"
                  name="glowColor"
                  value={
                    selectedElement.glowColor ||
                    selectedElement.activeColor ||
                    defaultColors.activeColor
                  }
                  onChange={handleChange}
                  disabled={selectedElement.isLocked}
                  className="w-6 h-6 rounded cursor-pointer bg-app-surface neu-panel-inset border border-app-border disabled:opacity-50 p-0.5 shrink-0"
                />
                <input disabled={selectedElement.isLocked}
                  type="text"
                  name="glowColor"
                  value={selectedElement.glowColor || ""}
                  onChange={handleChange}
                  placeholder="Auto"
                  className="flex-1 bg-app-surface neu-panel-inset border border-app-border rounded px-1.5 py-1 text-xs text-app-main w-full min-w-0 disabled:opacity-50 font-mono"
                />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-app-muted block">
                Gradient (CSS)
              </label>
              <input
                type="text"
                name="glowGradient"
                value={selectedElement.glowGradient || ""}
                onChange={handleChange}
                placeholder="linear-gradient(...)"
                disabled={selectedElement.isLocked}
                className="w-full bg-app-surface neu-panel-inset border border-app-border rounded px-1.5 py-1 text-xs text-app-main focus:outline-none disabled:opacity-50 font-mono"
              />
            </div>
          </div>
        </div>
      )}
    
      <div className="mt-2">
        <label className="text-[10px] text-app-muted block mb-1">
          Animation Effect
        </label>
        <CustomSelect
          value={selectedElement.effect || "none"}
          onChange={(val) =>
            setChoice("effect", val)
          }
          disabled={selectedElement.isLocked}
          options={[
            { value: "none", label: "None" },
            { value: "pulsing", label: "Pulsing (Continuous)" },
            { value: "breathing", label: "Breathing (Slow Pulse)" },
            { value: "flickering", label: "Flicker (Neon Flicker)" },
            { value: "orbital", label: "Orbital Glow" },
            { value: "floating", label: "Floating / Bobbing" },
            {
              value: "audioReactive",
              label: "Audio Reactive (Simulated)",
            },
          ]}
        />
      </div>
    </CollapsibleSection>
  );
}
