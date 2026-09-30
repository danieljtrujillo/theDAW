/**
 * Picking a language in SING writes it onto the lyrics document, where the
 * backend reads it: STUDY analyses a "la" document by the Latin rules and
 * ALIGN folds its macrons for the aligner. Before this, the picker only
 * remembered itself in localStorage and the document stayed English.
 *
 * Real store, fake `fetch` that records the PUT.
 */
import assert from 'node:assert/strict';
import { SING_LANGUAGES, useLyricsStore } from './lyricsStore.ts';
import type { LyricsDoc } from '../lib/lyricsClient.ts';

const GALLIA = 'Gallia est omnis dīvīsa in partēs trēs';

const doc = (language: string): LyricsDoc => ({
  version: 1,
  entry_id: 'e1',
  timing_unit: 'ms',
  language,
  source: 'manual',
  text: GALLIA,
  offset_ms: 0,
  lines: [],
  stats: null,
  updated_at: 0,
});

const puts: Array<Record<string, unknown>> = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  if (/^\/api\/lyrics\/e1$/.test(url) && init?.method === 'PUT') {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    puts.push(body);
    return new Response(JSON.stringify(doc(String(body.language ?? 'en'))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

// The picker offers Latin.
assert.ok(SING_LANGUAGES.some(([code, label]) => code === 'la' && label === 'Latin'), 'Latin is in the list');

// A pasted Latin lyric starts as an English document (the text PUT's default).
useLyricsStore.setState({ entryId: 'e1', doc: doc('en'), dirty: false, language: 'auto' });

// Picking Latin marks the document dirty with the new language and saves it.
useLyricsStore.getState().setLanguage('la');
assert.equal(useLyricsStore.getState().language, 'la', 'the picker remembers Latin');
assert.equal(useLyricsStore.getState().doc?.language, 'la', 'the document now says Latin');
await useLyricsStore.getState().flush();
assert.equal(puts.length, 1, 'one save went out');
assert.equal(puts[0].language, 'la', 'and it carried the language');
assert.equal(useLyricsStore.getState().doc?.language, 'la', 'the saved copy keeps it');
assert.equal(useLyricsStore.getState().dirty, false);

// Auto-detect is a whisper setting, so it leaves the document's language alone.
useLyricsStore.getState().setLanguage('auto');
assert.equal(useLyricsStore.getState().doc?.language, 'la', '"auto" does not rewrite the document');
assert.equal(useLyricsStore.getState().dirty, false, 'and saves nothing');

// Picking the language the document already has saves nothing either.
useLyricsStore.getState().setLanguage('la');
assert.equal(useLyricsStore.getState().dirty, false);

// With no document open the pick is only remembered for the next ALIGN.
useLyricsStore.setState({ entryId: null, doc: null, dirty: false });
useLyricsStore.getState().setLanguage('en');
assert.equal(useLyricsStore.getState().language, 'en');
assert.equal(useLyricsStore.getState().doc, null);

console.log('lyricsStore.language: ok');
