/**
 * singPitch.ts - the live microphone pitch for the SING pitch lane.
 *
 * Wraps the existing YIN capture (vocalToMidi.startVocalCapture) with the
 * song clock: every worklet frame carries the audio-context time it was
 * measured at, so its song position is the clock now minus the frame's age,
 * minus the user's mic offset. The capture graph ends in a zero-gain sink,
 * so nothing from the mic reaches the speakers.
 */
import { frequencyToMidi, startVocalCapture, type VocalCaptureController } from '../../../lib/vocalToMidi';
import { getEngineCtx } from '../../../state/playerStore';

export interface SingMicFrame {
  /** Song position of the frame, ms (offset applied). */
  songMs: number;
  hz: number;
  midi: number;
  clarity: number;
  rms: number;
}

export interface SingMic {
  getLevel: () => number;
  stop: () => void;
}

export const startSingMic = async (
  deviceId: string | undefined,
  getPosMs: () => number,
  getOffsetMs: () => number,
  onFrame: (frame: SingMicFrame) => void,
): Promise<SingMic> => {
  const ctx = getEngineCtx();
  const controller: VocalCaptureController = await startVocalCapture(deviceId, {
    onFrame: (frame, ctxSec) => {
      if (!(frame.hz > 0)) return;
      const ageMs = Math.max(0, ctx.currentTime - ctxSec) * 1000;
      onFrame({
        songMs: getPosMs() - ageMs - getOffsetMs(),
        hz: frame.hz,
        midi: frequencyToMidi(frame.hz),
        clarity: frame.clarity,
        rms: frame.rms,
      });
    },
  });
  return {
    getLevel: () => controller.getLevel(),
    stop: () => {
      try {
        void controller.stop();
      } catch {
        /* already stopped */
      }
    },
  };
};

/** The last few seconds of mic frames, for drawing the sung trace. */
export class FrameRing {
  private frames: SingMicFrame[] = [];
  constructor(private readonly windowMs = 4000) {}

  push(frame: SingMicFrame): void {
    this.frames.push(frame);
    const cutoff = frame.songMs - this.windowMs;
    // Frames arrive in time order; drop from the front until inside the window.
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].songMs < cutoff) drop += 1;
    if (drop > 0) this.frames.splice(0, drop);
  }

  slice(fromMs: number, toMs: number): SingMicFrame[] {
    return this.frames.filter((f) => f.songMs >= fromMs && f.songMs <= toMs);
  }

  clear(): void {
    this.frames = [];
  }

  get peakRms(): number {
    let peak = 0;
    for (const f of this.frames) if (f.rms > peak) peak = f.rms;
    return peak;
  }
}
