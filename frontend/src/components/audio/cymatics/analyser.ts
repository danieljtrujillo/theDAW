/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Analyser class for live audio visualisation. Wraps a Web Audio AnalyserNode
 * with a fixed 16-bin byte frequency buffer (fftSize 32) that the cymatics
 * visualizer reads each frame. Tapping is non-destructive: it fans out from the
 * source node, so disposing only removes this branch.
 */
export class Analyser {
  private analyser: AnalyserNode;
  private source: AudioNode;
  private dataArray: Uint8Array;

  constructor(node: AudioNode) {
    this.source = node;
    this.analyser = node.context.createAnalyser();
    this.analyser.fftSize = 32;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    node.connect(this.analyser);
  }

  update() {
    this.analyser.getByteFrequencyData(this.dataArray);
  }

  get data() {
    return this.dataArray;
  }

  /** Detach this analyser branch from the source (call on unmount). */
  dispose() {
    try {
      this.source.disconnect(this.analyser);
    } catch {
      /* already disconnected */
    }
  }
}
