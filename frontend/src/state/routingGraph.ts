/**
 * routingGraph — the app's ONE signal-routing adjacency model: buses, sends and
 * sidechain keys as edges of a single directed graph, with the master as an
 * ordinary node.
 *
 * Before this, every track's output was hard-coded to the master bus in
 * `liveMixer.ts` and there was no way to express "drums -> drum bus", "vocal ->
 * reverb send at -12 dB", or "kick keys the compressor on the bass". Three
 * separate features, one data structure: an edge whose `connType` says which
 * one it is. Keeping them in one graph is not tidiness — it is the only way
 * feedback refusal can be correct, because Web Audio does not care what a
 * connection is *called*: a sidechain that closes a loop silences the graph
 * exactly like an output that closes one.
 *
 * Contract
 * --------
 * - Pure data and pure functions. No Web Audio, no store import, no `Map` in
 *   the shape — a `RoutingGraph` is JSON, so it can live in the editor store
 *   and be written into `docSnapshot` / `.tasmo` unchanged. The dormant
 *   `.tasmo` schema (`backend/modules/project/tasmo_project.py`, `Track`) is
 *   directly expressible: `output_routing` is `outputOf()`, `send_amounts` is
 *   `sendsFrom()` keyed by `to`.
 * - Every mutator returns a NEW graph and never mutates its input, matching the
 *   editor store's reducer style.
 * - Mutators that ADD an edge return a `RoutingResult`: `{ ok: false, reason }`
 *   leaves the graph untouched. `'cycle'` is the load-bearing refusal — a Web
 *   Audio cycle with no DelayNode in it is silence, not feedback, so a cycle is
 *   refused at the model boundary and `topoOrder()` can then assume a DAG.
 * - Exactly one `CONN_OUTPUT` edge per non-master node. A node with none is
 *   read as feeding the master (`outputOf`), so a partially built graph is
 *   still audible; `validateGraph` reports the omission.
 * - The master never has an outgoing edge, which is what makes it the last
 *   entry of `topoOrder()`.
 *
 * Design references (READ, NOT COPIED — both are copyleft and incompatible with
 * this repo; no code, snippet or comment from either was used, only the shape
 * of the idea):
 *   - Stargate `src/sglib/models/daw/routing/graph.py` — GPL-3.0. Source of the
 *     design: the main out is node 0 rather than a special case, each edge
 *     carries a connection type, and a connection is checked for feedback by
 *     looking for an existing path back before it is made.
 *   - Ardour `libs/ardour/internal_return.cc` — GPL-2.0-or-later. Source of the
 *     bus contract: a bus is a normal node that sums its inputs, and a send is
 *     a post-pan tap with its own gain rather than a second output.
 */

export type RoutingNodeKind = 'track' | 'bus' | 'master';

export interface RoutingNode {
  id: string;
  kind: RoutingNodeKind;
  name: string;
}

/** Post-pan main output. Exactly one per non-master node. */
export const CONN_OUTPUT = 0;
/** Post-pan tap into another node, with its own gain. Any number per node. */
export const CONN_SEND = 1;
/** Key input feeding a NAMED effect entry on the destination node's rack. */
export const CONN_SIDECHAIN = 2;

export type ConnType = 0 | 1 | 2;

export interface RoutingEdge {
  from: string;
  to: string;
  connType: ConnType;
  gain: number;
  /** Required iff `connType === CONN_SIDECHAIN`: the `ChainEntry.id` it keys. */
  targetEntryId?: string;
}

export interface RoutingGraph {
  nodes: RoutingNode[];
  edges: RoutingEdge[];
}

export const MASTER_ID = 'master';

/** Why an edge-adding mutation was refused. The graph is untouched in each case. */
export type RoutingRefusal =
  | 'cycle'          // the edge would close a loop over ALL edge types
  | 'missing-node'   // `from` or `to` is not in the graph
  | 'master-output'  // the master never has an outgoing edge
  | 'duplicate'      // that exact connection already exists
  | 'missing-entry'; // a sidechain without the effect entry it keys

