import { useState } from "react";
import { ExtractedElement } from "../../lib/extractor/types";
import { ElementType, ELEMENT_TYPES } from "../../types";
import { ELEMENT_TYPE_ALIASES, normalizeElementType } from "../orb/elements";
import {
  Trash2,
  Loader2,
  Sparkles,
  Crop,
  Scissors,
  Brush,
  Download,
  SaveAll,
  Plus,
  Layers,
  ArrowRight,
  Palette,
  SlidersHorizontal,
  RefreshCw,
} from "lucide-react";
import JSZip from "jszip";
import { saveAs } from "file-saver";

interface ExtractTrayProps {
  elements: ExtractedElement[];
  onDelete: (id: string) => void;
  onUpdate: (id: string, updates: Partial<ExtractedElement>) => void;
  onEditMask: (id: string) => void;
  onAddToDesign: (els: ExtractedElement[], placeOnCanvas: boolean) => void;
  onAddAsTextures: (els: ExtractedElement[]) => void;
  // Promote cutouts to real interactive controls that wear the image as their
  // face. Each item carries the chosen target control type (see per-card select
  // below); the modal handles the durable face upload + layer placement.
  onMakeControls: (
    items: { el: ExtractedElement; controlType: ElementType }[],
  ) => void;
  // Global sensitivity (the toolbar slider) — seeds each card's re-process
  // slider so "Redo" without touching anything repeats the original settings.
  sensitivity: number;
  // Re-run the pipeline on one element at an alternative sensitivity.
  onReprocess: (el: ExtractedElement, sensitivity: number) => void;
}

