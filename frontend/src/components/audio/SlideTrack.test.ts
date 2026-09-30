// Run with: npx tsx src/components/audio/SlideTrack.test.ts
/**
 * SlideTrack's gesture boundary — the bookkeeping, not the DOM.
 *
 * The widget reports `onGestureStart` / `onGestureEnd` around each gesture so a
 * consumer (automation recording) no longer has to infer the boundary from
 * window-level pointerup/keyup listeners and an idle deadline. All of that
 * bookkeeping lives in `lib/gestureTracker.ts` as a pure helper; the component
 * only wires its three input paths to it, so the contract is tested here with no
 * DOM and an injected clock.
 *
 * The contract the consumer relies on: exactly one start before the first change
 * of a gesture, exactly one end after its last, balanced under every interleaving
 * of the three inputs, and balanced on unmount.
 */
import assert from 'node:assert/strict';
import { createGestureTracker, WHEEL_GESTURE_IDLE_MS } from '../../lib/gestureTracker.ts';

/** A hand-cranked clock: `setTimer`/`clearTimer` injected, `tick(ms)` runs what is due. */
const makeClock = () => {
  let now = 0;
  let nextHandle = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      pending.set(handle, { at: now + ms, fn });
      return handle;
    },
    clearTimer: (handle: number) => { pending.delete(handle); },
    tick(ms: number) {
      now += ms;
      for (const [handle, job] of [...pending.entries()]) {
        if (job.at > now) continue;
        pending.delete(handle);
        job.fn();
      }
    },
    get armed() { return pending.size; },
  };
};

