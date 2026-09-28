/**
 * EDIT's clip instrument picker with a clip a roll part bounced in Bank 1.
 *
 * The sequence: the piano roll's Horn part (program 60, Bank 1) was saved to
 * EDIT, so its clip holds program 60 and bank 1. The clip's instrument picker
 * shows the program and a "Bank 1" label beside it. The user picks Violin: the
 * bank goes with the old program, so the clip plays Violin in bank 0 and the
 * label goes. Back on a clip with no bank, no label shows.
 *
 *   cd frontend && npx tsx src/components/audio/ClipInstrumentSelect.bank.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { ClipInstrumentSelect } = await import('./WaveformEditor.tsx');
const { useEditorStore } = await import('../../state/editorStore.ts');
const { clipVoice } = await import('../../lib/clipProgram.ts');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLSelectElement: win.HTMLSelectElement,
  Node: win.Node,
  Event: win.Event,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');

const ed = () => useEditorStore.getState();
ed().loadProject({ tracks: [], clips: [] });
const trackId = ed().addTrack({ name: 'Horn', instrumentProgram: 60 });
const clipId = ed().addClipToTrack({
  trackId,
  label: 'Horn',
  audioBlob: new Blob([new Uint8Array(4)], { type: 'audio/wav' }),
  mimeType: 'audio/wav',
  sourceDuration: 2,
  offsetIntoSource: 0,
  durationSec: 2,
  startSec: 0,
  color: '#f59e0b',
  sourceKind: 'piano-roll',
  sourcePianoRoll: [{ id: 'h1', note: 53, step: 0, length: 4, velocity: 90 }],
  sourceBpm: 120,
  instrumentProgram: 60,
  instrumentBank: 1,
  renderedProgram: 60,
  renderedBank: 1,
});
const clip = () => ed().clips.find((c) => c.id === clipId)!;
const track = () => ed().tracks.find((t) => t.id === trackId);

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
const show = () => act(async () => root.render(<ClipInstrumentSelect clip={clip()} />));

await show();
const select = host.querySelector('select') as HTMLSelectElement;
assert.ok(select, 'the picker is a select');
assert.equal(win.document.querySelector(`label[for="${select.id}"]`)?.textContent, 'Clip Horn instrument', 'with its label');
assert.equal(select.value, '60', 'on program 60');
const label = host.querySelector('[data-clip-bank]');
assert.equal(label?.textContent, 'Bank 1', 'the bank the part chose shows beside it');
assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(label?.getAttribute('class') ?? ''), 'in 12px text or larger');
assert.deepEqual(clipVoice(clip(), track(), { useSoundfont: true, activeProgram: 0 }), { program: 60, percussion: false, bank: 1 });

// Pick Violin: the bank belonged to the Horn preset, so it goes.
await act(async () => {
  select.value = '40';
  select.dispatchEvent(new win.Event('change', { bubbles: true }));
});
assert.deepEqual([clip().instrumentProgram, clip().instrumentBank], [40, undefined], 'the new program, in bank 0');
await show();
assert.equal(host.querySelector('[data-clip-bank]'), null, 'and the bank label is gone');
assert.deepEqual(clipVoice(clip(), track(), { useSoundfont: true, activeProgram: 0 }), { program: 40, percussion: false });

// The track default also drops a bank.
await act(async () => ed().updateClip(clipId, { instrumentProgram: 60, instrumentBank: 1 }));
await show();
await act(async () => {
  select.value = 'default';
  select.dispatchEvent(new win.Event('change', { bubbles: true }));
});
assert.deepEqual([clip().instrumentProgram, clip().instrumentBank], [undefined, undefined], 'the track default carries no bank');

await act(async () => root.unmount());
console.log('ClipInstrumentSelect.bank: ok');
