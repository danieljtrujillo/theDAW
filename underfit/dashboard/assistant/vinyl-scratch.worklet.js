/* Vinyl-scratch AudioWorklet for the DJ decks.
 *
 * A standard AudioBufferSourceNode can't play backward or at an arbitrary
 * hand-driven speed, which is exactly what a scratch is. This processor holds
 * the deck's decoded samples and outputs them from a read-head it advances
 * each sample by a velocity (1 = normal forward, -1 = reverse, 0 = stopped).
 * The main thread drives that velocity from the jog wheel; a still hold eases
 * it to 0 (record wind-down) and release eases it back to 1 (spin-up).
 *
 * Two voices:
 *   classic — clean linear-interpolated resampling (turntable feel).
 *   cyber   — fragmented/glitch: speed-driven sample-hold + bit-crush +
 *             occasional grain stutter for a cyberpunk edge.
 *
 * Messages in:  {type:'load', l, r, len} | {type:'pos', sec} |
 *               {type:'vel', vel, immediate?} | {type:'ease', ease} |
 *               {type:'mode', mode} | {type:'play', on} | {type:'gain', gain}
 * Messages out: {type:'pos', sec}  (read-head, ~per block, for handoff/UI)
 */
class VinylScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.l = null;
    this.r = null;
    this.len = 0;
    this.readPos = 0;     // float sample index
    this.vel = 1;         // current velocity (audio samples per output sample)
    this.targetVel = 1;   // eased toward
    this.ease = 0.1;      // velocity smoothing per sample (brake/spin-up feel)
    this.mode = 'classic';
    this.playing = false;
    this.gain = 1;
    // cyber voice state
    this._holdL = 0;
    this._holdR = 0;
    this._holdN = 0;
    this._postCtr = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      switch (d.type) {
        case 'load': this.l = d.l; this.r = d.r || d.l; this.len = d.len | 0; break;
        case 'pos': this.readPos = Math.max(0, Math.min(this.len - 1, d.sec * sampleRate)); break;
        case 'vel': this.targetVel = d.vel; if (d.immediate) this.vel = d.vel; break;
        case 'ease': this.ease = Math.max(0.001, Math.min(1, d.ease)); break;
        case 'mode': this.mode = d.mode === 'cyber' ? 'cyber' : 'classic'; break;
        case 'play': this.playing = !!d.on; if (d.on) this._postCtr = 0; break;
        case 'gain': this.gain = d.gain; break;
        default: break;
      }
    };
  }

  read(ch, pos) {
    if (!ch) return 0;
    if (pos < 0 || pos >= this.len - 1) return 0;
    const i = pos | 0;
    const f = pos - i;
    return ch[i] * (1 - f) + ch[i + 1] * f;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const oL = out[0];
    const oR = out.length > 1 ? out[1] : null;
    const n = oL.length;

    if (!this.l || !this.playing) {
      for (let i = 0; i < n; i++) { oL[i] = 0; if (oR) oR[i] = 0; }
      return true;
    }

    const cyber = this.mode === 'cyber';
    for (let i = 0; i < n; i++) {
      // Ease the velocity toward its target (the brake / spin-up curve).
      this.vel += (this.targetVel - this.vel) * this.ease;
      let l = this.read(this.l, this.readPos);
      let r = this.read(this.r, this.readPos);

      if (cyber) {
        const speed = Math.abs(this.vel);
        // Sample-hold proportional to speed → gritty downsampled edge.
        const hold = 1 + (Math.min(8, speed * 6) | 0);
        if (this._holdN <= 0) { this._holdL = l; this._holdR = r; this._holdN = hold; }
        this._holdN--;
        l = this._holdL; r = this._holdR;
        // Bit-crush to ~5 bits for the digital fragmentation.
        const q = 32; // 2^5
        l = Math.round(l * q) / q;
        r = Math.round(r * q) / q;
      }

      oL[i] = l * this.gain;
      if (oR) oR[i] = r * this.gain;

      this.readPos += this.vel;
      if (this.readPos < 0) { this.readPos = 0; this.vel = 0; }
      else if (this.readPos >= this.len - 1) { this.readPos = this.len - 1; this.vel = 0; }
    }

    // Report the read-head a few times a second so the engine can hand back to
    // the normal source at the right spot and the UI can track it.
    this._postCtr += n;
    if (this._postCtr >= 2048) {
      this._postCtr = 0;
      this.port.postMessage({ type: 'pos', sec: this.readPos / sampleRate });
    }
    return true;
  }
}

registerProcessor('vinyl-scratch', VinylScratchProcessor);
