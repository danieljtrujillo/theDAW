// Run with: npx tsx src/lineagescale/lineageScaleModel.test.ts
//
// How a neighbourhood READS. The facts this pins are the ones the real library
// forced into the design:
//
//   * the same relationship is stored several times — a stem points at its
//     parent as derived_from AND edit_of AND stem_of — so a pair is ONE edge
//     whose label names every kind on it. Three lines between two boxes would
//     be three lies about one fact;
//   * a `uses` link (a mashup's sources) is a cross-reference, not descent, so
//     it is drawn dashed and the view never walks it;
//   * a node with 800 children becomes a box that says "Covers (312)" and
//     opens a LIST — the group is a query, and that query has to be exactly
//     the parent, that direction, that kind;
//   * Back walks the trail, and re-focusing a song already in the trail walks
//     BACK to it rather than growing the trail forever;
//   * "+412 more" is what `hidden` means, and zero hidden relatives produce no
//     badge at all rather than a "+0";
//   * and — found against the real library — a relation READS TWO WAYS, so
//     every phrase comes out of one direction-aware table. A song 677 mashups
//     were built from must never be labelled "Mashup sources (677)".
import assert from 'node:assert/strict';
import { EDGE_COLOR_BY_KIND } from '../lib/lineageInsights.ts';
import type { NeighbourEdge, NeighbourNode } from './lineageScaleClient.ts';
import {
  canGoBack, currentCrumb, edgeColorForKinds, edgeKindIsPaletted, edgeKindsLabel,
  edgeWidthForRole, focusNodeOf, formatCount, formatDuration, generationWords,
  KIND_WORDING, canFocusNode, groupAccessibleName, groupHeading, groupLabel,
  hasHiddenRelatives, hiddenAccessibleName, hiddenFor, standsAlone,
  hiddenLabel, hiddenTotal, isCrossReferenceRole, kindRows, kindSentence, kindWords, mergeEdges,
  nodeAccessibleName, nodeTitle, popCrumb, pushCrumb, relativeRowAccessibleWords, relativeRowWords,
  relativesRequestForGroup, relativesRequestForNode, summaryHeadlines,
} from './lineageScaleModel.ts';

const edge = (from: string, to: string, kinds: string[], role: NeighbourEdge['role'] = 'ancestry'): NeighbourEdge =>
  ({ from, to, kinds, role });

const node = (id: string, generation: number, extra: Partial<NeighbourNode> = {}): NeighbourNode => ({
  id, title: id, model: 'm', source: 'generate', duration_sec: 0, play_count: 0,
  in_library: true, generation, ...extra,
});

// ── one edge per pair, labelled with every kind ─────────────────────────────
{
  const merged = mergeEdges([
    edge('stem', 'song', ['derived_from']),
    edge('stem', 'song', ['edit_of']),
    edge('stem', 'song', ['stem_of', 'derived_from']),
    edge('cover', 'song', ['cover_of']),
  ]);

  assert.equal(merged.length, 2, 'three rows about one relationship are one edge');
  assert.deepEqual(
    merged[0].kinds,
    ['derived_from', 'edit_of', 'stem_of'],
    'every kind survives, in the order it arrived, with no repeat',
  );
  assert.equal(
    edgeKindsLabel(merged[0].kinds),
    'derived from · edit of · stem of',
    'and the label says all three, so the merge hides nothing',
  );
  assert.equal(edgeKindsLabel([]), 'related', 'an edge with no kind still says what it is');

  // Direction is part of the identity: parent→child is not child→parent.
  assert.equal(mergeEdges([edge('a', 'b', ['x']), edge('b', 'a', ['y'])]).length, 2);

  // An id containing the key separator cannot collide with another pair.
  assert.equal(mergeEdges([edge('a\u0000b', 'c', ['x']), edge('a', 'b\u0000c', ['y'])]).length, 2);
}

