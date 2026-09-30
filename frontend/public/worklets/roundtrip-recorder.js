/**
 * roundtrip-recorder — an AudioWorkletProcessor that captures raw input samples
 * for theDAW's loopback latency probe (`src/lib/roundTripProbe.ts`).
 *
 * Why a worklet and not MediaRecorder: the whole measurement is a SAMPLE index.
 * MediaRecorder hands back an encoded container whose first sample has no known
 * relationship to the AudioContext clock — the answer would be worth about as
 * much as a stopwatch. A worklet sees the graph's own frame counter, so every
 * captured sample has an exact context frame, and `startFrame` below is what
 * lets the probe line the capture up against the instant it scheduled the
 * signal for.
 *
 * It writes at ABSOLUTE index `currentFrame - startFrame` rather than appending,
 * so a dropped render quantum leaves a hole of silence where it happened
 * instead of sliding everything after it earlier and corrupting the answer.
 *
 * It observes only: its output is silence, and the probe connects it to a
 * zero-gain sink purely because a node no path reaches from the destination is
 * never pulled.
 *
 * Messages
 *   in : { type: 'stop' }  — finish now and post what has been captured.
 *   out: { type: 'capture', startFrame, sampleRate, samples: Float32Array }
 *        (`samples.buffer` is transferred, so this arrives with no copy).
 */

/** Render quantum, used only to advance the write cursor when the input has not
 *  produced a channel this call. The spec fixes it at 128. */
const QUANTUM = 128;

class RoundTripRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const asked = Number(opts.maxSamples);
    // Ceiling as well as a floor: a probe is a couple of seconds, and a
    // processorOption that arrived as NaN must not allocate the heap.
    const maxSamples = Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), Math.ceil(sampleRate * 30))
      : Math.ceil(sampleRate * 3);
    this.buf = new Float32Array(maxSamples);
    /** Context frame of `buf[0]`; -1 until the first `process`. */
    this.startFrame = -1;
    /** One past the highest index written. */
    this.written = 0;
    this.done = false;
    this.port.onmessage = (event) => {
      const data = event && event.data;
      if (data && data.type === 'stop') this.flush();
    };
  }

  flush() {
    if (this.done) return;
    this.done = true;
    const samples = this.buf.slice(0, this.written);
    this.port.postMessage(
      {
        type: 'capture',
        startFrame: this.startFrame < 0 ? 0 : this.startFrame,
        sampleRate,
        samples,
      },
      [samples.buffer],
    );
    this.buf = new Float32Array(0);
  }

  process(inputs) {
    if (this.done) return false;
    if (this.startFrame < 0) this.startFrame = currentFrame;
    const input = inputs[0];
    const channel = input && input.length > 0 ? input[0] : null;
    const n = channel ? channel.length : QUANTUM;
    let at = currentFrame - this.startFrame;
    // A frame counter that ran backwards (a context that was reset under us) is
    // not something to guess about: append instead of writing out of range.
    if (at < 0 || at > this.buf.length) at = this.written;
    if (at + n > this.buf.length) {
      // Out of room: the caller asked for a window and this is the end of it.
      this.flush();
      return false;
    }
    if (channel) this.buf.set(channel, at);
    const end = at + n;
    if (end > this.written) this.written = end;
    return true;
  }
}

registerProcessor('roundtrip-recorder', RoundTripRecorder);
