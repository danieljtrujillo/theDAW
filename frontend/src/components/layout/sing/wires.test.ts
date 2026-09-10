/**
 * The wire geometry, on its own.
 *
 * Two surfaces draw connections between words — the analysis sheet and the
 * karaoke — and both take their anchors from the DOM, which no test here can
 * produce. What CAN be pinned down is the part that decides the shape: which
 * of the three routes a pair of anchors gets, that two wires sharing a pair of
 * lines are not drawn on top of each other, that a rect measured under a zoom
 * lands back in the layer's own coordinates, and that the same pair of words is
 * routed the same way whatever size the type is set to.
 *
 * Everything here stays on the pure surface: `hostFrameOf`, `lineBoxOf` and
 * `textInsetOf` read the DOM and are the callers' business, not this file's —
 * what a decoration MEASURES is theirs, what it does to an anchor is here.
 *
 * Run: `npx tsx src/components/layout/sing/wires.test.ts`
 */
import assert from 'node:assert/strict';
import {
  anchorFrom,
  rowPitchOf,
  routeWire,
  type Anchor,
  type Fragment,
  type HostFrame,
  type RouteMetrics,
} from './wires';

const FRAME: HostFrame = { left: 0, top: 0, zoom: 1 };

/** A surface with a 16px line box whose rows sit 20px apart — small, round
 *  numbers rather than any real one, since what is being pinned down is the
 *  ratio between the two and not either of them. */
const M: RouteMetrics = { line: 16, pitch: 20 };

const rect = (left: number, top: number, width: number, height = 16): DOMRect =>
  ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;

const anchor = (x: number, top: number, width = 40, height = 16): Anchor => ({
  x,
  left: x - width / 2,
  right: x + width / 2,
  top,
  bottom: top + height,
});

// --- anchors ---------------------------------------------------------------

const frags: Fragment[] = [
  { s: 0, e: 4, rect: rect(100, 0, 30) },
  { s: 4, e: 9, rect: rect(130, 0, 40) },
  { s: 9, e: 20, rect: rect(200, 0, 50) },
];

// Only the fragments the span covers are measured.
const a = anchorFrom(frags, 0, 9, FRAME, 16);
assert.ok(a);
assert.equal(a.left, 100);
assert.equal(a.right, 170);
assert.equal(a.x, 135);

// Nothing covered is no anchor, and so is nothing measured at all.
assert.equal(anchorFrom(frags, 40, 50, FRAME, 16), null);
assert.equal(anchorFrom(undefined, 0, 9, FRAME, 16), null);

// A rect is viewport px and the layer it is drawn on is local px, so a zoomed
// host divides its measurements back down. Skipping this drew every wire at
// `zoom` times its true offset from the sheet's corner.
const zoomed = anchorFrom(frags, 0, 9, { left: 0, top: 0, zoom: 2 }, 32);
assert.ok(zoomed);
assert.equal(zoomed.left, 50);
assert.equal(zoomed.x, 67.5);

// Two fragments of ONE row whose tops differ, because a `meaning` fragment
// wears a top border its neighbour does not. Keyed on the exact top this was
// two rows, and the fatter half won the anchor.
const mixed: Fragment[] = [
  { s: 0, e: 4, rect: rect(100, 0, 30) },
  { s: 4, e: 9, rect: rect(130, -2, 40, 20) },
];
const one = anchorFrom(mixed, 0, 9, FRAME, 16);
assert.ok(one);
assert.equal(one.left, 100, 'a top border does not start a second row');
assert.equal(one.right, 170);

// A stretch that WRAPS has two boxes on two rows. The anchor is the row
// carrying most of it, never a rectangle around both — a bounding box there
// spans the whole column and puts the anchor in the middle of nowhere.
const wrapped: Fragment[] = [
  { s: 0, e: 5, rect: rect(600, 0, 20) },
  { s: 5, e: 20, rect: rect(20, 30, 200) },
];
const w = anchorFrom(wrapped, 0, 20, FRAME, 16);
assert.ok(w);
assert.equal(w.top, 30, 'the wide row wins');
assert.equal(w.x, 120);

