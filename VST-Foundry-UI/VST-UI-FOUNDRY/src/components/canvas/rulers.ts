import { worldToScreenX, worldToScreenY } from "./gridOverlay";

export interface DrawRulersOptions {
  topCanvas: HTMLCanvasElement | null;
  leftCanvas: HTMLCanvasElement | null;
  containerSize: { width: number; height: number };
  mousePos: { x: number; y: number } | null;
  scale: number;
  panX: number;
  panY: number;
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * Pure canvas ruler renderer extracted from Canvas.tsx. Draws the top and left
 * rulers (ticks, labels, cursor marker) onto the supplied 2D canvases. Reads
 * only its options — no React, no refs, no side effects beyond the given
 * canvases. Behavior is identical to the original inline implementation.
 */
export function drawRulers(options: DrawRulersOptions): void {
  const { topCanvas, leftCanvas, containerSize, mousePos } = options;
  if (!topCanvas || !leftCanvas || containerSize.width === 0 || containerSize.height === 0) return;

  const scale = options.scale || 1;
  const panX = options.panX || 0;
  const panY = options.panY || 0;
  const cw = options.canvasWidth || 800;
  const ch = options.canvasHeight || 600;
  const W = containerSize.width;
  const H = containerSize.height;

  const dpr = window.devicePixelRatio || 1;

  // Top Canvas Drawing
  topCanvas.width = W * dpr;
  topCanvas.height = 24 * dpr;
  topCanvas.style.width = `${W}px`;
  topCanvas.style.height = `24px`;
  const topCtx = topCanvas.getContext("2d");

  if (topCtx) {
    topCtx.scale(dpr, dpr);
    topCtx.fillStyle = "#09090b";
    topCtx.fillRect(0, 0, W, 24);

    // Bottom border
    topCtx.strokeStyle = "#27272a";
    topCtx.lineWidth = 1;
    topCtx.beginPath();
    topCtx.moveTo(0, 23.5);
    topCtx.lineTo(W, 23.5);
    topCtx.stroke();

    // Draw Ticks
    const STEP_PRESETS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let step = 100;
    for (const p of STEP_PRESETS) {
      if (p * scale >= 40) {
        step = p;
        break;
      }
    }

    const x_canvas_start = (24 - W / 2 - panX) / scale + cw / 2;
    const x_canvas_end = (W - W / 2 - panX) / scale + cw / 2;

    const subStep = step / 10;
    const start_val = Math.floor(x_canvas_start / subStep) * subStep;
    const end_val = Math.ceil(x_canvas_end / subStep) * subStep;

    topCtx.fillStyle = "#71717a";
    topCtx.font = "9px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    topCtx.textAlign = "center";
    topCtx.textBaseline = "middle";

    for (let val = start_val; val <= end_val; val += subStep) {
      const roundedVal = Math.round(val * 1000) / 1000;
      const x_px = worldToScreenX(roundedVal, W, cw, scale, panX);

      if (x_px < 24 || x_px > W) continue;

      const isMajor = Math.abs(roundedVal % step) < 0.001 || Math.abs((roundedVal % step) - step) < 0.001;
      const isMedium = Math.abs(roundedVal % (step / 2)) < 0.001 || Math.abs((roundedVal % (step / 2)) - (step / 2)) < 0.001;

      topCtx.strokeStyle = "#27272a";
      topCtx.beginPath();
      if (isMajor) {
        topCtx.moveTo(x_px, 12);
        topCtx.lineTo(x_px, 24);
        topCtx.stroke();
        topCtx.fillText(Math.round(roundedVal).toString(), x_px, 6);
      } else if (isMedium) {
        topCtx.moveTo(x_px, 16);
        topCtx.lineTo(x_px, 24);
        topCtx.stroke();
      } else {
        topCtx.moveTo(x_px, 20);
        topCtx.lineTo(x_px, 24);
        topCtx.stroke();
      }
    }

    // Draw active cursor tick
    if (mousePos && mousePos.x >= 24 && mousePos.x <= W) {
      topCtx.strokeStyle = "#a855f7";
      topCtx.lineWidth = 1.5;
      topCtx.beginPath();
      topCtx.moveTo(mousePos.x, 0);
      topCtx.lineTo(mousePos.x, 24);
      topCtx.stroke();
    }
  }

  // Left Canvas Drawing
  leftCanvas.width = 24 * dpr;
  leftCanvas.height = H * dpr;
  leftCanvas.style.width = `24px`;
  leftCanvas.style.height = `${H}px`;
  const leftCtx = leftCanvas.getContext("2d");

  if (leftCtx) {
    leftCtx.scale(dpr, dpr);
    leftCtx.fillStyle = "#09090b";
    leftCtx.fillRect(0, 0, 24, H);

    // Right border
    leftCtx.strokeStyle = "#27272a";
    leftCtx.lineWidth = 1;
    leftCtx.beginPath();
    leftCtx.moveTo(23.5, 0);
    leftCtx.lineTo(23.5, H);
    leftCtx.stroke();

    // Draw Ticks
    const STEP_PRESETS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let step = 100;
    for (const p of STEP_PRESETS) {
      if (p * scale >= 40) {
        step = p;
        break;
      }
    }

    const y_canvas_start = (24 - H / 2 - panY) / scale + ch / 2;
    const y_canvas_end = (H - H / 2 - panY) / scale + ch / 2;

    const subStep = step / 10;
    const start_val = Math.floor(y_canvas_start / subStep) * subStep;
    const end_val = Math.ceil(y_canvas_end / subStep) * subStep;

    leftCtx.fillStyle = "#71717a";
    leftCtx.font = "9px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    leftCtx.textAlign = "center";
    leftCtx.textBaseline = "middle";

    for (let val = start_val; val <= end_val; val += subStep) {
      const roundedVal = Math.round(val * 1000) / 1000;
      const y_px = worldToScreenY(roundedVal, H, ch, scale, panY);

      if (y_px < 24 || y_px > H) continue;

      const isMajor = Math.abs(roundedVal % step) < 0.001 || Math.abs((roundedVal % step) - step) < 0.001;
      const isMedium = Math.abs(roundedVal % (step / 2)) < 0.001 || Math.abs((roundedVal % (step / 2)) - (step / 2)) < 0.001;

      leftCtx.strokeStyle = "#27272a";
      leftCtx.beginPath();
      if (isMajor) {
        leftCtx.moveTo(12, y_px);
        leftCtx.lineTo(24, y_px);
        leftCtx.stroke();

        leftCtx.save();
        leftCtx.translate(6, y_px);
        leftCtx.rotate(-Math.PI / 2);
        leftCtx.fillText(Math.round(roundedVal).toString(), 0, 0);
        leftCtx.restore();
      } else if (isMedium) {
        leftCtx.moveTo(16, y_px);
        leftCtx.lineTo(24, y_px);
        leftCtx.stroke();
      } else {
        leftCtx.moveTo(20, y_px);
        leftCtx.lineTo(24, y_px);
        leftCtx.stroke();
      }
    }

    // Draw active cursor tick
    if (mousePos && mousePos.y >= 24 && mousePos.y <= H) {
      leftCtx.strokeStyle = "#a855f7";
      leftCtx.lineWidth = 1.5;
      leftCtx.beginPath();
      leftCtx.moveTo(0, mousePos.y);
      leftCtx.lineTo(24, mousePos.y);
      leftCtx.stroke();
    }
  }
}
