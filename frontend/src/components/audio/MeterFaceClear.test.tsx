/**
 * The METER face's TEMPO field: two keys, so neither clear removes the other's
 * marks. Clear takes the tempo changes and keeps every fermata; Clear fermatas
 * takes the holds and keeps every tempo change. Up to afd27bea one Clear key
 * emptied the whole map (setTempoMap([])), so clearing a ritardando also threw
 * away the fermata on the last chord.
 *
 * Mounted on jsdom against the real roll store, in the TempoLane.test.tsx
 * pattern: the sequence a user makes is a map with a tempo change, a ramp and
 * two fermatas, METER, Clear, undo, Clear fermatas, undo.
 *
 *   cd frontend && npx tsx src/components/audio/MeterFaceClear.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { usePianoRollStore } = await import('../../state/pianoRollStore.ts');

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
const find = (name: string): HTMLButtonElement | undefined =>
  [...win.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name) as HTMLButtonElement | undefined;
const button = (name: string): HTMLButtonElement => {
  const hit = find(name);
  assert.ok(hit, `the MIDI tab shows a "${name}" key`);
  return hit;
};
const shape = () =>
  roll().tempoMap.map((e) => (e.fermata ? `f${e.beat}` : `${e.beat}:${e.bpm}${e.curve === 'linear' ? 'r' : ''}`)).join(' ');

const MAP = [
  { beat: 0, bpm: 96, curve: 'step' as const },
  { beat: 8, bpm: 132, curve: 'step' as const },
  { beat: 16, bpm: 132, curve: 'linear' as const },
  { beat: 24, bpm: 72, curve: 'step' as const },
  { beat: 12, bpm: 132, fermata: { beats: 1, stretch: 2 } },
  { beat: 28, bpm: 72, fermata: { beats: 2, stretch: 3 } },
];
const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
await step(() => {
  roll().applyMeter({ meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0 });
  roll().importNotes([{ id: 'a', note: 60, step: 0, length: 4, velocity: 90 }], 96, undefined, [], MAP);
});
await step(() => root.render(<MidiPanel />));
await step(() => button('Meter').click());
const full = '0:96 8:132 f12 16:132r 24:72 f28';
assert.equal(shape(), full);

// Clear: the tempo changes go, both fermatas stay where they were.
const clear = button('Clear the tempo changes');
assert.equal(win.document.getElementById('mf-tempo-value')?.textContent, '72-132', 'the TEMPO field reads the range');
await wait(350);
await step(() => clear.click());
assert.equal(shape(), '0:96 f12 f28', 'Clear keeps the fermatas');
assert.ok(find('Clear the fermatas'), 'the fermata key is still there');
assert.equal(find('Clear the tempo changes'), undefined, 'with no tempo change left, Clear is gone');
await step(() => roll().undo());
assert.equal(shape(), full, 'one undo brings the tempo changes back');

// Clear fermatas: the holds go, every tempo change stays.
await wait(350);
await step(() => button('Clear the fermatas').click());
assert.equal(shape(), '0:96 8:132 16:132r 24:72', 'Clear fermatas keeps the tempo changes and the ramp');
assert.equal(find('Clear the fermatas'), undefined);
assert.ok(find('Clear the tempo changes'));
await step(() => roll().undo());
assert.equal(shape(), full, 'one undo brings the fermatas back');

await step(() => root.unmount());
console.log('MeterFaceClear: ok');
