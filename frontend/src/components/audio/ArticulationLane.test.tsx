/**
 * Mount test for the articulation lane (stage 4.5): a violin line marked from
 * arco to pizzicato in the lane under the roll.
 *
 * The sequence: a violin part of eight notes comes in; the lane shows no
 * marker; the last four notes are selected and the SELECTED field (a real
 * label) sets them pizzicato in one undo step; the status says the pizzicato
 * plays GM 46 on a channel of its own; the lane now shows "pizz." over the
 * last four and "arco" nowhere before them; the pizzicato marker selects its
 * four notes; a mixed selection reads Mixed. Nothing prints under 12px.
 *
 *   cd frontend && npx tsx src/components/audio/ArticulationLane.test.tsx
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

const { ArticulationLane, PianoRollArticulationKey } = await import('./ArticulationLane.tsx');
const { endRollGesture, usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const roll = () => usePianoRollStore.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const q = <T extends Element>(sel: string): T | null => win.document.querySelector(sel) as T | null;
const buttons = () => [...win.document.querySelectorAll('[data-articulation-lane] [role="group"] button')] as HTMLButtonElement[];

await step(() => {
  roll().importParts(
    [
      {
        name: 'Violin',
        program: 40,
        instrumentId: 'violin',
        notes: Array.from({ length: 8 }, (_, i) => ({ id: `v${i}`, note: 67 + (i % 4), step: i * 4, length: 4, velocity: 90 })),
      },
    ],
    120,
  );
});
const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
await step(() =>
  root.render(
    <>
      <PianoRollArticulationKey on={false} onChange={() => {}} />
      <ArticulationLane stepPx={10} totalSteps={32} />
    </>,
  ),
);

const select = q<HTMLSelectElement>('[data-articulation-lane] select');
assert.ok(select, 'the SELECTED field');
assert.equal(select.getAttribute('name'), select.id);
assert.equal(q(`label[for="${select.id}"]`)?.textContent, 'Selected', 'named by its label');
assert.equal(select.disabled, true, 'nothing selected, nothing to set');
assert.equal(buttons().length, 0, 'an all-arco line shows no marker');
assert.match(q('[data-articulation-lane] [role="status"]')?.textContent ?? '', /Select notes/);

await step(() => roll().setSelection(['v4', 'v5', 'v6', 'v7']));
assert.equal(select.disabled, false);
assert.equal(select.value, '', 'ordinario (arco)');
assert.ok([...select.options].some((o) => o.textContent === 'Ordinario (arco)'), 'a string part names ordinario arco');
endRollGesture();
const undo = roll()._undo.length;
await step(() => {
  select.value = 'pizzicato';
  select.dispatchEvent(new win.Event('change', { bubbles: true }));
});
assert.deepEqual(roll().notes.filter((n) => n.articulation === 'pizzicato').map((n) => n.id), ['v4', 'v5', 'v6', 'v7']);
assert.equal(roll()._undo.length, undo + 1, 'one undo step');
assert.match(q('[data-articulation-lane] [role="status"]')?.textContent ?? '', /Pizzicato: GM 46 Pizzicato Strings on a channel of its own/);

const marks = buttons();
assert.deepEqual(marks.map((b) => b.textContent), ['pizz.'], 'one marker over the pizzicato run');
assert.equal(marks[0].getAttribute('aria-label'), 'Pizzicato, 4 notes: select them');
assert.equal(marks[0].style.left, '160px', 'at step 16');
await step(() => roll().setSelection(['v0']));
await step(() => marks[0].click());
assert.deepEqual([...roll().selectedIds].sort(), ['v4', 'v5', 'v6', 'v7'], 'the marker selects its notes');

// Back to arco after the pizzicato: the lane marks it.
await step(() => roll().setArticulation(['v7'], null));
assert.deepEqual(buttons().map((b) => b.textContent), ['pizz.', 'arco']);
await step(() => roll().setSelection(['v6', 'v7']));
assert.equal(select.value, 'mixed', 'a mixed selection reads Mixed');

const small = [...host.querySelectorAll('*')].filter((el) => /text-\[(?:[0-9]|1[01])px\]/.test(el.getAttribute('class') ?? ''));
assert.equal(small.length, 0, 'no text under 12px');

await step(() => root.unmount());
console.log('ArticulationLane: ok');
