/**
 * A rhythm run that lands while the deck's own GET is still out reaches the
 * deck.
 *
 * The bug (PR #207 re-review): `invalidateRhythm` retires a GET that is on
 * the wire, and deletes nothing when no miss is stored yet, so
 * `byEntry[id]` is undefined before and after. The deck's re-ask effect
 * depended on `[entryId, rhythm, ensureRhythm]`; `rhythm` never changed, so
 * it never ran again, and the retired GET stored nothing for the miss window
 * to age out. The deck kept its `i % 4` grid until the track was loaded
 * again.
 *
 * Sequence, replayed on the real hook under real react-dom in jsdom:
 *   deck loads track X -> its GET /api/rhythm/X is held on the wire ->
 *   fetchRhythm(X, { run: true }) reads pending, POSTs /run, gets ready,
 *   calls invalidateRhythm -> the held GET is released answering pending ->
 *   the deck must ask again and draw the new bars.
 *
 * Run: `npx tsx src/state/djRhythmStore.deck.test.tsx` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
for (const [key, value] of Object.entries({
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { useDeckRhythm, useDjRhythmStore } = await import('./djRhythmStore.ts');
const { fetchRhythm } = await import('../lib/rhythmSeed.ts');

const READY = { status: 'ready', downbeats: [0.5, 2.5, 4.5], bars: [{ start_sec: 0.5 }, { start_sec: 2.5 }] };
let analyzed = false;
const calls: string[] = [];
/** The deck's first GET, held until the test lets it answer. */
let releaseHeld: (() => void) | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${url}`);
  if (url.endsWith('/run')) {
    analyzed = true;
    return new Response(JSON.stringify(READY), { status: 200 });
  }
  if (calls.length === 1) {
    // The deck's load-time GET. It answers with the cache as it was when it
    // was sent: nothing analyzed yet.
    await new Promise<void>((resolve) => { releaseHeld = resolve; });
    return new Response(JSON.stringify({ status: 'pending' }), { status: 200 });
  }
  return new Response(JSON.stringify(analyzed ? READY : { status: 'pending' }), { status: 200 });
}) as typeof fetch;

const seen: Array<ReturnType<typeof useDeckRhythm>> = [];
function Deck({ entryId }: { entryId: string }) {
  const rhythm = useDeckRhythm(entryId);
  seen.push(rhythm);
  return null;
}

const gets = () => calls.filter((c) => c === 'GET /api/rhythm/track-x').length;
const root = createRoot(win.document.body.appendChild(win.document.createElement('div')));

// 1. The deck loads track X; its GET goes out and is held.
await act(async () => { root.render(<Deck entryId="track-x" />); });
assert.equal(gets(), 1, 'the deck asked once on load');
assert.ok(releaseHeld, 'setup: the deck GET is on the wire');

// 2. A rhythm run for X lands elsewhere in the app while that GET is out.
await act(async () => {
  const ran = await fetchRhythm('track-x', { run: true });
  assert.equal(ran.status, 'ready');
});
assert.equal(useDjRhythmStore.getState().byEntry['track-x']?.ready, true,
  'THE BUG: the deck never asked again, so the run never reached it');

// 3. The stale GET answers now. It was retired and must not undo the run.
await act(async () => {
  releaseHeld?.();
  await new Promise((r) => setTimeout(r, 0));
});
const last = seen[seen.length - 1];
assert.ok(last?.ready, 'the deck draws from the finished analysis');
assert.deepEqual(last?.bars, [0.5, 2.5]);
assert.equal(useDjRhythmStore.getState().byEntry['track-x']?.ready, true, 'the retired GET stored nothing over it');
assert.equal(gets(), 3, 'deck load, the run\'s own read, and the deck\'s re-ask');

await act(async () => { root.unmount(); });
console.log('djRhythmStore.deck: ok');
