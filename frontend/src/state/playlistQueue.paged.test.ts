/**
 * The play queue against a PAGED library (T31): `entries` is only the loaded
 * window of the result set, so a queued id routinely names a row on a page the
 * LRU has already thrown away.
 *
 * What this pins:
 *   - a queued id whose page was evicted still plays — it resolves through
 *     `getById`, then through the store's single-entry fetch (`ensureEntry`);
 *   - a queue survives eviction MID-PLAY: every advance re-resolves;
 *   - an id the library no longer has is skipped with a message in the log,
 *     never in silence, and the queue carries on with the next track.
 *
 * The library and player stores are real; only the handful of state functions
 * the queue calls are replaced, so no network and no AudioContext is touched.
 *
 * Run: `npx tsx src/state/playlistQueue.paged.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import { advanceQueue, queuedIds, startQueue, stopQueue } from './playlistQueue.ts';
import { useLibraryStore, type LibraryEntry } from './libraryStore.ts';
import { usePlayerStore } from './playerStore.ts';
import { useLogStore } from './logStore.ts';

/** An entry with only the fields the queue reads. */
const entry = (id: string): LibraryEntry =>
  ({ id, title: `Track ${id}`, audioUrl: `/api/library/audio/${id}` }) as LibraryEntry;

/** Every row the fake server holds, whether or not a page has it in hand. */
const server = new Map<string, LibraryEntry>([
  ['near', entry('near')],
  ['far', entry('far')],
  ['alsoFar', entry('alsoFar')],
]);

/** The rows a loaded page would answer for. Shrinks when a page is evicted. */
let loaded = new Set<string>(['near']);
/** Ids that reached the single-entry fetch — the evicted-page path. */
let singleFetches: string[] = [];
/** entryId per successful player load, in order. */
let played: string[] = [];

usePlayerStore.setState({
  repeatMode: 'off',
  load: async (_blob: Blob, meta: { label: string; entryId?: string }) => {
    played.push(meta.entryId ?? '');
  },
  play: () => {},
});

useLibraryStore.setState({
  getById: (id: string) => (loaded.has(id) ? server.get(id) : undefined),
  ensureEntry: async (id: string) => {
    singleFetches.push(id);
    return server.get(id) ?? null;
  },
  fetchAudioBlob: async (e: LibraryEntry) => new Blob([e.id]),
  setPlayingId: () => {},
});

const reset = (): void => {
  stopQueue();
  loaded = new Set<string>(['near']);
  singleFetches = [];
  played = [];
  useLogStore.getState().clear();
  usePlayerStore.setState({ repeatMode: 'off' });
};

/** Every log line the queue wrote, level included. */
const logged = (): string[] =>
  useLogStore.getState().entries.map((e) => `${e.level}:${e.source}:${e.msg}`);

// ───────────────────────────────────────────────────────────────────────────
// A queued id on an evicted page plays: the queue asks the store for it.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  await startQueue(['far'], 0);

  assert.deepEqual(played, ['far'], 'a row on no loaded page still plays');
  assert.deepEqual(singleFetches, ['far'], 'it was resolved through the single-entry fetch');
  assert.deepEqual(queuedIds(), ['far'], 'and the queue holds the id, not the row');
}

// ───────────────────────────────────────────────────────────────────────────
// The queue survives eviction mid-play: the NEXT track re-resolves.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  loaded = new Set(['near', 'far']);
  await startQueue(['near', 'far'], 0);
  assert.deepEqual(played, ['near'], 'the first track plays from the loaded page');

  // The user scrolls far away; the LRU drops both pages.
  loaded = new Set<string>();
  await advanceQueue();

  assert.deepEqual(played, ['near', 'far'], 'the queue advances across an evicted page');
  assert.deepEqual(singleFetches, ['far'], 'the evicted row came from the single-entry fetch');
}

// ───────────────────────────────────────────────────────────────────────────
// An id the library no longer has is skipped LOUDLY, and play carries on.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  await startQueue(['deleted', 'far'], 0);

  assert.deepEqual(played, ['far'], 'the queue skips the missing id and plays the next');
  const notices = logged().filter((line) => line.startsWith('warn:'));
  assert.equal(notices.length, 1, 'exactly one notice for the one missing track');
  assert.match(notices[0], /deleted/, 'and it names the id that could not be played');
}

// ───────────────────────────────────────────────────────────────────────────
// A queue of nothing but missing ids stops instead of spinning forever.
// ───────────────────────────────────────────────────────────────────────────
{
  reset();
  usePlayerStore.setState({ repeatMode: 'all' });
  await startQueue(['gone1', 'gone2'], 0);

  assert.deepEqual(played, [], 'nothing played');
  assert.deepEqual(queuedIds(), [], 'and a wrapping queue of dead ids stopped');
  assert.equal(
    logged().filter((line) => line.startsWith('warn:')).length,
    2,
    'each missing track is reported once',
  );
}

console.log('playlistQueue.paged: ok');
