/**
 * granular.worklet.js - a single-source real-time granular processor for the
 * Ares composite effect (the "grains" stage).
 *
 * Keeps a rolling ring buffer of recent stereo input and sprays overlapping,
 * Hann-windowed grains read from scattered positions in that buffer. Density sets
 * grains/second, size sets grain length, spread sets how far back grains scatter,
 * pitch resamples each grain, and mix crossfades dry against the grain cloud.
 * FREEZE stops writing new input to the ring, so the grains keep scattering the
 * frozen moment (the Ares Freeze button drives this).
 *
 * Parameters are k-rate AudioParams (set via setValueAtTime/setTargetAtTime from
 * rackEffects), and grain scheduling/scatter uses a deterministic PRNG, so the
 * live preview and the offline bounce render identically (no port-message race).
 */

const MAX_GRAINS = 128;

class GranularProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'density', defaultValue: 25, minValue: 1, maxValue: 200, automationRate: 'k-rate' },
      { name: 'size', defaultValue: 120, minValue: 5, maxValue: 500, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'spread', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'freeze', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.bufLen = Math.ceil(sampleRate * 2); // 2 seconds of history
    this.bufL = new Float32Array(this.bufLen);
    this.bufR = new Float32Array(this.bufLen);
    this.writePos = 0;
    this.filled = 0; // how much valid history exists (until the ring first fills)
    this.sinceGrain = 0; // samples since the last grain onset
    // Grain pool (flat arrays to avoid per-grain allocation).
    this.gPos = new Float32Array(MAX_GRAINS); // fractional read position (ring samples)
    this.gInc = new Float32Array(MAX_GRAINS); // per-sample advance (pitch ratio)
    this.gAge = new Float32Array(MAX_GRAINS); // samples played
    this.gLen = new Float32Array(MAX_GRAINS); // grain length in samples
    this.gOn = new Uint8Array(MAX_GRAINS); // active flag
    this.seed = 99991; // deterministic PRNG (bounce matches preview)
  }

  rng() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  spawn(size, spread, pitch) {
    let slot = -1;
    for (let g = 0; g < MAX_GRAINS; g += 1) {
      if (!this.gOn[g]) { slot = g; break; }
    }
    if (slot < 0) return; // pool full — drop this grain
    const lenSamp = Math.max(32, Math.floor((size / 1000) * sampleRate));
    const avail = Math.min(this.filled, this.bufLen) - lenSamp - 2;
    if (avail <= 0) return; // not enough history yet
    const back = lenSamp + Math.floor(spread * this.rng() * avail);
    const start = (this.writePos - back + this.bufLen) % this.bufLen;
    this.gPos[slot] = start;
    this.gInc[slot] = Math.pow(2, pitch / 12);
    this.gAge[slot] = 0;
    this.gLen[slot] = lenSamp;
    this.gOn[slot] = 1;
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

    const density = params.density[0];
    const size = params.size[0];
    const pitch = params.pitch[0];
    const spread = params.spread[0];
    const mix = params.mix[0];
    const frozen = params.freeze[0] >= 0.5;

    const grainInterval = Math.max(1, Math.floor(sampleRate / Math.max(1, density)));
    // Normalize the grain cloud so heavy overlap does not build up in level.
    const overlap = Math.max(1, (density * (size / 1000)));
    const wetGain = mix / Math.sqrt(overlap);
    const bl = this.bufL, br = this.bufR, bufLen = this.bufLen;

    for (let i = 0; i < n; i += 1) {
      const xl = inL ? inL[i] : 0;
      const xr = inR ? inR[i] : xl;

      if (!frozen) {
        bl[this.writePos] = xl;
        br[this.writePos] = xr;
        this.writePos = (this.writePos + 1) % bufLen;
        if (this.filled < bufLen) this.filled += 1;
      }

      this.sinceGrain += 1;
      if (this.sinceGrain >= grainInterval) {
        this.sinceGrain = 0;
        this.spawn(size, spread, pitch);
      }

      let wl = 0, wr = 0;
      for (let g = 0; g < MAX_GRAINS; g += 1) {
        if (!this.gOn[g]) continue;
        const len = this.gLen[g];
        const age = this.gAge[g];
        // Hann window across the grain.
        const w = 0.5 - 0.5 * Math.cos((6.283185307179586 * age) / len);
        const pos = this.gPos[g];
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = (i0 % bufLen + bufLen) % bufLen;
        const b = (a + 1) % bufLen;
        wl += (bl[a] + (bl[b] - bl[a]) * frac) * w;
        wr += (br[a] + (br[b] - br[a]) * frac) * w;
        const nextPos = pos + this.gInc[g];
        this.gPos[g] = nextPos;
        const nextAge = age + 1;
        this.gAge[g] = nextAge;
        if (nextAge >= len) this.gOn[g] = 0;
      }

      outL[i] = xl * (1 - mix) + wl * wetGain;
      if (outR) outR[i] = xr * (1 - mix) + wr * wetGain;
    }

    return true;
  }
}

registerProcessor('granular-processor', GranularProcessor);
