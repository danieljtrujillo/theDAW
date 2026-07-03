/**
 * chop.worklet.js - an MPC-style buffer chop processor for the EDIT FX rack.
 *
 * Keeps a rolling ring buffer of recent stereo input. On each trigger (rate per
 * second) it captures a slice and loops it for the period, so the output is the
 * input re-chopped in real time:
 *   program 0 = stutter      : re-capture the most recent slice every trigger.
 *   program 1 = beat-repeat  : capture once, repeat the held slice for 4 triggers.
 *   program 2 = shuffle      : jump to a random earlier slice every trigger.
 * `slice` sets the slice length as a fraction of the trigger period; `mix`
 * crossfades dry against the chopped signal.
 *
 * Parameters are AudioParams (k-rate), so they are set from rackEffects via
 * setValueAtTime / setTargetAtTime and apply deterministically in both the live
 * context and the offline bounce (no port-message race).
 */

class ChopProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'program', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 8, minValue: 0.5, maxValue: 32, automationRate: 'k-rate' },
      { name: 'slice', defaultValue: 0.5, minValue: 0.05, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.bufLen = Math.ceil(sampleRate * 2); // 2 seconds of history
    this.bufL = new Float32Array(this.bufLen);
    this.bufR = new Float32Array(this.bufLen);
    this.writePos = 0;
    this.phase = 0; // samples remaining until the next trigger
    this.sliceStart = 0; // ring index where the current slice begins
    this.sliceLen = 1; // current slice length in samples
    this.readOff = 0; // playback offset within the slice
    this.trig = 0; // trigger counter (for beat-repeat hold)
    this.seed = 22222; // deterministic PRNG so the bounce matches the preview
  }

  rng() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  process(inputs, outputs, params) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const input = inputs[0];
    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : inL;
    const outL = output[0];
    const outR = output[1] || output[0];
    const n = outL.length;

    const program = Math.round(params.program[0]);
    const rate = params.rate[0];
    const sliceFrac = params.slice[0];
    const mix = params.mix[0];
    const period = Math.max(64, Math.floor(sampleRate / Math.max(0.5, rate)));

    for (let i = 0; i < n; i += 1) {
      const xl = inL ? inL[i] : 0;
      const xr = inR ? inR[i] : xl;

      this.bufL[this.writePos] = xl;
      this.bufR[this.writePos] = xr;

      if (this.phase <= 0) {
        this.phase = period;
        this.sliceLen = Math.max(32, Math.min(this.bufLen - 1, Math.floor(period * Math.max(0.05, Math.min(1, sliceFrac)))));
        const recapture = program !== 1 || this.trig % 4 === 0;
        if (recapture) {
          if (program === 2) {
            const back = Math.floor((0.1 + 0.85 * this.rng()) * (this.bufLen - this.sliceLen));
            this.sliceStart = (this.writePos - back + this.bufLen) % this.bufLen;
          } else {
            this.sliceStart = (this.writePos - this.sliceLen + this.bufLen) % this.bufLen;
          }
        }
        this.readOff = 0; // restart the slice each period for a clean rhythmic repeat
        this.trig += 1;
      }

      const rp = (this.sliceStart + (this.readOff % this.sliceLen) + this.bufLen) % this.bufLen;
      const wl = this.bufL[rp];
      const wr = this.bufR[rp];

      outL[i] = xl * (1 - mix) + wl * mix;
      if (outR) outR[i] = xr * (1 - mix) + wr * mix;

      this.readOff += 1;
      this.phase -= 1;
      this.writePos = (this.writePos + 1) % this.bufLen;
    }

    return true;
  }
}

registerProcessor('chop-processor', ChopProcessor);
