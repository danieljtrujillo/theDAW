/**
 * FE-025: slideStore.ts is reachable eagerly (App -> Shell ->
 * BottomMultiTabPanel -> slideStore, none of those lazy), so its
 * DEFAULT_PROFILE_ID import must come from controllerProfileIds.ts (a small
 * constants-only module), never from controllerProfiles.ts (the 400+ line
 * table) — the latter would drag the whole table back into the first-paint
 * bundle regardless of how many other consumers of controllerProfiles.ts are
 * lazy. See App.test.ts for the end-to-end (real build) proof of the bundle
 * split; this is the narrow source check for this file's own import.
 *
 * Run: `npx tsx src/state/slideStore.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'slideStore.ts'),
  'utf8',
);

assert.doesNotMatch(
  source,
  /from\s*['"]\.\/controllerProfiles['"]/,
  'slideStore.ts must not import from ./controllerProfiles (the full table) — it is reachable eagerly',
);
assert.match(
  source,
  /import\s*\{\s*DEFAULT_PROFILE_ID\s*\}\s*from\s*['"]\.\/controllerProfileIds['"]/,
  'slideStore.ts must import DEFAULT_PROFILE_ID from ./controllerProfileIds',
);

console.log('slideStore: all assertions passed');