/**
 * The two arms each declare the OTHER arm's field as `?: undefined`. That is not
 * decoration: this project's tsconfig has no `strictNullChecks`, under which TS
 * narrows `if (r.ok)` but NOT `if (!r.ok)`, so a caller reading `r.reason` on the
 * failure path would need a cast. Declaring both fields on both arms makes the
 * read legal either way while keeping the discriminant exact.
 */
export type RoutingResult =
  | { ok: true; graph: RoutingGraph; reason?: undefined }
  | { ok: false; graph?: undefined; reason: RoutingRefusal };

const refuse = (reason: RoutingRefusal): RoutingResult => ({ ok: false, reason });

/** A graph holding nothing but the master. */
export function emptyGraph(): RoutingGraph {
  return { nodes: [{ id: MASTER_ID, kind: 'master', name: 'Master' }], edges: [] };
}

const hasNode = (g: RoutingGraph, id: string): boolean => g.nodes.some((n) => n.id === id);

/** Add `id` as `kind` if absent (renaming it if present), with its output edge to master. */
function ensureNode(g: RoutingGraph, id: string, kind: RoutingNodeKind, name: string): RoutingGraph {
  // The master is never added as a track or a bus. It has no output, so the
  // edge this would otherwise create is `master -> master`: a self-edge that no
  // ordering can satisfy, on a graph a caller only meant to seed.
  if (id === MASTER_ID) return g;
  const existing = g.nodes.find((n) => n.id === id);
  if (existing) {
    if (existing.name === name) return { nodes: g.nodes.slice(), edges: g.edges.slice() };
    return { nodes: g.nodes.map((n) => (n.id === id ? { ...n, name } : n)), edges: g.edges.slice() };
  }
  const edges = g.edges.slice();
  edges.push({ from: id, to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 });
  return { nodes: [...g.nodes, { id, kind, name }], edges };
}

/** Add (or rename) the node for an editor track. Idempotent. */
export function ensureTrackNode(g: RoutingGraph, trackId: string, name: string): RoutingGraph {
  return ensureNode(g, trackId, 'track', name);
}

/** Add (or rename) a bus node. Idempotent. */
export function addBus(g: RoutingGraph, id: string, name: string): RoutingGraph {
  return ensureNode(g, id, 'bus', name);
}

/**
 * Drop `id` and every edge touching it. Any node whose ONLY output pointed at
 * it is re-homed to the master, so removing a bus never silences what fed it.
 * The master itself cannot be removed.
 */
export function removeNode(g: RoutingGraph, id: string): RoutingGraph {
  if (id === MASTER_ID || !hasNode(g, id)) return { nodes: g.nodes.slice(), edges: g.edges.slice() };
  const orphaned = g.edges
    .filter((e) => e.to === id && e.connType === CONN_OUTPUT && e.from !== id)
    .map((e) => e.from);
  const edges = g.edges.filter((e) => e.from !== id && e.to !== id);
  for (const from of orphaned) {
    edges.push({ from, to: MASTER_ID, connType: CONN_OUTPUT, gain: 1 });
  }
  return { nodes: g.nodes.filter((n) => n.id !== id), edges };
}

/**
 * True when an edge `from -> to` would close a loop, counting edges of EVERY
 * type: a path back to `from` already exists, or the edge is a self-edge.
 */
export function wouldCycle(g: RoutingGraph, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>([to]);
  const stack: string[] = [to];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const e of g.edges) {
      if (e.from !== cur) continue;
      if (e.to === from) return true;
      if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    }
  }
  return false;
}

/** Shared guards for every edge-adding mutator. `null` means "go ahead". */
function edgeGuard(g: RoutingGraph, from: string, to: string): RoutingRefusal | null {
  if (!hasNode(g, from) || !hasNode(g, to)) return 'missing-node';
  if (from === MASTER_ID) return 'master-output';
  return null;
}

/**
 * Replace the node's single `CONN_OUTPUT` edge. Sends and sidechains from the
 * same node are untouched — they are taps, not outputs.
 */
