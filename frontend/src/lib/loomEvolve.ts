/**
 * loomEvolve — scores that grow and breed (docs/design/loom.md §9).
 *
 * Pure functions over the score model: `mutateScore` makes a handful of small,
 * musical edits (drop or add a rail cell from the lane's own vocabulary, nudge
 * a row, flip a gate, tweak a lock or a generator option, swap two cells);
 * `breedScores` crosses two scores lane by lane with a uniform crossover of
 * their rows. Both take a seeded PRNG so a generation is reproducible.
 *
 * A `form` on the parent (song structure by lap) is inherited untouched, and
 * lanes named in `keep` are never mutated, which is how "grow it, but keep
 * the drums" works from the GROW pane.
 */
import { GEN_DEFAULT_OPTS, mulberry32, type GenTile } from './loomGen';
import type { LoomLane, LoomQuery, LoomScore, LoomTile } from './loomScore';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const pick = <T,>(rng: () => number, xs: T[]): T => xs[Math.floor(rng() * xs.length)];

/** Shard queries already used on a lane — its vocabulary. */
function vocabulary(lane: LoomLane): LoomQuery[] {
  const out: LoomQuery[] = [];
  for (const row of lane.rows) for (const t of row) {
    if (t?.kind === 'shard') out.push(t.query);
    if (t?.kind === 'gen') for (const q of t.alphabet) if (q) out.push(q);
  }
  return out;
}

type Op = (lane: LoomLane, rng: () => number, score: LoomScore) => boolean;

const OPS: Op[] = [
  // Add a shard from the vocabulary into an empty rail cell.
  (lane, rng) => {
    const rail = lane.rows[lane.rows.length - 1];
    const vocab = vocabulary(lane);
    const empties = rail.map((t, i) => (t ? -1 : i)).filter((i) => i >= 0);
    if (!vocab.length || !empties.length) return false;
    rail[pick(rng, empties)] = { kind: 'shard', query: clone(pick(rng, vocab)), steps: 1, roll: 0 };
    return true;
  },
  // Drop a rail cell (never the last one on the lane).
  (lane, rng) => {
    const rail = lane.rows[lane.rows.length - 1];
    const filled = rail.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
    if (filled.length < 2) return false;
    rail[pick(rng, filled)] = null;
    return true;
  },
  // Nudge a row one step left or right (wrapping).
  (lane, rng) => {
    const row = pick(rng, lane.rows);
    if (!row.some(Boolean)) return false;
    if (rng() < 0.5) row.push(row.shift() ?? null); else row.unshift(row.pop() ?? null);
    return true;
  },
  // Swap two rail cells.
  (lane, rng) => {
    const rail = lane.rows[lane.rows.length - 1];
    if (rail.length < 2) return false;
    const a = Math.floor(rng() * rail.length);
    const b = Math.floor(rng() * rail.length);
    if (a === b) return false;
    [rail[a], rail[b]] = [rail[b], rail[a]];
    return true;
  },
  // Toggle a chance gate above a played cell.
  (lane, rng) => {
    const rail = lane.rows[lane.rows.length - 1];
    const filled = rail.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
    if (!filled.length) return false;
    const col = pick(rng, filled);
    if (lane.rows.length < 2) lane.rows.unshift(new Array(lane.length).fill(null));
    const upper = lane.rows[0];
    const cur = upper[col];
    upper[col] = cur?.kind === 'chance' ? null : { kind: 'chance', pct: 25 + Math.round(rng() * 50) };
    return true;
  },
  // Tweak a lock or a generator option by a small amount.
  (lane, rng) => {
    const tiles = lane.rows.flat().filter((t): t is LoomTile => t !== null && (t.kind === 'lock' || t.kind === 'gen'));
    if (!tiles.length) return false;
    const t = pick(rng, tiles);
    if (t.kind === 'lock') {
      const keys = Object.keys(t.params) as (keyof typeof t.params)[];
      if (!keys.length) return false;
      const k = pick(rng, keys);
      const v = t.params[k] ?? 0;
      t.params[k] = Math.round((v + (rng() - 0.5) * (k === 'gain' ? 6 : k === 'transpose' ? 4 : 0.2)) * 100) / 100;
      return true;
    }
    if (t.kind === 'gen') return tweakGen(t, rng);
    return false;
  },
  // Stretch or shrink a shard's length by one step.
  (lane, rng) => {
    const rail = lane.rows[lane.rows.length - 1];
    const shards = rail.filter((t): t is Extract<LoomTile, { kind: 'shard' }> => t?.kind === 'shard');
    if (!shards.length) return false;
    const t = pick(rng, shards);
    t.steps = Math.max(1, Math.min(lane.length, t.steps + (rng() < 0.5 ? -1 : 1)));
    return true;
  },
];

