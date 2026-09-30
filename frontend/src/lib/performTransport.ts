/**
 * performTransport — PERFORM's session grid as the transport its hosted plugins follow.
 *
 * A VST3 on a grid column hears where the transport is through the broadcast
 * EDIT's mixer uses (lib/vstLive/vstLiveNode `broadcastVstTransport`): whether
 * it plays, the position in sample frames and the tempo. The grid has no
 * timeline of its own. Its time is the shared beat clock (lib/beatClock), whose
 * anchor is bar 0, beat 0, so the position a plugin is given is the clock's
 * beats since that anchor written as sample frames at the tempo it is given.
 * The host derives its musical position as
 * `positionSamples / sampleRate * tempoBpm / 60`, which is then the grid's beat.
 *
 * The transport starts with the first clip the grid starts after a stop and
 * stops with the grid's Stop, which also runs when PERFORM closes. While it
 * plays, a change on the clock is passed on: a new tempo keeps the beat the
 * grid is on, and a clock re-anchored under the grid is a jump, which the host
 * answers by resetting the plugin.
 *
 * Units: seconds are AudioContext seconds; positions are sample frames.
 */
import { beatClock } from './beatClock';
import { getTempoAtBeat, timeToBeat, type TempoEvent } from './tempoMap';
import { broadcastVstTransport, type VstTransportInfo } from './vstLive/vstLiveNode';
import { getEngineCtx } from '../state/playerStore';

/** The part of the beat clock the transport reads. */
export interface PerformClock {
  readonly state: { anchor: number | null };
  readonly tempoMap: TempoEvent[];
  subscribe(fn: () => void): () => void;
}

/** Seams for tests; the grid passes none. */
export interface PerformTransportDeps {
  clock?: PerformClock;
  /** The context the grid plays on: its time and its sample rate. */
  ctx?: () => { currentTime: number; sampleRate: number };
  broadcast?: (info: VstTransportInfo) => void;
}

export interface PerformTransport {
  /** A clip started on the grid. The first one after a stop starts the transport. */
  play(): void;
  /** The grid's Stop. */
  stop(): void;
  isPlaying(): boolean;
}

/** Beats apart that still count as the same place on the clock. */
const SAME_BEAT = 1e-3;

export function createPerformTransport(deps: PerformTransportDeps = {}): PerformTransport {
  const clock = deps.clock ?? beatClock;
  const ctxOf = deps.ctx ?? getEngineCtx;
  const broadcast = deps.broadcast ?? broadcastVstTransport;

  let playing = false;
  /** What the last broadcast said, to tell a tempo change from a jump. */
  let last: { beats: number; tempo: number; atSec: number } | null = null;
  let unsubscribe: (() => void) | null = null;

  /** The clock's beat and tempo at context time `t`. */
  const where = (t: number): { beats: number; tempo: number } => {
    const map = clock.tempoMap;
    const anchor = clock.state.anchor ?? t;
    const beats = timeToBeat(map, t - anchor);
    return { beats, tempo: getTempoAtBeat(map, beats) };
  };

  const send = (isPlaying: boolean, discontinuity: boolean): void => {
    const ctx = ctxOf();
    const t = ctx.currentTime;
    const { beats, tempo } = where(t);
    last = { beats, tempo, atSec: t };
    const valid = Number.isFinite(tempo) && tempo > 0;
    broadcast({
      playing: isPlaying,
      positionSamples: valid ? Math.round(((beats * 60) / tempo) * ctx.sampleRate) : 0,
      tempoBpm: valid ? tempo : 0,
      discontinuity,
      atSec: t,
    });
  };

  /** A clock change while the grid plays: a new tempo, a jump, or neither (a new meter). */
  const onClock = (): void => {
    if (!playing || !last) return;
    const t = ctxOf().currentTime;
    const { beats, tempo } = where(t);
    const expected = last.beats + ((t - last.atSec) * last.tempo) / 60;
    const jumped = Math.abs(beats - expected) > SAME_BEAT;
    if (!jumped && tempo === last.tempo) return;
    send(true, jumped);
  };

  return {
    play() {
      if (playing) return;
      playing = true;
      unsubscribe ??= clock.subscribe(onClock);
      send(true, true);
    },
    stop() {
      if (!playing) return;
      playing = false;
      unsubscribe?.();
      unsubscribe = null;
      // Stopping holds the position, as a pause does; the next play is the jump.
      send(false, false);
    },
    isPlaying: () => playing,
  };
}
