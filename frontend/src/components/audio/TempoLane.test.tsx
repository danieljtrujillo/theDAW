/**
 * Mount test for the MIDI tab's TEMPO key and lane (TempoLane.tsx), and the
 * header's BPM field, against the real roll store.
 *
 * The sequence a user makes: the TEMPO key opens the lane under the grid; a
 * click on the strip adds a tempo change at the bar line under the pointer; the
 * mode key turns to RAMP and a click adds a ritardando's start; HOLD adds a
 * fermata; a click on a point selects it, and its BPM field and RAMP key edit
 * it; Delete removes it and undo brings it back; CLEAR leaves only the starting
 * tempo. In the header, typing 140 into BPM gives 140: at 30a3edf the first
 * digit was clamped as it was typed (the "1" of 140 became 40), and the field
 * stopped at 40-240. The TEMPO, BEND and VELOCITY strips are sliders whose
 * value (aria-valuenow, aria-valuetext) is the selected point or notes, and
 * follows the arrow keys.
 *
 * Client-rendered (createRoot on jsdom), in the MidiPanel.test.tsx pattern.
 *
 *   cd frontend && npx tsx src/components/audio/TempoLane.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const { tempoLaneRange, tempoToY, TEMPO_LANE_HEIGHT } = await import('../../lib/tempoLane.ts');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  // The roll's window key listeners test `instanceof Element`; without it they throw and never run.
  Element: win.Element,
  Node: win.Node,
  localStorage: win.localStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
// jsdom lays nothing out, so every offsetParent is null and the roll's key
// listeners would take the roll for hidden; a mounted element has a parent here.
Object.defineProperty(win.HTMLElement.prototype, 'offsetParent', { get(this: HTMLElement) { return this.parentElement; }, configurable: true });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const roll = () => usePianoRollStore.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
const button = (name: string): HTMLButtonElement => {
  const hit = [...win.document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name,
  );
  assert.ok(hit, `the MIDI tab shows a "${name}" key`);
  return hit as HTMLButtonElement;
};
const shape = () =>
  roll().tempoMap.map((e) => (e.fermata ? `f${e.beat}:${e.fermata.beats}x${e.fermata.stretch}` : `${e.beat}:${e.bpm}${e.curve === 'linear' ? 'r' : ''}`)).join(' ');
const strip = () => win.document.querySelector('[data-tempo-lane] [role="slider"]') as HTMLElement | null;
const input = (id: string) => win.document.getElementById(id) as HTMLInputElement | null;
const valueSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
/** Typing: the value changes and an InputEvent says it was typed. */
const type = (el: HTMLInputElement, text: string) => {
  valueSetter.call(el, text);
  el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text.slice(-1) }));
};
const key = (el: HTMLElement, k: string) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
const blur = (el: HTMLElement) => el.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
/** A click on the strip at step `s` and tempo `bpm`, in the range the strip shows now. */
const clickAt = (s: number, bpm: number) => {
  const el = strip();
  assert.ok(el, 'the tempo strip is open');
  const clientX = s * 16; // the MIDI tab's default step width
  const clientY = tempoToY(bpm, tempoLaneRange(roll().tempoMap), TEMPO_LANE_HEIGHT);
  el.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX, clientY }));
  el.dispatchEvent(new win.MouseEvent('pointerup', { bubbles: true, button: 0, clientX, clientY }));
};

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => {
  roll().importNotes([{ id: 'a', note: 60, step: 0, length: 4, velocity: 90 }], 120);
  usePianoRollStore.setState({ totalSteps: 64 });
});
await step(() => root.render(<MidiPanel />));

