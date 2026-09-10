/**
 * The gate that decides whether a WebGL scene draws.
 *
 * Getting this wrong is expensive in both directions: too eager and five
 * three.js scenes render behind a panel nobody is looking at; too strict and a
 * visible scene freezes. Both are pinned here against a fake
 * IntersectionObserver, because there is no DOM in these runs.
 *
 * Run: `npx tsx src/lib/renderGate.test.ts`
 */
import assert from 'node:assert/strict';

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;

const observers: Array<{ cb: IOCallback; disconnected: boolean }> = [];
const listeners: Record<string, Array<() => void>> = {};
const doc = {
  hidden: false,
  addEventListener(type: string, fn: () => void) {
    (listeners[type] ||= []).push(fn);
  },
  removeEventListener(type: string, fn: () => void) {
    listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
  },
};

class FakeIO {
  private readonly entry: { cb: IOCallback; disconnected: boolean };
  constructor(cb: IOCallback) {
    this.entry = { cb, disconnected: false };
    observers.push(this.entry);
  }
  observe(): void {}
  disconnect(): void {
    this.entry.disconnected = true;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g.window = g.window ?? {};
g.document = doc;
g.IntersectionObserver = FakeIO;

const { createRenderGate } = await import('./renderGate.ts');

const fire = (isIntersecting: boolean): void => {
  for (const o of observers) if (!o.disconnected) o.cb([{ isIntersecting }]);
};
const emitVisibilityChange = (): void => {
  for (const fn of listeners.visibilitychange || []) fn();
};

const el = {} as Element;
const gate = createRenderGate(el);

// Starts drawing: the observer's first callback is async, and a scene that is
// on screen must not skip its opening frames waiting for it.
assert.equal(gate.visible(), true, 'draws before the first observation lands');
assert.equal(gate.resumed(), false, 'the first frame is not a resume');

// Off screen — a panel hidden behind another workspace — stops drawing.
fire(false);
assert.equal(gate.visible(), false);
assert.equal(gate.visible(), false, 'and stays stopped');

// Back on screen: drawing resumes, and the loop is told to re-baseline its
// clock exactly once so it does not integrate the whole absence in one frame.
fire(true);
assert.equal(gate.visible(), true);
assert.equal(gate.resumed(), true, 'the first frame back is a resume');
assert.equal(gate.resumed(), false, 'and only that one');

// A minimised window stops it too, even while the element is on screen.
doc.hidden = true;
assert.equal(gate.visible(), false, 'document.hidden still stops the loop');
doc.hidden = false;
assert.equal(gate.visible(), true);
assert.equal(gate.resumed(), true, 'un-minimising is a resume as well');

// visibilitychange marks a resume without waiting for the next visible() call,
// so a loop that checks resumed() first still re-baselines.
fire(false);
gate.visible();
doc.hidden = false;
emitVisibilityChange();
assert.equal(gate.resumed(), true);

// A real minimise never calls visible() while hidden: the browser pauses rAF
// exactly then, so the loop stops asking until the window is back. The resume
// has to survive that gap — the cases above all reach `hidden` through a
// visible() call, which is the one thing a minimised window cannot do.
fire(true);
gate.visible(); // on screen and drawing
gate.resumed(); // clear whatever the transition above latched
doc.hidden = true;
emitVisibilityChange(); // minimised — rAF stops here, no visible() calls follow
doc.hidden = false;
emitVisibilityChange(); // restored
assert.equal(gate.visible(), true, 'drawing again after the window comes back');
assert.equal(gate.resumed(), true, 'a minimise that paused rAF still re-baselines');

// Disposal detaches both subscriptions — a leaked observer on a torn-down
// scene keeps the element alive.
gate.dispose();
assert.ok(
  observers.every((o) => o.disconnected),
  'the observer is disconnected',
);
assert.equal((listeners.visibilitychange || []).length, 0, 'and the listener removed');

// No IntersectionObserver (an old webview, a test runner): draw rather than
// refuse — a black panel is worse than a wasted frame.
delete g.IntersectionObserver;
const fallback = createRenderGate(el);
assert.equal(fallback.visible(), true);
assert.equal(fallback.resumed(), false);
fallback.dispose();
g.IntersectionObserver = FakeIO;

// A missing element is the same story.
assert.equal(createRenderGate(null).visible(), true);

console.log('renderGate: ok');
