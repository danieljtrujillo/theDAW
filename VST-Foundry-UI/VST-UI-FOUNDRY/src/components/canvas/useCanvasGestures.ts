import React, { useState, useEffect, useRef } from "react";
import { CanvasState, CanvasTool, UIElement, ElementType } from "../../types";
import { computeResizeRotated, ResizeHandle } from "./resizeMath";
import { computeDragSnap, SNAP_THRESHOLD } from "./snapMath";

/** Screen-px dead zone before a mousedown becomes a move, so a plain click
 *  (with a pixel of jitter) never yanks the element onto the grid. */
const DRAG_ACTIVATION_PX = 3;

export interface UseCanvasGesturesParams {
  canvasState: CanvasState;
  elements: UIElement[];
  selectedElementIds: string[];
  activeTool: CanvasTool;
  onUpdateCanvas: (updates: Partial<CanvasState>) => void;
  onSelectElements: (ids: string[], multi: boolean) => void;
  onUpdateElements: (
    ids: string[],
    updates: Partial<UIElement> | ((el: UIElement) => Partial<UIElement>),
  ) => void;
  onDrop: (
    type: ElementType,
    x: number,
    y: number,
    defaultWidth: number,
    defaultHeight: number,
    assetId?: string,
    variant?: string,
    customCode?: string,
    presetData?: any,
  ) => void;
}

/**
 * Canvas pointer-gesture engine extracted from Canvas.tsx: drag / marquee /
 * pan plus the drop-target handlers. Owns `canvasRef` so it can be attached to
 * the scalable canvas div by the caller.
 *
 * The live-state pattern is preserved verbatim: props/state are mirrored into
 * refs during render, and the single window `mousemove`/`mouseup` effect reads
 * exclusively from those refs so its dependency array can stay reduced to
 * `[isMarqueeActive, isDragActive, isPanningActive]` (avoiding listener churn
 * on every drag frame). The marquee selection is diffed via
 * `marqueeSelectionRef` before calling `onSelectElements`.
 */