// --- what the words are wearing --------------------------------------------

// A finding is painted as padding plus a rule UNDER the word — 4px of box
// below the text at the sheet's default, up to 8 under a certain repetition —
// and a rect reports all of it. Anchored to the box, one wire left the word
// and the next left its underline.
const marked: Fragment[] = [
  { s: 0, e: 4, rect: rect(100, 0, 30) },
  { s: 4, e: 9, rect: rect(130, 0, 40, 20), inset: { above: 0, below: 4 } },
];
const inked = anchorFrom(marked, 0, 9, FRAME, 16);
assert.ok(inked);
assert.equal(inked.bottom, 16, 'the underline is not part of the word');
assert.equal(inked.left, 100, 'and the marked half is still the same row');

// `meaning` rides ABOVE its word instead of under it — 3px of rule over the
// text and 2px of padding still under it, measured — and the step route lands
// on `top`, so the correction has to work in both directions at once.
const over = anchorFrom(
  [{ s: 0, e: 4, rect: rect(100, -3, 30, 21), inset: { above: 3, below: 2 } }],
  0,
  4,
  FRAME,
  16,
);
assert.ok(over);
assert.equal(over.top, 0, 'a rule over the word is not part of it either');
assert.equal(over.bottom, 16);

// The rect is viewport px and the decoration is local px, so the zoom comes
// out of the rect BEFORE the decoration comes off the result. Taking it off
// first would scale the error by the zoom.
const zoomedInk = anchorFrom(
  [{ s: 0, e: 4, rect: rect(100, 0, 30, 40), inset: { above: 0, below: 4 } }],
  0,
  4,
  { left: 0, top: 0, zoom: 2 },
  32,
);
assert.ok(zoomedInk);
assert.equal(zoomedInk.bottom, 16);

// --- the row pitch ---------------------------------------------------------

// The gap between neighbouring rows, as the median of what was measured.
assert.equal(
  rowPitchOf(
    [
      { top: 0, lines: 1 },
      { top: 25, lines: 1 },
      { top: 50, lines: 1 },
    ],
    19.2,
  ),
  25,
);

// A wrapped row is TWO rows, so it contributes the pitch of one and not the
// height of both. This is the mixture — half short lines, half wrapped ones —
// that otherwise drags the answer up towards two line boxes and flips the
// route class with it.
assert.ok(
  rowPitchOf(
    [
      { top: 0, lines: 2 },
      { top: 44, lines: 1 },
      { top: 69, lines: 1 },
    ],
    19.2,
  ) < 30,
  'a wrapped row is not read as one very tall row',
);

// Nothing to measure falls back to the line box.
assert.equal(rowPitchOf([{ top: 0, lines: 1 }], 19.2), 19.2);
assert.equal(rowPitchOf([], 19.2), 19.2);

// Two boxes of the SAME row are not a step down to the next one.
assert.equal(
  rowPitchOf(
    [
      { top: 0, lines: 1 },
      { top: 2, lines: 1 },
      { top: 26, lines: 1 },
    ],
    19.2,
  ),
  24,
);

// --- routes ----------------------------------------------------------------

/** The control points of a cubic `M x y C ...`, as numbers. */
const points = (d: string): number[] =>
  d
    .replace(/[MC,]/g, ' ')
    .trim()
    .split(/\s+/)
    .map(Number);

// Inside one line: a slur that dips BELOW both ends and comes back.
const slur = points(routeWire(anchor(100, 0), anchor(300, 0), M).d);
assert.equal(slur[1], 16, 'starts at the baseline box bottom');
assert.ok(slur[3] > 16 && slur[5] > 16, 'both control points are below the words');
assert.equal(slur[7], 16, 'and lands back on the other end');

