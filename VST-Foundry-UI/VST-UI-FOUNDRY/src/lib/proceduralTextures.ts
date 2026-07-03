import type { Texture } from "../types";

// Built-in procedural texture pack. These ship with the app and cost zero bytes
// on disk: every texture is drawn to an offscreen 512×512 canvas at runtime and
// exported as a PNG data URL. Generation is fully DETERMINISTIC — a seeded
// mulberry32 PRNG with a fixed seed per texture, never Math.random — so the same
// build always produces byte-identical output (stable ids + stable pixels means
// the autosave/dedupe path never sees them "change").
//
// All eight textures are authored to tile seamlessly at 512px: strokes/patterns
// are either full-span or use a period that divides 512, and all value-noise is
// sampled from a wrapped lattice.

const SIZE = 512;

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

// mulberry32: tiny, fast, well-distributed 32-bit PRNG. Same seed → same stream.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

// Tileable value-noise sampler. Builds a `cells`×`cells` lattice of random
// values that wraps at the lattice edge, so sampling at u=1 equals u=0 → the
// resulting field is seamless across a 512px tile for ANY integer `cells`.
// Inputs u/v are normalized [0,1).
function makeTileableNoise(
  rand: () => number,
  cells: number,
): (u: number, v: number) => number {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const at = (ix: number, iy: number): number => {
    const x = ((ix % cells) + cells) % cells;
    const y = ((iy % cells) + cells) % cells;
    return grid[y * cells + x];
  };
  return (u: number, v: number): number => {
    const fx = u * cells;
    const fy = v * cells;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const top = lerp(at(x0, y0), at(x0 + 1, y0), tx);
    const bot = lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), tx);
    return lerp(top, bot, ty);
  };
}

// Sum several octaves of tileable noise (fractal Brownian motion). Each octave
// tiles individually, so the sum tiles. Normalized back to ~[0,1].
function makeFbm(
  rand: () => number,
  baseCells: number,
  octaves: number,
): (u: number, v: number) => number {
  const layers: Array<{ noise: (u: number, v: number) => number; amp: number }> =
    [];
  let cells = baseCells;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ noise: makeTileableNoise(rand, cells), amp });
    norm += amp;
    amp *= 0.5;
    cells *= 2;
  }
  return (u: number, v: number): number => {
    let sum = 0;
    for (const l of layers) sum += l.noise(u, v) * l.amp;
    return sum / norm;
  };
}

// Draw a filled circle and its wrapped copies so dots that fall near a tile edge
// reappear on the opposite side — keeps speckle/hole patterns seamless.
function wrappedCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      if (
        x + ox * SIZE + r < 0 ||
        x + ox * SIZE - r > SIZE ||
        y + oy * SIZE + r < 0 ||
        y + oy * SIZE - r > SIZE
      ) {
        continue;
      }
      ctx.beginPath();
      ctx.arc(x + ox * SIZE, y + oy * SIZE, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// Build one Texture from a draw callback, exporting the canvas as a PNG data URL.
function renderTexture(
  id: string,
  name: string,
  seed: number,
  draw: (ctx: CanvasRenderingContext2D, rand: () => number) => void,
): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx) draw(ctx, mulberry32(seed));
  return {
    id,
    name,
    url: canvas.toDataURL("image/png"),
    isGenerated: true,
    provider: "builtin",
  };
}

// ---------------------------------------------------------------------------
// Individual texture recipes
// ---------------------------------------------------------------------------

