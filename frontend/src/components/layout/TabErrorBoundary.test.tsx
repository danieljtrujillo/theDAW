/**
 * T20 re-audit item 3 (MINOR): React.lazy caches a REJECTED chunk-load
 * promise — clicking "Retry" (which only clears TabErrorBoundary's local
 * `error` state) re-renders the exact same lazy component, which re-throws
 * the exact same cached rejection. Retry can never recover from a chunk-load
 * failure; only a full page reload (re-fetching the chunk, picking up a
 * redeploy's new URL) can. This tests the detection helper directly, and
 * that Retry's behavior actually branches on it.
 *
 * jsdom supplies the DOM for the component-level checks (same pattern as
 * orbStatusBubble.test.tsx).
 *
 * Run: `npx tsx src/components/layout/TabErrorBoundary.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;

// jsdom's `window.location` (and `location.reload` on it) are non-
// configurable, non-writable own properties, mirroring real browsers
// specifically to prevent this kind of tampering — `win.location.reload =
// ...` and `Object.defineProperty(win.location, 'reload', ...)` both throw,
// and even a Proxy `get` trap over the real Location object is rejected (the
// spec's proxy invariant requires a `get` trap to return the exact target
// value for a non-configurable, non-writable property). Route `window`
// through a Proxy instead: every property except `location` forwards
// straight to the real jsdom window; `location` returns a plain stub object
// (not the real Location, so no invariant applies) exposing just `reload`.
let reloadCalls = 0;
const locationStub = { reload: () => { reloadCalls += 1; } };
const windowProxy = new Proxy(win, {
  get(target, prop, receiver) {
    if (prop === 'location') return locationStub;
    return Reflect.get(target, prop, target);
  },
}) as unknown as typeof win;

const globals: Record<string, unknown> = {
  window: windowProxy,
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
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { TabErrorBoundary, isChunkLoadError } = await import('./TabErrorBoundary');
const { AudioWorkletUnavailableError } = await import('../../lib/audioWorkletSupport');

const document = win.document;
const step = (fn: () => void) => act(async () => { fn(); });
const click = (el: Element) => step(() => {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
});

// ── isChunkLoadError: pure detection ────────────────────────────────────
assert.equal(isChunkLoadError(null), false);
assert.equal(isChunkLoadError(undefined), false);
assert.equal(isChunkLoadError(new Error('Cannot read properties of undefined (reading \'foo\')')), false, 'an ordinary render error is not a chunk-load failure');
assert.equal(isChunkLoadError(new Error("Failed to fetch dynamically imported module: https://app/assets/DJView-abc123.js")), true, 'Vite/native ESM phrasing');
assert.equal(isChunkLoadError(new Error('error loading dynamically imported module')), true, 'Firefox phrasing');
assert.equal(isChunkLoadError(new Error('Importing a module script failed')), true, 'Safari phrasing');
assert.equal(isChunkLoadError(Object.assign(new Error('boom'), { name: 'ChunkLoadError' })), true, 'webpack ChunkLoadError by name');
assert.equal(isChunkLoadError(new Error('Loading chunk 42 failed.')), true, 'webpack loading-chunk-N-failed phrasing');

// ── Retry behavior branches on the same detection ───────────────────────
let shouldThrow = true;
let thrownMessage = 'boom: an ordinary render error';
function Bomb(): React.ReactElement {
  if (shouldThrow) throw new Error(thrownMessage);
  return React.createElement('div', { 'data-testid': 'recovered' }, 'ok');
}

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);

// A normal render error: Retry clears local state and re-renders children.
await step(() => root.render(
  React.createElement(TabErrorBoundary, { tabName: 'Test', children: React.createElement(Bomb) }),
));
assert.ok(host.textContent?.includes('Test stopped'), 'fallback UI shows for a normal error');
assert.ok(host.textContent?.includes('Retry'), 'button reads "Retry" for a non-chunk error');
shouldThrow = false;
const retryButton = () => host.querySelector('button') as HTMLButtonElement;
await click(retryButton());
assert.equal(reloadCalls, 0, 'a normal error must NOT reload the page');
assert.ok(host.querySelector('[data-testid="recovered"]'), 'children re-render after Retry clears a non-chunk error');

// A chunk-load failure: Retry must reload instead of re-rendering (which
// would just re-throw the same cached rejection).
shouldThrow = true;
thrownMessage = "Failed to fetch dynamically imported module: https://app/assets/DJView-abc123.js";
await step(() => root.render(
  React.createElement(TabErrorBoundary, { tabName: 'DJ', children: React.createElement(Bomb) }),
));
assert.ok(host.textContent?.includes('DJ stopped'), 'fallback UI shows for a chunk-load failure');
assert.ok(host.textContent?.includes('Reload'), 'button reads "Reload" (not "Retry") for a chunk-load failure');
await click(retryButton());
assert.equal(reloadCalls, 1, 'a chunk-load failure must call window.location.reload() exactly once');

// ── Unrecognised failure: retries once in place, then escalates ────────
// A chunk that evaluates and throws, or a `BottomMultiTabPanel.tsx`-style
// "Element type is invalid" from an undefined named export, is phrased
// nothing like CHUNK_LOAD_ERROR_PATTERNS — isChunkLoadError must be false
// for it — yet React.lazy still cached the rejection, so an in-place retry
// can never recover it either. First click must retry (no reload, matching
// the regex-recognised path's UX); the SAME failure recurring after that
// retry must escalate to a reload rather than looping forever.
const unrecognisedMessage = 'TypeError: Failed to fetch';
assert.equal(isChunkLoadError(new Error(unrecognisedMessage)), false, 'a bare "Failed to fetch" TypeError must not match the chunk-load regexes');

shouldThrow = true;
thrownMessage = unrecognisedMessage;
await step(() => root.render(
  React.createElement(TabErrorBoundary, { tabName: 'Unrecognised', children: React.createElement(Bomb) }),
));
assert.ok(host.textContent?.includes('Unrecognised stopped'), 'fallback UI shows for the unrecognised error');
assert.ok(host.textContent?.includes('Retry'), 'button reads "Retry" on first encounter of an unrecognised error');
const reloadCallsBeforeFirstClick = reloadCalls;
await click(retryButton());
assert.equal(reloadCalls, reloadCallsBeforeFirstClick, 'first click on an unrecognised error must NOT reload — it retries in place');
// The retry cleared `error`, so React re-renders children; Bomb still
// throws (shouldThrow is still true), which re-triggers the boundary with
// `retried` now true (preserved by getDerivedStateFromError).
assert.ok(host.textContent?.includes('Unrecognised stopped'), 'boundary re-catches the same unrecognised error after the failed in-place retry');
await click(retryButton());
assert.equal(reloadCalls, reloadCallsBeforeFirstClick + 1, 'second click on the SAME unrecognised error must escalate to a reload');

// ── No AudioWorklet on this page: explain, and offer no false Retry ────
// Opening theDAW over plain http on a LAN address leaves `ctx.audioWorklet`
// undefined, which used to reach this boundary as "Cannot read properties of
// undefined (reading 'addModule')" plus a Retry button that could never
// succeed — nothing on that card told the user what was wrong. The typed
// error carries an actionable message, and no re-render or reload can make a
// non-secure page secure, so there is no button to offer.
shouldThrow = true;
const workletError = new AudioWorkletUnavailableError('insecure-context');
function WorkletBomb(): React.ReactElement {
  throw workletError;
}
await step(() => root.render(
  React.createElement(TabErrorBoundary, { tabName: 'Edit', children: React.createElement(WorkletBomb) }),
));
assert.ok(host.textContent?.includes('Edit stopped'), 'the boundary still catches it');
assert.ok(host.textContent?.includes(workletError.message), "the error's own actionable message is shown");
assert.ok(host.textContent?.includes('localhost'), 'the user is told where to open theDAW instead');
assert.equal(host.querySelector('button'), null, 'no Retry button that could never succeed');
assert.ok(!host.textContent?.includes('Retry'), 'and no "Retry" label anywhere on the card');

// Every other error still renders exactly as before.
thrownMessage = 'boom: an ordinary render error';
await step(() => root.render(
  React.createElement(TabErrorBoundary, { tabName: 'Other', children: React.createElement(Bomb) }),
));
assert.ok(host.textContent?.includes('Retry'), 'an ordinary error keeps its Retry button');

await step(() => root.unmount());
console.log('TabErrorBoundary: all assertions passed');