// ── a classified role beats the unclassified bucket ─────────────────────────
{
  const merged = mergeEdges([edge('a', 'b', ['weird_of'], 'other'), edge('a', 'b', ['cover_of'], 'ancestry')]);
  assert.equal(merged[0].role, 'ancestry', 'once a kind on the pair is understood, the pair is');
  const other = mergeEdges([edge('a', 'b', ['w'], 'other'), edge('a', 'b', ['w2'], 'other')]);
  assert.equal(other[0].role, 'other', 'and an unknown kind is never promoted to ancestry');
}

// ── colour comes from the app-wide palette, and nothing is invented ─────────
{
  assert.equal(edgeColorForKinds(['stem_of']), EDGE_COLOR_BY_KIND.stem_of);
  assert.equal(
    edgeColorForKinds(['derived_from', 'stem_of']),
    EDGE_COLOR_BY_KIND.derived_from,
    'the FIRST kind decides the colour',
  );
  assert.equal(edgeKindIsPaletted(['stem_of']), true);
  assert.equal(edgeKindIsPaletted(['cover_of']), false, 'a kind the palette does not name is reported as such');
  assert.equal(edgeKindIsPaletted([]), false);
  assert.equal(
    edgeColorForKinds(['cover_of']),
    edgeColorForKinds(['nonsense_of']),
    'and it falls back to the shared neutral rather than a colour made up here',
  );
}

// ── a cross-reference is drawn differently from descent ─────────────────────
{
  assert.equal(isCrossReferenceRole('uses'), true, 'a mashup USES its sources');
  assert.equal(isCrossReferenceRole('ancestry'), false);
  assert.equal(isCrossReferenceRole('artifact'), false);
  assert.equal(isCrossReferenceRole('other'), false);
  assert.ok(edgeWidthForRole('ancestry') > edgeWidthForRole('uses'), 'descent reads heavier');
}

// ── THE REGRESSION: a relation reads two ways, and the fold must say which ──
//
// Found against the real library: a song that 677 mashups were built FROM
// emits {kind: 'mashup_source', direction: 'down', count: 677}. Labelling that
// "Mashup sources (677)" says the song HAS 677 sources. It has none — it IS
// the source. Every phrase for a kind now comes out of one table with a column
// per direction, so no label, heading or spoken sentence can say the opposite
// of the truth.
{
  const usedInMashups = {
    id: 'g-m', parent_id: 'song-7', direction: 'down' as const,
    kind: 'mashup_source', count: 677, sample_ids: [],
  };

  assert.equal(groupLabel(usedInMashups), 'Used in mashups (677)');
  assert.ok(
    !groupLabel(usedInMashups).includes('source'),
    'a song 677 mashups were made FROM has no sources, and must never be told it has',
  );
  assert.ok(
    !groupAccessibleName(usedInMashups, 'Night Drive').includes('source'),
    'and the spoken name must not say it either',
  );
  assert.equal(
    groupAccessibleName(usedInMashups, 'Night Drive'),
    '677 mashups use Night Drive. Open the list.',
  );
  assert.equal(groupHeading(usedInMashups, 'Night Drive'), 'Used in mashups (677) — Night Drive');

  // The SAME kind pointing the other way is where "Mashup sources" belongs.
  const mashupIngredients = { ...usedInMashups, direction: 'up' as const, count: 3 };
  assert.equal(groupLabel(mashupIngredients), 'Mashup sources (3)');
  assert.equal(
    groupAccessibleName(mashupIngredients, 'A Mashup'),
    '3 songs A Mashup was mashed up from. Open the list.',
  );
}

