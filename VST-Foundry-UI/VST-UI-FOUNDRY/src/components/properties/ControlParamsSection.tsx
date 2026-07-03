/**
 * ControlParamsSection — the generated "Control Parameters" editor shared by
 * PropertiesPanel and CompactElementProperties.
 *
 * Two responsibilities:
 *   1. A universal "Skin" picker on every element type except Group. The chosen
 *      skin id is stored on `element.skin` (cleared to undefined for "none").
 *   2. One generated editor per param declared for the element's type/variant in
 *      controlParams.ts (number → range + numeric input, color → ColorField,
 *      toggle → ToggleField, select → SelectField). Values live in
 *      `element.styleParams` and are serialized whole with the element, so no
 *      save-path changes are needed.
 *
 * Rendered without its own section title — callers frame it (a CollapsibleSection
 * in PropertiesPanel, a boxed header in CompactElementProperties).
 */
import { ELEMENT_TYPES, type UIElement } from "../../types";
import { SKINS } from "../../lib/skins";
import { paramsForElement, type ControlParamDef } from "../controls/controlParams";
import { NumberField, ToggleField, ColorField, SelectField } from "./fields";
import { parseNumericInput, type UpdateElementsFn } from "./useElementField";

interface ControlParamsSectionProps {
  element: UIElement;
  onUpdateElements: UpdateElementsFn;
}

