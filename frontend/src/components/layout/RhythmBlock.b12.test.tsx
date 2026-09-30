/**
 * T26 SCORE UI (re-audit fix) — RhythmBlock's SAVE-menu Escape scoping.
 *
 * RhythmBlock is embedded inside an ancestor popover (ScoreView's METER MAP
 * button, LyricAnalysisPane's STUDY bar), which has its own document-level
 * Escape handler. RhythmBlock's own SAVE menu used to close on a SECOND,
 * independent `document.addEventListener('keydown', ...)` — a native
 * listener whose `stopPropagation()` cannot shield an ancestor's listener on
 * the SAME target (`document`), so one Escape press closed the save menu
 * AND the ancestor popover at once (and, in ScoreView, exited fullscreen
 * focus mode too). The fix moves Escape handling onto a React `onKeyDown` on
 * the menu's own wrapper, which DOES stop the underlying native event from
 * reaching document-level listeners.
 *
 * This test stands in for that ancestor with a plain `document` keydown spy:
 * Escape while SAVE is open must close only the menu and never reach the
 * spy; a second Escape (SAVE already closed) must reach it, exactly the way
 * it would reach ScoreView's/BarPopover's own handler and close the panel.
 *
 * Client-rendered (createRoot), same reasoning as HfTokenField.b12.test.tsx:
 * state set after mount needs a live subscription to be visible.
 *
 * Run: cd frontend && npx tsx src/components/layout/RhythmBlock.b12.test.tsx
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
  HTMLButtonElement: win.HTMLButtonElement,
  HTMLDivElement: win.HTMLDivElement,
  Node: win.Node,
  KeyboardEvent: win.KeyboardEvent,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  // jsdom has no layout engine, so MeterMapChart's ResizeObserver never
  // fires and its SVG never draws — irrelevant to the Escape behaviour under
  // test, and RhythmBlock renders the SAVE button independently of it.
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// A minimal "ready" result: enough for RhythmBlock to show the SAVE button
// (gated on `result` being truthy) without MeterMapChart needing real
// layout to draw anything.
const READY_RESULT = {
  status: 'ready',
  duration_sec: 12,
  meter_map: [{ start_sec: 0, end_sec: 12, time_signature: '4/4', bpm: 120, bars: 6, confidence: 0.9 }],
  tempo: { bpm: 120, global_bpm: 120, range_bpm: [120, 120] as [number, number] },
  bars: [],
  syncopation: {},
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => ({
  ok: true,
  json: async () => READY_RESULT,
})) as unknown as typeof fetch;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { RhythmBlock } = await import('./RhythmBlock.tsx');

const document = win.document;
const step = (fn: () => void) => act(async () => { fn(); });

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return;
    await step(() => {});
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await step(() => root.render(React.createElement(RhythmBlock, { entryId: 'track-1', title: 'Test Track' })));

await waitFor(() => !!host.querySelector('[aria-haspopup="menu"]'), 'the SAVE button to appear once the cached result loads');

// Stands in for the ancestor popover's own document-level Escape handler
// (ScoreView's meter-map dialog, or LyricAnalysisPane's BarPopover).
let outerEscapeCount = 0;
const outerHandler = (e: KeyboardEvent) => {
  if (e.key === 'Escape') outerEscapeCount += 1;
};
document.addEventListener('keydown', outerHandler);

// Open the SAVE menu.
const saveButton = host.querySelector('[aria-haspopup="menu"]') as HTMLButtonElement;
await step(() => saveButton.click());
await waitFor(() => !!host.querySelector('[role="menu"]'), 'the SAVE menu to open');

// First Escape: closes ONLY the menu, and must not reach the ancestor.
const menu = host.querySelector('[role="menu"]') as HTMLElement;
await step(() => {
  menu.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});
assert.equal(host.querySelector('[role="menu"]'), null, 'the SAVE menu closed on the first Escape');
assert.equal(outerEscapeCount, 0, 'the first Escape did not reach the ancestor popover’s handler');
assert.equal(document.activeElement, saveButton, 'focus returned to the SAVE button');

// Second Escape: the menu is already closed, so RhythmBlock's own handler
// no-ops and this one must reach the ancestor — the same press that, in the
// real app, closes the panel RhythmBlock is embedded in.
await step(() => {
  saveButton.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
});
assert.equal(outerEscapeCount, 1, 'the second Escape reached the ancestor popover’s handler');

document.removeEventListener('keydown', outerHandler);
await step(() => root.unmount());
host.remove();
globalThis.fetch = realFetch;

console.log('RhythmBlock: Escape with SAVE open closes only the menu; a second Escape reaches the popover RhythmBlock is embedded in');
