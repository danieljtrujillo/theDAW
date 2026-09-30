import assert from 'node:assert/strict';
import {
  autoscrollVelocity,
  cancelGesture,
  type ClickProfile,
  type ClickSurface,
  type Combine,
  finishGesture,
  isPrimaryGestureButton,
  moveGesture,
  placementIntent,
  refreshMarquee,
  startGesture,
} from './pointerGesture';

// Local stand-ins for the selection combiner and a hit test over fixed points.
const combine: Combine = (baseline, hits, mode) => {
  if (mode === 'replace') return [...hits];
  const set = new Set(baseline);
  for (const id of hits) {
    if (mode === 'add') set.add(id);
    else if (mode === 'subtract') set.delete(id);
    else if (set.has(id)) set.delete(id);
    else set.add(id);
  }
  return [...set];
};
const boxes = new Map<string, { x: number; y: number }>([
  ['a', { x: 10, y: 10 }],
  ['b', { x: 50, y: 10 }],
  ['c', { x: 90, y: 90 }],
]);
let hitCalls = 0;
const hitTest = (r: { x1: number; y1: number; x2: number; y2: number }): string[] => {
  hitCalls += 1;
  const out: string[] = [];
  for (const [id, p] of boxes) if (p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2) out.push(id);
  return out;
};

// startGesture copies the baseline and starts pending.
{
  const baseline = ['c'];
  const s = startGesture(1, { x: 100, y: 100 }, { x: 0, y: 0 }, baseline, 'add');
  assert.equal(s.phase, 'pending');
  assert.deepEqual(s.baselineIds, ['c']);
  assert.notEqual(s.baselineIds, baseline);
  assert.deepEqual(s.currentModel, { x: 0, y: 0 });
  assert.throws(() => startGesture(1, { x: Number.NaN, y: 0 }, { x: 0, y: 0 }, [], 'replace'), RangeError);
  assert.throws(() => startGesture(1, { x: 0, y: 0 }, { x: 0, y: Infinity }, [], 'replace'), RangeError);
}

// Threshold boundary: screen-space hypot; just below stays pending, exactly at becomes marquee.
{
  const s = startGesture(1, { x: 100, y: 100 }, { x: 0, y: 0 }, [], 'replace');
  const below = moveGesture(s, 1, { x: 102.8, y: 102.8 }, { x: 60, y: 60 }, hitTest, combine);
  assert.equal(below.state.phase, 'pending');
  assert.equal(below.selectedIds, null);
  assert.equal(below.rect, null);
  assert.equal(finishGesture(below.state, 1), 'click');
  const at = moveGesture(s, 1, { x: 103, y: 104 }, { x: 60, y: 60 }, hitTest, combine);
  assert.equal(at.state.phase, 'marquee');
  assert.deepEqual(at.rect, { x1: 0, y1: 0, x2: 60, y2: 60 });
  assert.deepEqual(at.selectedIds, ['a', 'b']);
  // Custom threshold.
  const custom = moveGesture(s, 1, { x: 103, y: 104 }, { x: 60, y: 60 }, hitTest, combine, 10);
  assert.equal(custom.state.phase, 'pending');
  assert.throws(
    () => moveGesture(s, 1, { x: 103, y: 104 }, { x: 60, y: 60 }, hitTest, combine, Number.NaN),
    RangeError,
  );
  assert.throws(() => moveGesture(s, 1, { x: Infinity, y: 0 }, { x: 0, y: 0 }, hitTest, combine), RangeError);
}

// Pointer-id filtering: another pointer changes nothing and finishes as ignore.
{
  const s = startGesture(7, { x: 0, y: 0 }, { x: 0, y: 0 }, ['a'], 'replace');
  const other = moveGesture(s, 8, { x: 500, y: 500 }, { x: 100, y: 100 }, hitTest, combine);
  assert.equal(other.state, s);
  assert.equal(other.selectedIds, null);
  assert.equal(other.rect, null);
  assert.equal(finishGesture(s, 8), 'ignore');
}

// Once marquee, never reverts to pending, even when the pointer returns to the origin.
{
  let s = startGesture(1, { x: 0, y: 0 }, { x: 20, y: 20 }, [], 'replace');
  s = moveGesture(s, 1, { x: 40, y: 0 }, { x: 60, y: 20 }, hitTest, combine).state;
  assert.equal(s.phase, 'marquee');
  const back = moveGesture(s, 1, { x: 0, y: 0 }, { x: 5, y: 5 }, hitTest, combine);
  assert.equal(back.state.phase, 'marquee');
  // Rect is normalized even when dragging up-left of the origin.
  assert.deepEqual(back.rect, { x1: 5, y1: 5, x2: 20, y2: 20 });
  assert.deepEqual(back.selectedIds, ['a']);
  assert.equal(finishGesture(back.state, 1), 'marquee');
}

