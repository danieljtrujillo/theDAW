/**
 * Batch-12 T16 audit follow-ups for mediaBucketStore.hydrate():
 *
 *   1. (MINOR #7, 1st audit) — `hydrate()` had no guard against running
 *      twice. `SlidePanel.tsx` now calls it (alongside the pre-existing
 *      `MediaBucketView.tsx` caller) — two independent mount sites can both
 *      see `hydrated === false` and both kick off the full IndexedDB read +
 *      meta rewrite, racing each other. Fixed by sharing the in-flight
 *      promise across concurrent callers and short-circuiting once
 *      `hydrated` is already true.
 *   2. (MINOR #2, 2nd audit, THE REMAINING BUG) — the fix above still
 *      replaced `items`/meta from the `restored` snapshot built BEFORE
 *      hydrate's awaits. An `add()` landing while hydrate is still awaiting
 *      `getBucketBlob` (e.g. trackMenuActions.ts:495, which does not await
 *      hydrate) got silently overwritten by `set({ items: restored, ... })`,
 *      and that item's already-written blob became an orphan nothing
 *      references. Fixed by merging: anything present in the live store at
 *      the moment hydrate finishes, that ISN'T already in `restored`, is kept
 *      — and the saved meta reflects the merged list, not just `restored`.
 *   3. (MINOR #4, 2nd audit) — hydrate must be retryable after a rejection:
 *      the in-flight promise is cleared in a `finally`, so a failed hydrate
 *      doesn't permanently wedge every future caller behind a cached
 *      rejection.
 *
 * `../lib/mediaBucketPersistence` talks to real `window.localStorage` /
 * `indexedDB`, neither of which exist in plain Node. This file registers a
 * `resolve` hook (Node's `module.register()` customization hooks, verified
 * against the Node.js docs before use — see SlidePanel.b12.test.ts for the
 * same technique applied to a `.css` import) that redirects
 * `../lib/mediaBucketPersistence` to an inline fake module, driven through
 * `globalThis.__mbpMock` so the test can control timing (an awaitable
 * "gate") and inspect every call. The redirected module still executes in
 * the MAIN thread (verified empirically), so it freely shares `globalThis`
 * with this test file.
 *
 * Each scenario dynamically imports `mediaBucketStore.ts` with a distinct
 * `?scenario=` query string — Node's ESM loader caches modules per resolved
 * URL, so each query gives a truly fresh module instance (fresh zustand
 * store, fresh module-level `hydratePromise`), letting each scenario exercise
 * hydrate() from a clean, unhydrated state without one scenario's completed
 * hydration leaking into the next (verified empirically before use).
 *
 * Run: `npx tsx src/state/mediaBucketStore.b12.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';

const hookSrc = `
export async function resolve(specifier, context, nextResolve) {
  // tsx's own hook rewrites relative specifiers to add a .ts extension
  // before this hook sees them (verified empirically), so match by
  // substring rather than an exact suffix.
  if (specifier.includes('mediaBucketPersistence')) {
    return { url: 'data:text/javascript,' + encodeURIComponent(FAKE_SOURCE), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`.replace(
  'FAKE_SOURCE',
  JSON.stringify(`
    export function loadBucketMeta() {
      return (globalThis.__mbpMock.meta || []).slice();
    }
    export function saveBucketMeta(items) {
      globalThis.__mbpMock.saveCalls.push(items);
    }
    export async function getBucketBlob(id) {
      if (globalThis.__mbpMock.rejectGetBlob) {
        throw new Error(globalThis.__mbpMock.rejectMessage || 'mock getBucketBlob failure');
      }
      await globalThis.__mbpMock.gate;
      return (globalThis.__mbpMock.blobs || {})[id] ?? null;
    }
    export async function putBucketBlob(id, blob) {
      globalThis.__mbpMock.putCalls.push({ id, blob });
    }
    export async function deleteBucketBlob(id) {
      globalThis.__mbpMock.deleteCalls.push(id);
    }
    export async function clearBucketBlobs() {
      globalThis.__mbpMock.clearCalls.push(true);
    }
  `),
);
register(`data:text/javascript,${encodeURIComponent(hookSrc)}`, import.meta.url);

/**
 * Imports mediaBucketStore.ts with a cache-busting query so each scenario
 * gets a fresh module instance (fresh zustand store, fresh module-level
 * `hydratePromise` — verified empirically before use, see file header). A
 * template-literal specifier (not a string literal) so `tsc` doesn't attempt
 * static module resolution against a query string it can't parse (verified
 * empirically before use); the `typeof import(...)` cast on the real,
 * query-free path keeps the result properly typed.
 */
const importFreshStore = (scenario: string) =>
  import(`./mediaBucketStore.ts?scenario=${scenario}`) as Promise<typeof import('./mediaBucketStore.ts')>;

const freshMock = (overrides: Record<string, unknown> = {}) => {
  (globalThis as unknown as { __mbpMock: Record<string, unknown> }).__mbpMock = {
    meta: [],
    blobs: {},
    gate: Promise.resolve(),
    rejectGetBlob: false,
    rejectMessage: '',
    saveCalls: [] as unknown[],
    putCalls: [] as unknown[],
    deleteCalls: [] as unknown[],
    clearCalls: [] as unknown[],
    ...overrides,
  };
};

