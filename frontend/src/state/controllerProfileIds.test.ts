/**
 * FE-025: controllerProfileIds.ts holds the id constants split out of
 * controllerProfiles.ts so an eager consumer (slideStore.ts) can import just
 * an id without pulling in the 400+ line CONTROLLER_PROFILES table. This
 * checks the values are correct and that controllerProfiles.ts re-exports
 * them (rather than redefining them, which would silently reintroduce two
 * sources of truth).
 *
 * Run: `npx tsx src/state/controllerProfileIds.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIMA_SWAY_ID,
  DEFAULT_PROFILE_ID,
  GANTASMO_WORLDS_COLLIDE_ID,
} from './controllerProfileIds';
import * as controllerProfiles from './controllerProfiles';

assert.equal(GANTASMO_WORLDS_COLLIDE_ID, 'gantasmo-worlds-collide');
assert.equal(AUDIMA_SWAY_ID, 'audima-sway');
assert.equal(DEFAULT_PROFILE_ID, GANTASMO_WORLDS_COLLIDE_ID);

// controllerProfiles.ts must re-export the SAME values, not its own copies.
assert.equal(controllerProfiles.GANTASMO_WORLDS_COLLIDE_ID, GANTASMO_WORLDS_COLLIDE_ID);
assert.equal(controllerProfiles.AUDIMA_SWAY_ID, AUDIMA_SWAY_ID);
assert.equal(controllerProfiles.DEFAULT_PROFILE_ID, DEFAULT_PROFILE_ID);

const controllerProfilesSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'controllerProfiles.ts'),
  'utf8',
);
assert.doesNotMatch(
  controllerProfilesSource,
  /^export const (GANTASMO_WORLDS_COLLIDE_ID|AUDIMA_SWAY_ID|DEFAULT_PROFILE_ID)\s*=/m,
  'controllerProfiles.ts must re-export these ids from controllerProfileIds.ts, not define its own copies (two sources of truth)',
);
assert.match(
  controllerProfilesSource,
  /export\s*\{[^}]*GANTASMO_WORLDS_COLLIDE_ID[^}]*AUDIMA_SWAY_ID[^}]*DEFAULT_PROFILE_ID[^}]*\}\s*from\s*['"]\.\/controllerProfileIds['"]/,
  'controllerProfiles.ts must re-export GANTASMO_WORLDS_COLLIDE_ID, AUDIMA_SWAY_ID, DEFAULT_PROFILE_ID from ./controllerProfileIds',
);

console.log('controllerProfileIds: all assertions passed');
