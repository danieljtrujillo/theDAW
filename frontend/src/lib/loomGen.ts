/**
 * loomGen — LOOM's generator tiles: a cell that is not a shard but a RULE
 * that yields shards (docs/design/loom.md §9, v2).
 *
 * A generator sits on the rail and owns `span` cells; for every (offset, lap)
 * it answers "what plays here" from its alphabet of shard queries, plus any
 * modulation (gain, transpose, a time warp) the rule implies. Placed in an
 * upper row it yields no shard and only modulates the column below it, like a
 * lock that changes shape as the lap counter runs.
 *
 * Every generator is a pure function of (tile, offset, lap, seed, form), so
 * the plane can draw what a lap WILL play and the engine and the view always
 * agree. Nothing here touches audio or the clock.
 *
 *   fib(k s):16                Fibonacci word over two symbols, drifting one
 *                              step per lap
 *   fractal(k . s; kind=thue)  Thue–Morse / Cantor dust / dragon curve /
 *                              Sierpinski (the lap is the triangle row)
 *   euclid(k; hits=5):16       Bjorklund's Euclidean rhythm, rotated per lap
 *   life(k s h; density=.35)   Conway's Life: rows are the alphabet, one
 *                              generation per lap; `form AABA` on the score
 *                              makes repeated sections replay a generation
 *   rand(k s . .; p=.8):16     seeded random pick per cell per lap
 *   frag(k s; size=1):16       one-beat fragments, re-shuffled and
 *                              re-resolved every lap
 *   echo(v; every=3 decay=6)   a shard and its decaying repeats (recursion)
 *   accel(k; from=1 to=2)      accelerando: the lane's step time warps across
 *                              the span (from>to = ritardando)
 *   gliss(v; from=-12 to=12)   glissando: transpose sweeps across the span
 */
import type { LoomQuery } from './loomScore';

export const GEN_KINDS = ['fib', 'fractal', 'euclid', 'life', 'rand', 'frag', 'echo', 'accel', 'gliss'] as const;
export type GenKind = typeof GEN_KINDS[number];

export type GenOpts = Record<string, number | string>;

export interface GenTile {
  kind: 'gen';
  gen: GenKind;
  /** Shard queries the rule chooses from; `null` is a rest symbol (`.`). */
  alphabet: (LoomQuery | null)[];
  /** Cells owned on the rail (like a shard's `steps`). */
  span: number;
  opts: GenOpts;
  /** Re-resolve the alphabet every N laps (`^`), like a shard tile. */
  roll: number;
}

/** What one cell of a generator plays and does. */
export interface GenCell {
  query: LoomQuery | null;
  /** dB added to the lane's effective gain for this cell. */
  gain?: number;
  /** Semitones added to the lane's effective transpose for this cell. */
  transpose?: number;
  /** Multiplies the step's duration (0.5 = twice as fast). */
  warp?: number;
  /** Ask the engine to resolve this cell's query fresh for this lap. */
  fresh?: boolean;
  /** Steps this cell holds (the following cells are silent continuations). */
  steps?: number;
}

export const GEN_DEFAULT_OPTS: Record<GenKind, GenOpts> = {
  fib: { drift: 1 },
  fractal: { kind: 'thue', drift: 0, depth: 4 },
  euclid: { hits: 5, rotate: 1 },
  life: { density: 0.35, rule: 'B3/S23', rows: 0 },
  rand: { p: 0.75 },
  frag: { size: 1 },
  echo: { every: 3, decay: 6, depth: 3 },
  accel: { from: 1, to: 2, curve: 1 },
  gliss: { from: -12, to: 12, curve: 1 },
};

export const GEN_GLYPH: Record<GenKind, string> = {
  fib: 'φ', fractal: '∆', euclid: 'E', life: '⚘', rand: '⚄', frag: '⁂', echo: '∞', accel: '↗', gliss: '≈',
};

export const GEN_BLURB: Record<GenKind, string> = {
  fib: 'Fibonacci word over the first two symbols; drifts one step per lap.',
  fractal: 'Self-similar sequence: thue (Thue–Morse), cantor (dust), dragon (curve turns), sierpinski (lap = triangle row).',
  euclid: 'Euclidean rhythm: hits spread as evenly as possible across the span, rotated per lap.',
  life: "Conway's Game of Life: rows are the alphabet, one generation per lap. `form AABA` replays sections.",
  rand: 'Seeded random pick per cell per lap; p = chance a cell plays.',
  frag: 'One-beat fragments of the alphabet, shuffled and re-resolved every lap.',
  echo: 'A shard and its decaying repeats every N cells (recursion).',
  accel: 'Accelerando / ritardando: step time warps from × from to × to across the span.',
  gliss: 'Glissando: transpose sweeps from → to semitones across the span.',
};

