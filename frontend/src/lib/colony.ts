/**
 * colony — LOOM's node mode: a graph of cells instead of lanes
 * (docs/design/loom.md §10).
 *
 * A COLONY is a graph. Its nodes are cells:
 *   loop    a shard loop (a stem loop, a bar of bass, a word) that plays
 *           when triggered, for `beats`, or holds until the next trigger
 *   rule    a generator (euclid, fib, life, fractal, rand, echo …) that
 *           emits a symbol per step of the colony's bar
 *   gate    lets triggers through by chance (?60) or by lap (!2:4)
 *   mod     colours what it passes (=cut.3,gain-6 / +trans12)
 *   colony  a whole graph as one cell, with its own meter and tempo —
 *           colonies nest without limit, which is the fractal
 * Edges carry triggers: `pulse -> kick`, `swarm -> bass on=0`,
 * `pulse -> maybe -> dark -> bass`. A trigger into a colony starts its bar.
 *
 * Meters are free: `meter 7/8 groups=3+2+2`, `meter 11/8 groups=3+3+3+2`,
 * `meter 5/4`. A colony's bar is num/den whole notes at its tempo; groups
 * accent the downbeats of each group and shape the drawing.
 *
 * The text is the colony, as with the plane. Everything here is pure: the
 * parser, the serializer, and the bar arithmetic.
 */
import { GEN_DEFAULT_OPTS, GEN_KINDS, type GenKind, type GenOpts, type GenTile } from './loomGen';
import { parseLoom, serializeQuery, serializeTile, type LockParam, type LoomParseError, type LoomQuery, type LoomTile } from './loomScore';

export interface Meter { num: number; den: number; groups: number[] }

export interface LoopNode {
  kind: 'loop';
  id: string;
  query: LoomQuery;
  /** Loop length in beats (4 = one bar of 4/4). */
  beats: number;
  gain: number;
  transpose: number;
  /** Keep looping until the next trigger instead of stopping after `beats`. */
  hold: boolean;
}
export interface RuleNode {
  kind: 'rule';
  id: string;
  gen: GenKind;
  /** Steps per colony bar. */
  steps: number;
  /** Distinct symbols the rule can emit (edges may filter with `on=`). */
  symbols: number;
  opts: GenOpts;
}
export interface GateNode { kind: 'gate'; id: string; pct?: number; period?: number; laps?: number[] }
export interface ModNode { kind: 'mod'; id: string; mode: 'abs' | 'rel'; params: Partial<Record<LockParam, number>> }
export interface ColonyNode_ { kind: 'colony'; id: string; graph: ColonyGraph }
export type ColonyNode = LoopNode | RuleNode | GateNode | ModNode | ColonyNode_;

export interface ColonyEdge { from: string; to: string; on?: number }

export interface ColonyGraph {
  meter: Meter;
  /** Tempo multiplier against the parent (root: 1). */
  tempo: number;
  nodes: ColonyNode[];
  edges: ColonyEdge[];
}

export interface ColonyScore {
  bpm?: number;
  key?: string;
  scale?: 'major' | 'minor';
  seed?: number;
  form?: string;
  root: ColonyGraph;
}

export const DEFAULT_METER: Meter = { num: 4, den: 4, groups: [] };

/** Seconds of one bar of `meter` at a quarter-note `beatSec`. */
export function barSeconds(meter: Meter, beatSec: number): number {
  return (meter.num / meter.den) * 4 * beatSec;
}

/** Group starts as step indices when the bar has `steps` steps. */
export function groupStarts(meter: Meter, steps: number): number[] {
  const groups = meter.groups.length ? meter.groups : [meter.num];
  const total = groups.reduce((a, b) => a + b, 0) || 1;
  const out: number[] = [];
  let acc = 0;
  for (const g of groups) {
    out.push(Math.round((acc / total) * steps));
    acc += g;
  }
  return out;
}

export function meterText(m: Meter): string {
  return `${m.num}/${m.den}${m.groups.length ? ` groups=${m.groups.join('+')}` : ''}`;
}

export function parseMeter(s: string): Meter | null {
  const m = /^(\d+)\/(\d+)$/.exec(s.trim());
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (num < 1 || num > 64 || ![1, 2, 4, 8, 16, 32].includes(den)) return null;
  return { num, den, groups: [] };
}