/** Tracker + the start/end log, so every case reads as a sequence. */
const rig = (idleMs = WHEEL_GESTURE_IDLE_MS) => {
  const clock = makeClock();
  const log: string[] = [];
  const tracker = createGestureTracker({
    onStart: () => log.push('start'),
    onEnd: () => log.push('end'),
    idleMs,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, log, tracker };
};

// The idle window is the widget's own constant, not the consumer's 250ms deadline.
{
  assert.equal(WHEEL_GESTURE_IDLE_MS, 150);
}

// Pointer drag: down, moves, up — one pair, and the moves are not boundaries.
{
  const { log, tracker } = rig();
  tracker.pointerDown();
  assert.deepEqual(log, ['start'], 'the start precedes the first change of the drag');
  tracker.pointerUp();
  assert.deepEqual(log, ['start', 'end']);
}

// A press and release with NO move still emits the pair: consumers rely on balance,
// not on a change having happened.
{
  const { log, tracker } = rig();
  tracker.pointerDown();
  tracker.pointerUp();
  assert.deepEqual(log, ['start', 'end']);
}

// No double start under a repeated pointerdown (a second button pressed mid-drag),
// and no double end under pointerup followed by pointercancel — both land on
// `pointerUp`, and the second one is a no-op.
{
  const { log, tracker } = rig();
  tracker.pointerDown();
  tracker.pointerDown();
  tracker.pointerUp();
  tracker.pointerUp();
  assert.deepEqual(log, ['start', 'end']);
}

// Keyboard: one gesture per key press. The keydown opens it before the change, the
// matching keyup closes it; auto-repeat keydowns stay inside the one gesture.
{
  const { log, tracker } = rig();
  tracker.key('down');
  assert.deepEqual(log, ['start']);
  tracker.key('down');
  tracker.key('down');
  assert.deepEqual(log, ['start'], 'key auto-repeat does not re-open the gesture');
  tracker.key('up');
  assert.deepEqual(log, ['start', 'end']);
  // A stray keyup with nothing open (a modifier released while idle) is a no-op.
  tracker.key('up');
  assert.deepEqual(log, ['start', 'end']);
}

// The key gesture is PINNED to the key that opened it. Shift held with ArrowUp and
// then released while the arrow auto-repeats must NOT split the ride: only the
// arrow's own keyup ends it. (This is the granularity failure WaveformEditor's
// `endOnKey` had to work around by gating on a held pointer.)
{
  const { log, tracker } = rig();
  tracker.key('down', 'ArrowUp');
  tracker.key('down', 'ArrowUp');           // auto-repeat
  tracker.key('up', 'Shift');               // a modifier let go mid-ride
  assert.deepEqual(log, ['start'], 'another key going up cannot close the gesture');
  tracker.key('down', 'ArrowUp');           // the arrow is still repeating
  assert.deepEqual(log, ['start'], 'and the repeat does not open a second one');
  tracker.key('up', 'ArrowUp');
  assert.deepEqual(log, ['start', 'end']);
}

// A second arrow pressed while the first is held stays inside the first one's
// gesture, and the first one's keyup still closes it.
{
  const { log, tracker } = rig();
  tracker.key('down', 'ArrowUp');
  tracker.key('down', 'ArrowDown');
  assert.deepEqual(log, ['start']);
  tracker.key('up', 'ArrowDown');
  assert.deepEqual(log, ['start'], 'the pin belongs to the opening key');
  tracker.key('up', 'ArrowUp');
  assert.deepEqual(log, ['start', 'end']);
}

// An identity-less `key('up')` is the unconditional close — what the widget's
// `blur` uses, since a focus lost mid-press sends the keyup somewhere else.
{
  const { log, tracker } = rig();
  tracker.key('down', 'ArrowUp');
  tracker.key('up');
  assert.deepEqual(log, ['start', 'end']);
  // It still cannot touch a drag or a burst that is not a key gesture.
  tracker.pointerDown();
  tracker.key('up');
  assert.deepEqual(log, ['start', 'end', 'start']);
  tracker.pointerUp();
  assert.deepEqual(log, ['start', 'end', 'start', 'end']);
}

// A key gesture does NOT time out: it waits for its keyup however long the key is held.
{
  const { clock, log, tracker } = rig();
  tracker.key('down');
  clock.tick(10 * WHEEL_GESTURE_IDLE_MS);
  assert.deepEqual(log, ['start'], 'a held key is still one gesture');
  tracker.key('up');
  assert.deepEqual(log, ['start', 'end']);
}

// Wheel: a burst is ONE gesture. Two ticks inside the idle window give one pair,
// closed by the deadline — the wheel has no release event of any kind.
{
  const { clock, log, tracker } = rig();
  tracker.wheelTick();
  clock.tick(WHEEL_GESTURE_IDLE_MS - 1);
  tracker.wheelTick();
  assert.deepEqual(log, ['start'], 'the second tick is inside the burst');
  clock.tick(WHEEL_GESTURE_IDLE_MS - 1);
  assert.deepEqual(log, ['start'], 'the deadline was pushed out by the second tick');
  clock.tick(1);
  assert.deepEqual(log, ['start', 'end']);
  assert.equal(clock.armed, 0, 'the deadline disarms itself when it fires');
}

// Ticks further apart than the window are two separate gestures.
{
  const { clock, log, tracker } = rig();
  tracker.wheelTick();
  clock.tick(WHEEL_GESTURE_IDLE_MS);
  tracker.wheelTick();
  clock.tick(WHEEL_GESTURE_IDLE_MS);
  assert.deepEqual(log, ['start', 'end', 'start', 'end']);
}

// Interleaving rule: a pointer gesture is DOMINANT. A pointerdown during a wheel
// burst ends the wheel gesture first and then starts the pointer one (never two
// open at once, never a start without its end), and the wheel's deadline is
// disarmed with it so it cannot punch out under the held button.
{
  const { clock, log, tracker } = rig();
  tracker.wheelTick();
  tracker.pointerDown();
  assert.deepEqual(log, ['start', 'end', 'start']);
  assert.equal(clock.armed, 0, 'the wheel deadline is cleared by the pointer gesture');
  clock.tick(10 * WHEEL_GESTURE_IDLE_MS);
  assert.deepEqual(log, ['start', 'end', 'start'], 'no deadline can end a pointer drag');
  tracker.pointerUp();
  assert.deepEqual(log, ['start', 'end', 'start', 'end']);
}

// The other half of dominance: while a drag is held, wheel ticks and key presses
// FOLD INTO it. A Shift released mid-ride (or an arrow nudge with the button down)
// must not punch the drag out — the drag ends on its own pointerup and nothing else.
{
  const { clock, log, tracker } = rig();
  tracker.pointerDown();
  tracker.wheelTick();
  tracker.key('down');
  tracker.key('up');
  clock.tick(10 * WHEEL_GESTURE_IDLE_MS);
  assert.deepEqual(log, ['start'], 'nothing inside the drag opens or closes a gesture');
  assert.equal(clock.armed, 0);
  tracker.pointerUp();
  assert.deepEqual(log, ['start', 'end']);
}

// Key and wheel take turns: whichever is open, the other's first input closes it
// and opens its own. Still strictly alternating start/end.
{
  const { clock, log, tracker } = rig();
  tracker.key('down');
  tracker.wheelTick();
  assert.deepEqual(log, ['start', 'end', 'start']);
  tracker.key('down');
  assert.deepEqual(log, ['start', 'end', 'start', 'end', 'start']);
  assert.equal(clock.armed, 0, 'the wheel deadline left with the wheel gesture');
  tracker.key('up');
  assert.deepEqual(log, ['start', 'end', 'start', 'end', 'start', 'end']);
  // A stale keyup after the gesture already closed cannot end anything.
  tracker.key('up');
  clock.tick(10 * WHEEL_GESTURE_IDLE_MS);
  assert.deepEqual(log, ['start', 'end', 'start', 'end', 'start', 'end']);
}

// A keyup while a wheel burst is running belongs to no gesture the tracker owns:
// it must not close the burst early.
{
  const { clock, log, tracker } = rig();
  tracker.wheelTick();
  tracker.key('up');
  assert.deepEqual(log, ['start']);
  clock.tick(WHEEL_GESTURE_IDLE_MS);
  assert.deepEqual(log, ['start', 'end']);
}

// Unmount mid-gesture emits exactly one end — for each of the three sources — and
// the disposed tracker is inert afterwards.
{
  for (const open of [
    (t: ReturnType<typeof createGestureTracker>) => t.pointerDown(),
    (t: ReturnType<typeof createGestureTracker>) => t.key('down'),
    (t: ReturnType<typeof createGestureTracker>) => t.wheelTick(),
  ]) {
    const { clock, log, tracker } = rig();
    open(tracker);
    tracker.dispose();
    assert.deepEqual(log, ['start', 'end']);
    assert.equal(clock.armed, 0, 'dispose disarms any deadline');
    tracker.dispose();
    tracker.pointerDown(); tracker.pointerUp();
    tracker.key('down'); tracker.key('up');
    tracker.wheelTick();
    clock.tick(10 * WHEEL_GESTURE_IDLE_MS);
    assert.deepEqual(log, ['start', 'end'], 'a disposed tracker never fires again');
  }
}

// Dispose with nothing open emits nothing.
{
  const { log, tracker } = rig();
  tracker.dispose();
  assert.deepEqual(log, []);
}

// The double-click reset is a gesture of one change: the widget wraps it in a
// pointer pair of its own, and it is balanced like any other.
{
  const { log, tracker } = rig();
  tracker.pointerDown(); tracker.pointerUp();   // first click
  tracker.pointerDown(); tracker.pointerUp();   // second click
  tracker.pointerDown(); tracker.pointerUp();   // the reset the dblclick performs
  assert.deepEqual(log, ['start', 'end', 'start', 'end', 'start', 'end']);
}

// Balance under a long random interleaving: never two starts in a row, never two
// ends, and the sequence closes when the tracker is disposed.
{
  const { clock, log, tracker } = rig();
  let seed = 20260915;
  // High bits only: the low bits of an LCG cycle far too short to interleave with.
  const rnd = (n: number) => Math.floor(((seed = (seed * 1103515245 + 12345) % 2147483648) / 2048) % n);
  const moves = [
    () => tracker.pointerDown(),
    () => tracker.pointerUp(),
    () => tracker.key('down'),
    () => tracker.key('up'),
    () => tracker.key('down', 'ArrowUp'),
    () => tracker.key('up', 'ArrowUp'),
    () => tracker.key('up', 'Shift'),
    () => tracker.wheelTick(),
    () => clock.tick(WHEEL_GESTURE_IDLE_MS),
    () => clock.tick(1),
  ];
  for (let i = 0; i < 4000; i++) moves[rnd(moves.length)]();
  tracker.dispose();
  assert.ok(log.length > 20, 'the interleaving actually exercised the tracker');
  for (let i = 0; i < log.length; i++) assert.equal(log[i], i % 2 === 0 ? 'start' : 'end');
  assert.equal(log.length % 2, 0, 'every start was closed');
}

console.log('SlideTrack gesture boundary: all assertions passed');
