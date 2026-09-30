/**
 * renderRangePlan's pure frame arithmetic: given a `RenderRange` (F24's frame
 * contract), pins where the offline context actually starts (preroll pulled
 * forward, clamped at the project start), how many frames it must produce,
 * and which frames of the finished buffer are kept. No AudioContext, no DOM,
 * no store — the whole suite runs under plain tsx.
 *
 * What is pinned here:
 *
 *  - a mid-project range renders its preroll and discards exactly that many
 *    leading frames from the kept buffer;
 *  - a range that cannot fit its full preroll before the project start (frame
 *    0) clamps the render start to 0 rather than going negative — covering
 *    both the natural case (`rangeFromSeconds` already clamped it) and a
 *    hand-built range with raw-negative fields, since this module must not
 *    assume a well-formed input;
 *  - the tail is rendered past `endFrame` and, unlike preroll, is KEPT;
 *  - a zero-length or inverted range throws rather than planning a render;
 *  - `sliceRangeBuffer` is pure (never mutates its input) and always returns
 *    exactly `plan.keepFrames` per channel, zero-filling a shortfall at the
 *    tail rather than shortening the file — the same rule `renderCore.ts`'s
 *    `trimLeadingSec` applies to the whole-project bounce;
 *  - `planMatchesRange` agrees with `renderRange.ts`'s own frame counts,
 *    including through a clamped-preroll plan.
 *
 * Run: npx tsx src/lib/render/renderRangePlan.test.ts
 */
import assert from 'node:assert/strict';

import {
  keptFrameCount,
  rangeFromSeconds,
  renderedFrameCount,
  RENDER_SAMPLE_RATE,
  type RenderRange,
} from './renderRange.ts';
import {
  planMatchesRange,
  planRangeRender,
  sliceRangeBuffer,
  type RangeRenderPlan,
} from './renderRangePlan.ts';

/** A structural stand-in AudioBuffer, the same shape `renderCore.ts` uses. */
function fakeBuffer(channels: number[][], sampleRate = RENDER_SAMPLE_RATE): AudioBuffer {
  const data = channels.map((ch) => Float32Array.from(ch));
  const length = data[0]?.length ?? 0;
  return {
    duration: length / sampleRate,
    length,
    sampleRate,
    numberOfChannels: data.length,
    getChannelData: (ch: number) => data[ch],
  } as unknown as AudioBuffer;
}

