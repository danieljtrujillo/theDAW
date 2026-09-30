/**
 * T26 SCORE UI (audit fix) — meterMapEntryId + rhythmBlockDisplay
 * (LyricAnalysisPane.tsx).
 *
 * LyricStudioView.tsx mounts LyricAnalysisPane in its hosted mode with
 * `entryId={docId}` — a lyric-NOTEBOOK document id, not a library entry.
 * Gating the meter-map popover on that raw `entryId` made RhythmBlock call
 * `/api/rhythm/<docId>` for audio that does not exist and offer a RUN button
 * for nothing. The fix reads `lyricStudioStore.entryId` — the real library
 * entry the notebook doc is LINKED to, if any — and uses that instead when
 * hosted; a hosted doc with no link gets no meter map at all.
 *
 * rhythmBlockDisplay then decides what RhythmBlock actually shows once that
 * entry is looked up fresh from useLibraryStore.entries: the TRACK's own
 * title and analysis, never the pane's globally-selected `entry` (a
 * different track entirely, in hosted mode) or the notebook's own title.
 *
 * LyricAnalysisPane.tsx side-effect-imports `./sing.css`, which plain
 * Node/tsx cannot load (no CSS loader) — a `node:module` customization hook
 * (Node 20.6+) stubs `.css` imports to an empty module for just this import,
 * so the REAL component module (and so the real `meterMapEntryId`) loads,
 * rather than testing a duplicated copy of its logic.
 *
 * Run: cd frontend && npx tsx src/components/layout/sing/LyricAnalysisPane.b12.test.ts
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';

const cssStubHook = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) return { url: 'css-stub:' + specifier, shortCircuit: true };
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('css-stub:')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  return nextLoad(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(cssStubHook)}`);

const { meterMapEntryId, rhythmBlockDisplay } = await import('./LyricAnalysisPane.tsx');

// Not hosted (SingScoreView's normal SING/STUDY usage): entryId IS a real
// library entry (SingScoreView passes entry?.id), so it is used as-is.
// lyricStudioStore's link is irrelevant here regardless of its value.
assert.equal(meterMapEntryId(false, 'lib-entry-1', null), 'lib-entry-1');
assert.equal(meterMapEntryId(false, 'lib-entry-1', 'lib-entry-2'), 'lib-entry-1');
assert.equal(meterMapEntryId(false, null, 'lib-entry-2'), null);

// Hosted (LyricStudioView's LYRIC tab): entryId is a notebook doc id, never
// used directly. No link -> no meter map.
assert.equal(meterMapEntryId(true, 'doc-42', null), null);

// Hosted WITH a link (the doc was created via importFromEntry / attached via
// attachToEntry): the linked library entry is used, never the doc id.
assert.equal(meterMapEntryId(true, 'doc-42', 'lib-entry-9'), 'lib-entry-9');

console.log('LyricAnalysisPane: meterMapEntryId only offers the meter map for a real library entry, never a hosted notebook doc id');

// rhythmBlockDisplay: hosted+linked mode looks the linked entry up fresh
// (never reuses the pane's own globally-selected `entry`), and RhythmBlock
// gets the TRACK's title, never the notebook doc's.
{
  const trackEntry = { title: 'Midnight Drive', analysis: { bpm: 118, key: 'Am' } };
  const found = rhythmBlockDisplay(trackEntry, 'My Lyric Notebook');
  assert.equal(found.title, 'Midnight Drive', 'the track title, not the notebook title');
  assert.deepEqual(found.analysis, { bpm: 118, key: 'Am' });
}

// No matching library entry (a stale/deleted link — meterMapEntryId already
// keeps this off the happy path by returning null instead, but the display
// helper still has to degrade sanely if it is ever called with one anyway):
// falls back to the notebook title, then "track".
{
  assert.deepEqual(rhythmBlockDisplay(null, 'My Lyric Notebook'), { title: 'My Lyric Notebook', analysis: null });
  assert.deepEqual(rhythmBlockDisplay(null, ''), { title: 'track', analysis: null });
}

console.log('LyricAnalysisPane: rhythmBlockDisplay shows the linked track’s own title and analysis, never the notebook’s');
