// Run with: npx tsx src/lineagescale/LineageLanding.test.tsx
//
// The LEARN landing page, rendered (node, no DOM — `renderToStaticMarkup`).
//
// One rule, asserted five ways: EVERY NUMBER ON THIS PAGE OPENS A LIST.
//
//   * each headline card is a <button> whose accessible name says which list
//     it opens, and the "Songs" card opens BOTH populations it counts;
//   * each relationship-kind row is a button, so all seventeen kinds are a way
//     in and not four presets;
//   * each ranked list that generalises has a "More…" button naming the list;
//     `deepest` has none, because no ranking over a kind and a role can ask
//     for the length of a chain;
//   * the custom ranking row is two labelled <select>s and an Open button;
//   * the search box is still a real labelled control.
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { LineageLanding } from './LineageLanding.tsx';
import type { LineageSummary, RankingRow } from './lineageScaleClient.ts';

const summary: LineageSummary = {
  entries: 194833,
  with_lineage: 173877,
  standalone: 20956,
  links_raw: 475174,
  links_distinct: 400031,
  by_kind: { derived_from: 164779, edit_of: 140939, cover_of: 85552, mashup_source: 31904 },
  largest_connected: 81501,
  largest_tree: 8595,
  full_view_ok: false,
  revision: 42,
};

const rows: RankingRow[] = [
  { id: 'n1', title: 'Night Drive', model: 'stable-audio', source: 'generate', count: 312, detail: '312 covers' },
];

const html = renderToStaticMarkup(
  <LineageLanding
    summary={summary}
    rankings={{ most_derived: rows, deepest: rows, mashup_sources: rows, recent: rows }}
    loading={false}
    error={null}
    onRetry={() => {}}
    onFocus={() => {}}
    onSearch={async () => []}
  />,
);

const buttonTags = (s: string): string[] => s.match(/<button[^>]*>/g) ?? [];
const named = (label: string): string | undefined =>
  buttonTags(html).find((tag) => tag.includes(`aria-label="${label}"`));

/* ─────────────────────── every headline number opens a list ──────────────── */

// The four cards `summaryHeadlines` builds, each naming the list it opens.
assert.ok(named('Songs: 194,833. Open Songs with lineage.'), 'the song count opens its list');
assert.ok(
  named('Relationships: 400,031. Open Most relationships as the source.'),
  'the relationship count opens a ranking',
);
assert.ok(named('Largest family: 8,595. Open Families.'), 'the family number opens the families');
// A cluster is NOT a family, so that card opens the links that weld one.
assert.ok(
  named('Largest cluster: 81,501. Open Used in mashups.'),
  'the cluster number opens the mashup links behind it',
);

// The Songs card counts two populations; both are reachable.
assert.ok(named('Open Songs with lineage'), 'with-lineage is one click');
assert.ok(named('Open Songs with no lineage'), 'standalone is one click');

/* ──────────────────────── every kind row opens a list ────────────────────── */

assert.ok(
  named('derived from, 164,779 links. Open Songs derived from or songs derived from another.'),
  'a kind row opens the songs holding that kind',
);
assert.ok(buttonTags(html).some((tag) => tag.includes('aria-label="cover of, 85,552 links.')));
assert.ok(buttonTags(html).some((tag) => tag.includes('aria-label="mashup source, 31,904 links.')));

/* ───────────────────────── the presets are not the limit ─────────────────── */

assert.ok(named('Open Most relationships as the source'), 'most_derived has a More…');
assert.ok(named('Open Most mashup source links as the source'), 'mashup_sources has a More…');
// Depth is not a count of links: no generalisation, so no button that pretends.
assert.equal(
  buttonTags(html).filter((tag) => /Open Deepest/i.test(tag)).length,
  0,
  'deepest offers no More…',
);

/* ────────────────────── any kind, either way round, by hand ──────────────── */

assert.match(html, /<label[^>]*for="lineage-rankings-kind"/);
assert.match(html, /<select[^>]*id="lineage-rankings-kind"/);
assert.match(html, /<select[^>]*name="lineage-rankings-kind"/);
assert.match(html, /<label[^>]*for="lineage-rankings-role"/);
assert.match(html, /<select[^>]*id="lineage-rankings-role"/);
assert.ok(html.includes('value="upsample_of"'), 'every kind is offered, not four');
assert.ok(html.includes('value="chimera_source_of"'));
assert.ok(named('Open Most relationships as the source'));

/* ───────────────────────────── still a search box ────────────────────────── */

assert.match(html, /<label[^>]*for="lineage-scale-search"/);
assert.match(html, /<input[^>]*id="lineage-scale-search"/);
// A <label> never wraps a button: it does not name a non-native control.
assert.ok(!/<label[^>]*>\s*<button/.test(html));

console.log('LineageLanding.test.tsx: ok');
