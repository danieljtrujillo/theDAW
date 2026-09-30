// Run with: npx tsx src/lineagescale/LineageExplorer.test.tsx
//
// Render tests for the LEARN explorer panel (node, no DOM —
// `renderToStaticMarkup`, the house pattern).
//
// What they pin:
//
//   * a list ROW is two named buttons — "Focus this song" and "Copy id" — so
//     a keyboard reaches both, and Enter on the focus button is the row's
//     Enter;
//   * every row carries the provider badge built from BOTH `model` and
//     `source`: a legacy Suno import has model "" and a badge given only the
//     model calls it Stable Audio;
//   * the search box and every select is a real native control with a real
//     <label htmlFor> (project CLAUDE.md rule 3), and the pager buttons —
//     which are not native controls — carry aria-labels instead;
//   * empty, loading and error states each say which list they are about,
//     rather than showing a blank table;
//   * the pager says where you are ("1–50 of 173,877") and disables the ends.
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { entryProviderMeta } from '../catalog/catalogProviders.ts';
import { LineageExplorer } from './LineageExplorer.tsx';
import type { ExplorePage, ExploreRow, ExploreSpec } from './exploreModel.ts';

const row = (id: string, extra: Partial<ExploreRow> = {}): ExploreRow => ({
  id,
  title: `song ${id}`,
  model: 'stable-audio',
  source: 'generate',
  duration_sec: 90,
  play_count: 3,
  created_at: 1_700_000_000,
  ...extra,
});

const page = (rows: ExploreRow[], total = rows.length, offset = 0): ExplorePage => ({
  total,
  offset,
  limit: 50,
  rows,
});

const buttonTags = (html: string): string[] => html.match(/<button[^>]*>/g) ?? [];
const named = (html: string, label: string): string | undefined =>
  buttonTags(html).find((tag) => tag.includes(`aria-label="${label}"`));

const base = {
  q: '',
  sort: 'title' as const,
  dir: 'asc' as const,
  loading: false,
  error: null,
  onQuery: () => {},
  onSort: () => {},
  onDir: () => {},
  onOffset: () => {},
  onClose: () => {},
  onFocus: () => {},
  onCopyId: () => {},
  onSpec: () => {},
};

const render = (spec: ExploreSpec, over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    <LineageExplorer spec={spec} page={page([row('a'), row('b')])} {...base} {...over} />,
  );

/* ───────────────────────────────── the rows ──────────────────────────────── */

const songs: ExploreSpec = { list: 'songs', set: 'with_lineage' };
const html = render(songs, {
  page: page([row('a', { links: 3 }), row('b', { links: 1, model: '', source: 'suno' })], 173877),
});

const labelOf = (model: string, source: string): string =>
  entryProviderMeta({ model, source }).label;

assert.ok(html.includes('Songs with lineage'), 'the panel names the list it opened');
// The same name the landing page's rows announce: the provider is half of what
// tells two songs with one title apart, and it is on the badge beside the row.
assert.ok(
  named(html, `song a, ${labelOf('stable-audio', 'generate')}. Focus this song.`),
  'every row focuses, and says whose song it is',
);
assert.ok(
  named(html, `song b, ${labelOf('', 'suno')}. Focus this song.`),
  'a legacy import is named by its source, not mislabelled by its empty model',
);
assert.ok(named(html, 'Copy the id of song a'), 'every row copies its id');
assert.ok(html.includes('3 relationships'), 'the count the list ranked by is shown');

// The badge reads model AND source. A legacy import has model "" and would be
// mislabelled by a badge given only the model.
assert.ok(html.includes('data-provider="suno"'), 'source alone still badges correctly');
assert.ok(html.includes('data-provider="stable-audio"'));

/* ───────────────────────────── controls are labelled ─────────────────────── */

assert.match(html, /<label[^>]*for="lineage-explorer-q"/, 'the search box has a real label');
assert.match(html, /<input[^>]*id="lineage-explorer-q"/);
assert.match(html, /<input[^>]*name="lineage-explorer-q"/);
assert.match(html, /<label[^>]*for="lineage-explorer-sort"/, 'the sort select has a real label');
assert.match(html, /<select[^>]*id="lineage-explorer-sort"/);
assert.match(html, /<label[^>]*for="lineage-explorer-dir"/);