// TEMPO opens the lane.
assert.equal(strip(), null, 'the lane starts closed');
const tempoKey = button('Tempo');
assert.equal(tempoKey.getAttribute('aria-pressed'), 'false');
await step(() => tempoKey.click());
assert.equal(tempoKey.getAttribute('aria-pressed'), 'true');
assert.ok(strip(), 'the lane is under the grid');
assert.match(strip()!.getAttribute('aria-label') ?? '', /starting at 120 BPM/);
// The strip is a slider over the selected point's tempo, in the app's 20-300 range.
assert.equal(strip()!.getAttribute('aria-valuemin'), '20');
assert.equal(strip()!.getAttribute('aria-valuemax'), '300');
assert.equal(strip()!.getAttribute('aria-valuenow'), '120', 'with nothing picked, the starting tempo');
assert.equal(strip()!.getAttribute('aria-valuetext'), 'No point selected; the tempo starts at 120 BPM');

// A click adds a tempo change on bar 3's line (step 32, beat 8), at 90.
await step(() => clickAt(32, 90));
assert.equal(shape(), '0:120 8:90');
assert.equal(strip()!.getAttribute('aria-valuenow'), '90', 'the new point is selected, and its tempo is the value');
assert.equal(strip()!.getAttribute('aria-valuetext'), '90 BPM, a step at bar 3');
// The arrow keys move it, and the value follows. The strip has the focus, so
// the roll owns the key (lib/keyScope) and its capture listener must let the
// lane have the arrows, as it does for BEND and VELOCITY.
await step(() => { strip()!.focus(); });
assert.equal(win.document.activeElement, strip());
await step(() => { key(strip()!, 'ArrowUp'); });
assert.equal(strip()!.getAttribute('aria-valuenow'), '91');
assert.equal(shape(), '0:120 8:91');
await step(() => { key(strip()!, 'ArrowDown'); });
assert.equal(shape(), '0:120 8:90');

// RAMP: a click adds a point that slides to the next one.
const modeKey = () => [...win.document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('What a click adds')) as HTMLButtonElement;
await step(() => modeKey().click());
assert.equal(modeKey().getAttribute('aria-label'), 'What a click adds: RAMP');
await step(() => clickAt(48, 90));
await step(() => clickAt(60, 60));
assert.equal(shape(), '0:120 8:90 12:90r 15:60r', 'a ramp from beat 12, and the point it ramps to');

// HOLD: a click adds a fermata, a quarter held twice as long.
await step(() => modeKey().click());
assert.equal(modeKey().getAttribute('aria-label'), 'What a click adds: HOLD');
await step(() => clickAt(56, 90));
assert.equal(shape(), '0:120 8:90 12:90r f14:1x2 15:60r');
assert.ok(input('tempo-lane-hold'), 'the fermata is selected and its HOLD field shows');
// A fermata's value is the tempo in force where it holds: the ramp from 90 at beat 12 to 60 at beat 15, at beat 14.
assert.equal(strip()!.getAttribute('aria-valuenow'), '70');
assert.equal(strip()!.getAttribute('aria-valuetext'), 'Fermata at bar 4, holds 1 beat x2, at 70 BPM');
await step(() => {
  const hold = input('tempo-lane-hold')!;
  valueSetter.call(hold, '2');
  blur(hold);
});
assert.equal(shape(), '0:120 8:90 12:90r f14:2x2 15:60r', 'the fermata holds two beats');

// A click on the point at beat 8 selects it; its BPM field and RAMP key edit it.
await step(() => clickAt(32, 90));
assert.equal(shape(), '0:120 8:90 12:90r f14:2x2 15:60r', 'a click on a point selects it, it adds nothing');
const pointBpm = input('tempo-lane-bpm');
assert.ok(pointBpm, 'the selected point has a BPM field');
assert.ok(win.document.querySelector('label[for="tempo-lane-bpm"]'), 'with a label');
await step(() => {
  valueSetter.call(pointBpm!, '66.5');
  blur(pointBpm!);
});
assert.equal(shape(), '0:120 8:66.5 12:90r f14:2x2 15:60r');
const ramp = button('Ramp from this point to the next');
assert.equal(ramp.getAttribute('aria-pressed'), 'false');
await step(() => ramp.click());
assert.equal(shape(), '0:120 8:66.5r 12:90r f14:2x2 15:60r');

