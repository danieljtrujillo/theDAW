/**
 * liveBadge: short pill text plus a full-sentence label for assistive tech.
 *
 * Run: `npx tsx src/components/audio/fxRackBadge.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { liveBadge } from './fxRackBadge';
import { FxRack } from './FxRack';
import type { ChainEntry } from '../../state/effectChainStore';

// A live entry with its saved state intact: short pill text, nothing about defaults.
{
  const badge = liveBadge('live', false);
  assert.equal(badge.text, 'LIVE');
  assert.ok(badge.label.length > 0);
  assert.notEqual(badge.label, badge.text, 'the label is more than the pill text');
}

// R1 finding 9 — THE bug. A live entry running at factory defaults used to put
// a whole sentence in the pill ("LIVE · saved settings could not be loaded —
// <reason>"). The pill stays short now; the sentence lives in `label` instead.
{
  const badge = liveBadge('live', true);
  assert.equal(badge.text, 'LIVE · DEFAULTS');
  assert.ok(/defaults/i.test(badge.label), 'the full explanation says why it is on defaults');
  assert.notEqual(badge.label, badge.text, 'the label is more than the pill text');
}

// usingDefaults only means something for 'live' — every other status reports
// its own short, static text and ignores the flag.
{
  assert.equal(liveBadge('starting', false).text, 'starting…');
  assert.equal(liveBadge('starting', true).text, liveBadge('starting', false).text);
  assert.equal(liveBadge('error', false).text, 'error');
  assert.equal(liveBadge('error', true).text, liveBadge('error', false).text);
  assert.equal(liveBadge('off', false).text, 'render-only');
  assert.equal(liveBadge('unavailable', false).text, 'render-only');
  assert.equal(liveBadge('unavailable', true).text, liveBadge('unavailable', false).text);
}

// A hard guard against another whole sentence sneaking back into the pill:
// every status's pill text is short, and every status still has a real label.
{
  const statuses = ['live', 'starting', 'error', 'off', 'unavailable'] as const;
  for (const status of statuses) {
    for (const usingDefaults of [false, true]) {
      const badge = liveBadge(status, usingDefaults);
      assert.ok(
        badge.text.length <= 'LIVE · DEFAULTS'.length,
        `${status}/${usingDefaults}: pill text "${badge.text}" is short`,
      );
      assert.ok(badge.label.length > 0, `${status}/${usingDefaults}: label is non-empty`);
    }
  }
}

// R1 finding 9 fix, at the DOM the pill actually renders into: FxRack's live
// badge is a bare <span>, whose implicit ARIA role is `generic` — and
// aria-label is prohibited on `generic` (axe-core aria-prohibited-attr,
// Serious). So the full sentence can't reach assistive tech via aria-label (or
// title — role=generic has no accessible-name source, and title is not
// reachable by keyboard/touch anyway); it has to be real text. This renders
// the actual component and checks the DOM, not just the pure helper above, so
// a regression that re-adds aria-label to the pill or drops the sibling text
// fails here even if `liveBadge` itself still looks correct in isolation.
{
  const entry: ChainEntry = {
    id: 'test-vst-entry',
    effect: 'vst3',
    params: {},
    enabled: true,
    vst: { plugin_path: 'Test.vst3', plugin_name: 'Test Plugin' },
  };
  const html = renderToStaticMarkup(
    React.createElement(FxRack, {
      chain: [entry],
      idPrefix: 'fx-badge-test',
      onAdd: () => {},
      onRemove: () => {},
      onReorder: () => {},
      onToggle: () => {},
      onUpdateParams: () => {},
    }),
  );
  // Isolate the pill's own opening tag (there are OTHER, legitimate
  // aria-labels in this row, e.g. the real <button aria-label="Remove …">) —
  // the finding is about this <span> specifically, so the check has to be too.
  const pillTag = html.match(/<span[^>]*>render-only<\/span>/)?.[0];
  assert.ok(pillTag, 'the pill renders its short text');
  assert.ok(
    !pillTag!.includes('aria-label'),
    'the pill <span> itself carries no aria-label — role="generic" forbids it (axe-core aria-prohibited-attr)',
  );
  assert.ok(
    html.includes(`<span class="sr-only">${liveBadge('off', false).label}</span>`),
    'the full sentence reaches assistive tech as real text (a sr-only sibling), not a discarded attribute',
  );
}

console.log('fxRackBadge: liveBadge keeps the pill short and the full explanation in label');
