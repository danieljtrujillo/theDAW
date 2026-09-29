/**
 * The LIBRARY MIDI rows menu's "All stems to piano roll" and "All stems to
 * EDIT as tracks" (LibraryView SubTabList, lib/stemMidiSet), mounted against
 * the real stores.
 *
 * The sequence: the MIDI sub-tab lists a song's full-mix MIDI and its three
 * stem MIDI rows; a right-click on any of them opens the row menu, which
 * offers both actions with the count of the song's stems. The roll action
 * opens the three stems as three parts named for their stems, the drums on
 * channel 10; the EDIT action lays them on three tracks. A song with only
 * its full-mix MIDI offers both, disabled, saying it has no stems.
 *
 * Run: `npx tsx src/views/LibraryView.stemMidi.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { encodeMidi, type MidiFileData } from '../lib/midi';

const { SubTabList } = await import('./LibraryView.tsx');
const { rollTracksOf, usePianoRollStore } = await import('../state/pianoRollStore.ts');
const { useEditorStore } = await import('../state/editorStore.ts');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'navigator']) {
  Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
}
for (const key of ['requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, (...a: unknown[]) => unknown>)[key].bind(dom.window), configurable: true, writable: true });
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const stem = (program: number, channel: number, notes: number[]): MidiFileData => ({
  ppq: 220,
  bpm: 100,
  tracks: [{ name: channel === 9 ? 'Drums' : '', programs: [{ tick: 0, channel, program }], notes: notes.map((note, i) => ({ tick: i * 220, durationTicks: 200, note, velocity: 90, channel })) }],
});
const files: Record<string, MidiFileData> = {
  s1__full: stem(4, 0, [60, 64]),
  s1__vocals_midi: stem(4, 0, [67, 69]),
  s1__bass_midi: stem(4, 0, [40, 43]),
  s1__drums_midi: stem(0, 9, [36, 38]),
};
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const id = decodeURIComponent(String(input).split('/').pop() ?? '');
  const f = files[id];
  return f ? new Response(encodeMidi(f).slice().buffer as ArrayBuffer, { status: 200 }) : new Response('{}', { status: 404 });
}) as typeof fetch;

const row = (id: string, source: string, file: string) => ({ id, source, midi_path: `D:/lib/s1/midi/${file}.mid`, engine: 'basic_pitch', parent_id: 's1' });
const byParent = {
  s1: [row('s1__full', 'full', 'full'), row('s1__vocals_midi', 'stem', 'vocals'), row('s1__bass_midi', 'stem', 'bass'), row('s1__drums_midi', 'stem', 'drums')],
  s2: [row('s2__full', 'full', 'full')],
};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const doc = document;
const root = createRoot(doc.getElementById('root')!);
const noop = () => {};
await act(async () =>
  root.render(
    <SubTabList
      byParent={byParent}
      parentTitles={{ s1: 'Night Drive', s2: 'Solo Take' }}
      kind="midi"
      placeholder="none"
      onMutated={noop}
      selectedId={null}
      onSelectParent={noop}
    />,
  ),
);

/** Right-click the row whose name is `name` in the group `n` (0-based), and give back the menu's rows. */
const openMenu = async (n: number, name: string) => {
  const rows = [...doc.querySelectorAll<HTMLElement>('[draggable="true"]')].filter((r) => r.textContent?.includes(name));
  assert.ok(rows[n], `the ${name} row`);
  await act(async () => {
    rows[n].dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  });
  return [...doc.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
};
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
};

// A stem row of Night Drive: both actions, with its three stems.
let items = await openMenu(0, 'bass');
const toRoll = items.find((b) => b.textContent?.startsWith('All stems to piano roll'));
const toEdit = items.find((b) => b.textContent?.startsWith('All stems to EDIT as tracks'));
assert.ok(toRoll && toEdit, `the menu offers both: ${items.map((b) => b.textContent).join(' | ')}`);
assert.equal(toRoll.disabled, false);
assert.ok(toRoll.textContent?.endsWith('3 stems'), 'the full mix is not counted');
await act(async () => toRoll.click());
await settle();
assert.deepEqual(rollTracksOf(usePianoRollStore.getState()).map((t) => [t.name, t.program, t.channel]), [['Vocals', 53, null], ['Bass', 33, null], ['Drums', 0, 10]]);

// From the full mix's row, the EDIT action.
useEditorStore.getState().loadProject({ tracks: [], clips: [], bpm: 120, timeSignature: { num: 4, den: 4 } });
items = await openMenu(0, 'full');
await act(async () => items.find((b) => b.textContent?.startsWith('All stems to EDIT as tracks'))!.click());
await settle();
const names = useEditorStore.getState().tracks.filter((t) => ['Vocals', 'Bass', 'Drums'].includes(t.name));
assert.equal(names.length, 3, 'three EDIT tracks, one a stem');
assert.equal(names.find((t) => t.name === 'Drums')?.isPercussion, true);

// A song with only its full mix: both are offered, off, saying why.
items = await openMenu(1, 'full');
const off = items.filter((b) => b.textContent?.startsWith('All stems'));
assert.equal(off.length, 2);
assert.equal(off.every((b) => b.disabled && b.textContent?.endsWith('no stems')), true);

await act(async () => root.unmount());
console.log('LibraryView.stemMidi: ok');
