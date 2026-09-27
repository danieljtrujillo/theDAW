/**
 * Render test for RollPlayhead.
 *
 * The sequence a user makes: click the ruler at step 64 with the roll stopped
 * (seek), look at the roll, press PLAY (play), press STOP. The playhead is drawn
 * at step 64 the whole time: fainter while stopped, full while playing, on the
 * step line where step 64 starts. It used to draw nothing while the roll was
 * stopped, so a ruler click left no mark of where PLAY would start.
 *
 * Client-rendered (createRoot on jsdom), not renderToStaticMarkup: zustand
 * answers a server render from the store's INITIAL state, so a seek made after
 * the store exists is invisible to a static render.
 *
 *   cd frontend && npx tsx src/components/audio/RollPlayhead.test.tsx
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
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { RollPlayhead } = await import('./RollPlayhead.tsx');
const { usePianoRollStore } = await import('../../state/pianoRollStore.ts');

const st = () => usePianoRollStore.getState();
const step = (fn: () => void) => act(async () => { fn(); });

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
const line = () => host.firstElementChild as HTMLElement | null;

await step(() => usePianoRollStore.setState({ totalSteps: 128, currentStep: 0, isPlaying: false }));
await step(() => root.render(<RollPlayhead stepPx={10} totalSteps={128} />));

// A ruler click with the roll stopped: the playhead is drawn at step 64, faint.
await step(() => st().seek(64));
assert.ok(line(), 'the playhead is drawn while the roll is stopped');
assert.equal(line()!.style.left, '640px', 'on the line where step 64 starts');
assert.ok(line()!.classList.contains('opacity-40'), 'fainter while stopped');
assert.equal(line()!.getAttribute('aria-hidden'), 'true', 'decoration, hidden from assistive tech');

// PLAY: the same place, full strength.
await step(() => st().play());
assert.equal(line()!.style.left, '640px');
assert.equal(line()!.classList.contains('opacity-40'), false, 'full strength while playing');

// STOP: still drawn where it stopped.
await step(() => st().setPlaying(false));
assert.ok(line(), 'the playhead stays in view after STOP');
assert.equal(line()!.style.left, '640px');

// It never leaves the roll: a step past the end draws at the end.
await step(() => usePianoRollStore.setState({ currentStep: 500 }));
assert.equal(line()!.style.left, '1280px');

await step(() => root.unmount());
console.log('RollPlayhead: ok');
