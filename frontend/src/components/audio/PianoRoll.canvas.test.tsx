/**
 * The roll's note canvas, mounted in the MIDI tab: the pointer finds notes
 * through the interval index where the canvas draws them, the keyboard and a
 * screen reader reach them through the focus layer, the overview jumps the
 * grid, a 4,096-bar roll draws only the ruler bars and grid lines in view, and
 * the zoom goes down to one pixel a step.
 *
 * The sequence a user makes: the MIDI tab opens on a roll of three notes. A
 * press and click on the second note selects it; a second click deletes it;
 * undo brings it back. A drag on its right edge lengthens it; released past
 * the snapped end, or pressed on the note and let go 2 px down in the row
 * below, the click adds no note. A right-click on it opens its menu. Tab to the
 * selected note: it is named; Alt+Right selects the next note, Enter and Space
 * open the menu, and Space never reaches EDIT's PLAY key. Every 4/4 bar prints
 * its number, with or without a 2/16 bar far off screen. Then the window is
 * 1920x1080, where the
 * shell's CSS zoom scales every client point: a click on a note selects the
 * note drawn under the pointer, a click on an empty cell adds the note there,
 * an edge drag and a marquee land in grid px, the ruler seeks the step under
 * the pointer, and the canvas is drawn at the zoom. A click on the overview's
 * right half scrolls the grid there, and its arrow keys move a bar. The roll
 * grows to 65,536 steps: the ruler and the grid draw the bars in view. The
 * roll's markers draw their lines down the grid. Zoom out to the floor.
 *
 * jsdom has no layout: every box is at 0,0, so a client point is a grid point
 * times the zoom, and the grid's view is the window's size (1024x768). A
 * recording 2D context stands in for the canvas, and a silent AudioContext for
 * the engine the auditions play on.
 *
 *   cd frontend && npx tsx src/components/audio/PianoRoll.canvas.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Imported before `window` exists: a module that reads import.meta.env under a window (playerStore) is then skipped.
const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { usePianoRollStore } = await import('../../state/pianoRollStore.ts');

/* ── a silent AudioContext: every node connects, nothing sounds ── */
class FakeParam {
  value = 0;
  setValueAtTime(): FakeParam { return this; }
  linearRampToValueAtTime(): FakeParam { return this; }
  exponentialRampToValueAtTime(): FakeParam { return this; }
  setTargetAtTime(): FakeParam { return this; }
  cancelScheduledValues(): FakeParam { return this; }
}
class FakeNode {
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly detune = new FakeParam();
  readonly playbackRate = new FakeParam();
  fftSize = 2048;
  smoothingTimeConstant = 0;
  frequencyBinCount = 1024;
  type = '';
  buffer: unknown = null;
  connect(d: unknown): unknown { return d; }
  disconnect(): void {}
  start(): void {}
  stop(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  getFloatTimeDomainData(): void {}
  getByteFrequencyData(): void {}
  getFloatFrequencyData(): void {}
}
class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  sampleRate = 48000;
  outputLatency = 0;
  baseLatency = 0;
  destination = new FakeNode();
  createGain(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode { return new FakeNode(); }
  createMediaElementSource(): FakeNode { return new FakeNode(); }
  createBiquadFilter(): FakeNode { return new FakeNode(); }
  createDynamicsCompressor(): FakeNode { return new FakeNode(); }
  createOscillator(): FakeNode { return new FakeNode(); }
  createBufferSource(): FakeNode { return new FakeNode(); }
  createStereoPanner(): FakeNode { return new FakeNode(); }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (c: number) => data[c] };
  }
  resume(): Promise<void> { return Promise.resolve(); }
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
Object.defineProperty(win, 'AudioContext', { value: FakeAudioContext, configurable: true });
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement,
  HTMLSelectElement: win.HTMLSelectElement,
  Node: win.Node,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
  KeyboardEvent: win.KeyboardEvent,
  Audio: win.Audio,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  AudioContext: FakeAudioContext,
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async () => new Response('{}', { status: 404 }) });