const fakeBlob = (tag: string) => ({ __tag: tag } as unknown as Blob);

async function main(): Promise<void> {
  /* ------------------------------ Scenario A: idempotency ------------------------------ */
  {
    freshMock();
    const { useMediaBucketStore } = await importFreshStore('idempotency');
    const store = useMediaBucketStore;

    assert.equal(store.getState().hydrated, false, 'starts unhydrated');

    // Two "concurrent mount sites" (SlidePanel + MediaBucketView) both call
    // hydrate() before either has resolved.
    const p1 = store.getState().hydrate();
    const p2 = store.getState().hydrate();
    await Promise.all([p1, p2]);

    assert.equal(store.getState().hydrated, true, 'hydrated after both calls resolve');
    const mock = (globalThis as unknown as { __mbpMock: { saveCalls: unknown[] } }).__mbpMock;
    assert.equal(mock.saveCalls.length, 1, 'the underlying meta-save work ran exactly once for two concurrent callers (THE BUG ran it twice)');

    // A third call, after hydration already completed, is a pure no-op.
    await store.getState().hydrate();
    assert.equal(mock.saveCalls.length, 1, 'a call after hydration is already done does no further work');
  }

  /* ------------------------------ Scenario B: add() during in-flight hydrate (audit #2) ------------------------------ */
  {
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
    freshMock({
      meta: [{ id: 'existing-1', name: 'existing.mp4', mimeType: 'video/mp4', size: 5, addedAt: 1 }],
      blobs: { 'existing-1': fakeBlob('existing') },
      gate,
    });
    const { useMediaBucketStore } = await importFreshStore('mergeAdd');
    const store = useMediaBucketStore;

    // hydrate() runs synchronously up to its first await (inside
    // getBucketBlob('existing-1'), which is paused on the gate) before this
    // call even returns — so the store is already "mid-hydrate" here.
    const hydratePromise = store.getState().hydrate();
    assert.equal(store.getState().hydrated, false, 'still mid-hydrate, paused on the gate');

    // An add() lands WHILE hydrate is in flight (trackMenuActions.ts:495
    // never awaits hydrate before calling add()).
    const newFile = new File(['data'], 'new.mp4', { type: 'video/mp4' });
    store.getState().add(newFile);
    assert.equal(store.getState().items.length, 1, 'add() landed immediately (zustand set() is synchronous)');

    // Let hydrate's getBucketBlob resolve and the rest of hydrate run.
    resolveGate();
    await hydratePromise;

    const finalItems = store.getState().items;
    const finalIds = finalItems.map((i) => i.id).sort();
    assert.ok(finalIds.includes('existing-1'), 'the restored (pre-existing) item survived');
    assert.ok(
      finalItems.some((i) => i.name === 'new.mp4'),
      'the item added DURING hydrate survived in the store (THE BUG: hydrate\'s set({items: restored}) overwrote it)',
    );
    assert.equal(finalItems.length, 2, 'both items present, nothing duplicated or dropped');

    const mock = (globalThis as unknown as {
      __mbpMock: { saveCalls: Array<Array<{ id: string }>> };
    }).__mbpMock;
    const lastSave = mock.saveCalls.at(-1);
    assert.ok(lastSave, 'hydrate saved meta at least once');
    const savedIds = (lastSave as Array<{ id: string }>).map((m) => m.id).sort();
    assert.deepEqual(savedIds, finalIds, 'the SAVED meta also reflects the merged list, not just the restored snapshot');
  }

  /* ------------------------------ Scenario C: hydrate retries after a rejection (audit #4) ------------------------------ */
  {
    freshMock({
      meta: [{ id: 'retry-1', name: 'retry.mp4', mimeType: 'video/mp4', size: 5, addedAt: 1 }],
      rejectGetBlob: true,
      rejectMessage: 'simulated IndexedDB failure',
    });
    const { useMediaBucketStore } = await importFreshStore('retry');
    const store = useMediaBucketStore;

    await assert.rejects(
      () => store.getState().hydrate(),
      /simulated IndexedDB failure/,
      'a failing hydrate rejects rather than silently swallowing the error',
    );
    assert.equal(store.getState().hydrated, false, 'still unhydrated after the failure');

    // Fix the underlying cause and retry — must NOT be permanently wedged
    // behind the first (now-settled) rejected promise.
    const mock = (globalThis as unknown as {
      __mbpMock: { rejectGetBlob: boolean; blobs: Record<string, unknown> };
    }).__mbpMock;
    mock.rejectGetBlob = false;
    mock.blobs['retry-1'] = fakeBlob('retry');

    await store.getState().hydrate();
    assert.equal(store.getState().hydrated, true, 'the retry succeeds');
    assert.equal(store.getState().items[0]?.id, 'retry-1', 'the item is present after the successful retry');
  }

  console.log('mediaBucketStore.b12.test.ts: all assertions passed');
}

await main();
