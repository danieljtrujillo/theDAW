/**
 * waveformStyleStore — the one global "what do these colors mean, can I turn
 * them off" preference. Behavior under test: cycle order, persistence to
 * localStorage, and that a reload (a fresh module instance against the same
 * localStorage) comes back with whatever was last chosen instead of
 * resetting to 'semantic' — and survives a corrupted stored value instead of
 * throwing.
 *
 * Run: `npx tsx src/state/waveformStyleStore.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// The store reads `localStorage` at module-evaluation time (the initial
// `mode: loadMode()`), so jsdom has to be global BEFORE it is imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.localStorage = dom.window.localStorage;

const STORAGE_KEY = 'thedaw.waveformStyle.v1';
const { useWaveformStyleStore, WAVEFORM_DRAW_MODES } = await import('./waveformStyleStore.ts');

let passed = 0;
const test = (name: string, fn: () => void) => {
  (g.localStorage as Storage).clear();
  useWaveformStyleStore.setState({ mode: 'semantic' }, false);
  fn();
  passed++;
};

test('the mode ladder is exactly semantic, plain, clipping, in that order', () => {
  assert.deepEqual(WAVEFORM_DRAW_MODES, ['semantic', 'plain', 'clipping']);
});

test('cycleMode walks the ladder and wraps around', () => {
  const { cycleMode } = useWaveformStyleStore.getState();
  assert.equal(useWaveformStyleStore.getState().mode, 'semantic');
  cycleMode();
  assert.equal(useWaveformStyleStore.getState().mode, 'plain');
  cycleMode();
  assert.equal(useWaveformStyleStore.getState().mode, 'clipping');
  cycleMode();
  assert.equal(useWaveformStyleStore.getState().mode, 'semantic', 'wraps back to the start');
});

test('setMode sets any mode directly, not just the next one', () => {
  useWaveformStyleStore.getState().setMode('clipping');
  assert.equal(useWaveformStyleStore.getState().mode, 'clipping');
});

test('a chosen mode is written to localStorage under the versioned key', () => {
  useWaveformStyleStore.getState().setMode('plain');
  assert.equal((g.localStorage as Storage).getItem(STORAGE_KEY), 'plain');
});

// A cache-busted re-import is a genuinely fresh module instance, so this
// exercises the real `loadMode()` path at import time, not a simulation.
{
  (g.localStorage as Storage).clear();
  (g.localStorage as Storage).setItem(STORAGE_KEY, 'clipping');
  const fresh = await import(`./waveformStyleStore.ts?fresh-reload-${Date.now()}`);
  assert.equal(fresh.useWaveformStyleStore.getState().mode, 'clipping', 'a fresh module instance reads back what was last persisted');
  passed++;
}

{
  (g.localStorage as Storage).clear();
  (g.localStorage as Storage).setItem(STORAGE_KEY, 'rainbow');
  const fresh = await import(`./waveformStyleStore.ts?fresh-garbage-${Date.now()}`);
  assert.equal(fresh.useWaveformStyleStore.getState().mode, 'semantic', 'a corrupted stored value falls back to semantic instead of throwing');
  passed++;
}

delete g.window;
console.log(`waveformStyleStore: ${passed} passed`);
