/**
 * Mount test for the piano roll's MARKER ROW and MARKS jump list
 * (RollMarkers.tsx), in the mounted MIDI tab, against the real roll store.
 *
 * The sequence a user makes: a double-click on the row under the ruler adds a
 * section on the bar line before the pointer and opens its name field; typing a
 * name and Enter keeps it. A click on the flag jumps the playhead there. The
 * arrow keys move it a bar (Shift a step), F2 opens the name field and Escape
 * leaves the name alone, and a drag moves it to the nearest bar line as one
 * undo step. MARKS opens the jump list: +MOVEMENT adds a movement at the
 * playhead's bar, the list's name field renames it, its kind picker turns a
 * section into a movement, a bar key jumps, and the remove key takes one away.
 * Delete on a flag removes that marker and leaves the selected note alone.
 * No edit removes a neighbour: a drag through other sections passes over them
 * to the next free bar line, an arrow skips their bar lines, and a double-click
 * or +SECTION in a bar that already starts with a section opens that section's
 * name (with a LOG line) and adds nothing.
 *
 * At afd27bea the roll had no marker row, no MARKS key and no markers, so the
 * first query below fails there.
 *
 * Client-rendered (createRoot on jsdom), in the TempoLane.test.tsx pattern.
 *
 *   cd frontend && npx tsx src/components/audio/RollMarkers.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { MidiPanel } = await import('../layout/MidiPanel.tsx');
const { usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const { markerStep } = await import('../../lib/rollMarkers.ts');
const { useLogStore } = await import('../../state/logStore.ts');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
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
Object.defineProperty(win.HTMLElement.prototype, 'offsetParent', { get(this: HTMLElement) { return this.parentElement; }, configurable: true });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const roll = () => usePianoRollStore.getState();
const step = (fn: () => void | Promise<void>) => act(async () => { await fn(); });
/** Longer than the roll's 300 ms undo coalescing: a person's next edit. */
const pause = () => act(async () => { await new Promise((done) => setTimeout(done, 350)); });
const frame = () => act(async () => { await new Promise((done) => setTimeout(done, 40)); });
const STEP_PX = 16; // the MIDI tab's default step width
const row = () => win.document.querySelector('[data-roll-markers]') as HTMLElement | null;
const flags = () => [...win.document.querySelectorAll<HTMLButtonElement>('[data-roll-marker]')];
const flagNamed = (name: string) => flags().find((f) => f.textContent === name);
const byLabel = (label: string) =>
  [...win.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label);
const valueSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
const selectSetter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!;
const type = (el: HTMLInputElement, text: string) => {
  valueSetter.call(el, text);
  el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text.slice(-1) }));
};
const key = (el: HTMLElement, k: string, shiftKey = false) =>
  el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true, cancelable: true }));
const pointer = (el: HTMLElement, kind: string, clientX: number, shiftKey = false) =>
  el.dispatchEvent(new win.MouseEvent(kind, { bubbles: true, button: 0, clientX, shiftKey }));
const shape = () => roll().markers.map((m) => `${m.kind === 'movement' ? 'M' : 'S'}:${m.name}@${markerStep(m)}`).join(' ');
/** Every text field and select on the page has a label that names it by id. */
const assertLabelled = () => {
  for (const el of win.document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-roll-markers] input, #roll-marker-list input, #roll-marker-list select')) {
    assert.ok(el.id && el.name, `${el.outerHTML.slice(0, 60)} has an id and a name`);
    assert.ok(win.document.querySelector(`label[for="${el.id}"]`), `${el.id} has a label`);
  }
};

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => {
  roll().setEditingClip(null);
  roll().applyMeter({ meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0 });
  roll().importNotes([{ id: 'a', note: 60, step: 0, length: 4, velocity: 90 }], 120, undefined, [], undefined, { markers: [] });
  usePianoRollStore.setState({ totalSteps: 128 });
});
await step(() => root.render(<MidiPanel />));

// The row is under the ruler, and MARKS sits level with it in the keyboard column.
assert.ok(row(), 'the marker row is mounted');
assert.equal(row()!.getAttribute('role'), 'group');
const marks = byLabel('Markers: none yet. Open the jump list');
assert.ok(marks, 'the MARKS key names what it opens');
assert.equal(marks!.getAttribute('aria-haspopup'), 'dialog');
assert.equal(marks!.getAttribute('aria-expanded'), 'false');
assert.equal(marks!.getAttribute('aria-controls'), 'roll-marker-list');
assert.equal(flags().length, 0);

