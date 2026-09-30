/**
 * vstLive/jitterBuffer — the play-out buffer the VST bridge worklet drains.
 *
 * The audio thread hands the host `block_size` frames at a time and gets them
 * back over a socket, so the return leg has jitter the render quantum does not
 * tolerate: a quantum must produce its samples NOW. The buffer absorbs that by
 * running `bufferBlocks` blocks behind, which makes the bridge's contribution
 * to latency a CONSTANT rather than a race:
 *
 *   delay = blockSize * (bufferBlocks + 1) frames
 *
 * The `+ 1` is the input side: a block is only sent once `blockSize` frames
 * have been accumulated, so the first sample of a block waits a whole block
 * before it even leaves. That number is what `vstLiveStore` reports as
 * `bridgeLatencySamples` and what plugin-delay compensation moves the mixer by,
 * so the buffer must never let it drift:
 *
 *  - Below the nominal depth it plays SILENCE (priming) rather than playing
 *    early, which would shorten the delay. "Nominal depth" is MORE THAN
 *    `bufferBlocks` blocks — the one being played plus `bufferBlocks` of
 *    reserve — which is what makes the realised delay equal the declared one.
 *  - A quantum it cannot fill completely is silenced WHOLE and the queue is
 *    cleared, which returns it to priming. Splicing part of a quantum would
 *    click; keeping the remainder would leave the block boundary offset from
 *    the quantum grid for the rest of the session.
 *
 * PURE: no audio context, no DOM, no allocation in `pull`. `public/vst-bridge.
 * worklet.js` runs the same algorithm by hand (a worklet cannot import app
 * source) — change both together. Mirrored 1:1: `push()` <-> `pushProcessed()`,
 * `pull()` <-> `pullProcessed()`.
 *
 * WHY TWO BLOCKS. T40a measured the native host's loopback round trip at
 * 0.12–0.15 ms average and 0.3 ms p99 per 512-frame block, against a block
 * period of 10.7 ms at 48 kHz — so the socket is not what this absorbs. What it
 * absorbs is the MAIN THREAD: the blocks cross a MessagePort, and a layout or a
 * garbage collection there can hold one up for several milliseconds while the
 * audio thread keeps running on time. Two blocks (21 ms of slack at 48 kHz) is
 * the protocol default and comfortably covers that; the cost is paid back
 * exactly, because plugin-delay compensation knows the number.
 *
 * Units: every count here is SAMPLE FRAMES per channel unless it says blocks.
 */

export interface JitterBufferOptions {
  /** Frames per block, as agreed with the host (`--block-size`). */
  blockSize: number;
  /** Channels per block. Every pushed block must carry exactly this many. */
  channels: number;
  /** Whole blocks held back before play-out starts (protocol default 2). */
  bufferBlocks: number;
}

const positiveInt = (v: number, field: string, min: number): number => {
  if (!Number.isInteger(v) || v < min) {
    throw new RangeError(`vstLive/jitterBuffer: ${field} must be an integer >= ${min}, got ${v}`);
  }
  return v;
};

/**
 * The bridge's own contribution to latency, in sample frames — everything
 * except the plugin's reported `latency_samples`.
 *
 * Exported separately because the store needs the number BEFORE a buffer
 * exists: an entry that is still `starting` already knows what the bridge will
 * cost once it is live.
 */
export function fixedDelayFrames(blockSize: number, bufferBlocks: number): number {
  positiveInt(blockSize, 'blockSize', 1);
  positiveInt(bufferBlocks, 'bufferBlocks', 0);
  return blockSize * (bufferBlocks + 1);
}

interface QueuedBlock {
  seq: number;
  channels: Float32Array[];
  /** Frames already drained out of this block. */
  read: number;
}

export class JitterBuffer {
  readonly blockSize: number;
  readonly channels: number;
  readonly bufferBlocks: number;
  /** Hard ceiling on queued blocks, so a burst cannot grow the queue forever. */
  readonly maxBlocks: number;

  private queue: QueuedBlock[] = [];
  private _primed = false;
  /** True from construction, and again on every re-prime, until `pull` first
   *  drains real audio. While true, `push` caps the queue to the nominal depth
   *  so a late prime or a post-underrun burst cannot leave the buffer holding
   *  more than it declared — see `push` below. */
  private _pendingFirstDrain = true;
  private _queuedFrames = 0;
  private _underruns = 0;
  private _overflows = 0;
  private _stale = 0;
  /** Highest seq accepted, so a repeat or a straggler is dropped rather than
   *  played out of order. `-1` = nothing accepted yet. */
  private lastSeq = -1;

  constructor(opts: JitterBufferOptions) {
    this.blockSize = positiveInt(opts.blockSize, 'blockSize', 1);
    this.channels = positiveInt(opts.channels, 'channels', 1);
    this.bufferBlocks = positiveInt(opts.bufferBlocks, 'bufferBlocks', 0);
    // Four times the nominal depth (at least four blocks): deep enough that a
    // normal burst is absorbed, shallow enough that a stalled audio thread
    // cannot accumulate seconds of stale audio to dump when it wakes up.
    this.maxBlocks = Math.max(4, this.bufferBlocks * 4);
  }

  /** Frames it will hold back once primed, including the input accumulator. */
  get delayFrames(): number {
    return fixedDelayFrames(this.blockSize, this.bufferBlocks);
  }

  /** True once play-out has reached its nominal depth. */
  get primed(): boolean {
    return this._primed;
  }

  get queuedBlocks(): number {
    return this.queue.length;
  }

