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

// Map bounds that are relative to a panel CROP (0..1 within the crop) back
// into source-image space (0..1 within the full image). Pass 2 of group
// extraction detects children inside each panel's crop; their bounds must be
// re-based before they can live beside pass-1 (full-image) elements.
export function panelLocalToGlobal(
  local: { xmin: number; ymin: number; xmax: number; ymax: number },
  panel: { xmin: number; ymin: number; xmax: number; ymax: number },
): { xmin: number; ymin: number; xmax: number; ymax: number } {
  const w = panel.xmax - panel.xmin;
  const h = panel.ymax - panel.ymin;
  return {
    xmin: panel.xmin + local.xmin * w,
    ymin: panel.ymin + local.ymin * h,
    xmax: panel.xmin + local.xmax * w,
    ymax: panel.ymin + local.ymax * h,
  };
}
