/**
 * T20 re-audit item 2 (MAJOR, lead decision): no left panel exists in
 * today's layout — appUiStore.ts's own comment says so plainly ("There is
 * no left panel any more — the center bar hosts all tab content... nothing
 * toggles it and nothing renders behind it"). A prior pass wired Shell to
 * listen for `thedaw:set-left-panel` (dispatched by LineageModal.tsx and the
 * assistant's open_left_panel/close_left_panel actions in
 * orb-kit/actionHandlers.ts) and forward it to `setLeftPanelOpen`. That made
 * the problem WORSE, not better: it let `isLeftPanelOpen` actually flip to
 * `true`, so the assistant's app-state report (orb-kit/appContext.ts) can
 * now claim a left panel is open while nothing whatsoever is on screen for
 * it — a more confident lie than the flag sitting permanently at `false`.
 *
 * The honest fix is on the assistant side (A2's write set: orb-kit/actions
 * and the flag itself) — not a Shell listener. This asserts Shell has NO
 * listener for `thedaw:set-left-panel`, restoring the flag to its accurate,
 * inert `false` default per appUiStore.ts's own comment.
 *
 * Shell needs the full app-store tree mounted to exercise this at runtime,
 * so per the house pattern for a component-only fix (see
 * audioEditorPanelWiring.test.ts) this asserts the wiring at SOURCE level.
 *
 * Run: `npx tsx src/components/layout/Shell.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'Shell.tsx'),
  'utf8',
);

assert.doesNotMatch(
  source,
  /['"]thedaw:set-left-panel['"]/,
  'Shell must not listen for thedaw:set-left-panel — no left panel exists in today\'s layout, and wiring the flag only makes the assistant\'s dishonest report more convincing',
);
assert.doesNotMatch(
  source,
  /setLeftPanelOpen/,
  'Shell must not call setLeftPanelOpen — nothing in Shell renders from isLeftPanelOpen',
);

// The rest of the shared listener effect (thedaw:navigate / open-docs /
// close-docs / open-settings) must be untouched by the removal.
for (const evt of ['thedaw:navigate', 'thedaw:open-docs', 'thedaw:close-docs', 'thedaw:open-settings']) {
  assert.match(
    source,
    new RegExp(`addEventListener\\(\\s*['"]${evt}['"]`),
    `Shell must still listen for ${evt}`,
  );
  assert.match(
    source,
    new RegExp(`removeEventListener\\(\\s*['"]${evt}['"]`),
    `Shell must still clean up its ${evt} listener`,
  );
}

console.log('Shell: all assertions passed');