export function parseGroups(s: string, num: number): number[] | null {
  const parts = s.split('+').map((x) => Number(x.trim()));
  if (parts.some((n) => !Number.isFinite(n) || n < 1)) return null;
  if (parts.reduce((a, b) => a + b, 0) !== num) return null;
  return parts;
}

/** Placeholder alphabet so lib/loomGen's rules yield a symbol INDEX. */
export function ruleTile(node: RuleNode): GenTile {
  const alphabet: (LoomQuery | null)[] = Array.from({ length: Math.max(1, node.symbols) }, (_, i) => ({ shardId: `sym:${i}` }));
  return { kind: 'gen', gen: node.gen, alphabet, span: node.steps, opts: node.opts, roll: 0 };
}

export function symbolIndex(q: LoomQuery | null): number | null {
  if (!q || !q.shardId || !q.shardId.startsWith('sym:')) return null;
  return Number(q.shardId.slice(4));
}

/* ── parsing ──────────────────────────────────────────────────────────── */

const ID_RE = /^[A-Za-z][A-Za-z0-9_\-.]*$/;

function stripComment(s: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '{' || ch === '<') depth += 1;
    else if (ch === ')' || ch === '}' || ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) return s.slice(0, i);
  }
  return s;
}

/** `k=v k=v` (and bare flags) after a head token, respecting `< >` and `{ }`. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '<' || ch === '{' || ch === '(') depth += 1;
    else if (ch === '>' || ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Parse a shard token (`k`, `<song:drums>`, `{role=vocals text=love}`) via the plane's parser. */
function parseQueryToken(tok: string, line: number, errors: LoomParseError[]): LoomQuery | null {
  const { score, errors: errs } = parseLoom(`lane x x1\n  ${tok}`);
  for (const e of errs) errors.push({ line, message: e.message });
  const t: LoomTile | null | undefined = score.lanes[0]?.rows[0]?.[0];
  return t && t.kind === 'shard' ? t.query : null;
}

const numOr = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : d;
};

