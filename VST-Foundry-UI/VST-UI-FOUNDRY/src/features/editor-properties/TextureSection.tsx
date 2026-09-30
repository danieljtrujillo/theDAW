import React from "react";
import type { PropertySectionProps } from "./types";
import { CollapsibleSection } from "./PanelLayout";
import CustomSelect from "../../components/CustomSelect";
import type { Texture } from "../../types";

export function TextureSection({ selectedElement, onUpdateElements, setChoice, textures }: PropertySectionProps & { textures: Texture[] }) {
  return (
    <CollapsibleSection
      title="Texture & Background"
      defaultOpen={false}
    >
      <div className="space-y-3">
        <div>
          <label className="text-[10px] text-app-muted flex justify-between mb-1.5">
            <span>Background Image</span>
            {selectedElement.textureId && (
              <button disabled={selectedElement.isLocked}
                onClick={() =>
                  onUpdateElements(
                    [selectedElement.id],
                    { textureId: undefined },
                  )
                }
                className="text-[9px] text-red-400 hover:text-red-300"
              >
                Clear
              </button>
            )}
          </label>
          <div className="grid grid-cols-4 gap-1.5">
            {textures.length === 0 && (
              <div className="col-span-4 text-[10px] text-app-muted text-center py-4 border border-dashed border-app-border rounded">
                Upload images in the left Texture Library to use
                them as textures.
              </div>
            )}
            {textures.map((texture) => (
              <button disabled={selectedElement.isLocked}
                key={texture.id}
                onClick={() =>
                  onUpdateElements(
                    [selectedElement.id],
                    { textureId: texture.id },
                  )
                }
                className={`aspect-square rounded border relative overflow-hidden group ${selectedElement.textureId === texture.id ? "border-app-accent" : "border-app-border hover:border-app-muted"}`}
                title={texture.name}
              >
                <img
                  src={texture.url}
                  alt={texture.name}
                  className="w-full h-full object-cover"
                />
                {selectedElement.textureId === texture.id && (
                  <div className="absolute inset-0 border-2 border-app-accent rounded pointer-events-none" />
                )}
              </button>
            ))}
          </div>
        </div>
    
        {selectedElement.textureId && (
          <>
            <div>
              <label className="text-[10px] text-app-muted block mb-1">
                Blend Mode
              </label>
              <CustomSelect
                value={selectedElement.textureBlendMode || "normal"}
                onChange={(val) =>
                  onUpdateElements(
                    [selectedElement.id],
                    { textureBlendMode: val },
                  )
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
                ]}
              />
            </div>
    
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-app-muted">
                  Texture Opacity
                </label>
                <span className="text-[10px] text-app-muted font-mono">
                  {selectedElement.textureOpacity ?? 100}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={selectedElement.textureOpacity ?? 100}
                onChange={(event) =>
                  onUpdateElements(
                    [selectedElement.id],
                    { textureOpacity: parseInt(event.target.value) },
                  )
                }
                className="w-full accent-app-main disabled:opacity-50"
                disabled={selectedElement.isLocked}
              />
            </div>
    
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-app-muted block mb-1">
                  Size
                </label>
                <CustomSelect
                  value={selectedElement.textureSize || "cover"}
                  onChange={(val) =>
                    setChoice("textureSize", val)
                  }
                  disabled={selectedElement.isLocked}
                  options={[
                    { value: "cover", label: "Cover" },
                    { value: "contain", label: "Contain" },
                    { value: "auto", label: "Auto (Original)" },
                    { value: "100% 100%", label: "Stretch" },
                  ]}
                />
              </div>
              <div>
                <label className="text-[10px] text-app-muted block mb-1">
                  Repeat
                </label>
                <CustomSelect
                  value={
                    selectedElement.textureRepeat || "no-repeat"
                  }
                  onChange={(val) =>
                    setChoice("textureRepeat", val)
                  }
                  disabled={selectedElement.isLocked}
                  options={[
                    { value: "no-repeat", label: "No Repeat" },
                    { value: "repeat", label: "Repeat Both" },
                    { value: "repeat-x", label: "Repeat X" },
                    { value: "repeat-y", label: "Repeat Y" },
                  ]}
                />
              </div>
            </div>
    
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-app-muted">
                  Texture Scale
                </label>
                <span className="text-[10px] text-app-muted font-mono">
                  {selectedElement.textureScale ?? 100}%
                </span>
              </div>
              <input
                type="range"
                min="10"
                max="400"
                value={selectedElement.textureScale ?? 100}
                onChange={(event) =>
                  onUpdateElements(
                    [selectedElement.id],
                    { textureScale: parseInt(event.target.value) },
                  )
                }
                className="w-full accent-app-main disabled:opacity-50"
                disabled={selectedElement.isLocked}
              />
            </div>
    
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-app-muted">
                  Rotation
                </label>
                <span className="text-[10px] text-app-muted font-mono">
                  {selectedElement.textureRotation ?? 0}°
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="360"
                value={selectedElement.textureRotation ?? 0}
                onChange={(event) =>
                  onUpdateElements(
                    [selectedElement.id],
                    { textureRotation: parseInt(event.target.value) },
                  )
                }
                className="w-full accent-app-main disabled:opacity-50"
                disabled={selectedElement.isLocked}
              />
            </div>
    
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-app-muted block mb-1">
                  Offset X
                </label>
                <input
                  type="number"
                  value={selectedElement.textureOffsetX ?? 0}
                  onChange={(event) =>
                    onUpdateElements(
                      [selectedElement.id],
                      {
                        textureOffsetX:
                          parseInt(event.target.value) || 0,
                      },
                    )
                  }
                  className="w-full bg-app-surface neu-panel-inset border border-app-border rounded-md px-2 py-1.5 text-xs text-app-main focus:outline-none focus:border-app-main disabled:opacity-50"
                  disabled={selectedElement.isLocked}
                />
              </div>
              <div>
                <label className="text-[10px] text-app-muted block mb-1">
                  Offset Y
                </label>
                <input
                  type="number"
                  value={selectedElement.textureOffsetY ?? 0}
                  onChange={(event) =>
                    onUpdateElements(
                      [selectedElement.id],
                      {
                        textureOffsetY:
                          parseInt(event.target.value) || 0,
                      },
                    )
                  }
                  className="w-full bg-app-surface neu-panel-inset border border-app-border rounded-md px-2 py-1.5 text-xs text-app-main focus:outline-none focus:border-app-main disabled:opacity-50"
                  disabled={selectedElement.isLocked}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </CollapsibleSection>
  );
}