function drawBrushedSteel(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
): void {
  const g = ctx.createLinearGradient(0, 0, 0, SIZE);
  g.addColorStop(0, "#b9bdc5");
  g.addColorStop(0.5, "#9498a0");
  g.addColorStop(1, "#7f838b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Thousands of faint full-width horizontal strokes → the brushed grain. Full
  // width keeps every row identical L↔R (seamless in x); random rows read as
  // metal grain (seamless enough in y for a directionless brush).
  for (let i = 0; i < 9000; i++) {
    const y = Math.floor(rand() * SIZE);
    const light = rand() > 0.5;
    const a = rand() * 0.06;
    ctx.fillStyle = light
      ? `rgba(255,255,255,${a})`
      : `rgba(0,0,0,${a * 0.9})`;
    ctx.fillRect(0, y, SIZE, 1);
  }

  // Broad diagonal sheen band.
  const sheen = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  sheen.addColorStop(0, "rgba(255,255,255,0)");
  sheen.addColorStop(0.45, "rgba(255,255,255,0.14)");
  sheen.addColorStop(0.55, "rgba(255,255,255,0.14)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, SIZE, SIZE);
}

function drawCarbonWeave(
  ctx: CanvasRenderingContext2D,
  _rand: () => number,
): void {
  const cell = 16; // divides 512 → seamless twill
  ctx.fillStyle = "#101116";
  ctx.fillRect(0, 0, SIZE, SIZE);

  for (let gy = 0; gy < SIZE / cell; gy++) {
    for (let gx = 0; gx < SIZE / cell; gx++) {
      const x = gx * cell;
      const y = gy * cell;
      const even = (gx + gy) % 2 === 0;
      // Alternate the fiber-bundle direction to form the woven twill.
      const grad = even
        ? ctx.createLinearGradient(x, y, x + cell, y + cell)
        : ctx.createLinearGradient(x + cell, y, x, y + cell);
      grad.addColorStop(0, "#33343c");
      grad.addColorStop(0.5, "#1c1d23");
      grad.addColorStop(1, "#0c0c10");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, cell, cell);
    }
  }

  // Thin weave separations for the crosshatch read.
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1;
  for (let p = cell; p < SIZE; p += cell) {
    ctx.beginPath();
    ctx.moveTo(p + 0.5, 0);
    ctx.lineTo(p + 0.5, SIZE);
    ctx.moveTo(0, p + 0.5);
    ctx.lineTo(SIZE, p + 0.5);
    ctx.stroke();
  }
}

function drawLeatherGrain(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
): void {
  const mottle = makeFbm(rand, 6, 4);
  const grain = makeTileableNoise(rand, 96);
  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const m = mottle(u, v);
      const gr = grain(u, v);
      const shade = 0.7 + m * 0.5 + (gr - 0.5) * 0.25;
      const r = clamp255(96 * shade);
      const g = clamp255(58 * shade);
      const b = clamp255(38 * shade);
      const i = (y * SIZE + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Pores: dark punctures + tiny warm highlights, wrapped for seamlessness.
  for (let i = 0; i < 2600; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    const r = 0.4 + rand() * 1.1;
    ctx.fillStyle = `rgba(0,0,0,${0.12 + rand() * 0.16})`;
    wrappedCircle(ctx, x, y, r);
  }
  for (let i = 0; i < 900; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    ctx.fillStyle = `rgba(255,225,190,${0.05 + rand() * 0.06})`;
    wrappedCircle(ctx, x, y, 0.4 + rand() * 0.7);
  }
}

function drawWoodGrain(ctx: CanvasRenderingContext2D, rand: () => number): void {
  // Low-freq warp bends the vertical strands; fine noise adds fibre texture.
  const warp = makeTileableNoise(rand, 8);
  const fibre = makeFbm(rand, 24, 3);
  const rings = 22; // integer periods across the tile → seamless in x
  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const w = warp(u, v);
      // Vertical strands: value driven mostly by x, gently warped by y-varying
      // noise. sin over an integer number of periods keeps the seam closed.
      const strand = Math.sin((u * rings + w * 0.6) * Math.PI * 2) * 0.5 + 0.5;
      const f = fibre(u, v);
      const shade = 0.55 + strand * 0.4 + (f - 0.5) * 0.22;
      const r = clamp255(150 * shade);
      const g = clamp255(100 * shade);
      const b = clamp255(58 * shade);
      const i = (y * SIZE + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawPlasticNoise(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
): void {
  const fine = makeTileableNoise(rand, 160);
  const broad = makeTileableNoise(rand, 8);
  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      // Vertical sheen baked in + subtle broad mottle + very fine grain.
      const sheen = 1 - v * 0.18;
      const shade = sheen + (broad(u, v) - 0.5) * 0.12 + (fine(u, v) - 0.5) * 0.08;
      const base = 74 * shade;
      const i = (y * SIZE + x) * 4;
      d[i] = clamp255(base + 6);
      d[i + 1] = clamp255(base + 4);
      d[i + 2] = clamp255(base + 10);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function drawConcrete(ctx: CanvasRenderingContext2D, rand: () => number): void {
  const fbm = makeFbm(rand, 5, 5);
  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE;
      const v = y / SIZE;
      const n = fbm(u, v);
      const shade = 0.62 + n * 0.5;
      const g = clamp255(150 * shade);
      const i = (y * SIZE + x) * 4;
      d[i] = g;
      d[i + 1] = g;
      d[i + 2] = clamp255(g + 4);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Aggregate speckle: dark pits + light flecks, wrapped for seamlessness.
  for (let i = 0; i < 4200; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    ctx.fillStyle = `rgba(0,0,0,${0.06 + rand() * 0.12})`;
    wrappedCircle(ctx, x, y, 0.4 + rand() * 1.2);
  }
  for (let i = 0; i < 1800; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    ctx.fillStyle = `rgba(255,255,255,${0.04 + rand() * 0.08})`;
    wrappedCircle(ctx, x, y, 0.4 + rand() * 0.9);
  }
}

function drawPerforatedMetal(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
): void {
  // Dark plate base with a faint brushed grain.
  const g = ctx.createLinearGradient(0, 0, 0, SIZE);
  g.addColorStop(0, "#2b2e34");
  g.addColorStop(1, "#191b1f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < 2500; i++) {
    const y = Math.floor(rand() * SIZE);
    ctx.fillStyle = `rgba(255,255,255,${rand() * 0.03})`;
    ctx.fillRect(0, y, SIZE, 1);
  }

  // Punched dot grid. spacing divides 512 → seamless. Each hole is a radial
  // gradient (dark centre) with a top-left highlight + bottom-right shadow arc
  // to sell the punched inner shadow.
  const spacing = 32;
  const radius = 9;
  for (let cy = spacing / 2; cy < SIZE; cy += spacing) {
    for (let cx = spacing / 2; cx < SIZE; cx += spacing) {
      const hole = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      hole.addColorStop(0, "#060708");
      hole.addColorStop(0.7, "#0c0e11");
      hole.addColorStop(1, "rgba(20,22,26,0)");
      ctx.fillStyle = hole;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath();
      ctx.arc(cx, cy, radius - 0.5, Math.PI * 0.9, Math.PI * 1.6);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.beginPath();
      ctx.arc(cx, cy, radius - 0.5, Math.PI * -0.2, Math.PI * 0.55);
      ctx.stroke();
    }
  }
}

function drawScanlines(ctx: CanvasRenderingContext2D, rand: () => number): void {
  ctx.fillStyle = "#0a0b0f";
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Horizontal lines on a 4px period (divides 512 → seamless in y). A lit band
  // + dark gap per period; per-line jitter adds CRT life without breaking tiling.
  const period = 4;
  for (let y = 0; y < SIZE; y += period) {
    const j = rand() * 0.08;
    ctx.fillStyle = `rgba(150,170,190,${0.12 + j})`;
    ctx.fillRect(0, y, SIZE, 1);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(0, y + 2, SIZE, 2);
  }

  // Very faint vertical phosphor triads for extra fidelity.
  for (let x = 0; x < SIZE; x += 3) {
    ctx.fillStyle = "rgba(255,255,255,0.02)";
    ctx.fillRect(x, 0, 1, SIZE);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Generate the built-in texture pack. Returns an empty array outside a browser
 * (no `document`), so callers can invoke it unconditionally. Ids and names are
 * STABLE — used by App.tsx to dedupe against already-persisted copies.
 */
export function generateBuiltinTextures(): Texture[] {
  if (typeof document === "undefined") return [];
  return [
    renderTexture(
      "builtin-brushed-steel",
      "Brushed Steel",
      1001,
      drawBrushedSteel,
    ),
    renderTexture("builtin-carbon-weave", "Carbon Weave", 1002, drawCarbonWeave),
    renderTexture(
      "builtin-leather-grain",
      "Leather Grain",
      1003,
      drawLeatherGrain,
    ),
    renderTexture("builtin-wood-grain", "Wood Grain", 1004, drawWoodGrain),
    renderTexture(
      "builtin-plastic-noise",
      "Plastic Noise",
      1005,
      drawPlasticNoise,
    ),
    renderTexture("builtin-concrete", "Concrete", 1006, drawConcrete),
    renderTexture(
      "builtin-perforated-metal",
      "Perforated Metal",
      1007,
      drawPerforatedMetal,
    ),
    renderTexture("builtin-scanlines", "Scanlines", 1008, drawScanlines),
  ];
}
