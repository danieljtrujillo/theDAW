import React, { useRef, useState } from "react";
import { Annotation, CanvasState } from "../../types";

// Sub-tools available while the main toolbar is in "annotate" mode.
export type AnnotationSubTool = "pen" | "rect" | "ellipse" | "text" | "eraser" | "move";

export const ANNOTATION_PALETTE = [
  "#ff3b30", // red
  "#ff9500", // orange
  "#ffd60a", // yellow
  "#34c759", // green
  "#00c7be", // teal
  "#0a84ff", // blue
  "#bf5af2", // purple
  "#ff2d92", // pink
  "#ffffff", // white
];

const ERASER_RADIUS = 12; // canvas px

interface AnnotationLayerProps {
  canvasState: CanvasState;
  active: boolean; // annotate mode on (layer interactive)
  subTool: AnnotationSubTool;
  color: string;
  strokeWidth: number;
  onUpdateCanvas: (updates: Partial<CanvasState>) => void;
}

interface DraftShape {
  kind: "rect" | "ellipse";
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface MoveState {
  id: string;
  mode: "move" | "resize";
  handle?: "nw" | "ne" | "sw" | "se";
  lastX: number;
  lastY: number;
}

const newId = () => Math.random().toString(36).substring(2, 10);

function strokeBounds(points: { x: number; y: number }[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Loop-based (never spread) so arbitrarily long freehand strokes can't blow
// the JS argument limit. Shared with the orb's getAnnotations tool.
export function annotationBounds(a: Annotation) {
  if (a.kind === "stroke" && a.points?.length) return strokeBounds(a.points);
  if (a.kind === "text") {
    const fs = a.fontSize ?? 14;
    const lines = (a.text || "").split("\n");
    let longest = 1;
    for (const l of lines) if (l.length > longest) longest = l.length;
    // monospace-ish estimate; good enough for hit-testing and AI bounds
    return { x: a.x ?? 0, y: a.y ?? 0, width: longest * fs * 0.6, height: lines.length * fs * 1.3 };
  }
  return { x: a.x ?? 0, y: a.y ?? 0, width: a.width ?? 0, height: a.height ?? 0 };
}

// Erasing removes stroke points within the eraser radius; a stroke whose
// middle was erased splits into the surviving contiguous runs.
function eraseFromStroke(a: Annotation, cx: number, cy: number): Annotation[] {
  const pts = a.points || [];
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  for (const p of pts) {
    const gone = (p.x - cx) ** 2 + (p.y - cy) ** 2 <= ERASER_RADIUS ** 2;
    if (gone) {
      if (run.length > 1) runs.push(run);
      run = [];
    } else {
      run.push(p);
    }
  }
  if (run.length > 1) runs.push(run);
  if (runs.length === 1 && runs[0].length === pts.length) return [a]; // untouched
  return runs.map((r) => ({ ...a, id: newId(), points: r }));
}

// Pure: apply one eraser dab to a list. Returns the same array reference when
// nothing was touched so callers can cheaply detect "no change".
function eraseFromList(list: Annotation[], x: number, y: number): Annotation[] {
  let changed = false;
  const next: Annotation[] = [];
  for (const a of list) {
    if (a.kind === "stroke") {
      const parts = eraseFromStroke(a, x, y);
      if (parts.length !== 1 || parts[0] !== a) changed = true;
      next.push(...parts);
    } else {
      // Shapes/notes erase whole when the eraser touches their bounding box.
      const b = annotationBounds(a);
      const hit =
        x >= b.x - ERASER_RADIUS && x <= b.x + b.width + ERASER_RADIUS &&
        y >= b.y - ERASER_RADIUS && y <= b.y + b.height + ERASER_RADIUS;
      if (hit) changed = true;
      else next.push(a);
    }
  }
  return changed ? next : list;
}

export default function AnnotationLayer({
  canvasState,
  active,
  subTool,
  color,
  strokeWidth,
  onUpdateCanvas,
}: AnnotationLayerProps) {
  const annotations = canvasState.annotations || [];
  const visible = canvasState.showAnnotations !== false;

  // In-progress gestures stay LOCAL so pointermove never round-trips app
  // state (canvasState commit → full Canvas re-render + autosave churn).
  // Every gesture commits exactly once, on pointer-up:
  //   pen    → draftPoints        shapes → draftShape
  //   move/resize → draftEdit     eraser → eraseDraft
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[] | null>(null);
  const [draftShape, setDraftShape] = useState<DraftShape | null>(null);
  const [draftEdit, setDraftEdit] = useState<Annotation | null>(null);
  const [eraseDraft, setEraseDraft] = useState<Annotation[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Text note being typed: position in canvas coords + live value.
  const [editingText, setEditingText] = useState<{ id: string | null; x: number; y: number; value: string } | null>(null);
  const moveRef = useRef<MoveState | null>(null);
  const erasingRef = useRef(false);
  // Guards the Enter→blur double-fire on the text editor: first commit wins.
  const textCommittedRef = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!visible && !active) return null;

  // The list currently shown: an active erase gesture previews its local
  // draft; otherwise the committed annotations.
  const displayList = eraseDraft ?? annotations;

  const toCanvas = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const scale = canvasState.scale || 1;
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };

  const commit = (list: Annotation[]) => onUpdateCanvas({ annotations: list });

  // Capture on the SVG itself, never on a child that the gesture might
  // unmount (an erased shape) — the svg handlers then see every move/up.
  const capturePointer = (e: React.PointerEvent) => {
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (!active || e.button !== 0) return;
    e.stopPropagation();
    // Canceling pointerdown is what suppresses the compatibility mousedown —
    // without it the canvas marquee/selection would start under the drawing.
    // It also suppresses default focusing, so focus explicitly (Delete key).
    e.preventDefault();
    svgRef.current?.focus();
    capturePointer(e);
    const { x, y } = toCanvas(e);

    if (editingText) {
      commitTextEdit();
      return;
    }

    if (subTool === "pen") {
      setDraftPoints([{ x, y }]);
    } else if (subTool === "rect" || subTool === "ellipse") {
      setDraftShape({ kind: subTool, startX: x, startY: y, currentX: x, currentY: y });
    } else if (subTool === "text") {
      textCommittedRef.current = false;
      setEditingText({ id: null, x, y, value: "" });
    } else if (subTool === "eraser") {
      erasingRef.current = true;
      setEraseDraft(eraseFromList(annotations, x, y));
    } else if (subTool === "move") {
      setSelectedId(null); // empty-space click clears selection
    }
  };

  // Commit (or discard, when empty) the in-progress text note. Idempotent —
  // Enter commits and the resulting unmount fires blur, which must not
  // commit a second time.
  const commitTextEdit = () => {
    if (!editingText || textCommittedRef.current) return;
    textCommittedRef.current = true;
    const value = editingText.value.trim();
    if (editingText.id) {
      commit(
        value
          ? annotations.map((a) => (a.id === editingText.id ? { ...a, text: value } : a))
          : annotations.filter((a) => a.id !== editingText.id),
      );
    } else if (value) {
      commit([
        ...annotations,
        {
          id: newId(),
          kind: "text",
          color,
          strokeWidth,
          x: editingText.x,
          y: editingText.y,
          text: value,
          fontSize: Math.max(12, strokeWidth * 5),
        },
      ]);
    }
    setEditingText(null);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!active) return;
    const { x, y } = toCanvas(e);

    if (draftPoints) {
      setDraftPoints((pts) => (pts ? [...pts, { x, y }] : pts));
    } else if (draftShape) {
      setDraftShape((s) => (s ? { ...s, currentX: x, currentY: y } : s));
    } else if (erasingRef.current) {
      setEraseDraft((list) => eraseFromList(list ?? annotations, x, y));
    } else if (moveRef.current && draftEdit) {
      const mv = moveRef.current;
      const dx = x - mv.lastX;
      const dy = y - mv.lastY;
      mv.lastX = x;
      mv.lastY = y;
      setDraftEdit((a) => {
        if (!a) return a;
        if (mv.mode === "move") {
          if (a.kind === "stroke") {
            return { ...a, points: (a.points || []).map((p) => ({ x: p.x + dx, y: p.y + dy })) };
          }
          return { ...a, x: (a.x ?? 0) + dx, y: (a.y ?? 0) + dy };
        }
        // resize (shapes only) — drag a corner, clamp to 8px minimum
        let { x: ax = 0, y: ay = 0, width: aw = 0, height: ah = 0 } = a;
        const h = mv.handle!;
        if (h.includes("w")) { ax += dx; aw -= dx; }
        if (h.includes("e")) { aw += dx; }
        if (h.includes("n")) { ay += dy; ah -= dy; }
        if (h.includes("s")) { ah += dy; }
        if (aw < 8) { aw = 8; }
        if (ah < 8) { ah = 8; }
        return { ...a, x: ax, y: ay, width: aw, height: ah };
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!active) return;
    e.stopPropagation();
    if (draftPoints) {
      if (draftPoints.length > 1) {
        commit([...annotations, { id: newId(), kind: "stroke", color, strokeWidth, points: draftPoints }]);
      }
      setDraftPoints(null);
    }
    if (draftShape) {
      const x = Math.min(draftShape.startX, draftShape.currentX);
      const y = Math.min(draftShape.startY, draftShape.currentY);
      const w = Math.abs(draftShape.currentX - draftShape.startX);
      const h = Math.abs(draftShape.currentY - draftShape.startY);
      if (w >= 4 && h >= 4) {
        commit([...annotations, { id: newId(), kind: draftShape.kind, color, strokeWidth, x, y, width: w, height: h }]);
      }
      setDraftShape(null);
    }
    if (erasingRef.current) {
      if (eraseDraft && eraseDraft !== annotations) commit(eraseDraft);
      setEraseDraft(null);
      erasingRef.current = false;
    }
    if (moveRef.current && draftEdit) {
      commit(annotations.map((a) => (a.id === draftEdit.id ? draftEdit : a)));
      setDraftEdit(null);
    }
    moveRef.current = null;
  };

  // A pointerup that's never delivered (alt-tab / focus steal / lost capture
  // mid-gesture) would strand moveRef/erasingRef and freeze a half-drawn draft.
  // Mirrors useCanvasGestures' window-blur cancel: drop the in-flight gesture
  // WITHOUT committing — a half-gesture must not commit. (lostpointercapture
  // also fires right after a normal pointerup, by which point the commit path
  // has already cleared these, so this is an idempotent no-op there.)
  const cancelGesture = () => {
    moveRef.current = null;
    erasingRef.current = false;
    setDraftEdit(null);
    setEraseDraft(null);
    setDraftPoints(null);
    setDraftShape(null);
  };

  const beginMove = (e: React.PointerEvent, a: Annotation) => {
    if (!active || subTool !== "move" || e.button !== 0) return;
    e.stopPropagation();
    svgRef.current?.focus(); // so Delete/Backspace works right after selecting
    capturePointer(e);
    const { x, y } = toCanvas(e);
    setSelectedId(a.id);
    setDraftEdit({ ...a });
    moveRef.current = { id: a.id, mode: "move", lastX: x, lastY: y };
  };

  const beginResize = (e: React.PointerEvent, a: Annotation, handle: MoveState["handle"]) => {
    if (!active || e.button !== 0) return;
    e.stopPropagation();
    svgRef.current?.focus();
    capturePointer(e);
    const { x, y } = toCanvas(e);
    setDraftEdit({ ...a });
    moveRef.current = { id: a.id, mode: "resize", handle, lastX: x, lastY: y };
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    commit(annotations.filter((a) => a.id !== selectedId));
    setSelectedId(null);
    setDraftEdit(null);
    moveRef.current = null;
  };

  const renderAnnotation = (a: Annotation) => {
    const moveCursor = active && subTool === "move" ? "move" : undefined;
    if (a.kind === "stroke") {
      // Strokes hit-test on the painted line only (a transparent fill would
      // close the path into a bogus interior hit region).
      const d = (a.points || []).map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
      return (
        <path
          key={a.id}
          d={d}
          stroke={a.color}
          strokeWidth={a.strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            cursor: moveCursor,
            pointerEvents: (active && subTool === "move"
              ? "stroke"
              : "none") as React.CSSProperties["pointerEvents"],
          }}
          onPointerDown={(e) => beginMove(e, a)}
        />
      );
    }
    if (a.kind === "text") {
      const fs = a.fontSize ?? 14;
      const lines = (a.text || "").split("\n");
      const ax = a.x ?? 0;
      return (
        <text
          key={a.id}
          x={ax}
          y={(a.y ?? 0) + fs}
          fill={a.color}
          fontSize={fs}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          style={{
            cursor: moveCursor,
            pointerEvents: (active && subTool === "move"
              ? "all"
              : "none") as React.CSSProperties["pointerEvents"],
            userSelect: "none",
          }}
          onPointerDown={(e) => beginMove(e, a)}
          onDoubleClick={() => {
            if (active && subTool === "move") {
              textCommittedRef.current = false;
              setEditingText({ id: a.id, x: ax, y: a.y ?? 0, value: a.text || "" });
            }
          }}
        >
          {lines.map((l, i) => (
            <tspan key={i} x={ax} dy={i === 0 ? 0 : fs * 1.3}>{l}</tspan>
          ))}
        </text>
      );
    }
    // rect / ellipse: transparent fill so the INTERIOR is grabbable in move
    // mode (matches the eraser's whole-box hit test), visually identical to
    // fill:none.
    const { x = 0, y = 0, width = 0, height = 0 } = a;
    const shapeStyle: React.CSSProperties = {
      cursor: moveCursor,
      pointerEvents: (active && subTool === "move"
        ? "all"
        : "none") as React.CSSProperties["pointerEvents"],
    };
    if (a.kind === "rect") {
      return (
        <rect
          key={a.id}
          x={x}
          y={y}
          width={width}
          height={height}
          rx={2}
          stroke={a.color}
          strokeWidth={a.strokeWidth}
          fill="transparent"
          style={shapeStyle}
          onPointerDown={(e) => beginMove(e, a)}
        />
      );
    }
    return (
      <ellipse
        key={a.id}
        cx={x + width / 2}
        cy={y + height / 2}
        rx={width / 2}
        ry={height / 2}
        stroke={a.color}
        strokeWidth={a.strokeWidth}
        fill="transparent"
        style={shapeStyle}
        onPointerDown={(e) => beginMove(e, a)}
      />
    );
  };

  const storedSelected = displayList.find((a) => a.id === selectedId);
  // During a move/resize the local draft is the live geometry.
  const selected = draftEdit && draftEdit.id === selectedId ? draftEdit : storedSelected;
  const selectedBox = selected ? annotationBounds(selected) : null;

  return (
    <svg
      ref={svgRef}
      data-annotation-layer
      width={canvasState.width}
      height={canvasState.height}
      viewBox={`0 0 ${canvasState.width} ${canvasState.height}`}
      className="absolute left-0 top-0 z-40 overflow-visible"
      style={{ pointerEvents: active ? "auto" : "none", touchAction: "none" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelGesture}
      onLostPointerCapture={cancelGesture}
      onKeyDown={(e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
          // Contain the event: the app-wide shortcut handler deletes selected
          // CANVAS ELEMENTS on the same keys.
          e.stopPropagation();
          e.preventDefault();
          deleteSelected();
        }
      }}
      tabIndex={active ? 0 : -1}
      aria-label="Canvas annotations"
    >
      {/* Eye toggle hides committed annotations, but in-progress drafts below
          stay visible so active drawing still previews while hidden. */}
      {visible &&
        displayList.map((a) =>
          renderAnnotation(draftEdit && a.id === draftEdit.id ? draftEdit : a),
        )}

      {/* live freehand preview */}
      {draftPoints && (
        <path
          d={draftPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
        />
      )}

      {/* live shape preview */}
      {draftShape && (() => {
        const x = Math.min(draftShape.startX, draftShape.currentX);
        const y = Math.min(draftShape.startY, draftShape.currentY);
        const w = Math.abs(draftShape.currentX - draftShape.startX);
        const h = Math.abs(draftShape.currentY - draftShape.startY);
        return draftShape.kind === "rect" ? (
          <rect x={x} y={y} width={w} height={h} rx={2} stroke={color} strokeWidth={strokeWidth} fill="none" strokeDasharray="6 4" pointerEvents="none" />
        ) : (
          <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} stroke={color} strokeWidth={strokeWidth} fill="none" strokeDasharray="6 4" pointerEvents="none" />
        );
      })()}

      {/* inline text-note editor */}
      {editingText && (
        <foreignObject
          x={editingText.x}
          y={editingText.y}
          width={Math.max(220, canvasState.width - editingText.x - 8)}
          height={120}
          style={{ overflow: "visible" }}
        >
          <textarea
            id="annotation-text-editor"
            name="annotation-text-editor"
            aria-label="Annotation text note"
            autoFocus
            value={editingText.value}
            placeholder="note… (Enter to save, Esc to cancel)"
            onChange={(e) => setEditingText((t) => (t ? { ...t, value: e.target.value } : t))}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitTextEdit();
              } else if (e.key === "Escape") {
                setEditingText(null);
              }
            }}
            onBlur={commitTextEdit}
            style={{
              width: 210,
              minHeight: 40,
              background: "rgba(10,10,14,0.92)",
              color,
              border: `1px dashed ${color}`,
              borderRadius: 4,
              padding: "4px 6px",
              fontSize: Math.max(12, strokeWidth * 5),
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
              outline: "none",
              resize: "both",
            }}
          />
        </foreignObject>
      )}