// End to end, the bug the inset closes: a slur under a marked word and one
// under plain text are the SAME wire. Every route starts at `bottom`, so a
// word wearing a rule under it used to hang its end 4px lower than its
// neighbour and the two halves of one line stopped agreeing on the baseline.
const plainEnd = anchorFrom([{ s: 0, e: 4, rect: rect(100, 0, 30) }], 0, 4, FRAME, 16);
const inkedEnd = anchorFrom(
  [{ s: 0, e: 4, rect: rect(100, 0, 30, 20), inset: { above: 0, below: 4 } }],
  0,
  4,
  FRAME,
  16,
);
assert.ok(plainEnd && inkedEnd);
assert.equal(
  routeWire(plainEnd, anchor(300, 0), M).d,
  routeWire(inkedEnd, anchor(300, 0), M).d,
  'a marked word and a plain one start the same wire',
);

// Neighbouring rows: the control points sit directly under and over the two
// ends, so the curve stays in the gap instead of sweeping across the text.
const step = points(routeWire(anchor(100, 0), anchor(300, 40), M).d);
assert.equal(step[0], 100);
assert.equal(step[2], 100, 'first control point is under the start');
assert.equal(step[4], 300, 'second is over the end');
assert.equal(step[6], 300);

// A long reach leaves the column: both control points are well left of either
// end, which is what keeps it off the words it passes.
const far = points(routeWire(anchor(400, 0), anchor(420, 600), M).d);
assert.ok(far[2] < 300 && far[4] < 300, `routed down the margin: ${far[2]}, ${far[4]}`);
// ...but never past the edge it was given.
const clamped = points(routeWire(anchor(400, 0), anchor(420, 600), { ...M, leftEdge: 350 }).d);
assert.equal(clamped[2], 350);
assert.equal(clamped[4], 350);

// Lanes: two wires between the same two rows must not be the same curve.
assert.notEqual(
  routeWire(anchor(100, 0), anchor(300, 40), { ...M, lane: 0 }).d,
  routeWire(anchor(100, 0), anchor(300, 40), { ...M, lane: 1 }).d,
  'a second wire between the same rows is routed apart',
);
assert.notEqual(
  routeWire(anchor(100, 0), anchor(300, 0), { ...M, lane: 0 }).d,
  routeWire(anchor(100, 0), anchor(300, 0), { ...M, lane: 1 }).d,
  'and so is a second slur inside one line',
);

// The route is chosen in ROWS, so the same two words get the same shape of
// wire whatever size the type is set to. `M` is a sheet-sized line box; `BIG`
// is a karaoke-sized one, nearly three times as tall.
const BIG: RouteMetrics = { line: 46, pitch: 57 };
assert.equal(
  routeWire(anchor(400, 0), anchor(420, 40), M).route,
  routeWire(anchor(400, 0, 40, 46), anchor(420, 114, 40, 46), BIG).route,
  'two rows apart is two rows apart at any size',
);
assert.equal(routeWire(anchor(400, 0), anchor(420, 40), M).route, 'step');
assert.equal(
  routeWire(anchor(400, 0), anchor(420, 80), M).route,
  routeWire(anchor(400, 0, 40, 46), anchor(420, 228, 40, 46), BIG).route,
  'and so is four',
);
assert.equal(routeWire(anchor(400, 0), anchor(420, 80), M).route, 'margin');

// The endpoints the renderer draws its dots on are the route's OWN, on every
// route. Re-deriving them at the call site is what once put a dot at a word's
// left edge while its wire left from the centre — half a word away, and wider
// the longer the word.
for (const wire of [
  routeWire(anchor(100, 0), anchor(300, 0), M),
  routeWire(anchor(100, 0), anchor(300, 40), M),
  routeWire(anchor(400, 0), anchor(420, 600), M),
]) {
  const p = points(wire.d);
  assert.equal(p[0], wire.ax, `${wire.route}: the stroke starts where the dot is`);
  assert.equal(p[1], wire.ay);
  assert.equal(p[6], wire.bx, `${wire.route}: and lands where the other one is`);
  assert.equal(p[7], wire.by);
}

console.log('wires: ok');
