/**
 * Mount test for the Vocal2MIDI column (Vocal2MidiPanel).
 *
 * The sequence a user makes: a recording sits in the column's history, the user
 * clicks its load key, then the +1 transpose key. The roll takes the take at the
 * recording's own tempo, 97.3 BPM with its fraction, and every note at the tick
 * it was sung on, a 128th note included; +1 moves every pitch up a semitone and
 * leaves the ticks and the tempo where they were. The column reaches the roll
 * through rollBridge.applyVocalNotesToRoll, whose own test does not go through
 * the panel, so a panel that passed the wrong tempo or the unprocessed notes
 * would pass that test.
 *
 * Client-rendered (createRoot on jsdom), in the RollPlayhead.test.tsx pattern.
 *
 *   cd frontend && npx tsx src/components/audio/vocal2midi/Vocal2MidiPanel.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// Imported before the jsdom globals exist: state/playerStore guards a Vite-only
// `import.meta.env.DEV` read behind `typeof window !== 'undefined'`, so it stays
// unread (the MixerStrips.b12.test.tsx order).
const { Vocal2MidiPanel } = await import('./Vocal2MidiPanel.tsx');
const { usePianoRollStore } = await import('../../../state/pianoRollStore.ts');

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
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

// One recording in the column's history, at 97.3 BPM: an 8th, a 32nd, a 64th
// and a 128th, each start and length given in seconds at that tempo.
const BPM = 97.3;
const TICKS_PER_SEC = (BPM / 60) * 960;
const SUNG = [
  { midiNote: 60, tick: 0, ticks: 480 },
  { midiNote: 62, tick: 480, ticks: 120 },
  { midiNote: 64, tick: 600, ticks: 60 },
  { midiNote: 65, tick: 720, ticks: 30 },
];
win.localStorage.setItem('vocal2midi_recordings', JSON.stringify([{
  id: 'rec_1',
  timestamp: 1,
  name: 'Recording 1',
  notes: SUNG.map((n) => ({ midiNote: n.midiNote, startTime: n.tick / TICKS_PER_SEC, duration: n.ticks / TICKS_PER_SEC, velocity: 100 })),
  bpm: BPM,
  rootNote: 60,
  scale: 'Chromatic',
  genre: 'None',
  profileId: 'DEFAULT',
}]));

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const roll = () => usePianoRollStore.getState();
const step = (fn: () => void) => act(async () => { fn(); });
const button = (name: string): HTMLButtonElement => {
  const hit = [...host.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);
  assert.ok(hit, `the column shows a "${name}" key`);
  return hit as HTMLButtonElement;
};
const heard = () => roll().notes.map((n) => ({ midiNote: n.note, tick: n.tick, ticks: n.ticks })).sort((a, b) => a.tick! - b.tick!);

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);

await step(() => usePianoRollStore.setState({ bpm: 120 }));
await step(() => root.render(<Vocal2MidiPanel />));

// History lists the recording behind its header; open it, then load the take.
const history = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Recording History'));
if (history && history.getAttribute('aria-expanded') === 'false') await step(() => history.click());
await step(() => button('Load Recording 1').click());

assert.equal(roll().bpm, BPM, 'the roll plays the take at the recording\'s own 97.3 BPM');
assert.deepEqual(heard(), SUNG, 'every note lands at the tick it was sung on, the 128th note at 30 ticks');

// +1: every pitch a semitone up, at the same ticks and the same tempo.
await step(() => button('+1').click());
assert.equal(roll().bpm, BPM, 'transposing keeps the tempo');
assert.deepEqual(heard(), SUNG.map((n) => ({ ...n, midiNote: n.midiNote + 1 })), 'transposing moves pitch only');

await step(() => root.unmount());
console.log('Vocal2MidiPanel: ok');
