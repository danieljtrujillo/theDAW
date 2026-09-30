/**
 * Settings → Storage → Media roots: what the list says when it is empty.
 *
 * The backend blanks `library.media_roots` for a caller that may not set it
 * (a phone on the LAN; see backend/modules/settings/router.py `_redacted_for`),
 * so "the list is empty" and "you are not allowed to see the list" arrive as
 * the same empty array. Telling a phone user "no media roots yet" would be a
 * lie about the PC's library, and would invite them to add one that the PATCH
 * guard then refuses.
 *
 * A static render (no DOM, no effects, no fetch) is enough: the branch under
 * test is the text, and `renderToString` skips the effects that would load the
 * index status.
 *
 * Run: `npx tsx src/components/layout/settings/StorageSection.test.tsx`
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';

async function main(): Promise<void> {
  const { MediaRootsRows, MEDIA_ROOTS_EMPTY, MEDIA_ROOTS_HIDDEN, mediaRootsEmptyText } =
    await import('./StorageSection.tsx');

  // The branch itself. It is a function, not an inline ternary, because
  // zustand answers a SERVER render from the store's initial state -- a
  // `renderToString` after `setState` renders the defaults, so the redacted
  // case is unreachable from a static render.
  assert.equal(mediaRootsEmptyText(true), MEDIA_ROOTS_HIDDEN);
  assert.equal(mediaRootsEmptyText(false), MEDIA_ROOTS_EMPTY);
  assert.ok(MEDIA_ROOTS_HIDDEN.includes('theDAW PC'), MEDIA_ROOTS_HIDDEN);
  assert.ok(!MEDIA_ROOTS_HIDDEN.includes('No media roots yet'));

  // ...and that the list actually renders it, rather than its own copy of the
  // sentence. A store with no roots and no marker is the default case.
  const rendered = renderToString(React.createElement(MediaRootsRows));
  assert.ok(rendered.includes(mediaRootsEmptyText(false)), rendered.slice(-300));
  assert.ok(!rendered.includes(MEDIA_ROOTS_HIDDEN));

  console.log('StorageSection.test.tsx: all assertions passed');
}

await main();