// ── every kind, both ways round ─────────────────────────────────────────────
{
  const expected: Array<[string, string, string]> = [
    ['cover_of', 'Covers', 'Cover of'],
    ['edit_of', 'Edits', 'Edit of'],
    ['derived_from', 'Derivatives', 'Derived from'],
    ['upsample_of', 'Upsamples', 'Upsample of'],
    ['stem_of', 'Stems', 'Stem of'],
    ['overpaint_of', 'Overpaints', 'Overpaint of'],
    ['underpaint_of', 'Underpaints', 'Underpaint of'],
    ['speed_change_of', 'Speed changes', 'Speed change of'],
    ['mashup_source', 'Used in mashups', 'Mashup sources'],
    // The Suno poller's bare kinds (backend/modules/suno/router.py:346) read
    // with the same words as their `_of` siblings: the same relationship.
    ['cover', 'Covers', 'Cover of'],
    ['mashup', 'Used in mashups', 'Mashup sources'],
    ['chimera_source_of', 'Used in chimeras', 'Chimera sources'],
    ['all', 'Derivatives', 'Sources'],
  ];
  for (const [kind, down, up] of expected) {
    assert.equal(kindWords(kind, 'down'), down, `${kind} down`);
    assert.equal(kindWords(kind, 'up'), up, `${kind} up`);
    assert.notEqual(down, up, `${kind} must read differently each way`);
    // The sentence is filled in from the same row, both ways.
    for (const direction of ['down', 'up'] as const) {
      const sentence = kindSentence(kind, direction, 1200, 'Night Drive');
      assert.ok(sentence.startsWith('1,200 '), `${kind} ${direction} counts: ${sentence}`);
      assert.ok(sentence.includes('Night Drive'), `${kind} ${direction} names the song: ${sentence}`);
      assert.ok(!sentence.includes('{'), `${kind} ${direction} left a slot unfilled: ${sentence}`);
    }
  }
  // Every kind in the table is covered by the list above.
  assert.deepEqual(
    Object.keys(KIND_WORDING).sort(),
    expected.map(([kind]) => kind).sort(),
    'a kind added to the table must be added to this test',
  );

  // A kind this build has never seen is named by its own words AND told which
  // side it is on, rather than borrowing the other direction's phrase.
  assert.equal(kindWords('never_seen_of', 'down'), 'Never seen of (derived)');
  assert.equal(kindWords('never_seen_of', 'up'), 'Never seen of (sources)');
  assert.equal(
    kindSentence('never_seen_of', 'down', 2, 'X'),
    '2 derivatives of X (never seen of)',
  );
  assert.equal(kindSentence('never_seen_of', 'up', 2, 'X'), '2 sources of X (never seen of)');
}

// ── a folded group is a label and a query ───────────────────────────────────
{
  const group = { id: 'g1', parent_id: 'song-7', direction: 'down' as const, kind: 'cover_of', count: 312, sample_ids: [] };

  assert.equal(groupLabel(group), 'Covers (312)');
  assert.equal(
    groupAccessibleName(group, 'Night Drive'),
    '312 covers of Night Drive. Open the list.',
  );
  assert.equal(
    groupAccessibleName({ ...group, direction: 'up', count: 14 }, 'Night Drive'),
    '14 songs Night Drive is a cover of. Open the list.',
    'the same fold read the other way round names the song it is a cover OF',
  );
  assert.equal(groupHeading(group, 'Night Drive'), 'Covers (312) — Night Drive');

  assert.deepEqual(relativesRequestForGroup(group), {
    entryId: 'song-7', direction: 'down', kind: 'cover_of', sort: 'title', offset: 0, limit: 100,
  });
  assert.equal(relativesRequestForGroup(group, 'plays').sort, 'plays');
  assert.deepEqual(relativesRequestForNode('song-7', 'up'), {
    entryId: 'song-7', direction: 'up', kind: 'all', sort: 'title', offset: 0, limit: 100,
  });
}

// ── hidden counts: "+412 more", and silence when nothing is hidden ──────────
{
  const hidden = { 'song-7': { up: 12, down: 400 } };
  assert.deepEqual(hiddenFor(hidden, 'song-7'), { up: 12, down: 400 });
  assert.deepEqual(hiddenFor(hidden, 'song-8'), { up: 0, down: 0 }, 'a node not in the map hid nothing');
  assert.deepEqual(hiddenFor(undefined, 'song-7'), { up: 0, down: 0 });

  assert.equal(hiddenTotal({ up: 12, down: 400 }), 412);
  assert.equal(hiddenLabel({ up: 12, down: 400 }), '+412 more');
  assert.equal(hiddenLabel({ up: 0, down: 0 }), '', 'no badge at all, rather than "+0 more"');
  assert.equal(hiddenLabel({ up: 0, down: 1200 }), '+1,200 more');

  assert.equal(
    hiddenAccessibleName({ up: 12, down: 400 }, 'Night Drive'),
    '12 more sources and 400 more derivatives of Night Drive. Focus it to expand.',
  );
  assert.equal(hiddenAccessibleName({ up: 0, down: 3 }, 'X'), '3 more derivatives of X. Focus it to expand.');
  assert.equal(hiddenAccessibleName({ up: 0, down: 0 }, 'X'), '');
}

