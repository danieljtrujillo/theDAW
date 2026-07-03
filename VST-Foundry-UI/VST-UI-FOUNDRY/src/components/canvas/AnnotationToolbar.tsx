import React, { useState } from "react";
import { Pencil, Square, Circle, Type, Eraser, MousePointer2, Eye, EyeOff, Trash2, Palette } from "lucide-react";
import { AnnotationLegendEntry, CanvasState, ElementType } from "../../types";
import { AnnotationSubTool, ANNOTATION_PALETTE } from "./AnnotationLayer";

const LEGEND_TYPE_OPTIONS: (ElementType | "Other")[] = [
  "Knob", "Slider", "Button", "Toggle", "Select", "Label", "Meter", "Waveform",
  "XYPad", "Envelope", "StepSequencer", "Keyboard", "Image", "Other",
];

interface AnnotationToolbarProps {
  canvasState: CanvasState;
  subTool: AnnotationSubTool;
  color: string;
  strokeWidth: number;
  onSetSubTool: (t: AnnotationSubTool) => void;
  onSetColor: (c: string) => void;
  onSetStrokeWidth: (w: number) => void;
  onUpdateCanvas: (updates: Partial<CanvasState>) => void;
}

const SUB_TOOLS: { id: AnnotationSubTool; icon: React.ReactNode; title: string }[] = [
  { id: "pen", icon: <Pencil size={13} />, title: "Freehand pen" },
  { id: "rect", icon: <Square size={13} />, title: "Rectangle (drag to draw, resizable)" },
  { id: "ellipse", icon: <Circle size={13} />, title: "Ellipse (drag to draw, resizable)" },
  { id: "text", icon: <Type size={13} />, title: "Text note (click to type; Enter saves)" },
  { id: "eraser", icon: <Eraser size={13} />, title: "Eraser (partially erases strokes, removes shapes/notes)" },
  { id: "move", icon: <MousePointer2 size={13} />, title: "Move / resize / delete annotations" },
];