// A double-click at step 40 adds a section on bar 3's line (step 32) and opens its name field.
await step(() => { row()!.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, clientX: 40 * STEP_PX })); });
assert.equal(shape(), 'S:A@32');
const rename = win.document.querySelector<HTMLInputElement>('[data-roll-markers] input');
assert.ok(rename, 'the name field is open');
assertLabelled();
await step(() => { type(rename!, 'Exposition'); });
await step(() => { key(rename!, 'Enter'); });
assert.equal(shape(), 'S:Exposition@32');
await frame();
const expo = flagNamed('Exposition');
assert.ok(expo, 'the flag shows its name');
assert.equal(expo!.getAttribute('aria-label'), 'Section Exposition, bar 3');
assert.match(expo!.className, /text-\[12px\]/, 'the flag reads at 12px');

// A click jumps the playhead to the marker.
await step(() => roll().seek(90));
await step(() => { pointer(expo!, 'pointerdown', 32 * STEP_PX); pointer(expo!, 'pointerup', 32 * STEP_PX); expo!.click(); });
assert.equal(roll().currentStep, 32, 'the playhead is on the marker');
assert.equal(expo!.getAttribute('aria-current'), 'true', 'the flag holding the playhead says so');

// Keys: a bar right, a step left with Shift, F2 opens the name and Escape keeps it.
await pause();
await step(() => { expo!.focus(); key(expo!, 'ArrowRight'); });
assert.equal(shape(), 'S:Exposition@48');
await pause();
await step(() => { key(flagNamed('Exposition')!, 'ArrowLeft', true); });
assert.equal(shape(), 'S:Exposition@47');
await step(() => { key(flagNamed('Exposition')!, 'F2'); });
const f2 = win.document.querySelector<HTMLInputElement>('[data-roll-markers] input');
assert.ok(f2, 'F2 opens the name field');
await step(() => { type(f2!, 'Something else'); key(f2!, 'Escape'); });
assert.equal(shape(), 'S:Exposition@47', 'Escape keeps the name');
await frame();

// A drag of twenty steps lands on the nearest bar line, as one undo step.
await pause();
const beforeDrag = roll()._undo.length;
const dragged = flagNamed('Exposition')!;
await step(() => {
  pointer(dragged, 'pointerdown', 47 * STEP_PX);
  pointer(dragged, 'pointermove', 47 * STEP_PX + 5 * STEP_PX);
  pointer(dragged, 'pointermove', 47 * STEP_PX + 20 * STEP_PX);
  pointer(dragged, 'pointerup', 47 * STEP_PX + 20 * STEP_PX);
});
assert.equal(shape(), 'S:Exposition@64', 'step 67 lands on bar 5 (64)');
assert.equal(roll()._undo.length, beforeDrag + 1, 'the drag is one undo step');
await step(() => roll().undo());
assert.equal(shape(), 'S:Exposition@47', 'undo puts it back');
await step(() => roll().redo());
assert.equal(roll().currentStep, 32, 'a drag moves no playhead');

// MARKS: the jump list.
await step(() => marks!.click());
assert.equal(marks!.getAttribute('aria-expanded'), 'true');
const list = () => win.document.getElementById('roll-marker-list');
assert.ok(list(), 'the jump list opens');
assert.equal(list()!.getAttribute('role'), 'dialog');
await pause();
await step(() => byLabel("Add a movement marker at the playhead's bar")!.click());
assert.equal(shape(), 'M:I@32 S:Exposition@64', "a movement named I on the playhead's bar");
assertLabelled();
const nameField = win.document.getElementById(`roll-marker-name-${roll().markers[0].id}`) as HTMLInputElement;
await pause();
await step(() => { type(nameField, 'I. Allegro'); nameField.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true })); });
assert.equal(shape(), 'M:I. Allegro@32 S:Exposition@64');
// The bar key jumps.
await step(() => roll().seek(0));
await step(() => byLabel('Jump to Section Exposition, bar 5')!.click());
assert.equal(roll().currentStep, 64);
// Next and previous around the playhead.
await step(() => byLabel('Previous marker: Movement I. Allegro, bar 3')!.click());
assert.equal(roll().currentStep, 32);
// The kind picker turns the section into a movement.
await pause();
const kind = win.document.getElementById(`roll-marker-kind-${roll().markers[1].id}`) as HTMLSelectElement;
await step(() => { selectSetter.call(kind, 'movement'); kind.dispatchEvent(new win.Event('change', { bubbles: true })); });
assert.equal(shape(), 'M:I. Allegro@32 M:Exposition@64');
await pause();
await step(() => byLabel('Remove the movement Exposition')!.click());
assert.equal(shape(), 'M:I. Allegro@32');
await step(() => roll().undo());
assert.equal(shape(), 'M:I. Allegro@32 M:Exposition@64', 'undo brings the removed marker back');
await step(() => marks!.click());
assert.equal(marks!.getAttribute('aria-expanded'), 'false');