function tweakGen(t: GenTile, rng: () => number): boolean {
  const numeric = Object.entries({ ...GEN_DEFAULT_OPTS[t.gen], ...t.opts }).filter(([, v]) => typeof v === 'number') as [string, number][];
  if (!numeric.length) return false;
  const [k, v] = pick(rng, numeric);
  const scale = Math.abs(v) < 1 ? 0.15 : Math.max(1, Math.abs(v) * 0.25);
  let next = v + (rng() - 0.5) * 2 * scale;
  if (k === 'hits' || k === 'every' || k === 'depth' || k === 'rotate' || k === 'size' || k === 'rows') next = Math.max(k === 'rotate' ? -8 : 0, Math.round(next));
  if (k === 'density' || k === 'p') next = Math.max(0.05, Math.min(0.95, next));
  t.opts[k] = Math.round(next * 1000) / 1000;
  return true;
}

export interface EvolveOpts {
  /** 1 = a couple of edits, 5 = a different tune. */
  intensity?: number;
  /** Lane names left untouched. */
  keep?: string[];
}

/** A mutated copy of the score. */
export function mutateScore(score: LoomScore, seed: number, opts: EvolveOpts = {}): LoomScore {
  const rng = mulberry32(seed);
  const next = clone(score);
  const keep = new Set(opts.keep ?? []);
  const lanes = next.lanes.filter((l) => !keep.has(l.name) && !l.isTarget);
  if (!lanes.length) return next;
  const edits = Math.max(1, Math.round((opts.intensity ?? 2) * 1.5));
  let done = 0;
  let tries = 0;
  while (done < edits && tries < edits * 8) {
    tries += 1;
    const lane = pick(rng, lanes);
    const op = pick(rng, OPS);
    if (op(lane, rng, next)) done += 1;
  }
  next.seed = (score.seed ?? 0) + 1;
  return next;
}

/** A child of two scores: lanes by name, rows crossed over at random points. */
export function breedScores(a: LoomScore, b: LoomScore, seed: number, opts: EvolveOpts = {}): LoomScore {
  const rng = mulberry32(seed);
  const child = clone(a);
  const keep = new Set(opts.keep ?? []);
  for (const lane of child.lanes) {
    if (keep.has(lane.name)) continue;
    const other = b.lanes.find((l) => l.name === lane.name) ?? b.lanes.find((l) => l.div === lane.div && l.length === lane.length && !l.isTarget);
    if (!other) continue;
    const rows = Math.max(lane.rows.length, other.rows.length);
    // Align rails: both lanes' last rows are rails.
    const mine = [...new Array(rows - lane.rows.length).fill(null).map(() => new Array(lane.length).fill(null)), ...lane.rows];
    const theirs = [...new Array(rows - other.rows.length).fill(null).map(() => new Array(other.length).fill(null)), ...other.rows];
    lane.rows = mine.map((row, r) => {
      const cut = Math.floor(rng() * lane.length);
      const flip = rng() < 0.5;
      return row.map((t, col) => {
        const fromOther = flip ? col >= cut : col < cut;
        const src = fromOther ? theirs[r]?.[col % other.length] ?? null : t;
        return src ? clone(src) : null;
      });
    });
    // Jumps into lanes the child does not have are dropped.
    const names = new Set(child.lanes.map((l) => l.name));
    lane.rows = lane.rows.map((row) => row.map((t) => (t?.kind === 'jump' && !names.has(t.target) ? null : t)));
  }
  // Lanes only the partner has come along with a coin flip.
  for (const other of b.lanes) {
    if (!child.lanes.some((l) => l.name === other.name) && rng() < 0.5) child.lanes.push(clone(other));
  }
  child.seed = ((a.seed ?? 0) ^ (b.seed ?? 0)) + 1;
  return child;
}

/** Turn every rail shard into a one-beat fragment generator over the lane's vocabulary. */
export function fragmentScore(score: LoomScore, size = 1): LoomScore {
  const next = clone(score);
  for (const lane of next.lanes) {
    const rail = lane.rows[lane.rows.length - 1];
    const vocab = vocabulary(lane);
    if (!vocab.length) continue;
    const alphabet = vocab.slice(0, 6).map(clone);
    const gen: GenTile = { kind: 'gen', gen: 'frag', alphabet, span: lane.length, opts: { ...GEN_DEFAULT_OPTS.frag, size }, roll: 0 };
    lane.rows[lane.rows.length - 1] = rail.map((_, i) => (i === 0 ? gen : null));
  }
  return next;
}
