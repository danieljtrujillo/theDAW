// Run with: npx tsx src/components/render/renderRangeDialogModel.test.ts
import assert from 'node:assert/strict';
import { DEFAULT_PREROLL_SEC, MAX_TAIL_SEC, keptFrameCount, secToFrame } from '../../lib/render/renderRange';
import {
  DEFAULT_RANGE_FORM,
  type RangeRenderForm,
  type RangeRenderPlanResult,
  clampPrerollSec,
  clampTailSec,
  planRangeRenderJob,
  rangeRenderTitle,
  tailHint,
} from './renderRangeDialogModel';

// a null selection is refused with the select-a-range reason
{
  const result = planRangeRenderJob(null, DEFAULT_RANGE_FORM);
  assert.deepEqual(result, { ok: false, reason: 'Select a time range on the timeline first' });
}

// a zero-length selection is refused with the empty-range reason
{
  const result = planRangeRenderJob({ startSec: 4, endSec: 4 }, DEFAULT_RANGE_FORM);
  assert.deepEqual(result, { ok: false, reason: 'The time range is empty' });
}

// tail seconds clamp to 0..10 and a NaN falls back to 0
{
  assert.equal(clampTailSec(5), 5);
  assert.equal(clampTailSec(MAX_TAIL_SEC + 5), MAX_TAIL_SEC);
  assert.equal(clampTailSec(-3), 0);
  assert.equal(clampTailSec(Number.NaN), 0);
  assert.equal(clampTailSec(Number.POSITIVE_INFINITY), 0);
}

// preroll defaults to DEFAULT_PREROLL_SEC for a NaN and clamps at 30
{
  assert.equal(clampPrerollSec(Number.NaN), DEFAULT_PREROLL_SEC);
  assert.equal(clampPrerollSec(45), 30);
  assert.equal(clampPrerollSec(-5), 0);
  assert.equal(clampPrerollSec(10), 10);
}

// an empty name becomes a timestamped range_*.wav
{
  assert.equal(rangeRenderTitle('', () => 1234567890123), 'range_890123.wav');
  // whitespace-only is empty too
  assert.equal(rangeRenderTitle('   ', () => 42), 'range_42.wav');
}

// a typed name gains .wav exactly once
{
  assert.equal(rangeRenderTitle('intro fade'), 'intro fade.wav');
  assert.equal(rangeRenderTitle('intro fade.wav'), 'intro fade.wav');
  assert.equal(rangeRenderTitle('  intro fade  '), 'intro fade.wav');
}

// a valid form produces a RenderRange whose kept length is the selection plus the tail
{
  const form: RangeRenderForm = { name: 'take', tailSec: 3, prerollSec: 1 };
  const sel = { startSec: 2, endSec: 6 };
  const result = planRangeRenderJob(sel, form, () => 999);
  assert.equal(result.ok, true);
  // Non-strict tsconfig (no strictNullChecks) does not narrow a boolean
  // discriminant through `if (!result.ok)`, so assert first, then cast.
  const ok = result as Extract<RangeRenderPlanResult, { ok: true }>;
  assert.equal(ok.title, 'take.wav');
  assert.equal(keptFrameCount(ok.range), secToFrame(sel.endSec - sel.startSec) + secToFrame(form.tailSec));
}

// tailHint text
{
  assert.equal(tailHint(0), 'No effect tail');
  assert.equal(tailHint(3), 'Keeps 2.5 s of effect tail');
}

console.log('renderRangeDialogModel: all assertions passed');
