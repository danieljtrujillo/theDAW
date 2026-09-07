/**
 * colonyGrow — a colony that is alive: it divides, envelops, withers and
 * mutates on every root bar, the way a Life grid steps a generation
 * (docs/design/loom.md §11).
 *
 * The score is the organism. On each lap the growth step looks at every cell's
 * NEIGHBOURS (its wires) and its ACTIVITY (when it last fired) and applies
 * Life-shaped rules — and nothing pops:
 *
 *   division  an active cell with 1–3 neighbours may bud a child and wire it
 *             in. The child is born at the parent's position with zero
 *             vitality; it ripens over a few bars (the engine fades it in, the
 *             canvas grows it). A rule buds loops (through a gate or a mod now
 *             and then); a loop buds the loop that plays after it, a repeat
 *             wire on itself, a new pacemaker feeding it, or a mod spliced in
 *             front of it. Births slow as the population nears `max`.
 *   envelop   now and then a colony forms AROUND a loop that is already
 *             there: the loop moves inside a new membrane with its own meter
 *             and a pacemaker of its own; what pointed at the loop now starts
 *             the colony's bar, and what the loop pointed at now fires when
 *             the colony's bar ends.
 *   wither    an orphan (no wires) or a loop silent for eight laps is marked
 *             dying; it fades for two bars and is only then removed. A cell
 *             with five or more wires sheds one. The root's last loop never
 *             withers.
 *   mutation  a rule's hits or density move a notch, a gate's odds shift, a
 *             loop's length, pan, glide or motion drifts.
 *
 * What a bud plays follows the score's GRAIN (beats per shard): drums and bass
 * take the grain, percussion a quarter of it, drones (other, piano, guitar)
 * twice it with `hold` and a portamento glide, so a colony at grain 8 moves
 * in two-bar breaths rather than sixteenth notes.
 *
 * Everything is a pure function of (score, lap, activity, seed): a colony with
 * a seed grows the same way twice. Nothing here touches audio.
 */
import { GEN_DEFAULT_OPTS, unit } from './loomGen';
import { LOOP_DEFAULTS, nodeKey, uniqueId, type ColonyGraph, type ColonyNode, type ColonyScore, type GateNode, type LoopNode, type Meter, type ModNode, type RuleNode } from './colony';
import type { LoomQuery, LoomRole } from './loomScore';

export interface Activity {
  /** Root lap a node (by path key) last fired on. */
  fires: Record<string, number>;
  /** Root lap a node (by path key) was born on. */
  born: Record<string, number>;
  /** Root lap a withering node will be removed on. */
  dying: Record<string, number>;
}

export interface Birth { key: string; parent: string | null }
export interface Move { from: string; to: string }

export interface GrowResult {
  score: ColonyScore;
  born: Birth[];
  /** Cells removed this step (they withered first). */
  died: string[];
  /** Cells that started withering this step. */
  withering: string[];
  /** Cells whose path changed (enveloped by a new colony). */
  moved: Move[];
  /** Keys of cells whose settings moved. */
  changed: string[];
}

export interface GrowOpts {
  /** Bud from this cell now, whatever the dice say (the BUD button). */
  force?: string;
  /** Override the score's rate (0–1). */
  rate?: number;
  /** Override the score's population cap. */
  max?: number;
}

