/**
 * Mount test for the MIDI tab (MidiPanel): the song field's LOAD.
 *
 * The sequence a user makes: a song is selected in the library, the MIDI tab
 * opens with it in the song field, the user opens the field's menu (More song
 * actions) and presses Load. The panel fetches the song's vocal artifact and
 * hands its notes to the roll (lib/rollTakes.importTake): the roll takes the
 * artifact's tempo with its fraction, 97.3 BPM, and every note at the tick it
 * was sung on, a 128th note included. importTake's own test does not go
 * through the panel, so a panel that passed the wrong tempo or dropped the
 * artifact's notes would pass that test.
 *
 * Client-rendered (createRoot on jsdom), in the RollPlayhead.test.tsx pattern.
 *
 *   cd frontend && npx tsx src/components/layout/MidiPanel.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Imported before the jsdom globals exist: state/playerStore guards a Vite-only
// `import.meta.env.DEV` read behind `typeof window !== 'undefined'`, so it stays
// unread (the MixerStrips.b12.test.tsx order).
const { MidiPanel } = await import('./MidiPanel.tsx');
const { usePianoRollStore } = await import('../../state/pianoRollStore.ts');
const { useLibraryStore } = await import('../../state/libraryStore.ts');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
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

// The song's vocal artifact at 97.3 BPM: an 8th, a 32nd, a 64th and a 128th,
// each start and end given in milliseconds at that tempo.
const BPM = 97.3;
const TICKS_PER_MS = ((BPM / 60) * 960) / 1000;
const SUNG = [
  { midiNote: 60, tick: 0, ticks: 480 },
  { midiNote: 62, tick: 480, ticks: 120 },
  { midiNote: 64, tick: 600, ticks: 60 },
  { midiNote: 65, tick: 720, ticks: 30 },
];
const ARTIFACT = {
  notes: SUNG.map((n) => ({ pitch: n.midiNote, velocity: 100, start_ms: n.tick / TICKS_PER_MS, end_ms: (n.tick + n.ticks) / TICKS_PER_MS })),
  segments: [],
  timing: { tempo_bpm: BPM },
  source: { asset_id: 'song1', duration_ms: 1000 },
  lyrics: { language: 'en', text: '', source: 'none' },
  review: { reviewed: false, notes: '' },
};
const fetched: string[] = [];
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async (input: unknown) => {
    const url = String(input);
    fetched.push(url);
    if (url === '/api/vocal/metadata/song1') return new Response(JSON.stringify(ARTIFACT), { status: 200 });
    return new Response('{}', { status: 404 });
  },
});

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
const heard = () => roll().notes.map((n) => ({ midiNote: n.note, tick: n.tick, ticks: n.ticks })).sort((a, b) => a.tick! - b.tick!);

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => {
  usePianoRollStore.setState({ bpm: 120 });
  useLibraryStore.setState({ selectedEntryId: 'song1' });
});
await step(() => root.render(<MidiPanel />));

await step(() => button('More song actions').click());
await step(async () => {
  button('Load').click();
  // The fetch and its JSON resolve on later microtasks.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
});

assert.ok(fetched.includes('/api/vocal/metadata/song1'), `Load fetches the selected song's artifact (${fetched.join(', ')})`);
assert.equal(roll().bpm, BPM, 'the roll plays the artifact at its own 97.3 BPM');
assert.deepEqual(heard(), SUNG, 'every note lands at the tick it was sung on, the 128th note at 30 ticks');

await step(() => root.unmount());
console.log('MidiPanel: ok');
