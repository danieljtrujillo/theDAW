/**
 * Interaction test for HoverTip's portalled tip (T20 audit item 4): a tip
 * rendered via createPortal escapes its anchor's DOM subtree, so nothing
 * removes it automatically when the anchor's tab is hidden (theDAW keeps
 * warmed tabs mounted and toggles an ancestor's `style.display`,
 * DAWCenterPanel.tsx) or when the page scrolls, loses focus, or the user
 * clicks/taps elsewhere. This proves the tip closes in each of those cases.
 *
 * T20 re-audit item 4: HoverTip used to portal its wrapper div into
 * document.body UNCONDITIONALLY, even while hidden — every one of the ~40
 * HoverTip call sites (2 per catalogue row) added a body node whether or not
 * anyone had ever hovered it. This also tests that the portal is mounted
 * only while shown or while its exit transition is running, and that the
 * layout-poll `setInterval` never leaks (none pending after hide or
 * unmount).
 *
 * Assertions read the portal's `data-hover-tip-open` attribute rather than
 * DOM presence of the tip text: the AnimatePresence exit transition keeps
 * the tip's DOM node mounted for its 120ms duration, and jsdom's
 * requestAnimationFrame polyfill (which drives that transition) is not
 * reachable through node:test's mocked timers — so waiting for the node to
 * actually leave the DOM is not viable here. `data-hover-tip-open` mirrors
 * the `show` state directly and updates synchronously with it, independent
 * of the animation. The portal-mount lifecycle itself is driven by a plain
 * `setTimeout` matching the exit transition's duration (see Tooltip.tsx),
 * which IS reachable through the mocked timers.
 *
 * jsdom supplies the DOM; setTimeout/setInterval are node:test mocks, ticked
 * manually.
 *
 * Run: `npx tsx src/components/ui/Tooltip.b12.test.tsx`
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;

mock.timers.enable({ apis: ['setTimeout', 'setInterval'], now: 1_000_000 });
// jsdom keeps its own timers; HoverTip's layout poll calls window.setInterval
// and its portal-mount lifecycle calls window.setTimeout. Route both through
// the mocked globals, and count outstanding intervals so "no interval
// pending after hide/unmount" is a real assertion, not a guess.
let activeIntervalCount = 0;
win.setInterval = ((fn: () => void, ms?: number) => {
  activeIntervalCount += 1;
  return globalThis.setInterval(fn, ms);
}) as unknown as typeof win.setInterval;
win.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
  if (id !== undefined) activeIntervalCount -= 1;
  return globalThis.clearInterval(id);
}) as unknown as typeof win.clearInterval;
win.setTimeout = ((fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms)) as unknown as typeof win.setTimeout;
win.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id)) as unknown as typeof win.clearTimeout;

const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  Event: win.Event,
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
const { HoverTip } = await import('./Tooltip');

const document = win.document;
const step = (fn: () => void) => act(async () => { fn(); });
const tick = (ms: number) => step(() => mock.timers.tick(ms));
// Past HoverTip's exit-transition-length portal-unmount timer.
const settle = () => tick(500);

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);

await step(() => root.render(
  <HoverTip text="hint text">
    <span data-anchor="1">anchor</span>
  </HoverTip>,
));

const anchorSpan = host.querySelector('span[data-anchor]') as HTMLElement;
const hoverWrapper = anchorSpan.parentElement as HTMLElement; // the <span ref=...> from HoverTip
const isOpen = () => document.body.querySelector('[data-hover-tip-open="true"]') !== null;
// React 17+ implements onMouseEnter/onMouseLeave via native mouseover/mouseout
// with a relatedTarget outside the subtree — mirrors orbStatusBubble.test.tsx.
const hover = async () => {
  await step(() => {
    hoverWrapper.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
  });
  assert.ok(isOpen(), 'tip opens after hover');
};

// ── never hovered: no portal node in document.body at all ──────────────
assert.equal(document.body.querySelectorAll('[data-hover-tip-open]').length, 0, 'an un-hovered HoverTip must not add any node to document.body');

// ── portalled: the marker div is NOT nested inside HoverTip's own <span> ───
await hover();
assert.equal(hoverWrapper.querySelector('[data-hover-tip-open]'), null, 'the tip is portalled to document.body, not nested inside the anchor span');
assert.ok(document.body.textContent?.includes('hint text'), 'the tip text is present under document.body');

// ── closes on window blur ───────────────────────────────────────────────
await step(() => win.dispatchEvent(new win.Event('blur')));
assert.ok(!isOpen(), 'tip closes on window blur');
await settle();
assert.equal(document.body.querySelectorAll('[data-hover-tip-open]').length, 0, 'once its exit transition has run, the portal node must leave document.body entirely');
assert.equal(activeIntervalCount, 0, 'no layout-poll interval must remain pending after hide settles');

// ── closes on scroll, including from an unrelated nested scroller (capture) ─
await hover();
const scroller = document.createElement('div');
document.body.appendChild(scroller);
// `scroll` does not bubble — this only reaches a `window` listener at all if
// HoverTip registered its scroll listener with capture: true.
await step(() => scroller.dispatchEvent(new win.Event('scroll', { bubbles: false })));
assert.ok(!isOpen(), 'tip closes on scroll of an unrelated nested scrollable container (capture-phase)');
document.body.removeChild(scroller);
await settle();

// ── closes on pointerdown anywhere ──────────────────────────────────────
await hover();
await step(() => document.body.dispatchEvent(new win.Event('pointerdown', { bubbles: true })));
assert.ok(!isOpen(), 'tip closes on pointerdown anywhere in the document');
await settle();

// ── closes when the anchor stops being laid out (ancestor display:none) ───
await hover();
await step(() => { host.style.display = 'none'; });
await tick(1000); // past the 200ms poll interval, plus the exit-mount timer
assert.ok(!isOpen(), 'tip closes once its anchor\'s ancestor is set to display:none (e.g. DAWCenterPanel hiding an inactive tab)');
host.style.display = '';
await settle();
assert.equal(activeIntervalCount, 0, 'no layout-poll interval must remain pending after the anchor is hidden and the tip settles');

// ── closes when an ancestor is hidden via a CSS CLASS, not inline style ──
// T20 re-audit item 4: the old `isLaidOut` walked `node.style.display`,
// which only ever sees an element's own INLINE style — a stylesheet class
// (`.hidden { display: none }`) never touches `.style.display`, so a class-
// hidden ancestor left the old implementation reporting "still laid out"
// forever and the tip never closed. `getClientRects().length > 0` (the new
// implementation) does not special-case inline vs. class styling — it asks
// whether the element renders any boxes at all, so it closes here too.
const styleEl = document.createElement('style');
styleEl.textContent = '.b12-hidden-ancestor { display: none; }';
document.head.appendChild(styleEl);
await hover();
await step(() => { host.classList.add('b12-hidden-ancestor'); });
await tick(1000); // past the 200ms poll interval
assert.ok(!isOpen(), 'tip closes once its ancestor is hidden via a CSS class, not just inline style.display');
host.classList.remove('b12-hidden-ancestor');
document.head.removeChild(styleEl);
await settle();

// ── many tips mounted, none ever hovered: still zero body nodes ─────────
const manyHost = document.createElement('div');
document.body.appendChild(manyHost);
const manyRoot = createRoot(manyHost);
await step(() => manyRoot.render(
  <>
    {Array.from({ length: 20 }, (_, i) => (
      <HoverTip key={i} text={`hint ${i}`}><span>anchor {i}</span></HoverTip>
    ))}
  </>,
));
assert.equal(document.body.querySelectorAll('[data-hover-tip-open]').length, 0, '20 unhovered HoverTips must add zero nodes to document.body');
await step(() => manyRoot.unmount());
document.body.removeChild(manyHost);

// ── unmounting while shown must not leak the interval either ────────────
await hover();
assert.equal(activeIntervalCount, 1, 'the layout-poll interval is running while shown');
await step(() => root.unmount());
assert.equal(activeIntervalCount, 0, 'unmounting while shown must clear the layout-poll interval, not leak it');

mock.timers.reset();
console.log('Tooltip.b12: all assertions passed');
