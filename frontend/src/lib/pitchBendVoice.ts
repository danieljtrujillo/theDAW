/**
 * pitchBendVoice — makes a Web Audio voice follow a lane's pitch bend.
 *
 * A voice builds its graph through the context it is handed (lib/synthVoices).
 * voiceContext hands it one whose every oscillator has a ConstantSourceNode
 * wired into its `detune`. An AudioParam adds whatever is connected to it to its
 * own value, so the bend in cents rides on top of the detune a voice sets itself
 * (a supersaw keeps its spread) and on an FM voice the modulator moves with the
 * carrier.
 *
 * stepNotesToRender turns the roll's step notes into render notes in seconds,
 * each with its channel and its bend, plus each bent lane's wheel messages for
 * a soundfont render. It takes a 16th's seconds, or a StepClock (lib/rollTempo)
 * when the roll's tempo map changes tempo, ramps or holds a fermata.
 *
 * No Vite-only imports, so node tests load it.
 */
import {
  bendAutomation,
  bendAutomationIsFlat,
  bendWheelEvents,
  playingLane,
  type BendAutomationEvent,
  type RollRenderBends,
} from './pitchBend';
import type { RenderNote } from './midiSynth';
import type { SmfWheel } from './midiWrite';
import { spanSec, stepsIn, type StepClock } from './rollTempo';

/**
 * A voice's bend: the automation, and where it sits in time (step `originStep`
 * sounds at the voice's `when`, one step lasts `stepSec`). Under a tempo map a
 * step does not last one fixed time, so `stepTime` gives the seconds of a step
 * on the automation's own axis, and it wins over `stepSec`.
 */
export interface VoiceBend {
  events: BendAutomationEvent[];
  originStep: number;
  stepSec: number;
  stepTime?: (step: number) => number;
}

/** Seconds a bend outlives its note: past the longest release any built-in voice rings for. */
export const BEND_TAIL_SEC = 0.8;

type ParamLike = Pick<AudioParam, 'setValueAtTime' | 'linearRampToValueAtTime'>;

/** The context time of `step` for a voice that starts at `when`. */
export const bendEventTime = (bend: VoiceBend, when: number, step: number): number =>
  bend.stepTime ? when + bend.stepTime(step) - bend.stepTime(bend.originStep) : when + (step - bend.originStep) * bend.stepSec;

/** Write the bend onto a parameter in cents: a set for each set, a linear ramp for each ramp. */
export function scheduleBendAutomation(param: ParamLike, bend: VoiceBend, when: number): void {
  for (const e of bend.events) {
    const t = Math.max(0, bendEventTime(bend, when, e.step));
    if (e.ramp) param.linearRampToValueAtTime(e.cents, t);
    else param.setValueAtTime(e.cents, t);
  }
}

/**
 * `ctx` as a voice sees it, with `source` connected to the detune of every
 * oscillator the voice creates. Everything else is the context's own, bound to it.
 */
