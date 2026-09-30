// Shared contract for rendering part of the timeline (F24) and for the export
// dialog that offers it (F25). Frames, never seconds: a range render must be
// sample-exact, and the engine runs at one fixed rate (44.1 kHz stereo).
//
// Preroll exists so effects with memory (reverb, delay, compressors with slow
// release) reach the state they would have had in a full render before the
// first kept frame. The preroll is rendered and then discarded. The tail is
// rendered AFTER the end frame and kept, so a reverb does not stop dead.

export const RENDER_SAMPLE_RATE = 44100

export type RenderRange = {
  /** First kept frame, inclusive. */
  startFrame: number
  /** Frame after the last kept frame of the selection itself (exclusive). */
  endFrame: number
  /** Frames rendered before startFrame and thrown away. Clamped at the project start. */
  prerollFrames: number
  /** Frames rendered after endFrame and kept (effect tails). */
  tailFrames: number
}

export const DEFAULT_PREROLL_SEC = 2
export const MAX_TAIL_SEC = 10

export function secToFrame(sec: number, sampleRate: number = RENDER_SAMPLE_RATE): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0
  return Math.round(sec * sampleRate)
}

export function frameToSec(frame: number, sampleRate: number = RENDER_SAMPLE_RATE): number {
  return frame / sampleRate
}

/**
 * Builds a range from a time selection in seconds. Returns null when the
 * selection is empty or not finite, so callers cannot queue a zero-length render.
 */
export function rangeFromSeconds(
  startSec: number,
  endSec: number,
  opts: { prerollSec?: number; tailSec?: number; sampleRate?: number } = {},
): RenderRange | null {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null
  const sampleRate = opts.sampleRate ?? RENDER_SAMPLE_RATE
  const lo = Math.max(0, Math.min(startSec, endSec))
  const hi = Math.max(0, Math.max(startSec, endSec))
  const startFrame = secToFrame(lo, sampleRate)
  const endFrame = secToFrame(hi, sampleRate)
  if (endFrame <= startFrame) return null
  const wantedPreroll = secToFrame(opts.prerollSec ?? DEFAULT_PREROLL_SEC, sampleRate)
  const tailSec = Math.min(MAX_TAIL_SEC, Math.max(0, opts.tailSec ?? 0))
  return {
    startFrame,
    endFrame,
    prerollFrames: Math.min(wantedPreroll, startFrame),
    tailFrames: secToFrame(tailSec, sampleRate),
  }
}

/** Frames the renderer has to produce, including the discarded preroll. */
export function renderedFrameCount(range: RenderRange): number {
  return range.prerollFrames + (range.endFrame - range.startFrame) + range.tailFrames
}

/** Frames in the finished file. */
export function keptFrameCount(range: RenderRange): number {
  return range.endFrame - range.startFrame + range.tailFrames
}