export function setOutput(g: RoutingGraph, from: string, to: string): RoutingResult {
  const bad = edgeGuard(g, from, to);
  if (bad) return refuse(bad);
  const rest = g.edges.filter((e) => !(e.from === from && e.connType === CONN_OUTPUT));
  if (wouldCycle({ nodes: g.nodes, edges: rest }, from, to)) return refuse('cycle');
  rest.push({ from, to, connType: CONN_OUTPUT, gain: 1 });
  return { ok: true, graph: { nodes: g.nodes.slice(), edges: rest } };
}

/** Add a post-pan send with its own gain. One send per (from, to) pair. */
export function addSend(g: RoutingGraph, from: string, to: string, gain: number): RoutingResult {
  const bad = edgeGuard(g, from, to);
  if (bad) return refuse(bad);
  if (g.edges.some((e) => e.from === from && e.to === to && e.connType === CONN_SEND)) return refuse('duplicate');
  if (wouldCycle(g, from, to)) return refuse('cycle');
  return { ok: true, graph: { nodes: g.nodes.slice(), edges: [...g.edges, { from, to, connType: CONN_SEND, gain }] } };
}

/** Set an existing send's gain. A send that does not exist is a no-op. */
export function setSendGain(g: RoutingGraph, from: string, to: string, gain: number): RoutingGraph {
  return {
    nodes: g.nodes.slice(),
    edges: g.edges.map((e) => (e.from === from && e.to === to && e.connType === CONN_SEND ? { ...e, gain } : e)),
  };
}

/** Drop the send from `from` to `to`. A send that does not exist is a no-op. */
export function removeSend(g: RoutingGraph, from: string, to: string): RoutingGraph {
  return {
    nodes: g.nodes.slice(),
    edges: g.edges.filter((e) => !(e.from === from && e.to === to && e.connType === CONN_SEND)),
  };
}

/**
 * Key the effect entry `targetEntryId` on `toNode` from `from`. Several
 * sidechains may land on the same node as long as they key different entries.
 */
export function setSidechain(g: RoutingGraph, from: string, toNode: string, targetEntryId: string): RoutingResult {
  const bad = edgeGuard(g, from, toNode);
  if (bad) return refuse(bad);
  if (!targetEntryId) return refuse('missing-entry');
  const dup = g.edges.some(
    (e) => e.from === from && e.to === toNode && e.connType === CONN_SIDECHAIN && e.targetEntryId === targetEntryId,
  );
  if (dup) return refuse('duplicate');
  if (wouldCycle(g, from, toNode)) return refuse('cycle');
  const edge: RoutingEdge = { from, to: toNode, connType: CONN_SIDECHAIN, gain: 1, targetEntryId };
  return { ok: true, graph: { nodes: g.nodes.slice(), edges: [...g.edges, edge] } };
}

/**
 * Drop the sidechain from `from` into `toNode`. With `targetEntryId` omitted,
 * every sidechain on that pair goes (used when the destination rack is cleared).
 */
export function removeSidechain(g: RoutingGraph, from: string, toNode: string, targetEntryId?: string): RoutingGraph {
  return {
    nodes: g.nodes.slice(),
    edges: g.edges.filter(
      (e) => !(
        e.from === from
        && e.to === toNode
        && e.connType === CONN_SIDECHAIN
        && (targetEntryId === undefined || e.targetEntryId === targetEntryId)
      ),
    ),
  };
}

/** Every incoming edge of `id`, whatever its type, in insertion order. */
export function inputsOf(g: RoutingGraph, id: string): RoutingEdge[] {
  return g.edges.filter((e) => e.to === id);
}

/**
 * Where `id`'s main output goes. A non-master node with no explicit output edge
 * is read as feeding the master, so a half-built graph is still audible. The
 * master has no output: `null`.
 */
export function outputOf(g: RoutingGraph, id: string): string | null {
  if (id === MASTER_ID) return null;
  const e = g.edges.find((x) => x.from === id && x.connType === CONN_OUTPUT);
  return e ? e.to : MASTER_ID;
}

