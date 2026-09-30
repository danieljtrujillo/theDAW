/**
 * Library lookups that are not the LIBRARY tab's list must search the WHOLE
 * library with their own query.
 *
 * The paged store holds a few pages of the LIBRARY tab's own query. Before
 * this, the EDIT picker, the LOOM crate, the phone's library tab and the LOOM
 * reference lookup all filtered those loaded rows, so a song on page 4 — or a
 * song the LIBRARY tab's current search excludes — could not be found from
 * anywhere else. Each block below replays that: the store loads its query
 * first, then the other surface asks its own question.
 *
 * Real store, real provider, fake `fetch`.
 * Run: `npx tsx src/lib/librarySearch.test.ts`
 */
import assert from 'node:assert/strict';
import { useLibraryStore } from '../state/libraryStore.ts';
import { useLibraryCounts } from '../state/libraryCountsStore.ts';
import { LIBRARY_PAGE_SIZE } from './backendLocalProvider.ts';
import { LibrarySearchSession, filterLibraryLocally } from './librarySearch.ts';
import { entryMatchesSearch } from './librarySearchMatch.ts';
import { localCandidates, resolveEntryRef, resolveEntryRefIn } from '../state/shardIndexStore.ts';
import { describeFolderImport, importFolder } from './mediaLibrary.ts';
import { importFolderToLibrary } from './folderImport.ts';
import { useLogStore } from '../state/logStore.ts';
import type { LibraryEntry } from '../state/libraryEntry.ts';

const TOTAL = 1000;
/** The song nobody has scrolled to: page 3 of the LIBRARY tab's list. */
const FAR = 777;