  /** Frames still to play, across every queued block. */
  get queuedFrames(): number {
    return this._queuedFrames;
  }

  /** Quanta silenced because the host did not deliver in time. */
  get underruns(): number {
    return this._underruns;
  }

  /** Blocks dropped because the queue was too deep — either it hit
   *  `maxBlocks`, or a late prime / re-prime left more than the nominal depth
   *  queued before the first drain. */
  get overflows(): number {
    return this._overflows;
  }

  /** Blocks dropped as duplicate or out-of-order. */
  get stale(): number {
    return this._stale;
  }

  /**
   * Queue one processed block. `seq` is the sequence number the host echoed;
   * anything not strictly newer than the last accepted block is dropped.
   *
   * A block SHORTER than `blockSize` is accepted — the contract lets a frame
   * carry fewer frames than the block size — but a longer one, or one with the
   * wrong channel count, is a protocol violation and throws.
   */
  push(seq: number, channels: readonly Float32Array[]): void {
    if (channels.length !== this.channels) {
      throw new RangeError(
        `vstLive/jitterBuffer: block has ${channels.length} channels, buffer expects ${this.channels}`,
      );
    }
    const frames = channels[0].length;
    if (frames > this.blockSize) {
      throw new RangeError(
        `vstLive/jitterBuffer: block of ${frames} frames exceeds block size ${this.blockSize}`,
      );
    }
    for (let c = 1; c < channels.length; c += 1) {
      if (channels[c].length !== frames) {
        throw new RangeError('vstLive/jitterBuffer: block channels differ in length');
      }
    }
    if (this.lastSeq >= 0 && seq <= this.lastSeq) {
      this._stale += 1;
      return;
    }
    this.lastSeq = seq;
    if (this.queue.length >= this.maxBlocks) {
      const dropped = this.queue.shift();
      if (dropped) this._queuedFrames -= dropped.channels[0].length - dropped.read;
      this._overflows += 1;
    }
    this.queue.push({ seq, channels: channels.slice(), read: 0 });
    this._queuedFrames += frames;
    // MORE THAN `bufferBlocks`, not "at least": the block about to be played
    // plus `bufferBlocks` of reserve. That is exactly what makes the realised
    // delay `blockSize * (bufferBlocks + 1)` — block i is only complete at time
    // (i+1)*blockSize, so starting to play it once `bufferBlocks` further
    // blocks exist puts its first sample out at (i + bufferBlocks + 1) *
    // blockSize. Priming one block earlier would declare a delay to PDC that
    // the buffer does not actually hold.
    if (!this._primed && this.queue.length > this.bufferBlocks) this._primed = true;
    // A late prime (pushes keep arriving before `pull` ever drains real audio)
    // or a post-underrun burst can queue MORE than the nominal depth before
    // draining starts. Left alone, that excess is a permanent extra delay:
    // once push and pull settle into steady state the depth never shrinks
    // back (see the file header). So while a drain is still pending, cap the
    // queue back to exactly `bufferBlocks + 1` blocks, oldest first — the same
    // policy `maxBlocks` uses above — which re-anchors the offset to the delay
    // actually declared. (Mirrors `pushProcessed` in
    // `public/vst-bridge.worklet.js`.)
    if (this._pendingFirstDrain) {
      while (this.queue.length > this.bufferBlocks + 1) {
        const dropped = this.queue.shift();
        if (dropped) this._queuedFrames -= dropped.channels[0].length - dropped.read;
        this._overflows += 1;
      }
    }
  }

  /**
   * Drain `frames` frames per channel into `out`, which must hold at least that
   * many. Returns true when real audio was written; false when the quantum was
   * silenced (still priming, or an underrun — `underruns` tells them apart).
   *
   * `out` is ALWAYS written for the whole quantum, zeros included: a Web Audio
   * output buffer is recycled between calls and leaving it untouched would
   * replay whatever was in it.
   */
  pull(out: Float32Array[], frames: number): boolean {
    const silence = (): false => {
      for (let c = 0; c < out.length; c += 1) out[c].fill(0, 0, frames);
      return false;
    };
    if (!this._primed) return silence();
    if (this._queuedFrames < frames) {
      // Partial audio spliced onto silence is a click, and a queue left half
      // consumed keeps the block boundary off the quantum grid. Silence the
      // quantum whole, drop everything, and re-prime to the nominal depth.
      this._underruns += 1;
      this.queue.length = 0;
      this._queuedFrames = 0;
      this._primed = false;
      this._pendingFirstDrain = true;
      return silence();
    }

    this._pendingFirstDrain = false;
    let written = 0;
    while (written < frames) {
      const head = this.queue[0];
      const avail = head.channels[0].length - head.read;
      const take = Math.min(avail, frames - written);
      for (let c = 0; c < out.length; c += 1) {
        // A buffer configured for more channels than the output asks for simply
        // drops the extra; fewer, and the last one is repeated (mono -> both).
        const src = head.channels[Math.min(c, head.channels.length - 1)];
        out[c].set(src.subarray(head.read, head.read + take), written);
      }
      head.read += take;
      written += take;
      this._queuedFrames -= take;
      if (head.read >= head.channels[0].length) this.queue.shift();
    }
    return true;
  }

  /** Back to the state a fresh buffer is in, stats included. */
  reset(): void {
    this.queue.length = 0;
    this._primed = false;
    this._pendingFirstDrain = true;
    this._queuedFrames = 0;
    this._underruns = 0;
    this._overflows = 0;
    this._stale = 0;
    this.lastSeq = -1;
  }
}
