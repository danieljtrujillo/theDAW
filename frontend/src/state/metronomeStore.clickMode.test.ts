/**
 * The metronome settings a user saved load into the store with the click mode
 * and a count-in the UI offers. Settings saved before the click mode existed
 * load with quarters; a stored count-in the UI does not offer (7 bars) loads as
 * Off (at 30a3edf it loaded as 7: the count-in select showed none of its
 * choices and an EDIT play counted seven bars in); a junk mode loads as
 * quarters; a chosen mode is saved.
 * Run from `frontend/`:
 *   npx tsx src/state/metronomeStore.clickMode.test.ts
 */
import assert from 'node:assert/strict';

// The store's graph (playerStore, liveMixer) arms window listeners only in a
// browser, so it loads first; window, with the saved settings, comes after it.
await import('./playerStore.ts');
await import('./liveMixer.ts');
const saved = new Map<string, string>([
  ['thedaw-metronome', JSON.stringify({ state: { enabled: true, volume: 0.5, accent: false, countInBars: 7 }, version: 1 })],
]);
const storage = {
  getItem: (k: string) => saved.get(k) ?? null,
  setItem: (k: string, v: string) => void saved.set(k, v),
  removeItem: (k: string) => void saved.delete(k),
};
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: storage } });
const { useMetronomeStore } = await import('./metronomeStore.ts');

const s = () => useMetronomeStore.getState();
assert.equal(s().enabled, true);
assert.equal(s().volume, 0.5);
assert.equal(s().accent, false);
assert.equal(s().clickMode, 'quarter', 'settings from before the click mode load with quarters');
assert.equal(s().countInBars, 0, 'a count-in the UI does not offer loads as Off');

s().setClickMode('group');
assert.equal(JSON.parse(saved.get('thedaw-metronome') ?? '{}').state.clickMode, 'group', 'the chosen mode is saved');

saved.set('thedaw-metronome', JSON.stringify({ state: { enabled: false, volume: 0.7, accent: true, countInBars: 2, clickMode: 'swing' }, version: 1 }));
await useMetronomeStore.persist.rehydrate();
assert.equal(s().clickMode, 'quarter', 'a mode the app does not have loads as quarters');
assert.equal(s().countInBars, 2);

console.log('metronomeStore.clickMode: ok');
