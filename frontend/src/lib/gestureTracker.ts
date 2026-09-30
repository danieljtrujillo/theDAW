/* ── gestureTracker: one gesture boundary for a three-input widget ───────────
   A slider that can be dragged, typed at and scrolled has three inputs and only
   one of them (the pointer) reports a release. A consumer that records a GESTURE
   — automation touch/latch/write, an undo coalescer — needs a begin and an end
   per gesture, not a stream of anonymous values, so the widget owns that
   bookkeeping and reports the boundary; the consumer stops guessing it from
   window listeners and a deadline.

   The rules, in one place because they only make sense together:

   · Sources are `pointer`, `key` and `wheel`, and at most ONE gesture is open at
     any moment. `onStart` fires when it opens, `onEnd` when it closes, always
     alternating, never twice in a row.
   · The POINTER IS DOMINANT. While a drag is held, wheel ticks and key presses
     fold into it: they neither open nor close a gesture, and no deadline runs. A
     Shift let go mid-ride, or an arrow nudged with the button down, must not
     punch the drag out. A drag ends on its own pointerup/pointercancel.
   · A pointerdown arriving during a wheel burst or a key press ENDS that gesture
     first, then starts the pointer one. Same for key-during-wheel and
     wheel-during-key: the newcomer closes the incumbent before it opens.
   · A KEY gesture spans one key press: the keydown opens it (auto-repeat
     keydowns stay inside it) and the matching keyup closes it. It has no
     deadline, so holding a key is one gesture however long it is held. The
     gesture is PINNED to the key that opened it, so a keyup for any OTHER key
     cannot close it: Shift held with ArrowUp and then let go while the arrow
     auto-repeats must not split the ride into two gestures. Pass the key
     identity to both phases (`key('down', e.key)` / `key('up', e.key)`); an
     identity-less `key('up')` is the unconditional close the widget uses for
     `blur`, because a focus lost mid-press sends the keyup somewhere else and a
     gesture that never closes is the one failure a consumer cannot recover from.
   · A WHEEL burst has no release event of any kind, so it closes on a deadline:
     `idleMs` with no further tick. Each tick pushes the deadline out.
   · `dispose()` (unmount) closes whatever is open, exactly once, and leaves the
     tracker inert.

   SCOPE, for the consumer: the boundary is the only thing reported. `onStart`
   carries no value and does not promise a change is coming — a press and release
   with no movement is still a balanced pair — and `onEnd` carries no value
   either. So treat `onStart` as ARM, treat the first `onChange` as the real
   begin, and tolerate an `onEnd` for a target that was never begun (drop it).
   Balance is the guarantee; a change having happened is not.

   The clock is injected so the whole thing is testable without a DOM. */

/** How long a wheel burst may go quiet before it counts as released. */
export const WHEEL_GESTURE_IDLE_MS = 150;

export type GestureSource = 'pointer' | 'key' | 'wheel';
/** `down` opens a key gesture, `up` closes it (also used for `blur`). */
export type GestureKeyPhase = 'down' | 'up';

export interface GestureTrackerOptions {
  onStart?: () => void;
  onEnd?: () => void;
  /** Wheel-burst idle window. Defaults to `WHEEL_GESTURE_IDLE_MS`. */
  idleMs?: number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export interface GestureTracker {
  /** Pointer down — call BEFORE the first `onChange` of the drag. */
  pointerDown(): void;
  /** Pointer up or pointer cancel; the second of the two is a no-op. */
  pointerUp(): void;
  /** A handled keydown (before its `onChange`), a keyup, or a blur.
   *  `id` is the key identity (`e.key`): a keyup only closes the gesture the
   *  SAME key opened. Omit it to close unconditionally, as `blur` does. */
  key(phase: GestureKeyPhase, id?: string): void;
  /** One wheel tick — call BEFORE its `onChange`. */
  wheelTick(): void;
  /** Unmount: close anything open and go inert. Idempotent. */
  dispose(): void;
}

export function createGestureTracker(options: GestureTrackerOptions = {}): GestureTracker {
  const { onStart, onEnd } = options;
  const idleMs = options.idleMs ?? WHEEL_GESTURE_IDLE_MS;
  const setTimer = options.setTimer
    ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? ((handle: number) => clearTimeout(handle));

  let source: GestureSource | null = null;
  let keyId: string | undefined;
  let timer: number | null = null;
  let disposed = false;

  const disarm = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };
  const end = () => {
    if (source === null) return;
    disarm();
    // Cleared BEFORE the callback, so a consumer that reacts by calling back in
    // (ending a gesture can settle a value, which can settle a prop) takes the
    // guard above instead of emitting a second end.
    source = null;
    keyId = undefined;
    onEnd?.();
  };
  const start = (next: GestureSource) => {
    if (source === next) return;
    end();
    source = next;
    onStart?.();
  };
  const arm = () => {
    disarm();
    timer = setTimer(() => { timer = null; end(); }, idleMs);
  };

  return {
    pointerDown() {
      if (disposed) return;
      start('pointer');
    },
    pointerUp() {
      if (disposed || source !== 'pointer') return;
      end();
    },
    key(phase, id) {
      if (disposed) return;
      if (phase === 'down') {
        if (source === 'pointer') return; // folded into the drag
        // Auto-repeat: the gesture (and its pin) belong to the first keydown.
        if (source === 'key') return;
        start('key');
        keyId = id;
        return;
      }
      // A keyup only ever ends a KEY gesture: while a drag or a wheel burst owns
      // the widget, any key let go belongs to something else.
      if (source !== 'key') return;
      // ...and only the key that OPENED it can close it. A modifier released
      // while the arrow it modified still auto-repeats is not the end of the
      // ride. `id === undefined` is the unconditional close (blur).
      if (id !== undefined && keyId !== undefined && id !== keyId) return;
      end();
    },
    wheelTick() {
      if (disposed || source === 'pointer') return; // folded into the drag
      start('wheel');
      arm();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      end();
    },
  };
}