/** A 2D context that records the rects of each fill and of each fillRect. A paint starts with clearRect. */
class RecordingContext {
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  globalAlpha = 1;
  lineWidth = 1;
  transform: number[] = [];
  path: number[][] = [];
  fills: { style: string; rects: number[][] }[] = [];
  beginPath() { this.path = []; }
  rect(x: number, y: number, w: number, h: number) { this.path.push([x, y, w, h]); }
  fill() { this.fills.push({ style: String(this.fillStyle), rects: [...this.path] }); }
  stroke() {}
  fillRect(x: number, y: number, w: number, h: number) { this.fills.push({ style: String(this.fillStyle), rects: [[x, y, w, h]] }); }
  clearRect() { this.fills = []; }
  setTransform(...m: number[]) { this.transform = m; }
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
const fire = (el: Element, type: string, init: MouseEventInit): void => {
  el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
};
const press = (el: Element, x: number, y: number, extra: MouseEventInit = {}) => {
  fire(el, 'pointerdown', { clientX: x, clientY: y, ...extra });
  fire(el, 'pointerup', { clientX: x, clientY: y, ...extra });
  fire(el, 'click', { clientX: x, clientY: y, ...extra });
};
const kb = (el: Element, k: string, init: KeyboardEventInit = {}): void => {
  el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
};
/** A scroll of the grid, and the animation frame its repaint waits for. */
const scrolled = (el: Element) =>
  step(async () => {
    fire(el, 'scroll', {});
    await new Promise((r) => setTimeout(r, 40));
  });

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => {
  roll().importNotes(
    [
      { id: 'a', note: 60, step: 0, length: 2, velocity: 90 },
      { id: 'b', note: 64, step: 4, length: 2, velocity: 70 },
      { id: 'c', note: 67, step: 8, length: 2, velocity: 50 },
    ],
    120,
  );
});
await step(() => root.render(<MidiPanel />));

const canvas = q<HTMLCanvasElement>('canvas[data-roll-notes]');
assert.ok(canvas, 'the notes draw on a canvas');
assert.equal(win.document.querySelectorAll('[data-piano-note]').length, 0, 'no note is a DOM element any more');
assert.equal(canvas.dataset.notes, '3', 'the three notes are drawn');
const grid = canvas.parentElement?.parentElement as HTMLElement;
const scroller = grid.parentElement as HTMLElement;
assert.ok(grid.className.includes('cursor-crosshair'), 'the canvas sits in the grid');
// jsdom: the grid is at 0,0 and the scroll box at the scrollTop the roll centred on.
const stepPx = 16;
const highest = roll().highestNote;
const yOf = (pitch: number) => (highest - pitch) * 12 + 6;
const xOf = (s: number) => s * stepPx + 4;

// A resting pointer shows the note under it: its details in the grid's tooltip.
await step(() => fire(scroller, 'pointermove', { clientX: xOf(4), clientY: yOf(64) }));
assert.equal(grid.title, 'E4 · step 5 · 2 steps', 'the hovered note names itself');
await step(() => fire(scroller, 'pointermove', { clientX: xOf(20), clientY: yOf(64) }));
assert.equal(grid.title, '', 'off every note, no tooltip');

// Press and click the second note: selected. Again: deleted. Undo: back.
await step(() => press(grid, xOf(4), yOf(64)));
assert.deepEqual([...roll().selectedIds], ['b'], 'a click on the canvas selects the note drawn there');
assert.equal(canvas.dataset.selected, '1');
await step(() => press(grid, xOf(4), yOf(64)));
assert.deepEqual(roll().notes.map((n) => n.id), ['a', 'c'], 'a second click deletes it');
await step(() => roll().undo());
assert.deepEqual(roll().notes.map((n) => n.id).sort(), ['a', 'b', 'c']);
// A click on empty grid still adds a note.
await step(() => press(grid, xOf(12), yOf(72)));
assert.equal(roll().notes.length, 4, 'an empty cell takes a new note');
await step(() => roll().undo());