// Delete on a flag removes that marker, and not the selected note.
await step(() => roll().setSelectedNote('a'));
await pause();
const allegro = flagNamed('I. Allegro')!;
await step(() => { allegro.focus(); key(allegro, 'Delete'); });
assert.equal(shape(), 'M:Exposition@64');
assert.equal(roll().notes.length, 1, 'the selected note stays');

// No edit removes a neighbour. Three sections a bar apart: Intro, Theme, Bridge.
await pause();
await step(() => roll().setMarkers([
  { id: 'intro', step: 0, name: 'Intro', kind: 'section' },
  { id: 'theme', step: 16, name: 'Theme', kind: 'section' },
  { id: 'bridge', step: 32, name: 'Bridge', kind: 'section' },
]));
await frame();
assert.equal(shape(), 'S:Intro@0 S:Theme@16 S:Bridge@32');
// Intro dragged through Theme's bar line and on: it passes over Theme and Bridge and lands on the next free bar line.
await pause();
const intro = flagNamed('Intro')!;
await step(() => {
  pointer(intro, 'pointerdown', 0);
  pointer(intro, 'pointermove', 16 * STEP_PX);
  pointer(intro, 'pointermove', 20 * STEP_PX);
  pointer(intro, 'pointermove', 34 * STEP_PX);
  pointer(intro, 'pointermove', 44 * STEP_PX);
  pointer(intro, 'pointerup', 44 * STEP_PX);
});
assert.equal(shape(), 'S:Theme@16 S:Bridge@32 S:Intro@48', 'Theme and Bridge are still there');
await step(() => roll().undo());
assert.equal(shape(), 'S:Intro@0 S:Theme@16 S:Bridge@32', 'the drag was one undo step');
// The right arrow on Theme skips Bridge's bar line and lands on the next free one.
await pause();
await frame();
await step(() => { const t = flagNamed('Theme')!; t.focus(); key(t, 'ArrowRight'); });
assert.equal(shape(), 'S:Intro@0 S:Bridge@32 S:Theme@48');
await pause();
await step(() => { key(flagNamed('Theme')!, 'ArrowLeft'); });
assert.equal(shape(), 'S:Intro@0 S:Theme@16 S:Bridge@32', 'back left, past Bridge again');
// A double-click inside Bridge's bar opens Bridge's name and adds nothing.
await pause();
await step(() => { row()!.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, clientX: 36 * STEP_PX })); });
assert.equal(shape(), 'S:Intro@0 S:Theme@16 S:Bridge@32', 'Bridge keeps its name');
const bridgeName = win.document.querySelector<HTMLInputElement>('[data-roll-markers] input');
assert.ok(bridgeName, 'the name field opens');
assert.equal(bridgeName!.value, 'Bridge', 'on the section already there');
await step(() => { key(bridgeName!, 'Escape'); });
// +SECTION in Bridge's bar adds nothing, points the list at Bridge and says so in the LOG.
await step(() => roll().seek(36));
await step(() => marks!.click());
const logged = useLogStore.getState().entries.length;
await step(() => byLabel("Add a section marker at the playhead's bar")!.click());
await frame();
assert.equal(shape(), 'S:Intro@0 S:Theme@16 S:Bridge@32');
assert.equal(win.document.activeElement?.id, 'roll-marker-name-bridge', "Bridge's name field has the focus");
const said = useLogStore.getState().entries.slice(logged).map((e) => e.msg).join(' ');
assert.match(said, /Bridge already starts at bar 3/);
await step(() => marks!.click());
// A caller that names the marker it adds at an occupied place renames the one there (the assistant, a script).
await pause();
let named = '';
await step(() => { named = roll().addMarker({ step: 32, kind: 'section', name: 'Bridge B' }); });
assert.equal(named, 'bridge', 'the id of the section already there');
assert.equal(shape(), 'S:Intro@0 S:Theme@16 S:Bridge B@32');
// A retype onto a place that holds one of the new kind is refused too.
await step(() => { roll().addMarker({ id: 'mv', step: 16, kind: 'movement', name: 'I' }); });
await pause();
await step(() => { roll().updateMarker('theme', { kind: 'movement' }); });
assert.equal(shape(), 'S:Intro@0 M:I@16 S:Theme@16 S:Bridge B@32', 'Theme stays a section beside movement I');

