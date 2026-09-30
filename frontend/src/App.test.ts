/**
 * FE-025: the controller-profile table (state/controllerProfiles.ts — a
 * 400+ line static table of every known DJ/MIDI controller's control layout)
 * was imported statically into App.tsx (App.tsx:59 at the time of
 * P-20260919-batch12), pulling it into the first paint bundle even though it
 * is only consulted inside a MIDI-device-change effect, never during initial
 * render.
 *
 * These are the fast, cheap source-level checks only. A source scan of
 * App.tsx alone is NOT sufficient proof that the table stays out of the
 * eager bundle graph — it also reaches the entry chunk through other files
 * entirely (App -> Shell -> BottomMultiTabPanel -> SlidePanel / slideStore) —
 * so the real end-to-end property (a production build, grepping the actual
 * entry chunk) lives in `App.bundle.check.ts` instead, run separately via
 * `npm run test:bundle`: a real `vite build` takes ~35s, which this file's
 * neighbours in the regular `npm test` discovery run should not have to pay
 * on every run.
 *
 * Run: `npx tsx src/App.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'App.tsx'),
  'utf8',
);

assert.doesNotMatch(
  appSource,
  /^import\s*\{[^}]*\}\s*from\s*['"]\.\/state\/controllerProfiles['"];?\s*$/m,
  'controllerProfiles must not be statically imported at module top level in App.tsx',
);
assert.match(
  appSource,
  /import\(['"]\.\/state\/controllerProfiles['"]\)/,
  'App.tsx must dynamically import(\'./state/controllerProfiles\') inside the effect that needs it',
);
assert.match(
  appSource,
  /import\(['"]\.\/state\/controllerProfiles['"]\)[\s\S]{0,600}\.catch\(/,
  'the dynamic import of controllerProfiles must have a .catch — an unhandled rejection here silently drops the Sway auto-enable with no diagnostic',
);

console.log('App: all assertions passed');