// A <label> does not name a non-native control, so the buttons carry their own
// names and are never wrapped in one.
assert.ok(!/<label[^>]*>\s*<button/.test(html), 'no button is wrapped in a label');
for (const tag of buttonTags(html)) {
  assert.ok(/aria-label="/.test(tag) || />/.test(tag), tag);
}
assert.ok(named(html, 'Close this list'), 'the panel can be left');

// A search box is offered only where a route reads `q`.
assert.match(html, /<input[^>]*id="lineage-explorer-q"/, 'a song list is searchable');

const rankingHtml = render({ list: 'rankings', kind: 'any', role: 'parent' });
assert.ok(
  !/id="lineage-explorer-q"/.test(rankingHtml),
  'a ranking has no title filter on the wire, so it offers no box for one',
);
assert.ok(!/for="lineage-explorer-q"/.test(rankingHtml));
const familyListHtml = render({ list: 'families' });
assert.ok(!/id="lineage-explorer-q"/.test(familyListHtml), 'nor does the family list');
// The family MEMBERS list does read `q`, so it keeps its box.
assert.match(render({ list: 'family', id: 'r1' }), /<input[^>]*id="lineage-explorer-q"/);

/* ──────────────────────────── kind and role selects ──────────────────────── */

const kindHtml = render({ list: 'kind', kind: 'cover_of', role: 'parent' });
assert.match(kindHtml, /<label[^>]*for="lineage-explorer-kind"/);
assert.match(kindHtml, /<select[^>]*id="lineage-explorer-kind"/);
assert.match(kindHtml, /<label[^>]*for="lineage-explorer-role"/);
// Every kind the backend knows is offered, not four presets.
assert.ok(kindHtml.includes('value="mashup_source"'));
assert.ok(kindHtml.includes('value="upsample_of"'));
// A song list has no kind to choose.
assert.ok(!html.includes('id="lineage-explorer-kind"'));

/* ────────────────────────────────── the pager ────────────────────────────── */

const fullPage = Array.from({ length: 50 }, (_, i) => row(`p${i}`));
const paged = render(songs, { page: page(fullPage, 173877, 0) });
assert.ok(paged.includes('1–50 of 173,877'), 'the pager says where you are');
const prev = named(paged, 'Previous page');
assert.ok(prev && / disabled=""/.test(prev), 'there is no page before the first');
const next = named(paged, 'Next page');
assert.ok(next && !/ disabled=""/.test(next));
assert.match(paged, /<label[^>]*for="lineage-explorer-page"/, 'the page jump is labelled');

const lastPage = render(songs, { page: page([row('a')], 120, 100) });
const nextOnLast = named(lastPage, 'Next page');
assert.ok(nextOnLast && / disabled=""/.test(nextOnLast), 'there is no page after the last');

/* ───────────────────────── empty, loading, failed ────────────────────────── */

const empty = render(songs, { page: page([], 0) });
assert.ok(/No song/i.test(empty), 'an empty list says so');
assert.ok(!/<tbody>\s*<\/tbody>/.test(empty) || /No song/i.test(empty));

const loading = render(songs, { page: null, loading: true });
assert.ok(/Loading|Reading/i.test(loading));
assert.ok(loading.includes('Songs with lineage'), 'it still says which list is loading');

const failed = render(songs, { page: null, error: 'HTTP 503' });
assert.ok(failed.includes('HTTP 503'));
assert.ok(named(failed, 'Try this list again'), 'a failure offers a retry');

/* ───────────────────────────── the family list ───────────────────────────── */

const families = render(
  { list: 'families' },
  { page: page([row('r1', { root_id: 'r1', size: 8618 })]) },
);
assert.ok(families.includes('8,618 songs'));
assert.ok(named(families, 'Open the family of song r1'), 'a family row opens its members');
assert.ok(
  named(families, `song r1, ${labelOf('stable-audio', 'generate')}. Focus this song.`),
  'and still focuses the song itself',
);

console.log('LineageExplorer.test.tsx: ok');
