/**
 * synthOutputStage — the safety limiter (public/safety-limiter.worklet.js)
 * that keeps a soundfont synth's lifted presets under -0.3 dBFS.
 *
 * A downloaded sound bank's playback gain (lib/soundbankGain) lifts a quiet
 * preset after the voice. Registration caps each preset's gain so a single
 * velocity-127 note at CC 7 127 stays under the ceiling, but a chord in a
 * lifted preset, its reverb and chorus, and everything else playing with it
 * can still sum past it. So:
 *
 *  - live, one limiter sits at the end of the engine's master chain
 *    (state/playerStore getSafetyInsert, after the MIX rack and the live
 *    master FX, before the meters and the monitor fader), where every synth's
 *    dry channels and its shared reverb/chorus output have summed. It is
 *    active while any live synth channel plays a lifted preset (`LiftTracker`,
 *    fed by each program change at its audio time) and idle otherwise;
 *  - in a render, one limiter takes the whole synth (its sixteen dry outputs,
 *    their per-program-change gain steps and the shared effects output) when
 *    the file plays a lifted preset anywhere (lib/soundbankGain
 *    renderBoosted), and a bounce puts one on its master when a clip in it
 *    plays a lifted voice (lib/renderCore `safetyLimiter`).
 *
 * The limiter is zero latency and stereo linked: a signal that stays under the
 * ceiling passes at a gain of exactly 1, so it only acts when the sum would
 * pass -0.3 dBFS.
 */
import { addWorkletModule } from './audioWorkletSupport';

export const SAFETY_LIMITER_URL = '/safety-limiter.worklet.js';
export const SAFETY_LIMITER_NAME = 'thedaw-safety-limiter';
/** The limiter's ceiling: no sample leaves above it. */
export const SAFETY_CEILING_DB = -0.3;
/** How fast a reduction the limiter took releases back to unity. */
export const SAFETY_RELEASE_SEC = 0.15;

/** A limiter node: a node with the `active` parameter. */
export type LimiterNode = AudioNode & { parameters: { get(name: string): AudioParam | undefined } };

/** The node options every safety limiter is made with. */
export const safetyLimiterOptions = (): AudioWorkletNodeOptions => ({
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [2],
  channelCount: 2,
  channelCountMode: 'explicit',
  processorOptions: { ceilingDb: SAFETY_CEILING_DB, releaseSec: SAFETY_RELEASE_SEC },
});

/** The safety limiter module on `ctx`, loaded once per context; resolves false when it cannot load. */
const moduleByCtx = new WeakMap<BaseAudioContext, Promise<boolean>>();
export function ensureSafetyLimiter(ctx: BaseAudioContext): Promise<boolean> {
  let p = moduleByCtx.get(ctx);
  if (!p) {
    p = addWorkletModule(ctx, SAFETY_LIMITER_URL).then(
      () => true,
      () => false,
    );
    moduleByCtx.set(ctx, p);
  }
  return p;
}

/** A safety limiter on `ctx`, or null when its module is not loaded there. */
export async function safetyLimiterFor(ctx: BaseAudioContext): Promise<LimiterNode | null> {
  if (!(await ensureSafetyLimiter(ctx))) return null;
  try {
    return new AudioWorkletNode(ctx, SAFETY_LIMITER_NAME, safetyLimiterOptions());
  } catch {
    return null;
  }
}

/** Set a limiter's `active` parameter from audio time `time` (0, now, when absent). */
export function setLimiterActive(limiter: LimiterNode | null | undefined, active: boolean, time?: number): void {
  const at = time !== undefined && Number.isFinite(time) ? Math.max(0, time) : 0;
  limiter?.parameters.get('active')?.setValueAtTime(active ? 1 : 0, at);
}

/**
 * Which live synth channels play a lifted preset. `set` records a channel's
 * lift from a program change at audio time `time`; `onChange` hears whether
 * any channel is lifted, and from when, each time that answer changes.
 */
export interface LiftTracker {
  set: (key: string, lifted: boolean, time?: number) => void;
  /** True while any channel plays a lifted preset. */
  active: () => boolean;
}

export function createLiftTracker(onChange: (active: boolean, time: number | undefined) => void): LiftTracker {
  const lifted = new Set<string>();
  return {
    set: (key, on, time) => {
      const before = lifted.size > 0;
      if (on) lifted.add(key);
      else lifted.delete(key);
      const after = lifted.size > 0;
      if (after !== before) onChange(after, time);
    },
    active: () => lifted.size > 0,
  };
}

/** Put `limiter` into a passthrough insert (`input -> output`, the engine's safety insert): `input -> limiter -> output`. */
export function spliceLimiter(insert: { input: AudioNode; output: AudioNode }, limiter: AudioNode): void {
  insert.input.disconnect(insert.output);
  insert.input.connect(limiter);
  limiter.connect(insert.output);
}

/** The part of a WorkletSynthesizer a render wires. */
export interface RenderSynth {
  connect(target: AudioNode): AudioNode;
}

/**
 * Where an offline render's synth plays: every one of its outputs (the
 * sixteen dry channel outputs and the shared reverb/chorus output) into
 * `limiter` when there is one, and the limiter into `destination`, so the
 * whole sum is held under the ceiling; else straight into `destination`.
 * Returns the node the synth plays into, which the per-channel gain steps
 * (lib/soundbankGain routeRenderGains) feed as well.
 */
export function wireRenderOutput(synth: RenderSynth, destination: AudioNode, limiter: AudioNode | null): AudioNode {
  const into = limiter ?? destination;
  if (limiter) limiter.connect(destination);
  synth.connect(into);
  return into;
}
