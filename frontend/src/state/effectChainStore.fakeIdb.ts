/**
 * A controllable in-memory IndexedDB for the effectChainStore / vstStateStorage
 * tests. Plain `npx tsx` has no IndexedDB, and the durability tests need what
 * a real browser can do to the store at the worst moment: a `get` or `put`
 * that has not settled yet, one that fails (QuotaExceededError, a broken
 * partition), and a `delete` that fails.
 *
 * Only the surface `vstStateStorage.ts` uses is implemented: `open` (with
 * upgrade), one request per transaction, `get` / `put` / `delete` / `clear` /
 * `getAllKeys`, and a transaction that completes (or aborts) after its request
 * settles.
 *
 * Not a test file itself (no `.test.` in the name), so the runner does not
 * execute it; the test files import it BEFORE the store under test.
 */

type Handler = ((ev: Event) => void) | null;

class FakeRequest<T = unknown> {
  result: T = undefined as T;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: Error | null = null;
  constructor(private readonly db: FakeIdb) {}
  objectStore() {
    return this.db.storeFor(this);
  }
}

export class FakeIdb {
  readonly data: Map<string, unknown>;
  /** Every operation in the order it was APPLIED (`put:e1`, `delete:e2`, …). */
  readonly ops: string[] = [];
  /** While true, `get`s wait for `releaseGets()`. */
  holdGets = false;
  /** While true, `put`s wait for `releasePuts()`. */
  holdPuts = false;
  /** Fail every `get` of these keys with this error. */
  failGetKeys = new Map<string, Error>();
  /** Fail every `put` with this error (null = succeed). */
  failPuts: Error | null = null;
  /** Fail every `delete` with this error (null = succeed). */
  failDeletes: Error | null = null;
  /** How many connections were opened / closed (one shared one is expected). */
  opens = 0;
  closes = 0;
  /** Fail every `open` with this error (null = succeed). */
  failOpen: Error | null = null;
  /** Answer every `open` with `onblocked` (another tab holds an older version). */
  blockOpen = false;
  /** With `blockOpen`, also let the open succeed afterwards. */
  openAfterBlocked = false;
  /** Delay before an `open` settles, in ms (0 = a microtask). */
  openDelayMs = 0;
  /** Delay before a `get` settles, in ms (0 = a microtask). */
  getDelayMs = 0;
  /** Throw this from `db.transaction()` (a connection closed under us). */
  throwOnTransaction: Error | null = null;
  private heldGets: (() => void)[] = [];
  private heldPuts: (() => void)[] = [];

  constructor(seed: [string, unknown][] = []) {
    this.data = new Map(seed);
  }

  /** Let every held `get` settle. */
  releaseGets(): void {
    this.holdGets = false;
    const run = this.heldGets;
    this.heldGets = [];
    for (const f of run) f();
  }

  /** Let every held `put` settle. */
  releasePuts(): void {
    this.holdPuts = false;
    const run = this.heldPuts;
    this.heldPuts = [];
    for (const f of run) f();
  }

  /** Install as `globalThis.indexedDB`. */
  install(): void {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = {
      open: () => {
        this.opens += 1;
        const req = new (class extends FakeRequest<unknown> {
          onupgradeneeded: Handler = null;
          onblocked: Handler = null;
        })();
        const finishOpen = () => {
          if (this.blockOpen) {
            req.onblocked?.({} as Event);
            // A blocking tab that closes lets the open go through after all —
            // which is exactly the connection nobody is tracking.
            if (this.openAfterBlocked) {
              req.result = this.database();
              req.onsuccess?.({} as Event);
            }
            return;
          }
          if (this.failOpen) {
            req.error = this.failOpen;
            req.onerror?.({} as Event);
            return;
          }
          req.result = this.database();
          req.onupgradeneeded?.({} as Event);
          req.onsuccess?.({} as Event);
        };
        if (this.openDelayMs > 0) setTimeout(finishOpen, this.openDelayMs);
        else queueMicrotask(finishOpen);
        return req;
      },
    };
  }

