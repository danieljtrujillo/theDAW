/**
 * `captureLiveVstStates` must always settle (T18 re-audit, MAJOR 2).
 *
 * Its per-plugin `finish()` cleared the timeout, then called the sink, then
 * resolved. A throw from the sink (a localStorage quota error inside the store
 * write) escaped between the two: the promise never resolved, so
 * `await captureLiveVstStates()` in the project save and in the editor
 * autosave waited forever, and the save never completed.
 *
 * Run: npx tsx src/state/vstEditorStore.captureHang.test.ts
 */
import assert from 'node:assert/strict';
import type { VstLiveSession } from '../lib/vstLive/sessionRegistry.ts';

/* ── window/localStorage shim, installed before the store imports ─────────── */
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
const g = globalThis as unknown as { localStorage?: Storage; window?: unknown };
g.localStorage = storage;
g.window = new Proxy(windowCore, {
  get: (target, prop, receiver) =>
    Reflect.has(target, prop) ? Reflect.get(target, prop, receiver) : () => undefined,
});
(globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
  throw new Error('network disabled in this test');
}) as typeof fetch;

const { captureLiveVstStates } = await import('./vstEditorStore.ts');
const { useVstLiveStore } = await import('./vstLiveStore.ts');

function fakeSession(entryId: string): VstLiveSession {
  const session = {
    entryId,
    sessionId: `s-${entryId}`,
    wsUrl: 'ws://x',
    pid: 1,
    stateDirty: true,
    client: { getState: () => {} },
  } as unknown as VstLiveSession;
  // The host answers immediately, as a live plugin does.
  (session.client as unknown as { getState: () => void }).getState = () => {
    session.stateSink?.('CAPTURED');
  };
  return session;
}

const session = fakeSession('e1');
useVstLiveStore.getState().setStatus('e1', 'live');

/* ── a sink that throws (the quota error path) still settles the capture ──── */
{
  const settled = await Promise.race([
    captureLiveVstStates({
      sessions: () => [session],
      sink: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      timeoutMs: 20,
    }).then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 300)),
  ]);
  assert.equal(settled, 'settled', 'a throwing sink must not hang the save');
}

/* ── and the normal path still works ──────────────────────────────────────── */
{
  const sunk: [string, string][] = [];
  session.stateDirty = true;
  await captureLiveVstStates({
    sessions: () => [session],
    sink: (id, state) => {
      sunk.push([id, state]);
      return true;
    },
    timeoutMs: 20,
  });
  assert.deepEqual(sunk, [['e1', 'CAPTURED']]);
  assert.equal(session.stateDirty, false, 'a captured session is no longer stale');
}

console.log('vstEditorStore.captureHang: ok');
