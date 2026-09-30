// Run with: npx tsx src/lineagescale/LineageScaleView.test.tsx
//
// Render tests for the lineage-at-scale views (node, no DOM —
// `renderToStaticMarkup`, the house pattern; see ProviderBadge.test.tsx).
//
// What they pin:
//
//   * the LANDING leads with the four numbers and the four ranked lists, and
//     its search box is a real labelled control — the way IN to a library too
//     big to draw;
//   * the FOCUS view draws ONE line per pair of songs, labelled with every
//     relation stored for that pair, and draws a `uses` link DASHED because a
//     mashup's sources are a cross-reference and not descent;
//   * a folded family is a BUTTON that names itself ("Covers (312) —
//     derivatives of Night Drive"), and the query it opens is that same fold;
//   * "+412 more" appears where the server said relatives were left out, and
//     the truncated notice appears when the budget was hit — the two ways this
//     view admits it is showing part of something;
//   * every node and every group is a focusable, NAMED button, and none of
//     them is wrapped in a <label> (a <label> does not name a non-native
//     control — project CLAUDE.md rule 3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { ProviderBadge } from '../components/library/ProviderBadge.tsx';
import { FocusGraph } from './FocusGraph.tsx';
import { ClassicGraphAction, GraphPane, classicPerTrackProps } from './LineageScaleView.tsx';
import { LineageLanding } from './LineageLanding.tsx';
import { RelativesPanelBody } from './RelativesPanel.tsx';
import LineageScaleView from './LineageScaleView.tsx';
import type {
  LineageSummary, NeighbourGroup, NeighbourNode, Neighbourhood, RankingRow, RelativesPage,
} from './lineageScaleClient.ts';
import { groupAccessibleName, groupHeading, relativesRequestForGroup } from './lineageScaleModel.ts';

const node = (id: string, generation: number, extra: Partial<NeighbourNode> = {}): NeighbourNode => ({
  id, title: id, model: 'stable-audio', source: 'generate', duration_sec: 0, play_count: 0,
  in_library: true, generation, ...extra,
});

/** Every `<button ...>` open tag in a rendered tree. */
const buttonTags = (html: string): string[] => html.match(/<button[^>]*>/g) ?? [];

/** Is the button with this accessible name rendered disabled? */
const isDisabled = (html: string, label: string): boolean => {
  const tag = buttonTags(html).find((t) => t.includes(`aria-label="${label}"`));
  return tag !== undefined && / disabled=""/.test(tag);
};

/* ══════════════════════════════ the landing ═══════════════════════════════ */

const summary: LineageSummary = {
  entries: 194833,
  with_lineage: 173877,
  standalone: 20652,
  links_raw: 475174,
  links_distinct: 400031,
  by_kind: { derived_from: 164779, edit_of: 140939, cover_of: 85552 },
  largest_connected: 81501,
  largest_tree: 8618,
  full_view_ok: false,
  revision: 12,
};

const ranked = (
  id: string, title: string, count: number, extra: Partial<RankingRow> = {},
): RankingRow =>
  ({ id, title, model: 'stable-audio', source: 'generate', count, detail: `${count} descendants`, ...extra });

{
  const html = renderToStaticMarkup(
    <LineageLanding
      summary={summary}
      rankings={{
        most_derived: [ranked('a', 'Night Drive', 812)],
        deepest: [ranked('b', 'Long Line', 14)],
        mashup_sources: [ranked('c', 'Welded', 96)],
        recent: [ranked('d', 'Fresh', 1)],
      }}
      loading={false}
      error={null}
      onRetry={() => {}}
      onFocus={() => {}}
      onSearch={async () => []}
    />,
  );

  // The four headline numbers, formatted for a six-figure library.
  assert.ok(html.includes('194,833'), 'the library size leads');
  assert.ok(html.includes('173,877') && html.includes('20,652'), 'with and without lineage');
  assert.ok(html.includes('400,031'), 'distinct relationships, not raw rows');
  assert.ok(html.includes('8,618'), 'the largest FAMILY');
  assert.ok(html.includes('81,501'), 'and the largest cluster, shown next to it');
  assert.ok(
    html.includes('not one family'),
    'the cluster is labelled for what it is — mashups welding unrelated trees together',
  );
  assert.ok(
    html.includes('475,174') && html.includes('400,031'),
    'the duplicate-storage fact is stated, not hidden by the merge',
  );

  // The four ranked lists, each named for assistive tech.
  for (const title of ['Most derived from', 'Deepest lineage', 'Most used in mashups', 'Recently extended']) {
    assert.ok(html.includes(`aria-label="${title}"`), `the ${title} list is a named section`);
  }
  assert.ok(html.includes('Night Drive'), 'and its rows are the songs');
  assert.ok(
    html.includes('aria-label="Night Drive, Stable Audio, 812, 812 descendants. Focus this song."'),
    'a ranked row says what it is, who made it, and what clicking it does',
  );

  // The search box is a REAL control: stable id, name, and a <label htmlFor>.
  assert.ok(html.includes('id="lineage-scale-search"'), 'the input has a stable id');
  assert.ok(html.includes('name="lineage-scale-search"'), 'and a name');
  assert.ok(html.includes('for="lineage-scale-search"'), 'and a label pointing at that id');
  assert.ok(!/<label[^>]*>\s*<(button|div)/.test(html), 'no label wraps a non-native control');

  // No picture of the library is offered, and the reason is on the page.
  assert.ok(html.includes('no single picture'), 'the landing says why there is no whole-library drawing');
}