/** Bars a newborn takes to ripen, and a dying cell to wither. */
export const RIPEN_LAPS = 3;
export const WITHER_LAPS = 2;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Which roles a role likes to grow next to. Drones (other, piano, guitar) are welcome everywhere. */
const ROLE_NEXT: Record<string, LoomRole[]> = {
  kick: ['snare', 'hihat', 'bass', 'other'],
  snare: ['hihat', 'kick', 'toms', 'piano'],
  hihat: ['snare', 'cymbals', 'kick', 'other'],
  cymbals: ['hihat', 'toms', 'guitar'],
  toms: ['kick', 'cymbals', 'snare'],
  drums: ['bass', 'other', 'vocals', 'piano', 'hihat'],
  bass: ['other', 'vocals', 'piano', 'drums', 'guitar'],
  vocals: ['other', 'bass', 'piano', 'guitar'],
  guitar: ['bass', 'vocals', 'other', 'piano'],
  piano: ['bass', 'vocals', 'other', 'guitar'],
  other: ['vocals', 'bass', 'guitar', 'piano', 'drums'],
  mix: ['drums', 'bass', 'other', 'vocals'],
};
const PERCUSSIVE = new Set(['kick', 'snare', 'hihat', 'cymbals', 'toms']);
const DRONE = new Set(['other', 'piano', 'guitar']);
const METERS: Meter[] = [
  { num: 7, den: 8, groups: [3, 2, 2] },
  { num: 5, den: 4, groups: [3, 2] },
  { num: 11, den: 8, groups: [3, 3, 3, 2] },
  { num: 6, den: 8, groups: [3, 3] },
  { num: 3, den: 4, groups: [] },
  { num: 9, den: 8, groups: [2, 2, 2, 3] },
];
const METER_NAMES = ['seven', 'five', 'eleven', 'six', 'three', 'nine'];

