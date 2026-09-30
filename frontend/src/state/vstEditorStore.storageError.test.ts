/**
 * vstEditorStore surfaces a failed VST state save (FE-004).
 *
 * Moving `raw_state` out of effectChainStore's localStorage payload and into
 * IndexedDB (FE-003, `vstStateStorage.ts`) means the write can now fail on
 * its own terms — most notably `QuotaExceededError`. Before this, that
 * failure had no listener anywhere: an unhandled promise rejection nobody
 * saw, and the user's dialed-in plugin state simply would not survive a
 * reload with no indication why. This pins that a failure reaches BOTH the
 * status bar (always) and the open editor's own `error` (when the failing
 * entry is the one currently shown).
 *
 * Run: npx tsx src/state/vstEditorStore.storageError.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* ── window/localStorage shim, installed BEFORE any store import rehydrates
   (same constraint as vstEditorStore.live.test.ts / effectChainStore.test.ts) ── */
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
const windowCore: Record<string, unknown> = {
  localStorage: storage,
  devicePixelRatio: 1,
  setInterval,
  clearInterval,
  setTimeout,
  clearTimeout,
};
const windowShim = new Proxy(windowCore, {
  get: (target, prop, receiver) =>
    Reflect.has(target, prop) ? Reflect.get(target, prop, receiver) : () => undefined,
});
const g = globalThis as unknown as { localStorage?: Storage; window?: unknown };
if (typeof g.window === 'undefined') {
  g.localStorage = storage;
  g.window = windowShim;
}
(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
  throw new Error('network disabled in this test');
}) as typeof fetch;

/* ── a fake IndexedDB whose next `put` can be told to fail ────────────────── */
class FakeRequest<T = unknown> {
  result: T = undefined as T;
  onsuccess: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  succeed(result: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({} as Event));
  }
  fail(error: Error): void {
    (this as unknown as { error: Error }).error = error;
    queueMicrotask(() => this.onerror?.({} as Event));
  }
}
let failNextPut: Error | null = null;
let failNextDelete: Error | null = null;
const idbData = new Map<string, unknown>();
class FakeDb {
  objectStoreNames = { contains: () => true };
  transaction() {
    const store = {
      get: (k: string) => {
        const r = new FakeRequest();
        r.succeed(idbData.get(k));
        return r;
      },
      put: (v: unknown, k: string) => {
        const r = new FakeRequest();
        const failure = failNextPut;
        failNextPut = null;
        if (failure) r.fail(failure);
        else {
          idbData.set(k, v);
          r.succeed(k);
        }
        return r;
      },
      delete: (k: string) => {
        const r = new FakeRequest();
        const failure = failNextDelete;
        failNextDelete = null;
        if (failure) r.fail(failure);
        else {
          idbData.delete(k);
          r.succeed(undefined);
        }
        return r;
      },
      clear: () => {
        const r = new FakeRequest();
        idbData.clear();
        r.succeed(undefined);
        return r;
      },
    };
    const tx = {
      oncomplete: null as ((ev: Event) => void) | null,
      onerror: null as ((ev: Event) => void) | null,
      onabort: null as ((ev: Event) => void) | null,
      error: null as unknown,
      objectStore: () => store,
    };
    const wrap = <A extends unknown[]>(fn: (...a: A) => FakeRequest) => (...a: A) => {
      const req = fn(...a);
      queueMicrotask(() =>
        queueMicrotask(() => {
          if ((req as unknown as { error?: Error }).error) {
            tx.error = (req as unknown as { error: Error }).error;
            tx.onabort?.({} as Event);
          } else {
            tx.oncomplete?.({} as Event);
          }
        }),
      );
      return req;
    };
    store.get = wrap(store.get);
    store.put = wrap(store.put);
    store.delete = wrap(store.delete);
    store.clear = wrap(store.clear);
    return tx;
  }
  close() {}
}
const fakeDb = new FakeDb();
(globalThis as unknown as { indexedDB: unknown }).indexedDB = {
  open: () => {
    const req = new (class extends FakeRequest<FakeDb> {
      onupgradeneeded: ((ev: Event) => void) | null = null;
    })();
    req.result = fakeDb;
    queueMicrotask(() => {
      req.onupgradeneeded?.({} as Event);
      req.succeed(fakeDb);
    });
    return req;
  },
};

const { useEffectChainStore } = await import('./effectChainStore.ts');
const { useVstEditorStore } = await import('./vstEditorStore.ts');
const { useStatusBarStore } = await import('./statusBarStore.ts');