/* ══════ a ranked row is badged, and a Suno one says Suno ═════════════════ */

{
  // The four landing lists are lists of SONGS, and every other list of songs in
  // the app says which service made each one. A ranked row now carries
  // `(model, source)` — the pair the badge reads — so it can say so too.
  const html = renderToStaticMarkup(
    <LineageLanding
      summary={summary}
      rankings={{
        most_derived: [
          ranked('s', 'Promoted From Suno', 3, { model: 'chirp-v4', source: 'suno' }),
          ranked('n', 'Native Generation', 2),
        ],
      }}
      loading={false} error={null} onRetry={() => {}} onFocus={() => {}} onSearch={async () => []}
    />,
  );
  assert.ok(html.includes('data-provider="suno"'), `a chirp-v4/suno row badged as: ${html}`);
  assert.ok(html.includes('data-provider="stable-audio"'), 'and a native generation still reads Stable Audio');
  assert.ok(!html.includes('data-provider="thedaw"'), 'nothing here falls to the last arm');
}

// Loading and error states.
{
  const loading = renderToStaticMarkup(
    <LineageLanding
      summary={null} rankings={{}} loading error={null}
      onRetry={() => {}} onFocus={() => {}} onSearch={async () => []}
    />,
  );
  assert.ok(loading.includes('Counting the library'), 'a first visit says what it is waiting for');
  assert.ok(loading.includes('Loading…'), 'and each ranked list says so too');

  const failed = renderToStaticMarkup(
    <LineageLanding
      summary={null} rankings={{}} loading={false} error="backend did not answer"
      onRetry={() => {}} onFocus={() => {}} onSearch={async () => []}
    />,
  );
  assert.ok(failed.includes('backend did not answer'), 'the failure is quoted, not swallowed');
  assert.ok(failed.includes('Try again'), 'and it is recoverable');

  const perList = renderToStaticMarkup(
    <LineageLanding
      summary={summary} rankings={{}} rankingErrors={{ deepest: 'ranking failed' }}
      loading={false} error={null} onRetry={() => {}} onFocus={() => {}} onSearch={async () => []}
    />,
  );
  assert.ok(perList.includes('ranking failed'), 'one broken list does not take the page down');
  assert.ok(perList.includes('194,833'), 'the rest of the page is still there');
}

/* ═══════════════════════════════ the focus view ═══════════════════════════ */

const group: NeighbourGroup = {
  id: 'g1', parent_id: 'song-7', direction: 'down', kind: 'cover_of', count: 312,
  sample_ids: ['c1', 'c2'],
};

const neighbourhood: Neighbourhood = {
  focus: 'song-7',
  nodes: [
    node('src-1', -1, { title: 'Original', duration_sec: 253, play_count: 1200 }),
    node('ghost', -1, { title: 'Ghost', in_library: false }),
    node('song-7', 0, { title: 'Night Drive', duration_sec: 240, play_count: 44 }),
    node('kid', 1, { title: 'The Stem' }),
    node('mash', 1, { title: 'A Mashup' }),
  ],
  edges: [
    // One relationship stored three times: ONE line, three names.
    { from: 'song-7', to: 'src-1', kinds: ['derived_from', 'edit_of', 'stem_of'], role: 'ancestry' },
    { from: 'kid', to: 'song-7', kinds: ['stem_of'], role: 'ancestry' },
    { from: 'song-7', to: 'ghost', kinds: ['cover_of'], role: 'ancestry' },
    // A mashup USES this song: a cross-reference, not descent.
    { from: 'mash', to: 'song-7', kinds: ['mashup_source'], role: 'uses' },
  ],
  groups: [group],
  hidden: { 'song-7': { up: 12, down: 400 } },
  truncated: true,
  budget: 400,
};

