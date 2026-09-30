// Run with: npx tsx src/components/audio/effects/EffectKnob.gesture.test.ts
/**
 * The SCHEMA-driven rack widgets report a real automation gesture boundary.
 *
 * `EffectKnob` and `EffectXYPad` are the default controls of every schema
 * effect panel (EffectControls), and until now neither said when a gesture
 * began or ended — the automation consumer had to punch out on
 * `lib/automationGesture`'s 250 ms idle deadline, so one slow drag with a pause
 * in it was recorded as two passes. Both widgets now own a
 * `lib/gestureTracker`, the same way `SlideTrack` does.
 *
 * `SlideTrack.test.ts` tests that bookkeeping as a pure helper. What is NOT
 * covered there is the WIRING: that each of the widget's input paths actually
 * reaches the tracker, and reaches it on the right side of the value write. So
 * this suite mounts the real components in jsdom (the rig
 * `EffectWindows.test.tsx` established) and drives them with real events.
 *
 * The contract: exactly one start before the first change of a gesture, exactly
 * one end after its last — for a drag, a wheel burst, a held key and a
 * double-click reset — and an end even when the widget unmounts mid-gesture.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const g = globalThis as unknown as Record<string, unknown>;
for (const key of [
  'window', 'document', 'HTMLElement', 'SVGElement', 'Node', 'Element', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
]) {
  Object.defineProperty(g, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const W = dom.window as unknown as Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A pointer event jsdom can build: `PointerEvent` when it has one, else a
 *  `MouseEvent` of the same type. React dispatches by event NAME, and neither
 *  widget reads anything a MouseEvent lacks except `pointerType`, which is only
 *  ever compared against 'mouse' to reject a non-primary button. */
const pointer = (el: Element, type: string, init: Record<string, unknown> = {}) => {
  const Ctor = W.PointerEvent ?? W.MouseEvent;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init }));
};
const keyEvent = (el: Element, type: string, key: string, init: Record<string, unknown> = {}) => {
  el.dispatchEvent(new W.KeyboardEvent(type, { bubbles: true, cancelable: true, key, ...init }));
};
const mouse = (el: Element, type: string) => {
  el.dispatchEvent(new W.MouseEvent(type, { bubbles: true, cancelable: true }));
};
const wheelTick = (el: Element, deltaY: number) => {
  el.dispatchEvent(new W.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY }));
};

