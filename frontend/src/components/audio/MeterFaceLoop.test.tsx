/**
 * LOOP on a lane with a span: the loop counts inside the span, and a press
 * past the span's length wraps to the shortest loop, so the lane keeps
 * looping. Up to afd27bea the stepper counted to the roll's length: lane B
 * spanned four bars (64 steps) could step to an 80-step loop, which laneLoop
 * plays from the span's first step and cuts at its end, so the lane played its
 * first 64 steps once and never looped, with nothing on the face saying so.
 *
 * Mounted on jsdom against the real roll store (TempoLane.test.tsx pattern).
 * The sequence: lane B over bars 5-8 with a 48-step loop, METER, Shift+LOOP
 * longer (64, the span), Shift+LOOP longer again (wraps to 16), then the
 * played notes repeat every 16 steps through the span. A loop an older file
 * (or SPAN on a longer loop) leaves past its span reads flagged on the LOOP
 * readout, and SPAN says so in the LOG.
 *
 *   cd frontend && npx tsx src/components/audio/MeterFaceLoop.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const { playedRollNotes } = await import('../../lib/rollClip.ts');
const { useLogStore } = await import('../../state/logStore.ts');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
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
Object.defineProperty(win.HTMLElement.prototype, 'offsetParent', { get(this: HTMLElement) { return this.parentElement; }, configurable: true });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const roll = () => usePianoRollStore.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const wait = (ms: number) => step(() => new Promise<void>((done) => setTimeout(done, ms)));
const button = (name: string): HTMLButtonElement => {
  const hit = [...win.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);
  assert.ok(hit, `the MIDI tab shows a "${name}" key`);
  return hit as HTMLButtonElement;
};
const shiftClick = (el: HTMLElement) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, shiftKey: true }));
const cycleB = () => roll().lanes.find((l) => l.id === 1)?.cycleSteps;

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
await step(() => {
  roll().applyMeter({
    meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }],
    pickupSteps: 0,
    lanes: [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: 48, span: { start: 64, end: 128 } }],
  });
  roll().importNotes([
    { id: 'a', note: 60, step: 0, length: 4, velocity: 90 },
    { id: 'b', note: 72, step: 64, length: 2, velocity: 90, lane: 1 },
  ], 120, undefined, []);
  usePianoRollStore.setState({ totalSteps: 192 });
  roll().setActiveLane(1);
});
await step(() => root.render(<MidiPanel />));
await step(() => button('Meter').click());

const longer = button('Longer loop for lane B');
assert.equal(longer.disabled, false);
await wait(350);
await step(() => { shiftClick(longer); });
assert.equal(cycleB(), 64, 'a bar longer: the loop fills the four-bar span');
await wait(350);
await step(() => { shiftClick(button('Longer loop for lane B')); });
assert.equal(cycleB(), 16, 'past the span it wraps to one bar (it went to 80 and stopped looping)');

const lanes = roll().lanes;
const played = playedRollNotes(roll().notes, lanes, roll().totalSteps)
  .filter((n) => n.note === 72)
  .map((n) => n.step);
assert.deepEqual(played, [64, 80, 96, 112], 'lane B repeats every bar through its span');

// One step at a time wraps too, and the shorter key walks back down inside the span.
await wait(350);
await step(() => roll().setLaneCycle(1, 63));
await step(() => button('Longer loop for lane B').click());
assert.equal(cycleB(), 64);
await wait(350);
await step(() => button('Longer loop for lane B').click());
assert.equal(cycleB(), 1, 'a step past the span wraps to one step');
await wait(350);
await step(() => roll().setLaneCycle(1, 80));
await step(() => button('Shorter loop for lane B').click());
assert.equal(cycleB(), 63, 'a loop an older file left past its span steps down from the span');

// A loop left longer than its span reads flagged: the readout is in the accent and a screen reader hears why.
const loopValue = () => win.document.getElementById('mf-loop-value') as HTMLElement;
await wait(350);
await step(() => roll().setLaneCycle(1, 80));
assert.ok(loopValue().hasAttribute('data-alert'), 'the 80-step loop in a 64-step span is flagged');
assert.match(loopValue().textContent ?? '', /80, longer than its 64-step span; the last 16 steps are not heard/);
await wait(350);
await step(() => button('Shorter loop for lane B').click());
assert.equal(cycleB(), 63);
assert.ok(!loopValue().hasAttribute('data-alert'), 'a loop inside its span is not flagged');

// SPAN on a lane that already loops longer than the segment says so in the LOG and on the readout.
// The loop is kept: taking the span off gives the whole loop back (laneLoop plays the first span-length once).
await step(() => {
  roll().applyMeter({
    meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }, { bar: 4, meter: { num: 3, den: 4, groups: [] } }],
    lanes: [{ id: 0, name: 'A', cycleSteps: null }, { id: 1, name: 'B', cycleSteps: 80 }],
  });
  roll().seek(0);
});
const logged = useLogStore.getState().entries.length;
await wait(350);
await step(() => button('Span: lane B only in bars 1-4').click());
assert.deepEqual(roll().lanes.find((l) => l.id === 1)?.span, { start: 0, end: 64 });
assert.equal(cycleB(), 80, 'the loop keeps its length');
const said = useLogStore.getState().entries.slice(logged);
assert.ok(said.some((e) => e.level === 'warn' && /LANE B LOOPS EVERY 80 STEPS, LONGER THAN ITS 64-STEP SPAN/.test(e.msg)), 'SPAN warns in the LOG');
assert.ok(loopValue().hasAttribute('data-alert'));

await step(() => root.unmount());
console.log('MeterFaceLoop: ok');
