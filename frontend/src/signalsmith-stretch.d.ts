/**
 * Ambient types for `signalsmith-stretch` (MIT) — the package ships JS+WASM but
 * no .d.ts. Mirrors the documented Web Audio API (README): a factory returning
 * an AudioWorkletNode with async control methods. Used by djEngine for key-lock.
 */
declare module 'signalsmith-stretch' {
  export interface StretchScheduleOptions {
    /** AudioContext time for this change (the node compensates its own latency). */
    output?: number;
    /** Whether the node is processing audio. */
    active?: boolean;
    /** Position in the input buffer (buffer mode only). */
    input?: number;
    /** Playback rate, e.g. 0.5 = half speed (buffer mode only). */
    rate?: number;
    /** Pitch shift in semitones. */
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    /** Auto-loop section (buffer mode only); disabled when both are equal. */
    loopStart?: number;
    loopEnd?: number;
  }

  export interface StretchNode extends AudioWorkletNode {
    /** Current input playback position, in seconds (updated via setUpdateInterval). */
    inputTime: number;
    schedule(options: StretchScheduleOptions): Promise<void>;
    start(when?: number): Promise<void>;
    stop(when?: number): Promise<void>;
    /** Live-input latency, in seconds. */
    latency(): Promise<number>;
    addBuffers(channels: Float32Array[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number } | void>;
    setUpdateInterval(seconds: number, callback?: (t: number) => void): Promise<void>;
    configure(options: {
      blockMs?: number;
      intervalMs?: number;
      splitComputation?: boolean;
      preset?: 'default' | 'cheaper';
    }): Promise<void>;
  }

  /** Create a Signalsmith Stretch AudioWorkletNode (stereo insert by default). */
  export default function SignalsmithStretch(
    audioContext: BaseAudioContext,
    options?: AudioWorkletNodeOptions,
  ): Promise<StretchNode>;
}