export default function AnnotationToolbar({
  canvasState,
  subTool,
  color,
  strokeWidth,
  onSetSubTool,
  onSetColor,
  onSetStrokeWidth,
  onUpdateCanvas,
}: AnnotationToolbarProps) {
  const [showLegend, setShowLegend] = useState(false);
  const legend = canvasState.annotationLegend || [];
  const visible = canvasState.showAnnotations !== false;

  const setLegend = (entries: AnnotationLegendEntry[]) =>
    onUpdateCanvas({ annotationLegend: entries });

  const legendFor = (c: string) => legend.find((l) => l.color.toLowerCase() === c.toLowerCase());

  return (
    <div className="absolute bottom-16 left-1/2 -translate-x-1/2 bg-app-base border border-app-border rounded-lg p-2 shadow-xl z-50 flex items-center gap-2">
      {SUB_TOOLS.map((t) => (
        <button
          key={t.id}
          onClick={() => onSetSubTool(t.id)}
          className={`p-1.5 rounded transition-colors ${subTool === t.id ? "btn-3d text-white" : "text-app-muted hover:bg-app-surface"}`}
          title={t.title}
          aria-label={t.title}
          aria-pressed={subTool === t.id}
        >
          {t.icon}
        </button>
      ))}

      <div className="w-px h-5 bg-app-surface-hover" />

      {/* palette — swatches badge their legend meaning */}
      <div className="flex items-center gap-1">
        {ANNOTATION_PALETTE.map((c) => {
          const entry = legendFor(c);
          return (
            <button
              key={c}
              onClick={() => onSetColor(c)}
              className={`w-5 h-5 rounded-full border-2 transition-transform ${color.toLowerCase() === c ? "border-white scale-110" : "border-transparent hover:scale-105"}`}
              style={{ backgroundColor: c }}
              title={entry ? `${c} = ${entry.meaning}` : c}
              aria-label={entry ? `Color ${c}, means ${entry.meaning}` : `Color ${c}`}
            />
          );
        })}
        <input
          type="color"
          id="annotation-custom-color"
          name="annotation-custom-color"
          value={color}
          onChange={(e) => onSetColor(e.target.value)}
          className="w-6 h-6 rounded cursor-pointer bg-transparent border-none p-0"
          title="Custom color"
          aria-label="Custom annotation color"
        />
      </div>

      <div className="w-px h-5 bg-app-surface-hover" />

      <input
        type="range"
        id="annotation-stroke-width"
        name="annotation-stroke-width"
        min={1}
        max={12}
        value={strokeWidth}
        onChange={(e) => onSetStrokeWidth(Number(e.target.value))}
        className="w-16"
        title={`Stroke width: ${strokeWidth}px`}
        aria-label="Annotation stroke width"
      />

      <div className="w-px h-5 bg-app-surface-hover" />

      <button
        onClick={() => onUpdateCanvas({ showAnnotations: !visible })}
        className="p-1.5 rounded text-app-muted hover:bg-app-surface transition-colors"
        title={visible ? "Hide annotations" : "Show annotations"}
        aria-label={visible ? "Hide annotations" : "Show annotations"}
      >
        {visible ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>

      <button
        onClick={() => {
          if ((canvasState.annotations || []).length === 0) return;
          if (window.confirm("Clear ALL annotations from the board?")) {
            onUpdateCanvas({ annotations: [] });
          }
        }}
        className="p-1.5 rounded text-app-muted hover:bg-app-surface hover:text-red-400 transition-colors"
        title="Clear all annotations"
        aria-label="Clear all annotations"
      >
        <Trash2 size={13} />
      </button>

      <button
        onClick={() => setShowLegend((s) => !s)}
        className={`p-1.5 rounded transition-colors ${showLegend ? "btn-3d text-white" : "text-app-muted hover:bg-app-surface"}`}
        title="Color legend — map colors to UI element types so the assistant knows what each drawn shape means"
        aria-label="Edit color legend"
        aria-expanded={showLegend}
      >
        <Palette size={13} />
      </button>

      {showLegend && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-70 bg-app-base border border-app-border rounded-lg p-3 shadow-xl">
          <div className="text-xs text-app-main font-semibold mb-1">Color legend</div>
          <div className="text-[10px] text-app-muted mb-2">
            Tell the assistant what each color means — e.g. red = Knob. Shapes you
            draw in that color become placement instructions.
          </div>
          {legend.map((entry, i) => (
            <div key={`${entry.color}-${i}`} className="flex items-center gap-2 mb-1.5">
              <input
                type="color"
                id={`legend-color-${i}`}
                name={`legend-color-${i}`}
                value={entry.color}
                onChange={(e) =>
                  setLegend(legend.map((l, j) => (j === i ? { ...l, color: e.target.value } : l)))
                }
                className="w-6 h-6 rounded cursor-pointer bg-transparent border-none p-0 shrink-0"
                aria-label={`Legend entry ${i + 1} color`}
              />
              <select
                id={`legend-meaning-${i}`}
                name={`legend-meaning-${i}`}
                value={LEGEND_TYPE_OPTIONS.includes(entry.meaning as ElementType) ? entry.meaning : "Other"}
                onChange={(e) =>
                  setLegend(legend.map((l, j) => (j === i ? { ...l, meaning: e.target.value } : l)))
                }
                className="bg-app-surface border border-app-border rounded px-1.5 py-0.5 text-xs text-app-main grow"
                aria-label={`Legend entry ${i + 1} element type`}
              >
                {LEGEND_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              {entry.meaning === "Other" || !LEGEND_TYPE_OPTIONS.includes(entry.meaning as ElementType) ? (
                <input
                  type="text"
                  id={`legend-custom-${i}`}
                  name={`legend-custom-${i}`}
                  value={LEGEND_TYPE_OPTIONS.includes(entry.meaning as ElementType) ? "" : entry.meaning}
                  placeholder="meaning…"
                  onChange={(e) =>
                    setLegend(legend.map((l, j) => (j === i ? { ...l, meaning: e.target.value } : l)))
                  }
                  className="bg-app-surface border border-app-border rounded px-1.5 py-0.5 text-xs text-app-main w-20"
                  aria-label={`Legend entry ${i + 1} custom meaning`}
                />
              ) : null}
              <button
                onClick={() => setLegend(legend.filter((_, j) => j !== i))}
                className="text-app-muted hover:text-red-400 shrink-0"
                title="Remove legend entry"
                aria-label={`Remove legend entry ${i + 1}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button
            onClick={() => setLegend([...legend, { color, meaning: "Knob" }])}
            className="mt-1 px-2 py-1 text-xs rounded bg-app-surface hover:bg-app-surface-hover text-app-main w-full"
          >
            + Add color meaning
          </button>
        </div>
      )}
    </div>
  );
}
