/**
 * The LOOM tab's LANES view: the lane-score editor (lanes on 1/12-1/28 tuplet
 * grids, the meter directive) is reachable from a labelled view switch, and
 * the choice survives a reload.
 *
 * Up to afd27bea loomStore's persist config forced the colony view on every
 * load (migrate and onRehydrateStorage both wrote mode 'colony') and LoomView
 * rendered only the dish, so the lane score's grids and meter directive had
 * no UI at all.
 *
 * The sequence: a save with the LANES view reloads into it; a v2 save (which
 * always carried 'colony') and a v1 save open on the colony; the switch reads
 * LANES pressed; a lane's grid goes to 1/20 and the score's text follows; SET
 * A METER then a beat more writes `meter 5/4`; COLONY is saved for the next
 * load.
 *
 *   cd frontend && npx tsx src/views/LoomLanes.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const KEY = 'thedaw-loom-v1';
const SCORE = 'bpm 100\nlane drums 1/16 x8\n  k . h . s . h .\nlane other 1/16 x6\n  o . . o . .\n';
win.localStorage.setItem(KEY, JSON.stringify({ state: { mode: 'plane', text: SCORE, colonyText: '', colonyPositions: {} }, version: 3 }));

// playerStore reads import.meta.env.DEV (a Vite-only value) behind a
// `typeof window` guard at module scope, so it is imported before the DOM
// goes in. The LOOM store is created after, because its persisted settings
// read window.localStorage when it is created.
await import('../state/playerStore.ts');
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLSelectElement: win.HTMLSelectElement,
  Element: win.Element,
  Node: win.Node,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const { useLoomStore } = await import('../state/loomStore.ts');
const { LoomView } = await import('./LoomView.tsx');
const store = () => useLoomStore.getState();
await useLoomStore.persist.rehydrate();
assert.equal(store().mode, 'plane', 'a saved LANES view reloads as LANES');
assert.equal(store().applied.lanes.length, 2, 'with its lane score');

// Older saves: v2 always carried 'colony'; v1 is migrated to the colony.
win.localStorage.setItem(KEY, JSON.stringify({ state: { mode: 'colony', text: SCORE, colonyText: '', colonyPositions: {} }, version: 2 }));
await useLoomStore.persist.rehydrate();
assert.equal(store().mode, 'colony', 'a v2 save opens on the colony');
win.localStorage.setItem(KEY, JSON.stringify({ state: { mode: 'plane', text: SCORE, colonyText: '', colonyPositions: {} }, version: 1 }));
await useLoomStore.persist.rehydrate();
assert.equal(store().mode, 'colony', 'a v1 save opens on the colony, as v2 did');
win.localStorage.setItem(KEY, JSON.stringify({ state: { mode: 'plane', text: SCORE, colonyText: '', colonyPositions: {} }, version: 3 }));
await useLoomStore.persist.rehydrate();
assert.equal(store().mode, 'plane');

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const button = (name: string, root: ParentNode = win.document): HTMLButtonElement => {
  const hit = [...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);
  assert.ok(hit, `a "${name}" key`);
  return hit as HTMLButtonElement;
};
const selectSetter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!;

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
await step(() => root.render(React.createElement(LoomView)));

const group = win.document.querySelector('[role="group"][aria-label="LOOM view"]');
assert.ok(group, 'the view switch is a labelled group');
assert.deepEqual([...group.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]), [['Colony', 'false'], ['Lanes', 'true']]);
assert.ok(win.document.querySelector('section[aria-label="The lane score"]'), 'LANES shows the lane score');
assert.deepEqual([...win.document.querySelectorAll('[role="tab"]')].map((t) => t.textContent), ['code', 'crate'], 'the rail holds CODE and CRATE');

// A lane's grid: every grid, the tuplets named, with a real label.
const grid = win.document.getElementById('loom-lane-drums-grid') as HTMLSelectElement;
assert.ok(grid);
assert.equal(win.document.querySelector('label[for="loom-lane-drums-grid"]')?.textContent, 'grid');
assert.ok([...grid.options].some((o) => o.textContent === '1/20 · 16th quintuplets'));
assert.ok([...grid.options].some((o) => o.textContent === '1/28 · 16th septuplets'));
await step(() => {
  selectSetter.call(grid, '20');
  grid.dispatchEvent(new win.Event('change', { bubbles: true }));
});
assert.equal(store().applied.lanes.find((l) => l.name === 'drums')?.div, 20);
assert.match(store().text, /lane drums 1\/20 x8/, 'the score text follows the grid');

// The meter directive.
await step(() => button('set a meter').click());
assert.match(store().text, /^meter 4\/4$/m);
await step(() => button('beats in a bar up').click());
assert.match(store().text, /^meter 5\/4$/m, 'a beat more writes meter 5/4');
assert.match(win.document.body.textContent ?? '', /A 5\/4 bar holds 25 steps of 1\/20/);
await step(() => button('clock meter').click());
assert.doesNotMatch(store().text, /^meter /m, 'CLOCK METER removes the line');

// Length and a new lane.
await step(() => button('steps up', win.document.getElementById('loom-lane-other-len-label')!.parentElement!).click());
assert.equal(store().applied.lanes.find((l) => l.name === 'other')?.length, 7);
await step(() => button('+ lane').click());
assert.equal(store().applied.lanes.length, 3);

// The choice is saved for the next load.
await step(() => { store().setMode('colony'); });
const saved = JSON.parse(win.localStorage.getItem(KEY) ?? '{}');
assert.equal(saved.state.mode, 'colony');
assert.equal(saved.version, 3);
await step(() => { store().setMode('plane'); });
assert.equal(JSON.parse(win.localStorage.getItem(KEY) ?? '{}').state.mode, 'plane');

await step(() => root.unmount());
console.log('LoomLanes: ok');