// Drag the right edge (the last 6px of the drawn box): the note grows on the snap grid.
const edgeX = 4 * stepPx + 2 * stepPx - 1 - 2;
await step(() => fire(grid, 'pointerdown', { clientX: edgeX, clientY: yOf(64) }));
await step(() => fire(scroller, 'pointermove', { clientX: edgeX + 2 * stepPx, clientY: yOf(64) }));
await step(() => fire(scroller, 'pointerup', { clientX: edgeX + 2 * stepPx, clientY: yOf(64) }));
await step(() => fire(grid, 'click', { clientX: edgeX + 2 * stepPx, clientY: yOf(64) }));
assert.equal(roll().notes.find((n) => n.id === 'b')?.length, 4, 'the edge drag lengthens the note to 4 steps');
await step(() => roll().undo());
assert.equal(roll().notes.find((n) => n.id === 'b')?.length, 2);

// The same drag 7 px further: the end snaps to step 8 with the pointer at step
// 8.25, past the note. The click that ends the resize is the resize's own and
// adds nothing there. Shortened the same way, the pointer ends 4 px past the
// new end: nothing added either.
await step(() => fire(grid, 'pointerdown', { clientX: edgeX, clientY: yOf(64) }));
await step(() => fire(scroller, 'pointermove', { clientX: edgeX + 2 * stepPx + 7, clientY: yOf(64) }));
await step(() => fire(scroller, 'pointerup', { clientX: edgeX + 2 * stepPx + 7, clientY: yOf(64) }));
await step(() => fire(grid, 'click', { clientX: edgeX + 2 * stepPx + 7, clientY: yOf(64) }));
assert.equal(roll().notes.find((n) => n.id === 'b')?.length, 4, 'the end snaps to step 8');
assert.equal(roll().notes.length, 3, 'the click that ends a resize past the note adds no note');
assert.deepEqual([...roll().selectedIds], ['b'], 'the resized note stays selected');
await step(() => roll().undo());
await step(() => fire(grid, 'pointerdown', { clientX: edgeX, clientY: yOf(64) }));
await step(() => fire(scroller, 'pointermove', { clientX: edgeX - 9, clientY: yOf(64) }));
await step(() => fire(scroller, 'pointerup', { clientX: edgeX - 9, clientY: yOf(64) }));
await step(() => fire(grid, 'click', { clientX: edgeX - 9, clientY: yOf(64) }));
assert.equal(roll().notes.find((n) => n.id === 'b')?.length, 1, 'the end snaps back to step 5');
assert.equal(roll().notes.length, 3, 'shortened, the click past the new end adds no note');
await step(() => roll().undo());
assert.equal(roll().notes.find((n) => n.id === 'b')?.length, 2);

// A press on the note's body 1 px above the row line under it, let go 2 px
// lower (under the drag threshold, in E-flat4's row): a click on the note it
// pressed, which is selected, and no note in the row below.
const rowLine = (highest - 63) * 12;
await step(() => roll().setSelection([]));
await step(() => fire(grid, 'pointerdown', { clientX: xOf(5), clientY: rowLine - 1 }));
await step(() => fire(scroller, 'pointermove', { clientX: xOf(5), clientY: rowLine + 1 }));
await step(() => fire(scroller, 'pointerup', { clientX: xOf(5), clientY: rowLine + 1 }));
await step(() => fire(grid, 'click', { clientX: xOf(5), clientY: rowLine + 1 }));
assert.equal(roll().notes.length, 3, 'the wobble adds no note in the row below');
assert.deepEqual([...roll().selectedIds], ['b'], 'the pressed note is selected');
assert.equal(roll().notes.find((n) => n.id === 'b')?.note, 64, 'and stays in its row');
await step(() => roll().setSelection([]));

// Right-click the note: its menu, and it is selected.
await step(() => roll().setSelection([]));
await step(() => fire(grid, 'contextmenu', { clientX: xOf(0), clientY: yOf(60), button: 2 }));
assert.deepEqual([...roll().selectedIds], ['a'], 'the right-clicked note takes the selection');
assert.ok(q('[role="menu"]'), 'its menu opens');
assert.ok([...win.document.querySelectorAll('[role="menuitem"]')].some((m) => /Delete note/.test(m.textContent ?? '')));
await step(() => kb(q('[role="menu"]') as Element, 'Escape'));