const rec = (i: number): Record<string, unknown> => ({
  id: `e${i}`,
  title: i === FAR ? 'Zephyr Harbor' : `Track ${i}`,
  prompt: '',
  negative_prompt: '',
  model: 'sa3',
  duration: 10 + i,
  steps: 8,
  cfg: 1,
  seed: i,
  audio_url: `/api/library/audio/e${i}`,
  audio_filename: `${i}.wav`,
  file_size_bytes: 1000,
  mime_type: 'audio/wav',
  timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
  favorite: i % 10 === 0,
  rating: null,
  tags: [],
  notes: '',
  source: 'generate',
  ...(i === FAR ? { analysis: { bpm: 97, key: 'F#' }, embedded_tags: { artist: 'Boards' } } : {}),
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls: string[] = [];
type Handler = (url: string) => Promise<Response>;
let handler: Handler = async () => jsonResponse({}, 500);
globalThis.fetch = ((input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  calls.push(url);
  return handler(url);
}) as typeof fetch;

const isList = (url: string) =>
  url.startsWith('/api/library/entries?') || url === '/api/library/entries';

/** A paged backend: the title search stands in for the server's matcher. */
const pagedBackend: Handler = async (url) => {
  if (url.startsWith('/api/library/summary')) {
    return jsonResponse({ revision: 3, counts: { tracks: TOTAL, stems: 0, midi: 0, video: 0, score: 0 } });
  }
  const u = new URL(url, 'http://local');
  if (u.pathname === '/api/library/entries/resolve') {
    const ref = (u.searchParams.get('ref') ?? '').toLowerCase();
    return jsonResponse({ id: ref.includes('zephyr') ? `e${FAR}` : null });
  }
  if (isList(url)) {
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    const fav = u.searchParams.get('favorite') === 'true';
    const all: Record<string, unknown>[] = [];
    for (let i = 0; i < TOTAL; i += 1) {
      const r = rec(i);
      if (q && !String(r.title).toLowerCase().includes(q)) continue;
      if (fav && !r.favorite) continue;
      all.push(r);
    }
    const offset = Number(u.searchParams.get('offset') ?? '0');
    const limit = Number(u.searchParams.get('limit') ?? String(LIBRARY_PAGE_SIZE));
    return jsonResponse({ entries: all.slice(offset, offset + limit), total: all.length, offset, limit, revision: 3 });
  }
  return jsonResponse({}, 404);
};

const st = () => useLibraryStore.getState();

// ── 1. A search session answers from the backend, not the store's pages ──────
{
  handler = pagedBackend;
  st().resetPaging();
  await st().load();
  assert.equal(st().entries.length, LIBRARY_PAGE_SIZE, 'the LIBRARY tab holds page 0 only');
  assert.ok(!st().entries.some((e) => e.id === `e${FAR}`), 'the far song is on no loaded page');

  calls.length = 0;
  const session = new LibrarySearchSession({ q: 'zephyr', kind: 'audio', sort: 'favorites_first' }, { debounceMs: 0 });
  await session.start();
  const snap = session.getSnapshot();
  assert.deepEqual(snap.rows.map((r) => r.id), [`e${FAR}`], 'the session finds the song on page 3');
  assert.equal(snap.total, 1);
  const asked = new URL(calls.find(isList)!, 'http://local').searchParams;
  assert.equal(asked.get('q'), 'zephyr', "the session sent ITS query, not the LIBRARY tab's");
  assert.equal(asked.get('sort'), 'favorites_first');
  assert.equal(asked.get('kind'), 'audio');
  assert.equal(st().entries.length, LIBRARY_PAGE_SIZE, "the LIBRARY tab's pages are untouched");

  // Its own paging: an empty query is the whole library, a page at a time.
  await session.setQuery({ q: '' });
  assert.equal(session.getSnapshot().rows.length, 100);
  assert.equal(session.getSnapshot().total, TOTAL);
  await session.loadMore();
  assert.equal(session.getSnapshot().rows.length, 200, 'loadMore appends the next page');
  assert.equal(session.getSnapshot().rows[150].id, 'e150');
  session.dispose();
}

// ── 2. A text change is debounced; a superseded answer never lands ───────────
{
  handler = pagedBackend;
  calls.length = 0;
  const session = new LibrarySearchSession({ kind: 'audio' }, { debounceMs: 30 });
  await session.start();
  const firstLists = calls.filter(isList).length;
  const a = session.setQuery({ q: 'z' });
  const b = session.setQuery({ q: 'ze' });
  const c = session.setQuery({ q: 'zephyr' });
  await Promise.all([a, b, c]);
  assert.equal(calls.filter(isList).length - firstLists, 1, 'three keystrokes, one request');
  assert.deepEqual(session.getSnapshot().rows.map((r) => r.id), [`e${FAR}`]);
  session.dispose();
}

// ── 3. Against a backend that does not page, the matcher is main's ───────────
{
  const whole = Array.from({ length: 50 }, (_, i) => rec(i === 7 ? FAR : i));
  handler = async (url) => (isList(url) ? jsonResponse(whole) : jsonResponse({}, 404));
  const session = new LibrarySearchSession({ q: '97', kind: 'audio' }, { debounceMs: 0 });
  await session.start();
  // "97" is the far song's BPM; also every duration that rounds to 97 s or
  // 97 minutes -- none here but e87 (10 + 87 = 97 s).
  const ids = session.getSnapshot().rows.map((r) => r.id).sort();
  assert.deepEqual(ids, [`e${FAR}`], 'a BPM finds its song without a server');
  await session.setQuery({ q: 'boards' });
  assert.deepEqual(session.getSnapshot().rows.map((r) => r.id), [`e${FAR}`], 'an embedded artist too');
  session.dispose();
}

// ── 4. entryMatchesSearch is main's matcher, field for field ─────────────────
{
  const base = {
    id: 'x', title: 'Neon Drift', prompt: 'dusty lofi', negativePrompt: 'harsh', model: 'small-rf',
    notes: 'second verse', source: 'import', mimeType: 'audio/flac', rating: null, tags: ['chill'],
    duration: 185, analysis: { bpm: 123, key: 'Bb' }, embeddedTags: { album: 'Selected Ambient' },
  } as unknown as LibraryEntry;
  for (const q of ['neon', 'rift', 'lofi', 'harsh', 'small-rf', 'verse', 'import', 'flac', 'chill', '123', 'bb', 'ambient', '185', '3']) {
    assert.equal(entryMatchesSearch(base, q), true, q);
  }
  assert.equal(entryMatchesSearch(base, 'nothing'), false);
  assert.deepEqual(
    filterLibraryLocally([base, { ...base, id: 'y', kind: 'video' } as LibraryEntry], {
      q: 'neon', sort: 'created_desc', kind: 'audio', favorite: null, source: null, provider: null,
    }).map((e) => e.id),
    ['x'],
    'the kind narrows too',
  );
}

// ── 5. A LOOM reference resolves over the whole library ──────────────────────
{
  handler = pagedBackend;
  st().resetPaging();
  useLibraryCounts.setState({ revision: 3 });
  await st().load();
  assert.ok(!st().entries.some((e) => e.id === `e${FAR}`));
  // What 8039b45 did: look through the loaded rows only.
  assert.equal(resolveEntryRefIn('zephyr harbor', st().entries), null, 'the loaded pages cannot answer');
  calls.length = 0;
  assert.equal(await resolveEntryRef('Zephyr_Harbor.wav'), `e${FAR}`, 'the backend can');
  assert.ok(calls.some((c) => c.startsWith('/api/library/entries/resolve?ref=')));
  // An id on a loaded page is answered without a request.
  calls.length = 0;
  assert.equal(await resolveEntryRef('e5'), 'e5');
  assert.equal(calls.length, 0);
  // A backend with no resolve route falls back to the rows in hand.
  handler = async (url) => (url.startsWith('/api/library/entries/resolve') ? jsonResponse({}, 404) : pagedBackend(url));
  assert.equal(await resolveEntryRef('Track 12'), 'e12');
  // The exclusion is a resolved id now, so a crate lookup can skip it.
  assert.deepEqual(localCandidates({}, ['a'], 'a'), []);
}

// ── 6. A folder import of more than 200 files reports what it created ───────
{
  const echoed = Array.from({ length: 200 }, (_, i) => ({ id: `f${i}`, title: `File ${i}` }));
  handler = async (url) =>
    url === '/api/library/import-folder'
      ? jsonResponse({ cancelled: false, folder: 'D:/music/big', name: 'big', entries: echoed, created_total: 250 })
      : jsonResponse({}, 404);
  const res = await importFolder('D:/music/big');
  assert.equal(res.entries.length, 200, 'the backend echoes at most 200');
  assert.equal(res.created_total, 250);
  assert.equal(describeFolderImport(res), 'Added 250 tracks from D:/music/big');
  // The LIBRARY tab's action logs that number, after refreshing the list.
  handler = async (url) =>
    url === '/api/library/import-folder'
      ? jsonResponse({ cancelled: false, folder: 'D:/music/big', name: 'big', entries: echoed, created_total: 250 })
      : pagedBackend(url);
  useLogStore.getState().clear();
  calls.length = 0;
  await importFolderToLibrary();
  const logged = useLogStore.getState().entries.map((e) => `${e.level}:${e.msg}`);
  assert.deepEqual(logged, ['info:Added 250 tracks from D:/music/big']);
  assert.ok(calls.some(isList), 'the list was refreshed');
  // An older backend with no created_total still reports what it echoed.
  assert.equal(
    describeFolderImport({ cancelled: false, folder: 'D:/x', entries: echoed.slice(0, 1) }),
    'Added 1 track from D:/x',
  );
}

// ── 7. A backend from before favorites_first still answers the picker ───────
{
  // The backend has no auto-reload: a frontend that knows the new sort can be
  // talking to a backend at 8039b45, which answers 400 for it.
  handler = async (url) => {
    const u = new URL(url, 'http://local');
    if (isList(url) && u.searchParams.get('sort') === 'favorites_first') {
      return jsonResponse({ detail: "sort must be one of ['created_desc', 'title_asc'], got 'favorites_first'" }, 400);
    }
    return pagedBackend(url);
  };
  calls.length = 0;
  const session = new LibrarySearchSession({ kind: 'audio', sort: 'favorites_first' }, { debounceMs: 0, pageSize: 25 });
  await session.start();
  const snap = session.getSnapshot();
  assert.equal(snap.error, null, 'the refused sort is not shown as an error');
  assert.equal(snap.rows.length, 25);
  const sorts = calls.filter(isList).map((c) => new URL(c, 'http://local').searchParams.get('sort'));
  assert.deepEqual(sorts, ['favorites_first', 'title_asc'], 'asked once, then the fallback');
  const favs = snap.rows.filter((r) => r.favorite).length;
  assert.ok(favs > 0);
  assert.ok(snap.rows.slice(0, favs).every((r) => r.favorite), 'the favourites held come first');
  // Later pages go straight to the fallback and keep the favourites first.
  calls.length = 0;
  await session.loadMore();
  const next = session.getSnapshot();
  assert.equal(next.rows.length, 50);
  assert.deepEqual(
    calls.filter(isList).map((c) => new URL(c, 'http://local').searchParams.get('sort')),
    ['title_asc'],
  );
  const nextFavs = next.rows.filter((r) => r.favorite).length;
  assert.ok(next.rows.slice(0, nextFavs).every((r) => r.favorite));
  // Any other refusal is still an error.
  handler = async (url) => (isList(url) ? jsonResponse({ detail: 'boom' }, 500) : pagedBackend(url));
  await session.refresh();
  assert.match(session.getSnapshot().error ?? '', /boom/);
  session.dispose();
}

console.log('librarySearch: ok');
