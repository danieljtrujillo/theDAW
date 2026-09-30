/**
 * T20 re-audit items 2 and 3 (Tooltip.tsx).
 *
 * Item 2 (MAJOR): InfoTip was never portalled — it rendered its panel
 * `absolute` inline in the DOM tree, so any `overflow:hidden|auto` ancestor
 * (CatalogueInspector.tsx's `flex-1 overflow-y-auto`, every settings
 * SectionHeader) clipped it. This proves the panel now escapes to
 * document.body, and that its outside-click handler treats the portalled
 * panel node as "inside" rather than closing the instant it opens.
 *
 * Item 3 (MINOR): HoverTip's portalled tip had no accessibility
 * association — no `role="tooltip"`, no id, no `aria-describedby`, no
 * focus handling, no Escape. This proves each of those exists and works.
 *
 * jsdom supplies the DOM; setTimeout is a node:test mock, ticked manually
 * (matches the pattern in Tooltip.b12.test.tsx).
 *
 * Run: `npx tsx src/components/ui/Tooltip.infotip.test.tsx`
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;

mock.timers.enable({ apis: ['setTimeout'], now: 1_000_000 });
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
  KeyboardEvent: win.KeyboardEvent,
  FocusEvent: win.FocusEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { HoverTip, InfoTip } = await import('./Tooltip');

const document = win.document;
const step = (fn: () => void) => act(async () => { fn(); });
const tick = (ms: number) => step(() => mock.timers.tick(ms));

/* ─── Item 2: InfoTip portal + outside-click-on-portal-node ─────────── */

const infoHost = document.createElement('div');
// A clipping ancestor identical in spirit to CatalogueInspector's
// `flex-1 overflow-y-auto` — jsdom does not implement real clipping, so
// this is here to document intent; the actual proof is that the panel is
// portalled OUT of this subtree entirely (see assertions below).
infoHost.className = 'overflow-y-auto';
document.body.appendChild(infoHost);
const infoRoot = createRoot(infoHost);

await step(() => infoRoot.render(
  <InfoTip title="Test Title" body="line one" />,
));

const infoButton = infoHost.querySelector('button') as HTMLButtonElement;
assert.ok(infoButton, 'InfoTip renders its trigger button');

assert.equal(document.body.querySelectorAll('.rounded-lg').length, 0, 'panel is not in the DOM before opening');

await step(() => {
  infoButton.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
});
assert.ok(document.body.textContent?.includes('Test Title'), 'panel text is present under document.body once opened');
assert.equal(infoHost.querySelector('.rounded-lg'), null, 'the panel is portalled to document.body, not nested inside InfoTip\'s own wrapper div (so no ancestor can clip it)');

// Clicking INSIDE the portalled panel must not be treated as an outside
// click (T20 item 2's specific regression risk: the old handler checked
// `ref.current.contains(e.target)`, which is false for a portalled node
// even while truly inside the panel).
const panelBody = document.body.querySelector('.rounded-lg') as HTMLElement;
await step(() => {
  panelBody.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
});
assert.ok(document.body.textContent?.includes('Test Title'), 'a mousedown inside the portalled panel must not close it');

// A real outside click still closes it.
await step(() => {
  document.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
});
await tick(500); // past the panel's own exit-transition unmount timer
assert.equal(document.body.querySelectorAll('.rounded-lg').length, 0, 'a genuine outside click still closes the portalled panel');

await step(() => infoRoot.unmount());
document.body.removeChild(infoHost);

/* ─── Item 3: HoverTip accessibility association ────────────────────── */

const hoverHost = document.createElement('div');
document.body.appendChild(hoverHost);
const hoverRoot = createRoot(hoverHost);

// T20 re-audit item 5: the previous version of this test dispatched
// focusin on the WRAPPER span, which never proved the child-delegation
// path its own comment claimed — it only proved the wrapper's own
// onFocus/onBlur handlers fire, which was never in question. ~40 real call
// sites wrap a <button> (see SlideFader/SlideKnob/SlideRow), so the anchor
// here is a <button> child and focus is dispatched on THAT element, then
// aria-describedby is asserted on the button itself (the id, per Tooltip.tsx
// item 3, must land on the cloned focusable child, not the roleless wrapper
// span).
await step(() => hoverRoot.render(
  <HoverTip text="hint text">
    <button type="button" data-anchor="1">anchor</button>
  </HoverTip>,
));

const anchorButtonEl = hoverHost.querySelector('button[data-anchor]') as HTMLElement;
const hoverWrapperEl = anchorButtonEl.parentElement as HTMLElement;

// T20 re-audit item 4: unconditional tabIndex={0} added a second, nameless
// tab stop at every call site — most of which already wrap a focusable
// element (a <button>), where React's bubbling focusin/focusout (proved
// below) reaches this wrapper's handlers for free. The wrapper is no longer
// a tab stop by default; `focusable` is an opt-in prop for a non-interactive
// anchor that needs keyboard reach of its own.
assert.equal(hoverWrapperEl.getAttribute('tabindex'), null, 'the wrapper span is not its own tab stop by default — focus delegates from the button child instead');
assert.equal(hoverWrapperEl.hasAttribute('aria-describedby'), false, 'the wrapper never carries aria-describedby when a single focusable child is delegated to');
assert.equal(anchorButtonEl.hasAttribute('aria-describedby'), false, 'aria-describedby must be absent on the button while the tip is closed');

// React delegates onFocus/onBlur via the bubbling 'focusin'/'focusout'
// events (native 'focus'/'blur' do not bubble), same pattern as the
// mouseover/mouseout delegation Tooltip.b12.test.tsx relies on. Dispatched
// on the button itself — the actual element a keyboard user tabs to at the
// ~40 real call sites — not the wrapper.
await step(() => {
  anchorButtonEl.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
});
const tipNode = document.body.querySelector('[role="tooltip"]') as HTMLElement | null;
assert.ok(tipNode, 'a role="tooltip" node exists once the tip is shown (via focus on the child button)');
assert.ok(tipNode!.id, 'the tooltip node has a non-empty id');
assert.equal(hoverWrapperEl.hasAttribute('aria-describedby'), false, 'the wrapper still carries no aria-describedby once delegated to the button');
assert.equal(anchorButtonEl.getAttribute('aria-describedby'), tipNode!.id, 'aria-describedby on the button child must reference the tooltip node\'s own id');

// Escape dismisses it.
await step(() => {
  document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
assert.equal(document.body.querySelector('[data-hover-tip-open="true"]'), null, 'Escape closes the tip');
assert.equal(anchorButtonEl.hasAttribute('aria-describedby'), false, 'aria-describedby is removed off the button once the tip closes');
await tick(500);

// blur also dismisses it (already-covered close path, re-checked via focus).
await step(() => {
  anchorButtonEl.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }));
});
assert.ok(document.body.querySelector('[role="tooltip"]'), 'tip reopens on focus of the child button');
await step(() => {
  anchorButtonEl.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
});
assert.equal(document.body.querySelector('[data-hover-tip-open="true"]'), null, 'blur off the child button closes the tip');
await tick(500);

await step(() => hoverRoot.unmount());
document.body.removeChild(hoverHost);

mock.timers.reset();
console.log('Tooltip.infotip: all assertions passed');