// ── a list row names the LINK, and says which side the row is on ───────────
{
  // The kinds on a row describe the link, which is written from the derived
  // song's point of view. In the `down` list the row IS the derived song; in
  // the `up` list it is the source, and "cover of" alone would read as a claim
  // about the row rather than about the focus.
  assert.equal(relativeRowWords(['cover_of'], 'down'), 'cover of · derivative');
  assert.equal(relativeRowWords(['cover_of'], 'up'), 'cover of · source');
  assert.equal(relativeRowWords(['derived_from', 'edit_of'], 'down'), 'derived from · edit of · derivative');
  assert.equal(
    relativeRowAccessibleWords(['mashup_source'], 'down'),
    'mashup source, a derivative of this song',
  );
  assert.equal(
    relativeRowAccessibleWords(['mashup_source'], 'up'),
    'mashup source, a source of this song',
  );
}

// ── the breadcrumb trail ────────────────────────────────────────────────────
{
  let trail = pushCrumb([], { id: 'a', title: 'A' });
  assert.equal(canGoBack(trail), false, 'the first song has nothing behind it');

  trail = pushCrumb(trail, { id: 'b', title: 'B' });
  trail = pushCrumb(trail, { id: 'c', title: 'C' });
  assert.deepEqual(trail.map((c) => c.id), ['a', 'b', 'c']);
  assert.equal(currentCrumb(trail)?.id, 'c');
  assert.equal(canGoBack(trail), true);

  // Re-focusing the song already in view changes nothing.
  assert.deepEqual(pushCrumb(trail, { id: 'c', title: 'C' }).map((c) => c.id), ['a', 'b', 'c']);

  // Focusing a song already behind you WALKS BACK to it: A → B → A → B → …
  // leaves two crumbs, not sixty.
  const walkedBack = pushCrumb(trail, { id: 'a', title: 'A' });
  assert.deepEqual(walkedBack.map((c) => c.id), ['a'], 'the trail rewinds instead of growing');
  assert.equal(
    pushCrumb(trail, { id: 'b', title: 'Renamed' })[1].title,
    'Renamed',
    'and a fresher title is taken while rewinding',
  );

  assert.deepEqual(popCrumb(trail).map((c) => c.id), ['a', 'b'], 'Back drops the last crumb');
  assert.deepEqual(popCrumb(popCrumb(popCrumb(trail))).map((c) => c.id), ['a'], 'and never empties the trail');
  assert.equal(currentCrumb([]), null);

  // Every operation returns a NEW array: the caller's state is not mutated.
  const before = trail.map((c) => c.id).join(',');
  pushCrumb(trail, { id: 'z', title: 'Z' });
  popCrumb(trail);
  assert.equal(trail.map((c) => c.id).join(','), before);
}

// ── the focus node is found even if the server names it differently ─────────
{
  const data = { focus: 'song-7', nodes: [node('p', -1), node('song-7', 0), node('c', 1)] };
  assert.equal(focusNodeOf(data)?.id, 'song-7');
  assert.equal(focusNodeOf(data, 'c')?.id, 'c', 'the requested id wins');
  assert.equal(
    focusNodeOf({ focus: 'not-sent', nodes: data.nodes })?.id,
    'song-7',
    'and generation 0 is the fallback, so the view is never left without a centre',
  );
  assert.equal(focusNodeOf({ focus: 'x', nodes: [] }), null);
}

