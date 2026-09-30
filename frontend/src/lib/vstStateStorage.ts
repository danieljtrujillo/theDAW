/**
 * IndexedDB-backed storage for captured VST3 plugin `raw_state` blobs, keyed
 * by MIX chain entry id.
 *
 * `raw_state` is a base64 capture of a plugin's full parameter state — for
 * some plugins several hundred KB, occasionally low-MB. `effectChainStore`'s
 * `persist` middleware re-serializes its WHOLE partialized state into
 * localStorage on every store update, so keeping `raw_state` inline in the
 * persisted chain meant every knob move and every periodic live-editor
 * capture tick re-wrote every loaded plugin's full state blob back into
 * localStorage — quickly exceeding its ~5-10MB quota with more than a couple
 * of heavy plugins loaded (FE-003).
 *
 * Moving the blob here keeps localStorage holding only small, structured data
 * (chain order, params, plugin identity) while the actual state blob lives in
 * IndexedDB, written and read back on demand, keyed by the (stable) chain
 * entry id — modeled on `mediaBucketPersistence.ts`'s blob store.
 */

import type { ChainEntry } from '../state/effectChainStore';

/** What is stored per entry id: the blob and which host produced it (see
 *  `VstStateHost` in `effectChainStore.ts` — mirrored here as a plain string
 *  so this module has no runtime dependency on that store; the `ChainEntry`
 *  import above is type-only and erased). */
export interface StoredVstState {
  rawState: string;
  stateHost?: string;
}

/*
 * The startup-load signal. `effectChainStore` loads every MIX entry's saved
 * state back from this database right after hydration and settles the signal
 * once every one of those reads has finished; it also installs the lookup that
 * returns an entry as it is now. They live HERE, in a module with no runtime
 * imports, so the live plugin node (`vstLive/vstLiveNode.ts`) can wait on them
 * without importing `effectChainStore` — that store imports `rackEffects`,
 * which imports the node, and the cycle broke module initialization.
 */
let statesLoaded = false;
let statesLoading = false;
let resolveStatesLoaded: () => void = () => {};
/** Settles once every startup read of a saved plugin state has finished
 *  (success or failure). Re-exported by `effectChainStore`, which settles it
 *  while it initializes. */
export const vstStatesLoaded: Promise<void> = new Promise((resolve) => {
  resolveStatesLoaded = resolve;
});
/** False only while startup reads are in flight. True before
 *  `effectChainStore` has even loaded: with no store there are no MIX entries
 *  and nothing of theirs can be loading, so nothing needs to wait. */
export const areVstStatesLoaded = (): boolean => !statesLoading;
/** Startup reads have begun (called by `effectChainStore`). */
export function beginVstStatesLoad(): void {
  if (!statesLoaded) statesLoading = true;
}
/** Settle `vstStatesLoaded` (called once, by `effectChainStore`). */
export function markVstStatesLoaded(): void {
  statesLoading = false;
  if (statesLoaded) return;
  statesLoaded = true;
  resolveStatesLoaded();
}

/** The chain entry as it is now, by id, wherever it lives: the MIX chain
 *  (whose startup load `vstStatesLoaded` covers), a track's `fxChain`, or
 *  `masterVstChain`. `undefined` for an id in none of them. Used to be MIX-
 *  only, which left `sessionRegistry.recreate()`'s re-read of a track or
 *  master entry inert -- it always got `undefined` and fell through to the
 *  stale `slot.entry`, silently discarding captures recorded since the last
 *  chain rebuild on every respawn (T18 seventh audit, MAJOR 2). */
export type LoadedVstEntryLookup = (entryId: string) => ChainEntry | undefined;
let loadedEntryLookup: LoadedVstEntryLookup = () => undefined;
/** Installed by `effectChainStore`. */
export function setLoadedVstEntryLookup(lookup: LoadedVstEntryLookup): void {
  loadedEntryLookup = lookup;
}
/** The entry `entryId` as it is now (a MIX entry after `vstStatesLoaded`,
 *  with its loaded state; a track or master entry as the live chain holds
 *  it), or `undefined` when it is in none of the three chains. */
export const loadedVstEntry = (entryId: string): ChainEntry | undefined => loadedEntryLookup(entryId);

/** Is this entry's saved state one nobody could read? Installed by
 *  `effectChainStore`; lives here so the session registry can ask without
 *  importing that store (the rackEffects cycle). */
