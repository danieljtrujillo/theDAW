/**
 * Source-level wiring check for FE-012: only the Perform (session) tab was
 * wrapped in a TabErrorBoundary (DAWCenterPanel.tsx:114-220 at the time of
 * P-20260919-batch12). A crash in any OTHER center tab (make, edit, mix,
 * learn, dj, vj, sway, foundry, underfit, nodefi, loom, tour) unmounted the
 * whole center panel instead of being contained.
 *
 * DAWCenterPanel needs a live React tree + a component that actually throws
 * to exercise this at runtime, so per the house pattern for a component-only
 * fix (see audioEditorPanelWiring.test.ts) this asserts the wiring at SOURCE
 * level: every one of the warmed/eager tab branches must be wrapped in a
 * TabErrorBoundary with a tab-specific name, not just SessionView's.
 *
 * Run: `npx tsx src/components/layout/DAWCenterPanel.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'DAWCenterPanel.tsx'),
  'utf8',
);

// Every tab view rendered in the center panel — the eager `make`/`edit`/`mix`
// branches plus every warmed-tab branch — must sit inside a TabErrorBoundary.
const TAB_VIEWS = [
  { view: 'AdvancedView', tab: 'make' },
  { view: 'WaveformEditor', tab: 'edit' },
  { view: 'SessionView', tab: 'session' },
  { view: 'MixView', tab: 'mix' },
  { view: 'LineageView', tab: 'learn' },
  { view: 'DJView', tab: 'dj' },
  { view: 'VJView', tab: 'vj' },
  { view: 'SwayView', tab: 'sway' },
  { view: 'FoundryView', tab: 'foundry' },
  { view: 'UnderfitView', tab: 'underfit' },
  { view: 'NodefiView', tab: 'nodefi' },
  { view: 'LoomView', tab: 'loom' },
  { view: 'TourView', tab: 'tour' },
];

for (const { view, tab } of TAB_VIEWS) {
  const viewIdx = source.indexOf(`<${view}`);
  assert.ok(viewIdx >= 0, `<${view} /> must still be rendered somewhere in DAWCenterPanel.tsx`);
  // Look at the 400 chars immediately before the view's opening tag: the
  // nearest wrapping boundary must be a TabErrorBoundary, not a bare
  // Suspense/div with no crash containment.
  const before = source.slice(Math.max(0, viewIdx - 400), viewIdx);
  assert.match(
    before,
    /<TabErrorBoundary\s+tabName=/,
    `${view} (${tab} tab) must be wrapped in a <TabErrorBoundary tabName="..."> — a crash in ${tab} must not blank the whole center panel`,
  );
}

console.log('DAWCenterPanel: all assertions passed');
