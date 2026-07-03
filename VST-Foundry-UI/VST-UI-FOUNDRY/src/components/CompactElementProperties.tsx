import React, { useState, useEffect } from "react";
import { UIElement, Texture } from "../types";
import { getDefaultColors } from "../lib/colorUtils";
import {
  Move,
  Palette,
  Sparkles,
  SlidersHorizontal,
  Layers,
  Link,
  Image as ImageIcon,
  Code,
  Save,
  Lock,
} from "lucide-react";
import Editor, { useMonaco } from "@monaco-editor/react";

import {
  TextField,
  NumberField,
  ToggleField,
  ColorField,
  SelectField,
} from "./properties/fields";
import {
  createFieldChangeHandler,
  parseNumericInput,
} from "./properties/useElementField";
import { useRawJsonEditor } from "./properties/rawEditor";
import {
  BLEND_MODE_OPTIONS,
  TEXTURE_BLEND_MODE_OPTIONS,
  EFFECT_OPTIONS,
  normalizeGlowStyle,
} from "./properties/options";
import BindingPicker from "./properties/BindingPicker";
import ControlParamsSection from "./properties/ControlParamsSection";
import {
  bindableKindsFor,
  customCodeBindableParams,
  listenKindsFor,
} from "../lib/dawControlBus";

interface Props {
  element: UIElement;
  /** All canvas elements — passed to BindingPicker for element→element routing. */
  elements?: UIElement[];
  onUpdateElements: (
    ids: string[],
    updates: Partial<UIElement> | ((el: UIElement) => Partial<UIElement>),
  ) => void;
  textures?: Texture[];
}

type TabId =
  | "transform"
  | "style"
  | "fx"
  | "control"
  | "texture"
  | "binding"
  | "image"
  | "raw";

interface TabDef {
  id: TabId;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
}

// Full tab catalog. Order here is the strip order; applicability (below) hides
// the tabs that don't apply to the selected element type.
const TAB_DEFS: TabDef[] = [
  {
    id: "transform",
    label: "Transform",
    Icon: Move,
    title: "Position, size, rotation, opacity & lock",
  },
  {
    id: "style",
    label: "Style",
    Icon: Palette,
    title: "Colors, corner radius & blend mode",
  },
  {
    id: "fx",
    label: "FX",
    Icon: Sparkles,
    title: "Glow & animation effects",
  },
  {
    id: "control",
    label: "Control",
    Icon: SlidersHorizontal,
    title: "Name, values & control parameters",
  },
  {
    id: "texture",
    label: "Texture",
    Icon: Layers,
    title: "Background texture",
  },
  {
    id: "binding",
    label: "Bind",
    Icon: Link,
    title: "Bind this control to a theDAW function",
  },
  {
    id: "image",
    label: "Image",
    Icon: ImageIcon,
    title: "Image processing",
  },
  {
    id: "raw",
    label: "Raw",
    Icon: Code,
    title: "Raw JSON configuration",
  },
];

// Which tabs apply to a given element type. Image is Image-only; Binding shows
// for control types theDAW can drive (write) OR display types that can listen to
// a theDAW signal (BindingPicker itself renders null otherwise). Everything else
// applies universally.
function isTabApplicable(id: TabId, element: UIElement): boolean {
  if (id === "image") return element.type === "Image";
  if (id === "binding")
    return (
      bindableKindsFor(element.type) !== null ||
      listenKindsFor(element.type) !== null ||
      customCodeBindableParams(element).length > 0
    );
  return true;
}

