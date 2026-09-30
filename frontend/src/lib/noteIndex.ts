/**
 * A sorted interval index over notes: range queries and hit tests that visit
 * O(log n) tree nodes for each of the k notes they report, O(k log n) in all,
 * where the roll and EDIT used to walk every note.
 *
 * The notes sit sorted by start (then pitch, then their place in the list).
 * Over that order a segment tree keeps, per node, the latest end of the notes
 * below it. A query for [from, to] cuts the order at the last start <= to
 * (binary search) and descends only into nodes whose latest end reaches
 * `from`, so it visits the notes it reports plus O(log n) nodes per report.
 *
 * Every pitch has a tree of its own over the same order, built the first time
 * that pitch is asked for, so a view that shows twenty rows of a 100,000-note
 * orchestra queries twenty small trees and a hit test queries one. Building an
 * index is one sort (skipped when the list is already in start order) and one
 * pass; the trees fill in lazily.
 *
 * An index describes one list as it was: the roll's lists are immutable (every
 * edit writes a new array), so `noteIndexOf` keeps one index per list in a
 * WeakMap and every reader of the same list shares it.
 */

/** What the index reads from a note: its start and length in steps (or any one unit) and its pitch. */
export interface IndexedNote {
  step: number;
  length: number;
  note: number;
}

const finite = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/**
 * Walk stacks, reused so a query allocates nothing: one per nesting depth (a
 * visit that queries again takes the next). 64 slots hold any tree's walk.
 */
const stacks: Int32Array[] = [];
let stackDepth = 0;

/** A segment tree over a slice of the sorted order: `pos` holds positions into the index's sorted arrays. */
class Tree {
  readonly pos: Int32Array;
  /** The notes' starts and ends in the tree's own order, packed, so a walk reads memory in order. */
  readonly starts: Float64Array;
  readonly ends: Float64Array;
  private readonly size: number;
  private readonly maxEnd: Float64Array;

  constructor(pos: Int32Array, starts: Float64Array, ends: Float64Array) {
    this.pos = pos;
    const n = pos.length;
    this.starts = new Float64Array(n);
    this.ends = new Float64Array(n);
    let size = 1;
    while (size < n) size <<= 1;
    this.size = size;
    const maxEnd = new Float64Array(2 * size).fill(-Infinity);
    for (let i = 0; i < n; i += 1) {
      this.starts[i] = starts[pos[i]];
      this.ends[i] = ends[pos[i]];
      maxEnd[size + i] = ends[pos[i]];
    }
    for (let i = size - 1; i >= 1; i -= 1) maxEnd[i] = Math.max(maxEnd[2 * i], maxEnd[2 * i + 1]);
    this.maxEnd = maxEnd;
  }

  /**
   * The latest-in-list note (by `order`) with start <= at < max(end, start +
   * reach(leaf)), or -1: the hit test's walk. `reachOf` is the caller's, and
   * may itself query an index, so the walk holds a stack of its own depth.
   */
  lastHit(at: number, maxReach: number, order: Int32Array, reachOf: ((leaf: number) => number) | null): number {
    const hi = this.cut(at);
    if (hi === 0) return -1;
    const { size, maxEnd, starts, ends, pos } = this;
    const from = at - maxReach;
    const stack = (stacks[stackDepth] ??= new Int32Array(64));
    stackDepth += 1;
    let best = -1;
    try {
      let top = 0;
      stack[top++] = 1;
      while (top > 0) {
        const node = stack[--top];
        if (maxEnd[node] < from) continue;
        const level = 31 - Math.clz32(node);
        const span = size >> level;
        const lo = (node - (1 << level)) * span;
        if (lo >= hi) continue;
        if (span === 1) {
          const reach = reachOf ? reachOf(lo) : maxReach;
          const end = Math.max(ends[lo], starts[lo] + reach);
          const listIndex = order[pos[lo]];
          if (starts[lo] <= at && at < end && listIndex > best) best = listIndex;
          continue;
        }
        stack[top++] = 2 * node + 1;
        stack[top++] = 2 * node;
      }
    } finally {
      stackDepth -= 1;
    }
    return best;
  }

