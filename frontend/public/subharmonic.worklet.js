/**
 * subharmonic.worklet.js — octave-divider sub generator (the Kargyraa Sub engine).
 *
 * Emulates the kargyraa (Tuvan undertone) mechanism electronically: the
 * ventricular folds cover every second vocal-fold closure, halving the
 * effective pitch. Here a Schmitt-triggered flip-flop toggles once per
 * input period, producing a square at f/2 (`sub`), and a second flip-flop
 * divides that again to f/4 (`deep`). Both are scaled by an envelope
 * follower so the sub tracks the source's articulation instead of droning.
 *
 * The host graph feeds this node a low-passed copy of the signal (so the
 * trigger locks to the bass fundamental, not the hats) and tone-shapes the
 * output; the flip edges are pre-smoothed here only enough to avoid clicks.
 *
 * Parameters (k-rate): sub 0..1, deep 0..1.
 * Registered as 'subharmonic-processor'. Loaded per-context by
 * ensureSubharmonicModule (rackEffects.ts), same pattern as chop/granular.
 */

class SubharmonicProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sub', defaultValue: 1.0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'deep', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.flip2 = 1; // f/2 square state
    this.flip4 = 1; // f/4 square state
    this.sign = 1; // Schmitt state of the (DC-blocked) input
    this.env = 0; // envelope follower
    this.dcX = 0; // DC blocker memories
    this.dcY = 0;
    this.smooth2 = 1; // edge-smoothed flip outputs
    this.smooth4 = 1;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const ch0 = input && input[0];
    const n = output[0].length;
    const subGain = parameters.sub[0];
    const deepGain = parameters.deep[0];

    // Coefficients (sampleRate-aware). Envelope: ~4 ms attack, ~120 ms release.
    const aAtk = 1 - Math.exp(-1 / (sampleRate * 0.004));
    const aRel = 1 - Math.exp(-1 / (sampleRate * 0.12));
    // Edge smoothing one-pole (~280 Hz) keeps the divided square from clicking
    // while leaving plenty of harmonics for the formant bank downstream.
    const aEdge = 1 - Math.exp((-2 * Math.PI * 280) / sampleRate);

    for (let i = 0; i < n; i += 1) {
      const x = ch0 ? ch0[i] : 0;

      // DC blocker (one-pole high-pass) so asymmetric material doesn't jam the trigger.
      const y = x - this.dcX + 0.995 * this.dcY;
      this.dcX = x;
      this.dcY = y;

      // Envelope follower on the band-limited input.
      const ax = Math.abs(y);
      this.env += (ax - this.env) * (ax > this.env ? aAtk : aRel);

      // Schmitt trigger with an envelope-relative hysteresis window: quiet
      // noise can't chatter the flip-flops, loud material triggers reliably.
      const h = Math.max(1e-4, this.env * 0.25);
      if (this.sign < 0 && y > h) {
        this.sign = 1;
        // One positive-going trigger per input period: divide.
        this.flip2 = -this.flip2;
        if (this.flip2 > 0) this.flip4 = -this.flip4; // divide again -> f/4
      } else if (this.sign > 0 && y < -h) {
        this.sign = -1;
      }

      this.smooth2 += (this.flip2 - this.smooth2) * aEdge;
      this.smooth4 += (this.flip4 - this.smooth4) * aEdge;

      const s = (subGain * this.smooth2 + deepGain * this.smooth4) * this.env;
      for (let c = 0; c < output.length; c += 1) output[c][i] = s;
    }
    return true;
  }
}

registerProcessor('subharmonic-processor', SubharmonicProcessor);
