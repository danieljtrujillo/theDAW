import type { PointerEvent } from "react";
import type { ExtractedElement } from "../../lib/extractor/types";

interface Point { x: number; y: number }

export interface CanvasSelectionProps {
  selectMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onSelectElement?: (id: string, additive: boolean) => void;
  onMarqueeSelect?: (ids: string[], additive: boolean) => void;
}

export function completeMarquee(
  start: Point, end: Point, size: { width: number; height: number },
  elements: ExtractedElement[], additive: boolean,
  onSelect: CanvasSelectionProps["onMarqueeSelect"],
) {
  if (size.width <= 0 || size.height <= 0) return;
  const xmin = Math.min(start.x, end.x);
  const xmax = Math.max(start.x, end.x);
  const ymin = Math.min(start.y, end.y);
  const ymax = Math.max(start.y, end.y);
  if (xmax - xmin > 4 && ymax - ymin > 4) {
    onSelect?.(elements.filter((element) =>
      element.xmin < xmax / size.width && element.xmax > xmin / size.width &&
      element.ymin < ymax / size.height && element.ymax > ymin / size.height,
    ).map((element) => element.id), additive);
  } else if (!additive) onSelect?.([], false);
}

export function selectCapture(event: PointerEvent<HTMLDivElement>, element: ExtractedElement, onSelect: CanvasSelectionProps["onSelectElement"]) {
  event.stopPropagation();
  if (element.status === "processing" || (event.target instanceof Element && event.target.closest("button"))) return;
  onSelect?.(element.id, event.shiftKey || event.ctrlKey || event.metaKey);
}