  /** The count of starts <= `to`. */
  private cut(to: number): number {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] <= to) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Calls `visit` with the tree's own index of each note with start <= to and end >= from, in sorted order. */
  each(from: number, to: number, visit: (leaf: number) => void): void {
    const hi = this.cut(to);
    if (hi === 0) return;
    const { size, maxEnd } = this;
    // A depth-first walk on a stack of nodes: a node's leaf range follows from
    // its level, so only the node is kept. At most one pending right sibling
    // per level plus the node in hand, so 64 slots hold any tree.
    const stack = (stacks[stackDepth] ??= new Int32Array(64));
    stackDepth += 1;
    try {
      this.walk(stack, from, hi, size, maxEnd, visit);
    } finally {
      stackDepth -= 1;
    }
  }

  private walk(stack: Int32Array, from: number, hi: number, size: number, maxEnd: Float64Array, visit: (leaf: number) => void): void {
    let top = 0;
    stack[top++] = 1;
    while (top > 0) {
      const node = stack[--top];
      if (maxEnd[node] < from) continue;
      // The node's level and first leaf: node = 2^level + k covers size / 2^level leaves from k * that.
      const level = 31 - Math.clz32(node);
      const span = size >> level;
      const lo = (node - (1 << level)) * span;
      if (lo >= hi) continue;
      if (span === 1) {
        visit(lo);
        continue;
      }
      // Right first, so the left child pops first and the visits run in order.
      stack[top++] = 2 * node + 1;
      stack[top++] = 2 * node;
    }
  }
}

export interface NoteIndex<T extends IndexedNote> {
  /** The notes indexed. */
  readonly size: number;
  /** The longest note, in the index's unit. */
  readonly maxLength: number;
  /** The lowest and highest pitch held, or null for an empty index. */
  readonly pitchRange: { low: number; high: number } | null;
  /** Every note sounding anywhere in [from, to] (a note touching either edge counts), in start order. */
  query(from: number, to: number): T[];
  /**
   * Calls `visit` for every note in [from, to] whose pitch is lowNote..highNote,
   * pitch by pitch from the top, each pitch in start order; returns the count.
   */
  queryRect(from: number, to: number, lowNote: number, highNote: number, visit: (n: T) => void): number;
  /**
   * queryRect for a drawing that needs only where the notes are: `visit` gets
   * each note's start, end and pitch as numbers, read from packed arrays
   * rather than the note objects. Returns the count.
   */
  spansInRect(from: number, to: number, lowNote: number, highNote: number, visit: (start: number, end: number, pitch: number) => void): number;
  /**
   * The note at `at` on `pitch`: start <= at < end, with each note at least
   * `minLength` long (a note drawn wider than it lasts is hit where it is
   * drawn). `minLengthOf`, when given, is each note's own minimum (at most
   * `minLength`), for notes whose drawn width depends on the note. Of notes
   * that overlap there, the one latest in the list wins, as it is the one
   * drawn on top.
   */
  hitTest(at: number, pitch: number, minLength?: number, minLengthOf?: (n: T) => number): T | null;
  /** The first note in order (start, then pitch, then list order), or null. */
  first(): T | null;
  /** The note after (dir 1) or before (dir -1) `n` in that order, or null at an end or for a note not in the index. */
  step(n: T, dir: 1 | -1): T | null;
}