// A Shift drag moves by single steps and still passes over a neighbour: Intro pulled onto Theme's step
// lands on the free step beside it, and Theme stays.
await pause();
await frame();
await step(() => {
  const intro = flagNamed('Intro')!;
  pointer(intro, 'pointerdown', 0, true);
  pointer(intro, 'pointermove', 8 * STEP_PX, true);
  pointer(intro, 'pointermove', 16 * STEP_PX, true);
  pointer(intro, 'pointerup', 16 * STEP_PX, true);
});
assert.equal(shape(), 'S:Intro@15 M:I@16 S:Theme@16 S:Bridge B@32', 'Intro lands on step 15, beside Theme');

// The place helpers against a plain scan of every place, on rolls up to 65,536 steps: a Shift drag lands
// on the nearest free step, a Shift arrow on the next free one, and a busy roll reads few places per move.
{
  const { keyMoveStep, markerPlaceTaken, nearestFreeStep } = await import('./RollMarkers.tsx');
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let trial = 0; trial < 400; trial += 1) {
    const total = trial % 4 === 0 ? 65536 : 16 + Math.floor(rand() * 240);
    const takenSet = new Set<number>();
    const busy = Math.floor(rand() * Math.min(total, 60));
    const around = Math.floor(rand() * total);
    for (let i = 0; i < busy; i += 1) takenSet.add(Math.max(0, Math.min(total - 1, around + Math.floor((rand() - 0.5) * 40))));
    const taken = (s: number) => takenSet.has(s);
    const at = rand() * (total - 1);
    let want: number | null = null;
    for (let s = 0; s < total; s += 1) if (!taken(s) && (want === null || Math.abs(s - at) < Math.abs(want - at))) want = s;
    assert.equal(nearestFreeStep(at, total, taken, -1), want ?? -1, `nearest free step to ${at} of ${total}`);
    for (const dir of [-1, 1] as const) {
      let next: number | null = null;
      for (let s = 0; s < total; s += 1) {
        if (taken(s) || (dir > 0 ? s <= at + 1e-9 : s >= at - 1e-9)) continue;
        if (next === null || (dir > 0 ? s < next : s > next)) next = s;
      }
      assert.equal(keyMoveStep([], at, dir, true, total, taken), next ?? at, `next free step ${dir > 0 ? 'after' : 'before'} ${at}`);
    }
  }
  // The taken test reads the roll's markers once: same kind, another marker, the same tick.
  const marks: Parameters<typeof markerPlaceTaken>[0] = [
    { id: 'a', tick: 0, name: 'A', kind: 'section' },
    { id: 'b', tick: 240 * 16, name: 'B', kind: 'section' },
    { id: 'i', tick: 240 * 16, name: 'I', kind: 'movement' },
  ];
  const forA = markerPlaceTaken(marks, { id: 'a', kind: 'section' });
  assert.deepEqual([forA(0), forA(16), forA(15)], [false, true, false], 'its own place is free, B is taken');
  const forI = markerPlaceTaken(marks, { id: 'i', kind: 'movement' });
  assert.equal(forI(0), false, 'a section does not take a movement place');
  // A 65,536-step roll with 64 sections packed round the pointer: the search reads a few hundred places at most.
  let reads = 0;
  const packed = new Set(Array.from({ length: 64 }, (_, i) => 32000 + i));
  const counted = (s: number) => { reads += 1; return packed.has(s); };
  assert.equal(nearestFreeStep(32010.4, 65536, counted, -1), 31999);
  assert.ok(reads < 200, `a Shift drag move read ${reads} places`);
}

await step(() => root.unmount());
console.log('RollMarkers: ok');
