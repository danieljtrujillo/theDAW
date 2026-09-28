/**
 * Every place a tempo is set holds the app's 20-300 BPM (lib/tempoMap), so a
 * 24 BPM Grave or a 280 BPM Presto set in one surface is not moved in
 * another. Up to afd27bea AI COMPOSE, the Gater, the Step Sequencer, Chimera's
 * target BPM, the clip-op tempo bounds (MIN_BPM/MAX_BPM) and the assistant's
 * source-BPM tool stopped at 40-240, and a .tasmo clip at 30 BPM had its notes
 * placed at 40.
 * Run from `frontend/`:
 *   npx tsx src/lib/tempoRange.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN } from './tempoMap.ts';
import { MAX_BPM, MIN_BPM, setClipSourceBpm } from './clipOps/timeline.ts';
import { composeGrid, parseComposeResponse } from './aiComposeGrid.ts';
import { getRackEffect } from './rackEffects.ts';
import { tasmoMidiNotesToPiano } from './projectImport.ts';
import { PPQ } from './noteClock.ts';
import type { AudioClip } from '../state/editorStore.ts';

assert.equal(TEMPO_BPM_MIN, 20);
assert.equal(TEMPO_BPM_MAX, 300);

// The clip-op bounds and the assistant tool that uses them.
assert.equal(MIN_BPM, 20);
assert.equal(MAX_BPM, 300);
const clip = { id: 'c', trackId: 't', start: 0, duration: 4 } as unknown as AudioClip;
for (const bpm of [20, 24, 280, 300]) {
  const r = setClipSourceBpm(clip, bpm);
  assert.ok(r.ok, `${bpm} BPM is a source tempo a clip can declare`);
}
assert.equal(setClipSourceBpm(clip, 19.9).ok, false, 'below 20 is refused');
assert.equal(setClipSourceBpm(clip, 300.1).ok, false, 'above 300 is refused');

// AI COMPOSE keeps the model's tempo inside 20-300 with its fraction.
{
  const g = composeGrid({ bars: 1, meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0 });
  const answer = (bpm: number) => JSON.stringify({ bpm, notes: [{ note: 60, step: 0, length: 4, velocity: 90 }] });
  assert.equal(parseComposeResponse(answer(24.5), g, 120, String).bpm, 24.5, 'a Grave at 24.5 stays');
  assert.equal(parseComposeResponse(answer(280), g, 120, String).bpm, 280, 'a Presto at 280 stays');
  assert.equal(parseComposeResponse(answer(400), g, 120, String).bpm, 300);
  assert.equal(parseComposeResponse(answer(5), g, 120, String).bpm, 20);
}

// The Gater's tempo-synced clock.
{
  const bpm = getRackEffect('gater')?.params.find((p) => p.key === 'bpm');
  assert.ok(bpm, 'the Gater has a BPM param');
  assert.deepEqual([bpm.min, bpm.max], [20, 300]);
}

// A .tasmo clip's notes in seconds at 30 BPM land on their ticks at 30, not 40.
{
  const [n] = tasmoMidiNotesToPiano([{ note: 60, start: 2, duration: 2, velocity: 90 }], 30);
  assert.equal(n.tick, PPQ, 'two seconds at 30 BPM is one quarter');
}

// The controls: each tempo field offers 20-300 and keeps what is typed in it.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'navigator']) {
  Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
}
g.IS_REACT_ACT_ENVIRONMENT = true;
const storage = new Map<string, string>();
Object.defineProperty(g, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) },
});
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const { AiComposePopover } = await import('../components/audio/AiComposePopover.tsx');
const { GaterControls } = await import('../components/audio/GaterControls.tsx');
const doc = dom.window.document;
const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;

{
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(AiComposePopover, { currentBpm: 120, meterMap: [], pickupSteps: 0, onGenerated: () => undefined }));
  });
  await act(async () => { (doc.querySelector('[aria-label="AI compose"]') as HTMLElement).click(); });
  const field = doc.getElementById('ai-compose-bpm') as HTMLInputElement;
  assert.ok(field, 'the AI COMPOSE card has its BPM field');
  assert.equal(doc.querySelector('label[for="ai-compose-bpm"]')?.textContent?.trim(), 'BPM');
  assert.deepEqual([field.min, field.max], ['20', '300']);
  await act(async () => {
    valueSetter.call(field, '24.5');
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.equal(field.value, '24.5', 'a typed 24.5 is kept (it was raised to 40)');
  await act(async () => { root.unmount(); });
}

{
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(GaterControls, { params: { sync: 1, bpm: 280 }, onChange: () => undefined, idPrefix: 'g' }));
  });
  const slider = host.querySelector('[aria-labelledby="g-gater-bpm"]') as HTMLElement;
  assert.ok(slider, 'the Gater BPM slider is labelled');
  assert.deepEqual([slider.getAttribute('aria-valuemin'), slider.getAttribute('aria-valuemax'), slider.getAttribute('aria-valuenow')], ['20', '300', '280']);
  await act(async () => { root.unmount(); });
}

console.log('tempoRange: ok');
