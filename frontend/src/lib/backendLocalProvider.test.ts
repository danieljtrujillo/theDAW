/**
 * The library list's media kind, and the query a COUNT is asked over.
 *
 * Pins: BackendLocalProvider.list() carries each record's `kind` onto the
 * entry, and a record without one comes back as audio; isAudioEntry treats a
 * missing kind as audio and rejects video and image. The MIDI tab's song box
 * compared `kind` to 'audio' while the provider dropped the field, so the box
 * listed nothing and MATCH could never pick a song.
 *
 * Also: `plainLibraryQuery` clears EVERY row-narrowing filter — the text, the
 * favourites toggle, the source and the provider — keeping the media kind, so
 * "how many imports are there" is never answered with "…that also match what
 * you have typed and picked".
 *
 * Run: `npx tsx src/lib/backendLocalProvider.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import { BackendLocalProvider, DEFAULT_LIBRARY_QUERY, plainLibraryQuery, type LibraryQuery } from './backendLocalProvider';
import { isAudioEntry } from '../state/libraryEntry';

// ── the plain (counting) query ───────────────────────────────────────────────
{
  const filtered: LibraryQuery = {
    q: 'amen',
    sort: 'title_asc',
    kind: 'video',
    favorite: true,
    source: 'import',
    provider: 'suno',
  };
  assert.deepEqual(plainLibraryQuery(filtered), {
    q: '',
    sort: 'title_asc',
    kind: 'video',
    favorite: null,
    source: null,
    provider: null,
  }, 'every filter cleared, the kind and the sort kept');

  // The provider is the one this had to learn: a sidebar count taken while a
  // provider was selected used to count only that provider's rows.
  assert.equal(plainLibraryQuery(filtered).provider, null);
  // Pure: the caller's query is not touched.
  assert.equal(filtered.provider, 'suno', 'the input is left alone');
  assert.deepEqual(plainLibraryQuery(DEFAULT_LIBRARY_QUERY), DEFAULT_LIBRARY_QUERY, 'an unfiltered query is already plain');
  // Every field of the query is accounted for: whatever is added to
  // LibraryQuery next has to be decided about here, not forgotten.
  assert.deepEqual(
    Object.keys(plainLibraryQuery(filtered)).sort(),
    ['favorite', 'kind', 'provider', 'q', 'sort', 'source'],
  );
}

const record = (id: string, kind?: string) => ({
  id,
  title: id,
  prompt: '',
  negative_prompt: '',
  model: 'import',
  duration: 1,
  steps: 0,
  cfg: 0,
  seed: 0,
  audio_url: `/api/library/audio/${id}`,
  audio_filename: `${id}.wav`,
  file_size_bytes: 1,
  mime_type: 'audio/wav',
  timestamp: '2026-09-14T00:00:00Z',
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  source: 'import',
  ...(kind === undefined ? {} : { kind }),
});

const realFetch = globalThis.fetch;
let requested = '';
globalThis.fetch = (async (input: RequestInfo | URL) => {
  requested = String(input);
  const body = { entries: [record('song', 'audio'), record('clip', 'video'), record('still', 'image'), record('old')] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

try {
  const entries = await new BackendLocalProvider('http://backend/api/library').list();
  assert.equal(requested, 'http://backend/api/library/entries');
  assert.deepEqual(
    entries.map((e) => [e.id, e.kind]),
    [
      ['song', 'audio'],
      ['clip', 'video'],
      ['still', 'image'],
      ['old', 'audio'],
    ],
  );
  assert.deepEqual(entries.filter(isAudioEntry).map((e) => e.id), ['song', 'old']);
} finally {
  globalThis.fetch = realFetch;
}

assert.equal(isAudioEntry({}), true);
assert.equal(isAudioEntry({ kind: undefined }), true);
assert.equal(isAudioEntry({ kind: 'audio' }), true);
assert.equal(isAudioEntry({ kind: 'video' }), false);
assert.equal(isAudioEntry({ kind: 'image' }), false);

console.log('backendLocalProvider: kind carried through, audio filter holds');