export default function ExtractTray({
  elements,
  onDelete,
  onUpdate,
  onEditMask,
  onAddToDesign,
  onAddAsTextures,
  onMakeControls,
  sensitivity,
  onReprocess,
}: ExtractTrayProps) {
  const [isSavingAll, setIsSavingAll] = useState(false);
  // Per-card control-type overrides, keyed by element id. Unset entries fall
  // back to the detected default (see defaultControlType), so the select always
  // has a value without needing to seed state up front.
  const [controlTypes, setControlTypes] = useState<Record<string, ElementType>>(
    {},
  );
  // Per-card re-process sensitivity overrides, keyed by element id. Unset
  // entries fall back to the global toolbar sensitivity, so "Redo" without
  // touching the slider simply repeats the original settings.
  const [reproSens, setReproSens] = useState<Record<string, number>>({});
  const reproFor = (el: ExtractedElement): number =>
    reproSens[el.id] ?? sensitivity;

  const labeledEls = elements.filter((el) => el.status === "labeled");

  // Alias-normalized detected type, defaulting to "Image" — NOT "Knob" — when
  // the detector's raw type has no alias entry. normalizeElementType alone
  // falls back to "Knob", which would misfile a logo/graphic as a knob; a
  // graphic with no control meaning should stay an Image, so we check the alias
  // map ourselves and only trust normalizeElementType on an alias hit.
  const defaultControlType = (el: ExtractedElement): ElementType => {
    const raw = typeof el.type === "string" ? el.type : "";
    const key = raw.toLowerCase().replace(/[\s_-]/g, "");
    return ELEMENT_TYPE_ALIASES[key] ? normalizeElementType(raw) : "Image";
  };

  // Current selection for a card: the user's override if set, else the detected
  // default. Used by both the per-card and "Place All as Controls" actions.
  const selectionFor = (el: ExtractedElement): ElementType =>
    controlTypes[el.id] ?? defaultControlType(el);

  const handleSaveAll = async () => {
    if (elements.length === 0) return;
    setIsSavingAll(true);

    try {
      const zip = new JSZip();

      const metadataList = elements.map((el) => ({
        id: el.id,
        label: el.label,
        type: el.type,
        group: el.group,
        tags: el.tags,
        bounds: {
          xmin: el.xmin,
          ymin: el.ymin,
          xmax: el.xmax,
          ymax: el.ymax,
        },
      }));

      zip.file("metadata.json", JSON.stringify(metadataList, null, 2));

      // Track sanitized file names so duplicate labels do not overwrite each
      // other inside the zip; a repeated name is suffixed with its index.
      const usedNames = new Set<string>();
      elements.forEach((el, index) => {
        const currentImg =
          el.displayMode === "mask" && el.maskDataUrl
            ? el.maskDataUrl
            : el.displayMode === "cutout" && el.cutoutDataUrl
              ? el.cutoutDataUrl
              : el.cropDataUrl;

        if (currentImg) {
          // Remove the data URI prefix (e.g., "data:image/png;base64,")
          const base64Data = currentImg.replace(/^data:image\/\w+;base64,/, "");
          const base = el.label
            ? el.label.replace(/[^a-z0-9]/gi, "_").toLowerCase()
            : `asset_${index}`;
          let fileName = `${base}.png`;
          if (usedNames.has(fileName)) {
            fileName = `${base}_${index}.png`;
          }
          usedNames.add(fileName);
          zip.file(fileName, base64Data, { base64: true });
        }
      });

      const content = await zip.generateAsync({ type: "blob" });
      saveAs(content, "assets.zip");
    } catch (err) {
      console.error("Failed to save all assets", err);
    } finally {
      setIsSavingAll(false);
    }
  };

  return (
    <div className="w-80 border-l border-app-border bg-app-base flex flex-col shrink-0 overflow-hidden">
      <div className="border-b border-app-border px-4 py-3 shrink-0 bg-app-surface flex flex-col gap-2">
        <h2 className="font-semibold text-sm text-app-main">Captured Assets ({elements.length})</h2>
        {elements.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={handleSaveAll}
              disabled={isSavingAll}
              className="text-xs flex items-center gap-1.5 bg-app-surface hover:bg-app-surface-hover disabled:opacity-50 text-app-main py-1 px-2.5 rounded border border-app-border transition-colors"
            >
              {isSavingAll ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <SaveAll className="w-3.5 h-3.5" />
              )}
              Save All
            </button>
            <button
              type="button"
              onClick={() => onAddToDesign(labeledEls, false)}
              disabled={labeledEls.length === 0}
              className="text-xs flex items-center gap-1.5 bg-app-surface hover:bg-app-surface-hover disabled:opacity-50 text-app-main py-1 px-2.5 rounded border border-app-border transition-colors"
              title="Add all labeled elements to the design asset library"
            >
              <Plus className="w-3.5 h-3.5" />
              Add All as Assets
            </button>
            <button
              type="button"
              onClick={() => onAddAsTextures(labeledEls)}
              disabled={labeledEls.length === 0}
              className="text-xs flex items-center gap-1.5 bg-app-surface hover:bg-app-surface-hover disabled:opacity-50 text-app-main py-1 px-2.5 rounded border border-app-border transition-colors"
              title="Add all labeled elements to the Texture Library for use on UI elements"
            >
              <Palette className="w-3.5 h-3.5" />
              Add All as Textures
            </button>
            <button
              type="button"
              onClick={() => onAddToDesign(labeledEls, true)}
              disabled={labeledEls.length === 0}
              className="btn-3d text-white text-xs flex items-center gap-1.5 disabled:opacity-50 py-1 px-2.5 rounded"
              title="Place all labeled elements onto the design canvas as layers"
            >
              <Layers className="w-3.5 h-3.5" />
              Place All as Layers
            </button>
            <button
              type="button"
              onClick={() =>
                onMakeControls(
                  labeledEls.map((el) => ({
                    el,
                    controlType: selectionFor(el),
                  })),
                )
              }
              disabled={labeledEls.length === 0}
              className="btn-3d text-white text-xs flex items-center gap-1.5 disabled:opacity-50 py-1 px-2.5 rounded"
              title="Promote all labeled cutouts to interactive controls, each using its selected control type"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Place All as Controls
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {elements.length === 0 ? (
          <div className="text-app-muted text-sm text-center mt-10">
            Drag a box on the image to capture an asset.
          </div>
        ) : (
          elements
            .slice()
            .reverse()
            .map((el) => {
              const currentImg =
                el.displayMode === "mask" && el.maskDataUrl
                  ? el.maskDataUrl
                  : el.displayMode === "cutout" && el.cutoutDataUrl
                    ? el.cutoutDataUrl
                    : el.cropDataUrl;

              return (
                <div
                  key={el.id}
                  className="bg-app-surface border border-app-border rounded-lg overflow-hidden group shadow-sm flex flex-col"
                >
                  <div
                    className="bg-app-base/50 p-3 flex justify-center items-center h-40 relative group/img"
                    style={{
                      backgroundImage:
                        "url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAAMElEQVQ4T2P8z8Dwn4GKgHHUQBoG/mOUYkBBMy2mO41yqGFAi8VMRvNQDcR/qIQBALSZNxE9iG7uAAAAAElFTkSuQmCC')",
                    }}
                  >
                    {currentImg ? (
                      <img
                        src={currentImg}
                        alt={el.label}
                        className="max-w-full max-h-full object-contain drop-shadow-md"
                      />
                    ) : (
                      <div className="text-xs text-app-muted">No Image</div>
                    )}

                    <button
                      type="button"
                      onClick={() => onDelete(el.id)}
                      className="absolute top-2 right-2 bg-red-900/80 hover:bg-red-600 text-white p-1.5 rounded-md opacity-0 group-hover/img:opacity-100 transition-opacity"
                      title="Delete asset"
                      aria-label="Delete asset"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>

                    {el.status === "detected" && (
                      <div
                        className="absolute top-2 left-2 bg-blue-900/80 text-blue-200 p-1 rounded"
                        title="Auto-detected"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                      </div>
                    )}
                  </div>

                  {/* Mode Toggles */}
                  <div className="grid grid-cols-3 border-y border-app-border bg-app-base/80">
                    <button
                      type="button"
                      aria-pressed={el.displayMode === "rect"}
                      onClick={() => onUpdate(el.id, { displayMode: "rect" })}
                      className={`flex flex-col items-center gap-1 py-1.5 transition-colors ${el.displayMode === "rect" ? "bg-app-surface-hover text-app-main" : "text-app-muted hover:text-app-main hover:bg-app-surface"}`}
                    >
                      <Crop className="w-3.5 h-3.5" />
                      <span className="text-[10px] font-medium leading-none">Rect</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={el.displayMode === "cutout"}
                      onClick={() => onUpdate(el.id, { displayMode: "cutout" })}
                      disabled={!el.cutoutDataUrl}
                      className={`flex flex-col items-center gap-1 py-1.5 transition-colors ${!el.cutoutDataUrl ? "opacity-30 cursor-not-allowed" : el.displayMode === "cutout" ? "bg-blue-500/10 text-blue-400" : "text-app-muted hover:text-app-main hover:bg-app-surface"}`}
                    >
                      <Scissors className="w-3.5 h-3.5" />
                      <span className="text-[10px] font-medium leading-none">Auto</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={el.displayMode === "mask"}
                      onClick={() => {
                        if (!el.maskDataUrl || el.displayMode === "mask") {
                          onEditMask(el.id);
                          onUpdate(el.id, { displayMode: "mask" });
                        } else {
                          onUpdate(el.id, { displayMode: "mask" });
                        }
                      }}
                      className={`flex flex-col items-center gap-1 py-1.5 transition-colors ${el.displayMode === "mask" ? "bg-purple-500/10 text-purple-400" : "text-app-muted hover:text-app-main hover:bg-app-surface"}`}
                    >
                      <Brush className="w-3.5 h-3.5" />
                      <span className="text-[10px] font-medium leading-none">
                        {el.maskDataUrl && el.displayMode === "mask" ? "Edit Mask" : "Mask"}
                      </span>
                    </button>
                  </div>

                  <div className="p-3 flex flex-col gap-3">
                    {el.status === "processing" ? (
                      <div className="flex items-center gap-2 text-purple-400 text-sm font-medium">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Generating Cutout...
                      </div>
                    ) : el.status === "pending" || el.status === "detected" ? (
                      <div className="flex items-center gap-2 text-app-muted text-sm italic">
                        Waiting to process...
                      </div>
                    ) : (
                      <>
                        <input
                          type="text"
                          id={"extract-label-" + el.id}
                          name={"extract-label-" + el.id}
                          aria-label="Element label"
                          value={el.label}
                          onChange={(e) => onUpdate(el.id, { label: e.target.value })}
                          className="bg-app-base hover:bg-app-surface focus:bg-app-surface border border-app-border text-app-main text-sm font-medium w-full px-2 py-1.5 rounded transition-colors outline-none focus:border-app-accent"
                          placeholder="Label"
                        />

                        <div className="flex flex-col gap-1.5">
                          {el.group && (
                            <div className="text-[11px] text-app-muted font-semibold px-1">
                              {el.group}
                            </div>
                          )}
                          {el.tags && el.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 px-1">
                              {el.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="px-1.5 py-0.5 rounded bg-app-surface-hover text-app-main text-[10px] font-mono whitespace-nowrap"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                          {!el.group && (!el.tags || el.tags.length === 0) && (
                            <div className="text-[11px] text-app-muted px-1 italic">
                              No tags detected
                            </div>
                          )}
                        </div>

                        {/* Target control type for "Make Control" — defaults to
                            the detected type (Image for graphics with no control
                            alias), overridable per card. */}
                        <div className="flex items-center gap-2">
                          <label
                            htmlFor={"extract-type-" + el.id}
                            className="text-[11px] text-app-muted font-semibold shrink-0"
                          >
                            Control type
                          </label>
                          <select
                            id={"extract-type-" + el.id}
                            name={"extract-type-" + el.id}
                            aria-label="Control type"
                            value={selectionFor(el)}
                            onChange={(e) =>
                              setControlTypes((prev) => ({
                                ...prev,
                                [el.id]: e.target.value as ElementType,
                              }))
                            }
                            className="bg-app-base hover:bg-app-surface focus:bg-app-surface border border-app-border text-app-main text-sm w-full px-2 py-1.5 rounded transition-colors outline-none focus:border-app-accent"
                          >
                            {ELEMENT_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Re-process at an alternative sensitivity — for when
                            the first pass produced a bad cutout or labels. */}
                        <div className="flex items-center gap-2">
                          <label
                            htmlFor={"extract-resens-" + el.id}
                            className="text-[11px] text-app-muted font-semibold shrink-0"
                          >
                            Sens {Math.round(reproFor(el) * 100)}%
                          </label>
                          <input
                            type="range"
                            id={"extract-resens-" + el.id}
                            name={"extract-resens-" + el.id}
                            min="0"
                            max="1"
                            step="0.05"
                            value={reproFor(el)}
                            onChange={(e) =>
                              setReproSens((prev) => ({
                                ...prev,
                                [el.id]: parseFloat(e.target.value),
                              }))
                            }
                            className="w-full accent-purple-500"
                          />
                          <button
                            type="button"
                            onClick={() => onReprocess(el, reproFor(el))}
                            className="text-app-accent hover:text-app-main flex items-center gap-1 font-sans font-medium text-[11px] shrink-0"
                            title="Re-run detection + cutout on this element at the sensitivity above"
                          >
                            <RefreshCw className="w-3 h-3" />
                            Redo
                          </button>
                        </div>
                      </>
                    )}

                    <div className="text-[10px] text-app-muted font-mono flex justify-between items-center px-1">
                      <span>ID: {el.id}</span>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => onAddToDesign([el], true)}
                          className="text-app-accent hover:text-app-main flex items-center gap-1 font-sans font-medium"
                          title="Send to design canvas as a layer"
                        >
                          <ArrowRight className="w-3 h-3" />
                          Design
                        </button>
                        <button
                          type="button"
                          onClick={() => onAddAsTextures([el])}
                          className="text-app-accent hover:text-app-main flex items-center gap-1 font-sans font-medium"
                          title="Add to the Texture Library for use on UI elements"
                        >
                          <Palette className="w-3 h-3" />
                          Tex
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            onMakeControls([
                              { el, controlType: selectionFor(el) },
                            ])
                          }
                          className="text-app-accent hover:text-app-main flex items-center gap-1 font-sans font-medium"
                          title="Make an interactive control that wears this cutout as its face"
                        >
                          <SlidersHorizontal className="w-3 h-3" />
                          Control
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const link = document.createElement("a");
                            link.download = `${el.label || el.id}.png`;
                            link.href = currentImg || "";
                            link.click();
                          }}
                          className="text-blue-400 hover:text-blue-300 flex items-center gap-1 font-sans font-medium"
                        >
                          <Download className="w-3 h-3" />
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}
