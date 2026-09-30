/**
 * vstStateStorage — the IndexedDB store that keeps captured VST `raw_state`
 * blobs OUT of effectChainStore's localStorage payload (FE-003).
 *
 * jsdom-less `npx tsx` has no real IndexedDB, so this suite drives a small
 * fake that implements just enough of the API (open/upgrade, a transaction
 * that completes once its request settles, get/put/delete/clear) to exercise
 * the real module unmodified — including the QuotaExceededError path
 * `effectChainStore`/`vstEditorStore` surface (FE-004).
 *
 * Run: npx tsx src/lib/vstStateStorage.test.ts
 */
import assert from 'node:assert/strict';

/* ── a minimal fake IndexedDB, installed before the module under test loads ── */

type Listener<E> = ((ev: E) => void) | null;

class FakeRequest<T = unknown> {
  result: T = undefined as T;
  error: DOMException | Error | null = null;
  onsuccess: Listener<Event> = null;
  onerror: Listener<Event> = null;
  succeed(result: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({} as Event));
  }
  fail(error: Error): void {
    this.error = error;
    queueMicrotask(() => this.onerror?.({} as Event));
  }
}

class FakeObjectStore {
  constructor(private data: Map<string, unknown>, private failNextPut: () => Error | null) {}
  get(key: string): FakeRequest {
    const req = new FakeRequest();
    req.succeed(this.data.get(key));
    return req;
  }
  put(value: unknown, key: string): FakeRequest {
    const req = new FakeRequest();
    const failure = this.failNextPut();
    if (failure) req.fail(failure);
    else {
      this.data.set(key, value);
      req.succeed(key);
    }
    return req;
  }
  delete(key: string): FakeRequest {
    const req = new FakeRequest();
    this.data.delete(key);
    req.succeed(undefined);
    return req;
  }
  clear(): FakeRequest {
    const req = new FakeRequest();
    this.data.clear();
    req.succeed(undefined);
    return req;
  }
}

class FakeTransaction {
  oncomplete: Listener<Event> = null;
  onerror: Listener<Event> = null;
  onabort: Listener<Event> = null;
  private store: FakeObjectStore;
  constructor(data: Map<string, unknown>, failNextPut: () => Error | null) {
    this.store = new FakeObjectStore(data, failNextPut);
  }
  objectStore(): FakeObjectStore {
    return this.store;
  }
  /** Simplified: any request made on this transaction settles the
   *  transaction on the same microtask turn — good enough for the module's
   *  "one request per transaction" usage. */
  _settleAfter(req: FakeRequest): void {
    queueMicrotask(() =>
      queueMicrotask(() => {
        if (req.error) {
          this.error = req.error;
          this.onabort?.({} as Event);
        } else {
          this.oncomplete?.({} as Event);
        }
      }),
    );
  }
  error: unknown = null;
}

class FakeDatabase {
  objectStoreNames = { contains: () => true };
  data = new Map<string, unknown>();
  /** Set by a test to make the NEXT `put` reject; auto-clears after firing. */
  failNextPut: Error | null = null;
  transaction(_store: string, _mode: string): FakeTransaction {
    const tx = new FakeTransaction(this.data, () => {
      const f = this.failNextPut;
      this.failNextPut = null;
      return f;
    });
    // Patch objectStore() so every request made through it also settles the tx.
    const realObjectStore = tx.objectStore.bind(tx);
    tx.objectStore = () => {
      const store = realObjectStore();
      const wrap = <A extends unknown[]>(fn: (...a: A) => FakeRequest) => (...a: A) => {
        const req = fn(...a);
        tx._settleAfter(req);
        return req;
      };
      store.get = wrap(store.get.bind(store));
      store.put = wrap(store.put.bind(store));
      store.delete = wrap(store.delete.bind(store));
      store.clear = wrap(store.clear.bind(store));
      return store;
    };
    return tx;
  }
  close(): void {}
}

const fakeDb = new FakeDatabase();

class FakeIDBOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded: Listener<Event> = null;
}

(globalThis as unknown as { indexedDB: unknown }).indexedDB = {
  open: (_name: string, _version: number) => {
    const req = new FakeIDBOpenRequest();
    // Real IDBOpenDBRequest sets `.result` to the (upgrading) database BEFORE
    // firing `onupgradeneeded`, since the upgrade callback creates the store
    // ON that db — `db.createObjectStore` in the module under test reads it.
    req.result = fakeDb;
    queueMicrotask(() => {
      req.onupgradeneeded?.({} as Event);
      req.succeed(fakeDb);
    });
    return req;
  },
};

const {
  getVstRawState,
  putVstRawState,
  deleteVstRawState,
  clearVstRawStates,
} = await import('./vstStateStorage.ts');

/* ── round trip: put, then get ────────────────────────────────────────────── */
{
  fakeDb.data.clear();
  await putVstRawState('e1', 'AAAA', 'thedaw');
  const got = await getVstRawState('e1');
  assert.deepEqual(got, { rawState: 'AAAA', stateHost: 'thedaw' });
}

/* ── a missing entry reads as null, not an empty string ──────────────────── */
{
  fakeDb.data.clear();
  assert.equal(await getVstRawState('nope'), null);
}

/* ── delete removes exactly the one entry ─────────────────────────────────── */
{
  fakeDb.data.clear();
  await putVstRawState('e1', 'A');
  await putVstRawState('e2', 'B');
  await deleteVstRawState('e1');
  assert.equal(await getVstRawState('e1'), null);
  assert.deepEqual(await getVstRawState('e2'), { rawState: 'B', stateHost: undefined });
}

/* ── clear drops everything ───────────────────────────────────────────────── */
{
  fakeDb.data.clear();
  await putVstRawState('e1', 'A');
  await putVstRawState('e2', 'B');
  await clearVstRawStates();
  assert.equal(await getVstRawState('e1'), null);
  assert.equal(await getVstRawState('e2'), null);
}

/* ── a QuotaExceededError from the underlying store REJECTS the promise,
   it is never swallowed (FE-004: the caller decides how to surface it) ──── */
{
  fakeDb.data.clear();
  fakeDb.failNextPut = new DOMException('quota', 'QuotaExceededError');
  await assert.rejects(
    () => putVstRawState('e1', 'A'),
    (err: unknown) => err instanceof DOMException && err.name === 'QuotaExceededError',
    'a quota failure must reject, not resolve silently',
  );
  assert.equal(await getVstRawState('e1'), null, 'the failed write left nothing behind');
}

console.log('vstStateStorage: ok');
