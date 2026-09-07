/**
 * lifeStack — what a Life rule looks like from the inside: its live grid,
 * and its generations stacked up behind it.
 *
 * Two pens, ported:
 *  - ilithya's "Gen Art with Conway's Game of Life"
 *    (https://codepen.io/ilithya/pen/QWMaQdg): the grid of alive cells drawn
 *    as squares, circles or triangles — `drawLifeGrid` keeps her three shapes
 *    and toggles them by cell kind.
 *  - foretoo's "game of life evolves in 3D" (https://codepen.io/foretoo/pen/xxeoJoq):
 *    every generation becomes a layer of cubes and the stack rises with time;
 *    `drawLifeStack` draws that stack in an isometric projection on the 2D
 *    canvas with his vertex-shader shading: ambient occlusion from the height
 *    `h`, the distance from the far corner `l` and the radius from the centre
 *    `r` (`color = l * r * sqrt(h)`, squared, lifted to 0.087), then a
 *    directional light on each face.
 */

export type CellShape = 'square' | 'circle' | 'triangle';

/** ilithya's cells: the alive ones of one generation, in one of her shapes. */
export function drawLifeGrid(ctx: CanvasRenderingContext2D, grid: boolean[][], x: number, y: number, w: number, h: number, shape: CellShape, color: string, liveCol = -1, liveColor = '#fff3b0'): void {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  if (!rows || !cols) return;
  const cw = w / cols;
  const ch = h / rows;
  const s = Math.min(cw, ch);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const alive = grid[r][c];
      const cx = x + c * cw + cw / 2;
      const cy = y + r * ch + ch / 2;
      ctx.fillStyle = c === liveCol ? liveColor : color;
      ctx.globalAlpha = alive ? 1 : c === liveCol ? 0.35 : 0.14;
      ctx.beginPath();
      if (shape === 'circle') ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2);
      else if (shape === 'triangle') { ctx.moveTo(cx, cy - s * 0.46); ctx.lineTo(cx + s * 0.46, cy + s * 0.4); ctx.lineTo(cx - s * 0.46, cy + s * 0.4); ctx.closePath(); }
      else ctx.rect(cx - s * 0.42, cy - s * 0.42, s * 0.84, s * 0.84);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * foretoo's stack: `gens` oldest→newest, each a rows×cols grid; drawn as
 * isometric cubes with his AO + light, `unit` px per cube edge, rising by
 * `unit * 0.9` per generation. `tint` colours the lit faces.
 */
export function drawLifeStack(ctx: CanvasRenderingContext2D, gens: boolean[][][], x: number, y: number, unit: number, tint: [number, number, number]): void {
  const height = gens.length;
  if (!height) return;
  const rows = gens[0].length;
  const cols = gens[0][0]?.length ?? 0;
  const side = Math.max(rows, cols);
  const hSide = side / 2;
  // isometric axes
  const ax = { x: unit * 0.87, y: unit * 0.5 };
  const ay = { x: -unit * 0.87, y: unit * 0.5 };
  const up = unit * 0.9;
  const lightDir = norm3(1, 3, -2);
  const faces: { top: number; right: number; front: number } = {
    top: Math.max(0, dot3([0, 1, 0], lightDir)),
    right: Math.max(0, dot3([1, 0, 0], lightDir)),
    front: Math.max(0, dot3([0, 0, -1], lightDir)),
  };
  for (let g = 0; g < height; g += 1) {
    const grid = gens[g];
    const h = g / height;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (!grid[r][c]) continue;
        // AO, SELF SHADOW — his vertex shader, per cube
        const px = c - hSide; const pz = hSide - r;
        let l = Math.hypot(-hSide - px, hSide - pz);
        l = Math.min(1, l / side); l *= l;
        l = mix(1, l, Math.sqrt(1 - h) - 0.1);
        let rr = Math.hypot(c / side - 0.5, r / side - 0.5);
        rr = Math.min(1, rr * 2);
        rr = mix(1, rr, Math.sqrt(1 - h) - 0.1);
        const hh = mix(h, 1, (l + h) / 5);
        let base = l * rr * Math.sqrt(Math.max(0, hh));
        base *= base;
        base = 0.087 + base * (1 - 0.087);
        const ox = x + c * ax.x + r * ay.x;
        const oy = y + c * ax.y + r * ay.y - g * up;
        // three visible faces
        face(ctx, [[ox, oy], [ox + ax.x, oy + ax.y], [ox + ax.x + ay.x, oy + ax.y + ay.y], [ox + ay.x, oy + ay.y]], shade(base, faces.top, tint));
        face(ctx, [[ox + ax.x, oy + ax.y], [ox + ax.x + ay.x, oy + ax.y + ay.y], [ox + ax.x + ay.x, oy + ax.y + ay.y + up], [ox + ax.x, oy + ax.y + up]], shade(base, faces.right, tint));
        face(ctx, [[ox + ay.x, oy + ay.y], [ox + ax.x + ay.x, oy + ax.y + ay.y], [ox + ax.x + ay.x, oy + ax.y + ay.y + up], [ox + ay.x, oy + ay.y + up]], shade(base, faces.front, tint));
      }
    }
  }
}

function face(ctx: CanvasRenderingContext2D, pts: [number, number][], color: string): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function shade(base: number, diff: number, tint: [number, number, number]): string {
  const k = base * Math.sqrt(0.5 + diff * 0.5);
  return `rgb(${Math.round(tint[0] * k)},${Math.round(tint[1] * k)},${Math.round(tint[2] * k)})`;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function norm3(x: number, y: number, z: number): [number, number, number] { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
function dot3(a: [number, number, number], b: [number, number, number]): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
