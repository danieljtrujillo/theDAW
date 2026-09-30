/**
 * Mount test for the roll's parts column (RollTrackColumn) inside the MIDI
 * tab, and the ghost notes it switches.
 *
 * The sequence a user makes: the MIDI tab opens on a roll of one part with
 * notes; ADD makes a second part and turns to it (the first part's notes now
 * draw behind as ghost notes); the part is renamed and given the viola from
 * the Sound list, which names its row; a note drawn goes into it; MUTE and
 * SOLO press on its row; AUDITION solos it alone; the first part's name turns
 * back to it; GHOSTS hides the other part's notes; the column hides and shows.
 * Every control is checked for its label: the native fields by <label for>,
 * the keys by aria-label and aria-pressed.
 *
 * The notes draw on a canvas (RollNotesCanvas): the counts it drew sit on the
 * canvas as data attributes, and a recording 2D context stands in for the
 * browser's so the ghost colour is read off the real paint calls.
 *
 * Client-rendered (createRoot on jsdom), in the MidiPanel.test.tsx pattern.
 *
 *   cd frontend && npx tsx src/components/audio/RollTrackColumn.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { rollTracksOf, usePianoRollStore } = await import('../../state/pianoRollStore.ts');

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
/** A native field and the <label for> that names it. */
const field = <T extends HTMLElement>(id: string, label: RegExp): T => {
  const el = q<T>(`#${id}`);
  assert.ok(el, `#${id} is there`);
  assert.ok(el.getAttribute('name'), `#${id} has a name`);
  const lab = q<HTMLLabelElement>(`label[for="${id}"]`);
  assert.ok(lab && label.test(lab.textContent ?? ''), `#${id} has its label`);
  return el;
};
const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = el instanceof win.HTMLSelectElement ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new win.Event(el instanceof win.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};
/** A 2D context that records each fill: its style, strength and the rects in the path. A paint starts with clearRect. */
class RecordingContext {
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  globalAlpha = 1;
  lineWidth = 1;
  path: number[][] = [];
  fills: { style: string; alpha: number; rects: number[][] }[] = [];
  beginPath() { this.path = []; }
  rect(x: number, y: number, w: number, h: number) { this.path.push([x, y, w, h]); }
  fill() { this.fills.push({ style: String(this.fillStyle), alpha: this.globalAlpha, rects: [...this.path] }); }
  stroke() {}
  fillRect(x: number, y: number, w: number, h: number) { this.fills.push({ style: String(this.fillStyle), alpha: this.globalAlpha, rects: [[x, y, w, h]] }); }
  clearRect() { this.fills = []; }
  setTransform() {}
}
const contexts = new WeakMap<object, RecordingContext>();
Object.defineProperty(win.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value(this: object) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = new RecordingContext();
      contexts.set(this, ctx);
    }
    return ctx;
  },
});
const notesCanvas = () => q<HTMLCanvasElement>('canvas[data-roll-notes]');
const ghostRects = () => Number(notesCanvas()?.dataset.ghosts ?? 0);
const drawnNotes = () => Number(notesCanvas()?.dataset.notes ?? 0);
/** The rects the last paint filled in `color`. */
const filledIn = (color: string) => {
  const canvas = notesCanvas();
  const ctx = canvas ? contexts.get(canvas) : undefined;
  return (ctx?.fills ?? []).filter((f) => f.style === color).reduce((n, f) => n + f.rects.length, 0);
};

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => {
  roll().setPartsOpen(true);
  roll().setShowGhosts(true);
  roll().importNotes(
    [
      { id: 'a', note: 60, step: 0, length: 2, velocity: 90 },
      { id: 'b', note: 64, step: 4, length: 2, velocity: 90 },
      { id: 'c', note: 67, step: 8, length: 2, velocity: 90 },
    ],
    120,
  );
});
await step(() => root.render(<MidiPanel />));

// One part: its row, its keys, no ghosts.
assert.ok(q('[data-roll-parts="open"]'), 'the parts column is open');
assert.equal(win.document.querySelectorAll('[data-roll-part]').length, 1);
assert.equal(key('Edit part Part 1, Roll voice, 3 notes').getAttribute('aria-pressed'), 'true', "the first part's name key says it is the one being edited");
assert.equal(ghostRects(), 0, 'no other part, no ghost notes');
field('roll-part-name', /Name/);
field('roll-part-sound', /Sound/);
field('roll-part-channel', /Channel/);
field('roll-part-bank', /Bank/);
const firstId = roll().activeTrackId;
field(`roll-part-color-${firstId}`, /Colour of Part 1/);

