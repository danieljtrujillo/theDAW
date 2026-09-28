/**
 * Mount test for the roll's CC lane (stage 4.1): the strip under the grid
 * where one controller of the part being edited is drawn.
 *
 * The sequence: a piano part comes in from a file with its sustain pedal; the
 * lane opens on expression; the CONTROLLER field (a real label) moves it to
 * brightness; a click adds a change and it is one undo step, the pedal left
 * as it was; DRAW writes a rising swell in one drag and one undo step; the
 * arrow keys move the selected change; REC writes a hardware mod wheel at the
 * playhead and lands the pass when PLAY stops; CLEAR takes brightness away
 * and leaves the rest. Nothing prints under 12px.
 *
 *   cd frontend && npx tsx src/components/audio/CcLane.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

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

const { CcLane, PianoRollCcKey } = await import('./CcLane.tsx');
const { activeTrackOf, endRollGesture, usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const { publishMidi } = await import('../../state/midiBus.ts');
const { CC_LANE_HEIGHT, ccValueToY, controllerPoints } = await import('../../lib/ccLane.ts');

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const roll = () => usePianoRollStore.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const q = <T extends Element>(sel: string): T | null => win.document.querySelector(sel) as T | null;
const byName = (name: string): HTMLButtonElement => {
  const hit = [...win.document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name);
  assert.ok(hit, `a key named "${name}"`);
  return hit as HTMLButtonElement;
};
const ptr = (el: Element, type: string, x: number, y: number) =>
  el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
const points = (cc: number) => controllerPoints(activeTrackOf(roll()).controls, cc);

const STEP_PX = 10;
const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => {
  roll().importParts(
    [
      {
        name: 'Piano',
        program: 0,
        notes: [{ id: 'p1', note: 48, step: 0, length: 16, velocity: 80 }],
        controls: [
          { tick: 0, controller: 64, value: 127 },
          { tick: 1920, controller: 64, value: 0 },
        ],
      },
    ],
    120,
  );
});
let open = false;
const App = () => (
  <>
    <PianoRollCcKey on={open} onChange={(v) => { open = v; }} />
    <CcLane stepPx={STEP_PX} totalSteps={64} />
  </>
);
await step(() => root.render(<App />));

// The field is named by a real label and opens on expression.
const select = q<HTMLSelectElement>('[data-cc-lane] select');
assert.ok(select, 'a controller field');
assert.equal(select.getAttribute('name'), select.id, 'id and name');
assert.equal(q(`label[for="${select.id}"]`)?.textContent, 'Controller');
assert.equal(select.value, '11', 'expression first');
assert.deepEqual([...select.options].map((o) => o.value), ['1', '7', '10', '11', '64', '74', '91', '-1', '-2', '-3'], 'every controller a part keeps, then the selected note’s expression');
assert.deepEqual([...select.options].slice(7).map((o) => o.textContent), ['Note pressure', 'Note timbre (74)', 'Note bend']);
await step(() => {
  select.value = '74';
  select.dispatchEvent(new win.Event('change', { bubbles: true }));
});
const strip = q<HTMLElement>('[data-cc-lane] [role="slider"]');
assert.ok(strip, 'the strip is a slider');
assert.match(strip.getAttribute('aria-label') ?? '', /^CC 74 Brightness for Piano, 0 changes$/);

// A click adds a change: one undo step, on the grid, the pedal left alone.
endRollGesture();
let undo = roll()._undo.length;
await step(() => {
  ptr(strip, 'pointerdown', 100, ccValueToY(100, CC_LANE_HEIGHT));
  ptr(strip, 'pointerup', 100, ccValueToY(100, CC_LANE_HEIGHT));
});
assert.deepEqual(points(74), [{ tick: 2400, value: 100 }], 'step 10 is tick 2400; the value is where it was clicked');
assert.deepEqual(points(64), [{ tick: 0, value: 127 }, { tick: 1920, value: 0 }], 'the pedal stays');
assert.equal(roll()._undo.length, undo + 1, 'one undo step');

// The arrow keys move the selected change.
await step(() => {
  strip.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
});
assert.deepEqual(points(74), [{ tick: 2400, value: 101 }]);

// DRAW: one drag writes a rising swell, in one undo step.
await step(() => byName('Draw').click());
endRollGesture();
undo = roll()._undo.length;
await step(() => {
  ptr(strip, 'pointerdown', 200, ccValueToY(10, CC_LANE_HEIGHT));
  ptr(strip, 'pointermove', 280, ccValueToY(120, CC_LANE_HEIGHT));
  ptr(strip, 'pointerup', 280, ccValueToY(120, CC_LANE_HEIGHT));
});
const swell = points(74).filter((p) => p.tick >= 4800);
assert.ok(swell.length > 10, `a change every 64th where it moves (${swell.length})`);
for (let i = 1; i < swell.length; i += 1) assert.ok(swell[i].value > swell[i - 1].value, 'rising');
assert.equal(swell[swell.length - 1].value, 120);
assert.equal(roll()._undo.length, undo + 1, 'the drawn swell is one undo step');
assert.deepEqual(points(64).length, 2, 'the pedal still stays');
await step(() => byName('Draw').click());

// REC: a hardware mod wheel written at the playhead, landed when PLAY stops.
await step(() => byName('Rec').click());
await step(() => {
  usePianoRollStore.setState({ isPlaying: true, currentStep: 4 });
});
await step(() => publishMidi([0xb0, 1, 70]));
await step(() => {
  usePianoRollStore.setState({ currentStep: 8 });
});
await step(() => publishMidi([0xb0, 1, 90]));
assert.deepEqual(points(1), [], 'nothing lands while the pass runs');
assert.match(q('[data-cc-lane] [role="status"]')?.textContent ?? '', /Recording · 2/);
await step(() => {
  usePianoRollStore.setState({ isPlaying: false });
});
assert.deepEqual(points(1), [{ tick: 960, value: 70 }, { tick: 1920, value: 90 }], 'the pass lands at the ticks it was played on');
await step(() => byName('Rec').click());

// CLEAR takes brightness away and leaves the rest.
await step(() => byName('Clear controller').click());
assert.deepEqual(points(74), []);
assert.equal(points(64).length, 2);
assert.equal(points(1).length, 2);

// ── The selected note's own expression ─────────────────────────────────────
{
  const noteOf = () => roll().notes.find((x) => x.id === 'p1')!;
  await step(() => {
    select.value = '-2';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  await step(() => roll().setSelection([]));
  assert.match(strip.getAttribute('aria-label') ?? '', /Note timbre \(74\): no note selected/);
  assert.match(strip.textContent ?? '', /Select a note to draw its note timbre/);
  await step(() => roll().setSelection(['p1']));
  endRollGesture();
  const before = roll()._undo.length;
  // The note spans steps 0-16: its start value at x 0, a change at step 8.
  await step(() => {
    ptr(strip, 'pointerdown', 0, ccValueToY(40, CC_LANE_HEIGHT));
    ptr(strip, 'pointerup', 0, ccValueToY(40, CC_LANE_HEIGHT));
  });
  await step(() => {
    ptr(strip, 'pointerdown', 80, ccValueToY(120, CC_LANE_HEIGHT));
    ptr(strip, 'pointerup', 80, ccValueToY(120, CC_LANE_HEIGHT));
  });
  const e = noteOf().expr!;
  assert.equal(Math.round(e.timbre! * 127), 40, 'the note starts at the first point');
  assert.deepEqual(e.curves?.timbre?.map((p) => [p.tick, Math.round(p.value * 127)]), [[1920, 120]], 'and moves at step 8');
  assert.equal(roll()._undo.length, before + 2, 'each edit one undo step');
  assert.deepEqual(points(74), [], 'the part’s CC 74 is untouched');
  // A point past the note's end is held inside it.
  await step(() => {
    ptr(strip, 'pointerdown', 300, ccValueToY(10, CC_LANE_HEIGHT));
    ptr(strip, 'pointerup', 300, ccValueToY(10, CC_LANE_HEIGHT));
  });
  assert.ok(noteOf().expr!.curves!.timbre!.every((p) => p.tick < 3840), 'inside the note');

  // Note bend: 64 is the centre.
  await step(() => {
    select.value = '-3';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  await step(() => {
    ptr(strip, 'pointerdown', 0, ccValueToY(64, CC_LANE_HEIGHT));
    ptr(strip, 'pointerup', 0, ccValueToY(64, CC_LANE_HEIGHT));
  });
  assert.equal(noteOf().expr!.pitchBend, 0, 'the centre is no bend');

  // REC: an MPE controller's pressure into the selected note while the playhead is in it.
  await step(() => {
    select.value = '-1';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
  await step(() => byName('Rec').click());
  await step(() => usePianoRollStore.setState({ isPlaying: true, currentStep: 4 }));
  await step(() => publishMidi([0xd1, 100]));
  await step(() => usePianoRollStore.setState({ currentStep: 20 }));
  await step(() => publishMidi([0xd1, 10])); // past the note: not its
  await step(() => usePianoRollStore.setState({ isPlaying: false }));
  assert.deepEqual(noteOf().expr!.curves?.pressure?.map((p) => [p.tick, Math.round(p.value * 127)]), [[960, 100]], 'the pressure lands a beat into the note');
  await step(() => byName('Rec').click());

  // CLEAR takes the note's pressure away, its timbre and bend stay.
  await step(() => byName('Clear controller').click());
  assert.equal(noteOf().expr!.pressure, undefined);
  assert.equal(noteOf().expr!.curves?.pressure, undefined);
  assert.ok(noteOf().expr!.curves?.timbre, 'its timbre stays');
}

// The key counts the part's changes.
assert.ok(byName('CC'), 'the strip key');

// Nothing prints under 12px.
const small = [...host.querySelectorAll('*')].filter((el) => /text-\[(?:[0-9]|1[01])px\]/.test(el.getAttribute('class') ?? ''));
assert.equal(small.length, 0, 'no text under 12px in the lane');

await step(() => root.unmount());
console.log('CcLane: ok');