/** Every send leaving `id`, in insertion order. */
export function sendsFrom(g: RoutingGraph, id: string): RoutingEdge[] {
  return g.edges.filter((e) => e.from === id && e.connType === CONN_SEND);
}

/** Every sidechain key landing on `id`, in insertion order. */
export function sidechainsInto(g: RoutingGraph, id: string): RoutingEdge[] {
  return g.edges.filter((e) => e.to === id && e.connType === CONN_SIDECHAIN);
}

/**
 * Kahn's algorithm over all edge types: the order the mixer must build nodes in
 * so every source exists before the node that reads it. Deterministic — ties go
 * to the earlier node in `nodes` — and the master is always last, because it
 * never has an outgoing edge. Throws on a cycle, which the mutators prevent.
 */
export function topoOrder(g: RoutingGraph): string[] {
  // Deduped so a malformed graph with a repeated node id yields one entry per
  // id rather than an unsatisfiable count.
  const ids: string[] = [];
  const known = new Set<string>();
  for (const n of g.nodes) {
    if (n.id === MASTER_ID || known.has(n.id)) continue;
    known.add(n.id);
    ids.push(n.id);
  }
  // ONLY edges between two known non-master nodes carry weight. A dangling
  // `from`, or an illegal `master -> x`, would otherwise leave an in-degree
  // nothing can ever decrement and the throw below would blame a cycle that is
  // not there — a `.tasmo` load can hand this function exactly such a graph.
  // Naming that damage is `validateGraph`'s job; ordering must still succeed.
  const counts = (e: RoutingEdge): boolean => known.has(e.from) && known.has(e.to) && e.from !== e.to;
  const inDeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of g.edges) {
    if (!counts(e)) continue;
    inDeg.set(e.to, (inDeg.get(e.to) as number) + 1);
  }
  const out: string[] = [];
  const done = new Set<string>();
  while (out.length < ids.length) {
    // Lowest insertion index with no remaining inputs: the deterministic tie-break.
    const next = ids.find((id) => !done.has(id) && inDeg.get(id) === 0);
    if (next === undefined) {
      const stuck = ids.filter((id) => !done.has(id)).join(', ');
      throw new Error(`routingGraph.topoOrder: cycle or malformed graph — run validateGraph. Stuck on [${stuck}]`);
    }
    done.add(next);
    out.push(next);
    for (const e of g.edges) {
      if (e.from !== next || !counts(e)) continue;
      inDeg.set(e.to, (inDeg.get(e.to) as number) - 1);
    }
  }
  if (hasNode(g, MASTER_ID)) out.push(MASTER_ID);
  return out;
}

/**
 * Structural problems, as human-readable strings — for a graph loaded from a
 * project file, which no mutator vetted. An empty list means the graph is sane.
 */
export function validateGraph(g: RoutingGraph): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const n of g.nodes) {
    if (seen.has(n.id)) problems.push(`duplicate node id "${n.id}"`);
    seen.add(n.id);
  }
  for (const e of g.edges) {
    if (!seen.has(e.from)) problems.push(`edge from unknown node "${e.from}"`);
    if (!seen.has(e.to)) problems.push(`edge to unknown node "${e.to}"`);
    if (e.connType === CONN_SIDECHAIN && !e.targetEntryId) {
      problems.push(`sidechain "${e.from}" -> "${e.to}" has no targetEntryId`);
    }
    if (e.from === MASTER_ID) problems.push(`master has an outgoing edge to "${e.to}"`);
  }
  for (const n of g.nodes) {
    if (n.kind === 'master' || n.id === MASTER_ID) continue;
    const outs = g.edges.filter((e) => e.from === n.id && e.connType === CONN_OUTPUT).length;
    if (outs === 0) problems.push(`node "${n.id}" has no output edge`);
    if (outs > 1) problems.push(`node "${n.id}" has ${outs} output edges, expected 1`);
  }
  return problems;
}