// ADD: a second part, turned to, with the first part's notes as ghosts.
await step(() => key('Add a part').click());
assert.equal(roll().tracks.length, 2);
const secondId = roll().activeTrackId;
assert.notEqual(secondId, firstId, 'the new part is the one being edited');
assert.equal(win.document.querySelectorAll('[data-roll-part]').length, 2, 'two rows');
assert.equal(ghostRects(), 3, "the first part's three notes draw as ghosts");
assert.equal(drawnNotes(), 0, 'the new part has no notes of its own');

// Rename it and give it the viola.
await step(() => setValue(field<HTMLInputElement>('roll-part-name', /Name/), 'Viola 1'));
await step(() => {
  field<HTMLInputElement>('roll-part-name', /Name/).dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
});
assert.equal(rollTracksOf(roll())[1].name, 'Viola 1', 'the name commits when the field loses focus');
await step(() => setValue(field<HTMLSelectElement>('roll-part-sound', /Sound/), 'o:viola'));
const viola = rollTracksOf(roll())[1];
assert.deepEqual([viola.program, viola.instrumentId, viola.name], [41, 'viola', 'Viola 1'], 'the viola sets program 41 and keeps the name given');
assert.ok(key('Edit part Viola 1, Viola, 0 notes'), "the row says the part's name and sound");

// A note drawn now goes into the viola, not the first part.
await step(() => {
  roll().addNote({ note: 55, step: 12, length: 2, velocity: 90 });
});
assert.deepEqual(rollTracksOf(roll()).map((t) => t.notes.length), [3, 1]);

// MUTE, SOLO, AUDITION.
await step(() => key('Mute Viola 1').click());
assert.equal(key('Mute Viola 1').getAttribute('aria-pressed'), 'true');
assert.equal(rollTracksOf(roll())[1].mute, true);
await step(() => key('Mute Viola 1').click());
await step(() => key('Solo Part 1').click());
assert.equal(key('Solo Part 1').getAttribute('aria-pressed'), 'true');
await step(() => key('Audition Viola 1 alone').click());
assert.deepEqual(roll().tracks.map((t) => t.solo), [false, true], 'audition solos the viola alone');
assert.equal(key('Stop auditioning Viola 1 alone').getAttribute('aria-pressed'), 'true');
await step(() => key('Stop auditioning Viola 1 alone').click());
assert.deepEqual(roll().tracks.map((t) => t.solo), [false, false], 'and again clears every solo');

// Back to the first part: its notes in the grid, the viola's as a ghost.
await step(() => key('Edit part Part 1, Roll voice, 3 notes').click());
assert.equal(roll().activeTrackId, firstId);
assert.equal(drawnNotes(), 3);
assert.equal(ghostRects(), 1, "the viola's note is a ghost");
assert.equal(filledIn(viola.color), 1, 'in the viola’s colour');

// GHOSTS off and on.
await step(() => key('Ghost notes: draw the other parts behind this one').click());
assert.equal(ghostRects(), 0, 'ghosts hidden');
await step(() => key('Ghost notes: draw the other parts behind this one').click());
assert.equal(ghostRects(), 1);

// Move the viola up, then remove it; undo brings it back.
await step(() => roll().setActiveTrack(secondId));
await step(() => key('Move Viola 1 up').click());
assert.equal(roll().tracks[0].id, secondId, 'the viola moved to the top');
await step(() => key('Remove Viola 1').click());
assert.equal(roll().tracks.length, 1);
await step(() => roll().undo());
assert.equal(roll().tracks.length, 2, 'undo brings the removed part back');

// The column hides to a strip of swatches and shows again.
await step(() => key('Hide the parts column').click());
assert.ok(q('[data-roll-parts="closed"]'), 'the column is a strip');
assert.ok(key('Edit part Part 1'), 'a swatch per part');
await step(() => key('Show the parts column, 2 parts').click());
assert.ok(q('[data-roll-parts="open"]'));

// Nothing in the column prints under 12px.
const small = [...(q('#roll-parts')?.querySelectorAll('*') ?? [])].filter((el) => /text-\[(?:[0-9]|1[01])px\]/.test(el.getAttribute('class') ?? ''));
assert.equal(small.length, 0, 'no text under 12px in the parts column');

await step(() => root.unmount());
console.log('RollTrackColumn: ok');
