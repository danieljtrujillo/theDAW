/**
 * An EDIT MIDI clip's notes on a viewport-culled canvas (MidiClipNotes), as
 * the timeline shows it while the user scrolls.
 *
 * The sequence: a part of 2,000 notes (250 s at 120 BPM) sits on a track at 20
 * px a second, 5,000 px wide, in a 1,000 px view. The view starts at the clip's
 * left edge: the canvas is the view's width and draws the notes in it. The
 * user scrolls right: the same canvas draws the notes of the new span, at clip
 * px. The user scrolls past the clip: its canvas goes. The user scrolls back:
 * a new canvas mounts and draws the notes into its own context. The track
 * scrolls out of view downward: the canvas goes, and a sideways scroll while it
 * is out of view paints nothing; scrolled back, it paints the span in view. The
 * window is 1920x1080, where the shell's CSS zoom is 1.1: the backing store
 * covers the span at the zoom (drawn sharp), and the notes stay where they were.
 *
 * jsdom has no 2D canvas and no IntersectionObserver: a recording context per
 * canvas element and an observer the test drives stand in.
 *
 *   cd frontend && npx tsx src/components/audio/MidiClipNotes.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
/** An IntersectionObserver the test drives: `report` tells every live one whether its body is in view. */
class TestObserver {
  static live: TestObserver[] = [];
  private readonly cb: (entries: { isIntersecting: boolean; target: Element | null }[]) => void;
  private target: Element | null = null;
  constructor(cb: (entries: { isIntersecting: boolean; target: Element | null }[]) => void) {
    this.cb = cb;
    TestObserver.live.push(this);
  }
  observe(el: Element) { this.target = el; }
  unobserve() {}
  disconnect() { TestObserver.live = TestObserver.live.filter((o) => o !== this); }
  takeRecords() { return []; }
  static report(isIntersecting: boolean) {
    for (const o of TestObserver.live) o.cb([{ isIntersecting, target: o.target }]);
  }
}
const globals: Record<string, unknown> = {
  IntersectionObserver: TestObserver,
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  Event: win.Event,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

/** Records every fillRect since the last clearRect (a paint starts with one). */
class RecordingContext {
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  globalAlpha = 1;
  lineWidth = 1;
  transform: number[] = [];
  rects: number[][] = [];
  paints = 0;
  beginPath() {}
  rect() {}
  fill() {}
  stroke() {}
  fillRect(x: number, y: number, w: number, h: number) { this.rects.push([x, y, w, h]); }
  clearRect() { this.rects = []; this.paints += 1; }
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
const { MidiClipNotes } = await import('./MidiClipNotes.tsx');
const { clipNoteSpan } = await import('../../lib/rollClip.ts');
const { stepClock } = await import('../../lib/rollTempo.ts');
type AudioClip = import('../../state/editorStore.ts').AudioClip;
type PianoNote = import('../../state/pianoRollStore.ts').PianoNote;

// 2,000 sixteenths at 120 BPM (a 16th is 0.125 s), one note a step, a 16th to two beats long.
const notes: PianoNote[] = Array.from({ length: 2000 }, (_, i) => ({
  id: `n${i}`,
  note: 48 + (i % 24),
  step: i,
  length: 1 + (i % 8),
  velocity: 40 + (i % 80),
}));
const clip = {
  id: 'clip-violins',
  trackId: 't1',
  label: 'Violin I',
  startSec: 0,
  offsetIntoSource: 0,
  durationSec: 250,
  color: '#3b82f6',
  sourceKind: 'piano-roll',
  sourcePianoRoll: notes,
  sourceBpm: 120,
} as unknown as AudioClip;
const ZOOM = 20;
const clock = stepClock(120, undefined);
/** The notes the brute force says sound in [fromPx, toPx] of the clip (a note drawn 1.5px wide reaches that far left). */
const expected = (fromPx: number, toPx: number): number =>
  notes.filter((n) => {
    const { relStart, relEnd } = clipNoteSpan(n, clock, 0);
    return relStart <= toPx / ZOOM && relEnd >= fromPx / ZOOM - 1.5 / ZOOM && relEnd > 0 && relStart < clip.durationSec;
  }).length;

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
const show = (fromPx: number, toPx: number) =>
  act(async () => {
    root.render(<MidiClipNotes clip={clip} zoom={ZOOM} selected={false} height={60} visibleFromPx={fromPx} visibleToPx={toPx} />);
  });
const canvas = () => host.querySelector('canvas[data-clip-notes]') as HTMLCanvasElement | null;

// The view at the clip's left edge: a canvas the view's width, drawing the notes in it.
await show(0, 1000);
const first = canvas();
assert.ok(first, 'the clip draws on a canvas');
assert.equal(first.style.width, '1000px', 'the canvas covers the part of the clip in view, not its 5,000 px');
assert.equal(first.style.left, '0px');
assert.equal(first.width, 1000, 'its backing store is the view at one device pixel a px');
assert.equal(Number(first.dataset.notes), expected(0, 1000), 'it draws the notes in view');
assert.ok(Number(first.dataset.notes) < notes.length / 4, 'and not the clip');

// Scroll right: the same canvas draws the new span, each note at its clip px.
await show(2000, 3000);
assert.equal(canvas(), first, 'a scroll repaints the same canvas');
assert.equal(first.style.left, '2000px');
const ctx = contexts.get(first);
assert.ok(ctx);
assert.equal(Number(first.dataset.notes), expected(2000, 3000));
assert.equal(ctx.rects.length, expected(2000, 3000), 'one rect per note drawn');
for (const [x, , w] of ctx.rects) assert.ok(x + w >= 2000 - 1e-6 && x <= 3000 + 1e-6, `a rect at ${x} meets the view`);
assert.deepEqual(ctx.transform, [1, 0, 0, 1, -2000, 0], 'the transform shifts clip px onto the canvas');

// Scroll past the clip: its canvas goes.
await show(6000, 7000);
assert.equal(canvas(), null, 'a clip out of view mounts no canvas');

// Scroll back: a new canvas, drawing into its own context.
await show(0, 1000);
const again = canvas();
assert.ok(again && again !== first, 'a new canvas mounts');
const againCtx = contexts.get(again);
assert.ok(againCtx && againCtx.paints > 0, 'the new canvas painted its own context');
assert.equal(againCtx.rects.length, expected(0, 1000), 'with the notes in view');

// The track scrolls out of view downward: the canvas goes, and a sideways
// scroll meanwhile paints nothing. Back in view, the span in view paints.
assert.equal(TestObserver.live.length, 1, 'the body is watched');
await act(async () => TestObserver.report(false));
assert.equal(canvas(), null, 'a track scrolled out of view mounts no canvas');
await show(1000, 2000);
assert.equal(canvas(), null, 'and a sideways scroll while it is away paints nothing');
await act(async () => TestObserver.report(true));
const back = canvas();
assert.ok(back, 'back in view, the canvas mounts');
assert.equal(back.style.left, '1000px');
assert.equal(contexts.get(back)?.rects.length, expected(1000, 2000), 'and paints the span now in view');
await show(0, 1000);

// At 1920x1080 the shell's CSS zoom is 1.1: the backing store follows it.
host.style.zoom = '1.1';
await show(0, 999);
const zoomed = canvas();
assert.ok(zoomed);
assert.equal(zoomed.dataset.scale, '1.1', 'device px per clip px: the zoom times the device pixel ratio (1 here)');
assert.equal(zoomed.width, Math.round(999 * 1.1), 'the backing store covers the span at the zoom');
assert.equal(zoomed.style.width, '999px', 'and the canvas itself stays in clip px');
const zctx = contexts.get(zoomed);
assert.ok(zctx);
assert.deepEqual(zctx.transform, [1.1, 0, 0, 1.1, -0, 0], 'the drawing scales by the zoom');
assert.equal(zctx.rects.length, expected(0, 999), 'the same notes, at the same clip px');
host.style.zoom = '';

// A clip with no notes draws nothing and mounts nothing.
await act(async () => {
  root.render(<MidiClipNotes clip={{ ...clip, sourcePianoRoll: [] } as AudioClip} zoom={ZOOM} selected={false} height={60} visibleFromPx={0} visibleToPx={1000} />);
});
assert.equal(canvas(), null);

await act(async () => root.unmount());
console.log('MidiClipNotes: ok');