export function parseColony(text: string): { score: ColonyScore; errors: LoomParseError[] } {
  const errors: LoomParseError[] = [];
  const score: ColonyScore = { root: { meter: { ...DEFAULT_METER }, tempo: 1, nodes: [], edges: [] } };
  const stack: ColonyGraph[] = [score.root];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const err = (line: number, message: string) => errors.push({ line, message });

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = stripComment(lines[i]).trim();
    if (!raw) continue;
    const g = stack[stack.length - 1];
    if (raw === '}') {
      if (stack.length === 1) { err(lineNo, 'a } with no open colony'); continue; }
      stack.pop();
      continue;
    }
    // Edges: a -> b [on=N] -> c …
    if (raw.includes('->')) {
      const parts = raw.split('->').map((p) => p.trim());
      let prev: string | null = null;
      for (const part of parts) {
        const [id, ...rest] = splitArgs(part);
        if (!id || !ID_RE.test(id)) { err(lineNo, `edge needs node names: a -> b — got "${part}"`); prev = null; continue; }
        let on: number | undefined;
        for (const a of rest) {
          const m = /^on=(\d+)$/.exec(a);
          if (m) on = Number(m[1]); else err(lineNo, `edge option looks like on=N — got "${a}"`);
        }
        if (prev) g.edges.push({ from: prev, to: id, on });
        prev = id;
      }
      continue;
    }
    const [head, ...rest] = splitArgs(raw);
    const h = head.toLowerCase();
    if (h === 'bpm') {
      const b = Number(rest[0]);
      if (!Number.isFinite(b) || b < 20 || b > 300) err(lineNo, 'bpm is 20–300'); else score.bpm = b;
      continue;
    }
    if (h === 'key') {
      const t = rest.join(' ');
      if (/^follow$/i.test(t)) { score.key = 'follow'; continue; }
      const m = /^([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major|M)?$/.exec(t);
      if (!m) { err(lineNo, 'key looks like "Am", "F#", "Bb major", or "follow"'); continue; }
      score.key = m[1].toUpperCase() + m[2];
      score.scale = m[3] && /^(m|min|minor)$/.test(m[3]) ? 'minor' : 'major';
      continue;
    }
    if (h === 'seed') { const n = Number(rest[0]); if (!Number.isFinite(n)) err(lineNo, 'seed needs a number'); else score.seed = Math.floor(n); continue; }
    if (h === 'form') { const f = (rest[0] ?? '').replace(/[^A-Za-z]/g, ''); if (!f) err(lineNo, 'form is letters by lap, e.g. AABA'); else score.form = f.toUpperCase(); continue; }
    if (h === 'meter') {
      const m = parseMeter(rest[0] ?? '');
      if (!m) { err(lineNo, 'meter looks like 7/8 (optionally groups=3+2+2)'); continue; }
      for (const a of rest.slice(1)) {
        const gm = /^groups=(.+)$/.exec(a);
        if (!gm) { err(lineNo, `meter option looks like groups=3+2+2 — got "${a}"`); continue; }
        const groups = parseGroups(gm[1], m.num);
        if (!groups) err(lineNo, `groups must add up to ${m.num}`); else m.groups = groups;
      }
      g.meter = m;
      continue;
    }
    if (h === 'tempo') { const t = Number(rest[0]); if (!Number.isFinite(t) || t <= 0 || t > 8) err(lineNo, 'tempo is a multiplier, 0.25–8'); else g.tempo = t; continue; }

    if (h === 'colony') {
      const id = rest[0];
      if (!id || !ID_RE.test(id)) { err(lineNo, 'colony needs a name: colony NAME meter=7/8 {'); continue; }
      const child: ColonyGraph = { meter: { ...DEFAULT_METER }, tempo: 1, nodes: [], edges: [] };
      let opened = false;
      for (const a of rest.slice(1)) {
        if (a === '{') { opened = true; continue; }
        const mm = /^meter=(.+)$/.exec(a);
        if (mm) { const m = parseMeter(mm[1]); if (!m) err(lineNo, `meter looks like 7/8 — got "${mm[1]}"`); else child.meter = { ...m, groups: child.meter.groups }; continue; }
        const gm = /^groups=(.+)$/.exec(a);
        if (gm) { const groups = parseGroups(gm[1], child.meter.num); if (!groups) err(lineNo, `groups must add up to ${child.meter.num}`); else child.meter.groups = groups; continue; }
        const tm = /^tempo=(.+)$/.exec(a);
        if (tm) { const t = Number(tm[1]); if (!Number.isFinite(t) || t <= 0) err(lineNo, 'tempo is a multiplier'); else child.tempo = t; continue; }
        err(lineNo, `colony option looks like meter=7/8, groups=3+2+2 or tempo=1.5 — got "${a}"`);
      }
      if (!opened) err(lineNo, 'colony needs an opening {');
      if (g.nodes.some((n) => n.id === id)) err(lineNo, `"${id}" is defined twice`);
      g.nodes.push({ kind: 'colony', id, graph: child });
      stack.push(child);
      continue;
    }

    // Node definitions: kind NAME = body args
    if (h === 'loop' || h === 'rule' || h === 'gate' || h === 'mod') {
      const id = rest[0];
      if (!id || !ID_RE.test(id)) { err(lineNo, `${h} needs a name: ${h} NAME = …`); continue; }
      if (rest[1] !== '=') { err(lineNo, `${h} ${id} needs an = then its body`); continue; }
      if (g.nodes.some((n) => n.id === id)) err(lineNo, `"${id}" is defined twice`);
      const body = rest.slice(2);
      if (h === 'loop') {
        const q = body[0] ? parseQueryToken(body[0], lineNo, errors) : null;
        if (!q) { if (!body[0]) err(lineNo, 'loop needs a shard token: loop NAME = <song:drums> beats=8'); continue; }
        const node: LoopNode = { kind: 'loop', id, query: q, beats: 4, gain: 0, transpose: 0, hold: false };
        for (const a of body.slice(1)) {
          if (a === 'hold') { node.hold = true; continue; }
          const m = /^(beats|gain|transpose|trans)=(.+)$/.exec(a);
          if (!m) { err(lineNo, `loop option looks like beats=8, gain=-3, transpose=5 or hold — got "${a}"`); continue; }
          const v = Number(m[2]);
          if (!Number.isFinite(v)) { err(lineNo, `${m[1]} needs a number`); continue; }
          if (m[1] === 'beats') node.beats = Math.max(0.25, v); else if (m[1] === 'gain') node.gain = v; else node.transpose = v;
        }
        if (node.query.beats == null) node.query = { ...node.query, beats: [1, 4, 8, 16].includes(node.beats) ? node.beats : undefined };
        g.nodes.push(node);
      } else if (h === 'rule') {
        const m = /^([a-z]+)\((.*)\)$/s.exec(body.join(' '));
        if (!m || !(GEN_KINDS as readonly string[]).includes(m[1].toLowerCase())) { err(lineNo, `rule needs a generator: rule NAME = euclid(hits=5 steps=8) (${GEN_KINDS.join(', ')})`); continue; }
        const gen = m[1].toLowerCase() as GenKind;
        const node: RuleNode = { kind: 'rule', id, gen, steps: g.meter.num * (g.meter.den >= 8 ? 1 : 2), symbols: 2, opts: { ...GEN_DEFAULT_OPTS[gen] } };
        for (const a of m[2].split(/[\s,]+/).filter(Boolean)) {
          const om = /^([a-zA-Z_]+)=(.+)$/.exec(a);
          if (!om) { err(lineNo, `rule option looks like name=value — got "${a}"`); continue; }
          const k = om[1].toLowerCase();
          const v = Number(om[2]);
          const isNum = Number.isFinite(v) && !/[A-Za-z\/]/.test(om[2]);
          if (k === 'steps') node.steps = Math.max(1, Math.min(256, Math.round(v) || node.steps));
          else if (k === 'symbols') node.symbols = Math.max(1, Math.min(16, Math.round(v) || 2));
          else node.opts[k] = isNum ? v : om[2];
        }
        g.nodes.push(node);
      } else if (h === 'gate') {
        const b = body[0] ?? '';
        if (b.startsWith('?')) { const pct = Number(b.slice(1)); if (!Number.isFinite(pct)) err(lineNo, 'chance gate is ?60'); else g.nodes.push({ kind: 'gate', id, pct: Math.max(0, Math.min(100, pct)) }); }
        else if (b.startsWith('!')) {
          const cm = /^!(\d+(?:,\d+)*):(\d+)$/.exec(b);
          if (!cm) err(lineNo, 'cycle gate is !laps:period, e.g. !2:4'); else { const period = Math.max(2, Math.min(32, Number(cm[2]))); g.nodes.push({ kind: 'gate', id, period, laps: cm[1].split(',').map(Number).filter((n) => n >= 1 && n <= period) }); }
        } else err(lineNo, 'gate is ?60 (chance) or !2:4 (cycle)');
      } else {
        const b = body[0] ?? '';
        const { score: s2, errors: e2 } = parseLoom(`lane x x1\n  ${b}`);
        for (const e of e2) err(lineNo, e.message);
        const t = s2.lanes[0]?.rows[0]?.[0];
        if (!t || t.kind !== 'lock') { if (!e2.length) err(lineNo, 'mod is a lock: =cut.3,gain-6 or +trans12'); continue; }
        g.nodes.push({ kind: 'mod', id, mode: t.mode, params: t.params });
      }
      continue;
    }
    err(lineNo, `unknown line "${head}" (bpm, key, seed, form, meter, tempo, loop, rule, gate, mod, colony, or an a -> b edge)`);
  }
  if (stack.length > 1) err(0, `${stack.length - 1} colony block${stack.length > 2 ? 's are' : ' is'} missing a closing }`);

  // Edges must name nodes in their own colony.
  const check = (g: ColonyGraph, path: string) => {
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      if (!ids.has(e.from)) err(0, `${path}edge from "${e.from}": no such node`);
      if (!ids.has(e.to)) err(0, `${path}edge to "${e.to}": no such node`);
    }
    for (const n of g.nodes) if (n.kind === 'colony') check(n.graph, `${path}${n.id}: `);
  };
  check(score.root, '');
  return { score, errors };
}

