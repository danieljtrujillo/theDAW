import { Annotation, UIElement } from "../types";

/**
 * Draws the current state of VST Foundry canvas onto an in-memory canvas
 * and returns it as a base64 encoded PNG dataURL. When `annotations` are
 * passed (and the layer isn't hidden), the user's drawn strokes/shapes/notes
 * are composited on top so the assistant sees them in this synthetic
 * fallback exactly like in the real OS capture.
 */
export async function generateCanvasScreenshot(
  elements: UIElement[],
  canvasWidth: number,
  canvasHeight: number,
  backgroundImageUrl: string | null,
  annotations?: Annotation[]
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = canvasWidth || 800;
  canvas.height = canvasHeight || 600;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // 1. Draw Background
  if (backgroundImageUrl) {
    try {
      const img = new Image();
      img.crossOrigin = "Anonymous";
      img.src = backgroundImageUrl;
      await new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve; // Continue even if load fails
      });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } catch {
      // Fallback if image loading fails (cross-origin etc.)
      ctx.fillStyle = "#1e293b"; // Slate 800
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  } else {
    // Elegant Brushed Metal Gradiant Background
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#0f172a"); // Slate 900
    gradient.addColorStop(0.5, "#1e293b"); // Slate 800
    gradient.addColorStop(1, "#020617"); // Slate 950
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid lines for a high-tech Blueprint feel
    ctx.strokeStyle = "rgba(148, 163, 184, 0.05)"; // slate-400 with 5% opacity
    ctx.lineWidth = 1;
    const gridSize = 40;
    for (let x = 0; x < canvas.width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
  }

  // 2. Draw Elements
  elements.forEach((el) => {
    const x = el.x;
    const y = el.y;
    const w = el.width;
    const h = el.height;
    const opacity = el.opacity !== undefined ? el.opacity : 1;
    const color = el.baseColor || "#3b82f6"; // blue-500
    const activeColor = el.activeColor || "#10b981"; // emerald-500
    const min = el.min !== undefined ? el.min : 0;
    const max = el.max !== undefined ? el.max : 100;
    const value = el.value !== undefined ? el.value : (min + max) / 2;
    const frac = Math.max(
      0,
      Math.min(1, max > min ? (value - min) / (max - min) : 0)
    );

    ctx.save();
    ctx.globalAlpha = opacity;

    // Optional rotation
    if (el.rotation) {
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((el.rotation * Math.PI) / 180);
      ctx.translate(-(x + w / 2), -(y + h / 2));
    }

    // Glow effects representation
    if (el.glow) {
      ctx.shadowBlur = el.glowAmount || 15;
      ctx.shadowColor = el.glowColor || activeColor;
    }

    if (el.type === "Knob") {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const radius = Math.min(w, h) / 2.5;

      // Outer bezel ring
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 3, 0, 2 * Math.PI);
      ctx.fillStyle = "#334155"; // Slate 700
      ctx.fill();

      // Main dial face
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
      ctx.fillStyle = "#1e293b"; // Slate 800
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();

      // Indicator needle
      const startAngle = 0.75 * Math.PI;
      const endAngle = 2.25 * Math.PI;
      const currentAngle = startAngle + frac * (endAngle - startAngle);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(
        cx + Math.cos(currentAngle) * (radius - 5),
        cy + Math.sin(currentAngle) * (radius - 5)
      );
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.stroke();

      // Center cap
      ctx.beginPath();
      ctx.arc(cx, cy, radius / 4, 0, 2 * Math.PI);
      ctx.fillStyle = "#0f172a";
      ctx.fill();
    } else if (el.type === "Slider") {
      // Track
      const trackWidth = 10;
      ctx.beginPath();
      ctx.roundRect(x + w / 2 - trackWidth / 2, y + 10, trackWidth, h - 20, 5);
      ctx.fillStyle = "#0f172a";
      ctx.fill();
      ctx.strokeStyle = "#334155";
      ctx.stroke();

      // Filled track part (active area)
      const fillHeight = (h - 20) * frac;
      ctx.beginPath();
      ctx.roundRect(
        x + w / 2 - trackWidth / 2,
        y + h - 10 - fillHeight,
        trackWidth,
        fillHeight,
        5
      );
      ctx.fillStyle = activeColor;
      ctx.fill();

      // Handle thumb
      const thumbY = y + h - 10 - fillHeight;
      ctx.beginPath();
      ctx.roundRect(x + w / 2 - 15, thumbY - 8, 30, 16, 4);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Center handle line
      ctx.beginPath();
      ctx.moveTo(x + w / 2 - 10, thumbY);
      ctx.lineTo(x + w / 2 + 10, thumbY);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (el.type === "Button" || el.type === "Toggle") {
      const isPressed = el.type === "Toggle" && value > 0.5;

      // Button body
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, el.cornerRadius || 8);
      ctx.fillStyle = isPressed ? activeColor : color;
      ctx.fill();
      ctx.strokeStyle = "#475569";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Inner metallic highlight
      ctx.beginPath();
      ctx.roundRect(x + 2, y + 2, w - 4, h - 4, el.cornerRadius || 8);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.stroke();
    } else if (el.type === "Meter") {
      // Background chassis
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 6);
      ctx.fillStyle = "#020617";
      ctx.fill();
      ctx.strokeStyle = "#1e293b";
      ctx.stroke();

      // LED indicators
      const segments = 12;
      const spacing = 3;
      const segWidth = (w - 10);
      const segHeight = (h - 10 - (segments - 1) * spacing) / segments;

      for (let i = 0; i < segments; i++) {
        const segY = y + h - 5 - (i + 1) * (segHeight + spacing);
        const isActive = frac > i / segments;

        ctx.beginPath();
        ctx.roundRect(x + 5, segY, segWidth, segHeight, 2);

        if (isActive) {
          if (i > 9) ctx.fillStyle = "#ef4444"; // Red top
          else if (i > 7) ctx.fillStyle = "#eab308"; // Yellow mid
          else ctx.fillStyle = "#10b981"; // Green low
        } else {
          ctx.fillStyle = "#1e293b"; // Off segment
        }
        ctx.fill();
      }
    } else if (el.type === "Waveform") {
      // Audio waveform background panel
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 8);
      ctx.fillStyle = "#0f172a";
      ctx.fill();
      ctx.strokeStyle = "#334155";
      ctx.stroke();

      // Glowing Sine wave representation
      ctx.beginPath();
      ctx.moveTo(x + 5, y + h / 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = activeColor;

      for (let tx = 5; tx < w - 5; tx++) {
        const rad = ((tx - 5) / (w - 10)) * Math.PI * 4; // 2 cycles
        const ty = y + h / 2 + Math.sin(rad) * (h / 2.5) * frac;
        ctx.lineTo(x + tx, ty);
      }
      ctx.stroke();
    } else if (el.type === "XYPad") {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 8);
      ctx.fillStyle = "#0f172a";
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();

      // Grid crosshairs
      ctx.strokeStyle = "rgba(148, 163, 184, 0.1)";
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w / 2, y + h);
      ctx.moveTo(x, y + h / 2);
      ctx.lineTo(x + w, y + h / 2);
      ctx.stroke();

      // Position puck
      const px = x + (el.valueX !== undefined ? el.valueX : 0.5) * w;
      const py = y + (el.valueY !== undefined ? el.valueY : 0.5) * h;

      ctx.beginPath();
      ctx.arc(px, py, 7, 0, 2 * Math.PI);
      ctx.fillStyle = activeColor;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    } else if (el.type === "WaveShaper" || el.type === "Envelope") {
      // Dark panel + a curve line (wave-shaping transfer curve / ADSR contour).
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 8);
      ctx.fillStyle = "#0f172a";
      ctx.fill();
      ctx.strokeStyle = "#334155";
      ctx.stroke();

      ctx.beginPath();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = activeColor;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (el.type === "Envelope") {
        // ADSR contour: attack ramp up, decay to sustain plateau, release down.
        ctx.moveTo(x + 5, y + h - 5);
        ctx.lineTo(x + w * 0.2, y + 5);
        ctx.lineTo(x + w * 0.45, y + h * 0.45);
        ctx.lineTo(x + w * 0.7, y + h * 0.45);
        ctx.lineTo(x + w - 5, y + h - 5);
      } else {
        // Wave-shaper transfer curve: a soft S through the center.
        ctx.moveTo(x + 5, y + h - 5);
        ctx.bezierCurveTo(
          x + w * 0.4,
          y + h - 5,
          x + w * 0.6,
          y + 5,
          x + w - 5,
          y + 5
        );
      }
      ctx.stroke();
    } else if (el.type === "StepSequencer") {
      // Dark panel + a grid of dots.
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 8);
      ctx.fillStyle = "#0f172a";
      ctx.fill();
      ctx.strokeStyle = "#334155";
      ctx.stroke();

      const cols = 8;
      const rows = 4;
      const padX = 8;
      const padY = 8;
      const cellW = (w - padX * 2) / cols;
      const cellH = (h - padY * 2) / rows;
      const dotR = Math.max(1.5, Math.min(cellW, cellH) / 3.5);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const dotX = x + padX + cellW * (col + 0.5);
          const dotY = y + padY + cellH * (row + 0.5);
          ctx.beginPath();
          ctx.arc(dotX, dotY, dotR, 0, 2 * Math.PI);
          // A sparse diagonal of lit steps for a recognizable pattern.
          ctx.fillStyle = col % 4 === row ? activeColor : "#1e293b";
          ctx.fill();
        }
      }
    } else if (el.type === "Keyboard") {
      // White-key strip with black keys on top.
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 4);
      ctx.fillStyle = "#e2e8f0";
      ctx.fill();
      ctx.strokeStyle = "#334155";
      ctx.stroke();

      const whiteKeys = 7;
      const keyW = w / whiteKeys;
      ctx.strokeStyle = "#94a3b8";
      ctx.lineWidth = 1;
      for (let i = 1; i < whiteKeys; i++) {
        ctx.beginPath();
        ctx.moveTo(x + keyW * i, y);
        ctx.lineTo(x + keyW * i, y + h);
        ctx.stroke();
      }
      // Black keys sit over the gaps after C, D, F, G, A (indices 0,1,3,4,5).
      const blackAfter = [0, 1, 3, 4, 5];
      const bkW = keyW * 0.6;
      const bkH = h * 0.6;
      ctx.fillStyle = "#0f172a";
      for (const k of blackAfter) {
        const bkX = x + keyW * (k + 1) - bkW / 2;
        ctx.beginPath();
        ctx.roundRect(bkX, y, bkW, bkH, 2);
        ctx.fill();
      }
    } else {
      // General rect representing label/image/other elements
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 4);
      ctx.fillStyle = "rgba(30, 41, 59, 0.4)";
      ctx.fill();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.3)";
      ctx.stroke();
    }

    // Always draw labels/names on elements for visual awareness
    ctx.restore(); // clears shadows / rotation for labels

    if (el.name || el.label) {
      ctx.font = "bold 10px sans-serif";
      ctx.fillStyle = el.textColor || "#cbd5e1"; // slate-300
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const displayText = el.label || el.name;
      ctx.fillText(displayText.substring(0, 16), x + w / 2, y + h + 8);
    }
  });

  // 3. Draw user annotations on top (strokes, shapes, text notes)
  for (const a of annotations || []) {
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = a.strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (a.kind === "stroke" && a.points && a.points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(a.points[0].x, a.points[0].y);
      for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
      ctx.stroke();
    } else if (a.kind === "rect") {
      // Live layer uses rx={2}; match its rounded corners.
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(a.x ?? 0, a.y ?? 0, a.width ?? 0, a.height ?? 0, 2);
        ctx.stroke();
      } else {
        ctx.strokeRect(a.x ?? 0, a.y ?? 0, a.width ?? 0, a.height ?? 0);
      }
    } else if (a.kind === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(
        (a.x ?? 0) + (a.width ?? 0) / 2,
        (a.y ?? 0) + (a.height ?? 0) / 2,
        (a.width ?? 0) / 2,
        (a.height ?? 0) / 2,
        0, 0, Math.PI * 2,
      );
      ctx.stroke();
    } else if (a.kind === "text" && a.text) {
      const fs = a.fontSize ?? 14;
      // Match the live SVG layer: same font stack, alphabetic baseline, and
      // first line at y + fs (tspan dy = fs*1.3 for each additional line).
      ctx.font = `${fs}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      a.text.split("\n").forEach((line, i) => {
        ctx.fillText(line, a.x ?? 0, (a.y ?? 0) + fs + i * fs * 1.3);
      });
    }
  }

  try {
    return canvas.toDataURL("image/png");
  } catch (e) {
    // Cross-origin background tainted the canvas; re-render without it.
    if (backgroundImageUrl) {
      return generateCanvasScreenshot(
        elements,
        canvasWidth,
        canvasHeight,
        null,
        annotations
      );
    }
    return "";
  }
}