// The focus layer: the selected note is a focusable, named box; Alt+Right walks to the next note; Enter opens the menu.
await step(() => roll().setSelectedNote('a'));
const focusNote = () => q<HTMLElement>('[data-note-focus]');
assert.ok(focusNote(), 'the selected note has a focusable box');
assert.equal(focusNote()?.getAttribute('tabindex'), '0');
assert.match(focusNote()?.getAttribute('aria-label') ?? '', /^C4, step 1, 2 steps, velocity 90, selected/);
const group = q<HTMLElement>('[data-roll-note-focus]');
assert.equal(group?.getAttribute('role'), 'group');
assert.match(group?.getAttribute('aria-label') ?? '', /^Notes of Part 1: 3 notes, 1 selected/);
assert.ok(win.document.getElementById(group?.getAttribute('aria-describedby') ?? '')?.textContent?.includes('Alt+Left'), 'the keys are described');
await step(() => focusNote()?.focus());
await step(() => kb(focusNote() as Element, 'ArrowRight', { altKey: true }));
assert.deepEqual([...roll().selectedIds], ['b'], 'Alt+Right selects the next note in time');
assert.match(focusNote()?.getAttribute('aria-label') ?? '', /^E4, step 5/);
assert.equal(win.document.activeElement, focusNote(), 'the focus stays on the selected note');
await step(() => kb(focusNote() as Element, 'ArrowLeft', { altKey: true }));
assert.deepEqual([...roll().selectedIds], ['a'], 'Alt+Left goes back');
assert.equal(focusNote()?.getAttribute('aria-haspopup'), 'menu', 'the note says it opens a menu');
assert.equal(focusNote()?.getAttribute('aria-expanded'), 'false');
await step(() => kb(focusNote() as Element, 'Enter'));
assert.ok(q('[role="menu"]'), 'Enter opens the note menu');
assert.equal(focusNote()?.getAttribute('aria-expanded'), 'true', 'and says it is open');
await step(() => kb(q('[role="menu"]') as Element, 'Escape'));
assert.equal(focusNote()?.getAttribute('aria-expanded'), 'false', 'Escape closes it');
// Space, a button's other key, opens the menu too, and stops at the note: EDIT's
// window key handler would take it for PLAY.
let spaceAtWindow = 0;
const countSpace = (e: KeyboardEvent) => {
  if (e.key === ' ') spaceAtWindow += 1;
};
win.addEventListener('keydown', countSpace);
await step(() => kb(focusNote() as Element, ' '));
win.removeEventListener('keydown', countSpace);
assert.ok(q('[role="menu"]'), 'Space opens the note menu');
assert.equal(focusNote()?.getAttribute('aria-expanded'), 'true');
assert.equal(spaceAtWindow, 0, 'and the key never reaches the window');
await step(() => kb(q('[role="menu"]') as Element, 'Escape'));
// With nothing selected the group takes focus and Enter picks the first note.
await step(() => roll().setSelection([]));
assert.equal(focusNote(), null);
assert.equal(group?.getAttribute('tabindex'), '0', 'the group is focusable with no note selected');
await step(() => group?.focus());
await step(() => kb(group as Element, 'Enter'));
assert.deepEqual([...roll().selectedIds], ['a'], 'Enter on the group selects the first note');
await step(() => roll().setSelection([]));