// ── what a node says out loud ───────────────────────────────────────────────
{
  assert.equal(nodeTitle({ id: 'abc', title: '' }), 'abc', 'an untitled song is named by its id');
  assert.equal(nodeTitle({ id: 'abc', title: '  ' }), 'abc');
  assert.equal(generationWords(0), 'the focus');
  assert.equal(generationWords(-1), '1 generation up');
  assert.equal(generationWords(3), '3 generations down');

  assert.equal(
    nodeAccessibleName(node('n1', -2, { title: 'Night Drive', duration_sec: 253, play_count: 1200 })),
    'Night Drive, 2 generations up, 4:13, 1,200 plays. Focus this song.',
  );
  assert.equal(
    nodeAccessibleName(node('gone', 1, { title: 'Ghost', in_library: false })),
    'Ghost, 1 generation down, no longer in the library. Focus this song.',
    'a link endpoint that is not an entry says so',
  );
}

// ── formatting ──────────────────────────────────────────────────────────────
{
  assert.equal(formatCount(194833), '194,833');
  assert.equal(formatCount(Number.NaN), '0');
  assert.equal(formatDuration(0), '', 'no duration means no text, not "0:00"');
  assert.equal(formatDuration(61), '1:01');
  assert.equal(formatDuration(3661), '1:01:01');
  assert.equal(formatDuration(Number.NaN), '');
}

// ── the landing headlines ───────────────────────────────────────────────────
{
  const headlines = summaryHeadlines({
    entries: 194833, with_lineage: 173877, standalone: 20652,
    links_distinct: 400000, largest_connected: 81501, largest_tree: 8618,
  });
  assert.deepEqual(headlines.map((h) => h.key), ['entries', 'links', 'largest_tree', 'largest_connected']);
  assert.equal(headlines[0].value, '194,833');
  assert.ok(headlines[0].hint.includes('173,877') && headlines[0].hint.includes('20,652'));
  assert.equal(headlines[2].value, '8,618');
  assert.ok(
    headlines[3].hint.includes('not one family'),
    'the cluster number is labelled as what it is: mashups welding unrelated trees',
  );

  assert.deepEqual(
    kindRows({ derived_from: 164779, cover_of: 85552, edit_of: 140939 }, 2),
    [['derived_from', 164779], ['edit_of', 140939]],
    'the kind table is biggest-first and capped',
  );
  assert.deepEqual(kindRows({}), []);
}

// ── "stands alone" is about relatives, not about node count ─────────────────
{
  assert.equal(standsAlone({ nodes: [{ id: 'f' }], groups: [], hidden: {} } as never), true);
  assert.equal(standsAlone({ nodes: [], groups: [], hidden: {} } as never), true);

  // The headline case: a hub whose whole family is folded comes back as ONE
  // node plus groups. Calling that "stands alone" hid every group box it had.
  const allFolded = {
    nodes: [{ id: 'f' }],
    groups: [{
      id: 'f|down|cover_of', parent_id: 'f', direction: 'down',
      kind: 'cover_of', count: 800, sample_ids: [],
    }],
    hidden: {},
  };
  assert.equal(standsAlone(allFolded as never), false, 'a folded group IS a family');

  // A hidden count is a relative too.
  assert.equal(
    standsAlone({ nodes: [{ id: 'f' }], groups: [], hidden: { f: { up: 0, down: 7 } } } as never),
    false,
  );
  assert.equal(
    standsAlone({ nodes: [{ id: 'f' }], groups: [], hidden: { f: { up: 0, down: 0 } } } as never),
    true,
    'a zero count is not a relative',
  );
  assert.equal(hasHiddenRelatives(undefined), false);
  assert.equal(hasHiddenRelatives({ a: { up: 0, down: 0 }, b: { up: 3, down: 0 } }), true);
}

// ── an id with a '/' in it cannot be asked for by route ─────────────────────
{
  assert.equal(canFocusNode('9f3a1c2e'), true);
  assert.equal(canFocusNode('job_01'), true);
  // A chimera source label is an arbitrary string out of the entry's metadata;
  // `/{entry_id}/neighbourhood` takes the id as a PATH segment, so a '/' is a
  // separator before any route matching and the request can only 404.
  assert.equal(canFocusNode('samples/kick 03.wav'), false);
  assert.equal(canFocusNode('a/b'), false);
}

console.log('lineageScaleModel: all assertions passed');
