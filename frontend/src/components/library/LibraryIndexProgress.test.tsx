/**
 * Render test for the LIBRARY tab's library-opening progress bar (node, no
 * DOM — `renderToStaticMarkup`).
 *
 * What it pins:
 *   * a running phase renders a real progressbar: `role="progressbar"` with
 *     `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, a spoken value and an
 *     accessible name taken from the visible label;
 *   * the count and the ETA are on screen, in bold sans at 12 px (`text-xs
 *     font-bold`), never a small mono label;
 *   * nothing is counted yet → an indeterminate bar with no `aria-valuenow`;
 *   * `ready` renders nothing; `failed` renders an alert with the reason;
 *   * a search during the index build says how much of the library it covers;
 *   * the ETA wording and the count formatting.
 *
 *   cd frontend && npx tsx src/components/library/LibraryIndexProgress.test.tsx
 */
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { LibraryIndexProgressView } from './LibraryIndexProgress.tsx';
import {
  asIndexStatus,
  formatEta,
  indexProgressView,
  libraryOpeningText,
  searchCoverageText,
  type LibraryIndexStatus,
} from '../../lib/libraryIndexStatus.ts';

const snap = (over: Partial<LibraryIndexStatus>): LibraryIndexStatus => ({
  phase: 'index',
  label: 'Building the search index',
  done: 40_000,
  total: 200_000,
  items: 0,
  etaSec: 95,
  opened: true,
  error: null,
  ...over,
});

// ── a running build: a named, valued progressbar with count and ETA ─────────
{
  const html = renderToStaticMarkup(
    <LibraryIndexProgressView status={snap({})} libraryOpening={false} searchCoverage={null} />,
  );
  assert.ok(html.includes('role="progressbar"'), 'a progressbar');
  assert.ok(html.includes('aria-valuenow="40000"'), 'with its value');
  assert.ok(html.includes('aria-valuemin="0"'));
  assert.ok(html.includes('aria-valuemax="200000"'));
  assert.ok(html.includes('aria-valuetext="40,000 of 200,000 entries. About 2 min left."'));
  const labelId = /id="([^"]+)"[^>]*>Building the search index</.exec(html)?.[1];
  assert.ok(labelId, 'the label has an id');
  assert.ok(html.includes(`aria-labelledby="${labelId}"`), 'the bar is named by the visible label');
  assert.ok(html.includes('40,000 of 200,000 entries'), 'the count is on screen');
  assert.ok(html.includes('About 2 min left'), 'the ETA is on screen');
  assert.ok(html.includes('>20%<'), 'and the percentage');
  assert.ok(html.includes('style="width:20%"'), 'the bar is filled to it');
  assert.ok(html.includes('text-xs font-bold'), 'bold sans at 12 px');
  assert.ok(!/text-\[(8|9|10|11)px\]/.test(html), 'no text under 12 px');
  assert.ok(!html.includes('font-mono'), 'no mono labels');
  assert.ok(!html.includes('<label'), 'a custom widget is never wrapped in a label');
}

// ── the upgrade counts steps, the first read counts folders and entries ────
{
  const upgrade = indexProgressView(snap({ phase: 'upgrade', label: 'Upgrading the library database', done: 12, total: 30, etaSec: 8 }));
  assert.equal(upgrade.countText, '12 of 30 steps');
  assert.equal(upgrade.etaText, 'About 10 s left');
  const read = indexProgressView(snap({ phase: 'read', label: 'Reading the library from disk', done: 300, total: 1200, items: 290, etaSec: 30 }));
  assert.equal(read.countText, '300 of 1,200 folders · 290 entries found');
}

// ── nothing counted yet: indeterminate, no value announced ─────────────────
{
  const html = renderToStaticMarkup(
    <LibraryIndexProgressView
      status={snap({ phase: 'upgrade', label: 'Upgrading the library database', done: 0, total: 0, etaSec: null })}
      libraryOpening
      searchCoverage={null}
    />,
  );
  assert.ok(html.includes('role="progressbar"'));
  assert.ok(!html.includes('aria-valuenow'), 'an indeterminate bar has no value');
  assert.ok(html.includes('Estimating time left'));
}

// ── "opening" with nothing measured shows only once the list was refused ────
{
  const opening = snap({ phase: 'opening', label: 'Opening the library', done: 0, total: 0, etaSec: null, opened: false });
  assert.equal(
    renderToStaticMarkup(<LibraryIndexProgressView status={opening} libraryOpening={false} searchCoverage={null} />),
    '',
    'a small library opening in a moment flashes nothing',
  );
  assert.ok(
    renderToStaticMarkup(<LibraryIndexProgressView status={opening} libraryOpening searchCoverage={null} />).includes(
      'Opening the library',
    ),
  );
}