{
  const html = renderToStaticMarkup(
    <FocusGraph data={neighbourhood} focusId="song-7" onFocusNode={() => {}} onOpenGroup={() => {}} />,
  );

  // Every song is a focusable, named button — not an SVG shape with a click
  // handler, which no keyboard and no screen reader can reach.
  assert.ok(
    html.includes('aria-label="Night Drive, the focus, 4:00, 44 plays. Focus this song."'),
    'the focus names itself as the focus',
  );
  assert.ok(
    html.includes('aria-label="Original, 1 generation up, 4:13, 1,200 plays. Focus this song."'),
    'a source says how far up it is',
  );
  assert.ok(
    html.includes('aria-label="The Stem, 1 generation down. Focus this song."'),
    'and a derivative how far down',
  );
  assert.ok(
    html.includes('aria-label="Ghost, 1 generation up, no longer in the library. Focus this song."'),
    'a link endpoint that is no longer an entry says so rather than pretending',
  );
  assert.ok(html.includes('aria-current="true"'), 'the focus is marked current');
  for (const id of ['src-1', 'ghost', 'song-7', 'kid', 'mash']) {
    assert.ok(html.includes(`data-node-id="${id}"`), `${id} was drawn`);
  }

  // ONE line per pair, labelled with every kind on it.
  assert.ok(
    html.includes('derived from · edit of · stem of'),
    'the three stored rows about one relationship are one labelled line',
  );
  assert.equal(
    (html.match(/derived from · edit of · stem of<\/text>/g) ?? []).length,
    1,
    'drawn once, not once per stored kind',
  );
  assert.ok(
    html.includes('<title>Night Drive — derived from · edit of · stem of — Original</title>'),
    'and hovering it says which song came from which',
  );
  assert.equal((html.match(/<path /g) ?? []).length, 4, 'four pairs, four lines');

  // The cross-reference is dashed; descent is not.
  assert.equal(
    (html.match(/stroke-dasharray/g) ?? []).length,
    1,
    'exactly one dashed line: the mashup that USES this song',
  );
  assert.ok(html.includes('mashup source'), 'and it is labelled as such');

  // The two admissions that this is part of something bigger.
  assert.ok(html.includes('+412 more'), '12 hidden sources and 400 hidden derivatives make one badge');
  assert.ok(
    html.includes('12 more sources and 400 more derivatives of Night Drive'),
    'and the badge explains itself on hover',
  );
  assert.ok(html.includes('Budget of 400 reached'), 'hitting the budget is said out loud');
  assert.ok(html.includes('role="status"'), 'and announced, not just drawn');

  // The folded family: a named button carrying its own query.
  assert.ok(
    html.includes(`aria-label="${groupAccessibleName(group, 'Night Drive')}"`),
    'the group box says which fold it is and that it opens a list',
  );
  assert.ok(html.includes('aria-label="312 covers of Night Drive. Open the list."'));
  assert.ok(html.includes('data-group-id="g1"'));
  assert.ok(html.includes('data-group-kind="cover_of"') && html.includes('data-group-direction="down"'));
  assert.ok(html.includes('Covers (312)'), 'and it is legible without a screen reader too');

  // The whole drawing is one named region, and nothing in it is mis-labelled.
  assert.ok(
    html.includes('aria-label="Lineage around Night Drive: 5 songs, 4 relationships"'),
    'the graph names itself and its size',
  );
  assert.ok(!html.includes('<label'), 'a graph node is not a form control and is never wrapped in a label');
  for (const tag of buttonTags(html)) {
    assert.ok(/aria-label="/.test(tag), `every button is named: ${tag}`);
  }
  assert.ok(html.includes('aria-label="Zoom in"') && html.includes('aria-label="Reset the view"'));
}

// A neighbourhood that fitted in the budget makes no claim that it did not.
{
  const html = renderToStaticMarkup(
    <FocusGraph
      data={{ ...neighbourhood, truncated: false, hidden: {} }}
      focusId="song-7"
      onFocusNode={() => {}}
      onOpenGroup={() => {}}
    />,
  );
  assert.ok(!html.includes('Budget of'), 'no truncation notice when nothing was truncated');
  assert.ok(!html.includes('more<'), 'and no "+N more" badge when nothing was hidden');
}

/* ════════════════════════ the folded family, opened ═══════════════════════ */

{
  // What the group box opens: that parent, that direction, that kind, page one.
  const request = relativesRequestForGroup(group);
  assert.deepEqual(request, {
    entryId: 'song-7', direction: 'down', kind: 'cover_of', sort: 'title', offset: 0, limit: 100,
  });

  const page: RelativesPage = {
    total: 312,
    rows: [
      { id: 'c1', title: 'Cover One', model: 'stable-audio', source: 'generate', duration_sec: 61, play_count: 9, kinds: ['cover_of'] },
      { id: 'c2', title: 'Cover Two', model: 'stable-audio', source: 'generate', duration_sec: 0, play_count: 0, kinds: ['cover_of', 'edit_of'] },
    ],
  };
  const heading = groupHeading(group, 'Night Drive');
  const html = renderToStaticMarkup(
    <RelativesPanelBody
      heading={heading} request={request} page={page} loading={false} error={null}
      onSort={() => {}} onOffset={() => {}} onFocus={() => {}} onClose={() => {}} onRetry={() => {}}
    />,
  );

  assert.ok(html.includes(heading), 'the panel is headed by the fold it came from');
  assert.ok(html.includes('Showing 1–2 of 312'), 'a page of 312 says which page it is');
  assert.ok(html.includes('Cover One') && html.includes('Cover Two'), 'the page is a LIST, not more graph');
  assert.ok(
    html.includes('aria-label="Cover One, 1:01, cover of, a derivative of this song. Focus this song."'),
    'and every row is a named button back into the graph, on the side it is actually on',
  );
  assert.ok(
    html.includes('cover of · edit of · derivative'),
    'a row names every relation it has to the parent, and which side of it the row is',
  );
  assert.ok(html.includes('Covers (312) — Night Drive'), 'the panel is headed by the fold, read the right way');

  // Sorting is a real labelled select, and paging knows where it is.
  const selectId = 'lineage-scale-relatives-sort-song-7-down-cover_of';
  assert.ok(html.includes(`id="${selectId}"`), 'the sort select has a stable id');
  assert.ok(html.includes(`for="${selectId}"`), 'and a label pointing at it');
  assert.ok(html.includes('name="lineage-scale-relatives-sort"'), 'and a name');
  assert.ok(html.includes('aria-label="Previous page of relatives"'));
  assert.ok(html.includes('aria-label="Next page of relatives"'));
  // `disabled=""` is the attribute; `disabled:opacity-40` is a Tailwind class
  // on the very same tag, so the attribute is what is matched.
  assert.ok(isDisabled(html, 'Previous page of relatives'), 'there is no page before the first one');
  assert.ok(!isDisabled(html, 'Next page of relatives'), 'but there are 310 rows after these two');
  assert.ok(!/<label[^>]*>\s*<button/.test(html), 'no label wraps a button');
}

// Page two, and the far end of the list.
{
  const html = renderToStaticMarkup(
    <RelativesPanelBody
      heading="Covers (312)"
      request={{ entryId: 'song-7', direction: 'down', kind: 'cover_of', sort: 'plays', offset: 300, limit: 100 }}
      page={{ total: 312, rows: [{ id: 'c301', title: 'Last', model: 'm', source: 'generate', duration_sec: 0, play_count: 0, kinds: ['cover_of'] }] }}
      loading={false} error={null}
      onSort={() => {}} onOffset={() => {}} onFocus={() => {}} onClose={() => {}} onRetry={() => {}}
    />,
  );
  assert.ok(html.includes('Showing 301–301 of 312'), 'the last page counts from where it starts');
  assert.ok(isDisabled(html, 'Next page of relatives'), 'and there is nothing after it');
}

// Empty and failed panels.
{
  const empty = renderToStaticMarkup(
    <RelativesPanelBody
      heading="Covers (0)"
      request={{ entryId: 'x', direction: 'down', kind: 'cover_of', sort: 'title', offset: 0, limit: 100 }}
      page={{ total: 0, rows: [] }} loading={false} error={null}
      onSort={() => {}} onOffset={() => {}} onFocus={() => {}} onClose={() => {}} onRetry={() => {}}
    />,
  );
  assert.ok(empty.includes('No relatives of this kind'));
  assert.ok(empty.includes('Nothing here'), 'an empty list says so instead of showing a blank box');

  const failed = renderToStaticMarkup(
    <RelativesPanelBody
      heading="Covers (312)"
      request={{ entryId: 'x', direction: 'down', kind: 'cover_of', sort: 'title', offset: 0, limit: 100 }}
      page={null} loading={false} error="relatives: HTTP 500"
      onSort={() => {}} onOffset={() => {}} onFocus={() => {}} onClose={() => {}} onRetry={() => {}}
    />,
  );
  assert.ok(failed.includes('relatives: HTTP 500') && failed.includes('Try again'));
}

/* ═══════════ the regression, as the user would have seen it drawn ═════════ */

{
  // The real case: a song 677 mashups were built FROM. The group points DOWN
  // (made from this song), and the old label called it "Mashup sources (677)"
  // — telling the user the song has 677 sources when it has none.
  const usedIn: NeighbourGroup = {
    id: 'g-m', parent_id: 'song-7', direction: 'down', kind: 'mashup_source', count: 677,
    sample_ids: [],
  };
  const html = renderToStaticMarkup(
    <FocusGraph
      data={{ ...neighbourhood, groups: [usedIn], truncated: false, hidden: {} }}
      focusId="song-7"
      onFocusNode={() => {}}
      onOpenGroup={() => {}}
    />,
  );

  assert.ok(html.includes('Used in mashups (677)'), 'the box says what is true of this song');
  assert.ok(
    html.includes('aria-label="677 mashups use Night Drive. Open the list."'),
    'and says it in a sentence for assistive tech',
  );
  const groupTag = buttonTags(html).find((t) => t.includes('data-group-id="g-m"')) ?? '';
  assert.ok(groupTag !== '', 'the fold was drawn');
  assert.ok(
    !/sources/i.test(groupTag),
    'a song that IS the source must never be labelled as HAVING sources',
  );
  assert.ok(!html.includes('Mashup sources'), 'that phrase belongs to the other direction only');

  // And the other direction, drawn: a mashup’s own ingredients.
  const ingredients = renderToStaticMarkup(
    <FocusGraph
      data={{
        ...neighbourhood,
        groups: [{ ...usedIn, direction: 'up', count: 14 }],
        truncated: false, hidden: {},
      }}
      focusId="song-7"
      onFocusNode={() => {}}
      onOpenGroup={() => {}}
    />,
  );
  assert.ok(ingredients.includes('Mashup sources (14)'), 'where the phrase is the true one');
  assert.ok(
    ingredients.includes('aria-label="14 songs Night Drive was mashed up from. Open the list."'),
  );
}

/* ═════════════════════════════ the view itself ════════════════════════════ */

{
  // The default export is the tab view, it takes `visible`, and with nothing
  // focused it IS the landing page. (`visible={false}` so the mounted-but-
  // hidden case is the one exercised: it must still render, and fetch nothing.)
  const html = renderToStaticMarkup(<LineageScaleView visible={false} />);
  assert.ok(html.includes('id="lineage-scale-search"'), 'a fresh tab opens on the landing search');
  assert.ok(html.includes('Lineage at scale'));
  assert.ok(html.includes('No lineage summary yet.'), 'and a hidden tab has not fetched anything');
  assert.ok(!html.includes('aria-label="Back to the previously focused song"'), 'there is nothing to go back to');
}


/* ═════════════════ the graph pane: every state it can be in ═══════════════ */

const ALONE = 'This song stands alone';

{
  // A hub whose whole family is folded: ONE node, and a pile of group boxes.
  // `nodes.length <= 1` captioned this "stands alone" and never drew them.
  const folded: Neighbourhood = {
    focus: 'hub',
    nodes: [node('hub', 0)],
    edges: [],
    groups: [{
      id: 'hub|down|cover_of', parent_id: 'hub', direction: 'down',
      kind: 'cover_of', count: 800, sample_ids: ['c1'],
    }],
    hidden: {},
    truncated: false,
    budget: 400,
  };
  const html = renderToStaticMarkup(
    <GraphPane
      data={folded}
      focusId="hub"
      loading={false}
      error={null}
      onRetry={() => {}}
      onHome={() => {}}
      onFocusNode={() => {}}
      onOpenGroup={() => {}}
    />,
  );
  assert.ok(!html.includes(ALONE), 'a song with 800 folded covers does not stand alone');
  assert.ok(
    html.includes('data-group-id="hub|down|cover_of"'),
    'its group box must be on screen',
  );
  assert.ok(
    buttonTags(html).some((tag) => tag.includes(`aria-label="${groupAccessibleName(folded.groups[0], 'hub')}"`)),
    'and it is a named button',
  );

  // Truly nothing: one node, no groups, no hidden counts.
  const solo = renderToStaticMarkup(
    <GraphPane
      data={{ ...folded, groups: [] }}
      focusId="hub"
      loading={false}
      error={null}
      onRetry={() => {}}
      onHome={() => {}}
      onFocusNode={() => {}}
      onOpenGroup={() => {}}
    />,
  );
  assert.ok(solo.includes(ALONE));

  // A hidden count is a relative: not alone either.
  const withHidden = renderToStaticMarkup(
    <GraphPane
      data={{ ...folded, groups: [], hidden: { hub: { up: 0, down: 412 } } }}
      focusId="hub"
      loading={false}
      error={null}
      onRetry={() => {}}
      onHome={() => {}}
      onFocusNode={() => {}}
      onOpenGroup={() => {}}
    />,
  );
  assert.ok(!withHidden.includes(ALONE), '+412 more is 412 relatives');
}

/* ══════════ an id with a '/' is drawn, but never offered as a button ═══════ */

{
  const label = 'samples/kick 03.wav';
  const withLabel: Neighbourhood = {
    focus: 'song-1',
    nodes: [node('song-1', 0), node(label, -1, { in_library: false })],
    edges: [{ from: 'song-1', to: label, kinds: ['chimera_source_of'], role: 'uses' }],
    groups: [],
    hidden: {},
    truncated: false,
    budget: 400,
  };
  const html = renderToStaticMarkup(
    <FocusGraph data={withLabel} focusId="song-1" onFocusNode={() => {}} onOpenGroup={() => {}} />,
  );
  // Drawn, and named by the only name it has ...
  assert.ok(html.includes(label), 'the label is on screen');
  assert.ok(html.includes('data-unfocusable="true"'));
  // ... but not a button: `/{entry_id}/neighbourhood` would 404 on it.
  assert.ok(
    !buttonTags(html).some((tag) => tag.includes(`data-node-id="${label}"`)),
    'a node that can only 404 must not be clickable',
  );
  // The focus itself is still a button.
  assert.ok(buttonTags(html).some((tag) => tag.includes('data-node-id="song-1"')));

  // Not being focusable does not make its hidden relatives disappear. The
  // server counts what it left out for THIS node, and "+N more" is the only
  // thing that says the picture is partial — dropping it because the node is
  // drawn as a label rather than a button is a silently incomplete graph.
  const withHiddenLabel = renderToStaticMarkup(
    <FocusGraph
      data={{ ...withLabel, hidden: { [label]: { up: 7, down: 0 } } }}
      focusId="song-1"
      onFocusNode={() => {}}
      onOpenGroup={() => {}}
    />,
  );
  assert.ok(withHiddenLabel.includes('+7 more'), withHiddenLabel);
  assert.ok(
    withHiddenLabel.includes(`7 more sources of ${label}`),
    'and the badge still says what it stands for',
  );
}

/* ═══════ a relative's provider badge gets model AND source ════════════════ */

{
  const page: RelativesPage = {
    total: 1,
    rows: [{
      id: 'legacy', title: 'Legacy Suno Track', model: '', source: 'suno',
      duration_sec: 61, play_count: 0, kinds: ['cover_of'],
    }],
  };
  const html = renderToStaticMarkup(
    <RelativesPanelBody
      heading="Covers of Night Drive"
      request={{ entryId: 'nd', direction: 'down', kind: 'cover_of', sort: 'title', offset: 0, limit: 100 }}
      page={page}
      loading={false}
      error={null}
      onSort={() => {}}
      onOffset={() => {}}
      onFocus={() => {}}
      onClose={() => {}}
      onRetry={() => {}}
    />,
  );
  // A legacy Suno import has an empty model; badged on the model alone it
  // reads "Stable Audio" (the bug 30f8732 fixed in the catalogue).
  assert.ok(!/Stable\s*Audio/i.test(html), `badged as Stable Audio: ${html}`);
  assert.ok(/suno/i.test(html), 'the row must say Suno');
}

/* ═══════ a LANDING hit's badge: model AND source, and `chirp` is Suno ═════ */

{
  // The shape the landing's SEARCH-HIT list builds for every hit it shows
  // (LineageLanding.tsx: `<ProviderBadge entry={{ model: hit.model, source:
  // hit.source }} />`, over rows from the library's own `/entries`), and now
  // the shape `RankedList` builds too. These are the two the wire can hand it.
  const badge = (hit: { model?: string; source?: string }) =>
    renderToStaticMarkup(<ProviderBadge entry={{ model: hit.model, source: hit.source }} />);

  // T14 (2): a Suno song's model is `chirp-*` — the word "suno" is nowhere in
  // it. A hit whose `source` is missing or says something else is therefore all
  // the badge has to go on for 194,000 songs, and it read "theDAW".
  const modelOnly = badge({ model: 'chirp-v4', source: undefined });
  assert.ok(/suno/i.test(modelOnly), `chirp-v4 badged as: ${modelOnly}`);
  assert.ok(!/theDAW|Stable\s*Audio/i.test(modelOnly), modelOnly);

  // T14 (1): and when the route DOES send the column — which it now does for a
  // ranked row, as it always has for a neighbourhood node and a relatives row —
  // the source arm answers on its own, whatever the model says.
  const withSource = badge({ model: 'chirp-v4', source: 'suno' });
  assert.ok(/suno/i.test(withSource), withSource);
  assert.ok(/suno/i.test(badge({ model: '', source: 'suno' })), 'a legacy import');
}

// ── the CLASSIC graph, for the song in focus ────────────────────────────────
//
// The whole-library graph is what a 195,000-song library cannot draw. One
// song's family is a different request — bounded by the server's node cap —
// and there is no size at which it stops working. So this view, which IS the
// large-library view, offers it for whatever song is in focus.
{
  const focused = renderToStaticMarkup(<LineageScaleView rootEntryId="song-7" visible={false} />);
  assert.ok(
    focused.includes('aria-label="Classic graph for song-7"'),
    `the focused song has a named action that opens its classic graph: ${focused}`,
  );
  assert.ok(/<button[^>]*aria-label="Classic graph for song-7"/.test(focused), 'a real button');

  // The landing page has no song in focus, so there is nothing to draw.
  const landing = renderToStaticMarkup(<LineageScaleView visible={false} />);
  assert.ok(!landing.includes('Classic graph for'), 'and nothing offers it with nothing focused');

  // It is a TOGGLE, and it says which way it is: a control reporting
  // `aria-pressed` that can only ever be pressed lies to anything reading it.
  let toggled = 0;
  const closed = renderToStaticMarkup(
    <ClassicGraphAction label="Night Drive" open={false} onToggle={() => { toggled += 1; }} />,
  );
  assert.ok(closed.includes('aria-pressed="false"'), `closed: ${closed}`);
  assert.ok(closed.includes('aria-label="Classic graph for Night Drive"'));
  const opened = renderToStaticMarkup(
    <ClassicGraphAction label="Night Drive" open onToggle={() => { toggled += 1; }} />,
  );
  assert.ok(opened.includes('aria-pressed="true"'), `open: ${opened}`);
  assert.equal(toggled, 0, 'and nothing is toggled by rendering it');

  // And the view wires it BOTH ways. The button's own state is checked above;
  // this is the other half — the source-text guard the repo already uses for
  // invariants a static render cannot reach (see lineageWrapperGuards.test.ts).
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'LineageScaleView.tsx'),
    'utf8',
  );
  assert.ok(
    source.includes('onToggle={() => setClassicOpen((v) => !v)}'),
    'the action must close what it opens, or aria-pressed is a lie',
  );

  // What that action mounts: the classic modal, per-track, with the two
  // whole-library tabs refused.
  const props = classicPerTrackProps('song-7', true);
  assert.equal(props.rootEntryId, 'song-7', 'rooted at the focused song');
  assert.equal(props.wholeLibraryAllowed, false, 'and never the library-wide drawing');
  assert.equal(props.mode, 'embedded', 'inside the LEARN tab, not a modal over the app');
  assert.equal(props.open, true);
}

console.log('LineageScaleView: all assertions passed');