/* ── serializing ──────────────────────────────────────────────────────── */

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

function serializeNode(n: ColonyNode, indent: string, out: string[]): void {
  switch (n.kind) {
    case 'loop': {
      const q = { ...n.query };
      if ([1, 4, 8, 16].includes(n.beats) && q.beats === n.beats) delete q.beats;
      const opts = [`beats=${num(n.beats)}`];
      if (n.gain) opts.push(`gain=${num(n.gain)}`);
      if (n.transpose) opts.push(`transpose=${num(n.transpose)}`);
      if (n.hold) opts.push('hold');
      out.push(`${indent}loop ${n.id} = ${serializeQuery(q)} ${opts.join(' ')}`);
      return;
    }
    case 'rule': {
      const defaults = GEN_DEFAULT_OPTS[n.gen] ?? {};
      const opts = [`steps=${n.steps}`];
      if (n.symbols !== 2) opts.push(`symbols=${n.symbols}`);
      for (const [k, v] of Object.entries(n.opts)) if (defaults[k] !== v) opts.push(`${k}=${typeof v === 'number' ? num(v) : v}`);
      out.push(`${indent}rule ${n.id} = ${n.gen}(${opts.join(' ')})`);
      return;
    }
    case 'gate':
      out.push(`${indent}gate ${n.id} = ${n.pct != null ? `?${num(n.pct)}` : `!${(n.laps ?? []).join(',')}:${n.period ?? 4}`}`);
      return;
    case 'mod':
      out.push(`${indent}mod ${n.id} = ${serializeTile({ kind: 'lock', mode: n.mode, params: n.params })}`);
      return;
    case 'colony': {
      const g = n.graph;
      const opts = [`meter=${g.meter.num}/${g.meter.den}`];
      if (g.meter.groups.length) opts.push(`groups=${g.meter.groups.join('+')}`);
      if (g.tempo !== 1) opts.push(`tempo=${num(g.tempo)}`);
      out.push(`${indent}colony ${n.id} ${opts.join(' ')} {`);
      serializeGraphBody(g, `${indent}  `, out);
      out.push(`${indent}}`);
    }
  }
}

