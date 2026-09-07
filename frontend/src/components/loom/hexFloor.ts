/**
 * hexFloor — a hexagon lattice under the dish that crystallizes outward from
 * whatever fires.
 *
 * Ported from Grant Skinner's "CreateJS: HEX GRID #4"
 * (https://codepen.io/createjs/pen/qVojKK, https://lab.gskinner.com/hex_grid/):
 * `buildGrid` with its six-neighbour indexing, `trigger` — the organic
 * branching propagation where a hex hands its front to one or two neighbours
 * with a turn bias and a decaying chance — the `destination-in` fade and the
 * `lighter` composite, and `drawHex`'s two randomised strokes. His random
 * seeds along the top edge are replaced by `ignite(x, y, hue)`, which the
 * colony calls from a cell that fired, and the fill colours come from the
 * cell that lit the front.
 *
 * One number is changed from the pen, and it is the whole difference between a
 * strobe and a crystal: the pen schedules a neighbour with `neighbor.t = t`,
 * i.e. due immediately, so the front advances one hex ring per FRAME — about
 * 1800 px/s, crossing the dish in a third of a second. Here a ring waits
 * RING_MS before it lights, so the front creeps outward at ~25 px/s and takes
 * half a minute to cross. The branching factor is left exactly as his (~1.39,
 * barely above one) because that is what makes it dendritic instead of a
 * flood, and the arm decay is his 0.999 so an arm stays alive long enough for
 * that slow creep to be worth watching.
 */

interface Hex {
  col: number; row: number; x: number; y: number;
  tol: number; pot: number;
  color: string;
  neighbors: (Hex | null)[];
  clean: boolean;
  t: number; val: number; from: number; hue: number; lm: number; chance: number;
}

const rnd = (a: number, b?: number): number => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));
const rndInt = (n: number): number => Math.floor(Math.random() * n);
const rndBool = (chance: number): boolean => Math.random() < chance;
const rndBit = (p: number): number => (Math.random() < p ? 1 : 0);
const rndSign = (): number => (Math.random() < 0.5 ? -1 : 1);
const hsl = (h: number, s: number, l: number, a = 1): string => `hsla(${h},${s}%,${l}%,${a})`;

/** Milliseconds a ring waits before it lights the next — the creep. */
const RING_MS = 900;
/** Spread on that wait, so a front has organic timing rather than a pulse. */
const RING_JITTER_MS = 700;

export class HexFloor {
  private grid: Hex[] = [];
  private rows = 0;
  private cols = 0;
  private radius = 12;
  private watchList: Hex[] = [];
  private fadeT = 0;
  private w = 0;
  private h = 0;
  private hueBase = 200;

  build(w: number, h: number): void {
    this.w = w; this.h = h;
    this.radius = Math.max(9, h / 80);
    this.grid = this.buildGrid(w, h, this.radius);
    this.watchList = [];
  }

  get size(): { w: number; h: number } { return { w: this.w, h: this.h }; }

  private buildGrid(w: number, h: number, r: number): Hex[] {
    const rowh = r * Math.sin(Math.PI / 3);
    const colW = r * 2 * 1.5;
    this.rows = Math.ceil(h / rowh) + 1;
    this.cols = Math.ceil(w / colW) + 1;
    const grid: Hex[] = [];
    for (let row = 0; row < this.rows; row += 1) {
      const y = row * rowh;
      for (let col = 0; col < this.cols; col += 1) {
        const x = col * colW + (row % 2) * colW / 2;
        grid.push({
          col, row, x, y, tol: 1 + rnd(2), pot: 0,
          color: hsl(rnd(198, 204), 20, rnd(75, 80), rnd(0.01, 0.03)),
          neighbors: [], clean: true, t: 0, val: 0, from: 3, hue: this.hueBase, lm: 0.7, chance: 1.2,
        });
      }
    }
    // neighbors:
    const cols = this.cols;
    for (let i = 0, l = grid.length; i < l; i += 1) {
      const hex = grid[i];
      const off = hex.row % 2;
      const col = hex.col;
      hex.neighbors = [
        grid[i - cols * 2] ?? null,
        col + off < cols ? grid[i - cols + off] ?? null : null,
        col + off < cols ? grid[i + cols + off] ?? null : null,
        grid[i + cols * 2] ?? null,
        col + off > 0 ? grid[i + cols - 1 + off] ?? null : null,
        col + off > 0 ? grid[i - cols - 1 + off] ?? null : null,
      ];
    }
    return grid;
  }

