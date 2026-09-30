/**
 * The MIDI tab's CLEAN key (RollCleanup.tsx, lib/rollCleanup,
 * lib/clipNotes oneAtATime), mounted in the MIDI tab against the real store.
 *
 * Before: the note clean-up tools could only be asked of the assistant. The
 * sequence now: a bass transcription with a harmonic over each note and a
 * rumble under it is in the roll; CLEAN sits on the rail after TRANSFORM,
 * opens a card whose controls have real labels, and ONE AT A TIME with
 * "Bottom line" leaves the bass line, in one undo step. KEEP RANGE, set
 * from the electric bass's range, removes a whistle-register blip. On a
 * selection, only the selected notes change and they stay selected. Every
 * word on the card is 12px or larger.
 *
 *   cd frontend && npx tsx src/components/audio/RollCleanup.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
for (const [k, value] of Object.entries({
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
})) {
  Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async () => new Response('{}', { status: 404 }),
});

const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { endRollGesture, usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const { oneAtATime } = await import('../../lib/clipNotes/index.ts');
const { useLogStore } = await import('../../state/logStore.ts');
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const roll = () => usePianoRollStore.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const q = <T extends Element>(sel: string): T | null => win.document.querySelector(sel) as T | null;
const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
const setSelect = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!;
const note = (id: string, pitch: number, tick: number, ticks: number) => ({ id, note: pitch, tick, ticks, step: tick / 240, length: ticks / 240, velocity: 80 });
const smallText = (el: Element | null): string[] =>
  el ? [...el.querySelectorAll('*'), el].flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/)).filter((c) => /^text-\[(\d+)px\]$/.test(c) && Number(/\d+/.exec(c)![0]) < 12 || /^text-(xs|2xs|3xs)$/.test(c)) : [];

// The pure reduction first.
{
  const notes = [note('a', 60, 0, 960), note('b', 64, 0, 960), note('c', 55, 480, 960), note('d', 67, 720, 480)];
  const top = oneAtATime(notes, 'top');
  assert.deepEqual(top.notes.map((n) => [n.id, n.tick, n.ticks]), [['b', 0, 720], ['d', 720, 480]], 'the top line: the higher note, cut where a higher one starts');
  assert.equal(top.dropped, 2);
  assert.equal(top.shortened, 1);
  const bottom = oneAtATime(notes, 'bottom');
  assert.deepEqual(bottom.notes.map((n) => [n.id, n.tick, n.ticks]), [['a', 0, 480], ['c', 480, 960]], 'the bottom line');
  const latest = oneAtATime(notes, 'latest');
  assert.deepEqual(latest.notes.map((n) => [n.id, n.tick, n.ticks]), [['b', 0, 480], ['c', 480, 240], ['d', 720, 480]], 'each note cuts the one before it');
  assert.equal(latest.notes.every((n) => n.step === n.tick! / 240 && n.length === n.ticks! / 240), true, 'steps follow the ticks');
  // A pitch struck again while it still sounds (a transcriber's re-attack) is the same line in every mode:
  // the new attack cuts the old one and plays on, so the line keeps both attacks and sounds to the second one's end.
  const again = [note('x', 60, 0, 960), note('y', 60, 480, 960)];
  for (const keep of ['top', 'bottom', 'latest'] as const) {
    const res = oneAtATime(again, keep);
    assert.deepEqual(res.notes.map((n) => [n.id, n.tick, n.ticks]), [['x', 0, 480], ['y', 480, 960]], `${keep}: the second attack stays`);
    assert.equal(res.dropped, 0);
    assert.equal(res.shortened, 1);
  }
}

// A bass transcription: each bass note with a harmonic an octave and a fifth up over it, a rumble under the first, a blip up high.
await step(() => {
  roll().importParts([{ name: 'Bass', instrumentId: 'electric-bass', program: 33, notes: [
    note('b1', 40, 0, 960), note('h1', 59, 0, 900),
    note('r1', 16, 100, 400),
    note('b2', 43, 960, 960), note('h2', 62, 1000, 800),
    note('b3', 45, 1920, 960), note('w3', 110, 2000, 40),
  ] }], 100);
});
const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
await step(() => root.render(<MidiPanel />));

const rail = q('[role="group"][aria-label="MIDI actions"]');
assert.ok(rail, 'the action rail');
const railNames = [...rail.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? '');
const transformAt = railNames.findIndex((n) => n.startsWith('Transform'));
assert.ok(railNames[transformAt + 1]?.startsWith('Clean up the notes'), `CLEAN follows TRANSFORM on the rail (${railNames.join(' | ')})`);
const cleanKey = rail.querySelector<HTMLButtonElement>('button[aria-controls="piano-roll-clean-card"]')!;
assert.equal(cleanKey.getAttribute('aria-haspopup'), 'dialog');
assert.equal(cleanKey.getAttribute('aria-expanded'), 'false');
await step(() => cleanKey.click());
assert.equal(cleanKey.getAttribute('aria-expanded'), 'true');
const card = q<HTMLElement>('#piano-roll-clean-card');
assert.ok(card, 'the card opens');
assert.equal(card.getAttribute('role'), 'dialog');
assert.equal(card.getAttribute('aria-label'), 'Clean up the notes');
assert.deepEqual(smallText(card), [], 'no text under 12px on the card');
// Every field has an id, a name and a label that names it.
for (const field of card.querySelectorAll('input, select')) {
  assert.ok(field.id && field.getAttribute('name') === field.id, `${field.id} has an id and a name`);
  assert.ok(card.querySelector(`label[for="${field.id}"]`)?.textContent, `${field.id} has a label`);
}
assert.equal(card.querySelectorAll('label button, label [role]').length, 0, 'no custom control inside a label');
const low = q<HTMLInputElement>('#piano-roll-clean-low')!;
const high = q<HTMLInputElement>('#piano-roll-clean-high')!;
assert.equal(low.value, '28', "the range starts at the electric bass's E1");
assert.equal(high.value, '67', 'and ends at its G4');
assert.equal(q('#piano-roll-clean-low-name')?.textContent, 'E1');

// KEEP RANGE removes the rumble and the whistle.
const keyNamed = (start: string) => [...card.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label')?.startsWith(start))!;
endRollGesture();
useLogStore.getState().clear();
const before = roll()._undo.length;
await step(() => keyNamed('Keep range').click());
assert.deepEqual(roll().notes.map((n) => n.id).sort(), ['b1', 'b2', 'b3', 'h1', 'h2'], 'the notes outside E1 to G4 are gone');
assert.equal(roll()._undo.length, before + 1, 'one undo step');
assert.match(useLogStore.getState().entries.at(-1)?.msg ?? '', /Keep range E1 to G4: 7 notes of the part, 2 outside it removed/);

// ONE AT A TIME with the bottom line leaves the bass.
const keep = q<HTMLSelectElement>('#piano-roll-clean-keep')!;
assert.deepEqual([...keep.options].map((o) => o.textContent), ['Top line', 'Bottom line', 'Latest note']);
await step(() => {
  setSelect.call(keep, 'bottom');
  keep.dispatchEvent(new win.Event('change', { bubbles: true }));
});
endRollGesture();
await step(() => keyNamed('One at a time').click());
assert.deepEqual(roll().notes.map((n) => n.id), ['b1', 'b2', 'b3'], 'the bass line alone');
assert.match(useLogStore.getState().entries.at(-1)?.msg ?? '', /One at a time \(bottom line\): 5 notes of the part, 2 removed/);
await step(() => roll().undo());
assert.equal(roll().notes.length, 5, 'undo brings the harmonics back');

// On a selection: only the selected notes change, and they stay selected.
await step(() => roll().setSelection(['b2', 'h2']));
await step(() => {
  setSelect.call(keep, 'top');
  keep.dispatchEvent(new win.Event('change', { bubbles: true }));
});
assert.ok(keyNamed('One at a time: keep the top line of the 2 selected notes'), 'the key names what it works on');
endRollGesture();
await step(() => keyNamed('One at a time').click());
const byId = (id: string) => roll().notes.find((n) => n.id === id)!;
assert.equal(byId('b2').ticks, 40, 'b2 is cut where the higher note over it starts');
assert.equal(byId('h2').ticks, 800, 'the higher note keeps its length');
assert.equal(byId('b1').ticks, 960, 'a note outside the selection is untouched, though its harmonic overlaps it');
assert.equal(roll().notes.length, 5);
assert.deepEqual([...roll().selectedIds].sort(), ['b2', 'h2'], 'the notes left stay selected');

// The field accepts a typed pitch.
await step(() => {
  setValue.call(low, '40');
  low.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '0' }));
});
assert.equal(q('#piano-roll-clean-low-name')?.textContent, 'E2');

await step(() => root.unmount());
console.log('RollCleanup: ok');
