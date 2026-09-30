// Run with: npx tsx src/components/library/LineageModal.perTrack.test.tsx
//
// LineageModal has two data paths, and only one of them is dangerous.
//
//  * per-track — `/api/library/<id>/lineage?depth=4`, a BFS bounded by the
//    server's node cap. This is the CLASSIC graph of one song's family, and
//    there is no library size at which it cannot be drawn.
//  * whole-library — `/api/library/_graph/all`, every song at once. On the
//    real library that is 194,833 nodes and a 128 MB answer, and the page
//    dies.
//
// Hiding the whole component on a large library took the first away to be rid
// of the second. So the two are separated here: `wholeLibraryAllowed={false}`
// refuses the two tabs that draw the library — visibly, with the reason — and
// leaves the per-track graph exactly as it is. The prop DEFAULTS to true, so
// every caller that does not pass it (TrackMenu, LibraryView, the embedded
// LEARN view) keeps the behaviour it has today.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  LineageModal, LineageView, WHOLE_LIBRARY_REFUSED, WHOLE_LIBRARY_REFUSED_ID,
  defaultLineageTab, shouldFetchWholeLibrary, truncationNotice,
} from './LineageModal.tsx';

const render = (props: Partial<React.ComponentProps<typeof LineageModal>>): string =>
  renderToStaticMarkup(
    <LineageModal open mode="embedded" rootEntryId="song-7" onClose={() => {}} {...props} />,
  );

// ── which tab opens ─────────────────────────────────────────────────────────
{
  assert.equal(defaultLineageTab('song-7', true), 'track', 'a song opens on its own graph');
  assert.equal(defaultLineageTab(null, true), 'genealogy', 'library-wide opens on the library');
  assert.equal(
    defaultLineageTab(null, false),
    'track',
    'and where the library cannot be drawn, the library is never the opening view',
  );
  assert.equal(defaultLineageTab('song-7', false), 'track');
}

// ── when the 128 MB request is made ─────────────────────────────────────────
{
  // The tabs that draw the library, when it is allowed and on screen.
  assert.equal(shouldFetchWholeLibrary(true, true, 'genealogy', true), true);
  assert.equal(shouldFetchWholeLibrary(true, true, 'graph3d', true), true);

  // The per-track tab never asks for the library, even where it could.
  assert.equal(shouldFetchWholeLibrary(true, true, 'track', true), false);

  // And where it is refused, no tab asks for it at all.
  assert.equal(shouldFetchWholeLibrary(true, true, 'genealogy', false), false);
  assert.equal(shouldFetchWholeLibrary(true, true, 'graph3d', false), false);

  // The gates that were already there stay there.
  assert.equal(shouldFetchWholeLibrary(false, true, 'genealogy', true), false, 'closed asks nothing');
  assert.equal(shouldFetchWholeLibrary(true, false, 'genealogy', true), false, 'hidden asks nothing');
}

// ── the default: every existing caller is untouched ─────────────────────────
{
  const html = render({});
  assert.ok(html.includes('Genealogy'), 'the library tabs are offered');
  assert.ok(html.includes('3D graph'));
  assert.ok(html.includes('Track'));
  assert.ok(!html.includes('aria-disabled'), 'and none of them is refused');
  assert.ok(!html.includes('disabled=""'));
  assert.ok(!html.includes(WHOLE_LIBRARY_REFUSED_ID), 'and nothing explains a refusal there is not');

  // The embedded variant the LEARN tab mounts defaults the same way.
  const embedded = renderToStaticMarkup(<LineageView rootEntryId="song-7" visible={false} />);
  assert.ok(!embedded.includes('aria-disabled'), 'the embedded default is the same default');
  assert.ok(embedded.includes('Genealogy'));
}

// ── refused: the per-track graph survives, the library one does not ─────────
{
  const html = render({ wholeLibraryAllowed: false });

  assert.ok(html.includes('Track'), 'the per-track graph is still there — that is the whole point');
  assert.ok(html.includes('Genealogy'), 'the refused options are shown, not hidden');
  assert.ok(html.includes('3D graph'));

  const buttons: string[] = html.match(/<button[^>]*>/g) ?? [];
  const refused = buttons.filter((b) => b.includes('aria-disabled="true"'));
  assert.equal(refused.length, 2, 'exactly the two library tabs are refused');
  for (const b of refused) {
    assert.ok(
      !b.includes('disabled=""'),
      `native disabled takes the tab out of the tab order, so the reason never
       reaches a keyboard or screen-reader user: ${b}`,
    );
    assert.ok(
      b.includes(`aria-describedby="${WHOLE_LIBRARY_REFUSED_ID}"`),
      `and it must point at the reason instead: ${b}`,
    );
    assert.ok(
      b.includes('library too large for the whole-library graph'),
      `the reason is on the control itself too, as its title: ${b}`,
    );
    assert.ok(b.includes('use the per-track graph'), 'and it says what to do instead');
  }

  // The note those two point at is on the page, once, and readable.
  const notes = html.match(new RegExp(`id="${WHOLE_LIBRARY_REFUSED_ID}"`, 'g')) ?? [];
  assert.equal(notes.length, 1, 'the explanation is rendered exactly once');
  assert.ok(
    html.includes(`>${WHOLE_LIBRARY_REFUSED}<`),
    'and its text is visible, not only an attribute',
  );
}

// ── "you are seeing part of a larger family" ────────────────────────────────
{
  assert.equal(truncationNotice(null), null, 'nothing read yet says nothing');
  assert.equal(
    truncationNotice({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [] }),
    null,
    'an answer that was not cut says nothing either',
  );
  assert.equal(
    truncationNotice({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [], truncated: true }),
    'Showing the nearest 2 of a larger family.',
    'and one that was, says how much of it is on screen',
  );
}

console.log('LineageModal per-track: all assertions passed');