export default function CompactElementProperties({
  element,
  elements = [],
  onUpdateElements,
  textures = [],
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>("transform");
  const monaco = useMonaco();

  useEffect(() => {
    if (monaco) {
      const disposable = monaco.languages.registerHoverProvider("json", {
        provideHover: (model, position) => {
          const word = model.getWordAtPosition(position);
          if (!word) return null;

          // Monaco gets words with quotes around them if we click the key, or without quotes depending on selection.
          // Let's match cleanly.
          const cleanWord = word.word.replace(/"/g, "");

          const hints: Record<string, string> = {
            type: "The fundamental functional component type (e.g., Button, Knob, Slider).",
            variant:
              "Determines the overall style template of the element (e.g., Brutalist, Skeuomorphic).",
            baseColor:
              "The primary background or foundational color of the element.",
            activeColor:
              "The primary highlight color when the element is engaged or turned on.",
            glow: "Toggle boolean that enables or disables outer emissive effects.",
            glowStyle:
              'The visual rendering style of the glow (e.g., "solid", "neon", "inner").',
            glowAmount: "Controls the spread/intensity of the glow (0-200).",
            rotation: "Rotates the entire element by degrees (0-359).",
            cornerRadius:
              "Sets the border radius / rounded corners of the element (in pixels).",
            opacity:
              "Controls the overall transparency of the element (0-100).",
            effect: 'Special visual effects like "pulsing" or "orbital".',
            label: "The primary text displayed on or near the element.",
            value:
              "The current numeric value of the element (used by sliders/knobs).",
            transparentBackground:
              "Boolean to remove the background base fill.",
          };

          const hint = hints[cleanWord];
          if (hint) {
            return {
              range: new monaco.Range(
                position.lineNumber,
                word.startColumn,
                position.lineNumber,
                word.endColumn,
              ),
              contents: [
                { value: `**Property Info: \`${cleanWord}\`**` },
                { value: hint },
              ],
            };
          }
          return null;
        },
      });
      return () => disposable.dispose();
    }
  }, [monaco]);

  // When the selected element changes, the previously active tab may no longer
  // apply (e.g. Image tab while a Knob is now selected, or the Bind tab after a
  // CustomCode element loses its last numeric param). Fall back to Transform so
  // the panel never shows a stranded/empty tab. Safe against loops: clicking
  // only ever sets an applicable tab, so this no-ops after a reset.
  useEffect(() => {
    if (!isTabApplicable(activeTab, element)) {
      setActiveTab("transform");
    }
  }, [activeTab, element]);

  const { handleEditorChange, handleEditorMount } = useRawJsonEditor(
    element,
    onUpdateElements,
  );

  if (!element) return null;

  const handleChange = createFieldChangeHandler(element.id, onUpdateElements, {
    guardRange: true,
  });

  const defaultColors = getDefaultColors(element.variant);
  const visibleTabs = TAB_DEFS.filter((t) => isTabApplicable(t.id, element));

  return (
    <div
      className="bg-app-surface text-app-main flex flex-col font-mono"
      style={{
        width: activeTab === "raw" ? "520px" : "464px",
        maxHeight: "min(65vh, 540px)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header Info (fixed) */}
      <div className="flex items-center justify-between border-b border-app-border p-2 bg-app-base shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-white uppercase tracking-wider bg-app-border px-1.5 py-0.5 rounded">
            {element.type}
          </span>
          <span className="text-[10px] text-app-muted truncate max-w-40">
            {element.name || "Unnamed"}
          </span>
        </div>
        <span className="text-[9px] text-app-muted px-1.5 py-0.5 rounded border border-app-border/50">
          ID: {element.id.substring(0, 6)}
        </span>
      </div>

      {/* Tabs (fixed, wraps to 2 rows) */}
      <div className="flex flex-wrap border-b border-app-border text-[10px] shrink-0">
        {visibleTabs.map(({ id, label, Icon, title }) => (
          <button
            key={id}
            type="button"
            className={`flex-1 min-w-17 flex items-center justify-center gap-1 py-1.5 transition-colors ${
              activeTab === id
                ? "text-white border-b border-app-accent bg-app-surface-hover"
                : "text-app-muted hover:text-white"
            }`}
            onClick={() => setActiveTab(id)}
            title={title}
          >
            <Icon className="w-3 h-3" /> {label}
          </button>
        ))}
      </div>

      {/* Tab Content (scrolls internally) */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-3">
        {/* TRANSFORM TAB */}
        {activeTab === "transform" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase">
                  X Pos
                </label>
                <NumberField
                  name="x"
                  value={element.x}
                  onChange={handleChange}
                  disabled={element.isLocked}
                  className="w-full bg-app-base border border-app-border rounded px-1.5 py-1 text-[11px] outline-none focus:border-app-accent disabled:opacity-50"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase">
                  Y Pos
                </label>
                <NumberField
                  name="y"
                  value={element.y}
                  onChange={handleChange}
                  disabled={element.isLocked}
                  className="w-full bg-app-base border border-app-border rounded px-1.5 py-1 text-[11px] outline-none focus:border-app-accent disabled:opacity-50"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase">
                  Width
                </label>
                <NumberField
                  name="width"
                  value={element.width}
                  onChange={handleChange}
                  disabled={element.isLocked}
                  className="w-full bg-app-base border border-app-border rounded px-1.5 py-1 text-[11px] outline-none focus:border-app-accent disabled:opacity-50"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase">
                  Height
                </label>
                <NumberField
                  name="height"
                  value={element.height}
                  onChange={handleChange}
                  disabled={element.isLocked}
                  className="w-full bg-app-base border border-app-border rounded px-1.5 py-1 text-[11px] outline-none focus:border-app-accent disabled:opacity-50"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase flex justify-between">
                  <span>Rotation</span> <span>{element.rotation ?? 0}°</span>
                </label>
                <input
                  type="range"
                  name="rotation"
                  min="0"
                  max="359"
                  value={element.rotation ?? 0}
                  onChange={handleChange}
                  disabled={element.isLocked}
                  className="w-full accent-app-accent"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase flex justify-between">
                  <span>Opacity</span> <span>{element.opacity ?? 100}%</span>
                </label>
                <input
                  type="range"
                  name="opacity"
                  min="0"
                  max="100"
                  value={element.opacity ?? 100}
                  onChange={handleChange}
                  disabled={element.isLocked}
                  className="w-full accent-app-accent"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-[9px] text-app-muted uppercase cursor-pointer">
              <ToggleField
                name="isLocked"
                checked={element.isLocked || false}
                onChange={handleChange}
                className="rounded border-app-border bg-app-surface accent-app-accent"
              />
              <Lock className="w-3 h-3" />
              Lock Position &amp; Size
            </label>
          </div>
        )}

        {/* STYLE TAB */}
        {activeTab === "style" && (
          <div className="space-y-4">
            {/* Quick Styling */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase">
                  Design Variant
                </label>
                <SelectField
                  ariaLabel="Design variant"
                  value={element.variant || "Modernism"}
                  onChange={(val) =>
                    onUpdateElements([element.id], { variant: val })
                  }
                  disabled={element.isLocked}
                  options={[
                    { value: "Modernism", label: "Modernism" },
                    { value: "Neumorphic", label: "Neumorphic" },
                    { value: "Brutalist", label: "Brutalist" },
                    { value: "Classic", label: "Classic" },
                    { value: "CellShaded", label: "Cell Shaded" },
                    { value: "Minimal", label: "Minimal" },
                    { value: "Outline", label: "Outline" },
                    { value: "Checkbox", label: "Checkbox" },
                  ]}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase flex justify-between">
                  <span>Radius</span> <span>{element.cornerRadius ?? 4}px</span>
                </label>
                <input
                  type="range"
                  name="cornerRadius"
                  min="0"
                  max="100"
                  value={element.cornerRadius ?? 4}
                  onChange={handleChange}
                  disabled={element.isLocked}
                  className="w-full accent-app-accent mt-1"
                />
              </div>
            </div>

            {/* Colors */}
            <div className="space-y-1.5 bg-app-base p-2 rounded border border-app-border">
              <div className="flex items-center justify-between mb-1">
                <label className="text-[9px] text-app-muted uppercase">
                  Theme Colors
                </label>
                <label className="flex items-center gap-1 text-[9px] text-app-muted cursor-pointer">
                  <ToggleField
                    name="transparentBackground"
                    checked={element.transparentBackground || false}
                    onChange={handleChange}
                    disabled={element.isLocked}
                    className="rounded border-app-border bg-app-surface accent-app-accent"
                  />
                  Transparent Base
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ColorField
                  name="baseColor"
                  colorValue={element.baseColor || defaultColors.baseColor}
                  textValue={element.baseColor || ""}
                  onChange={handleChange}
                  colorDisabled={element.isLocked || element.transparentBackground}
                  textDisabled={element.isLocked || element.transparentBackground}
                  placeholder="Base"
                  wrapperClassName="flex items-center gap-1.5 border border-app-border/50 rounded px-1.5 py-1"
                  colorClassName="w-4 h-4 rounded cursor-pointer bg-transparent p-0 border-0 disabled:opacity-50 shrink-0"
                  textClassName="w-full bg-transparent text-[9px] outline-none disabled:opacity-50 uppercase"
                />
                <ColorField
                  name="activeColor"
                  colorValue={element.activeColor || defaultColors.activeColor}
                  textValue={element.activeColor || ""}
                  onChange={handleChange}
                  colorDisabled={element.isLocked}
                  textDisabled={element.isLocked}
                  placeholder="Active"
                  wrapperClassName="flex items-center gap-1.5 border border-app-border/50 rounded px-1.5 py-1"
                  colorClassName="w-4 h-4 rounded cursor-pointer bg-transparent p-0 border-0 disabled:opacity-50 shrink-0"
                  textClassName="w-full bg-transparent text-[9px] outline-none disabled:opacity-50 uppercase"
                />
                <ColorField
                  name="textColor"
                  colorValue={element.textColor || defaultColors.textColor}
                  textValue={element.textColor || ""}
                  onChange={handleChange}
                  colorDisabled={element.isLocked}
                  textDisabled={element.isLocked}
                  placeholder="Text"
                  wrapperClassName="flex items-center gap-1.5 border border-app-border/50 rounded px-1.5 py-1"
                  colorClassName="w-4 h-4 rounded cursor-pointer bg-transparent p-0 border-0 disabled:opacity-50 shrink-0"
                  textClassName="w-full bg-transparent text-[9px] outline-none disabled:opacity-50 uppercase"
                />
                <ColorField
                  name="borderColor"
                  colorValue={element.borderColor || defaultColors.borderColor}
                  textValue={element.borderColor || ""}
                  onChange={handleChange}
                  colorDisabled={element.isLocked}
                  textDisabled={element.isLocked}
                  placeholder="Border"
                  wrapperClassName="flex items-center gap-1.5 border border-app-border/50 rounded px-1.5 py-1"
                  colorClassName="w-4 h-4 rounded cursor-pointer bg-transparent p-0 border-0 disabled:opacity-50 shrink-0"
                  textClassName="w-full bg-transparent text-[9px] outline-none disabled:opacity-50 uppercase"
                />
                <ColorField
                  name="indicatorColor"
                  colorValue={
                    element.indicatorColor ||
                    element.activeColor ||
                    defaultColors.activeColor
                  }
                  textValue={element.indicatorColor || ""}
                  onChange={handleChange}
                  colorDisabled={element.isLocked}
                  textDisabled={element.isLocked}
                  placeholder="Indicator"
                  wrapperClassName="flex items-center gap-1.5 border border-app-border/50 rounded px-1.5 py-1"
                  colorClassName="w-4 h-4 rounded cursor-pointer bg-transparent p-0 border-0 disabled:opacity-50 shrink-0"
                  textClassName="w-full bg-transparent text-[9px] outline-none disabled:opacity-50 uppercase"
                />
              </div>
            </div>

            {/* Layer Blend Mode */}
            <div className="space-y-1.5 bg-app-base p-2 rounded border border-app-border">
              <label className="text-[9px] text-app-muted uppercase">
                Layer Blend Mode
              </label>
              <SelectField
                ariaLabel="Layer blend mode"
                value={element.blendMode || "normal"}
                onChange={(val) =>
                  onUpdateElements([element.id], { blendMode: val })
                }
                disabled={element.isLocked}
                options={BLEND_MODE_OPTIONS}
              />
            </div>
          </div>
        )}

        {/* FX TAB */}
        {activeTab === "fx" && (
          <div className="space-y-4">
            {/* Glow */}
            <div className="space-y-2 bg-app-base p-2 rounded border border-app-border">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-[9px] text-app-muted uppercase cursor-pointer">
                  <ToggleField
                    name="glow"
                    checked={element.glow || false}
                    onChange={handleChange}
                    disabled={element.isLocked}
                    className="rounded border-app-border bg-app-surface accent-app-accent"
                  />
                  Enable Glow
                </label>
                {element.glow && (
                  <label className="flex items-center gap-1.5 text-[9px] text-app-muted uppercase cursor-pointer">
                    <ToggleField
                      name="glowActiveOnly"
                      checked={element.glowActiveOnly || false}
                      onChange={handleChange}
                      disabled={element.isLocked}
                      className="rounded border-app-border bg-app-surface accent-app-accent"
                    />
                    Active Only
                  </label>
                )}
              </div>
              {element.glow && (
                <div className="space-y-2 mt-2 pt-2 border-t border-app-border/50">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[9px] text-app-muted uppercase">
                        Glow Style
                      </label>
                      <SelectField
                        ariaLabel="Glow style"
                        value={normalizeGlowStyle(element.glowStyle)}
                        onChange={(val) =>
                          onUpdateElements([element.id], { glowStyle: val as any })
                        }
                        disabled={element.isLocked}
                        options={[
                          { value: "outer", label: "Outer" },
                          { value: "inner", label: "Inner" },
                          { value: "center", label: "Center" },
                        ]}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] text-app-muted uppercase flex justify-between">
                        <span>Opacity</span>{" "}
                        <span>{element.glowOpacity ?? 100}%</span>
                      </label>
                      <input
                        type="range"
                        name="glowOpacity"
                        min="0"
                        max="100"
                        value={element.glowOpacity ?? 100}
                        onChange={handleChange}
                        disabled={element.isLocked}
                        className="w-full accent-app-accent mt-1"
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] text-app-muted uppercase flex justify-between">
                      <span>Intensity</span>{" "}
                      <span>{element.glowAmount ?? 50}%</span>
                    </label>
                    <input
                      type="range"
                      name="glowAmount"
                      min="0"
                      max="200"
                      value={element.glowAmount ?? 50}
                      onChange={handleChange}
                      disabled={element.isLocked}
                      className="w-full accent-app-accent mt-1"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] text-app-muted uppercase flex justify-between">
                      <span>Spread</span>{" "}
                      <span>{element.glowSpread ?? 10}px</span>
                    </label>
                    <input
                      type="range"
                      name="glowSpread"
                      min="0"
                      max="100"
                      value={element.glowSpread ?? 10}
                      onChange={handleChange}
                      disabled={element.isLocked}
                      className="w-full accent-app-accent mt-1"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[9px] text-app-muted uppercase">
                        Glow Color
                      </label>
                      <ColorField
                        name="glowColor"
                        colorValue={
                          element.glowColor ||
                          element.activeColor ||
                          defaultColors.activeColor
                        }
                        textValue={element.glowColor || ""}
                        onChange={handleChange}
                        colorDisabled={element.isLocked}
                        textDisabled={element.isLocked}
                        placeholder="Auto"
                        wrapperClassName="flex items-center gap-1.5 border border-app-border/50 rounded px-1.5 py-1 bg-app-surface"
                        colorClassName="w-4 h-4 rounded cursor-pointer bg-transparent p-0 border-0 disabled:opacity-50 shrink-0"
                        textClassName="w-full bg-transparent text-[9px] outline-none disabled:opacity-50 uppercase"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] text-app-muted uppercase">
                        Gradient
                      </label>
                      <TextField
                        name="glowGradient"
                        value={element.glowGradient || ""}
                        onChange={handleChange}
                        disabled={element.isLocked}
                        placeholder="e.g. linear-gradient(red, blue)"
                        className="w-full bg-app-surface border border-app-border rounded px-1.5 py-1 text-[10px] outline-none focus:border-app-accent disabled:opacity-50"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Animation Effect */}
            <div className="space-y-1 bg-app-base p-2 rounded border border-app-border">
              <label className="text-[9px] text-app-muted uppercase">
                Animation Effect
              </label>
              <SelectField
                ariaLabel="Animation effect"
                value={element.effect || "none"}
                onChange={(val) =>
                  onUpdateElements([element.id], { effect: val as any })
                }
                disabled={element.isLocked}
                options={EFFECT_OPTIONS}
              />
            </div>
          </div>
        )}

        {/* CONTROL TAB */}
        {activeTab === "control" && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-[9px] text-app-muted uppercase">
                Export Name
              </label>
              <TextField
                name="name"
                value={element.name}
                onChange={handleChange}
                disabled={element.isLocked}
                className="w-full bg-app-base border border-app-border rounded px-2 py-1 text-[11px] outline-none focus:border-app-accent disabled:opacity-50"
                placeholder="element_name"
              />
            </div>

            {["Button", "Label", "Toggle", "ValueBox"].includes(
              element.type,
            ) && (
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase">
                  Text / Label
                </label>
                <TextField
                  name="label"
                  value={element.label || ""}
                  onChange={handleChange}
                  disabled={element.isLocked}
                  className="w-full bg-app-base border border-app-border rounded px-2 py-1 text-[11px] outline-none focus:border-app-accent disabled:opacity-50"
                />
              </div>
            )}

            {["Knob", "Slider", "Meter"].includes(element.type) && (
              <div className="space-y-3 bg-app-base p-2 rounded border border-app-border">
                <div className="space-y-1">
                  <label className="text-[9px] text-app-muted uppercase flex justify-between">
                    <span>Value</span>{" "}
                    <span className="text-white">{element.value ?? 0}</span>
                  </label>
                  <input
                    type="range"
                    name="value"
                    min={element.min ?? 0}
                    max={element.max ?? 100}
                    value={element.value ?? 0}
                    onChange={handleChange}
                    disabled={element.isLocked}
                    className="w-full accent-app-accent"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[9px] text-app-muted uppercase">
                      Min
                    </label>
                    <NumberField
                      name="min"
                      value={element.min ?? 0}
                      onChange={handleChange}
                      disabled={element.isLocked}
                      className="w-full bg-app-surface border border-app-border rounded px-1.5 py-1 text-[11px] outline-none focus:border-app-accent disabled:opacity-50"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] text-app-muted uppercase">
                      Max
                    </label>
                    <NumberField
                      name="max"
                      value={element.max ?? 100}
                      onChange={handleChange}
                      disabled={element.isLocked}
                      className="w-full bg-app-surface border border-app-border rounded px-1.5 py-1 text-[11px] outline-none focus:border-app-accent disabled:opacity-50"
                    />
                  </div>
                </div>
              </div>
            )}

            {element.type === "Select" && (
              <div className="space-y-1">
                <label className="text-[9px] text-app-muted uppercase">
                  Options (comma separated)
                </label>
                <TextField
                  value={element.options?.join(", ") || ""}
                  onChange={(e) =>
                    onUpdateElements([element.id], {
                      options: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  disabled={element.isLocked}
                  className="w-full bg-app-base border border-app-border rounded px-2 py-1 text-[11px] outline-none focus:border-app-accent disabled:opacity-50"
                  placeholder="Opt 1, Opt 2, Opt 3"
                />
              </div>
            )}

            {/* Control Parameters — skin picker + generated per-param editors.
                Skin picker renders for every type except Group, so the box is
                never empty for non-Group elements. */}
            {element.type !== "Group" && (
              <div className="space-y-2 bg-app-base p-2 rounded border border-app-border">
                <div className="text-[9px] text-app-muted uppercase tracking-wider font-bold">
                  Control Parameters
                </div>
                <ControlParamsSection
                  element={element}
                  onUpdateElements={onUpdateElements}
                />
              </div>
            )}
          </div>
        )}

        {/* BINDING TAB — modulation-routing stack (see BindingPicker). The tab
            strip already labels this "Bind", so the picker fills the full,
            scrollable tab area without a redundant nested header/frame. */}
        {activeTab === "binding" && (
          <BindingPicker
            /* key: remount per element so per-instance picker state (e.g. the
               add-route axis selector) can never leak from one element onto a
               route for another (verify finding — latent, defended here). */
            key={element.id}
            element={element}
            elements={elements}
            onUpdateElements={onUpdateElements}
            showHeader={false}
          />
        )}

        {/* RAW TAB */}
        {activeTab === "raw" && (
          <div className="flex flex-col h-105 relative">
            <button
              onClick={() => {
                try {
                  const presetData = { ...element };
                  // Remove instance specific data
                  delete (presetData as any).id;
                  delete (presetData as any).x;
                  delete (presetData as any).y;

                  const saved = localStorage.getItem("vst-custom-presets");
                  const presets = saved ? JSON.parse(saved) : [];

                  const name = prompt(
                    "Enter a name for this preset:",
                    element.name + " Preset",
                  );
                  if (!name) return;

                  presets.push({
                    type: element.type,
                    variant: name,
                    label: name,
                    width: element.width,
                    height: element.height,
                    presetData,
                  });

                  localStorage.setItem(
                    "vst-custom-presets",
                    JSON.stringify(presets),
                  );
                  window.dispatchEvent(new Event("vst-preset-saved"));
                  alert("Preset saved!");
                } catch (e) {
                  alert("Error saving preset");
                }
              }}
              title="Save Modifications as New Preset"
              className="absolute bottom-4 right-8 z-10 bg-app-main text-app-base hover:bg-white p-2 rounded shadow-lg transition-colors flex items-center justify-center"
            >
              <Save className="w-4 h-4" />
            </button>

            <div className="flex-1 w-full h-full">
              <Editor
                key={element.id}
                height="100%"
                defaultLanguage="json"
                theme="vs-dark"
                defaultValue={JSON.stringify(element, null, 2)}
                options={{
                  minimap: { enabled: false },
                  fontSize: 11,
                  wordWrap: "on",
                  formatOnPaste: true,
                  scrollBeyondLastLine: false,
                  fixedOverflowWidgets: true,
                  padding: { top: 8, bottom: 8 },
                }}
                onChange={handleEditorChange}
                onMount={handleEditorMount}
              />
            </div>
          </div>
        )}

        {/* IMAGE TAB */}
        {activeTab === "image" && element.type === "Image" && (
          <div className="space-y-4">
            <div className="space-y-1.5 bg-app-base p-2 rounded border border-app-border">
              <div className="flex items-center justify-between mb-2">
                <label className="text-[9px] text-app-muted uppercase">
                  Background Removal
                </label>
                <label className="flex items-center gap-1 text-[9px] text-app-muted cursor-pointer">
                  <ToggleField
                    checked={element.imageModifiers?.removeBg || false}
                    onChange={(e) => {
                      onUpdateElements([element.id], {
                        imageModifiers: {
                          ...(element.imageModifiers || {}),
                          removeBg: e.target.checked,
                        },
                      });
                    }}
                    disabled={element.isLocked}
                    className="rounded border-app-border bg-app-surface accent-app-accent"
                  />
                  Enable
                </label>
              </div>

              {element.imageModifiers?.removeBg && (
                <div className="space-y-3 pt-2 border-t border-app-border/50">
                  <div className="space-y-1">
                    <label className="text-[9px] text-app-muted uppercase flex justify-between">
                      <span title="Tolerance (higher removes more colors similar to target)">
                        Tolerance
                      </span>
                      <span>{element.imageModifiers?.tolerance ?? 30}</span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="200"
                      value={element.imageModifiers?.tolerance ?? 30}
                      onChange={(e) => {
                        onUpdateElements([element.id], {
                          imageModifiers: {
                            ...(element.imageModifiers || {}),
                            tolerance: parseInt(e.target.value, 10),
                          },
                        });
                      }}
                      disabled={element.isLocked}
                      className="w-full accent-app-accent mt-1"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[9px] text-app-muted uppercase flex justify-between">
                      <span title="Feathering (smooths the edges of removed areas)">
                        Feathering
                      </span>
                      <span>{element.imageModifiers?.feathering ?? 0}</span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={element.imageModifiers?.feathering ?? 0}
                      onChange={(e) => {
                        onUpdateElements([element.id], {
                          imageModifiers: {
                            ...(element.imageModifiers || {}),
                            feathering: parseInt(e.target.value, 10),
                          },
                        });
                      }}
                      disabled={element.isLocked}
                      className="w-full accent-app-accent mt-1"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[9px] text-app-muted uppercase flex items-center justify-between">
                      <span title="Target color to remove. If empty, uses the top-left pixel color.">
                        Target Color
                      </span>
                      <button
                        onClick={() => {
                          onUpdateElements([element.id], {
                            imageModifiers: {
                              ...(element.imageModifiers || {}),
                              targetColor: undefined,
                            },
                          });
                        }}
                        className="text-[9px] text-app-accent hover:text-white"
                        title="Reset to Auto (Top-Left Pixel)"
                      >
                        Auto
                      </button>
                    </label>
                    <ColorField
                      colorValue={element.imageModifiers?.targetColor || "#000000"}
                      textValue={element.imageModifiers?.targetColor || ""}
                      onChange={(e) => {
                        onUpdateElements([element.id], {
                          imageModifiers: {
                            ...(element.imageModifiers || {}),
                            targetColor: e.target.value,
                          },
                        });
                      }}
                      colorDisabled={element.isLocked}
                      textDisabled={element.isLocked}
                      placeholder="Auto (Top-Left Pixel)"
                      wrapperClassName="flex items-center gap-1.5 border border-app-border/50 rounded px-1.5 py-1 bg-app-surface"
                      colorClassName="w-4 h-4 rounded cursor-pointer bg-transparent p-0 border-0 disabled:opacity-50 shrink-0"
                      textClassName="w-full bg-transparent text-[9px] outline-none disabled:opacity-50 uppercase"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5 bg-app-base p-2 rounded border border-app-border mt-2">
              <label className="text-[9px] text-app-muted uppercase">
                Layer Blend Mode
              </label>
              <SelectField
                ariaLabel="Image layer blend mode"
                value={element.blendMode || "normal"}
                onChange={(val) =>
                  onUpdateElements([element.id], { blendMode: val })
                }
                disabled={element.isLocked}
                options={BLEND_MODE_OPTIONS}
              />
            </div>
          </div>
        )}

        {/* TEXTURE TAB */}
        {activeTab === "texture" && (
          <div className="space-y-4">
            <div className="space-y-1.5 bg-app-base p-2 rounded border border-app-border">
              <label className="text-[9px] text-app-muted uppercase flex justify-between">
                <span>Background Texture</span>
                {element.textureId && (
                  <button
                    onClick={() =>
                      onUpdateElements([element.id], { textureId: undefined })
                    }
                    className="text-[9px] text-red-400 hover:text-red-300"
                  >
                    Remove
                  </button>
                )}
              </label>

              <div className="grid grid-cols-4 gap-1.5 pt-1">
                {textures.length === 0 && (
                  <div className="col-span-4 text-[10px] text-app-muted text-center py-4 border border-dashed border-app-border rounded">
                    Upload images in the Texture Library
                    <br />
                    to use them as textures.
                  </div>
                )}
                {textures.map((texture) => (
                  <button
                    key={texture.id}
                    onClick={() =>
                      onUpdateElements([element.id], { textureId: texture.id })
                    }
                    className={`aspect-square rounded border relative overflow-hidden group ${element.textureId === texture.id ? "border-app-accent" : "border-app-border hover:border-app-muted"}`}
                    title={texture.name}
                  >
                    <img
                      src={texture.url}
                      alt={texture.name}
                      className="w-full h-full object-cover"
                    />
                    {element.textureId === texture.id && (
                      <div className="absolute inset-0 border-2 border-app-accent rounded pointer-events-none" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {element.textureId && (
              <>
                <div className="space-y-1.5 bg-app-base p-2 rounded border border-app-border">
                  <label className="text-[9px] text-app-muted uppercase">
                    Blend Mode
                  </label>
                  <SelectField
                    ariaLabel="Texture blend mode"
                    value={element.textureBlendMode || "normal"}
                    onChange={(val) =>
                      onUpdateElements([element.id], { textureBlendMode: val })
                    }
                    disabled={element.isLocked}
                    options={TEXTURE_BLEND_MODE_OPTIONS}
                  />
                </div>

                <div className="space-y-1.5 bg-app-base p-2 rounded border border-app-border">
                  <label className="text-[9px] text-app-muted uppercase flex justify-between">
                    <span>Texture Opacity</span>
                    <span>{element.textureOpacity ?? 100}%</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={element.textureOpacity ?? 100}
                    onChange={(e) =>
                      onUpdateElements([element.id], {
                        textureOpacity: parseInt(e.target.value),
                      })
                    }
                    className="w-full accent-app-accent"
                  />
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <div className="space-y-1 bg-app-base p-1.5 rounded border border-app-border">
                    <label className="text-[9px] text-app-muted uppercase">
                      Size
                    </label>
                    <SelectField
                      ariaLabel="Texture size"
                      value={element.textureSize || "cover"}
                      onChange={(val) =>
                        onUpdateElements([element.id], {
                          textureSize: val as any,
                        })
                      }
                      disabled={element.isLocked}
                      options={[
                        { value: "cover", label: "Cover" },
                        { value: "contain", label: "Contain" },
                        { value: "auto", label: "Auto" },
                        { value: "100% 100%", label: "Stretch" },
                      ]}
                    />
                  </div>
                  <div className="space-y-1 bg-app-base p-1.5 rounded border border-app-border">
                    <label className="text-[9px] text-app-muted uppercase">
                      Repeat
                    </label>
                    <SelectField
                      ariaLabel="Texture repeat"
                      value={element.textureRepeat || "no-repeat"}
                      onChange={(val) =>
                        onUpdateElements([element.id], {
                          textureRepeat: val as any,
                        })
                      }
                      disabled={element.isLocked}
                      options={[
                        { value: "no-repeat", label: "No Repeat" },
                        { value: "repeat", label: "Repeat" },
                        { value: "repeat-x", label: "Repeat X" },
                        { value: "repeat-y", label: "Repeat Y" },
                      ]}
                    />
                  </div>
                </div>

                <div className="space-y-1.5 bg-app-base p-2 rounded border border-app-border">
                  <label className="text-[9px] text-app-muted uppercase flex justify-between">
                    <span>Scale</span>
                    <span>{element.textureScale ?? 100}%</span>
                  </label>
                  <input
                    type="range"
                    min="10"
                    max="400"
                    value={element.textureScale ?? 100}
                    onChange={(e) =>
                      onUpdateElements([element.id], {
                        textureScale: parseInt(e.target.value),
                      })
                    }
                    className="w-full accent-app-accent"
                  />
                </div>

                <div className="space-y-1.5 bg-app-base p-2 rounded border border-app-border">
                  <label className="text-[9px] text-app-muted uppercase flex justify-between">
                    <span>Rotation</span>
                    <span>{element.textureRotation ?? 0}°</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="360"
                    value={element.textureRotation ?? 0}
                    onChange={(e) =>
                      onUpdateElements([element.id], {
                        textureRotation: parseInt(e.target.value),
                      })
                    }
                    className="w-full accent-app-accent"
                  />
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <div className="space-y-1 bg-app-base p-1.5 rounded border border-app-border">
                    <label className="text-[9px] text-app-muted uppercase">
                      Offset X
                    </label>
                    <NumberField
                      value={element.textureOffsetX ?? 0}
                      onChange={(e) => {
                        const num = parseNumericInput(e.target.value);
                        if (num === null) return;
                        onUpdateElements([element.id], {
                          textureOffsetX: num,
                        });
                      }}
                      className="w-full bg-app-surface border border-app-border rounded text-[10px] p-1 text-white outline-none focus:border-app-accent"
                    />
                  </div>
                  <div className="space-y-1 bg-app-base p-1.5 rounded border border-app-border">
                    <label className="text-[9px] text-app-muted uppercase">
                      Offset Y
                    </label>
                    <NumberField
                      value={element.textureOffsetY ?? 0}
                      onChange={(e) => {
                        const num = parseNumericInput(e.target.value);
                        if (num === null) return;
                        onUpdateElements([element.id], {
                          textureOffsetY: num,
                        });
                      }}
                      className="w-full bg-app-surface border border-app-border rounded text-[10px] p-1 text-white outline-none focus:border-app-accent"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