/* ── seeded randomness ─────────────────────────────────────────────────── */

/** 32-bit integer hash of a few ints (Bob Jenkins' one-at-a-time). */
export function hashInts(...xs: number[]): number {
  let h = 0x9e3779b9 >>> 0;
  for (const x of xs) {
    let v = Math.floor(x) >>> 0;
    for (let b = 0; b < 4; b += 1) {
      h = (h + (v & 0xff)) >>> 0;
      h = (h + (h << 10)) >>> 0;
      h ^= h >>> 6;
      v >>>= 8;
    }
  }
  h = (h + (h << 3)) >>> 0;
  h ^= h >>> 11;
  h = (h + (h << 15)) >>> 0;
  return h >>> 0;
}

/** Uniform [0, 1) from a hash — reproducible per (seed, lane, step, lap). */
export function unit(...xs: number[]): number {
  return hashInts(...xs) / 4294967296;
}

/** A small stateful PRNG for sequences (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const num = (o: GenOpts, k: string, d: number): number => {
  const v = o[k];
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (o: GenOpts, k: string, d: string): string => {
  const v = o[k];
  return v === undefined || v === '' ? d : String(v);
};

/** Fold a stable string out of a tile for memo keys. */
function tileKey(t: GenTile, seed: number): string {
  return `${seed}|${t.gen}|${t.span}|${JSON.stringify(t.opts)}|${JSON.stringify(t.alphabet)}`;
}

/* ── song form ─────────────────────────────────────────────────────────── */

/** `form AABA`: which letter a lap is in. */
export function sectionOf(form: string | undefined, lap: number): string | null {
  const f = (form ?? '').replace(/[^A-Za-z]/g, '');
  if (!f) return null;
  return f[lap % f.length];
}

/** The generation index a lap plays under a form: repeated letters inside a
 *  cycle replay the generation of their first appearance, so an A section
 *  sounds like an A section; across cycles everything keeps evolving. */
export function generationOf(form: string | undefined, lap: number): number {
  const f = (form ?? '').replace(/[^A-Za-z]/g, '');
  if (!f) return lap;
  const cycle = Math.floor(lap / f.length);
  const letter = f[lap % f.length];
  return cycle * f.length + f.indexOf(letter);
}

/* ── the rules ─────────────────────────────────────────────────────────── */

const popcount = (n: number): number => {
  let c = 0;
  let v = n >>> 0;
  while (v) { c += v & 1; v >>>= 1; }
  return c;
};

/** Fibonacci word: S0 = a, S1 = ab, Sn = Sn-1 Sn-2; symbol at index i. */
function fibWord(i: number): 0 | 1 {
  // Zeckendorf: the i-th symbol is b iff the least significant Fibonacci digit
  // of i+1 is at F(2); equivalently floor((i+2)/φ) - floor((i+1)/φ) == 0 → b.
  const phi = (1 + Math.sqrt(5)) / 2;
  const a = Math.floor((i + 2) / phi) - Math.floor((i + 1) / phi);
  return a === 1 ? 0 : 1;
}

function fibNumber(n: number): number {
  let a = 0;
  let b = 1;
  for (let k = 0; k < n; k += 1) { const t = a + b; a = b; b = t; }
  return a;
}

/** Bjorklund / Euclidean rhythm as a boolean pattern of `steps` with `hits`. */
export function euclidPattern(hits: number, steps: number, rotate = 0): boolean[] {
  const n = Math.max(1, Math.floor(steps));
  const k = Math.max(0, Math.min(n, Math.floor(hits)));
  const out: boolean[] = new Array(n).fill(false);
  if (k === 0) return out;
  // Bresenham form: step i is a hit when (i·k mod n) < k. Step 0 always hits,
  // and E(3,8) comes out as the tresillo x..x..x. (Toussaint's rotation).
  for (let i = 0; i < n; i += 1) out[i] = ((i * k) % n) < k;
  const r = ((rotate % n) + n) % n;
  return out.map((_, i) => out[(i + r) % n]);
}

function dragonTurn(i: number): 0 | 1 {
  // Turn i (1-based) of the dragon curve: left iff ((i & -i) << 1) & i == 0.
  const n = i + 1;
  return (((n & -n) << 1) & n) === 0 ? 0 : 1;
}