// ── 1920x1080: the shell's CSS zoom scales every client point ─────────────────
// jsdom's boxes sit at 0,0, so a point Z times a grid point is where the user
// sees that grid point. Every gesture must land where the canvas drew.
const Z = 1.25;
await step(() => {
  host.style.zoom = String(Z);
});
await scrolled(scroller);
// The canvas's backing store covers the view at the zoom, so the notes are drawn sharp.
assert.equal(canvas.dataset.scale, String(Z), 'device px per grid px: the zoom times the device pixel ratio (1 here)');
assert.equal(canvas.width, Math.round(Number.parseFloat(canvas.style.width) * Z), 'the backing store is the view times the zoom');
const cctx = contexts.get(canvas);
assert.ok(cctx);
assert.equal(cctx.transform[0], Z, 'and the drawing scales to it');
// Note c is drawn from step 8 to 10: its middle, seen through the zoom. Unzoomed,
// that client point is step 10.6, past the note, where a click would add one.
await step(() => press(grid, xOf(8) * Z, yOf(67) * Z));
assert.deepEqual([...roll().selectedIds], ['c'], 'a click selects the note drawn under the pointer');
assert.equal(roll().notes.length, 3, 'and adds none');
await step(() => roll().setSelection([]));
// An empty cell at step 12 (of the roll's 16), seen through the zoom: the new
// note starts there. Unzoomed, that client point is step 15.
await step(() => press(grid, xOf(12) * Z, yOf(72) * Z));
const added = roll().notes.find((n) => !['a', 'b', 'c'].includes(n.id));
assert.ok(added, 'an empty cell takes a note');
assert.equal(added.step, 12, 'on the cell under the pointer');
assert.equal(added.note, 72, 'in the row under the pointer');
await step(() => roll().undo());
// The edge drag: the pointer travels two steps as the user sees them, the note grows two steps.
await step(() => fire(grid, 'pointerdown', { clientX: edgeX * Z, clientY: yOf(64) * Z }));
await step(() => fire(scroller, 'pointermove', { clientX: (edgeX + 2 * stepPx) * Z, clientY: yOf(64) * Z }));
await step(() => fire(scroller, 'pointerup', { clientX: (edgeX + 2 * stepPx) * Z, clientY: yOf(64) * Z }));
await step(() => fire(grid, 'click', { clientX: (edgeX + 2 * stepPx) * Z, clientY: yOf(64) * Z }));
assert.equal(roll().notes.find((n) => n.id === 'b')?.length, 4, 'the edge drag lengthens b by the two steps travelled');
await step(() => roll().undo());
// A marquee around a and b only, as the user sees them.
await step(() => roll().setSelection([]));
await step(() => fire(grid, 'pointerdown', { clientX: 1 * Z, clientY: yOf(65) * Z }));
await step(() => fire(scroller, 'pointermove', { clientX: xOf(6) * Z, clientY: yOf(59) * Z }));
await step(() => fire(scroller, 'pointerup', { clientX: xOf(6) * Z, clientY: yOf(59) * Z }));
await step(() => fire(grid, 'click', { clientX: xOf(6) * Z, clientY: yOf(59) * Z }));
assert.deepEqual([...roll().selectedIds].sort(), ['a', 'b'], 'the marquee takes the notes drawn inside it');
await step(() => roll().setSelection([]));
// The ruler: a click seeks the step under the pointer.
const ruler = q<HTMLElement>('[data-roll-ruler]');
assert.ok(ruler);
await step(() => {
  fire(ruler, 'pointerdown', { clientX: 12 * stepPx * Z, clientY: 5 });
  fire(ruler, 'pointerup', { clientX: 12 * stepPx * Z, clientY: 5 });
});
assert.equal(roll().currentStep, 12, 'the ruler seeks the step drawn under the pointer');
await step(() => roll().seek(0));
await step(() => {
  host.style.zoom = '';
});
await scrolled(scroller);
assert.equal(canvas.dataset.scale, '1', 'back at zoom 1');

// The ruler numbers each bar by its own width: at 16 px a step every 4/4 bar
// in view prints its number, and a 2/16 bar at bar 13, far off screen, thins
// none of them.
await step(() => roll().setTotalSteps(16 * 16));
await scrolled(scroller);
// The cells as HTMLElements by a cast, not a type argument: the lookup type-checks whether or not jsdom's types load.
const numbersInView = () =>
  [...win.document.querySelectorAll('[data-ruler-bar]')]
    .map((el) => el as HTMLElement)
    .filter((el) => Number.parseFloat(el.style.left) < 4 * 16 * stepPx)
    .map((el) => el.querySelector('span:not(.et-ink)')?.textContent ?? '');
assert.deepEqual(numbersInView(), ['1', '2', '3', '4'], 'every 4/4 bar prints its number');
const M44 = { num: 4, den: 4, groups: [] as number[] };
await step(() => roll().setMeterMap([{ bar: 0, meter: M44 }, { bar: 12, meter: { num: 2, den: 16, groups: [] } }, { bar: 13, meter: M44 }]));
await scrolled(scroller);
assert.equal(roll().meterMap.length, 3, 'the roll holds the 2/16 bar');
assert.deepEqual(numbersInView(), ['1', '2', '3', '4'], 'one 2/16 bar at bar 13 thins no number of the wide bars');
await step(() => roll().setMeterMap([{ bar: 0, meter: M44 }]));