export default function ControlParamsSection({
  element,
  onUpdateElements,
}: ControlParamsSectionProps) {
  const showSkin = element.type !== "Group";
  // Face-behavior params (keys prefixed "face*") only make sense once the
  // control is actually wearing an image. Hide them until element.faceSrc is
  // set, so a plain control's editor stays exactly as before.
  const defs = paramsForElement(element).filter(
    (d) => element.faceSrc || !d.key.startsWith("face"),
  );

  // Nothing to render (Group with no params).
  if (!showSkin && defs.length === 0) return null;

  const locked = !!element.isLocked;

  // Write a single control param into element.styleParams (merging with any
  // existing values so unrelated params are preserved).
  const setParam = (key: string, value: number | string | boolean) => {
    onUpdateElements([element.id], {
      styleParams: { ...element.styleParams, [key]: value },
    });
  };

  // Clear every param key this section manages; drop styleParams entirely when
  // nothing else remains so saved projects don't carry an empty object.
  const sectionKeys = defs.map((d) => d.key);
  const hasOverrides =
    !!element.styleParams &&
    sectionKeys.some((k) => element.styleParams?.[k] !== undefined);
  const handleReset = () => {
    if (!element.styleParams) return;
    const next: Record<string, number | string | boolean> = {
      ...element.styleParams,
    };
    for (const k of sectionKeys) delete next[k];
    onUpdateElements([element.id], {
      styleParams: Object.keys(next).length ? next : undefined,
    });
  };

  // Skin picker options: keep whatever "none" entry the skin library provides,
  // otherwise prepend one so the default (unskinned) state is selectable.
  const skinOptions = [
    ...(SKINS.some((s) => s.id === "none")
      ? []
      : [{ value: "none", label: "None" }]),
    ...SKINS.map((s) => ({ value: s.id, label: s.label })),
  ];

  const renderParam = (def: ControlParamDef) => {
    const value = element.styleParams?.[def.key] ?? def.default;
    const pid = `cp-${element.id}-${def.key}`;

    if (def.type === "number") {
      const rangeId = `${pid}-range`;
      const num = Number(value);
      const min = def.min ?? 0;
      const max = def.max ?? 100;
      const step = def.step ?? 1;
      return (
        <div key={def.key} className="space-y-1">
          <label
            htmlFor={rangeId}
            className="text-[10px] text-app-muted flex justify-between"
          >
            <span>{def.label}</span>
            <span className="font-mono">{num}</span>
          </label>
          <div className="flex gap-2 items-center">
            <input
              type="range"
              id={rangeId}
              name={def.key}
              min={min}
              max={max}
              step={step}
              value={num}
              onChange={(e) => setParam(def.key, Number(e.target.value))}
              disabled={locked}
              className="w-full accent-app-main disabled:opacity-50"
            />
            {/* NumberField has no id prop; a wrapping label with sr-only text
                gives its single native input an accessible name. */}
            <label className="shrink-0">
              <span className="sr-only">{def.label}</span>
              <NumberField
                name={def.key}
                value={num}
                onChange={(e) => {
                  const parsed = parseNumericInput(e.target.value);
                  if (parsed === null) return;
                  setParam(def.key, parsed);
                }}
                disabled={locked}
                className="w-16 bg-app-surface neu-panel-inset border border-app-border rounded px-1.5 py-1 text-xs text-app-main font-mono focus:outline-none focus:border-app-main disabled:opacity-50"
              />
            </label>
          </div>
        </div>
      );
    }

    if (def.type === "toggle") {
      return (
        <div key={def.key} className="flex items-center gap-2">
          <ToggleField
            id={pid}
            name={def.key}
            checked={Boolean(value)}
            onChange={(e) => setParam(def.key, e.target.checked)}
            disabled={locked}
            className="w-3.5 h-3.5 rounded border-app-border bg-app-surface neu-panel-inset text-app-main focus:ring-app-main"
          />
          <label
            htmlFor={pid}
            className="text-[10px] text-app-muted cursor-pointer select-none"
          >
            {def.label}
          </label>
        </div>
      );
    }

    if (def.type === "color") {
      // ColorField (shared) renders two native inputs sharing `name` and
      // exposes no id/aria prop, so we can't htmlFor-associate a single input.
      // A plain visible label + `name` + text-input placeholder matches every
      // other ColorField usage in these panels.
      return (
        <div key={def.key} className="space-y-1">
          <label className="text-[10px] text-app-muted block">
            {def.label}
          </label>
          <ColorField
            name={def.key}
            colorValue={String(value)}
            textValue={String(value)}
            onChange={(e) => setParam(def.key, e.target.value)}
            colorDisabled={locked}
            textDisabled={locked}
            placeholder={def.label}
            wrapperClassName="flex items-center gap-1"
            colorClassName="w-6 h-6 rounded cursor-pointer bg-app-surface neu-panel-inset border border-app-border disabled:opacity-50 p-0.5 shrink-0"
            textClassName="flex-1 bg-app-surface neu-panel-inset border border-app-border rounded px-1.5 py-1 text-xs text-app-main w-full min-w-0 disabled:opacity-50 font-mono"
          />
        </div>
      );
    }

    // select
    return (
      <div key={def.key} className="space-y-1">
        <label className="text-[10px] text-app-muted block">{def.label}</label>
        <SelectField
          ariaLabel={def.label}
          value={String(value)}
          onChange={(v) => setParam(def.key, v)}
          options={(def.options ?? []).map((o) => ({ value: o, label: o }))}
          disabled={locked}
        />
      </div>
    );
  };

  // An element that carries a picture (a control wearing a face, or an Image
  // layer backed by an asset — e.g. a placed extractor cutout) can be re-typed
  // in place: Image → working control, control → different control, control →
  // back to Image. App owns the actual conversion (Image↔face translation
  // needs the asset store), signalled the same way as vst-arsenal-save.
  const showTypeConvert =
    !!element.faceSrc || (element.type === "Image" && !!element.assetId);
  const convertOptions = ELEMENT_TYPES.filter(
    (t) => t !== "Group" && t !== "CustomCode",
  ).map((t) => ({ value: t, label: t }));

  return (
    <div className="space-y-3">
      {showTypeConvert && (
        <div className="space-y-1">
          <label className="text-[10px] text-app-muted block">
            Control Type
          </label>
          <SelectField
            ariaLabel="Convert element to control type"
            value={element.type}
            onChange={(v) => {
              if (v === element.type) return;
              window.dispatchEvent(
                new CustomEvent("vst-convert-type", {
                  detail: { elementId: element.id, targetType: v },
                }),
              );
            }}
            options={convertOptions}
            disabled={locked}
          />
        </div>
      )}

      {showSkin && (
        <div className="space-y-1">
          <label className="text-[10px] text-app-muted block">Skin</label>
          <SelectField
            ariaLabel="Element skin"
            value={element.skin ?? "none"}
            onChange={(v) =>
              onUpdateElements([element.id], {
                skin: v === "none" ? undefined : v,
              })
            }
            options={skinOptions}
            disabled={locked}
          />
        </div>
      )}

      {defs.map(renderParam)}

      {hasOverrides && (
        <button
          type="button"
          onClick={handleReset}
          disabled={locked}
          className="text-[10px] text-app-accent hover:text-white disabled:opacity-50"
        >
          Reset parameters
        </button>
      )}

      {/* Control actions — the two live on independent gates (C5). "Save to
          Arsenal" applies to ANY non-Group control (a face image is optional,
          the Arsenal stores the whole preset either way; a group has no single
          control to save) and dispatches the C5 signal App listens for.
          "Remove face image" only appears once the control actually wears an
          image, clearing faceSrc through the same onUpdateElements channel the
          section already uses (dropping back to the programmatic render). The
          wrapper renders whenever at least one action qualifies, so a plain
          Group still shows nothing. */}
      {(element.type !== "Group" || element.faceSrc) && (
        <div className="flex flex-col items-start gap-1.5 pt-2 border-t border-app-border">
          {element.faceSrc && (
            <button
              type="button"
              onClick={() =>
                onUpdateElements([element.id], { faceSrc: undefined })
              }
              disabled={locked}
              className="text-[10px] text-app-muted hover:text-white disabled:opacity-50"
            >
              Remove face image
            </button>
          )}
          {element.type !== "Group" && (
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("vst-arsenal-save", {
                    detail: { elementId: element.id },
                  }),
                )
              }
              disabled={locked}
              className="text-[10px] text-app-accent hover:text-white disabled:opacity-50"
            >
              Save to Arsenal
            </button>
          )}
        </div>
      )}
    </div>
  );
}
