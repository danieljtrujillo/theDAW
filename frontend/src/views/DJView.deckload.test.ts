/**
 * The DJ deck-load effect — a library lookup never rewinds, reloads or ejects
 * a playing deck.
 *
 * The bug (PR #207 review): both deck-load effects re-ran on every
 * `lookupVersion` bump, i.e. whenever ANY single-entry lookup landed, and
 * called `djEngine.loadDeck` each time. A playing deck stopped at 0:00; and
 * while the deck's own entry was unresolved (its lookup in flight, or
 * `libraryStore.refresh()` had just cleared the id cache) the effect passed a
 * null URL and ejected the deck mid-set.
 *
 * The effects now run `syncDeckToEntry` and nothing else, so these cases call
 * it at every point the old effect re-ran (each lookup landing), against the
 * real library store and the real engine on a fake AudioContext. That is a
 * stricter schedule than the new effect keeps: it re-runs only when the deck's
 * own entry object changes.
 *
 * Run: `npx tsx src/views/DJView.deckload.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import type { DeckId } from '../state/djEngine.ts';

// Imported with no `window`: DJView pulls in playerStore, whose module body
// reads `import.meta.env.DEV` behind a `typeof window` check, and plain tsx
// has no `import.meta.env`. The rig installs a window afterwards.
const { syncDeckToEntry, deckLoadStep } = await import('./DJView.tsx');
const djEngine = await import('../state/djEngine.ts');
const { useLibraryStore } = await import('../state/libraryStore.ts');
const { evictAll } = await import('../lib/djAudioCache.ts');
const { installDjEngineRig } = await import('../state/djEngineTestRig.ts');

const rig = installDjEngineRig(48000);
for (const id of ['x', 'y', 'z', 'p', 'q']) rig.rows.set(id, { title: `Track ${id.toUpperCase()}` });

type Held = Record<DeckId, string | null>;
const lib = () => useLibraryStore.getState();
const audioFetches = (id: string) => rig.fetches.filter((f) => f === rig.audioUrlOf(id)).length;
/** One effect run for a deck, exactly as the effect makes it. */
const run = (deck: DeckId, entryId: string | null, held: Held) =>
  syncDeckToEntry(deck, entryId, entryId ? lib().getById(entryId) ?? null : null, held);
/** A single-entry lookup for `id`: kick it the way a render does, let it land. */
const lookUp = async (id: string) => {
  lib().getById(id);
  await rig.settle();
};

let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
};

const fresh = async (): Promise<Held> => {
  await djEngine.loadDeck('A', null, null);
  await djEngine.loadDeck('B', null, null);
  evictAll();
  lib().resetPaging();
  rig.hold.clear();
  rig.page.length = 0;
  rig.fetches.length = 0;
  return { A: null, B: null };
};

/** Deck A holding `x`, loaded through the effect path and playing 40 s in. */
const playingX = async (held: Held) => {
  run('A', 'x', held);            // x is on no loaded page: the lookup goes out
  await rig.settle();              // ... and lands
  run('A', 'x', held);            // the re-run that loads it
  await rig.settle();
  djEngine.playDeck('A');
  rig.advance(40);
  assert.equal(djEngine.getStatus('A').playing, true, 'setup: deck A plays');
};

await test('a lookup for another row lands while a deck plays: the deck is untouched', async () => {
  const held = await fresh();
  await playingX(held);
  const version = lib().lookupVersion;

  await lookUp('y');               // a Sets row asked for a track on no page
  assert.ok(lib().lookupVersion > version, 'the lookup bumped lookupVersion');
  const step = run('A', 'x', held);

  assert.equal(step.kind, 'keep');
  const st = djEngine.getStatus('A');
  assert.equal(st.playing, true, 'THE BUG: the lookup stopped the playing deck');
  assert.ok(Math.abs(st.currentTime - 40) < 1e-6, `THE BUG: the deck was rewound to ${st.currentTime}s`);
  assert.equal(audioFetches('x'), 1, 'THE BUG: the deck fetched its track again');
});

await test('refresh() clears the cache, another lookup lands, then its own: the deck plays on', async () => {
  const held = await fresh();
  await playingX(held);

  // A generation finished: refresh() drops every cached row, and x is on no
  // page, so the render's getById('x') sends a lookup that is still out ...
  rig.hold.add('x');
  await lib().refresh();
  assert.equal(lib().getById('x'), undefined, 'x is unresolved again');
  // ... when a lookup for another row lands first.
  await lookUp('y');
  const whileOut = run('A', 'x', held);
  assert.equal(whileOut.kind, 'keep', 'THE BUG: an unresolved entry ejected the deck (loadDeck(null))');
  assert.equal(djEngine.getStatus('A').playing, true);
  assert.equal(djEngine.getStatus('A').loadedUrl, rig.audioUrlOf('x'));

  // Then x's own lookup lands: same URL, nothing to do.
  await rig.release('x');
  const landed = run('A', 'x', held);
  assert.equal(landed.kind, 'keep');
  const st = djEngine.getStatus('A');
  assert.equal(st.playing, true);
  assert.ok(Math.abs(st.currentTime - 40) < 1e-6, `rewound to ${st.currentTime}s`);
  assert.equal(audioFetches('x'), 1);
});