function hashKey(s: string): number {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

function degree(g: ColonyGraph, id: string): number {
  let d = 0;
  for (const e of g.edges) { if (e.from === id) d += 1; if (e.to === id) d += 1; }
  return d;
}

const snapBeats = (b: number): number | undefined => ([1, 4, 8, 16].includes(b) ? b : undefined);

/** A loop for a role at the colony's grain: drones long and gliding, percussion short. */
function loopFor(g: ColonyGraph, role: LoomRole, r: () => number, grain: number): LoopNode {
  let beats: number;
  let hold = false;
  let glide = 0;
  let energyMax: number | undefined;
  let energyMin: number | undefined;
  if (PERCUSSIVE.has(role)) { beats = Math.max(1, grain / 4); energyMin = 0.35; }
  else if (role === 'drums') { beats = grain; hold = r() < 0.6; energyMin = 0.3; }
  else if (role === 'bass') { beats = grain; hold = grain >= 8 && r() < 0.5; glide = r() < 0.3 ? [-5, -7, 5][Math.floor(r() * 3)] : 0; }
  else if (role === 'vocals') { beats = Math.max(1, grain / 2); }
  else if (DRONE.has(role)) { beats = Math.min(16, grain * 2); hold = true; glide = r() < 0.7 ? [-2, -5, 3, 7, -7, 12, -12][Math.floor(r() * 7)] : 0; energyMax = 0.55; }
  else { beats = grain; }
  const query: LoomQuery = { role, beats: snapBeats(beats), energyMin, energyMax };
  return {
    kind: 'loop', id: uniqueId(g, role), query, beats, gain: role === 'hihat' || role === 'cymbals' ? -6 : DRONE.has(role) ? -4 : 0, transpose: 0,
    hold, ...LOOP_DEFAULTS, glide,
    pan: PERCUSSIVE.has(role) && role !== 'kick' ? Math.round((r() - 0.5) * 12) / 10 : DRONE.has(role) ? Math.round((r() - 0.5) * 8) / 10 : 0,
    space: DRONE.has(role) && r() < 0.5 ? 'orbit' : 'fixed',
  };
}

/** A pacemaker on the quarter grid (or eighths, half the time): slow enough to breathe. */
function ruleFor(g: ColonyGraph, meter: Meter, r: () => number): RuleNode {
  const pick = r();
  const quarters = meter.den >= 8 ? Math.max(2, Math.round(meter.num / 2)) : meter.num;
  const steps = r() < 0.5 ? quarters : quarters * 2;
  if (pick < 0.45) return { kind: 'rule', id: uniqueId(g, 'pulse'), gen: 'euclid', steps, symbols: 2, opts: { ...GEN_DEFAULT_OPTS.euclid, hits: Math.max(1, Math.round(steps * (0.25 + r() * 0.3))) } };
  if (pick < 0.7) return { kind: 'rule', id: uniqueId(g, 'swarm'), gen: 'life', steps: quarters * 2, symbols: 3, opts: { ...GEN_DEFAULT_OPTS.life, rows: 3, density: Math.round((0.18 + r() * 0.22) * 100) / 100 } };
  if (pick < 0.85) return { kind: 'rule', id: uniqueId(g, 'fib'), gen: 'fib', steps, symbols: 2, opts: { ...GEN_DEFAULT_OPTS.fib } };
  return { kind: 'rule', id: uniqueId(g, 'dice'), gen: 'rand', steps, symbols: 2, opts: { ...GEN_DEFAULT_OPTS.rand, p: Math.round((0.3 + r() * 0.3) * 100) / 100 } };
}

function gateFor(g: ColonyGraph, r: () => number): GateNode {
  if (r() < 0.7) return { kind: 'gate', id: uniqueId(g, 'maybe'), pct: 30 + Math.round(r() * 5) * 10 };
  const period = r() < 0.5 ? 2 : 4;
  return { kind: 'gate', id: uniqueId(g, 'every'), period, laps: [period === 2 ? 2 : 1 + Math.floor(r() * 4)] };
}

function modFor(g: ColonyGraph, r: () => number): ModNode {
  const pick = r();
  if (pick < 0.3) return { kind: 'mod', id: uniqueId(g, 'dark'), mode: 'abs', params: { cutoff: Math.round((0.2 + r() * 0.4) * 100) / 100 } };
  if (pick < 0.55) return { kind: 'mod', id: uniqueId(g, 'soft'), mode: 'rel', params: { gain: -(3 + Math.round(r() * 6)) } };
  if (pick < 0.8) return { kind: 'mod', id: uniqueId(g, 'lift'), mode: 'rel', params: { transpose: [12, 7, 5, -12, -5][Math.floor(r() * 5)] } };
  return { kind: 'mod', id: uniqueId(g, 'side'), mode: 'abs', params: { pan: Math.round((r() - 0.5) * 16) / 10 } };
}

function roleOf(n: ColonyNode): LoomRole | undefined {
  return n.kind === 'loop' ? n.query.role : undefined;
}

interface BudResult { kids: ColonyNode[]; moved: { id: string; into: string }[] }

/**
 * Envelop `loop` (a node of `g`) in a new colony: the loop moves inside with
 * a fresh pacemaker; wires that pointed at it now point at the colony.
 */
function envelop(g: ColonyGraph, loop: LoopNode, r: () => number): Extract<ColonyNode, { kind: 'colony' }> {
  const mi = Math.floor(r() * METERS.length);
  const meter = clone(METERS[mi]);
  const child: ColonyGraph = { meter, tempo: r() < 0.25 ? 0.5 : r() < 0.5 ? 1.5 : 1, nodes: [], edges: [] };
  g.nodes.splice(g.nodes.indexOf(loop), 1);
  const colId = uniqueId(g, METER_NAMES[mi] ?? 'cell');
  // In-wires start the colony; out-wires fire when its bar ends; a self wire comes along inside.
  const self = g.edges.some((e) => e.from === loop.id && e.to === loop.id);
  const kept = g.edges.filter((e) => !(e.from === loop.id && e.to === loop.id));
  for (const e of kept) { if (e.to === loop.id) e.to = colId; if (e.from === loop.id) e.from = colId; }
  g.edges = kept.filter((e, i, arr) => arr.findIndex((x) => x.from === e.from && x.to === e.to) === i);
  const rule = ruleFor(child, meter, r);
  child.nodes.push(rule, loop);
  child.edges.push({ from: rule.id, to: loop.id });
  if (self) child.edges.push({ from: loop.id, to: loop.id });
  const col: Extract<ColonyNode, { kind: 'colony' }> = { kind: 'colony', id: colId, graph: child };
  g.nodes.push(col);
  return col;
}

/** Bud one child off `parent` in `g`. */
function bud(g: ColonyGraph, parent: ColonyNode, r: () => number, grain: number): BudResult {
  const out: BudResult = { kids: [], moved: [] };
  const nextRole = () => { const next = ROLE_NEXT[roleOf(parent) ?? 'mix'] ?? ROLE_NEXT.mix; return next[Math.floor(r() * next.length)]; };
  const pick = r();
  if (parent.kind === 'rule') {
    if (pick < 0.55) {
      const loop = loopFor(g, nextRole(), r, grain);
      g.nodes.push(loop);
      g.edges.push({ from: parent.id, to: loop.id, on: parent.symbols > 1 && r() < 0.5 ? Math.floor(r() * parent.symbols) : undefined });
      out.kids.push(loop);
    } else if (pick < 0.75) {
      const gate = gateFor(g, r);
      const loop = loopFor(g, nextRole(), r, grain);
      g.nodes.push(gate, loop);
      g.edges.push({ from: parent.id, to: gate.id }, { from: gate.id, to: loop.id });
      out.kids.push(gate, loop);
    } else if (pick < 0.96) {
      const mod = modFor(g, r);
      const loop = loopFor(g, nextRole(), r, grain);
      g.nodes.push(mod, loop);
      g.edges.push({ from: parent.id, to: mod.id }, { from: mod.id, to: loop.id });
      out.kids.push(mod, loop);
    } else {
      // Envelop one of the loops this rule already drives — rare, and only
      // once the dish has enough cells that losing one does not empty it.
      const targets = g.nodes.length < 5 ? [] : g.edges.filter((e) => e.from === parent.id).map((e) => g.nodes.find((n) => n.id === e.to)).filter((n): n is LoopNode => n?.kind === 'loop');
      if (targets.length) {
        const loop = targets[Math.floor(r() * targets.length)];
        const col = envelop(g, loop, r);
        out.kids.push(col);
        out.moved.push({ id: loop.id, into: col.id });
      }
    }
    return out;
  }
  if (parent.kind === 'loop') {
    const hasSelf = g.edges.some((e) => e.from === parent.id && e.to === parent.id);
    if (pick < 0.35) {
      const loop = loopFor(g, nextRole(), r, grain);
      g.nodes.push(loop);
      g.edges.push({ from: parent.id, to: loop.id });
      out.kids.push(loop);
    } else if (pick < 0.5 && !hasSelf) {
      g.edges.push({ from: parent.id, to: parent.id });
    } else if (pick < 0.75) {
      const rule = ruleFor(g, g.meter, r);
      g.nodes.push(rule);
      g.edges.push({ from: rule.id, to: parent.id });
      out.kids.push(rule);
    } else if (pick < 0.96 || g.nodes.length < 4) {
      const into = g.edges.filter((e) => e.to === parent.id && e.from !== parent.id);
      const mod = modFor(g, r);
      g.nodes.push(mod);
      if (into.length) {
        const e = into[Math.floor(r() * into.length)];
        e.to = mod.id;
        g.edges.push({ from: mod.id, to: parent.id });
      } else {
        g.edges.push({ from: mod.id, to: parent.id });
      }
      out.kids.push(mod);
    } else {
      const col = envelop(g, parent, r);
      out.kids.push(col);
      out.moved.push({ id: parent.id, into: col.id });
    }
    return out;
  }
  // gate / mod / colony: a loop after it
  const loop = loopFor(g, nextRole(), r, grain);
  g.nodes.push(loop);
  g.edges.push({ from: parent.id, to: loop.id });
  out.kids.push(loop);
  return out;
}

function mutate(n: ColonyNode, r: () => number): boolean {
  if (n.kind === 'rule') {
    const o = n.opts;
    if (n.gen === 'euclid') { const hits = Math.max(1, Math.min(n.steps, Math.round(Number(o.hits ?? 5)) + (r() < 0.5 ? -1 : 1))); if (hits === o.hits) return false; o.hits = hits; return true; }
    if (n.gen === 'life') { o.density = Math.round(Math.max(0.1, Math.min(0.6, Number(o.density ?? 0.35) + (r() - 0.5) * 0.1)) * 100) / 100; return true; }
    if (n.gen === 'rand') { o.p = Math.round(Math.max(0.15, Math.min(0.8, Number(o.p ?? 0.75) + (r() - 0.5) * 0.2)) * 100) / 100; return true; }
    if (n.gen === 'fib') { o.drift = (Number(o.drift ?? 1) + 1) % 3; return true; }
    return false;
  }
  if (n.kind === 'gate') {
    if (n.pct != null) { n.pct = Math.max(10, Math.min(95, n.pct + (r() < 0.5 ? -10 : 10))); return true; }
    return false;
  }
  if (n.kind === 'loop') {
    const pick = r();
    if (pick < 0.3) { const ladder = [1, 2, 4, 8, 16]; const i = ladder.indexOf(n.beats); if (i < 0) return false; const j = Math.max(0, Math.min(ladder.length - 1, i + (r() < 0.5 ? -1 : 1))); if (j === i) return false; n.beats = ladder[j]; if (n.query.beats != null) n.query = { ...n.query, beats: snapBeats(n.beats) }; return true; }
    if (pick < 0.55) { n.pan = Math.round(Math.max(-1, Math.min(1, n.pan + (r() - 0.5) * 0.6)) * 10) / 10; return true; }
    if (pick < 0.7) { n.space = n.space === 'fixed' ? (r() < 0.5 ? 'orbit' : 'pingpong') : 'fixed'; return true; }
    if (pick < 0.85) { n.glide = [0, -2, -5, 3, 5, 7, -7][Math.floor(r() * 7)]; return true; }
    n.transpose = [0, 12, -12, 7, 5][Math.floor(r() * 5)];
    return true;
  }
  if (n.kind === 'mod') return false;
  const tempos = [0.5, 1, 1.5, 2];
  const i = tempos.indexOf(n.graph.tempo);
  n.graph.tempo = tempos[(Math.max(0, i) + 1) % tempos.length];
  return true;
}

function countNodes(g: ColonyGraph): number {
  let n = 0;
  for (const x of g.nodes) { n += 1; if (x.kind === 'colony') n += countNodes(x.graph); }
  return n;
}

/**
 * One generation of growth. `lap` is the root lap the step happens on;
 * `activity` says when cells last fired, when they were born, and which are
 * withering (with the lap they go).
 */
export function growColony(score: ColonyScore, lap: number, activity: Activity, opts: GrowOpts = {}): GrowResult {
  const next = clone(score);
  const rate = Math.max(0, Math.min(1, opts.rate ?? score.grow?.rate ?? 0));
  const max = Math.max(2, opts.max ?? score.grow?.max ?? 24);
  const seed = score.seed ?? 0x10c;
  const grain = score.grain ?? 4;
  const born: Birth[] = [];
  const died: string[] = [];
  const withering: string[] = [];
  const moved: Move[] = [];
  const changed: string[] = [];
  const dying = activity.dying ?? {};
  const state = { pop: countNodes(next.root), births: 0 };
  const dice = (path: string[], id: string, salt: number, k = 0) => unit(seed, 41, lap, hashKey(nodeKey(path, id)), salt, k);

  const step = (g: ColonyGraph, path: string[], isRoot: boolean) => {
    // A small stream per (graph, lap) for shape choices.
    let k = 0;
    const r = () => unit(seed, 43, lap, hashKey(path.join('/') || '@'), k++);

    /* wither ----------------------------------------------------------- */
    if (!opts.force && rate > 0) {
      const loops = g.nodes.filter((n) => n.kind === 'loop').length;
      for (const n of [...g.nodes]) {
        const key = nodeKey(path, n.id);
        const dieAt = dying[key];
        if (dieAt != null) {
          if (lap >= dieAt) {
            g.nodes.splice(g.nodes.indexOf(n), 1);
            g.edges = g.edges.filter((e) => e.from !== n.id && e.to !== n.id);
            died.push(key);
            state.pop -= n.kind === 'colony' ? 1 + countNodes(n.graph) : 1;
          }
          continue;
        }
        if (g.nodes.length <= 1) break;
        const age = lap - (activity.born[key] ?? -99);
        if (age < RIPEN_LAPS) continue; // the young get their bars to find a wire
        if (isRoot && n.kind === 'loop' && loops <= 1) continue;
        const d = degree(g, n.id);
        const idle = n.kind === 'loop' ? lap - (activity.fires[key] ?? activity.born[key] ?? lap) : 0;
        let p = 0;
        // A colony with cells inside runs free; it needs no wire to live.
        if (d === 0 && !(n.kind === 'colony' && n.graph.nodes.length > 0)) p = 0.7 * rate;
        else if (n.kind === 'loop' && idle >= 8) p = 0.35 * rate;
        if (p > 0 && dice(path, n.id, 1) < p) { withering.push(key); continue; }
        if (d >= 5 && dice(path, n.id, 2) < 0.4 * rate) {
          const mine = g.edges.filter((e) => e.from === n.id || e.to === n.id);
          const e = mine[Math.floor(dice(path, n.id, 3) * mine.length)];
          if (e) { g.edges.splice(g.edges.indexOf(e), 1); changed.push(key); }
        }
      }
    }

    /* division ----------------------------------------------------------- */
    const room = Math.max(0, 1 - state.pop / max);
    for (const n of [...g.nodes]) {
      if (!g.nodes.includes(n)) continue; // enveloped by an earlier bud this step
      const key = nodeKey(path, n.id);
      if (dying[key] != null) continue;
      const forced = opts.force === key;
      if (!forced) {
        if (state.births >= 2 || room <= 0) break;
        const d = degree(g, n.id);
        const active = n.kind === 'rule' || lap - (activity.fires[key] ?? -99) <= 2 || lap - (activity.born[key] ?? -99) <= 1;
        const ripe = lap - (activity.born[key] ?? -99) >= RIPEN_LAPS - 1;
        if (!active || !ripe || d < 1 || d > 3) continue;
        if (dice(path, n.id, 4) >= rate * room * 0.9) continue;
      }
      const res = bud(g, n, r, grain);
      state.births += 1;
      for (const kid of res.kids) {
        const kidKey = nodeKey(path, kid.id);
        born.push({ key: kidKey, parent: key });
        state.pop += kid.kind === 'colony' ? 1 : 1;
        if (kid.kind === 'colony') {
          for (const inner of kid.graph.nodes) {
            const mv = res.moved.find((m) => m.id === inner.id && m.into === kid.id);
            if (mv) moved.push({ from: nodeKey(path, inner.id), to: nodeKey([...path, kid.id], inner.id) });
            else { born.push({ key: nodeKey([...path, kid.id], inner.id), parent: kidKey }); state.pop += 1; }
          }
        }
      }
      if (res.kids.length === 0 && !forced) changed.push(key); // a new wire
      if (forced) break;
    }

    /* mutation --------------------------------------------------------- */
    if (!opts.force && rate > 0 && g.nodes.length && dice(path, '@', 5) < 0.25 * rate) {
      const n = g.nodes[Math.floor(dice(path, '@', 6) * g.nodes.length)];
      if (n && dying[nodeKey(path, n.id)] == null && mutate(n, r)) changed.push(nodeKey(path, n.id));
    }

    /* nested colonies grow by their own rules --------------------------- */
    for (const n of g.nodes) if (n.kind === 'colony' && !born.some((b) => b.key === nodeKey(path, n.id))) step(n.graph, [...path, n.id], false);
  };

  step(next.root, [], true);
  // The swing drifts a hair now and then, so the feel is never frozen.
  if (!opts.force && rate > 0 && next.swing != null && unit(seed, 47, lap) < 0.08 * rate) {
    next.swing = Math.round(Math.max(0.5, Math.min(0.72, next.swing + (unit(seed, 48, lap) - 0.5) * 0.04)) * 100) / 100;
  }
  return { score: next, born, died, withering, moved, changed };
}

/** The keys of every node, for activity bookkeeping. */
export function allKeys(g: ColonyGraph, path: string[] = []): string[] {
  const out: string[] = [];
  for (const n of g.nodes) {
    out.push(nodeKey(path, n.id));
    if (n.kind === 'colony') out.push(...allKeys(n.graph, [...path, n.id]));
  }
  return out;
}

/**
 * How alive a cell is right now, 0..1: ripening from birth over RIPEN_LAPS,
 * withering toward its removal lap. `lap` may be fractional.
 */
export function vitalityOf(activity: Activity, key: string, lap: number): number {
  const dieAt = activity.dying?.[key];
  if (dieAt != null) return Math.max(0, Math.min(1, (dieAt - lap) / WITHER_LAPS));
  const born = activity.born[key];
  if (born == null) return 1;
  return Math.max(0, Math.min(1, (lap - born) / RIPEN_LAPS));
}