// Identical hits give identical output (combine runs against the fixed baseline, not the running result).
{
  let s = startGesture(1, { x: 0, y: 0 }, { x: 0, y: 0 }, ['a'], 'toggle');
  const r1 = moveGesture(s, 1, { x: 50, y: 0 }, { x: 60, y: 60 }, hitTest, combine);
  s = r1.state;
  const r2 = moveGesture(s, 1, { x: 51, y: 0 }, { x: 60, y: 60 }, hitTest, combine);
  assert.deepEqual(r1.selectedIds, ['b']);
  assert.deepEqual(r2.selectedIds, r1.selectedIds);
  assert.deepEqual(r2.rect, r1.rect);
}

// Cancel restores the baseline; afterwards everything is ignored.
{
  let s = startGesture(1, { x: 0, y: 0 }, { x: 0, y: 0 }, ['c'], 'add');
  s = moveGesture(s, 1, { x: 50, y: 0 }, { x: 60, y: 60 }, hitTest, combine).state;
  const { state, restoreIds } = cancelGesture(s);
  assert.equal(state.phase, 'cancelled');
  assert.deepEqual(restoreIds, ['c']);
  assert.notEqual(restoreIds, s.baselineIds);
  assert.equal(finishGesture(state, 1), 'ignore');
  const moved = moveGesture(state, 1, { x: 100, y: 0 }, { x: 100, y: 100 }, hitTest, combine);
  assert.equal(moved.state, state);
  assert.equal(moved.selectedIds, null);
  assert.equal(moved.rect, null);
  assert.deepEqual(refreshMarquee(state, hitTest, combine), { selectedIds: null, rect: null });
  // Cancelling a pending gesture also restores.
  const pending = startGesture(2, { x: 0, y: 0 }, { x: 0, y: 0 }, ['a', 'b'], 'replace');
  assert.deepEqual(cancelGesture(pending).restoreIds, ['a', 'b']);
}

// refreshMarquee: null while pending; re-hit-tests the current rect while marquee.
{
  const s = startGesture(1, { x: 0, y: 0 }, { x: 0, y: 0 }, [], 'add');
  hitCalls = 0;
  assert.deepEqual(refreshMarquee(s, hitTest, combine), { selectedIds: null, rect: null });
  assert.equal(hitCalls, 0);
  const m = moveGesture(s, 1, { x: 10, y: 0 }, { x: 30, y: 30 }, hitTest, combine).state;
  assert.deepEqual(refreshMarquee(m, hitTest, combine), {
    selectedIds: ['a'],
    rect: { x1: 0, y1: 0, x2: 30, y2: 30 },
  });
  // Content under the rect changed (autoscroll): refresh reflects the new hits.
  boxes.set('d', { x: 20, y: 20 });
  assert.deepEqual(refreshMarquee(m, hitTest, combine).selectedIds, ['a', 'd']);
  boxes.delete('d');
}

// isPrimaryGestureButton.
{
  assert.equal(isPrimaryGestureButton({ button: 0, ctrlKey: false }, false), true);
  assert.equal(isPrimaryGestureButton({ button: 1, ctrlKey: false }, false), false);
  assert.equal(isPrimaryGestureButton({ button: 2, ctrlKey: false }, false), false);
  assert.equal(isPrimaryGestureButton({ button: -1, ctrlKey: false }, false), false);
  assert.equal(isPrimaryGestureButton({ button: 0, ctrlKey: true, pointerType: 'mouse' }, false), true);
  assert.equal(isPrimaryGestureButton({ button: 0, ctrlKey: true, pointerType: 'mouse' }, true), false);
  assert.equal(isPrimaryGestureButton({ button: 0, ctrlKey: true }, true), false);
  assert.equal(isPrimaryGestureButton({ button: 0, ctrlKey: false, pointerType: 'mouse' }, true), true);
  assert.equal(isPrimaryGestureButton({ button: 0, ctrlKey: true, pointerType: 'pen' }, true), true);
  assert.equal(isPrimaryGestureButton({ button: 0, ctrlKey: true, pointerType: 'touch' }, true), true);
}

