import React, { useEffect, useRef } from 'react';

/* ── ModuleThumb ─────────────────────────────────────────────────────────────
   The "badass thumbnail" for a Studio Module tile. Ports the per-module canvas
   preview renderers verbatim from the Edit Tool Stack's static/modules/index.html
   so each tile previews its instrument's character (EQ bars, transfer curve,
   goniometer rings, grain cloud, RVQ segments, …). Pure Canvas2D, framework-free. */

type Draw = (ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number) => void;

// Deterministic PRNG so a VST's generated faceplate is stable across reloads
// (seeded by the plugin name) rather than reshuffling on every render.
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A generated plugin faceplate for VSTs, which expose no native GUI to capture.
// The category picks the screen motif (waveform for effects, note blocks for
// instruments); the seeded rng drives hue, screen content, and knob layout, so
// each plugin reads as a distinct module instead of a generic plug icon.
function drawVst(ctx: CanvasRenderingContext2D, W: number, H: number, rng: () => number, kind: 'effect' | 'instrument') {
  const hue = Math.floor(rng() * 360);
  const accent = `hsl(${hue}, 78%, 62%)`;
  const accentDim = `hsl(${hue}, 55%, 40%)`;
  const accent2 = `hsl(${(hue + 45) % 360}, 82%, 62%)`;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, `hsl(${hue}, 28%, 13%)`);
  bg.addColorStop(1, `hsl(${hue}, 32%, 6%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const padX = Math.max(3, W * 0.07);
  const screenY = Math.max(3, H * 0.1);
  const screenW = W - padX * 2;
  const screenH = Math.max(10, H * 0.34);

  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.beginPath(); ctx.roundRect(padX, screenY, screenW, screenH, 2); ctx.fill();
  ctx.strokeStyle = `hsl(${hue}, 40%, 22%)`; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.roundRect(padX, screenY, screenW, screenH, 2); ctx.stroke();

  if (kind === 'instrument') {
    const cols = 6 + Math.floor(rng() * 3);
    const cw = screenW / cols;
    const heights = Array.from({ length: cols }, () => 0.3 + rng() * 0.65);
    for (let i = 0; i < cols; i++) {
      const bh = heights[i] * (screenH - 4);
      ctx.fillStyle = i % 2 ? accent2 : accent;
      ctx.globalAlpha = 0.5 + heights[i] * 0.45;
      ctx.fillRect(padX + i * cw + 1, screenY + screenH - 2 - bh, cw - 2, bh);
    }
    ctx.globalAlpha = 1;
  } else {
    const midY = screenY + screenH / 2;
    const f1 = 0.06 + rng() * 0.1;
    const f2 = 0.12 + rng() * 0.22;
    const ph = rng() * Math.PI * 2;
    const amp = screenH * (0.22 + rng() * 0.16);
    ctx.strokeStyle = accent; ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let x = 0; x <= screenW; x++) {
      const v = Math.sin(x * f1) * 0.62 + Math.sin(x * f2 + ph) * 0.34;
      ctx.lineTo(padX + x, midY - v * amp);
    }
    ctx.stroke();
  }

  // status LEDs in the top-right of the screen
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = i === 0 ? accent2 : 'rgba(255,255,255,.16)';
    ctx.beginPath(); ctx.arc(padX + screenW - 4 - i * 4.5, screenY + 3.5, 1.3, 0, Math.PI * 2); ctx.fill();
  }

  // knob row
  const knobN = 2 + Math.floor(rng() * 2); // 2..3 knobs
  const ctrlTop = screenY + screenH + Math.max(4, H * 0.08);
  const availH = H - ctrlTop - Math.max(3, H * 0.06);
  const knobR = Math.max(3, Math.min(availH * 0.46, (screenW / knobN) * 0.34));
  const cy = ctrlTop + knobR + 1;
  for (let i = 0; i < knobN; i++) {
    const cx = padX + ((i + 0.5) / knobN) * screenW;
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.beginPath(); ctx.arc(cx, cy, knobR, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = accentDim; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, knobR, 0, Math.PI * 2); ctx.stroke();
    const a = (0.75 + rng() * 1.5) * Math.PI; // 135deg..405deg pointer sweep
    ctx.strokeStyle = accent; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * knobR * 0.72, cy + Math.sin(a) * knobR * 0.72); ctx.stroke();
    ctx.fillStyle = accent2;
    ctx.beginPath(); ctx.arc(cx, cy, Math.max(0.8, knobR * 0.16), 0, Math.PI * 2); ctx.fill();
  }
}

const DRAWERS: Record<string, Draw> = {
  'eq-bars': (ctx, W, H) => {
    const bars = [0.5, 0.7, 0.4, 0.8, 0.6];
    const bw = W / bars.length - 4;
    bars.forEach((v, i) => {
      ctx.fillStyle = `rgba(77,208,225,${0.3 + v * 0.4})`;
      const bh = v * H * 0.8;
      ctx.fillRect(i * (bw + 4) + 2, H - bh, bw, bh);
    });
  },
  dynamics: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(102,187,106,.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(4, H - 4); ctx.lineTo(W * 0.4, H * 0.5); ctx.lineTo(W - 4, H * 0.35); ctx.stroke();
    ctx.setLineDash([2, 2]); ctx.strokeStyle = 'rgba(255,255,255,.15)';
    ctx.beginPath(); ctx.moveTo(4, H - 4); ctx.lineTo(W - 4, 4); ctx.stroke(); ctx.setLineDash([]);
  },
  transient: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(129,199,132,.5)'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) { const t = x / W; const spike = t > 0.15 && t < 0.25 ? Math.exp(-(t - 0.2) * 80) * 20 : 0; const body = Math.sin(t * 40) * 4 * Math.exp(-t * 3); ctx.lineTo(x, H / 2 - spike - body); }
    ctx.stroke();
  },
  maximizer: (ctx, W, H) => {
    ctx.fillStyle = 'rgba(255,171,64,.15)'; ctx.fillRect(0, 4, W, H - 8);
    ctx.strokeStyle = 'rgba(255,171,64,.5)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) { const v = (Math.sin(x * 0.15) + Math.sin(x * 0.23) * 0.5) * 0.35; ctx.lineTo(x, H / 2 - v * H); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(239,83,80,.4)'; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(W, 6); ctx.stroke(); ctx.setLineDash([]);
  },
  imager: (ctx, W, H) => {
    const cx = W / 2, cy = H / 2;
    for (let i = 3; i > 0; i--) { ctx.beginPath(); ctx.ellipse(cx, cy, i * W * 0.12, i * H * 0.3, 0, 0, Math.PI * 2); ctx.strokeStyle = `rgba(171,71,188,${0.15 + i * 0.1})`; ctx.lineWidth = 1; ctx.stroke(); }
  },
  exciter: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(239,83,80,.4)'; ctx.lineWidth = 1;
    for (let h = 1; h <= 5; h++) { ctx.beginPath(); for (let x = 0; x < W; x++) { const v = Math.sin(x * 0.1 * h) * 3 / h; ctx.lineTo(x, H / 2 + v); } ctx.stroke(); }
  },
  character: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(255,112,67,.4)'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) { const v = Math.tanh(Math.sin(x * 0.12) * 2) * H * 0.3; ctx.lineTo(x, H / 2 - v); }
    ctx.stroke();
  },
  cleanup: (ctx, W, H) => {
    ctx.fillStyle = 'rgba(38,198,218,.06)';
    for (let i = 0; i < 30; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    ctx.strokeStyle = 'rgba(38,198,218,.4)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) ctx.lineTo(x, H / 2 + Math.sin(x * 0.2) * 5);
    ctx.stroke();
  },
  repair: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(77,208,225,.3)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) { const glitch = (x > W * 0.3 && x < W * 0.5) ? (Math.random() - 0.5) * 10 : 0; ctx.lineTo(x, H / 2 + Math.sin(x * 0.15) * 6 + glitch); }
    ctx.stroke();
    ctx.fillStyle = 'rgba(77,208,225,.12)'; ctx.fillRect(W * 0.3, 2, W * 0.2, H - 4);
  },
  enhance: (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(66,165,245,.3)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) ctx.lineTo(x, H / 2 + Math.sin(x * 0.18) * 4);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(66,165,245,.6)'; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let x = 0; x < W; x++) ctx.lineTo(x, H / 2 + Math.sin(x * 0.18) * 7);
    ctx.stroke();
  },
  vocoder: (ctx, W, H) => {
    for (let x = 0; x < W; x += 2) {
      for (let y = 0; y < H / 2 - 2; y += 3) { const v = Math.random() * 0.5; if (v > 0.3) { ctx.fillStyle = `rgba(232,121,249,${v * 0.5})`; ctx.fillRect(x, y, 2, 2); } }
      for (let y = H / 2 + 2; y < H; y += 3) { const v = Math.random() * 0.5; if (v > 0.3) { ctx.fillStyle = `rgba(0,229,255,${v * 0.5})`; ctx.fillRect(x, y, 2, 2); } }
    }
    ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(0, H / 2 - 1, W, 2);
  },
  granular: (ctx, W, H) => {
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * W, y = Math.random() * H;
      const c = Math.random();
      const r = Math.floor(255 * (1 - c) * 0.9 + 40 * c);
      const g = Math.floor(160 * (1 - c) + 200 * c);
      const b = Math.floor(60 * (1 - c) + 220 * c);
      ctx.beginPath(); ctx.arc(x, y, 1 + Math.random() * 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.3 + Math.random() * 0.5})`;
      ctx.fill();
    }
  },
  promptfx: (ctx, W, H) => {
    const colors = ['#26c6da', '#8b5cf6', '#ef5350', '#ffab40'];
    const labels = ['LP', 'RV', 'OD', 'DL'];
    for (let i = 0; i < 4; i++) {
      const bw = W * 0.25 + Math.random() * W * 0.45;
      const by = 4 + i * 11;
      ctx.fillStyle = colors[i] + '25';
      ctx.beginPath(); ctx.roundRect(4, by, bw, 9, 3); ctx.fill();
      ctx.fillStyle = colors[i] + '70';
      ctx.beginPath(); ctx.roundRect(4, by, 3, 9, [3, 0, 0, 3]); ctx.fill();
      ctx.fillStyle = colors[i] + '90';
      ctx.font = '700 6px "IBM Plex Mono"';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(labels[i], 11, by + 5);
    }
  },
  // Psychoacoustic effect thumbnails, one per group, in the Studio canvas style.
  'psy-spatial': (ctx, W, H) => {
    const cx = W / 2, cy = H / 2;
    for (let i = 3; i > 0; i--) {
      ctx.beginPath(); ctx.arc(cx, cy, i * Math.min(W, H) * 0.13, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(171,71,188,${0.15 + i * 0.12})`; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.fillStyle = 'rgba(232,121,249,.9)';
    ctx.beginPath(); ctx.arc(cx + W * 0.18, cy - H * 0.12, 2.5, 0, Math.PI * 2); ctx.fill();
  },
  'psy-lowend': (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(245,158,11,.55)'; ctx.lineWidth = 2; ctx.beginPath();
    for (let x = 0; x < W; x++) { const v = Math.sin(x * 0.06) * H * 0.3; ctx.lineTo(x, H / 2 - v); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(245,158,11,.2)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = 0; x < W; x++) { const v = Math.sin(x * 0.18) * H * 0.12; ctx.lineTo(x, H / 2 - v); }
    ctx.stroke();
  },
  'psy-tone': (ctx, W, H) => {
    ctx.strokeStyle = 'rgba(239,83,80,.4)'; ctx.lineWidth = 1;
    for (let h = 1; h <= 6; h++) { ctx.beginPath(); for (let x = 0; x < W; x++) { const v = Math.sin(x * 0.08 * h) * 3 / h; ctx.lineTo(x, H / 2 + v); } ctx.stroke(); }
    ctx.strokeStyle = 'rgba(239,83,80,.5)'; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(0, H * 0.72); ctx.lineTo(W, H * 0.25); ctx.stroke(); ctx.setLineDash([]);
  },
  'psy-performance': (ctx, W, H) => {
    const n = 8, bw = W / n;
    for (let i = 0; i < n; i++) {
      const on = i % 2 === 0;
      ctx.fillStyle = on ? 'rgba(139,92,246,.55)' : 'rgba(139,92,246,.12)';
      const bh = on ? H * 0.7 : H * 0.25;
      ctx.fillRect(i * bw + 1, H - bh, bw - 2, bh);
    }
  },
  codec: (ctx, W, H) => {
    const segW = W / 16;
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const r = Math.floor(239 * (1 - t));
      const g = Math.floor(83 * (1 - t) + 229 * t);
      const b = Math.floor(80 * (1 - t) + 255 * t);
      ctx.fillStyle = `rgba(${r},${g},${b},${i < 12 ? 0.7 : 0.08})`;
      ctx.beginPath(); ctx.roundRect(i * segW + 1, 6, segW - 2, H - 12, 2); ctx.fill();
    }
    const cutX = 12 * segW;
    ctx.strokeStyle = 'rgba(239,68,68,.35)'; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(cutX, 4); ctx.lineTo(cutX, H - 4); ctx.stroke(); ctx.setLineDash([]);
  },
  // VST faceplates — seeded per plugin (see drawVst). 'vst' is the generic fallback.
  'vst-effect': (ctx, W, H, rng) => drawVst(ctx, W, H, rng, 'effect'),
  'vst-instrument': (ctx, W, H, rng) => drawVst(ctx, W, H, rng, 'instrument'),
  vst: (ctx, W, H, rng) => drawVst(ctx, W, H, rng, 'effect'),
};

export const ModuleThumb: React.FC<{ preview: string; seed?: string; className?: string }> = ({ preview, seed, className }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const draw = DRAWERS[preview];

    const render = () => {
      const W = parent.clientWidth;
      const H = parent.clientHeight;
      if (W === 0 || H === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // A seed makes the drawer deterministic (used by VST faceplates); without
      // one the legacy drawers keep their Math.random sparkle.
      const rng = seed != null ? mulberry32(hashStr(seed)) : Math.random;
      draw?.(ctx, W, H, rng);
    };

    render();
    const ro = new ResizeObserver(render);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [preview, seed]);

  return <canvas ref={ref} className={className} />;
};
