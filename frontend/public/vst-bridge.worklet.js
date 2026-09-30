/**
 * vst-bridge.worklet.js — the audio-thread half of the live VST host bridge.
 *
 * The native host processes `block_size` frames at a time over a WebSocket, but
 * a render quantum is 128 frames and must produce its samples NOW. This
 * processor bridges the two:
 *
 *   in  : accumulate quanta into a block, post it to the main thread (transfer)
 *   out : play processed blocks back from a jitter buffer that runs
 *         `bufferBlocks` blocks behind, so the return leg's jitter never
 *         reaches the output
 *
 * The delay that costs is therefore a CONSTANT, which is the only reason
 * plugin-delay compensation can correct for it:
 *
 *   delay = blockSize * (bufferBlocks + 1) frames
 *
 * (the `+ 1` is the input accumulator: a block's first sample waits a whole
 * block before it is even sent). `lib/vstLive/jitterBuffer.ts` holds the same
 * algorithm in testable form — the two are mirrors and must be changed
 * together. A worklet module is loaded by URL into a separate global scope and
 * cannot import app source, which is why it is written twice rather than once.
 * Mirrored 1:1: `pushProcessed()` <-> `push()`, `pullProcessed()` <-> `pull()`.
 *
 * NEVER SILENT. Three output sources, all of them audible:
 *   live + primed      -> the plugin's output
 *   live, not primed   -> the DRY signal delayed by the same fixed delay, so
 *                         priming and an underrun do not shift the timeline
 *   not live           -> the dry signal with NO delay (the session is down;
 *                         the store declares 0 latency to match)
 * Moving between the delayed and the undelayed world is crossfaded over
 * `RAMP_FRAMES`, because those are two copies of the same signal at different
 * times and a hard switch is a click.
 *
 * Port protocol (see lib/vstLive/vstLiveNode.ts):
 *   worklet -> node  {type:'block', seq, frames, playing, discontinuity,
 *                     positionSamples, tempoBpm, channels:[Float32Array]}
 *                    {type:'stats', underruns, overflows}
 *   node -> worklet  {type:'processed', seq, frames, channels:[Float32Array]}
 *                    {type:'transport', playing, positionSamples, tempoBpm,
 *                     discontinuity, atTime?, freeRun?}
 *                    {type:'live', live:boolean}
 *                    {type:'audio-port', port:MessagePort}
 *
 * `atTime` (context seconds) is the time `positionSamples` holds at: the
 * position the next quantum starts on is `positionSamples` plus the frames
 * between `atTime` and that quantum, however late the message lands, so a
 * position the main thread computed for a moment ahead is exact.
 * `freeRun` advances the position every quantum even while `playing` is false,
 * so MIDI stamped on the position (a piano-roll part auditioned with its
 * transport stopped) still plays on time. Both are absent from EDIT's
 * transport, which holds the position while stopped, as it always did.
 *
 * `audio-port` is how the audio leaves the main thread. The node hands over one
 * end of a channel whose other end belongs to the bridge WORKER, and from then
 * on blocks go there and processed blocks come back from there — the main
 * thread is not in the path at all, so a layout or a React render cannot stall
 * it. `this.port` stays for stats (and for the runtime that has no worker),
 * and `processed` is accepted on either port because a handover can land
 * between two blocks.
 *
 * No AudioParams: every control travels over the WebSocket to the host, not
 * through the audio graph.
 */

/** Frames the dry/processed crossfade takes (~5 ms at 48 kHz). */
const RAMP_FRAMES = 256;
/** Quanta between stats posts (~0.7 s at 48 kHz) — cheap, and only when moved. */
const STATS_EVERY = 256;

class VstBridgeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.blockSize = Math.max(1, opts.blockSize | 0 || 512);
    this.bufferBlocks = Math.max(0, opts.bufferBlocks | 0);
    this.channels = Math.max(1, opts.channels | 0 || 2);

    /** Fixed bridge delay, in frames. Mirrors jitterBuffer.fixedDelayFrames. */
    this.delayFrames = this.blockSize * (this.bufferBlocks + 1);

    // ── input accumulator ────────────────────────────────────────────────
    this.accum = this.allocBlock();
    this.accumFill = 0;
    this.seq = 0;
    /** Timeline position of the accumulator's FIRST frame. */
    this.blockStartPos = 0;

    // ── play-out queue (the jitterBuffer algorithm) ──────────────────────
    this.queue = [];
    this.queuedFrames = 0;
    this.primed = false;
    // True from construction, and again on every re-prime (see resync), until
    // pullProcessed first drains real audio. While true, pushProcessed caps
    // the queue to the nominal depth. (Mirrors JitterBuffer._pendingFirstDrain
    // in lib/vstLive/jitterBuffer.ts.)
    this.pendingFirstDrain = true;
    this.lastSeq = -1;
    this.maxBlocks = Math.max(4, this.bufferBlocks * 4);
    this.underruns = 0;
    this.overflows = 0;
    /** Processed blocks accepted into the play-out queue: the proof that the plugin is IN the path. */
    this.processedBlocks = 0;

    // ── dry delay line, long enough for the delay plus a block of slack ──
    this.ringLen = this.delayFrames + this.blockSize * 2 + RAMP_FRAMES;
    this.ring = [];
    for (let c = 0; c < this.channels; c += 1) this.ring.push(new Float32Array(this.ringLen));
    this.ringWrite = 0;

    // ── transport ────────────────────────────────────────────────────────
    this.playing = false;
    this.position = 0;
    this.tempo = 0;
    this.pendingDiscontinuity = false;
    /** Advance the position while stopped too (the transport message's `freeRun`). */
    this.freeRun = false;
    /** A position to take at the next quantum: {pos, atTime} (see the port protocol's `atTime`). */
    this.anchor = null;

    // ── scratch buffers (never allocated inside process()) ───────────────
    this.wetBuf = [];
    this.dryBuf = [];
    for (let c = 0; c < this.channels; c += 1) {
      this.wetBuf.push(new Float32Array(128));
      this.dryBuf.push(new Float32Array(128));
    }

    // ── liveness + crossfade ─────────────────────────────────────────────
    this.live = false;
    /** 0 = undelayed dry, 1 = the delayed (plugin) world. */
    this.blend = 0;
    this.statsTick = 0;
    this.lastStats = '';

    /** The bridge worker's channel, once the node has handed it over. Until
     *  then (and without a worker at all) blocks go out on `this.port`. */
    this.audioPort = null;

    this.port.onmessage = (ev) => this.onMessage(ev.data);
  }

  allocBlock() {
    const b = [];
    for (let c = 0; c < this.channels; c += 1) b.push(new Float32Array(this.blockSize));
    return b;
  }

  onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'processed') {
      this.pushProcessed(msg.seq, msg.channels);
      return;
    }
    if (msg.type === 'audio-port') {
      this.setAudioPort(msg.port || null);
      return;
    }
    if (msg.type === 'transport') {
      this.playing = !!msg.playing;
      this.freeRun = !!msg.freeRun;
      this.tempo = Number.isFinite(msg.tempoBpm) ? msg.tempoBpm : 0;
      if (Number.isFinite(msg.positionSamples)) {
        // With `atTime` the position is taken at the next quantum, run on by the
        // time since `atTime` (process() below), so it lands exactly.
        if (Number.isFinite(msg.atTime)) this.anchor = { pos: msg.positionSamples, atTime: msg.atTime };
        else {
          this.anchor = null;
          this.position = msg.positionSamples;
        }
      }
      if (msg.discontinuity) {
        // Start / seek / loop wrap: the host calls the plugin's reset(), and
        // anything already queued belongs to the old timeline.
        this.pendingDiscontinuity = true;
        this.resync();
      }
      return;
    }
    if (msg.type === 'live') {
      const live = !!msg.live;
      if (live !== this.live) {
        this.live = live;
        // A session that dropped leaves stale blocks queued; a session that
        // came up starts its stream from scratch.
        this.resync();
      }
    }
  }

  /**
   * Take (or drop) the channel to the bridge worker.
   *
   * A reconnect that re-created the session hands over a NEW channel, so the
   * previous one is closed rather than left holding a reference to a worker
   * nobody talks to any more.
   */
  setAudioPort(port) {
    const previous = this.audioPort;
    this.audioPort = port;
    if (previous && previous !== port) {
      previous.onmessage = null;
      try {
        previous.close();
      } catch {
        /* already gone */
      }
    }
    if (port) {
      port.onmessage = (ev) => this.onMessage(ev.data);
      // Assigning onmessage already starts the port; this is belt for a runtime
      // that only delivers after an explicit start().
      if (typeof port.start === 'function') port.start();
    }
  }

  /** Drop the play-out queue and re-prime. Mirrors JitterBuffer's resync. */
  resync() {
    this.queue.length = 0;
    this.queuedFrames = 0;
    this.primed = false;
    this.lastSeq = -1;
    this.pendingFirstDrain = true;
  }

  pushProcessed(seq, channels) {
    if (!channels || channels.length === 0) return;
    if (this.lastSeq >= 0 && seq <= this.lastSeq) return; // duplicate or straggler
    this.lastSeq = seq;
    this.processedBlocks += 1;
    if (this.queue.length >= this.maxBlocks) {
      const dropped = this.queue.shift();
      if (dropped) this.queuedFrames -= dropped.channels[0].length - dropped.read;
      this.overflows += 1;
    }
    this.queue.push({ channels, read: 0 });
    this.queuedFrames += channels[0].length;
    // MORE THAN bufferBlocks: the block about to be played plus bufferBlocks of
    // reserve. Priming one block earlier would make the realised delay shorter
    // than the one declared to plugin-delay compensation. (Mirrors
    // JitterBuffer.push in lib/vstLive/jitterBuffer.ts.)
    if (!this.primed && this.queue.length > this.bufferBlocks) this.primed = true;
    // A late prime or a post-underrun burst can queue more than the nominal
    // depth before pullProcessed ever drains real audio; left alone that
    // excess is a permanent extra delay (steady-state push/pull never shrinks
    // it back). While a drain is still pending, cap back to exactly
    // bufferBlocks + 1 blocks, oldest first — the same policy maxBlocks uses
    // above. (Mirrors JitterBuffer.push in lib/vstLive/jitterBuffer.ts.)
    if (this.pendingFirstDrain) {
      while (this.queue.length > this.bufferBlocks + 1) {
        const dropped = this.queue.shift();
        if (dropped) this.queuedFrames -= dropped.channels[0].length - dropped.read;
        this.overflows += 1;
      }
    }
  }

  /** Read `n` frames out of the dry delay line, `delay` frames behind write. */
  readDelayed(dest, n, delay) {
    const len = this.ringLen;
    let read = this.ringWrite - delay - n;
    while (read < 0) read += len;
    for (let c = 0; c < dest.length; c += 1) {
      const src = this.ring[Math.min(c, this.ring.length - 1)];
      const out = dest[c];
      let r = read;
      for (let i = 0; i < n; i += 1) {
        out[i] = src[r];
        r += 1;
        if (r >= len) r = 0;
      }
    }
  }

  /** Drain `n` frames of processed audio; false when it had to silence them. */
  pullProcessed(dest, n) {
    if (!this.primed) return false;
    if (this.queuedFrames < n) {
      // Partial audio spliced onto silence is a click, and a half-consumed
      // queue leaves the block boundary off the quantum grid for good.
      this.underruns += 1;
      this.resync();
      return false;
    }
    this.pendingFirstDrain = false;
    let written = 0;
    while (written < n) {
      const head = this.queue[0];
      const avail = head.channels[0].length - head.read;
      const take = avail < n - written ? avail : n - written;
      for (let c = 0; c < dest.length; c += 1) {
        const src = head.channels[Math.min(c, head.channels.length - 1)];
        dest[c].set(src.subarray(head.read, head.read + take), written);
      }
      head.read += take;
      written += take;
      this.queuedFrames -= take;
      if (head.read >= head.channels[0].length) this.queue.shift();
    }
    return true;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    // Per MDN: the quantum is 128 frames today but MUST be read from the array
    // rather than assumed, so this stays correct if the spec lets it change.
    const n = output[0].length;
    const input = inputs[0];
    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : inL;

    // 0. A position anchored at a context time: where the clock is at this
    //    quantum's first frame (`currentTime` is that frame's time).
    if (this.anchor) {
      const running = this.playing || this.freeRun;
      this.position = this.anchor.pos + (running ? Math.round((currentTime - this.anchor.atTime) * sampleRate) : 0);
      this.anchor = null;
    }

    // 1. Write the dry signal into the delay line and the block accumulator.
    const len = this.ringLen;
    let w = this.ringWrite;
    for (let i = 0; i < n; i += 1) {
      this.ring[0][w] = inL ? inL[i] : 0;
      if (this.ring.length > 1) this.ring[1][w] = inR ? inR[i] : 0;
      w += 1;
      if (w >= len) w = 0;
    }
    this.ringWrite = w;

    if (this.accumFill === 0) this.blockStartPos = this.position;
    let taken = 0;
    while (taken < n) {
      const room = this.blockSize - this.accumFill;
      const take = room < n - taken ? room : n - taken;
      if (inL) this.accum[0].set(inL.subarray(taken, taken + take), this.accumFill);
      if (this.accum.length > 1 && inR) this.accum[1].set(inR.subarray(taken, taken + take), this.accumFill);
      this.accumFill += take;
      taken += take;
      if (this.accumFill >= this.blockSize) {
        this.postBlock();
        if (taken < n) this.blockStartPos = this.position + taken;
      }
    }

    // 2. Produce the two candidate outputs.
    //    `wet` is the delayed world (the plugin, or the dry signal delayed by
    //    exactly the same amount while priming), `direct` is the undelayed dry
    //    signal used when there is no session at all.
    this.growScratch(n);
    const gotProcessed = this.live ? this.pullProcessed(this.wetBuf, n) : false;
    if (!gotProcessed) this.readDelayed(this.wetBuf, n, this.delayFrames);
    this.readDelayed(this.dryBuf, n, 0);

    // 3. Crossfade between them. Two copies of one signal at different times:
    //    a hard switch is an audible click, so the move is ramped.
    const target = this.live ? 1 : 0;
    const step = 1 / RAMP_FRAMES;
    let blend = this.blend;
    for (let c = 0; c < output.length; c += 1) {
      const out = output[c];
      const a = this.wetBuf[Math.min(c, this.wetBuf.length - 1)];
      const b = this.dryBuf[Math.min(c, this.dryBuf.length - 1)];
      blend = this.blend;
      for (let i = 0; i < n; i += 1) {
        if (blend < target) blend = blend + step > target ? target : blend + step;
        else if (blend > target) blend = blend - step < target ? target : blend - step;
        out[i] = a[i] * blend + b[i] * (1 - blend);
      }
    }
    this.blend = blend;

    // 4. Advance the timeline and report.
    if (this.playing || this.freeRun) this.position += n;
    this.statsTick += 1;
    if (this.statsTick >= STATS_EVERY) {
      this.statsTick = 0;
      const sig = this.underruns + ':' + this.overflows + ':' + this.processedBlocks;
      if (sig !== this.lastStats) {
        this.lastStats = sig;
        this.port.postMessage({
          type: 'stats',
          underruns: this.underruns,
          overflows: this.overflows,
          processed: this.processedBlocks,
        });
      }
    }
    // True: this node holds a delay line and a play-out queue, so it still has
    // audio to produce after its input goes quiet.
    return true;
  }

  /** Re-allocate the scratch buffers if the quantum ever grows (see MDN: the
   *  block size is 128 today but the spec reserves the right to change it). */
  growScratch(n) {
    if (this.wetBuf[0].length >= n) return;
    for (let c = 0; c < this.channels; c += 1) {
      this.wetBuf[c] = new Float32Array(n);
      this.dryBuf[c] = new Float32Array(n);
    }
  }

  postBlock() {
    const channels = this.accum;
    const transfer = [];
    for (let c = 0; c < channels.length; c += 1) transfer.push(channels[c].buffer);
    // The worker's channel when there is one, so the block never reaches the
    // main thread; `this.port` only while the handover is still in flight or
    // the runtime has no worker at all.
    const out = this.audioPort || this.port;
    out.postMessage(
      {
        type: 'block',
        seq: this.seq,
        frames: this.blockSize,
        playing: this.playing,
        discontinuity: this.pendingDiscontinuity,
        positionSamples: this.blockStartPos,
        tempoBpm: this.tempo,
        channels,
      },
      transfer,
    );
    this.pendingDiscontinuity = false;
    this.seq = (this.seq + 1) >>> 0; // the protocol's seq is a u32
    // The buffers above were transferred away, so the accumulator needs new
    // ones. ~94 allocations a second at 48 kHz / 512: small, short-lived, and
    // the price of zero-copy transfer in both directions.
    this.accum = this.allocBlock();
    this.accumFill = 0;
  }
}

registerProcessor('vst-bridge', VstBridgeProcessor);