export type VstStateUnresolvedLookup = (entryId: string) => boolean;
let unresolvedLookup: VstStateUnresolvedLookup = () => false;
/** Installed by `effectChainStore`. */
export function setVstStateUnresolvedLookup(lookup: VstStateUnresolvedLookup): void {
  unresolvedLookup = lookup;
}
/**
 * True when this entry's saved state could not be read, so anything spawned
 * for it was handed NOTHING and is running at its factory defaults. The
 * session registry asks this before it claims a fresh spawn holds the entry's
 * state (T18 fourth audit, MAJOR 3).
 */
export const isVstStateUnresolvedFor = (entryId: string): boolean => unresolvedLookup(entryId);

const DB_NAME = 'thedaw-vst-state';
const DB_VERSION = 1;
const STORE = 'rawState';

/**
 * ONE connection for the whole module, opened on first use.
 *
 * Transactions created on the same connection run in the order they were
 * created; transactions on DIFFERENT connections have no such order, so a
 * connection per call meant two captures of one plugin could commit in either
 * order and the OLDER one could win (T18 re-audit, MINOR 8).
 */
let dbPromise: Promise<IDBDatabase> | null = null;
/** The handle `dbPromise` resolved to, so the cache is only ever dropped for
 *  THE connection that went away — never one another caller just opened. */
let cachedDb: IDBDatabase | null = null;

/**
 * A store operation that did not answer in time. NOT the same as a failed
 * read: a slow store is not an unreadable row, so the caller keeps refusing
 * captures rather than claiming the saved state is gone.
 */
export class VstStateStoreTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`the plugin-state store did not answer the ${what} within ${ms} ms`);
    this.name = 'VstStateStoreTimeoutError';
  }
}

/** How long the shared connection may take to open. One open, one budget. */
export let VST_STATE_OPEN_TIMEOUT_MS = 8000;
/** How long ONE request may take, armed when its transaction is created — not
 *  when the caller asked, so a queue of reads does not share one budget
 *  (T18 third audit, MAJOR 3). */
export let VST_STATE_TX_TIMEOUT_MS = 5000;
/** Test seam: the suites drive real timers and cannot wait out the real
 *  budgets. The app never calls this. */
export function __setVstStateStoreTimeoutsForTest(ms: { openMs?: number; txMs?: number }): void {
  if (ms.openMs !== undefined) VST_STATE_OPEN_TIMEOUT_MS = ms.openMs;
  if (ms.txMs !== undefined) VST_STATE_TX_TIMEOUT_MS = ms.txMs;
}

/** Reject with a {@link VstStateStoreTimeoutError} if `p` has not settled in
 *  `ms`. The timer never holds the page (or a test process) open by itself. */
const withTimeout = <T,>(p: Promise<T>, what: string, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new VstStateStoreTimeoutError(what, ms)), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

/** Names IndexedDB uses when the CONNECTION itself is gone (as opposed to one
 *  request failing on a healthy connection). */
const CONNECTION_GONE = new Set(['InvalidStateError', 'NotFoundError', 'InvalidAccessError']);
const isConnectionGone = (err: unknown): boolean =>
  err instanceof DOMException ? CONNECTION_GONE.has(err.name) : false;