export function useCanvasGestures({
  canvasState,
  elements,
  selectedElementIds,
  activeTool,
  onUpdateCanvas,
  onSelectElements,
  onUpdateElements,
  onDrop,
}: UseCanvasGesturesParams) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  // Dragging state. `active` flips once the pointer leaves the
  // DRAG_ACTIVATION_PX dead zone; until then no element geometry is touched.
  const [dragState, setDragState] = useState<{
    isDragging: boolean;
    active: boolean;
    startPos: { x: number; y: number };
    initialElements: UIElement[];
    guides: { type: "x" | "y"; pos: number }[];
  } | null>(null);

  // Marquee state
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // Panning state
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Resizing state (single-selection on-canvas handles). Follows the same
  // live-state pattern as drag: the initial element geometry is snapshotted on
  // mousedown and read back from a ref inside the window listener.
  const [resizeState, setResizeState] = useState<{
    isResizing: boolean;
    handle: ResizeHandle;
    startPos: { x: number; y: number };
    initialElement: UIElement;
  } | null>(null);

  const marqueeSelectionRef = useRef<string[] | null>(null);
  const canvasStateRef = useRef(canvasState);
  const elementsRef = useRef(elements);
  const selectedElementIdsRef = useRef(selectedElementIds);
  const marqueeRef = useRef(marquee);
  const dragStateRef = useRef(dragState);
  const resizeStateRef = useRef(resizeState);
  const isPanningRef = useRef(isPanning);
  const panStartRef = useRef(panStart);
  const onUpdateCanvasRef = useRef(onUpdateCanvas);
  const onSelectElementsRef = useRef(onSelectElements);
  const onUpdateElementsRef = useRef(onUpdateElements);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);

    if (!canvasRef.current) return;

    const type = e.dataTransfer.getData("elementType") as ElementType;
    const variant = e.dataTransfer.getData("variant") || undefined;
    const customCode = e.dataTransfer.getData("customCode") || undefined;
    const assetId = e.dataTransfer.getData("assetId") || undefined;
    const presetDataStr = e.dataTransfer.getData("presetData");
    let presetData: any = undefined;
    if (presetDataStr) {
      try {
        presetData = JSON.parse(presetDataStr);
      } catch (err) {
        console.warn("Failed to parse preset drop payload", err);
      }
    }
    const defaultWidth = parseInt(
      e.dataTransfer.getData("defaultWidth") || "100",
      10,
    );
    const defaultHeight = parseInt(
      e.dataTransfer.getData("defaultHeight") || "100",
      10,
    );
    const currentGridSize = canvasState.gridSize || 10;

    if (type) {
      const rect = canvasRef.current.getBoundingClientRect();
      const scale = canvasState.scale || 1;

      let x = (e.clientX - rect.left) / scale - defaultWidth / 2;
      let y = (e.clientY - rect.top) / scale - defaultHeight / 2;

      if (canvasState.snapToGrid !== false) {
        x = Math.round(x / currentGridSize) * currentGridSize;
        y = Math.round(y / currentGridSize) * currentGridSize;
      }

      onDrop(
        type,
        Math.max(0, x),
        Math.max(0, y),
        defaultWidth,
        defaultHeight,
        assetId,
        variant,
        customCode,
        presetData,
      );
    }
  };

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    // Drop any resize gesture orphaned by a missed mouseup before starting a new one.
    setResizeState(null);
    if (!canvasRef.current) return;

    // Space bar + click or pan tool
    if (
      activeTool === "pan" ||
      e.button === 1 ||
      (e.shiftKey && e.button === 0)
    ) {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
      e.preventDefault();
      return;
    }

    // Annotate mode: the AnnotationLayer owns left-button gestures (it cancels
    // its pointerdowns, but this guards any path that still reaches the root).
    if (activeTool === "annotate") return;

    if (canvasState.isPreviewMode) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const scale = canvasState.scale || 1;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    if (!e.shiftKey) {
      onSelectElements([], false);
    }

    marqueeSelectionRef.current = null;
    setMarquee({ startX: x, startY: y, currentX: x, currentY: y });
  };

  const handleElementMouseDown = (e: React.MouseEvent, id: string) => {
    // Drop any resize gesture orphaned by a missed mouseup before starting a new one.
    setResizeState(null);
    if (canvasState.isPreviewMode) return;

    if (
      activeTool === "pan" ||
      e.button === 1 ||
      (e.shiftKey && e.button === 0)
    ) {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
      e.preventDefault();
      return;
    }

    e.stopPropagation();

    let currentSelectedIds = [...selectedElementIds];

    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      onSelectElements([id], true);
      if (currentSelectedIds.includes(id)) {
        currentSelectedIds = currentSelectedIds.filter((i) => i !== id);
      } else {
        currentSelectedIds.push(id);
      }
    } else {
      if (!currentSelectedIds.includes(id)) {
        onSelectElements([id], false);
        currentSelectedIds = [id];
      }
    }

    const selectedElements = elements.filter((el) =>
      currentSelectedIds.includes(el.id),
    );

    // Skip drag if all selected elements are locked
    if (selectedElements.every((el) => el.isLocked)) {
      return;
    }

    setDragState({
      isDragging: true,
      active: false,
      startPos: { x: e.clientX, y: e.clientY },
      initialElements: selectedElements.map((el) => ({ ...el })),
      guides: [],
    });
  };

  // Mousedown on one of the eight selection handles. stopPropagation keeps it
  // from turning into a move-drag (element handler) or a marquee (canvas
  // handler). Shift is the aspect-ratio modifier here (read live during the
  // gesture), so — unlike the canvas/element handlers — we do NOT treat
  // shift+left as a pan. Middle/right buttons bubble through untouched.
  const handleResizeHandleMouseDown = (
    e: React.MouseEvent,
    id: string,
    handle: ResizeHandle,
  ) => {
    // Drop any resize gesture orphaned by a missed mouseup before starting a new one.
    setResizeState(null);
    if (canvasState.isPreviewMode) return;
    if (e.button !== 0) return;

    const el = elements.find((item) => item.id === id);
    if (!el || el.isLocked) return;

    e.stopPropagation();
    e.preventDefault();

    setResizeState({
      isResizing: true,
      handle,
      startPos: { x: e.clientX, y: e.clientY },
      initialElement: { ...el },
    });
  };

  canvasStateRef.current = canvasState;
  elementsRef.current = elements;
  selectedElementIdsRef.current = selectedElementIds;
  marqueeRef.current = marquee;
  dragStateRef.current = dragState;
  resizeStateRef.current = resizeState;
  isPanningRef.current = isPanning;
  panStartRef.current = panStart;
  onUpdateCanvasRef.current = onUpdateCanvas;
  onSelectElementsRef.current = onSelectElements;
  onUpdateElementsRef.current = onUpdateElements;

  const isPanningActive = isPanning;
  const isMarqueeActive = !!marquee;
  const isDragActive = !!dragState?.isDragging;
  const isResizeActive = !!resizeState?.isResizing;

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const isPanningNow = isPanningRef.current;
      const marquee = marqueeRef.current;
      const dragState = dragStateRef.current;
      const resizeState = resizeStateRef.current;
      const canvasState = canvasStateRef.current;
      const elements = elementsRef.current;
      const selectedElementIds = selectedElementIdsRef.current;
      const panStart = panStartRef.current;
      const onUpdateCanvas = onUpdateCanvasRef.current;
      const onSelectElements = onSelectElementsRef.current;
      const onUpdateElements = onUpdateElementsRef.current;

      if (isPanningNow) {
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;
        onUpdateCanvas({
          panX: (canvasState.panX || 0) + dx,
          panY: (canvasState.panY || 0) + dy,
        });
        setPanStart({ x: e.clientX, y: e.clientY });
        return;
      }

      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      const scale = canvasState.scale || 1;

      if (marquee) {
        setMarquee((prev) =>
          prev
            ? {
                ...prev,
                currentX: (e.clientX - rect.left) / scale,
                currentY: (e.clientY - rect.top) / scale,
              }
            : null,
        );

        const startX = Math.min(
          marquee.startX,
          (e.clientX - rect.left) / scale,
        );
        const startY = Math.min(marquee.startY, (e.clientY - rect.top) / scale);
        const endX = Math.max(marquee.startX, (e.clientX - rect.left) / scale);
        const endY = Math.max(marquee.startY, (e.clientY - rect.top) / scale);

        const intersectingIds = elements
          .filter((el) => {
            return (
              !el.groupId &&
              el.x < endX &&
              el.x + el.width > startX &&
              el.y < endY &&
              el.y + el.height > startY
            );
          })
          .map((el) => el.id);

        const prevIds = marqueeSelectionRef.current;
        const changed =
          prevIds === null ||
          prevIds.length !== intersectingIds.length ||
          intersectingIds.some((id, i) => id !== prevIds[i]);
        if (changed) {
          marqueeSelectionRef.current = intersectingIds;
          onSelectElements(intersectingIds, false);
        }
      }

      if (dragState && dragState.isDragging) {
        // Dead zone: ignore sub-threshold jitter (screen px) so a click never
        // moves the element. Once crossed, the gesture stays active.
        if (!dragState.active) {
          const dist = Math.hypot(
            e.clientX - dragState.startPos.x,
            e.clientY - dragState.startPos.y,
          );
          if (dist < DRAG_ACTIVATION_PX) return;
          setDragState((prev) => (prev ? { ...prev, active: true } : null));
        }

        const dx = (e.clientX - dragState.startPos.x) / scale;
        const dy = (e.clientY - dragState.startPos.y) / scale;

        // The first unlocked element drives grid/alignment snapping; the
        // snapped DELTA is then applied to the whole selection so relative
        // offsets survive multi-drags instead of every element re-rounding
        // onto the grid independently.
        const primaryEl =
          dragState.initialElements.find((el) => !el.isLocked) ||
          dragState.initialElements[0];

        const { dx: snapDx, dy: snapDy, guides: guidesToDraw } =
          computeDragSnap({
            dx,
            dy,
            primary: primaryEl ?? null,
            // Alignment candidates: everything outside the selection, minus
            // the dragged element's own children.
            others: elements.filter(
              (el) =>
                !selectedElementIds.includes(el.id) &&
                el.groupId !== primaryEl?.id,
            ),
            snapToGrid: canvasState.snapToGrid !== false,
            gridSize: canvasState.gridSize || 10,
            // Constant-feel magnetism: threshold is defined in screen px.
            alignThreshold: SNAP_THRESHOLD / scale,
            smartAlign: dragState.initialElements.length === 1,
          });

        const updates: Record<string, Partial<UIElement>> = {};
        dragState.initialElements.forEach((el) => {
          if (el.isLocked) return;
          updates[el.id] = { x: el.x + snapDx, y: el.y + snapDy };
        });

        onUpdateElements(Object.keys(updates), (el) => updates[el.id]);
        setDragState((prev) =>
          prev ? { ...prev, guides: guidesToDraw } : null,
        );
      }

      if (resizeState && resizeState.isResizing) {
        const el = resizeState.initialElement;
        const dx = (e.clientX - resizeState.startPos.x) / scale;
        const dy = (e.clientY - resizeState.startPos.y) / scale;

        // Group v1: resize the frame only. computeResizeRotated returns just this
        // element's bounds and we commit only its id, so children are left
        // untouched in data — consistent with move-drag, which also mutates
        // only the dragged element's own geometry. For rotated elements the
        // wrapper counter-rotates the pointer delta into the element's local
        // frame and resizes about center (transform-origin); zero-rotation
        // elements take the identical axis-aligned anchor path.
        const next = computeResizeRotated({
          handle: resizeState.handle,
          initial: {
            x: el.x,
            y: el.y,
            width: el.width,
            height: el.height,
          },
          dx,
          dy,
          snapToGrid: canvasState.snapToGrid !== false,
          gridSize: canvasState.gridSize || 10,
          preserveAspect: e.shiftKey,
          lockSquare: el.type === "Knob" || el.type === "Spatial3D",
          rotation: el.rotation,
        });

        onUpdateElements([el.id], {
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height,
        });
        // Stale-state guard: resize is exclusive — return so it can never
        // co-fire with the marquee/drag branches in the same frame.
        return;
      }
    };

    const handleMouseUp = () => {
      setMarquee(null);
      setDragState(null);
      setResizeState(null);
      setIsPanning(false);
      marqueeSelectionRef.current = null;
    };

    // A mouseup that lands outside the browser window is never delivered, so the
    // gesture state (esp. resizeState) would otherwise persist and co-fire with
    // the next gesture. Clearing on window blur cancels the orphaned gesture.
    const handleBlur = () => {
      setMarquee(null);
      setDragState(null);
      setResizeState(null);
      setIsPanning(false);
      marqueeSelectionRef.current = null;
    };

    if (isMarqueeActive || isDragActive || isPanningActive || isResizeActive) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("blur", handleBlur);
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [isMarqueeActive, isDragActive, isPanningActive, isResizeActive]);

  return {
    canvasRef,
    dragState,
    marquee,
    isPanning,
    resizeState,
    isDraggingOver,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleCanvasMouseDown,
    handleElementMouseDown,
    handleResizeHandleMouseDown,
  };
}
