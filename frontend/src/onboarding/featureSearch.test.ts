/**
 * node:assert regression for the help search's ranking. Run from `frontend/`:
 *   npx tsx src/onboarding/featureSearch.test.ts
 *
 * Two things are worth pinning. The first is that every feature is REACHABLE by
 * its own name — a registry entry nobody can find in the search box is a
 * feature the app has stopped being able to explain, and nothing about that
 * fails loudly. The second is the handful of ranking rules that are easy to
 * break by "improving" the scoring table: answering more of the question beats
 * answering one word of it loudly, question words score nothing, and a
 * two-letter workspace name survives the short-token floor.
 */
import assert from 'node:assert/strict';
import { FEATURES } from './featureRegistry';
import { featuredFeatures, searchFeatures, tokenize } from './featureSearch';

const ids = (q: string, limit = 6): string[] =>
  searchFeatures(q, limit).map((h) => h.feature.id);

// Nothing typed, nothing matched: both give an empty list, and the popover
// shows the featured entries rather than an arbitrary slice of the registry.
assert.deepEqual(searchFeatures(''), [], 'a blank query matches nothing');
assert.deepEqual(searchFeatures('   '), [], 'whitespace matches nothing');
assert.deepEqual(searchFeatures('zzzzqqq'), [], 'a nonsense query matches nothing');
assert.ok(featuredFeatures().length > 0, 'there is something to show before you type');

// Every feature answers to its own name. This is the assertion that catches a
// new entry whose name collides with an older one's alias.
for (const f of FEATURES) {
  if (f.devOnly) continue;
  assert.equal(ids(f.name)[0], f.id, `"${f.name}" finds ${f.id} first`);
}

// The reported failure: you know what it is called, you cannot find where it is.
assert.equal(ids('library')[0], 'library', 'library is the top hit for its name');
assert.equal(ids('where is the library')[0], 'library', 'question words do not change the answer');
assert.deepEqual(tokenize('where is the library'), ['library'], 'question words are dropped');

// Answering both words beats answering one of them exactly: SWAY is a
// workspace AND a dock panel, and "sway panel" means the panel.
assert.equal(ids('sway panel')[0], 'panel-sway', 'both words beat one exact name');
assert.equal(ids('sway')[0], 'sway', 'the bare name is still the workspace');

// Two-letter names survive the short-token floor.
assert.deepEqual(tokenize('dj mixer'), ['dj', 'mixer'], 'a two-letter workspace name is kept');
assert.equal(ids('dj mixer')[0], 'dj', 'DJ is found by a word its own copy does not use');
assert.equal(ids('vj')[0], 'vj', 'VJ likewise');

// A word people use for two different panels reaches both of them.
const lyricHits = ids('lyrics');
assert.ok(lyricHits.includes('panel-lyric'), 'lyrics reaches the LYRIC notepad');
assert.ok(lyricHits.includes('panel-sing'), 'lyrics reaches SING');

// A query made entirely of question words still tries, rather than going blank.
assert.deepEqual(tokenize('how do I'), ['how do i'], 'an all-noise query falls back to itself');

// Every hit actually matched something, and the limit is honoured.
for (const hit of searchFeatures('audio', 20)) {
  assert.ok(hit.hitTokens > 0, `${hit.feature.id}: a hit answered at least one word`);
  assert.ok(hit.score > 0, `${hit.feature.id}: a hit scored`);
}
assert.ok(searchFeatures('a', 3).length <= 3, 'the limit is honoured');

// Dev-only entries are never an answer to a user's question.
for (const hit of searchFeatures('xr bus', 20)) {
  assert.ok(!hit.feature.devOnly, `${hit.feature.id}: dev-only entries stay out of the results`);
}
for (const f of featuredFeatures()) {
  assert.ok(!f.devOnly, `${f.id}: dev-only entries are not offered as a starting point`);
}

console.log('featureSearch tests passed');