export function bendVoiceContext<T extends BaseAudioContext>(ctx: T, source: AudioNode): T {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'createOscillator') {
        return () => {
          const osc = target.createOscillator();
          source.connect(osc.detune);
          return osc;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A ConstantSourceNode playing the bend in cents from `when` until the voice's tail ends, or null when the bend stays at 0. */
export function startBendSource(ctx: BaseAudioContext, bend: VoiceBend | undefined, when: number, duration: number): ConstantSourceNode | null {
  if (!bend || bendAutomationIsFlat(bend.events)) return null;
  const src = ctx.createConstantSource();
  scheduleBendAutomation(src.offset, bend, when);
  src.start(when);
  src.stop(when + Math.max(0, duration) + BEND_TAIL_SEC);
  return src;
}

/** The context a voice starting at `when` builds on: bent when `bend` moves, else `ctx` itself. */
export function voiceContext<T extends BaseAudioContext>(ctx: T, bend: VoiceBend | undefined, when: number, duration: number): T {
  const src = startBendSource(ctx, bend, when, duration);
  return src ? bendVoiceContext(ctx, src) : ctx;
}

/** A step-grid note as the roll and its clips hold it. */
export interface StepNote {
  note: number;
  velocity: number;
  step: number;
  length: number;
  lane?: number;
}

/**
 * Step notes as render notes at `timing`: a 16th's seconds, or a StepClock
 * (lib/rollTempo) whose steps last as long as the roll's tempo map says. With
 * no bends each note is the four fields a render has always taken. With bends
 * each note carries its lane's channel, and its bend when its lane has one, and
 * `wheel` holds each bent lane's range and messages for a soundfont render.
 * A one-tempo clock renders exactly as its 16th's seconds do.
 */
export function stepNotesToRender(
  notes: readonly StepNote[],
  timing: number | StepClock,
  bends?: RollRenderBends,
): { notes: RenderNote[]; wheel: SmfWheel[] } {
  if (typeof timing !== 'number' && timing.stepSec === undefined) return mappedNotesToRender(notes, timing, bends);
  const stepSec = typeof timing === 'number' ? timing : (timing.stepSec as number);
  if (!bends) {
    return {
      notes: notes.map((n) => ({ midi: n.note, velocity: n.velocity, startSec: n.step * stepSec, durationSec: n.length * stepSec })),
      wheel: [],
    };
  }
  const tailSteps = BEND_TAIL_SEC / stepSec;
  const out = notes.map((n) => {
    const lane = playingLane(n.lane, bends.lanes);
    const r: RenderNote = {
      midi: n.note,
      velocity: n.velocity,
      startSec: n.step * stepSec,
      durationSec: n.length * stepSec,
      channel: bends.channels.get(lane) ?? 0,
    };
    const played = bends.played.get(lane);
    if (played) {
      const events = bendAutomation(played.points, played.range, n.step, n.step + n.length + tailSteps);
      if (!bendAutomationIsFlat(events)) r.bend = { events, originStep: n.step, stepSec };
    }
    return r;
  });
  // No wheel message past the last note's tail, so the wheel never lengthens a render.
  const soundEnd = notes.reduce((m, n) => Math.max(m, n.step + n.length), 0) + tailSteps;
  const wheel: SmfWheel[] = [...bends.played].map(([lane, p]) => ({
    channel: bends.channels.get(lane) ?? 0,
    range: p.range,
    events: bendWheelEvents(p.points, 0, Math.min(p.points[p.points.length - 1].step, soundEnd), true, p.range).map((e) => ({
      sec: e.step * stepSec,
      raw: e.raw,
    })),
  }));
  return { notes: out, wheel };
}

/**
 * stepNotesToRender under a tempo map: each note starts at its step's seconds
 * and lasts until its end step's, so a note inside a ritardando is as long as
 * its bar there, and a note under a fermata is held. A bend's automation keeps
 * its steps and reads their seconds from the clock (VoiceBend.stepTime); each
 * wheel message is sent at its step's seconds.
 */
function mappedNotesToRender(
  notes: readonly StepNote[],
  clock: StepClock,
  bends?: RollRenderBends,
): { notes: RenderNote[]; wheel: SmfWheel[] } {
  const timed = (n: StepNote): RenderNote => ({
    midi: n.note,
    velocity: n.velocity,
    startSec: clock.at(n.step),
    durationSec: spanSec(clock, n.step, n.length),
  });
  if (!bends) return { notes: notes.map(timed), wheel: [] };
  const out = notes.map((n) => {
    const lane = playingLane(n.lane, bends.lanes);
    const r: RenderNote = { ...timed(n), channel: bends.channels.get(lane) ?? 0 };
    const played = bends.played.get(lane);
    if (played) {
      const end = n.step + n.length;
      const events = bendAutomation(played.points, played.range, n.step, end + stepsIn(clock, end, BEND_TAIL_SEC));
      if (!bendAutomationIsFlat(events)) {
        r.bend = { events, originStep: n.step, stepSec: spanSec(clock, n.step, 1), stepTime: clock.at };
      }
    }
    return r;
  });
  const lastEnd = notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);
  const soundEnd = lastEnd + stepsIn(clock, lastEnd, BEND_TAIL_SEC);
  const wheel: SmfWheel[] = [...bends.played].map(([lane, p]) => ({
    channel: bends.channels.get(lane) ?? 0,
    range: p.range,
    events: bendWheelEvents(p.points, 0, Math.min(p.points[p.points.length - 1].step, soundEnd), true, p.range).map((e) => ({
      sec: clock.at(e.step),
      raw: e.raw,
    })),
  }));
  return { notes: out, wheel };
}
