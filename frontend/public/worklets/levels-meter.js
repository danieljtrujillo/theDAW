/**
 * levels-meter — an AudioWorkletProcessor that measures the master signal for
 * theDAW's Levels tab. Tapped non-destructively off the master gain (its output
 * feeds a silent sink, so it observes without altering the audio).
 *
 * Per ~100 ms it posts a compact readings frame:
 *   - LUFS: momentary (400 ms), short-term (3 s), and gated integrated (BS.1770-4
 *     K-weighting: high-shelf pre-filter + RLB high-pass, computed for the actual
 *     sample rate).
 *   - True peak (4x oversampled via Catmull-Rom) + sample peak, in dBTP/dBFS.
 *   - RMS + crest factor (for the Dynamic Range view).
 *   - Inter-channel correlation + a decimated L/R scatter (for the goniometer).
 *   - Per-band RMS at 40 / 80 / 120 / 160 Hz (for Bass Space).
 *   - Loudness range (LRA) from the short-term loudness distribution.
 */

function kWeightingCoeffs(fs) {
  // Stage 1 — high-shelf pre-filter.
  const db = 3.999843853973347;
  const f1 = 1681.9744509555319;
  const Q1 = 0.7071752369554193;
  const K1 = Math.tan(Math.PI * f1 / fs);
  const Vh = Math.pow(10, db / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a01 = 1 + K1 / Q1 + K1 * K1;
  const s1 = [
    (Vh + (Vb * K1) / Q1 + K1 * K1) / a01,
    (2 * (K1 * K1 - Vh)) / a01,
    (Vh - (Vb * K1) / Q1 + K1 * K1) / a01,
    (2 * (K1 * K1 - 1)) / a01,
    (1 - K1 / Q1 + K1 * K1) / a01,
  ];
  // Stage 2 — RLB high-pass.
  const f2 = 38.13547087613982;
  const Q2 = 0.5003270373253953;
  const K2 = Math.tan(Math.PI * f2 / fs);
  const a02 = 1 + K2 / Q2 + K2 * K2;
  const s2 = [1, -2, 1, (2 * (K2 * K2 - 1)) / a02, (1 - K2 / Q2 + K2 * K2) / a02];
  return [s1, s2];
}

function bandpass(f0, fs, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosw = Math.cos(w0);
  const a0 = 1 + alpha;
  return [alpha / a0, 0, -alpha / a0, (-2 * cosw) / a0, (1 - alpha) / a0];
}

class Biquad {
  constructor(c) {
    this.b0 = c[0];
    this.b1 = c[1];
    this.b2 = c[2];
    this.a1 = c[3];
    this.a2 = c[4];
    this.z1 = 0;
    this.z2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

const ABS_GATE = -70; // LUFS absolute gate
const MAX_BLOCKS = 36000; // ~1 hr of 100 ms gating blocks

function catmull(p0, p1, p2, p3, t) {
  return (
    p1 +
    0.5 *
      t *
      (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
  );
}

class LevelsMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    const k = kWeightingCoeffs(fs);
    this.kL = [new Biquad(k[0]), new Biquad(k[1])];
    this.kR = [new Biquad(k[0]), new Biquad(k[1])];
    this.bandFreqs = [40, 80, 120, 160];
    this.bandFilters = this.bandFreqs.map((f) => new Biquad(bandpass(f, fs, 4)));

    this.hop = Math.max(1, Math.round(fs * 0.1)); // 100 ms
    this.hopCount = 0;
    this.hopSumSq = 0; // K-weighted sum of squares (both channels) this 100 ms
    this.subBlocks = []; // recent per-100ms {ms} for momentary/short windows

    this.gatingMs = []; // 400 ms block mean-squares that pass the absolute gate
    this.shortLoud = []; // 3 s short-term loudness values (for LRA)

    // per-100ms accumulators
    this.samplePeak = 0;
    this.truePeak = 0;
    this.rmsSum = 0;
    this.rmsN = 0;
    this.corrLL = 0;
    this.corrRR = 0;
    this.corrLR = 0;
    this.bandSum = [0, 0, 0, 0];

    // true-peak history (Catmull-Rom needs 4 points) per channel
    this.hl = [0, 0, 0, 0];
    this.hr = [0, 0, 0, 0];

    // decimated scope ring (interleaved L,R)
    this.scope = new Float32Array(512);
    this.scopeIdx = 0;
    this.scopeDecim = Math.max(1, Math.round(this.hop / 256));
    this.scopeCtr = 0;
  }

  pushTruePeak(hist, x) {
    hist[0] = hist[1];
    hist[1] = hist[2];
    hist[2] = hist[3];
    hist[3] = x;
    const a = Math.abs(hist[3]);
    if (a > this.truePeak) this.truePeak = a;
    for (let j = 1; j < 4; j += 1) {
      const v = Math.abs(catmull(hist[0], hist[1], hist[2], hist[3], j / 4));
      if (v > this.truePeak) this.truePeak = v;
    }
  }

  emitHop() {
    const ms = this.hopCount > 0 ? this.hopSumSq / this.hopCount : 0;
    this.subBlocks.push(ms);
    if (this.subBlocks.length > 40) this.subBlocks.shift(); // keep 4 s

    // Gating block = last 400 ms (4 sub-blocks).
    if (this.subBlocks.length >= 4) {
      const w = this.subBlocks.slice(-4);
      const gm = (w[0] + w[1] + w[2] + w[3]) / 4;
      const loud = gm > 0 ? -0.691 + 10 * Math.log10(gm) : -Infinity;
      if (loud > ABS_GATE) {
        this.gatingMs.push(gm);
        if (this.gatingMs.length > MAX_BLOCKS) this.gatingMs.shift();
      }
    }
    // Short-term = last 3 s (30 sub-blocks).
    if (this.subBlocks.length >= 30) {
      const w = this.subBlocks.slice(-30);
      let sum = 0;
      for (let i = 0; i < 30; i += 1) sum += w[i];
      const sm = sum / 30;
      const loud = sm > 0 ? -0.691 + 10 * Math.log10(sm) : -Infinity;
      if (loud > ABS_GATE) {
        this.shortLoud.push(loud);
        if (this.shortLoud.length > MAX_BLOCKS) this.shortLoud.shift();
      }
    }

    this.hopSumSq = 0;
    this.hopCount = 0;
  }

  momentary() {
    const w = this.subBlocks.slice(-4);
    if (!w.length) return -Infinity;
    let s = 0;
    for (const v of w) s += v;
    const ms = s / w.length;
    return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
  }

  shortTerm() {
    const w = this.subBlocks.slice(-30);
    if (!w.length) return -Infinity;
    let s = 0;
    for (const v of w) s += v;
    const ms = s / w.length;
    return ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity;
  }

  integrated() {
    if (!this.gatingMs.length) return -Infinity;
    let sum = 0;
    for (const m of this.gatingMs) sum += m;
    const ungated = sum / this.gatingMs.length;
    const relGate = -0.691 + 10 * Math.log10(ungated) - 10;
    let s2 = 0;
    let n2 = 0;
    for (const m of this.gatingMs) {
      const loud = -0.691 + 10 * Math.log10(m);
      if (loud > relGate) {
        s2 += m;
        n2 += 1;
      }
    }
    if (!n2) return -Infinity;
    return -0.691 + 10 * Math.log10(s2 / n2);
  }

  lra() {
    if (this.shortLoud.length < 10) return 0;
    const sorted = [...this.shortLoud].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.1)];
    const hi = sorted[Math.floor(sorted.length * 0.95)];
    return Math.max(0, hi - lo);
  }

  postFrame() {
    const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    const rms = this.rmsN > 0 ? Math.sqrt(this.rmsSum / this.rmsN) : 0;
    const rmsDb = toDb(rms);
    const samplePeakDb = toDb(this.samplePeak);
    const crestDb = Number.isFinite(samplePeakDb) && Number.isFinite(rmsDb) ? samplePeakDb - rmsDb : 0;
    const corrDen = Math.sqrt(this.corrLL * this.corrRR);
    const correlation = corrDen > 1e-12 ? this.corrLR / corrDen : 0;
    const bands = this.bandSum.map((s) => toDb(this.rmsN > 0 ? Math.sqrt(s / this.rmsN) : 0));

    this.port.postMessage({
      momentary: this.momentary(),
      short: this.shortTerm(),
      integrated: this.integrated(),
      lra: this.lra(),
      samplePeakDb,
      truePeakDb: toDb(this.truePeak),
      rmsDb,
      crestDb,
      correlation,
      bands,
      bandFreqs: this.bandFreqs,
      scope: this.scope.slice(0, this.scopeIdx),
    });

    this.samplePeak = 0;
    this.truePeak = 0;
    this.rmsSum = 0;
    this.rmsN = 0;
    this.corrLL = 0;
    this.corrRR = 0;
    this.corrLR = 0;
    this.bandSum = [0, 0, 0, 0];
    this.scopeIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const L = input[0];
    const R = input.length > 1 ? input[1] : input[0];
    const n = L.length;
    for (let i = 0; i < n; i += 1) {
      const l = L[i];
      const r = R[i];
      const kl = this.kL[1].process(this.kL[0].process(l));
      const kr = this.kR[1].process(this.kR[0].process(r));
      this.hopSumSq += kl * kl + kr * kr;
      this.hopCount += 1;

      const ap = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      if (ap > this.samplePeak) this.samplePeak = ap;
      this.pushTruePeak(this.hl, l);
      this.pushTruePeak(this.hr, r);

      this.rmsSum += (l * l + r * r) * 0.5;
      this.rmsN += 1;
      this.corrLL += l * l;
      this.corrRR += r * r;
      this.corrLR += l * r;

      const mono = (l + r) * 0.5;
      for (let b = 0; b < 4; b += 1) {
        const bv = this.bandFilters[b].process(mono);
        this.bandSum[b] += bv * bv;
      }

      this.scopeCtr += 1;
      if (this.scopeCtr >= this.scopeDecim && this.scopeIdx < 510) {
        this.scopeCtr = 0;
        this.scope[this.scopeIdx] = l;
        this.scope[this.scopeIdx + 1] = r;
        this.scopeIdx += 2;
      }

      this.hopCounter = (this.hopCounter || 0) + 1;
      if (this.hopCounter >= this.hop) {
        this.hopCounter = 0;
        this.emitHop();
      }
    }
    // Post a frame roughly every 100 ms (aligned to the hop).
    this.postCounter = (this.postCounter || 0) + n;
    if (this.postCounter >= this.hop) {
      this.postCounter = 0;
      this.postFrame();
    }
    return true;
  }
}

registerProcessor('levels-meter', LevelsMeter);
