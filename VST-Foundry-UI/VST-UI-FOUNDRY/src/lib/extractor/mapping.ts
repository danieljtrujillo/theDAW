// Map an extracted element's normalized bounds onto Foundry canvas
// coordinates. The canvas background renders at exactly canvasState.width ×
// canvasState.height (Canvas.tsx sets those to the image's natural dims on
// upload and draws it backgroundSize:"contain"), so this is a straight scale.
export function boundsToCanvasRect(
  b: { xmin: number; ymin: number; xmax: number; ymax: number },
  canvas: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  return {
    x: b.xmin * canvas.width,
    y: b.ymin * canvas.height,
    width: Math.max(1, (b.xmax - b.xmin) * canvas.width),
    height: Math.max(1, (b.ymax - b.ymin) * canvas.height),
  };
}