// ── ready renders nothing ───────────────────────────────────────────────────
assert.equal(
  renderToStaticMarkup(
    <LibraryIndexProgressView status={snap({ phase: 'ready', label: 'Ready', done: 0, total: 0 })} libraryOpening={false} searchCoverage={null} />,
  ),
  '',
);

// ── failed: an alert with the reason, no bar ────────────────────────────────
{
  const html = renderToStaticMarkup(
    <LibraryIndexProgressView
      status={snap({ phase: 'failed', label: 'The search index build stopped', error: 'disk full; it resumes the next time theDAW starts' })}
      libraryOpening={false}
      searchCoverage={null}
    />,
  );
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes('The search index build stopped'));
  assert.ok(html.includes('disk full'));
  assert.ok(!html.includes('role="progressbar"'));
  assert.ok(!html.includes('<button'), 'no Retry button without a handler');
}

// ── failed with a Retry handler: a real, named button in the alert ─────────
{
  const failed = snap({ phase: 'failed', label: 'The library could not be opened', error: 'the folder cannot be read', opened: false });
  const html = renderToStaticMarkup(
    <LibraryIndexProgressView status={failed} libraryOpening searchCoverage={null} onRetry={() => {}} />,
  );
  assert.ok(html.includes('role="alert"'));
  assert.ok(/<button type="button"[^>]*aria-label="Retry opening the library"[^>]*>Retry<\/button>/.test(html), html);
  assert.ok(html.includes('text-xs font-bold'), 'the button text is bold sans at 12 px');
  const busy = renderToStaticMarkup(
    <LibraryIndexProgressView status={failed} libraryOpening searchCoverage={null} onRetry={() => {}} retrying retryError="HTTP 500" />,
  );
  assert.ok(busy.includes('disabled=""'), 'disabled while the request is out');
  assert.ok(busy.includes('>Retrying…<'));
  assert.ok(busy.includes('Retry failed: HTTP 500'));
  // The empty list points at the alert after a failed open, not at a wait.
  assert.equal(
    libraryOpeningText(failed),
    'The library could not be opened. The reason and a Retry button are above the list.',
  );
  assert.equal(libraryOpeningText(snap({ phase: 'upgrade' })), 'The list appears when the library has finished opening.');
  assert.equal(libraryOpeningText(null), 'The list appears when the library has finished opening.');
}

// ── a search during the build says what it covers ──────────────────────────
{
  const coverage = { complete: false, indexed: 40_000, total: 200_000, etaSec: 95 };
  const html = renderToStaticMarkup(
    <LibraryIndexProgressView status={snap({})} libraryOpening={false} searchCoverage={coverage} />,
  );
  assert.ok(html.includes('Search covers 40,000 of 200,000 entries until the search index finishes building.'));
  assert.ok(html.includes('role="status"'));
  assert.equal(searchCoverageText({ complete: false, indexed: 0, total: 0, etaSec: null }).startsWith('Search covers the entries indexed so far'), true);
  // A complete search says nothing.
  assert.ok(
    !renderToStaticMarkup(
      <LibraryIndexProgressView status={snap({ phase: 'ready', label: 'Ready', done: 0, total: 0 })} libraryOpening={false} searchCoverage={{ complete: true, indexed: 0, total: 0, etaSec: null }} />,
    ).includes('Search covers'),
  );
}

// ── ETA wording and parsing ─────────────────────────────────────────────────
assert.equal(formatEta(null), 'Estimating time left');
assert.equal(formatEta(3), 'Almost done');
assert.equal(formatEta(42), 'About 40 s left');
assert.equal(formatEta(150), 'About 3 min left');
assert.equal(formatEta(3600 * 2 + 60 * 10), 'About 2 h 10 min left');
assert.equal(asIndexStatus({ phase: 'nonsense' }), null, 'an unknown phase is not a status');
assert.deepEqual(
  asIndexStatus({ phase: 'index', label: 'x', done: 5, total: 10, items: 0, eta_sec: 2.5, opened: true, error: null }),
  { phase: 'index', label: 'x', done: 5, total: 10, items: 0, etaSec: 2.5, opened: true, error: null },
);

console.log('LibraryIndexProgress: all assertions passed');
