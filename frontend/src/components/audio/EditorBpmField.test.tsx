/**
 * Mount test for the EDIT toolbar's BPM field (EditorBpmField.tsx) against the
 * real editor store.
 *
 * The sequence a user makes: select the field and type 140, digit by digit,
 * then Enter; type a slow introduction's 24.25 and click away; type something
 * and press Escape; step with the spin buttons. Up to cb4f3e20 the field
 * applied every keystroke, so the "1" of 140 was clamped to 40 on the way in,
 * and it stopped at 40-240 and dropped the fraction.
 *
 *   cd frontend && npx tsx src/components/audio/EditorBpmField.test.tsx
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
const { EditorBpmField } = await import('./EditorBpmField.tsx');
const { useEditorStore } = await import('../../state/editorStore.ts');

const store = () => useEditorStore.getState();
const step = (fn: () => void) => act(async () => { fn(); });
const valueSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
/** Typing: the value changes and an InputEvent says it was typed. */
const type = (el: HTMLInputElement, text: string) => {
  valueSetter.call(el, text);
  el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text.slice(-1) }));
};
/** A spin-button or arrow-key step: a plain input event with no inputType. */
const spin = (el: HTMLInputElement, text: string) => {
  valueSetter.call(el, text);
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
};
const key = (el: HTMLElement, k: string) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
const blur = (el: HTMLElement) => el.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));

function Toolbar() {
  const bpm = useEditorStore((s) => s.bpm);
  const setBpm = useEditorStore((s) => s.setBpm);
  return <EditorBpmField bpm={bpm} onChange={setBpm} />;
}

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
await step(() => store().loadProject({ tracks: [], clips: [], bpm: 120 }));
await step(() => root.render(<Toolbar />));

const field = win.document.getElementById('editor-bpm') as HTMLInputElement;
assert.ok(field, 'the toolbar shows the BPM field');
assert.equal(field.name, 'editor-bpm');
assert.ok(win.document.querySelector('label[for="editor-bpm"]'), 'with a label');
assert.equal(field.min, '20');
assert.equal(field.max, '300');
assert.equal(field.value, '120');

// 140, one digit at a time: nothing applies until Enter.
await step(() => type(field, '1'));
assert.equal(store().bpm, 120, 'a first typed digit changes nothing yet');
assert.equal(field.value, '1', 'and the field shows what was typed');
await step(() => type(field, '14'));
await step(() => type(field, '140'));
await step(() => { key(field, 'Enter'); });
assert.equal(store().bpm, 140);
assert.equal(field.value, '140');

// A slow introduction, below the old 40 floor, with its fraction; blur applies it.
await step(() => type(field, '24.25'));
await step(() => { blur(field); });
assert.equal(store().bpm, 24.25);
assert.equal(field.value, '24.25');

// Escape drops what was typed.
await step(() => type(field, '99'));
await step(() => { key(field, 'Escape'); });
assert.equal(store().bpm, 24.25);
assert.equal(field.value, '24.25');

// A spin-button step applies at once.
await step(() => spin(field, '25.25'));
assert.equal(store().bpm, 25.25);

// Past the ceiling holds at 300.
await step(() => type(field, '500'));
await step(() => { key(field, 'Enter'); });
assert.equal(store().bpm, 300);

await step(() => root.unmount());
console.log('EditorBpmField: ok');
