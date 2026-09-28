/**
 * A rhythm run that lands reaches the DJ deck already holding the track.
 *
 * The bug (PR #207 review): `djRhythmStore.invalidateRhythm` existed but
 * nothing called it. A deck that loaded a track before its rhythm analysis
 * existed remembered the miss, and when the user then ran the analysis
 * (the Rhythm block's RUN, or `fetchRhythm(..., { run: true })` from the
 * piano roll's meter and the track menu) the deck kept drawing its grid off
 * `i % 4` until the miss aged out or the track was reloaded.
 *
 * Sequence: deck load (GET → pending, miss remembered) → a run elsewhere
 * (GET → pending, POST /run → ready) → the deck asks again and gets bars.
 *
 * Run: `npx tsx src/lib/rhythmSeed.invalidate.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { useDjRhythmStore } = await import('../state/djRhythmStore.ts');
const { fetchRhythm } = await import('./rhythmSeed.ts');

let analyzed = false;
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? 'GET'} ${url}`);
  const ready = { status: 'ready', downbeats: [0.5, 2.5, 4.5], bars: [{ start_sec: 0.5 }, { start_sec: 2.5 }] };
  if (url.endsWith('/run')) {
    analyzed = true;
    return new Response(JSON.stringify(ready), { status: 200 });
  }
  return new Response(JSON.stringify(analyzed ? ready : { status: 'pending' }), { status: 200 });
}) as typeof fetch;

// 1. The deck loads the track: nothing cached yet, the miss is remembered.
const first = await useDjRhythmStore.getState().ensureRhythm('song-1');
assert.equal(first, null);
assert.equal(useDjRhythmStore.getState().byEntry['song-1']?.ready, false, 'the miss is remembered');

// 2. The user runs the rhythm analysis elsewhere in the app.
const ran = await fetchRhythm('song-1', { run: true });
assert.equal(ran.status, 'ready');
assert.equal(useDjRhythmStore.getState().byEntry['song-1'], undefined,
  'THE BUG: the deck still holds the miss from before the run');

// 3. The deck (useDeck re-asks once its entry is forgotten) gets the bars.
const again = await useDjRhythmStore.getState().ensureRhythm('song-1');
assert.ok(again?.ready, 'the new analysis reaches the deck');
assert.deepEqual(again?.bars, [0.5, 2.5]);

// A plain read that finds the cache ready is not a re-analysis: it does not
// throw away what the deck holds.
const before = useDjRhythmStore.getState().byEntry['song-1'];
await fetchRhythm('song-1');
assert.equal(useDjRhythmStore.getState().byEntry['song-1'], before, 'a read leaves the deck alone');

// The Rhythm block's RUN button and the deck's re-ask are wired the same way.
const block = readFileSync(fileURLToPath(new URL('../components/layout/RhythmBlock.tsx', import.meta.url)), 'utf8');
assert.match(block, /\/run`, \{ method: 'POST' \}\);[\s\S]{0,300}invalidateRhythm\(entryId\);/, 'RhythmBlock invalidates after a run');
const dj = readFileSync(fileURLToPath(new URL('../views/DJView.tsx', import.meta.url)), 'utf8');
assert.ok(dj.includes('const rhythm = useDeckRhythm(entryId);'),
  'the deck reads its rhythm through useDeckRhythm, which re-asks on invalidation (djRhythmStore.deck.test.tsx)');

console.log('rhythmSeed.invalidate: ok');