  /** Light a crystallization front at a point, in a hue. */
  ignite(x: number, y: number, hue: number, strength = 1): void {
    if (!this.grid.length) return;
    let best: Hex | null = null;
    let bestD = Infinity;
    for (const hex of this.grid) {
      const d = (hex.x - x) * (hex.x - x) + (hex.y - y) * (hex.y - y);
      if (d < bestD) { bestD = d; best = hex; }
    }
    if (!best) return;
    best.t = Date.now() + rnd(20, 80);
    best.from = rndInt(6);
    best.hue = hue;
    best.lm = 0.7;
    best.chance = Math.min(1.2, 1.2 * strength);
    this.watchList.push(best);
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const grid = this.grid;
    for (let i = 0, l = grid.length; i < l; i += 1) {
      const hex = grid[i];
      if (!hex.clean) {
        const m = rnd(0.6, 1);
        this.drawHex(ctx, hex.x, hex.y, hex.color, m, rnd(1, this.radius / 6));
        this.drawHex(ctx, hex.x, hex.y, hex.color, rnd(0.2, m - 0.1), rnd(1, this.radius / 4));
        hex.clean = true;
      }
    }
  }

  /** One tick: propagate due fronts, fade the layer, draw the dirty hexes. */
  tick(ctx: CanvasRenderingContext2D): void {
    const t = Date.now();
    for (let i = this.watchList.length - 1; i >= 0; i -= 1) {
      const hex = this.watchList[i];
      if (!hex) break;
      if (hex.t < t) {
        this.removeFromWatch(hex);
        this.trigger(hex, t);
      }
    }
    if (this.fadeT < t) {
      // A gentler bite more often: the pen's 5%-per-250 ms visibly steps the
      // whole floor's brightness four times a second.
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = hsl(0, 0, 100, 0.988);
      ctx.fillRect(0, 0, this.w, this.h);
      this.fadeT = t + 90;
    }
    ctx.globalCompositeOperation = 'lighter';
    this.drawGrid(ctx);
    ctx.globalCompositeOperation = 'source-over';
  }

  private trigger(hex: Hex, t: number): void {
    // The pen re-blooms a lit hex every 0.4–0.9 s, which reads as glitter at
    // this density; a 3–7 s breath reads as a body.
    hex.val = rnd(3000, 7000);
    hex.t = t + hex.val;
    hex.clean = false;
    let chance = hex.chance;
    while (rndBool(chance)) {
      const turn = rndBit(0.5) * rndSign();
      const dir = (hex.from + 3 + turn + 6) % 6;
      const neighbor = hex.neighbors[dir];
      chance *= 0.25;
      if (!neighbor || neighbor.t >= t) continue;
      // The pen fires the neighbour on the next tick (`t`), which is what makes
      // its front a lightning strike. A real, jittered wait turns the same
      // branching process into something that creeps.
      neighbor.val = rnd(0, 1) * rnd(0, 1) * 900 + 200;
      neighbor.t = t + RING_MS + rnd(0, RING_JITTER_MS);
      neighbor.from = (dir + 3) % 6;
      neighbor.chance = hex.chance * 0.999;
      neighbor.hue = hex.hue;
      neighbor.color = hsl(neighbor.hue, 50, rnd(20, 35));
      neighbor.lm = hex.lm;
      this.watchList.push(neighbor);
    }
  }

  private removeFromWatch(hex: Hex): void {
    for (let i = this.watchList.length - 1; i >= 0; i -= 1) {
      if (hex === this.watchList[i]) this.watchList.splice(i, 1);
    }
  }

  private drawHex(ctx: CanvasRenderingContext2D, x: number, y: number, fill: string, m: number, s: number): void {
    let r = this.radius - 1 - s / 2;
    r *= m || 1;
    r = Math.ceil(r);
    ctx.beginPath();
    const p = (Math.PI / 6) * 2;
    for (let i = 0; i < 6; i += 1) {
      const x1 = x + Math.cos(p * i) * r;
      const y1 = y + Math.sin(p * i) * r;
      if (i === 0) ctx.moveTo(x1, y1); else ctx.lineTo(x1, y1);
    }
    ctx.closePath();
    ctx.strokeStyle = fill;
    ctx.lineWidth = s || 1;
    ctx.stroke();
  }
}