function serializeGraphBody(g: ColonyGraph, indent: string, out: string[]): void {
  for (const n of g.nodes) serializeNode(n, indent, out);
  if (g.edges.length && g.nodes.length) out.push('');
  for (const e of g.edges) out.push(`${indent}${e.from} -> ${e.to}${e.on != null ? ` on=${e.on}` : ''}`);
}

export function serializeColony(score: ColonyScore): string {
  const out: string[] = [];
  if (score.bpm) out.push(`bpm ${num(score.bpm)}`);
  if (score.key) out.push(`key ${score.key === 'follow' ? 'follow' : score.key + (score.scale === 'minor' ? 'm' : '')}`);
  if (score.seed != null) out.push(`seed ${score.seed}`);
  if (score.form) out.push(`form ${score.form}`);
  out.push(`meter ${meterText(score.root.meter)}`);
  if (score.root.tempo !== 1) out.push(`tempo ${num(score.root.tempo)}`);
  out.push('');
  serializeGraphBody(score.root, '', out);
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** Every node with its colony path, depth-first. */
export function walkNodes(g: ColonyGraph, path: string[] = []): { node: ColonyNode; path: string[]; graph: ColonyGraph }[] {
  const out: { node: ColonyNode; path: string[]; graph: ColonyGraph }[] = [];
  for (const n of g.nodes) {
    out.push({ node: n, path, graph: g });
    if (n.kind === 'colony') out.push(...walkNodes(n.graph, [...path, n.id]));
  }
  return out;
}

export const STARTER_COLONY = `; LOOM colony — cells, not lanes. Triggers travel along the arrows.
; A rule fires symbols on the colony's bar; a loop plays a stem loop when hit;
; a colony is a cell that is itself a whole graph, with its own meter.
bpm 120
key follow
seed 11
meter 4/4

loop kick = {role=drums beats=8} beats=8 hold
loop bass = b beats=4
loop word = v beats=1
rule pulse = euclid(hits=5 steps=8)
rule swarm = life(steps=16 rows=3 density=.35)
gate maybe = ?60
mod dark = =cut.35,gain-6

colony seven meter=7/8 groups=3+2+2 {
  rule tick = euclid(hits=3 steps=7)
  loop hat = h beats=1
  tick -> hat
}

pulse -> kick
swarm -> bass on=0
swarm -> maybe -> dark -> word
pulse -> seven on=0
`;