// Delete removes the selected point; undo brings it back. (Edits closer than
// 300 ms fold into one undo step, as a drag does; a person's next key press
// comes later than that.)
await new Promise((r) => setTimeout(r, 320));
await step(() => { key(strip()!, 'Delete'); });
assert.equal(shape(), '0:120 12:90r f14:2x2 15:60r');
await step(() => roll().undo());
assert.equal(shape(), '0:120 8:66.5r 12:90r f14:2x2 15:60r');

// The header's BPM: typed digits wait for Enter, so "1" is not clamped to 20 on the way to 140.
const bpmField = input('piano-roll-bpm')!;
assert.equal(bpmField.min, '20');
assert.equal(bpmField.max, '300');
await step(() => type(bpmField, '1'));
assert.equal(roll().bpm, 120, 'a first typed digit changes nothing yet');
await step(() => type(bpmField, '14'));
await step(() => type(bpmField, '140'));
await step(() => { key(bpmField, 'Enter'); });
assert.equal(roll().bpm, 140);
assert.equal(shape(), '0:140 8:66.5r 12:90r f14:2x2 15:60r', 'BPM is the starting point of the map');
await step(() => type(bpmField, '24.25'));
await step(() => { blur(bpmField); });
assert.equal(roll().bpm, 24.25, 'a slow introduction below the old 40 floor, with its fraction');

// CLEAR keeps only the starting tempo.
await step(() => button('Clear tempo').click());
assert.equal(shape(), '0:24.25');

// The BEND strip is a slider too: the selected point's bend in semitones at the lane's range.
await step(() => button('Bend').click());
const bendStrip = () => win.document.querySelector('[data-bend-lane] [role="slider"]') as HTMLElement | null;
assert.ok(bendStrip(), 'the bend lane is a slider');
assert.equal(bendStrip()!.getAttribute('aria-valuemin'), '-2');
assert.equal(bendStrip()!.getAttribute('aria-valuemax'), '2');
assert.equal(bendStrip()!.getAttribute('aria-valuenow'), '0');
assert.equal(bendStrip()!.getAttribute('aria-valuetext'), 'No point selected');
await step(() => { roll().addBendPoint(roll().activeLane, { step: 18, value: 0.5, shape: 'linear' }); });
await step(() => { key(bendStrip()!, 'Home'); });
assert.equal(bendStrip()!.getAttribute('aria-valuenow'), '1', 'half the 2-semitone range');
assert.equal(bendStrip()!.getAttribute('aria-valuetext'), '+1.00 st at bar 2, step 3, LINE');
await step(() => { key(bendStrip()!, 'ArrowUp'); });
assert.equal(bendStrip()!.getAttribute('aria-valuenow'), '1.1', 'the arrow key moves it, and the value follows');

// The VELOCITY strip is a vertical slider over the selected notes' velocity.
const velStrip = win.document.querySelector('[data-velocity-lane] [role="slider"]') as HTMLElement;
assert.ok(velStrip, 'the velocity lane is a slider');
assert.equal(velStrip.getAttribute('aria-orientation'), 'vertical');
assert.equal(velStrip.getAttribute('aria-valuemin'), '1');
assert.equal(velStrip.getAttribute('aria-valuemax'), '127');
assert.equal(velStrip.getAttribute('aria-valuenow'), '90');
assert.equal(velStrip.getAttribute('aria-valuetext'), 'None selected; the notes average velocity 90');
await step(() => roll().setSelection(['a']));
assert.equal(velStrip.getAttribute('aria-valuetext'), 'Velocity 90, 1 selected');
await step(() => { key(velStrip, 'ArrowUp'); });
assert.equal(velStrip.getAttribute('aria-valuenow'), '91', 'the arrow key moves it, and the value follows');

await step(() => root.unmount());
console.log('TempoLane: ok');
