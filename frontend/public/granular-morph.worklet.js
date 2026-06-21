/* Granular identity-bleed morph processor (Phase M).
 *
 * Concatenative / mosaicing granular synthesis. Two sources live in the audio
 * thread: a CORPUS A (the donor / "identity") sliced into a grain pool, and a
 * TARGET B (the host / structure). The read-head walks B's timeline; at a steady
 * grain rate it spawns grains pulled from A, choosing — for each grain — the A
 * grain whose loudness/brightness best matches what B is doing at that instant.
 * The output is therefore B's structure rebuilt out of A's material: "B spoken in
 * A's voice." `bleed` crossfades dry-B (0) -> full mosaic (1); `match` sets how
 * strictly grains are chosen (loose = more of A's own character bleeds through).
 *
 * Messages in:
 *   {type:'loadA', pcm, count, gOffset, gLoud, gBright}
 *   {type:'loadB', pcm, frameHop, frames, fLoud, fBright}
 *   {type:'params', bleed, grainSize, grainRate, spray, match, gain, loop}
 *   {type:'play', on} | {type:'seek', sec}
 * Messages out: {type:'pos', sec} (~per block, for the UI playhead)
 */

const POOL = 64; // max concurrent grain voices

class GranularMorphProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // corpus A
    this.aPcm = null; this.aLen = 0;
    this.gOffset = null; this.gLoud = null; this.gBright = null; this.gSal = null; this.gCount = 0;
    // target B
    this.bPcm = null; this.bLen = 0;
    this.fLoud = null; this.fBright = null; this.frameHop = 256; this.frames = 0;
    this.onsets = null; this.onsetCount = 0; this.onsetPtr = 0;
    // transport
    this.playhead = 0; this.playing = false;
    // params (+ derived)
    this.bleed = 0.6; this.grainSize = 0.12; this.grainRate = 24;
    this.spray = 0.2; this.match = 0.7; this.gain = 0.9; this.loop = true;
    this.sync = 0.5; this.favor = 0.4;
    this.grainLen = Math.floor(this.grainSize * sampleRate);
    this.grainInterval = sampleRate / this.grainRate;
    this.wetNorm = 1 / Math.sqrt(Math.max(1, this.grainRate * this.grainSize));
    this.spawnCountdown = 0;
    this._post = 0;
    // voice pool (parallel arrays)
    this.vActive = new Uint8Array(POOL);
    this.vAPos = new Float32Array(POOL); // read index into A
    this.vPos = new Float32Array(POOL);  // position within the grain
    this.vLen = new Float32Array(POOL);  // grain length

    // Offline renders (the "send to editor" bounce) seed everything through
    // processorOptions, which reach the constructor BEFORE the first process()
    // call. Port messages posted just before startRendering() are NOT guaranteed
    // to arrive first on a short offline render (verified live: they don't), so a
    // message-seeded bounce renders silence. Live playback keeps using messages.
    const po = options && options.processorOptions;
    if (po) {
      if (po.a) this.loadA(po.a);
      if (po.b) this.loadB(po.b);
      if (po.params) this.applyParams(po.params);
      if (po.play) { this.playing = true; this.spawnCountdown = 0; this._post = 0; }
    }

    this.port.onmessage = (e) => {
      const d = e.data;
      switch (d.type) {
        case 'loadA': this.loadA(d); break;
        case 'loadB': this.loadB(d); break;
        case 'params': this.applyParams(d); break;
        case 'play':
          this.playing = !!d.on;
          if (d.on) { this.spawnCountdown = 0; this._post = 0; }
          break;
        case 'seek':
          this.playhead = Math.max(0, Math.min(this.bLen - 1, (d.sec || 0) * sampleRate));
          this.onsetPtr = 0;
          while (this.onsets && this.onsetPtr < this.onsetCount && this.onsets[this.onsetPtr] < this.playhead) this.onsetPtr += 1;
          break;
        default: break;
      }
    };
  }

  loadA(d) {
    this.aPcm = d.pcm; this.aLen = d.pcm.length;
    this.gOffset = d.gOffset; this.gLoud = d.gLoud; this.gBright = d.gBright; this.gSal = d.gSal;
    this.gCount = d.count | 0;
  }

  loadB(d) {
    this.bPcm = d.pcm; this.bLen = d.pcm.length;
    this.fLoud = d.fLoud; this.fBright = d.fBright;
    this.frameHop = d.frameHop | 0; this.frames = d.frames | 0;
    this.onsets = d.onsets || null; this.onsetCount = this.onsets ? this.onsets.length : 0;
    this.playhead = 0; this.onsetPtr = 0;
  }

  applyParams(d) {
    if (d.bleed != null) this.bleed = d.bleed;
    if (d.grainSize != null) this.grainSize = Math.max(0.01, d.grainSize);
    if (d.grainRate != null) this.grainRate = Math.max(1, d.grainRate);
    if (d.spray != null) this.spray = d.spray;
    if (d.match != null) this.match = d.match;
    if (d.sync != null) this.sync = d.sync;
    if (d.favor != null) this.favor = d.favor;
    if (d.gain != null) this.gain = d.gain;
    if (d.loop != null) this.loop = !!d.loop;
    this.grainLen = Math.floor(this.grainSize * sampleRate);
    this.grainInterval = sampleRate / this.grainRate;
    this.wetNorm = 1 / Math.sqrt(Math.max(1, this.grainRate * this.grainSize));
  }

  /** Pick the A grain best matching the target (loud,bright). `match` low =
   *  sometimes roam A so its own identity bleeds through; `favor` biases toward
   *  high-salience (punchy/cool) grains both when roaming and when matching. */
  selectGrain(tLoud, tBright) {
    if (this.gCount <= 0) return -1;
    if (Math.random() > this.match) {
      // roam, but keep the most salient of a few random draws (more draws as favor rises)
      let pick = (Math.random() * this.gCount) | 0;
      const tries = 1 + ((this.favor * 4) | 0);
      for (let k = 1; k < tries; k += 1) {
        const c = (Math.random() * this.gCount) | 0;
        if (this.gSal && this.gSal[c] > this.gSal[pick]) pick = c;
      }
      return pick;
    }
    let best = 0;
    let bestScore = Infinity;
    for (let i = 0; i < this.gCount; i += 1) {
      const dl = this.gLoud[i] - tLoud;
      const db = this.gBright[i] - tBright;
      let score = dl * dl + db * db;
      if (this.gSal) score -= this.favor * this.gSal[i] * 0.6; // salient grains win near-ties
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  spawn() {
    if (!this.aPcm || this.gCount <= 0) return;
    const tf = this.frames > 0 ? Math.min(this.frames - 1, (this.playhead / this.frameHop) | 0) : 0;
    const tLoud = this.fLoud ? this.fLoud[tf] : 0.5;
    const tBright = this.fBright ? this.fBright[tf] : 0.5;
    const g = this.selectGrain(tLoud, tBright);
    if (g < 0) return;
    let start = this.gOffset[g];
    if (this.spray > 0) start += (Math.random() * 2 - 1) * this.spray * this.grainLen;
    start = Math.max(0, Math.min(this.aLen - 2, start));
    // find a free voice, else steal the one nearest its end
    let v = -1;
    for (let i = 0; i < POOL; i += 1) if (!this.vActive[i]) { v = i; break; }
    if (v < 0) {
      let most = 0;
      for (let i = 1; i < POOL; i += 1) {
        if (this.vPos[i] / this.vLen[i] > this.vPos[most] / this.vLen[most]) most = i;
      }
      v = most;
    }
    this.vActive[v] = 1; this.vAPos[v] = start; this.vPos[v] = 0; this.vLen[v] = this.grainLen;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : null;
    const n = oL.length;

    if (!this.playing || !this.aPcm || !this.bPcm) {
      for (let i = 0; i < n; i += 1) { oL[i] = 0; if (oR) oR[i] = 0; }
      return true;
    }

    const TWO_PI = Math.PI * 2;
    for (let i = 0; i < n; i += 1) {
      // beat-locked triggers: fire on host onsets (more of them as `sync` rises)
      if (this.sync > 0 && this.onsets) {
        while (this.onsetPtr < this.onsetCount && this.onsets[this.onsetPtr] <= this.playhead) {
          if (Math.random() < this.sync) this.spawn();
          this.onsetPtr += 1;
        }
      }
      // steady grain clock: thinned as `sync` rises, so sync=1 is pure beat-lock
      if (this.spawnCountdown <= 0) {
        if (Math.random() < 1 - this.sync) this.spawn();
        this.spawnCountdown += this.grainInterval * (1 + (Math.random() * 2 - 1) * this.spray * 0.5);
      }
      this.spawnCountdown -= 1;

      // sum active grain voices (windowed)
      let wet = 0;
      for (let v = 0; v < POOL; v += 1) {
        if (!this.vActive[v]) continue;
        const idx = this.vAPos[v] | 0;
        if (idx >= 0 && idx < this.aLen) {
          const w = 0.5 - 0.5 * Math.cos((TWO_PI * this.vPos[v]) / this.vLen[v]);
          wet += this.aPcm[idx] * w;
        }
        this.vAPos[v] += 1;
        this.vPos[v] += 1;
        if (this.vPos[v] >= this.vLen[v]) this.vActive[v] = 0;
      }
      wet *= this.wetNorm;

      // dry host at the read-head
      const ph = this.playhead | 0;
      const dry = ph < this.bLen ? this.bPcm[ph] : 0;

      const s = this.gain * (this.bleed * wet + (1 - this.bleed) * dry);
      oL[i] = s;
      if (oR) oR[i] = s;

      this.playhead += 1;
      if (this.playhead >= this.bLen) {
        if (this.loop) { this.playhead = 0; this.onsetPtr = 0; }
        else { this.playhead = this.bLen - 1; }
      }
    }

    this._post += n;
    if (this._post >= 4096) {
      this._post = 0;
      this.port.postMessage({ type: 'pos', sec: this.playhead / sampleRate });
    }
    return true;
  }
}

registerProcessor('granular-morph', GranularMorphProcessor);