  /** Every connection handed out, so a test can fire `onclose` /
   *  `onversionchange` the way a browser does. */
  readonly dbHandles: { onclose: Handler; onversionchange: Handler; close: () => void }[] = [];

  private database() {
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore: () => undefined,
      onclose: null as Handler,
      onversionchange: null as Handler,
      transaction: () => {
        if (this.throwOnTransaction) throw this.throwOnTransaction;
        return new FakeTransaction(this);
      },
      close: () => {
        this.closes += 1;
      },
    };
    this.dbHandles.push(db);
    return db;
  }

  /** Settle `req` (and then its transaction) with a value or an error. */
  private settle(tx: FakeTransaction, req: FakeRequest, outcome: { value?: unknown; error?: Error }): void {
    queueMicrotask(() => {
      if (outcome.error) {
        req.error = outcome.error;
        req.onerror?.({} as Event);
        queueMicrotask(() =>
          queueMicrotask(() => {
            tx.error = outcome.error ?? null;
            tx.onabort?.({} as Event);
          }),
        );
        return;
      }
      req.result = outcome.value;
      req.onsuccess?.({} as Event);
      queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.({} as Event)));
    });
  }

  storeFor(tx: FakeTransaction) {
    return {
      get: (key: string) => {
        const req = new FakeRequest();
        const run = () => {
          const failure = this.failGetKeys.get(key);
          if (failure) this.settle(tx, req, { error: failure });
          else {
            this.ops.push(`get:${key}`);
            this.settle(tx, req, { value: this.data.get(key) });
          }
        };
        if (this.holdGets) this.heldGets.push(run);
        else if (this.getDelayMs > 0) setTimeout(run, this.getDelayMs);
        else run();
        return req;
      },
      put: (value: unknown, key: string) => {
        const req = new FakeRequest();
        const run = () => {
          if (this.failPuts) this.settle(tx, req, { error: this.failPuts });
          else {
            this.data.set(key, value);
            this.ops.push(`put:${key}`);
            this.settle(tx, req, { value: key });
          }
        };
        if (this.holdPuts) this.heldPuts.push(run);
        else run();
        return req;
      },
      delete: (key: string) => {
        const req = new FakeRequest();
        if (this.failDeletes) this.settle(tx, req, { error: this.failDeletes });
        else {
          this.data.delete(key);
          this.ops.push(`delete:${key}`);
          this.settle(tx, req, { value: undefined });
        }
        return req;
      },
      clear: () => {
        const req = new FakeRequest();
        this.data.clear();
        this.ops.push('clear');
        this.settle(tx, req, { value: undefined });
        return req;
      },
      getAllKeys: () => {
        const req = new FakeRequest();
        this.settle(tx, req, { value: [...this.data.keys()] });
        return req;
      },
    };
  }
}

/** An in-memory `localStorage`, installed on `globalThis` and `window` (the
 *  persist middleware reads `window.localStorage`). Returns the backing map. */
export function installLocalStorage(): Map<string, string> {
  const mem = new Map<string, string>();
  const storage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  } as Storage;
  const g = globalThis as unknown as { localStorage: Storage; window?: { localStorage: Storage } };
  g.localStorage = storage;
  if (typeof g.window === 'undefined') g.window = { localStorage: storage };
  return mem;
}

/** Let queued microtasks and zero-delay timers run. */
export const tick = (n = 1): Promise<void> =>
  new Promise((resolve) => {
    let left = n;
    const step = () => (--left <= 0 ? resolve() : setTimeout(step, 0));
    setTimeout(step, 0);
  });

/** Poll (bounded) until `predicate` holds. */
export async function waitUntil(predicate: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i++) await tick();
}

export const STORE_KEY = 'thedaw-effect-chain';