await new Promise<void>((resolve) => {
  if (useEffectChainStore.persist.hasHydrated()) resolve();
  else useEffectChainStore.persist.onFinishHydration(() => resolve());
});

const waitFor = async (predicate: () => boolean, tries = 20): Promise<void> => {
  for (let i = 0; i < tries && !predicate(); i++) await new Promise((r) => setTimeout(r, 0));
};

/* ── a QuotaExceededError while capturing state reaches the status bar ────── */
{
  useEffectChainStore.setState({ chain: [] });
  useEffectChainStore.getState().addVst({ plugin_path: 'C:/plugins/Ozone 11.vst3', plugin_name: 'Ozone 11' });
  const id = useEffectChainStore.getState().chain[0].id;

  failNextPut = new DOMException('quota', 'QuotaExceededError');
  useStatusBarStore.getState().setText('');
  useEffectChainStore.getState().setVstRawState(id, 'BIG-STATE', 'thedaw');

  await waitFor(() => useStatusBarStore.getState().text.includes('failed to save'));
  const text = useStatusBarStore.getState().text;
  assert.ok(text.includes('failed to save'), `status bar should report the failure, got: ${text}`);
  assert.ok(
    /quota/i.test(text),
    `a QuotaExceededError should be named, not a generic message, got: ${text}`,
  );
  assert.ok(!/try again/i.test(text), `nothing retries, so the message must not say "try again", got: ${text}`);
  // The in-memory capture is NOT lost even though the persist write failed —
  // the render/process path and a same-session reopen still see it.
  assert.equal(useEffectChainStore.getState().chain[0].vst?.raw_state, 'BIG-STATE');
}

/* ── and it reaches the open editor's own `error`, when that entry is open ── */
{
  useEffectChainStore.setState({ chain: [] });
  useEffectChainStore.getState().addVst({ plugin_path: 'C:/plugins/Vinyl.vst3', plugin_name: 'Vinyl' });
  const id = useEffectChainStore.getState().chain[0].id;
  useVstEditorStore.setState({ entryId: id, error: null });

  failNextPut = new DOMException('quota', 'QuotaExceededError');
  useEffectChainStore.getState().setVstRawState(id, 'STATE', 'thedaw');

  await waitFor(() => useVstEditorStore.getState().error !== null);
  assert.match(useVstEditorStore.getState().error ?? '', /quota/i);

  // A different entry's failure must not paint over an unrelated open editor.
  useEffectChainStore.getState().addVst({ plugin_path: 'C:/plugins/Other.vst3', plugin_name: 'Other' });
  const otherId = useEffectChainStore.getState().chain[1].id;
  useVstEditorStore.setState({ error: null });
  failNextPut = new DOMException('quota', 'QuotaExceededError');
  useEffectChainStore.getState().setVstRawState(otherId, 'X', 'thedaw');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(useVstEditorStore.getState().error, null, 'a different entry failing does not touch this one');
}

/* ── a failed delete is worded as a delete, not a save ────────────────────── */
{
  useEffectChainStore.setState({ chain: [] });
  useEffectChainStore.getState().addVst({ plugin_path: 'C:/plugins/Gone.vst3', plugin_name: 'Gone' });
  const id = useEffectChainStore.getState().chain[0].id;
  useStatusBarStore.getState().setText('');
  failNextDelete = new Error('disk gone');
  useEffectChainStore.getState().removeEffect(id);
  await waitFor(() => useStatusBarStore.getState().text !== '');
  const text = useStatusBarStore.getState().text;
  assert.match(text, /could not delete stored plugin state/, `delete wording, got: ${text}`);
  assert.match(text, /disk gone/);
  assert.ok(!/save/i.test(text), `a delete failure must not claim a save failed, got: ${text}`);
}

/* ── the handler is installed BELOW create() (T18 re-audit, MINOR 5): the
   handler replays queued failures through `useVstEditorStore`, which would be
   a ReferenceError if the install ran before the store existed — as it does
   the moment this module is loaded lazily ─────────────────────────────────── */
{
  const src = readFileSync(new URL('./vstEditorStore.ts', import.meta.url), 'utf8');
  const install = src.indexOf('setVstStateStorageErrorHandler((entryId, error, op)');
  const create = src.indexOf('export const useVstEditorStore = create<VstEditorState>()');
  assert.ok(install > 0 && create > 0, 'both the install and the store creation must still exist');
  assert.ok(install > create, 'the storage-error handler must be installed after the store is created');
}

useEffectChainStore.setState({ chain: [] });
console.log('vstEditorStore.storageError: ok');
