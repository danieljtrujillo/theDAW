/**
 * Mount test for the MIDI tab's IMPORT flyout (MidiImportPopover) and its
 * "As EDIT tracks" row.
 *
 * The sequence a user makes: IMPORT opens the flyout; "As EDIT tracks" opens a
 * file picker, and the MIDI file picked goes to the handler that puts its
 * parts on EDIT tracks (lib/midiImportTracksApp), while "File" still goes to
 * the roll. Every control is checked for its label: the hidden inputs by
 * <label for>, the keys by aria-label, the flyout's state by aria-expanded.
 * Nothing in the flyout prints under 12px.
 *
 *   cd frontend && npx tsx src/components/audio/MidiImportPopover.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Loaded before the DOM globals exist, as MidiPanel.test.tsx loads the panel: a store it reaches reads Vite's env only in a browser.
const { MidiImportPopover } = await import('./MidiImportPopover.tsx');

const dom = new JSDOM('<!doctype html><html><body><div data-dock-floor></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
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
  File: win.File,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async () => new Response(JSON.stringify({ midis: [], count: 0, items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
});

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const byLabel = (name: string): HTMLButtonElement => {
  const hit = [...win.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name);
  assert.ok(hit, `a key named "${name}"`);
  return hit as HTMLButtonElement;
};
const field = (id: string, label: RegExp): HTMLInputElement => {
  const el = win.document.getElementById(id) as HTMLInputElement | null;
  assert.ok(el, `#${id} is there`);
  assert.equal(el.getAttribute('name'), id, `#${id} has its name`);
  const lab = win.document.querySelector(`label[for="${id}"]`);
  assert.ok(lab && label.test(lab.textContent ?? ''), `#${id} has its label`);
  return el;
};
/** Hand `files` to a hidden file input as the OS picker would. */
const pick = (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
};

const toRoll: File[] = [];
const toTracks: File[] = [];
const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
await step(() =>
  root.render(
    <MidiImportPopover onImportFile={(f) => toRoll.push(f)} onImportSheetFile={() => undefined} onImportTracksFile={(f) => toTracks.push(f)} />,
  ),
);

// The hidden pickers, each with its label.
const tracksInput = field('piano-roll-import-tracks', /MIDI file to import as EDIT tracks/);
const rollInput = field('piano-roll-import-midi', /MIDI file to import/);
assert.equal(tracksInput.type, 'file');
assert.match(tracksInput.accept, /\.mid/);

// IMPORT opens the flyout, and says so.
const importKey = byLabel('Import MIDI');
assert.equal(importKey.getAttribute('aria-expanded'), 'false');
await step(() => importKey.click());
assert.equal(importKey.getAttribute('aria-expanded'), 'true');
const flyout = win.document.getElementById('piano-roll-import-popover');
assert.ok(flyout, 'the flyout is open');

// "As EDIT tracks": its key opens its own picker.
const asTracks = byLabel('Import a MIDI file into EDIT as tracks, one track per part');
assert.match(asTracks.textContent ?? '', /As EDIT tracks/);
let clicked = 0;
tracksInput.click = () => {
  clicked += 1;
};
await step(() => asTracks.click());
assert.equal(clicked, 1, 'the key opens the file picker');
assert.match(flyout?.textContent ?? '', /As EDIT tracks puts each part on an EDIT track of its own/);

// A file picked there goes to the tracks handler, one picked from File to the roll.
const quartet = new win.File([new Uint8Array([0x4d, 0x54, 0x68, 0x64])], 'quartet.mid', { type: 'audio/midi' });
await step(() => pick(tracksInput, [quartet]));
assert.deepEqual(toTracks.map((f) => f.name), ['quartet.mid'], 'the file goes to Import as tracks');
assert.equal(toRoll.length, 0, 'and not into the roll');
await step(() => importKey.click());
await step(() => pick(rollInput, [quartet]));
assert.deepEqual(toRoll.map((f) => f.name), ['quartet.mid'], 'File still goes into the roll');

// Nothing in the flyout prints under 12px.
await step(() => importKey.click());
const open = win.document.getElementById('piano-roll-import-popover');
const small = [...(open?.querySelectorAll('*') ?? [])].filter((el) => /text-\[(?:[0-9]|1[01])px\]/.test(el.getAttribute('class') ?? ''));
assert.equal(small.length, 0, 'no text under 12px in the flyout');

// Without the handler, the row is not offered.
await step(() => root.render(<MidiImportPopover onImportFile={() => undefined} />));
assert.equal(win.document.getElementById('piano-roll-import-tracks'), null, 'no tracks picker without a handler');

await step(() => root.unmount());
console.log('MidiImportPopover: ok');
