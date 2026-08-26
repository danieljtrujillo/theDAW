/**
 * Frequency sources shared by the cymatics visualizers and the assistant orb's
 * ferrofluid body. Extracted from CymaticsVisualizer so both consumers read the
 * SAME idle/live crossfade behavior — the at-rest breathing and the audio
 * response curve must stay identical everywhere the ferrofluid appears.
 */
import { Analyser } from './analyser';

/** Shared shape so a render loop can read real or synthetic frequency data. */
export interface FreqSource {
  update(): void;
  readonly data: Uint8Array;
}

/**
 * Gentle self-driving frequency data for when no audio is audible, so the
 * meshes breathe/ripple/scroll at idle instead of sitting dead flat.
 */
export class IdleSource implements FreqSource {
  private dataArray = new Uint8Array(16);
  private seed: number;
  constructor(seed = 0) {
    this.seed = seed;
  }
  update() {
    const t = performance.now() / 1000 + this.seed;
    for (let i = 0; i < 16; i++) {
      const bandFall = 1 - i / 24; // highs a touch quieter
      const slow = 0.5 + 0.5 * Math.sin(t * 0.45 + i * 0.55);
      const fast = 0.5 + 0.5 * Math.sin(t * 1.6 + i * 1.27);
      const v = (0.4 * slow + 0.28 * fast) * bandFall;
      this.dataArray[i] = Math.max(0, Math.min(255, Math.round(v * 120)));
    }
  }
  get data() {
    return this.dataArray;
  }
}

/**
 * Real audio (master-gain analyser) crossfaded with idle: when the track is
 * audible the visualizer follows it; when it goes quiet it eases back to gentle
 * idle motion rather than freezing.
 */
export class HybridSource implements FreqSource {
  private real: Analyser;
  private idle: IdleSource;
  private buf = new Uint8Array(16);
  private activity = 0;
  constructor(node: AudioNode, seed = 0) {
    this.real = new Analyser(node);
    this.idle = new IdleSource(seed);
  }
  update() {
    this.real.update();
    this.idle.update();
    const rd = this.real.data;
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += rd[i];
    const target = sum > 16 ? 1 : 0; // audible vs silent
    this.activity += (target - this.activity) * 0.06; // ~1s ease
    const a = this.activity;
    const id = this.idle.data;
    for (let i = 0; i < 16; i++) this.buf[i] = Math.round((rd[i] || 0) * a + id[i] * (1 - a));
  }
  get data() {
    return this.buf;
  }
  dispose() {
    this.real.dispose();
  }
}
