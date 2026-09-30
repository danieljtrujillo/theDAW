/**
 * Re-audit MAJOR #1 — `usePeaksDecodeQueue` must survive React 19 StrictMode's
 * dev-only mount → run effects → run cleanups → run effects again dance
 * WITHOUT going permanently dead.
 *
 * `dispose()` is terminal. A ref built once (or built lazily but never reset)
 * and only ever DISPOSED on unmount — never NULLED — means StrictMode's
 * simulated remount reads that same disposed queue back out of `.current`:
 * every `sync()` from then on is a silent no-op forever, so nothing imported,
 * recorded, pasted, inpainted or take-switched AFTER the remount ever gets a
 * decoded waveform. This mounts the real hook under `React.StrictMode` with
 * real `react-dom` (dev build) in jsdom and proves a clip added after that
 * churn still gets its decode started.
 *
 * jsdom supplies the DOM (same pattern as TabErrorBoundary.test.tsx /
 * orbStatusBubble.test.tsx).
 *
 * Run: `npx tsx src/components/audio/usePeaksDecodeQueue.strictMode.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;

const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  MouseEvent: win.MouseEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act, StrictMode, useEffect } = React;
const { createRoot } = await import('react-dom/client');
const { usePeaksDecodeQueue } = await import('./usePeaksDecodeQueue');

const document = win.document;
const step = (fn: () => void) => act(async () => { fn(); });

// A stable Blob per id (the queue compares blobs with `===`, so a given id
// must hand back the SAME Blob instance across renders, matching how a real
// clip's `audioBlob` reference stays the same across re-renders that don't
// touch its audio).
const blobFor = (() => {
  const cache = new Map<string, Blob>();
  return (id: string): Blob => {
    let b = cache.get(id);
    if (!b) { b = new Blob([id]); cache.set(id, b); }
    return b;
  };
})();

/** A minimal stand-in for the peaks-decode effect in WaveformEditor.tsx:
 *  syncs `ids` against the queue and records which ones actually started. */
function Harness({ ids, onStart }: { ids: readonly string[]; onStart: (id: string) => void }) {
  const getQueue = usePeaksDecodeQueue(2);
  useEffect(() => {
    const queue = getQueue();
    const items = ids.map((id) => ({ id, blob: blobFor(id) }));
    const start = (item: { id: string; blob: Blob }) => {
      onStart(item.id);
      queue.settle(item.id, item.blob, start);
    };
    queue.sync(items, start);
  }, [ids, getQueue, onStart]);
  return null;
}

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

const started: string[] = [];
const onStart = (id: string) => { started.push(id); };

// Mount under StrictMode: React double-invokes effects in dev (mount, run
// effects, run cleanups, run effects again) WITHOUT a real unmount/remount —
// this is the exact churn that killed the queue before the fix.
await step(() => { root.render(<StrictMode><Harness ids={['a']} onStart={onStart} /></StrictMode>); });
assert.ok(started.includes('a'), 'the initial clip is decoded despite the StrictMode churn');

// A GENUINE re-render after the churn has settled — the scenario the audit
// named: "a clip added after the remount". With the bug, `getQueue()` keeps
// returning the disposed instance from StrictMode's simulated unmount, so
// this sync is silently swallowed and 'b' never starts.
await step(() => { root.render(<StrictMode><Harness ids={['a', 'b']} onStart={onStart} /></StrictMode>); });
assert.ok(started.includes('b'), 'a clip added after the StrictMode remount still gets decoded');

await step(() => { root.unmount(); });

console.log('usePeaksDecodeQueue StrictMode: all assertions passed');
