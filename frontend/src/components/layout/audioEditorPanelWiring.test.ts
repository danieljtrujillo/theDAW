/**
 * Source-level wiring checks for the Audio Editor drawer (RS6-3).
 *
 * AudioEditorPanel needs a live pointer-drag surface to exercise, so the house
 * pattern for a component-only fix is to assert the wiring at SOURCE level
 * instead: read the file text with `node:fs` and check the exact call shapes
 * that keep a clip with a damaged or unknown `sourceDuration` / `offsetIntoSource`
 * / `durationSec` from reaching the trim/slip/fade math un-sanitised, and that
 * a failed audition load leaves the Audition button usable again.
 *
 * Run: `npx tsx src/components/layout/audioEditorPanelWiring.test.ts`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'AudioEditorPanel.tsx'),
  'utf8',
);

// ── the source-length fallback is converted to source seconds ──────────────
{
  assert.match(
    source,
    /clipDurationSec \* rate/,
    'a missing sourceDuration must fall back to clipDurationSec converted through rate — ' +
      'a clip at rate r eats r SOURCE seconds per TIMELINE second',
  );
  assert.doesNotMatch(
    source,
    /: clipDurationSec\)/,
    'the old fallback read TIMELINE seconds (clipDurationSec) as SOURCE seconds with no rate conversion',
  );
}

// ── no model call receives a raw clip ───────────────────────────────────────
{
  assert.doesNotMatch(
    source,
    /(trimStartTo|trimEndTo|slipSourceTo|resetTrims)\(\s*clip\b/,
    'trimStartTo/trimEndTo/slipSourceTo/resetTrims must take the sanitised dragClip, never the raw clip',
  );
}

// ── fade edits go through fadeTargetOf ──────────────────────────────────────
{
  assert.doesNotMatch(
    source,
    /(setFadeIn|setFadeOut)\(\s*clip\s*,/,
    'setFadeIn/setFadeOut must take fadeTargetOf(clip), never the raw clip',
  );
}

// ── the audition load has a failure path ────────────────────────────────────
{
  const start = source.indexOf('const startAudition');
  assert.ok(start >= 0, 'startAudition is defined in AudioEditorPanel.tsx');
  const closeIdx = source.indexOf('}, [', start);
  assert.ok(closeIdx >= 0, 'startAudition\'s useCallback closes with a dependency array');
  const body = source.slice(start, closeIdx);
  assert.match(
    body,
    /\.catch\(/,
    'the audition load has no failure path — a blob that fails to decode leaves the Audition button dead',
  );
}

console.log('audioEditorPanelWiring: all assertions passed');