// The overview: a labelled slider; a click on its right half scrolls the grid there; arrows move a bar.
const map = q<HTMLElement>('[data-roll-minimap] [role="slider"]');
assert.ok(map, 'the overview is a slider');
assert.equal(win.document.getElementById(map.getAttribute('aria-labelledby') ?? '')?.textContent, 'Overview');
assert.equal(map.getAttribute('aria-valuemax'), String(roll().totalSteps / 16), 'its range is every bar of the roll');
assert.ok(Number(q<HTMLCanvasElement>('canvas[data-roll-density]')?.dataset.cells) > 0, 'the density map draws the notes');
await step(() => roll().setTotalSteps(1024));
scroller.scrollLeft = 0;
await step(() => {
  fire(map, 'pointerdown', { clientX: 450, clientY: 12 });
  fire(map, 'pointerup', { clientX: 450, clientY: 12 });
});
// The strip draws 600px wide until measured: 450px is three quarters of the roll, centred in the 1024px view.
assert.equal(scroller.scrollLeft, 0.75 * 1024 * stepPx - 1024 / 2, 'the click centres the grid on that step');
const before = scroller.scrollLeft;
await step(() => kb(map, 'ArrowRight'));
assert.ok(scroller.scrollLeft > before && scroller.scrollLeft - before <= 16 * stepPx, 'the arrow moves the view to the next bar line');
await step(() => kb(map, 'Home'));
assert.equal(scroller.scrollLeft, 0);

// The markers draw down the grid where their flags stand on the marker row: a movement strong, a section fainter.
await step(() => roll().setMarkers([{ tick: 0, name: 'I', kind: 'movement' }, { step: 32, name: 'A', kind: 'section' }]));
await scrolled(scroller);
const sectionLines = q<SVGPathElement>('svg path[data-roll-marker-lines="section"]')?.getAttribute('d') ?? '';
assert.ok(sectionLines.startsWith(`M${Math.round(32 * stepPx) + 0.5} `), `the section's line stands at step 32 (${sectionLines})`);
assert.ok((q<SVGPathElement>('svg path[data-roll-marker-lines="movement"]')?.getAttribute('d') ?? '').startsWith('M0.5 '), "the movement's line at step 0");
await step(() => roll().setMarkers([]));
assert.equal(q('svg path[data-roll-marker-lines]'), null, 'no marker, no line');

// A 4,096-bar roll: the ruler draws the bars in view, and the grid's bar path holds only the lines in view.
await step(() => roll().setTotalSteps(65536));
assert.equal(roll().totalSteps, 65536, 'the roll grows to 65,536 steps');
await scrolled(scroller);
const rulerBars = win.document.querySelectorAll('[data-ruler-bar]').length;
assert.ok(rulerBars > 0 && rulerBars < 40, `the ruler draws ${rulerBars} bars, not 4,096`);
const barPath = [...grid.querySelectorAll('svg path')].map((p) => p.getAttribute('d') ?? '').sort((a, b) => b.length - a.length)[0] ?? '';
const lines = (barPath.match(/M/g) ?? []).length;
assert.ok(lines > 0 && lines < 1000, `the busiest grid path holds ${lines} lines, not the roll's 65,536`);
assert.equal(q<HTMLInputElement>('#piano-roll-total-steps')?.max, '65536', 'the Steps field goes to the new limit');

// Zoom out to the floor: one pixel a step.
for (let i = 0; i < 20; i += 1) await step(() => key('Zoom out').click());
const widthText = [...win.document.querySelectorAll('span[title="Step width (px)"]')].map((s) => s.textContent)[0];
assert.equal(widthText, '1', 'the zoom reaches one pixel a step');
await step(() => key('Zoom in').click());
assert.equal([...win.document.querySelectorAll('span[title="Step width (px)"]')].map((s) => s.textContent)[0], '1.5');

// Nothing new prints under 12px.
const small = [...(q('[data-roll-minimap]')?.querySelectorAll('*') ?? [])].filter((el) => /text-\[(?:[0-9]|1[01])px\]/.test(el.getAttribute('class') ?? ''));
assert.equal(small.length, 0, 'no text under 12px in the overview');

await step(() => root.unmount());
console.log('PianoRoll.canvas: ok');