/** Builds an index over `notes`. Non-finite starts read as 0, lengths as 0; pitches are rounded. */
export function buildNoteIndex<T extends IndexedNote>(notes: readonly T[]): NoteIndex<T> {
  const n = notes.length;
  const rawStart = new Float64Array(n);
  const rawPitch = new Int32Array(n);
  let inOrder = true;
  for (let i = 0; i < n; i += 1) {
    rawStart[i] = finite(notes[i].step, 0);
    rawPitch[i] = Math.round(finite(notes[i].note, 0));
    if (i > 0 && (rawStart[i] < rawStart[i - 1] || (rawStart[i] === rawStart[i - 1] && rawPitch[i] < rawPitch[i - 1]))) inOrder = false;
  }
  // The sorted order, as list indices: start, then pitch, then list order.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  if (!inOrder) {
    const idx = Array.from(order);
    idx.sort((a, b) => rawStart[a] - rawStart[b] || rawPitch[a] - rawPitch[b] || a - b);
    for (let i = 0; i < n; i += 1) order[i] = idx[i];
  }
  // Positions in sorted order.
  const starts = new Float64Array(n);
  const ends = new Float64Array(n);
  let maxLength = 0;
  let low = Infinity;
  let high = -Infinity;
  const buckets = new Map<number, number[]>();
  for (let p = 0; p < n; p += 1) {
    const i = order[p];
    const len = Math.max(0, finite(notes[i].length, 0));
    starts[p] = rawStart[i];
    ends[p] = rawStart[i] + len;
    if (len > maxLength) maxLength = len;
    if (rawPitch[i] < low) low = rawPitch[i];
    if (rawPitch[i] > high) high = rawPitch[i];
    const bucket = buckets.get(rawPitch[i]);
    if (bucket) bucket.push(p);
    else buckets.set(rawPitch[i], [p]);
  }

  // The notes in sorted order, so a walk's lookups skip the order table.
  const sorted: T[] = new Array(n);
  for (let p = 0; p < n; p += 1) sorted[p] = notes[order[p]];
  let all: Tree | null = null;
  const byPitch = new Map<number, Tree>();
  const allTree = (): Tree => {
    if (!all) {
      const pos = new Int32Array(n);
      for (let p = 0; p < n; p += 1) pos[p] = p;
      all = new Tree(pos, starts, ends);
    }
    return all;
  };
  const pitchTree = (pitch: number): Tree | null => {
    let tree = byPitch.get(pitch);
    if (tree) return tree;
    const bucket = buckets.get(pitch);
    if (!bucket) return null;
    tree = new Tree(Int32Array.from(bucket), starts, ends);
    byPitch.set(pitch, tree);
    return tree;
  };
  let placeOf: Map<T, number> | null = null;

  return {
    size: n,
    maxLength,
    pitchRange: n ? { low, high } : null,
    query(from, to) {
      const out: T[] = [];
      if (!n || !(to >= from)) return out;
      const tree = allTree();
      tree.each(from, to, (leaf) => out.push(sorted[tree.pos[leaf]]));
      return out;
    },
    queryRect(from, to, lowNote, highNote, visit) {
      if (!n || !(to >= from)) return 0;
      let count = 0;
      const top = Math.min(Math.round(highNote), high);
      const bottom = Math.max(Math.round(lowNote), low);
      let pos: Int32Array = new Int32Array(0);
      const each = (leaf: number) => {
        count += 1;
        visit(sorted[pos[leaf]]);
      };
      for (let pitch = top; pitch >= bottom; pitch -= 1) {
        const tree = pitchTree(pitch);
        if (!tree) continue;
        pos = tree.pos;
        tree.each(from, to, each);
      }
      return count;
    },
    spansInRect(from, to, lowNote, highNote, visit) {
      if (!n || !(to >= from)) return 0;
      let count = 0;
      const top = Math.min(Math.round(highNote), high);
      const bottom = Math.max(Math.round(lowNote), low);
      let s0: Float64Array = new Float64Array(0);
      let e0: Float64Array = s0;
      let pitchNow = 0;
      const each = (leaf: number) => {
        count += 1;
        visit(s0[leaf], e0[leaf], pitchNow);
      };
      for (let pitch = top; pitch >= bottom; pitch -= 1) {
        const tree = pitchTree(pitch);
        if (!tree) continue;
        s0 = tree.starts;
        e0 = tree.ends;
        pitchNow = pitch;
        tree.each(from, to, each);
      }
      return count;
    },
    hitTest(at, pitch, minLength = 0, minLengthOf) {
      if (!n || !Number.isFinite(at)) return null;
      const tree = pitchTree(Math.round(pitch));
      if (!tree) return null;
      const reach = Math.max(0, finite(minLength, 0));
      const reachOf = minLengthOf
        ? (leaf: number) => Math.min(reach, Math.max(0, finite(minLengthOf(sorted[tree.pos[leaf]]), 0)))
        : null;
      const best = tree.lastHit(at, reach, order, reachOf);
      return best < 0 ? null : notes[best];
    },
    first() {
      return n ? notes[order[0]] : null;
    },
    step(note, dir) {
      if (!placeOf) {
        placeOf = new Map();
        for (let p = 0; p < n; p += 1) placeOf.set(notes[order[p]], p);
      }
      const p = placeOf.get(note);
      if (p === undefined) return null;
      const q = p + dir;
      return q >= 0 && q < n ? notes[order[q]] : null;
    },
  };
}

const cache = new WeakMap<readonly IndexedNote[], NoteIndex<IndexedNote>>();

/** The index of `notes`, built once per list and shared by every reader of the same array. */
export function noteIndexOf<T extends IndexedNote>(notes: readonly T[]): NoteIndex<T> {
  let index = cache.get(notes);
  if (!index) {
    index = buildNoteIndex(notes);
    cache.set(notes, index);
  }
  return index as unknown as NoteIndex<T>;
}
