/**
 * renderRangePlan — turns a `RenderRange` (renderRange.ts's F24 frame
 * contract) into the concrete arithmetic an offline render needs before any
 * audio node exists: where the render context actually has to start, how
 * many frames it must produce, and which of those frames end up in the
 * finished file. Frames only, never seconds — the engine is stereo at one
 * fixed rate (`RENDER_SAMPLE_RATE`, 44.1 kHz), so a frame count is
 * sample-exact and a second count is not.
 *
 * Preroll is rendered and then thrown away: effects with memory (reverb,
 * delay, a compressor's slow release) need to reach the state a full render
 * would have put them in before the first frame that is actually kept, so
 * the context is asked to start at `renderStartFrame` — the preroll pulled
 * forward, clamped at the project start — rather than at `startFrame`
 * itself. The tail is the mirror case: it is rendered PAST `endFrame` and,
 * unlike preroll, it is KEPT (`keepFrames` includes it), so a reverb tail
 * does not get cut off dead at the selection edge.
 *
 * Pure frame math: no AudioContext, no DOM, no store, so this runs under
 * plain tsx and the renderer wiring (F24-2) reduces to calling
 * `planRangeRender` and then `sliceRangeBuffer` on whatever the context
 * produced.
 */
import { keptFrameCount, renderedFrameCount, RENDER_SAMPLE_RATE, type RenderRange } from './renderRange';

/** The frame arithmetic for one range render, fixed before any audio node exists. */
export interface RangeRenderPlan {
  /** First frame the offline context is asked to render, never below project frame 0. */
  renderStartFrame: number;
  /** `renderStartFrame` restated in seconds, for the APIs that still take a start time. */
  renderStartSec: number;
  /** Total frames the context must produce — preroll and tail included. */
  contextFrames: number;
  /** Leading frames to drop from the rendered buffer — the preroll that was actually rendered. */
  keepFromFrame: number;
  /** Frames kept in the finished file — the selection plus its tail. */
  keepFrames: number;
}

/**
 * Plans a range render in frames.
 *
 * Defensive by design: `rangeFromSeconds` already produces a well-formed
 * `RenderRange` (preroll clamped to fit before `startFrame`, nothing
 * negative), but this module is the last stop before frame math and never
 * assumes that — a negative `startFrame`, `prerollFrames` or `tailFrames` is
 * clamped to 0 before anything is computed from it, and a preroll that is
 * simply larger than `startFrame` clamps `renderStartFrame` to 0 through the
 * same formula rather than a special case.
 *
 * Throws when the range covers zero or a negative number of frames — there
 * is no render to plan for a selection that keeps nothing.
 */
export function planRangeRender(range: RenderRange, sampleRate: number = RENDER_SAMPLE_RATE): RangeRenderPlan {
  const startFrame = Math.max(0, range.startFrame);
  const prerollFrames = Math.max(0, range.prerollFrames);
  const tailFrames = Math.max(0, range.tailFrames);
  const { endFrame } = range;

  if (endFrame <= startFrame) {
    throw new Error('render range must cover at least one frame');
  }

  const renderStartFrame = Math.max(0, startFrame - prerollFrames);

  return {
    renderStartFrame,
    renderStartSec: renderStartFrame / sampleRate,
    contextFrames: (endFrame + tailFrames) - renderStartFrame,
    keepFromFrame: startFrame - renderStartFrame,
    keepFrames: (endFrame - startFrame) + tailFrames,
  };
}

/**
 * Cuts a rendered buffer down to the plan's contract: drops `keepFromFrame`
 * leading frames (the rendered-and-discarded preroll) and returns exactly
 * `keepFrames` frames per channel. A context that produced fewer frames than
 * asked — the last range in a project that ends mid-tail, for instance — is
 * zero-filled at the tail rather than shortening the file, the same rule
 * `renderCore.ts`'s `trimLeadingSec` applies to the whole-project bounce.
 *
 * Pure: the input buffer is never read past `getChannelData`/`length` and is
 * never mutated. The return value is the same structural stand-in
 * `trimLeadingSec` hands back — a plain object exposing exactly the five
 * members `lib/wavEncode` reads (`duration`, `length`, `sampleRate`,
 * `numberOfChannels`, `getChannelData`), cast to `AudioBuffer` — not a real
 * one, since no context exists here to create one from.
 */
export function sliceRangeBuffer(buffer: AudioBuffer, plan: RangeRenderPlan): AudioBuffer {
  const { sampleRate, numberOfChannels } = buffer;
  const skip = Math.max(0, plan.keepFromFrame);
  const length = Math.max(0, plan.keepFrames);
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch += 1) {
    const out = new Float32Array(length); // zero-filled: a short context pads for free
    const src = buffer.getChannelData(ch);
    const take = Math.min(length, Math.max(0, src.length - skip));
    if (take > 0) out.set(src.subarray(skip, skip + take), 0);
    channels.push(out);
  }
  return {
    duration: length / sampleRate,
    length,
    sampleRate,
    numberOfChannels,
    getChannelData: (ch: number) => channels[ch],
  } as unknown as AudioBuffer;
}

/**
 * True when `plan` is what `planRangeRender(range, ...)` would produce,
 * cross-checked against `renderRange.ts`'s own frame counts rather than by
 * recomputing the plan. The exact relation:
 *
 *   plan.keepFrames    === keptFrameCount(range)
 *   plan.contextFrames === renderedFrameCount(range) - clampedAwayPreroll
 *
 * where `clampedAwayPreroll` is the slice of the requested preroll that
 * never actually got rendered because `startFrame - prerollFrames` went past
 * the project start and `renderStartFrame` clamped to 0 instead of going
 * negative — i.e. the requested preroll minus the preroll actually recorded
 * in `keepFromFrame`. For a well-formed range (preroll already clamped to
 * fit `startFrame`, as `rangeFromSeconds` guarantees) `clampedAwayPreroll` is
 * 0 and `contextFrames` equals `renderedFrameCount` exactly.
 */
export function planMatchesRange(plan: RangeRenderPlan, range: RenderRange): boolean {
  const requestedPreroll = Math.max(0, range.prerollFrames);
  const clampedAwayPreroll = requestedPreroll - plan.keepFromFrame;
  return (
    plan.keepFrames === keptFrameCount(range) &&
    plan.contextFrames === renderedFrameCount(range) - clampedAwayPreroll
  );
}
