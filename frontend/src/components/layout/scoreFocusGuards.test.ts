/**
 * Guards for the Score panel's Focus (fullscreen) mode.
 *
 * Focus has to ESCAPE a stacking context: ScoreView is mounted inside the
 * bottom dock, whose row is `relative z-30` (Shell.tsx), so an in-tree overlay
 * is ordered WITHIN z-30 and paints under the app header (z-40) and the library
 * edge tab (z-50) — which then keep intercepting clicks. The fix portals the
 * panel to <body>, where its z-index is compared at the top level.
 *
 * Two things about that fix are easy to regress silently, so they are pinned
 * here rather than left to a reviewer's memory:
 *
 *  1. The portal CONTAINER identity. It must come from a lazy ref (or a
 *     useState initializer), never from useMemo. useMemo is a performance hint
 *     React is allowed to drop; a fresh container would remount the whole
 *     alphaTab/OSMD subtree (a visible score reload) and orphan the superseded
 *     host, with stale DOM, inside the anchor.
 *  2. The focused geometry. The overlay must clear the transport footer instead
 *     of covering it — a follow-along you cannot play/pause/scrub is broken —
 *     so its `bottom-*` must track the footer's real height token.
 *
 * These are regex-on-source checks (same cheap style as
 * lineageWrapperGuards.test.ts): no renderer, no DOM, no alphaTab.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scoreViewPath = join(srcRoot, 'components', 'layout', 'ScoreView.tsx');
const playerFooterPath = join(srcRoot, 'components', 'audio', 'PlayerFooter.tsx');

const scoreView = readFileSync(scoreViewPath, 'utf8');
const scoreViewLines = scoreView.split('\n');

// 1. The portal container is created exactly once, through a lazy ref — not useMemo.
//    (Other `document.createElement` calls in this file belong to unrelated child
//    components, so key off the host assignment rather than counting them all.)
const creations = scoreViewLines.flatMap((line, i) =>
  /hostRef\.current = document\.createElement\('div'\)/.test(line) ? [i] : [],
);
assert.equal(
  creations.length,
  1,
  `expected exactly one lazy-ref overlay host creation in ScoreView, found ${creations.length}`,
);
const creationWindow = scoreViewLines
  .slice(Math.max(0, creations[0] - 4), creations[0] + 1)
  .join('\n');
assert.doesNotMatch(
  creationWindow,
  /useMemo/,
  'the portal container must NOT come from useMemo: React may drop a memo, and a new ' +
    'container remounts the alphaTab/OSMD subtree and orphans the old host inside the anchor',
);
assert.match(
  scoreView,
  /const hostRef = useRef<HTMLDivElement \| null>\(null\);/,
  'expected the lazy-ref overlay host declaration',
);
assert.doesNotMatch(
  scoreView,
  /const overlayHost = useMemo/,
  'the overlay host must not be derived from useMemo (identity is not guaranteed)',
);
assert.match(
  scoreView,
  /const overlayHost = hostRef\.current;/,
  'the overlay host must read straight off the stable ref',
);

// 2. Focus portals to <body> at the repo's z-60 overlay step, clearing the footer.
assert.match(
  scoreView,
  /document\.body\.appendChild\(host\)/,
  'focused mode must reparent the host to <body> to escape the dock stacking context',
);
assert.match(
  scoreView,
  /host\.className = 'fixed inset-x-0 top-0 bottom-16 z-60';/,
  'the focused host must sit at z-60 (the repo overlay step, above header z-40 and edge tab ' +
    "z-50) and stop at bottom-16 so the transport footer stays usable",
);
assert.match(
  scoreView,
  /createPortal\(root, overlayHost\)/,
  'the root subtree must render into the stable host so toggling Focus never remounts it',
);

// 3. The toggle is distinct from the dock's own Maximize2/Minimize2 "fill the window"
//    control, and carries an explicit accessible name.
assert.doesNotMatch(
  scoreView,
  /\bMaximize2\b/,
  'ScoreView must not use Maximize2: it is the dock\'s own resize toggle and reads as the same action',
);
assert.doesNotMatch(
  scoreView,
  /\bMinimize2\b/,
  'ScoreView must not use Minimize2: it is the dock\'s own resize toggle and reads as the same action',
);
assert.match(
  scoreView,
  /aria-label=\{focused \? 'Exit score focus' : 'Focus score \(fullscreen\)'\}/,
  'the Focus toggle needs an explicit aria-label (an icon-only button has no accessible name)',
);

// 4. Escape still exits Focus.
assert.match(
  scoreView,
  /e\.key === 'Escape'/,
  'Escape must still exit Focus mode',
);

// 5. The footer height that `bottom-16` above is matched to must not drift.
const playerFooter = readFileSync(playerFooterPath, 'utf8');
assert.match(
  playerFooter,
  /fixed bottom-0 left-0 right-0 h-16\b/,
  'PlayerFooter is no longer `fixed bottom-0 … h-16`: update the focused host\'s `bottom-16` in ' +
    'ScoreView.tsx to match the footer\'s new height, or Focus will cover or gap above the transport',
);

console.log('score focus guards: ok');
