/**
 * safety-limiter.worklet.js — the peak limiter after a soundfont synth
 * whose channel plays a sound bank preset lifted above unity by its playback
 * gain (lib/soundbankGain). A chord in such a preset could otherwise pass
 * full scale.
 *
 * Zero latency, stereo-linked: each sample's gain is the smaller of the gain
 * releasing back toward 1 and what keeps that sample's peak at the ceiling,
 * so no sample leaves above the ceiling, and a signal that never reaches it
 * passes with a gain of exactly 1.
 *
 * Parameter (k-rate): active 0 or 1. While 0 the node takes no new gain
 * reduction; a reduction already taken releases back to 1 as it would.
 * Options (processorOptions): ceilingDb (default -0.3), releaseSec (default
 * 0.15).
 *
 * Registered as 'thedaw-safety-limiter'. Loaded per context by
 * lib/synthOutputStage (the live engine context and each offline render).
 */

class SafetyLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'active', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const ceilingDb = typeof o.ceilingDb === 'number' ? o.ceilingDb : -0.3;
    const releaseSec = typeof o.releaseSec === 'number' && o.releaseSec > 0 ? o.releaseSec : 0.15;
    this.ceiling = Math.pow(10, ceilingDb / 20);
    this.release = 1 - Math.exp(-1 / (sampleRate * releaseSec));
    this.gain = 1;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0] || [];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const n = output[0].length;
    const active = parameters.active[0] >= 0.5;
    const channels = output.length;
    const ceiling = this.ceiling;
    const release = this.release;
    let gain = this.gain;
    for (let i = 0; i < n; i += 1) {
      let peak = 0;
      for (let c = 0; c < channels; c += 1) {
        const src = input[c] || input[0];
        const x = src ? src[i] : 0;
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
      }
      if (gain < 1) gain += (1 - gain) * release;
      if (active && peak * gain > ceiling) gain = ceiling / peak;
      for (let c = 0; c < channels; c += 1) {
        const src = input[c] || input[0];
        output[c][i] = src ? src[i] * gain : 0;
      }
    }
    this.gain = gain;
    return true;
  }
}

registerProcessor('thedaw-safety-limiter', SafetyLimiterProcessor);