function cantorAlive(i: number, depth: number): boolean {
  let v = i;
  for (let d = 0; d < depth && v > 0; d += 1) {
    if (v % 3 === 1) return false;
    v = Math.floor(v / 3);
  }
  return true;
}

/* Life ------------------------------------------------------------------ */

interface LifeRule { born: Set<number>; survive: Set<number> }

function parseRule(s: string): LifeRule {
  const m = /^B(\d*)\/S(\d*)$/i.exec(s.trim()) ?? /^B(\d*)S(\d*)$/i.exec(s.trim());
  const born = new Set((m?.[1] ?? '3').split('').map(Number));
  const survive = new Set((m?.[2] ?? '23').split('').map(Number));
  return { born, survive };
}

const lifeMemo = new Map<string, boolean[][][]>();

/** Generations of a Life grid (rows × width), toroidal, seeded by density. */
function lifeGenerations(t: GenTile, seed: number, upTo: number): boolean[][][] {
  const key = tileKey(t, seed);
  let gens = lifeMemo.get(key);
  const width = Math.max(1, t.span);
  const rows = Math.max(3, Math.min(16, Math.round(num(t.opts, 'rows', 0)) || Math.max(3, t.alphabet.length)));
  if (!gens) {
    const density = Math.max(0, Math.min(1, num(t.opts, 'density', 0.35)));
    const g0: boolean[][] = [];
    for (let r = 0; r < rows; r += 1) {
      const row: boolean[] = [];
      for (let c = 0; c < width; c += 1) row.push(unit(seed, 7, r, c) < density);
      g0.push(row);
    }
    gens = [g0];
    if (lifeMemo.size > 64) lifeMemo.clear();
    lifeMemo.set(key, gens);
  }
  const rule = parseRule(str(t.opts, 'rule', 'B3/S23'));
  while (gens.length <= upTo) {
    const prev = gens[gens.length - 1];
    const next: boolean[][] = prev.map((row, r) => row.map((alive, c) => {
      let n = 0;
      for (let dr = -1; dr <= 1; dr += 1) for (let dc = -1; dc <= 1; dc += 1) {
        if (!dr && !dc) continue;
        if (prev[(r + dr + rows) % rows][(c + dc + width) % width]) n += 1;
      }
      return alive ? rule.survive.has(n) : rule.born.has(n);
    }));
    // A dead or frozen world gets a spark so the lane never falls silent for
    // the rest of the set: reseed one cell from the lap's hash.
    const pop = next.reduce((a, row) => a + row.filter(Boolean).length, 0);
    if (pop === 0 || next.every((row, r) => row.every((v, c) => v === prev[r][c]))) {
      const g = gens.length;
      for (let k = 0; k < 3; k += 1) {
        next[Math.floor(unit(seed, 11, g, k) * rows)][Math.floor(unit(seed, 13, g, k) * width)] = true;
      }
    }
    gens.push(next);
  }
  return gens;
}

/** The grid of a Life generator's generation (rows × span), for the canvas. */
export function lifeGrid(t: GenTile, seed: number, generation: number): boolean[][] {
  return lifeGenerations(t, seed, generation)[generation];
}

/** Population of a Life generator's generation, for the plane's badge. */
export function lifePopulation(t: GenTile, seed: number, generation: number): number {
  const g = lifeGenerations(t, seed, generation)[generation];
  return g.reduce((a, row) => a + row.filter(Boolean).length, 0);
}

/* ── the cell function ─────────────────────────────────────────────────── */

const lerp = (a: number, b: number, x: number) => a + (b - a) * x;
const curved = (x: number, curve: number) => Math.pow(Math.max(0, Math.min(1, x)), Math.max(0.1, curve));

/**
 * What cell `offset` (0 ≤ offset < span) of generator `t` does on `lap`.
 * `laneIdx` and `col` only feed the hash so two identical generators in
 * different places roll different dice.
 */
