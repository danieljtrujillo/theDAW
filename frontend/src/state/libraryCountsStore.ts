/**
 * The library's five category counts (tracks / stems / MIDI / video / score).
 *
 * The tab strip used to print the length of each sub-tab's own array, which
 * only existed once that sub-tab had been visited, so four of the five counts
 * read `…` until the user clicked them. This store holds ONE snapshot fetched
 * from `GET /api/library/summary`: loaded at boot with the library itself and
 * re-fetched whenever a committed mutation could have changed it.
 *
 * Freshness rules, ported from docs/design/repair-pack/repair/src/libraryCounts.ts:
 *   - every request carries a sequence number; a response whose sequence is no
 *     longer the current one is dropped, so a slow OLD answer can never
 *     overwrite a newer one (the backend's `revision` guards the same thing
 *     from the other end);
 *   - a failed refresh KEEPS the last good counts and records the error — a
 *     stale number beats no number;
 *   - a payload that is not five non-negative integers plus a revision is
 *     refused rather than half-rendered;
 *   - `invalidate()` coalesces bursts: one request in flight, at most one
 *     queued behind it, however many mutations land meanwhile;
 *   - a 503 that says the library is still opening (`library_status`) is
 *     status `opening`, not `error`: the tabs keep `…` and show no Retry
 *     button, and the progress store asks again once the library has opened.
 *
 * DOM-free and store-free: only `fetch` + zustand.
 */

import { create } from 'zustand';
import { openingErrorFrom } from '../lib/libraryIndexStatus';

/** The summary endpoint. Counts come from one consistent read server-side. */
const SUMMARY_URL = '/api/library/summary';

export type LibraryCountKey = 'tracks' | 'stems' | 'midi' | 'video' | 'score';
export type LibraryCounts = Record<LibraryCountKey, number>;

/** The five categories, in tab-strip order. */
export const LIBRARY_COUNT_KEYS: readonly LibraryCountKey[] = [
  'tracks',
  'stems',
  'midi',
  'video',
  'score',
];

export type LibraryCountsStatus = 'idle' | 'loading' | 'ready' | 'opening' | 'error';

export interface LibraryCountsState {
  /** The last good snapshot, or null while none has ever arrived. */
  counts: LibraryCounts | null;
  /** The DB revision `counts` was read at; 0 before the first snapshot. */
  revision: number;
  status: LibraryCountsStatus;
  /** The last failure's message; null once a load succeeds. */
  error: string | null;
  /** Fetch a fresh snapshot now. Never rejects. */
  load: () => Promise<void>;
  /** Ask for a refresh after a mutation; coalesces with one already running. */
  invalidate: () => void;
}

interface CountSnapshot {
  revision: number;
  counts: LibraryCounts;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Throw unless `raw` is `{revision, counts}` with five non-negative integers. */
const parseSnapshot = (raw: unknown): CountSnapshot => {
  if (!raw || typeof raw !== 'object') throw new Error('summary payload is not an object');
  const body = raw as { revision?: unknown; counts?: unknown };
  if (!isCount(body.revision)) throw new Error('summary payload has no usable revision');
  if (!body.counts || typeof body.counts !== 'object') {
    throw new Error('summary payload has no counts');
  }
  const raws = body.counts as Record<string, unknown>;
  const counts = {} as LibraryCounts;
  for (const key of LIBRARY_COUNT_KEYS) {
    const value = raws[key];
    if (!isCount(value)) throw new Error(`summary count "${key}" is not a non-negative integer`);
    counts[key] = value;
  }
  return { revision: body.revision, counts };
};

// Request bookkeeping lives outside the store: it is plumbing, not state any
// component renders. `seq` only ever grows, so the comparison in load() is
// safe; `inFlight` + `queued` are the whole coalescing rule.
let seq = 0;
let inFlight: Promise<void> | null = null;
let queued = false;
let controller: AbortController | null = null;

export const useLibraryCounts = create<LibraryCountsState>()((set, get) => ({
  counts: null,
  revision: 0,
  status: 'idle',
  error: null,

  load: () => {
    const mine = ++seq;
    // Abort the previous request: its answer is already worthless, and the
    // sequence check below drops it even if the abort loses the race.
    controller?.abort();
    const ctrl = new AbortController();
    controller = ctrl;
    set({ status: 'loading', error: null });

    const run: Promise<void> = (async () => {
      try {
        const res = await fetch(SUMMARY_URL, { signal: ctrl.signal });
        if (!res.ok) {
          const opening = await openingErrorFrom(res);
          if (opening) {
            if (mine === seq) set({ status: 'opening', error: null });
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const snapshot = parseSnapshot(await res.json());
        if (mine !== seq) return;
        const current = get();
        if (current.counts === null || snapshot.revision >= current.revision) {
          set({ counts: snapshot.counts, revision: snapshot.revision });
        }
        set({ status: 'ready', error: null });
      } catch (e) {
        if (mine !== seq) return;
        // The counts themselves are left alone: the last good numbers stay on
        // screen next to the error.
        set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    })().finally(() => {
      if (inFlight !== run) return;
      inFlight = null;
      if (queued) {
        queued = false;
        void get().load();
      }
    });
    inFlight = run;
    return run;
  },

  invalidate: () => {
    if (inFlight) {
      queued = true;
      return;
    }
    void get().load();
  },
}));