      {/* selection box + resize handles (move sub-tool) */}
      {visible && active && subTool === "move" && selected && selectedBox && (
        <g>
          <rect
            x={selectedBox.x - 4}
            y={selectedBox.y - 4}
            width={selectedBox.width + 8}
            height={selectedBox.height + 8}
            fill="none"
            stroke="#0a84ff"
            strokeWidth={1}
            strokeDasharray="4 3"
            pointerEvents="none"
          />
          {selected.kind !== "stroke" &&
            (["nw", "ne", "sw", "se"] as const).map((h) => {
              const hx = h.includes("w") ? selectedBox.x : selectedBox.x + selectedBox.width;
              const hy = h.includes("n") ? selectedBox.y : selectedBox.y + selectedBox.height;
              return (
                <rect
                  key={h}
                  x={hx - 5}
                  y={hy - 5}
                  width={10}
                  height={10}
                  fill="#0a84ff"
                  stroke="#fff"
                  strokeWidth={1}
                  style={{ cursor: `${h}-resize`, pointerEvents: "all" }}
                  onPointerDown={(e) => beginResize(e, selected, h)}
                />
              );
            })}
          {/* delete button above the selection */}
          <g
            style={{ cursor: "pointer", pointerEvents: "all" }}
            onPointerDown={(e) => {
              e.stopPropagation();
              deleteSelected();
            }}
          >
            <circle cx={selectedBox.x + selectedBox.width + 14} cy={selectedBox.y - 14} r={9} fill="#ff3b30" />
            <path
              d={`M${selectedBox.x + selectedBox.width + 10} ${selectedBox.y - 18} l8 8 m0 -8 l-8 8`}
              stroke="#fff"
              strokeWidth={1.5}
            />
          </g>
        </g>
      )}
    </svg>
  );
}
