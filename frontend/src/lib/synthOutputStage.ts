/**
 * synthOutputStage — the node each output of a live soundfont synth plays
 * into, and the safety limiter (public/safety-limiter.worklet.js) a channel
 * gets while its preset plays above unity.
 *
 * A downloaded sound bank's playback gain (lib/soundbankGain) lifts a quiet
 * preset after the voice, so a chord in it can pass full scale. While a
 * channel plays such a preset, its dry output runs through a peak limiter
 * with a -0.3 dBFS ceiling; a signal that never reaches the ceiling passes at
 * a gain of exactly 1, and a channel whose preset has no lift passes with no
 * limiting at all.
 *
 * A WorkletSynthesizer has seventeen outputs: 0 the shared effects bus, 1-16
 * channel n % 16's dry output. The stage puts a node of its own after each,
 * and routing (the engine master, an EDIT track) connects from those nodes,
 * so a limiter can go in between the synth and a stage node without the
 * routing seeing it. A limiter is made the first time its output's channel
 * plays a lifted preset, and its `active` parameter follows the channel's
 * program changes at their audio times after that.
 *
 * The offline render puts one limiter after the whole synth instead
 * (`safetyLimiterFor`), when the file plays a lifted preset anywhere
 * (lib/soundbankGain renderBoosted).
 */
import { addWorkletModule } from './audioWorkletSupport';

export const SAFETY_LIMITER_URL = '/safety-limiter.worklet.js';
export const SAFETY_LIMITER_NAME = 'thedaw-safety-limiter';
/** The limiter's ceiling: no sample leaves above it. */
export const SAFETY_CEILING_DB = -0.3;
/** How fast a reduction the limiter took releases back to unity. */
export const SAFETY_RELEASE_SEC = 0.15;
/** A synth's outputs: the effects bus and sixteen dry channel outputs. */
export const SYNTH_OUTPUTS = 17;

/** The output a channel's dry signal leaves on. */
export const outputOf = (channel: number): number => (Math.max(0, Math.round(channel)) % 16) + 1;

/** The parts of a WorkletSynthesizer the stage wires. */
export interface StageSynth {
  connect(target: AudioNode): AudioNode;
  connectChannel(target: AudioNode, channel: number): AudioNode;
  disconnectChannel(target: AudioNode, channel: number): void;
}

/** A limiter node: a node with the `active` parameter. */
export type LimiterNode = AudioNode & { parameters: { get(name: string): AudioParam | undefined } };

export interface OutputStage {
  synth: StageSynth;
  /** One node per output; routing connects from these. */
  outs: AudioNode[];
  /** The limiter between an output and its node, once one was needed. */
  limiters: Array<LimiterNode | null>;
  /** The channels of each output that play a lifted preset now. */
  lifted: Map<number, Set<number>>;
  /** Makes a limiter, or null when the context has none (the worklet did not load). */
  makeLimiter: () => LimiterNode | null;
}

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

/**
 * Put a node after each of `synth`'s outputs. The synth must not be connected
 * anywhere yet; connect the stage (`stageConnect`) where the synth would go.
 */
export function createOutputStage(
  ctx: Pick<BaseAudioContext, 'createGain'>,
  synth: StageSynth,
  makeLimiter: () => LimiterNode | null,
): OutputStage {
  const outs: AudioNode[] = Array.from({ length: SYNTH_OUTPUTS }, () => ctx.createGain());
  // Every output into the effects node, then each dry output moved to its own.
  synth.connect(outs[0]);
  for (let ch = 0; ch < 16; ch += 1) {
    synth.disconnectChannel(outs[0], ch);
    synth.connectChannel(outs[ch + 1], ch);
  }
  return { synth, outs, limiters: Array.from({ length: SYNTH_OUTPUTS }, () => null), lifted: new Map(), makeLimiter };
}

/** Every output of the stage into `dest`. */
export function stageConnect(stage: OutputStage, dest: AudioNode): void {
  for (const o of stage.outs) o.connect(dest);
}

/** Every output of the stage off `dest`. */
export function stageDisconnect(stage: OutputStage, dest: AudioNode): void {
  for (const o of stage.outs) {
    try {
      o.disconnect(dest);
    } catch {
      /* this output was not on dest */
    }
  }
}

/** Channel `channel`'s dry output into `dest`. */
export function stageConnectChannel(stage: OutputStage, dest: AudioNode, channel: number): void {
  stage.outs[outputOf(channel)].connect(dest);
}

/** Channel `channel`'s dry output off `dest`. */
export function stageDisconnectChannel(stage: OutputStage, dest: AudioNode, channel: number): void {
  stage.outs[outputOf(channel)].disconnect(dest);
}

/**
 * Channel `channel` plays a lifted preset (`lifted`) from audio time `time`
 * (now when absent) or no longer does. The first lift on an output puts a
 * limiter in front of its node; the limiter is active while any channel of
 * the output plays a lifted preset.
 */
export function setChannelLift(stage: OutputStage, channel: number, lifted: boolean, time?: number): void {
  const out = outputOf(channel);
  const set = stage.lifted.get(out) ?? new Set<number>();
  if (lifted) set.add(channel);
  else set.delete(channel);
  stage.lifted.set(out, set);
  let limiter = stage.limiters[out];
  if (!limiter) {
    if (set.size === 0) return;
    limiter = stage.makeLimiter();
    if (!limiter) return;
    // Idle until the lift's own time: the channel may still play an earlier preset.
    limiter.parameters.get('active')?.setValueAtTime(0, 0);
    stage.synth.disconnectChannel(stage.outs[out], channel);
    stage.synth.connectChannel(limiter, channel);
    limiter.connect(stage.outs[out]);
    stage.limiters[out] = limiter;
  }
  const at = time !== undefined && Number.isFinite(time) ? Math.max(0, time) : 0;
  limiter.parameters.get('active')?.setValueAtTime(set.size > 0 ? 1 : 0, at);
}