/** Drop the cached connection, but only if it is still the one that failed. */
const forgetConnection = (db: IDBDatabase): void => {
  if (cachedDb !== db) return;
  cachedDb = null;
  dbPromise = null;
};

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  // Set when the BOUNDED wait below times out while `req` is still pending:
  // the underlying open is not cancelled by that timeout (IndexedDB has no
  // cancel), so it can still reach `onsuccess` afterward. Nothing is waiting
  // on it by then and `forgetConnection` has no way to find it — the same
  // leak `blocked` already guards against, for the timeout case (T18 fifth
  // audit, NOTE 5).
  let timedOut = false;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    // No IndexedDB at all (disabled, a sandboxed frame): reject with a message
    // a user can read rather than a bare ReferenceError. The caller keeps the
    // state inline in localStorage (see effectChainStore's partialize).
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    // Another tab is holding an older version open: without this the open
    // never settles, and every caller waiting on it waits for the session.
    req.onblocked = () => {
      blocked = true;
      reject(new Error('IndexedDB is blocked by another tab of this app - close it and reload'));
    };
    req.onsuccess = () => {
      const db = req.result;
      // The blocking tab closed and the open went through after all. Nobody
      // is waiting for this handle any more (the promise already rejected),
      // so close it rather than leaking a connection that would itself block
      // the next upgrade (T18 third audit, MINOR 7).
      if (blocked) {
        db.close();
        return;
      }
      // Same story when the BOUNDED wait gave up first: this handle arrived
      // too late for anyone to cache or ever close later.
      if (timedOut) {
        db.close();
        return;
      }
      // The connection can be taken away (another tab upgrades, the browser
      // evicts it). Drop the cached one so the next call opens a fresh one
      // instead of using a handle that throws on every transaction.
      db.onclose = () => forgetConnection(db);
      db.onversionchange = () => {
        forgetConnection(db);
        db.close();
      };
      cachedDb = db;
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
  const bounded = withTimeout(opening, 'open', VST_STATE_OPEN_TIMEOUT_MS).catch((err: unknown) => {
    if (err instanceof VstStateStoreTimeoutError) timedOut = true;
    // A failed (or timed-out) open is never cached: the next call tries again.
    if (dbPromise === bounded) {
      dbPromise = null;
      cachedDb = null;
    }
    throw err;
  });
  dbPromise = bounded;
  return bounded;
};

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

/** One request in its own transaction on the shared connection, resolved with
 *  the request's result once the transaction has COMMITTED. */
async function runTx<T>(
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest,
  failure: string,
): Promise<T> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, mode);
    const req = request(tx.objectStore(STORE));
    // The budget starts HERE, where the work actually starts — not when the
    // caller asked, which on a cold start is behind a shared open and every
    // request queued before this one.
    const settled = new Promise<T>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error ?? new Error(failure));
    }).then(async (value) => {
      await txDone(tx);
      return value;
    });
    return await withTimeout(settled, mode === 'readonly' ? 'read' : 'write', VST_STATE_TX_TIMEOUT_MS);
  } catch (err) {
    // Only a connection that is GONE is dropped. An ordinary request failure
    // (a QuotaExceededError, an aborted transaction) leaves a healthy shared
    // connection in place — throwing it away would throw the commit ordering
    // away with it (T18 third audit, MAJOR 4).
    if (isConnectionGone(err)) forgetConnection(db);
    throw err;
  }
}

/** Read a captured raw_state back, or `null` when nothing is stored for this
 *  entry id (a plugin still at its defaults, or one whose state lives inline
 *  in a not-yet-migrated legacy chain — see `effectChainStore.ts`'s
 *  `migrate`). */
export async function getVstRawState(entryId: string): Promise<StoredVstState | null> {
  const result = await runTx<StoredVstState | undefined>(
    'readonly',
    (store) => store.get(entryId),
    'Failed to read VST state',
  );
  return result && typeof result.rawState === 'string' ? result : null;
}

/** Store (or replace) the captured raw_state for a chain entry id. Rejects on
 *  failure — most notably `QuotaExceededError` — so a caller that awaits or
 *  `.catch()`es this never silently loses a capture; see `effectChainStore`'s
 *  `setVstRawState` and `vstEditorStore`'s storage-error surfacing. */
export async function putVstRawState(entryId: string, rawState: string, stateHost?: string): Promise<void> {
  const record: StoredVstState = { rawState, stateHost };
  await runTx('readwrite', (store) => store.put(record, entryId), 'Failed to save VST state');
}

/** Drop a single entry's stored state (an entry was removed from the chain). */
export async function deleteVstRawState(entryId: string): Promise<void> {
  await runTx('readwrite', (store) => store.delete(entryId), 'Failed to delete VST state');
}

/** Every entry id that has a stored state — the startup GC in
 *  `effectChainStore` compares it with the hydrated chain. */
export async function listVstRawStateIds(): Promise<string[]> {
  const keys = await runTx<IDBValidKey[]>(
    'readonly',
    (store) => store.getAllKeys(),
    'Failed to list VST states',
  );
  return keys.filter((k): k is string => typeof k === 'string');
}

/** Drop every stored state. NOT for clearing one chain: other open tabs share
 *  this database, so `effectChainStore.clearChain` deletes its own ids only. */
export async function clearVstRawStates(): Promise<void> {
  await runTx('readwrite', (store) => store.clear(), 'Failed to clear VST states');
}
