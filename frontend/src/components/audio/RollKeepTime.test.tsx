/**
 * The roll strip's KEEP TIME key beside its BPM field (PianoRoll.tsx
 * PianoRollTransport), mounted against the real piano roll store.
 *
 * The sequence a user makes: a song's stem MIDI in the roll (its part marked
 * as timed against audio), a BPM typed into the field and Enter. KEEP TIME
 * starts on for that roll, so every note keeps its second. Pressed off, the
 * next BPM keeps every note in its bar. A roll written on the grid starts with
 * it off. The key is a real toggle button with a name and a pressed state.
 *
 *   cd frontend && npx tsx src/components/audio/RollKeepTime.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
for (const [key, value] of Object.entries({
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
})) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { PianoRollTransport } = await import('./PianoRoll.tsx');
const { usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const { stepClock } = await import('../../lib/rollTempo.ts');

const roll = () => usePianoRollStore.getState();
const valueSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
const type = (el: HTMLInputElement, text: string) => {
  valueSetter.call(el, text);
  el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text.slice(-1) }));
};
const enter = (el: HTMLElement) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
const onsets = () => {
  const clock = stepClock(roll().bpm, roll().tempoMap);
  return roll().notes.map((n) => clock.at(n.step));
};

// A song's transcribed part, at the 120 BPM its file was stamped at.
roll().importParts([{ name: 'Bass', fromAudio: true, notes: [
  { id: 'n1', note: 40, step: 2, length: 3, velocity: 90 },
  { id: 'n2', note: 43, step: 11, length: 5, velocity: 90 },
] }], 120);

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => root.render(<PianoRollTransport />));

const bpmField = host.querySelector<HTMLInputElement>('#piano-roll-bpm')!;
assert.ok(bpmField, 'the BPM field renders');
assert.equal(host.querySelector(`label[for="piano-roll-bpm"]`)?.textContent, 'BPM', 'the field has its label');
const keep = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Keep time'))!;
assert.ok(keep, 'KEEP TIME renders beside the BPM field');
assert.equal(keep.getAttribute('aria-pressed'), 'true', 'KEEP TIME starts on for a roll whose parts came from audio');
assert.ok(keep.getAttribute('aria-describedby'), 'its tip describes it');

const before = onsets();
await act(async () => {
  type(bpmField, '96');
  enter(bpmField);
});
assert.equal(roll().bpm, 96);
onsets().forEach((t, i) => assert.ok(Math.abs(t - before[i]) < 0.002, `note ${i} kept its second (${t} vs ${before[i]})`));

// Off: the next tempo keeps each note in its bar.
await act(async () => keep.click());
assert.equal(keep.getAttribute('aria-pressed'), 'false');
const steps = roll().notes.map((n) => n.step);
await act(async () => {
  type(bpmField, '110');
  enter(bpmField);
});
assert.equal(roll().bpm, 110);
assert.deepEqual(roll().notes.map((n) => n.step), steps, 'with KEEP TIME off the notes keep their steps');

// A roll written on the grid starts with KEEP TIME off.
await act(async () => {
  roll().importParts([{ name: 'Keys', notes: [{ id: 'k', note: 60, step: 4, length: 2, velocity: 80 }] }], 120);
});
assert.equal(keep.getAttribute('aria-pressed'), 'false', 'a grid roll starts with KEEP TIME off');
// The choice belongs to the roll it was made in: the next song's stems start with it on again.
await act(async () => {
  roll().importParts([{ name: 'Vocals', fromAudio: true, notes: [{ id: 'v', note: 67, step: 4, length: 2, velocity: 80 }] }], 120);
});
assert.equal(keep.getAttribute('aria-pressed'), 'true', "a new song's stems start with KEEP TIME on");

await act(async () => root.unmount());
console.log('RollKeepTime: ok');