for (const firstToLand of ['q', 'p'] as const) {
  await test(`Send to DJ: both deck lookups out, ${firstToLand === 'q' ? 'B' : 'A'}'s lands first`, async () => {
    const held = await fresh();
    rig.hold.add('p');
    rig.hold.add('q');
    // The bridge put p on Deck A and q on Deck B; neither is on a page.
    run('A', 'p', held);
    run('B', 'q', held);
    assert.equal(djEngine.getStatus('A').loadedUrl, null);
    assert.equal(djEngine.getStatus('B').loadedUrl, null);

    const firstDeck: DeckId = firstToLand === 'q' ? 'B' : 'A';
    const otherDeck: DeckId = firstDeck === 'A' ? 'B' : 'A';
    const secondToLand = firstToLand === 'q' ? 'p' : 'q';

    await rig.release(firstToLand);
    // The bump re-runs both effects.
    run('A', 'p', held);
    run('B', 'q', held);
    await rig.settle();
    assert.equal(djEngine.getStatus(firstDeck).hasBuffer, true, 'the landed deck loaded');
    assert.equal(djEngine.getStatus(otherDeck).loadedUrl, null, 'the other deck waits, nothing ejected or loaded');
    djEngine.playDeck(firstDeck);
    rig.advance(8);

    await rig.release(secondToLand);
    run('A', 'p', held);
    run('B', 'q', held);
    await rig.settle();

    const playing = djEngine.getStatus(firstDeck);
    assert.equal(playing.playing, true, 'THE BUG: the second lookup restarted the deck that was playing');
    assert.ok(Math.abs(playing.currentTime - 8) < 1e-6, `rewound to ${playing.currentTime}s`);
    assert.equal(djEngine.getStatus(otherDeck).hasBuffer, true, 'the second deck loaded when its lookup landed');
    assert.equal(audioFetches('p'), 1, 'p fetched once');
    assert.equal(audioFetches('q'), 1, 'q fetched once');
  });
}

await test('a different track asked for on a playing deck stops the old one, loads the new on arrival', async () => {
  const held = await fresh();
  await playingX(held);
  rig.hold.add('z');
  // The user dropped z on Deck A; z is on no page.
  const asked = run('A', 'z', held);
  assert.equal(asked.kind, 'clear', 'the previous track does not keep playing under a new title');
  await rig.settle();
  assert.equal(djEngine.getStatus('A').playing, false);
  assert.equal(djEngine.getStatus('A').loadedUrl, null);
  await rig.release('z');
  const landed = run('A', 'z', held);
  assert.equal(landed.kind, 'load');
  await rig.settle();
  assert.equal(djEngine.getStatus('A').loadedUrl, rig.audioUrlOf('z'));
  assert.equal(djEngine.getStatus('A').hasBuffer, true);
});

await test('a failed load is retried when the entry resolves again', async () => {
  const held = await fresh();
  // The row resolves, but its audio 404s (the file moved on disk).
  rig.rows.set('gone', { title: 'Gone' });
  await lookUp('gone');
  const gone = lib().getById('gone');
  assert.ok(gone, 'setup: the row resolved');
  const missing = { ...gone, audioUrl: '/api/library/audio-missing/gone.wav' };
  syncDeckToEntry('A', 'gone', missing, held);
  await rig.settle();
  assert.equal(djEngine.getStatus('A').hasBuffer, false, 'setup: the load failed');
  // refresh() re-resolves the row as a new object, and the effect re-runs.
  const again = syncDeckToEntry('A', 'gone', { ...missing }, held);
  assert.equal(again.kind, 'load', 'a URL whose load failed is loaded again');
  await rig.settle();
  assert.equal(rig.fetches.filter((f) => f === missing.audioUrl).length, 2);
});

await test('deckLoadStep: every branch', async () => {
  const entry = { audioUrl: '/a.wav', title: 'A' };
  const step = (args: Omit<Parameters<typeof deckLoadStep>[0], 'holdsAudio'>, holdsAudio = true) =>
    deckLoadStep({ ...args, holdsAudio });
  assert.deepEqual(step({ entryId: null, entry: null, loadedEntryId: null, loadedUrl: null }), { kind: 'keep', holds: null });
  assert.deepEqual(step({ entryId: null, entry: null, loadedEntryId: 'a', loadedUrl: '/a.wav' }), { kind: 'clear', holds: null });
  assert.deepEqual(step({ entryId: 'a', entry: undefined, loadedEntryId: 'a', loadedUrl: '/a.wav' }), { kind: 'keep', holds: 'a' });
  assert.deepEqual(step({ entryId: 'b', entry: undefined, loadedEntryId: 'a', loadedUrl: '/a.wav' }), { kind: 'clear', holds: null });
  assert.deepEqual(step({ entryId: 'b', entry: undefined, loadedEntryId: null, loadedUrl: null }), { kind: 'keep', holds: null });
  assert.deepEqual(step({ entryId: 'a', entry, loadedEntryId: null, loadedUrl: '/a.wav' }), { kind: 'keep', holds: 'a' });
  assert.deepEqual(step({ entryId: 'a', entry, loadedEntryId: 'a', loadedUrl: '/a.wav' }, false), { kind: 'load', url: '/a.wav', label: 'A', holds: 'a' });
  assert.deepEqual(step({ entryId: 'a', entry, loadedEntryId: null, loadedUrl: null }), { kind: 'load', url: '/a.wav', label: 'A', holds: 'a' });
  assert.deepEqual(step({ entryId: 'a', entry: { audioUrl: '', title: 'A' }, loadedEntryId: 'a', loadedUrl: '/a.wav' }), { kind: 'clear', holds: null });
});

console.log(`\nDJView deck-load: ${passed} passed`);
