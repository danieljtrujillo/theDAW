/**
 * FE-025: BottomMultiTabPanel.tsx is reachable eagerly (App -> Shell ->
 * BottomMultiTabPanel, neither lazy), so its `SlidePanel` import — which
 * pulls in controllerProfiles.ts's 400+ line controller table — must be
 * React.lazy, matching the MidiPanel / LyricStudioView pattern already in
 * this file, and both render sites must wrap it in a Suspense boundary. See
 * App.test.ts / App.bundle.check.ts for the end-to-end (real build) proof of
 * the bundle split.
 *
 * T20 re-audit item 1: a REJECTED `import('./SlidePanel')` (a stale build
 * after a deploy, a flaky network on first chunk fetch) throws inside
 * Suspense with nothing above it to catch it — React 19 unmounts the whole
 * root and the app goes blank. Both render sites must also be wrapped in a
 * TabErrorBoundary, same as every other lazy view in DAWCenterPanel.tsx.
 *
 * Run: `npx tsx src/components/layout/BottomMultiTabPanel.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'BottomMultiTabPanel.tsx'),
  'utf8',
);

assert.doesNotMatch(
  source,
  /^import\s*\{\s*SlidePanel\s*\}\s*from\s*['"]\.\/SlidePanel['"];?\s*$/m,
  'SlidePanel must not be statically imported — it pulls the controller profile table into the eager graph',
);
assert.match(
  source,
  /const\s+SlidePanel\s*=\s*lazy\(\(\)\s*=>\s*import\(['"]\.\/SlidePanel['"]\)/,
  'SlidePanel must be React.lazy-loaded',
);

assert.match(
  source,
  /import\s*\{\s*TabErrorBoundary\s*\}\s*from\s*['"]\.\/TabErrorBoundary['"]/,
  'BottomMultiTabPanel.tsx must import TabErrorBoundary',
);

// Both render sites (inline and inside DetachableWindow) must wrap <SlidePanel />
// in a Suspense boundary, and that Suspense must itself be wrapped in a
// TabErrorBoundary — a rejected chunk fetch throws past Suspense with
// nothing above it, and React 19 unmounts the whole root for an uncaught
// render-phase error.
const slidePanelUsages = [...source.matchAll(/<SlidePanel\s*\/>/g)];
assert.equal(slidePanelUsages.length, 2, 'expected exactly 2 <SlidePanel /> render sites (inline + detached window)');
for (const usage of slidePanelUsages) {
  const before = source.slice(Math.max(0, usage.index! - 260), usage.index!);
  assert.match(
    before,
    /<Suspense\b/,
    'every <SlidePanel /> render site must be wrapped in <Suspense>',
  );
  assert.match(
    before,
    /<TabErrorBoundary\s+tabName=/,
    'every <SlidePanel /> render site\'s Suspense must itself be wrapped in <TabErrorBoundary tabName="...">',
  );
  // The TabErrorBoundary must be the OUTER wrapper (Suspense catches the
  // loading state; the boundary catches the load FAILURE, which happens
  // above Suspense in the tree) — assert ordering, not just co-presence.
  const tabErrorBoundaryIdx = before.lastIndexOf('<TabErrorBoundary');
  const suspenseIdx = before.lastIndexOf('<Suspense');
  assert.ok(
    tabErrorBoundaryIdx >= 0 && suspenseIdx >= 0 && tabErrorBoundaryIdx < suspenseIdx,
    'TabErrorBoundary must be the OUTER wrapper around Suspense, not the inner one',
  );
}

console.log('BottomMultiTabPanel: all assertions passed');