// placementIntent: every surface x profile x playing/stopped x explicitSeek.
{
  const surfaces: ClickSurface[] = ['ruler', 'empty-lane', 'clip-body', 'control'];
  const profiles: ClickProfile[] = ['default', 'clip-seeks', 'ruler-only'];
  const expected = (surface: ClickSurface, profile: ClickProfile, playing: boolean, explicitSeek: boolean) => {
    if (surface === 'control') return { moveEditCursor: false, seek: false };
    if (surface === 'ruler') return { moveEditCursor: true, seek: true };
    if (profile === 'ruler-only') return { moveEditCursor: true, seek: explicitSeek };
    if (surface === 'empty-lane') return { moveEditCursor: true, seek: true };
    if (profile === 'clip-seeks') return { moveEditCursor: true, seek: true };
    return { moveEditCursor: true, seek: explicitSeek || !playing };
  };
  let rows = 0;
  for (const surface of surfaces)
    for (const profile of profiles)
      for (const playing of [false, true])
        for (const explicitSeek of [false, true]) {
          const got = placementIntent({ surface, playing, explicitSeek, profile });
          assert.deepEqual(
            got,
            expected(surface, profile, playing, explicitSeek),
            `${surface}/${profile}/${playing}/${explicitSeek}`,
          );
          // Only these two fields: nothing can start or stop playback.
          assert.deepEqual(Object.keys(got).sort(), ['moveEditCursor', 'seek']);
          rows += 1;
        }
  assert.equal(rows, 48);
  // Literal table spot checks.
  const pi = placementIntent;
  assert.deepEqual(pi({ surface: 'clip-body', playing: true, explicitSeek: false, profile: 'default' }), {
    moveEditCursor: true,
    seek: false,
  });
  assert.deepEqual(pi({ surface: 'clip-body', playing: false, explicitSeek: false, profile: 'default' }), {
    moveEditCursor: true,
    seek: true,
  });
  assert.deepEqual(pi({ surface: 'clip-body', playing: true, explicitSeek: false, profile: 'clip-seeks' }), {
    moveEditCursor: true,
    seek: true,
  });
  assert.deepEqual(pi({ surface: 'empty-lane', playing: false, explicitSeek: false, profile: 'ruler-only' }), {
    moveEditCursor: true,
    seek: false,
  });
  assert.deepEqual(pi({ surface: 'control', playing: false, explicitSeek: true, profile: 'clip-seeks' }), {
    moveEditCursor: false,
    seek: false,
  });
}

// autoscrollVelocity: middle zero, linear ramp in the band, capped at/outside the edge, independent axes.
{
  const vp = { left: 0, top: 0, right: 400, bottom: 300 };
  assert.deepEqual(autoscrollVelocity({ x: 200, y: 150 }, vp), { vx: 0, vy: 0 });
  // The inner band boundary (32 px from the edge) is still zero.
  assert.deepEqual(autoscrollVelocity({ x: 32, y: 150 }, vp), { vx: 0, vy: 0 });
  assert.deepEqual(autoscrollVelocity({ x: 368, y: 150 }, vp), { vx: 0, vy: 0 });
  // Halfway into the band = half speed, sign toward the edge.
  assert.deepEqual(autoscrollVelocity({ x: 16, y: 150 }, vp), { vx: -12, vy: 0 });
  assert.deepEqual(autoscrollVelocity({ x: 384, y: 150 }, vp), { vx: 12, vy: 0 });
  assert.deepEqual(autoscrollVelocity({ x: 200, y: 8 }, vp), { vx: 0, vy: -18 });
  assert.deepEqual(autoscrollVelocity({ x: 200, y: 292 }, vp), { vx: 0, vy: 18 });
  // The ramp is monotonic.
  const a = autoscrollVelocity({ x: 390, y: 150 }, vp).vx;
  const b = autoscrollVelocity({ x: 395, y: 150 }, vp).vx;
  assert.ok(b > a && a > 0);
  // At the edge and beyond = cap.
  assert.deepEqual(autoscrollVelocity({ x: 0, y: 150 }, vp), { vx: -24, vy: 0 });
  assert.deepEqual(autoscrollVelocity({ x: -500, y: 150 }, vp), { vx: -24, vy: 0 });
  assert.deepEqual(autoscrollVelocity({ x: 900, y: 150 }, vp), { vx: 24, vy: 0 });
  assert.deepEqual(autoscrollVelocity({ x: 200, y: 1000 }, vp), { vx: 0, vy: 24 });
  // Axes are independent: a corner scrolls on both.
  assert.deepEqual(autoscrollVelocity({ x: -10, y: 310 }, vp), { vx: -24, vy: 24 });
  // Options.
  assert.deepEqual(autoscrollVelocity({ x: 5, y: 150 }, vp, { edgePx: 10, maxPxPerFrame: 40 }), { vx: -20, vy: 0 });
  assert.deepEqual(autoscrollVelocity({ x: 20, y: 150 }, vp, { edgePx: 10 }), { vx: 0, vy: 0 });
  // Offset viewport.
  assert.deepEqual(autoscrollVelocity({ x: 116, y: 250 }, { left: 100, top: 50, right: 500, bottom: 450 }), {
    vx: -12,
    vy: 0,
  });
  // Validation.
  assert.throws(() => autoscrollVelocity({ x: Number.NaN, y: 0 }, vp), RangeError);
  assert.throws(() => autoscrollVelocity({ x: 0, y: 0 }, { ...vp, right: Infinity }), RangeError);
  assert.throws(() => autoscrollVelocity({ x: 0, y: 0 }, vp, { edgePx: 0 }), RangeError);
  assert.throws(() => autoscrollVelocity({ x: 0, y: 0 }, vp, { maxPxPerFrame: -1 }), RangeError);
}

console.log('pointerGesture: ok');
