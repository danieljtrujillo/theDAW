// Run with: npx tsx src/lib/cloudModels.test.ts
import assert from 'node:assert/strict';
import { isLyriaCheckedOut, panelModelDefaults, panelModelOptions, PANEL_MODEL_OPTIONS } from './cloudModels.ts';

// ── isLyriaCheckedOut ────────────────────────────────────────────────────
assert.equal(isLyriaCheckedOut('needs_setup'), false, 'needs_setup is not checked out');
assert.equal(isLyriaCheckedOut('ready'), true, 'any other state is checked out');
assert.equal(isLyriaCheckedOut('needs_key'), true, 'missing key is a different gate than missing checkout');
assert.equal(isLyriaCheckedOut(null), true, 'a missing probe never blocks (fail open)');
assert.equal(isLyriaCheckedOut(undefined), true, 'an unreachable probe never blocks (fail open)');

// ── panelModelOptions (INT-005) ──────────────────────────────────────────
assert.deepEqual(
  panelModelOptions('small', true).map((o) => o.value),
  PANEL_MODEL_OPTIONS.map((o) => o.value),
  'checked out: every option offered, including lyria',
);
assert.deepEqual(
  panelModelOptions('small', false).map((o) => o.value),
  ['small', 'medium', 'small-rf', 'medium-rf', 'suno'],
  'not checked out: lyria is dropped from the switcher',
);
assert.deepEqual(
  panelModelOptions('lyria', false).map((o) => o.value),
  PANEL_MODEL_OPTIONS.map((o) => o.value),
  'not checked out but currently ON lyria: the active value stays an option so the <select> has a match',
);

// ── panelModelDefaults (FE-006) ──────────────────────────────────────────
assert.deepEqual(panelModelDefaults('small'), { steps: 8, cfg: 1.0 }, 'ARC defaults');
assert.deepEqual(panelModelDefaults('medium'), { steps: 8, cfg: 1.0 }, 'ARC defaults');
assert.deepEqual(panelModelDefaults('small-rf'), { steps: 50, cfg: 7.0 }, 'RF defaults');
assert.deepEqual(panelModelDefaults('medium-rf'), { steps: 50, cfg: 7.0 }, 'RF defaults');
// Cloud providers ignore steps/cfg entirely (capabilities.ts: params: []); the
// real dropdown computes this unconditionally too, so the cloud panels match it.
assert.deepEqual(panelModelDefaults('suno'), { steps: 8, cfg: 1.0 }, 'harmless default for a param-less provider');
assert.deepEqual(panelModelDefaults('lyria'), { steps: 8, cfg: 1.0 }, 'harmless default for a param-less provider');

console.log('cloudModels.test.ts: all assertions passed');
