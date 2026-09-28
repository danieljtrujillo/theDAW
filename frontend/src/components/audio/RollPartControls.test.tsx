/**
 * Mount test for the controller changes a part carries, in the MIDI tab's
 * parts column (RollTrackColumn, the active part's settings).
 *
 * The sequence: an orchestral MIDI file's piano part comes in with a sustain
 * pedal, a volume and an expression change; the part's settings list them
 * ("Sustain pedal · 2 changes"); CLEAR there removes them in one undo step and
 * the list goes; undo brings them back; a part without any shows no list.
 * Every word is 12px or larger, and CLEAR is named for the part it clears.
 *
 * Client-rendered (createRoot on jsdom), in the MidiPanel.test.tsx pattern.
 *
 *   cd frontend && npx tsx src/components/audio/RollPartControls.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { endRollGesture, rollTracksOf, usePianoRollStore } = await import('../../state/pianoRollStore.ts');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement,
  HTMLSelectElement: win.HTMLSelectElement,
  Node: win.Node,
  Event: win.Event,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async () => new Response('{}', { status: 404 }),
});

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const roll = () => usePianoRollStore.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const q = <T extends Element>(sel: string): T | null => win.document.querySelector(sel) as T | null;
const key = (name: string): HTMLButtonElement => {
  const hit = [...win.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name);
  assert.ok(hit, `a key named "${name}"`);
  return hit as HTMLButtonElement;
};

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => {
  roll().setPartsOpen(true);
  roll().importParts(
    [
      {
        name: 'Piano',
        program: 0,
        notes: [{ id: 'p1', note: 48, step: 0, length: 8, velocity: 80 }],
        controls: [
          { tick: 0, controller: 7, value: 100 },
          { tick: 240, controller: 64, value: 127 },
          { tick: 1920, controller: 64, value: 0 },
          { tick: 1920, controller: 11, value: 90 },
        ],
      },
      { name: 'Cello', program: 42, notes: [{ id: 'c1', note: 36, step: 0, length: 8, velocity: 80 }] },
    ],
    100,
  );
});
await step(() => root.render(<MidiPanel />));

// The piano part is the one being edited: its settings list its controllers.
const list = q('[data-part-controls]');
assert.ok(list, 'the part lists its controller changes');
const rows = [...(list?.querySelectorAll('li') ?? [])].map((li) => li.textContent);
assert.deepEqual(rows, ['Volume · 1 change', 'Expression · 1 change', 'Sustain pedal · 2 changes']);
const heading = list?.querySelector('[id^="roll-part-controls-"]');
assert.equal(heading?.textContent, 'Controllers');
assert.equal(list?.querySelector('ul')?.getAttribute('aria-labelledby'), heading?.id, 'the list is named by its heading');

// CLEAR takes them away in one undo step; undo brings them back.
endRollGesture();
const steps = roll()._undo.length;
await step(() => key('Clear every controller change of Piano').click());
assert.equal(rollTracksOf(roll())[0].controls, undefined, 'the part has no controller changes');
assert.equal(roll()._undo.length, steps + 1, 'one undo step');
assert.equal(q('[data-part-controls]'), null, 'and no list');
assert.equal(rollTracksOf(roll())[0].notes.length, 1, 'its notes stay');
await step(() => roll().undo());
assert.equal(rollTracksOf(roll())[0].controls?.length, 4, 'undo brings them back');
assert.ok(q('[data-part-controls]'), 'with the list');

// The bank LSB field: named by its label, empty for a part that sends none, and a typed value is one undo step.
{
  const lsb = q<HTMLInputElement>('#roll-part-bank-lsb');
  assert.ok(lsb, 'an LSB field in the part settings');
  assert.equal(lsb.getAttribute('name'), 'roll-part-bank-lsb');
  assert.equal(q('label[for="roll-part-bank-lsb"]')?.textContent, 'LSB', 'named by its label');
  assert.equal(lsb.value, '', 'the piano sends none');
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
  endRollGesture();
  const before = roll()._undo.length;
  await step(() => {
    setValue.call(lsb, '3');
    lsb.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
  assert.equal(rollTracksOf(roll())[0].bankLsb, 3, 'typed, the part sends CC 32 = 3');
  assert.equal(roll()._undo.length, before + 1, 'one undo step');
  assert.equal(q<HTMLInputElement>('#roll-part-bank-lsb')?.value, '3');
  endRollGesture();
  await step(() => {
    setValue.call(lsb, '');
    lsb.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
  assert.equal(rollTracksOf(roll())[0].bankLsb, undefined, 'emptied, it sends none');
}

// A part without any shows no list.
const celloKey = [...win.document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Edit part Cello,'));
assert.ok(celloKey, "the cello's name key");
await step(() => (celloKey as HTMLButtonElement).click());
assert.equal(q('[data-part-controls]'), null, 'the cello has none');

// Nothing in the column prints under 12px.
const small = [...(q('#roll-parts')?.querySelectorAll('*') ?? [])].filter((el) => /text-\[(?:[0-9]|1[01])px\]/.test(el.getAttribute('class') ?? ''));
assert.equal(small.length, 0, 'no text under 12px in the parts column');

await step(() => root.unmount());
console.log('RollPartControls: ok');