export function genCell(t: GenTile, offset: number, lap: number, seed: number, form?: string, laneIdx = 0, col = 0): GenCell | null {
  const n = t.alphabet.length;
  const span = Math.max(1, t.span);
  const sym = (k: number): LoomQuery | null => (n === 0 ? null : t.alphabet[((k % n) + n) % n]);
  const frac = span > 1 ? offset / (span - 1) : 0;
  const o = t.opts;
  switch (t.gen) {
    case 'fib': {
      const drift = num(o, 'drift', 1);
      const i = offset + Math.round(drift * lap);
      if (n <= 2) return { query: sym(fibWord(i)) };
      return { query: sym(fibNumber((i % 24) + 1)) };
    }
    case 'fractal': {
      const kind = str(o, 'kind', 'thue');
      const drift = num(o, 'drift', 0);
      const depth = Math.max(1, Math.round(num(o, 'depth', 4)));
      const i = offset + Math.round(drift * lap);
      if (kind === 'cantor') return cantorAlive(i, depth) ? { query: sym(0) } : { query: null };
      if (kind === 'dragon') return { query: sym(dragonTurn(i)) };
      if (kind === 'sierpinski') {
        const alive = (i & generationOf(form, lap)) === i || ((generationOf(form, lap) & i) === i);
        return alive ? { query: sym(0) } : n > 1 ? { query: sym(1) } : { query: null };
      }
      // thue: parity of the population count (2 symbols), or count mod n.
      const c = popcount(i);
      return { query: sym(n <= 2 ? c & 1 : c) };
    }
    case 'euclid': {
      const hits = Math.round(num(o, 'hits', 5));
      const rotate = Math.round(num(o, 'rotate', 1)) * lap;
      const pat = euclidPattern(hits, span, rotate);
      if (!pat[offset]) return { query: null };
      let k = 0;
      for (let i = 0; i < offset; i += 1) if (pat[i]) k += 1;
      return { query: sym(k) };
    }
    case 'life': {
      const g = generationOf(form, lap);
      const grid = lifeGenerations(t, seed, g)[g];
      const c = offset % grid[0].length;
      for (let r = 0; r < grid.length; r += 1) {
        if (grid[r][c]) {
          // A crowded column plays louder: every extra live cell adds 1.5 dB.
          let extra = 0;
          for (let rr = r + 1; rr < grid.length; rr += 1) if (grid[rr][c]) extra += 1;
          return { query: sym(r), gain: Math.min(6, extra * 1.5) };
        }
      }
      return { query: null };
    }
    case 'rand': {
      const p = Math.max(0, Math.min(1, num(o, 'p', 0.75)));
      const u = unit(seed, 21, laneIdx, col, lap, offset);
      if (u >= p) return { query: null };
      const pick = Math.floor(unit(seed, 23, laneIdx, col, lap, offset) * Math.max(1, n));
      return { query: sym(pick), fresh: true };
    }
    case 'frag': {
      const size = Math.max(1, Math.round(num(o, 'size', 1)));
      // A seeded permutation of the alphabet per lap; each cell takes the next.
      const order = Array.from({ length: Math.max(1, n) }, (_, i) => i);
      const rng = mulberry32(hashInts(seed, 29, laneIdx, col, lap));
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const q = sym(order[offset % order.length]);
      return { query: q ? { ...q, beats: size } : null, fresh: true };
    }
    case 'echo': {
      const every = Math.max(1, Math.round(num(o, 'every', 3)));
      const decay = num(o, 'decay', 6);
      const depth = Math.max(0, Math.round(num(o, 'depth', 3)));
      const period = every * (depth + 1);
      const within = offset % period;
      if (within % every !== 0) return { query: null };
      const k = within / every;
      const which = Math.floor(offset / period) + lap;
      return { query: sym(which), gain: -k * decay };
    }
    case 'accel': {
      const from = Math.max(0.1, num(o, 'from', 1));
      const to = Math.max(0.1, num(o, 'to', 2));
      const speed = lerp(from, to, curved(frac, num(o, 'curve', 1)));
      return { query: sym(offset), warp: 1 / speed };
    }
    case 'gliss': {
      const from = num(o, 'from', -12);
      const to = num(o, 'to', 12);
      return { query: sym(offset), transpose: lerp(from, to, curved(frac, num(o, 'curve', 1))) };
    }
  }
}

/** Every alphabet query the generator can ever play (for pre-resolution). */
export function genAlphabet(t: GenTile): LoomQuery[] {
  const size = t.gen === 'frag' ? Math.max(1, Math.round(num(t.opts, 'size', 1))) : null;
  return t.alphabet.filter((q): q is LoomQuery => q !== null).map((q) => (size ? { ...q, beats: size } : q));
}

/** Option string for the notation, defaults omitted. */
export function serializeGenOpts(t: GenTile): string {
  const defaults = GEN_DEFAULT_OPTS[t.gen] ?? {};
  const parts: string[] = [];
  for (const [k, v] of Object.entries(t.opts)) {
    if (defaults[k] === v) continue;
    parts.push(`${k}=${typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : v}`);
  }
  return parts.join(' ');
}