async function main(): Promise<void> {
  /* ── 1. a mid-project range renders its preroll and keeps only the selection ── */
  {
    const range: RenderRange = {
      startFrame: 88200, // 2s
      endFrame: 176400, // 4s
      prerollFrames: 44100, // 1s, fits before startFrame
      tailFrames: 0,
    };
    const plan = planRangeRender(range);
    assert.equal(plan.renderStartFrame, 44100, 'context starts one second of preroll before the selection');
    assert.equal(plan.renderStartSec, 1, 'restated in seconds at RENDER_SAMPLE_RATE');
    assert.equal(plan.contextFrames, 132300, 'preroll + selection, no tail');
    assert.equal(plan.keepFromFrame, 44100, 'the whole rendered preroll is discarded');
    assert.equal(plan.keepFrames, 88200, 'only the 2s selection is kept');
  }

  /* ── 2. a range at the project start clamps the preroll to zero and keeps from frame 0 ── */
  {
    // Natural case: rangeFromSeconds itself already clamps prerollFrames to
    // fit before a startFrame of 0, so the plan sees a request for no preroll.
    const atStart = rangeFromSeconds(0, 2, { prerollSec: 2 })!;
    assert.equal(atStart.prerollFrames, 0, 'rangeFromSeconds already clamped preroll to 0 at the project start');
    const planAtStart = planRangeRender(atStart);
    assert.equal(planAtStart.renderStartFrame, 0);
    assert.equal(planAtStart.keepFromFrame, 0, 'nothing to discard: the context starts exactly at the selection');

    // Defensive case: a hand-built range this module must not trust — preroll
    // that overshoots startFrame, plus raw-negative fields — still clamps to
    // frame 0 rather than requesting a negative render start.
    const malformed: RenderRange = {
      startFrame: -50,
      endFrame: 100,
      prerollFrames: -20,
      tailFrames: -5,
    };
    const planMalformed = planRangeRender(malformed);
    assert.equal(planMalformed.renderStartFrame, 0, 'negative startFrame clamps to the project start');
    assert.equal(planMalformed.keepFromFrame, 0);
    assert.equal(planMalformed.keepFrames, 100, 'negative tailFrames clamps to 0, not a reduction');
    assert.equal(planMalformed.contextFrames, 100);

    // A request whose preroll overshoots startFrame (larger than it, not just
    // negative) also clamps renderStartFrame to 0 rather than going negative.
    const overshoot: RenderRange = { startFrame: 100, endFrame: 1000, prerollFrames: 5000, tailFrames: 0 };
    const planOvershoot = planRangeRender(overshoot);
    assert.equal(planOvershoot.renderStartFrame, 0);
    assert.equal(planOvershoot.keepFromFrame, 100, 'only the 100 frames actually rendered before startFrame are discarded');
  }

  /* ── 3. tail frames are rendered after the end frame and KEPT ─────────────── */
  {
    const range: RenderRange = { startFrame: 44100, endFrame: 88200, prerollFrames: 0, tailFrames: 22050 };
    const plan = planRangeRender(range);
    assert.equal(plan.contextFrames, 66150, 'context runs 0.5s past endFrame for the tail');
    assert.equal(plan.keepFrames, 66150, 'the tail is kept, not discarded like preroll');
    assert.ok(plan.keepFrames > range.endFrame - range.startFrame, 'kept frames exceed the bare selection because of the tail');
    // Invariant: the only frames dropped between context and kept output are
    // the discarded preroll — the tail is on both sides of the subtraction.
    assert.equal(plan.contextFrames - plan.keepFrames, plan.keepFromFrame);
  }

  /* ── 4. a zero-length or inverted range throws ────────────────────────────── */
  {
    const zeroLength: RenderRange = { startFrame: 1000, endFrame: 1000, prerollFrames: 0, tailFrames: 0 };
    assert.throws(
      () => planRangeRender(zeroLength),
      /render range must cover at least one frame/,
      'endFrame === startFrame keeps nothing',
    );
    const inverted: RenderRange = { startFrame: 1000, endFrame: 500, prerollFrames: 0, tailFrames: 0 };
    assert.throws(
      () => planRangeRender(inverted),
      /render range must cover at least one frame/,
      'endFrame < startFrame is backwards',
    );
  }

  /* ── 5. sliceRangeBuffer returns exactly keepFrames per channel and does not mutate the input ── */
  {
    const left = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const right = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const buffer = fakeBuffer([left, right]);
    const beforeLeft = buffer.getChannelData(0).slice();
    const beforeRight = buffer.getChannelData(1).slice();

    const plan: RangeRenderPlan = {
      renderStartFrame: 0,
      renderStartSec: 0,
      contextFrames: 10,
      keepFromFrame: 3,
      keepFrames: 5,
    };
    const sliced = sliceRangeBuffer(buffer, plan);

    assert.equal(sliced.length, 5);
    assert.equal(sliced.numberOfChannels, 2);
    assert.equal(sliced.duration, 5 / RENDER_SAMPLE_RATE);
    assert.deepEqual([...sliced.getChannelData(0)], [4, 5, 6, 7, 8], 'drops the first 3 frames of channel 0');
    assert.deepEqual([...sliced.getChannelData(1)], [14, 15, 16, 17, 18], 'drops the first 3 frames of channel 1');

    // Input untouched.
    assert.deepEqual([...buffer.getChannelData(0)], [...beforeLeft]);
    assert.deepEqual([...buffer.getChannelData(1)], [...beforeRight]);
  }

  /* ── 6. a short context is zero-filled at the tail rather than shortening the file ── */
  {
    // Only 15 frames rendered; skipping 10 leaves 5 real frames where 20 were asked for.
    const source = Array.from({ length: 15 }, (_, i) => i + 1);
    const buffer = fakeBuffer([source]);
    const plan: RangeRenderPlan = {
      renderStartFrame: 0,
      renderStartSec: 0,
      contextFrames: 15,
      keepFromFrame: 10,
      keepFrames: 20,
    };
    const sliced = sliceRangeBuffer(buffer, plan);

    assert.equal(sliced.length, 20, 'the file is exactly plan.keepFrames long, not shortened to what was available');
    const data = [...sliced.getChannelData(0)];
    assert.deepEqual(data.slice(0, 5), [11, 12, 13, 14, 15], 'the 5 real frames that existed past the skip');
    assert.deepEqual(data.slice(5), new Array(15).fill(0), 'the shortfall is zero-filled, not left undefined or trimmed');
  }

  /* ── 7. planMatchesRange agrees with renderedFrameCount/keptFrameCount ────── */
  {
    // Well-formed range: no clamping occurs, so contextFrames equals
    // renderedFrameCount exactly (clampedAwayPreroll is 0).
    const range = rangeFromSeconds(2, 4, { prerollSec: 1, tailSec: 0.5 })!;
    const plan = planRangeRender(range);
    assert.equal(plan.keepFrames, keptFrameCount(range));
    assert.equal(plan.contextFrames, renderedFrameCount(range));
    assert.ok(planMatchesRange(plan, range));

    // Clamped-preroll range: contextFrames is renderedFrameCount() MINUS the
    // slice of preroll that never got rendered (requested preroll minus the
    // preroll actually kept in keepFromFrame) — planMatchesRange must still
    // agree, proving the relation holds through clamping, not just the
    // well-formed case.
    const overshoot: RenderRange = { startFrame: 100, endFrame: 1000, prerollFrames: 5000, tailFrames: 10 };
    const overshootPlan = planRangeRender(overshoot);
    const clampedAwayPreroll = overshoot.prerollFrames - overshootPlan.keepFromFrame;
    assert.equal(clampedAwayPreroll, 4900);
    assert.equal(overshootPlan.contextFrames, renderedFrameCount(overshoot) - clampedAwayPreroll);
    assert.ok(planMatchesRange(overshootPlan, overshoot), 'planMatchesRange accounts for the clamped-away preroll');
  }

  console.log('renderRangePlan: all assertions passed');
}

await main();