async function main(): Promise<void> {
  // Imported after the DOM globals exist: react-dom decides at load time
  // whether it runs in a browser.
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { EffectKnob } = await import('./EffectKnob.tsx');
  const { EffectXYPad } = await import('./EffectXYPad.tsx');
  const { WHEEL_GESTURE_IDLE_MS } = await import('../../../lib/gestureTracker.ts');
  const { act } = React;
  const doc = dom.window.document as Document;

  const freq = { key: 'freq', label: 'Freq', min: 0, max: 1, step: 0.01, default: 0.5 };
  const reso = { key: 'reso', label: 'Reso', min: 0, max: 1, step: 0.01, default: 0.25 };

  type Vals = { x: number; y: number };
  type Gesture = { onGestureStart: () => void; onGestureEnd: () => void };

  /** Mount one widget with a live value and a log of every boundary + change. */
  const mount = (build: (v: Vals, set: (n: Vals) => void, gesture: Gesture) => React.ReactElement) => {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const log: string[] = [];
    const root = createRoot(host);
    const Harness: React.FC = () => {
      const [v, setV] = React.useState<Vals>({ x: 0.5, y: 0.25 });
      return build(v, (n) => { log.push('change'); setV(n); }, {
        onGestureStart: () => log.push('start'),
        onGestureEnd: () => log.push('end'),
      });
    };
    act(() => { root.render(React.createElement(Harness)); });
    return {
      log,
      el: (sel: string): Element => {
        const found = host.querySelector(sel);
        assert.ok(found, `missing ${sel}`);
        return found;
      },
      unmount: () => act(() => { root.unmount(); }),
      /** Boundaries only — the change count varies with the input. */
      bounds: () => log.filter((e) => e !== 'change'),
      changes: () => log.filter((e) => e === 'change').length,
    };
  };

  const knob = () => mount((v, set, gesture) => React.createElement(EffectKnob, {
    param: freq, value: v.x, onChange: (n: number) => set({ ...v, x: n }), ...gesture,
  }));
  const pad = () => mount((v, set, gesture) => React.createElement(EffectXYPad, {
    label: 'Filter', xParam: freq, yParam: reso, x: v.x, y: v.y,
    onChange: (n: Vals) => set(n), ...gesture,
  }));

  const DIAL = 'div[role="slider"]';
  // The pad is a pointer surface (a labelled group); its two axes are sliders.
  const SURFACE = 'svg[role="group"]';
  const PAD_X = '[role="slider"][aria-label="Filter Freq (X)"]';
  const PAD_Y = '[role="slider"][aria-label="Filter Reso (Y)"]';

  // ── EffectKnob ────────────────────────────────────────────────────────────

  // A drag is ONE gesture: the start lands before the first change, the end
  // after the last, and the moves in between are not boundaries.
  {
    const w = knob();
    const el = w.el(DIAL);
    act(() => { pointer(el, 'pointerdown', { clientY: 200 }); });
    assert.deepEqual(w.log, ['start'], 'the start precedes the first change of the drag');
    for (const y of [190, 180, 170]) act(() => { pointer(el, 'pointermove', { clientY: y }); });
    assert.deepEqual(w.bounds(), ['start'], 'a move is not a boundary');
    assert.ok(w.changes() >= 3, 'the drag actually moved the dial');
    act(() => { pointer(el, 'pointerup', { clientY: 170 }); });
    assert.deepEqual(w.bounds(), ['start', 'end']);
    assert.equal(w.log[w.log.length - 1], 'end', 'the end lands after the last change');
    w.unmount();
  }

  // A press and release with no movement is still a balanced pair.
  {
    const w = knob();
    const el = w.el(DIAL);
    act(() => { pointer(el, 'pointerdown', { clientY: 200 }); });
    act(() => { pointer(el, 'pointerup', { clientY: 200 }); });
    assert.deepEqual(w.log, ['start', 'end']);
    w.unmount();
  }

  // pointercancel closes the drag exactly once (no second end after pointerup).
  {
    const w = knob();
    const el = w.el(DIAL);
    act(() => { pointer(el, 'pointerdown', { clientY: 200 }); });
    act(() => { pointer(el, 'pointerup', { clientY: 200 }); });
    act(() => { pointer(el, 'pointercancel', { clientY: 200 }); });
    assert.deepEqual(w.bounds(), ['start', 'end']);
    w.unmount();
  }

  // A wheel burst is ONE gesture, closed by the tracker's own idle window (the
  // wheel has no release event of any kind). The dial only turns while it holds
  // focus, so the burst runs on the focused element.
  {
    const w = knob();
    const el = w.el(DIAL) as unknown as HTMLElement;
    el.focus();
    assert.equal(doc.activeElement, el, 'the dial takes focus');
    act(() => { wheelTick(el, -1); });
    // Whole log, not just the boundaries: a `wheelTick()` made AFTER the step's
    // write would still leave `bounds()` reading ['start'].
    assert.deepEqual(w.log, ['start', 'change'], 'the start precedes the tick it belongs to');
    act(() => { wheelTick(el, -1); wheelTick(el, -1); });
    assert.deepEqual(w.bounds(), ['start'], 'three ticks inside the window are one gesture');
    assert.equal(w.changes(), 3, 'every tick still moved the dial');
    await act(async () => { await sleep(WHEEL_GESTURE_IDLE_MS + 80); });
    assert.deepEqual(w.bounds(), ['start', 'end'], 'the burst closes on its deadline');
    w.unmount();
  }

  // A held key is ONE gesture however long it is held: the auto-repeat keydowns
  // stay inside it and the keyup closes it. A modifier let go mid-ride does not
  // split it — the tracker pins the gesture to the key that opened it.
  {
    const w = knob();
    const el = w.el(DIAL);
    act(() => { keyEvent(el, 'keydown', 'ArrowUp'); });
    assert.deepEqual(w.bounds(), ['start']);
    act(() => { keyEvent(el, 'keydown', 'ArrowUp', { shiftKey: true }); });
    act(() => { keyEvent(el, 'keyup', 'Shift'); });
    act(() => { keyEvent(el, 'keydown', 'ArrowUp'); });
    assert.deepEqual(w.bounds(), ['start'], 'the ride is not split');
    assert.equal(w.changes(), 3);
    act(() => { keyEvent(el, 'keyup', 'ArrowUp'); });
    assert.deepEqual(w.bounds(), ['start', 'end']);
    w.unmount();
  }

  // An unhandled key opens nothing.
  {
    const w = knob();
    const el = w.el(DIAL);
    act(() => { keyEvent(el, 'keydown', 'a'); });
    act(() => { keyEvent(el, 'keyup', 'a'); });
    assert.deepEqual(w.log, []);
    w.unmount();
  }

  // Focus lost mid-press still closes the gesture: the keyup is delivered
  // somewhere else, so blur is the backstop.
  {
    const w = knob();
    const el = w.el(DIAL) as unknown as HTMLElement;
    el.focus();
    act(() => { keyEvent(el, 'keydown', 'ArrowUp'); });
    assert.deepEqual(w.bounds(), ['start']);
    act(() => { el.blur(); });
    assert.deepEqual(w.bounds(), ['start', 'end']);
    w.unmount();
  }

  // The double-click reset is a gesture of one change, in its own pair.
  {
    const w = knob();
    act(() => { mouse(w.el(DIAL), 'dblclick'); });
    assert.deepEqual(w.log, ['start', 'change', 'end']);
    w.unmount();
  }

  // Unmounting mid-gesture still closes it, exactly once.
  {
    const w = knob();
    act(() => { pointer(w.el(DIAL), 'pointerdown', { clientY: 200 }); });
    assert.deepEqual(w.bounds(), ['start']);
    w.unmount();
    assert.deepEqual(w.bounds(), ['start', 'end'], 'the unmount closes the open gesture');
  }

  // ── EffectXYPad ───────────────────────────────────────────────────────────

  const sized = (el: Element) => {
    (el as unknown as HTMLElement).getBoundingClientRect = () => ({
      left: 0, top: 0, width: 120, height: 120, right: 120, bottom: 120, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    return el;
  };

  // A drag across the surface writes BOTH lanes and is still one gesture.
  {
    const w = pad();
    const el = sized(w.el(SURFACE));
    act(() => { pointer(el, 'pointerdown', { clientX: 10, clientY: 110 }); });
    // Whole log: unlike the knob, the pad's press writes immediately, so the
    // ORDER is the assertion — a `pointerDown()` made after `fromPointer` would
    // still leave `bounds()` reading ['start'].
    assert.deepEqual(w.log, ['start', 'change'], 'the start precedes the first change of the drag');
    for (const x of [30, 60, 90]) act(() => { pointer(el, 'pointermove', { clientX: x, clientY: 60 }); });
    assert.deepEqual(w.bounds(), ['start'], 'a move is not a boundary');
    assert.ok(w.changes() >= 4, 'the drag actually moved the dot');
    act(() => { pointer(el, 'pointerup', { clientX: 90, clientY: 60 }); });
    assert.deepEqual(w.bounds(), ['start', 'end']);
    assert.equal(w.log[w.log.length - 1], 'end', 'the end lands after the last change');
    w.unmount();
  }

  // A held arrow is one gesture here too.
  {
    const w = pad();
    const el = w.el(PAD_X);
    act(() => { keyEvent(el, 'keydown', 'ArrowRight'); });
    act(() => { keyEvent(el, 'keydown', 'ArrowRight'); });
    assert.deepEqual(w.bounds(), ['start']);
    assert.equal(w.changes(), 2, 'auto-repeat keeps writing inside the one gesture');
    act(() => { keyEvent(el, 'keyup', 'ArrowRight'); });
    assert.deepEqual(w.bounds(), ['start', 'end']);
    w.unmount();
  }

  // An unhandled key opens nothing.
  {
    const w = pad();
    act(() => { keyEvent(w.el(PAD_X), 'keydown', 'Tab'); });
    act(() => { keyEvent(w.el(PAD_Y), 'keydown', 'a'); });
    assert.deepEqual(w.log, []);
    w.unmount();
  }

  // Each axis is a slider a screen reader reads: its range, its value and its
  // formatted text, and the keys move that axis alone. Up to afd27bea the pad
  // was one role="application" surface with no value for either axis.
  {
    const w = pad();
    const sx = w.el(PAD_X);
    const sy = w.el(PAD_Y);
    assert.equal(w.el(SURFACE).getAttribute('tabindex'), null, 'the surface is not a tab stop; its sliders are');
    assert.deepEqual([sx.getAttribute('tabindex'), sy.getAttribute('tabindex')], ['0', '0']);
    assert.deepEqual([sx.getAttribute('aria-valuemin'), sx.getAttribute('aria-valuemax'), sx.getAttribute('aria-valuenow')], ['0', '1', '0.5']);
    assert.equal(sy.getAttribute('aria-valuenow'), '0.25');
    act(() => { keyEvent(sy, 'keydown', 'ArrowUp'); });
    act(() => { keyEvent(sy, 'keyup', 'ArrowUp'); });
    assert.equal(w.el(PAD_Y).getAttribute('aria-valuenow'), '0.26', 'Up raises Y by one step');
    assert.equal(w.el(PAD_X).getAttribute('aria-valuenow'), '0.5', 'and leaves X');
    act(() => { keyEvent(w.el(PAD_X), 'keydown', 'End'); });
    act(() => { keyEvent(w.el(PAD_X), 'keyup', 'End'); });
    assert.equal(w.el(PAD_X).getAttribute('aria-valuenow'), '1', 'End goes to the top of X');
    act(() => { keyEvent(w.el(PAD_X), 'keydown', 'PageDown'); });
    act(() => { keyEvent(w.el(PAD_X), 'keyup', 'PageDown'); });
    assert.equal(w.el(PAD_X).getAttribute('aria-valuenow'), '0.9', 'PageDown moves ten steps');
    act(() => { keyEvent(w.el(PAD_Y), 'keydown', 'Delete'); });
    act(() => { keyEvent(w.el(PAD_Y), 'keyup', 'Delete'); });
    assert.deepEqual([w.el(PAD_X).getAttribute('aria-valuenow'), w.el(PAD_Y).getAttribute('aria-valuenow')], ['0.5', '0.25'], 'Delete resets both');
    assert.deepEqual(w.bounds(), ['start', 'end', 'start', 'end', 'start', 'end', 'start', 'end'], 'each press is its own gesture');
    w.unmount();
  }

  // The double-click reset is a gesture of one change.
  {
    const w = pad();
    act(() => { mouse(w.el(SURFACE), 'dblclick'); });
    assert.deepEqual(w.log, ['start', 'change', 'end']);
    w.unmount();
  }

  // Blur backstop.
  {
    const w = pad();
    const el = w.el(PAD_Y) as unknown as HTMLElement;
    act(() => { el.focus(); }); // the slider draws its focus line, a state update
    act(() => { keyEvent(el, 'keydown', 'ArrowUp'); });
    assert.deepEqual(w.bounds(), ['start']);
    act(() => { el.blur(); });
    assert.deepEqual(w.bounds(), ['start', 'end']);
    w.unmount();
  }

  // Unmount mid-drag.
  {
    const w = pad();
    act(() => { pointer(sized(w.el(SURFACE)), 'pointerdown', { clientX: 10, clientY: 10 }); });
    assert.deepEqual(w.bounds(), ['start']);
    w.unmount();
    assert.deepEqual(w.bounds(), ['start', 'end']);
  }

  console.log('EffectKnob / EffectXYPad gesture boundary: all assertions passed');
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
