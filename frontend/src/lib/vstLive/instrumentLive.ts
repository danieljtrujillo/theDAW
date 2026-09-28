/**
 * vstLive/instrumentLive — EDIT's live MIDI for a track whose instrument slot
 * holds a VST3 (editorStore EditorTrack.instrument).
 *
 * The notes go to the plugin's own live host session, the one its `vst3`
 * entry opens like any hosted plugin, over the `midi` op of
 * docs/design/vst-live-protocol.md. What each track plays, and when, is
 * decided by the same scheduler EDIT's synths use (lib/editMidiScheduler):
 * one scheduler per instrument track, so each plugin hears its own track's
 * notes, controllers (every CC the part writes, the pedal first when a clip
 * ends) and lane bends, chased where playback starts, with the clip's gain and
 * fades on the instrument's output.
 *
 * TIMING. The scheduler hands out audio-context seconds; the host places a
 * message by the timeline position of the audio block that holds it. So each
 * message is stamped with its timeline position in sample frames at the
 * session's rate, less the entry's live latency (the plugin's own plus the
 * bridge's buffering, vstLiveStore entryLatencySamples): a note sent that far
 * ahead comes out of the plugin on the beat, the way the track's other audio
 * plays, with no delay compensation asked of the rest of the mix. A message
 * whose block has already gone plays at the start of the next one.
 *
 * STOP, SEEK, LOOP. `stop()` sends `midi_panic`: the host drops what waits and
 * releases every note it let through, so nothing hangs over the jump.
 *
 * No Vite-only imports, so node tests load it.
 */
import type { AudioClip, EditorTrack } from '../../state/editorStore';
import { activeTrackInstrument } from '../../state/editorStore';
import type { ChainEntry } from '../../state/effectChainStore';
import type { VstMidiEvent } from './bridgeClient';
import { isPercussionTrack, type GlobalVoice } from '../clipProgram';
import { localChannel, planEditChannels } from '../editChannels';
import { EditMidiScheduler, clipLiveSlots, type EditMidiSchedulerDeps, type EditMidiSink, type EnvelopeParam } from '../editMidiScheduler';

/** One MIDI channel voice message for the live host's `midi` op. `pos` is timeline sample frames; -1 = now. */
export type VstMidiMessage = VstMidiEvent;

/** Where an instrument's messages go: its session's bridge. */
export interface InstrumentMidiPort {
  sendMidi(events: readonly VstMidiMessage[]): void;
  midiPanic(): void;
}

/** One instrument track as a live pass plays it. */
export interface InstrumentLiveTrack {
  trackId: string;
  entry: ChainEntry;
  liveClipIds: ReadonlySet<string>;
  /** The track's channels, first first: one, plus one per bent lane. */
  channels: number[];
}

const isRollClip = (c: Pick<AudioClip, 'sourceKind' | 'sourcePianoRoll'>): boolean =>
  c.sourceKind === 'piano-roll' && (c.sourcePianoRoll?.length ?? 0) > 0;

/**
 * Every track whose instrument slot plays its MIDI clips: the clips it plays
 * and its channels. A track's bent lanes each get a channel of their own, as
 * they do on EDIT's synths. Muted clips are left to the scheduler, which reads
 * mute every tick.
 */
export function planInstrumentTracks(clips: readonly AudioClip[], tracks: readonly EditorTrack[]): InstrumentLiveTrack[] {
  const out: InstrumentLiveTrack[] = [];
  for (const track of tracks) {
    if (track.isFolder) continue;
    const entry = activeTrackInstrument(track);
    if (!entry) continue;
    const own = clips.filter((c) => c.trackId === track.id && isRollClip(c));
    if (own.length === 0) continue;
    const percussion = isPercussionTrack(track);
    const slots = Math.max(1, ...own.map((c) => clipLiveSlots(c, percussion)));
    const plan = planEditChannels([{ id: track.id, percussion, channels: slots }]);
    const channels = (plan.channelsOf.get(track.id) ?? [0]).map(localChannel);
    out.push({ trackId: track.id, entry, liveClipIds: new Set(own.map((c) => c.id)), channels });
  }
  return out;
}

/** The ids of every MIDI clip an instrument slot plays: EDIT's synths and the clip audio path leave these alone. */
export function instrumentClipIds(clips: readonly AudioClip[], tracks: readonly EditorTrack[]): Set<string> {
  const ids = new Set<string>();
  for (const t of planInstrumentTracks(clips, tracks)) for (const id of t.liveClipIds) ids.add(id);
  return ids;
}

export interface InstrumentSinkOptions {
  /** The timeline second audio-context time `ctxTime` plays at. */
  timelineSecAt: (ctxTime: number) => number;
  /** The session's sample rate. */
  sampleRate: () => number;
  /** The entry's live latency in sample frames, sent ahead by. */
  latencySamples: () => number;
  /** One tick's messages, in the order the scheduler handed them over. */
  send: (events: VstMidiMessage[]) => void;
  /** Called once per batch; the default hands the batch over on the next microtask. */
  schedule?: (flush: () => void) => void;
}

/** An EditMidiSink that turns the scheduler's calls into timed `midi` messages, one op per tick. */
export function vstInstrumentSink(opts: InstrumentSinkOptions): EditMidiSink & { flush(): void } {
  let batch: VstMidiMessage[] = [];
  let armed = false;
  const schedule = opts.schedule ?? ((fn: () => void) => queueMicrotask(fn));
  const flush = (): void => {
    armed = false;
    if (batch.length === 0) return;
    const out = batch;
    batch = [];
    opts.send(out);
  };
  const push = (time: number, data: number[]): void => {
    const pos = Math.round(opts.timelineSecAt(time) * opts.sampleRate()) - Math.max(0, Math.round(opts.latencySamples()));
    batch.push({ pos: Math.max(0, pos), data });
    if (!armed) {
      armed = true;
      schedule(flush);
    }
  };
  const ch = (c: number): number => c & 0x0f;
  const b7 = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));
  return {
    noteOn: (channel, _program, midi, velocity, time) => push(time, [0x90 | ch(channel), b7(midi), Math.max(1, b7(velocity))]),
    noteOff: (channel, midi, time) => push(time, [0x80 | ch(channel), b7(midi), 0]),
    wheel: (channel, raw, time) => {
      const v = Math.max(0, Math.min(16383, Math.round(raw)));
      push(time, [0xe0 | ch(channel), v & 0x7f, v >> 7]);
    },
    wheelRange: (channel, semitones, time) => {
      // RPN 0/0, pitch bend sensitivity: the semitones in the data entry MSB, 0 cents in the LSB.
      const status = 0xb0 | ch(channel);
      push(time, [status, 101, 0]);
      push(time, [status, 100, 0]);
      push(time, [status, 6, b7(semitones)]);
      push(time, [status, 38, 0]);
    },
    control: (channel, controller, value, time) => push(time, [0xb0 | ch(channel), b7(controller), b7(value)]),
    // Channel pressure: an expressive note's pressure on its member channel (lib/mpeRotation).
    pressure: (channel, value, time) => push(time, [0xd0 | ch(channel), b7(value)]),
    flush,
  };
}

export interface InstrumentPassDeps {
  now: () => number;
  clips: () => readonly AudioClip[];
  tracks: () => readonly EditorTrack[];
  global: () => GlobalVoice;
  projectBpm: () => number | undefined;
  /** The session port of an instrument entry, or null while it has none (not open yet, or no host). */
  port: (entryId: string) => InstrumentMidiPort | null;
  /** The session's sample rate for an entry (the context's until it reports its own). */
  sampleRate: (entryId: string) => number;
  latencySamples: (entryId: string) => number;
  /** The gain the instrument's output passes through, which carries the playing clip's gain and fades. */
  envelope?: (trackId: string) => EnvelopeParam | null;
  lookaheadSec?: () => number;
  schedule?: (flush: () => void) => void;
}

/**
 * One live pass over every instrument track: a scheduler per track, anchored
 * where the pass's audio is. `tick()` drives them all; `stop()` ends them and
 * sends each plugin `midi_panic`.
 */
export class InstrumentLivePass {
  private readonly deps: InstrumentPassDeps;
  private runs: Array<{ track: InstrumentLiveTrack; scheduler: EditMidiScheduler; sink: ReturnType<typeof vstInstrumentSink> }> = [];

  constructor(deps: InstrumentPassDeps) {
    this.deps = deps;
  }

  get trackIds(): string[] {
    return this.runs.map((r) => r.track.trackId);
  }

  /** Transport second `fromSec` sounds at context time `anchorCtx`; nothing is scheduled at or past `endSec()`. */
  start(plan: readonly InstrumentLiveTrack[], fromSec: number, anchorCtx: number, endSec: () => number = () => Infinity): void {
    this.stop();
    for (const track of plan) {
      const entryId = track.entry.id;
      const sink = vstInstrumentSink({
        timelineSecAt: (ctxTime) => fromSec + (ctxTime - anchorCtx),
        sampleRate: () => this.deps.sampleRate(entryId),
        latencySamples: () => this.deps.latencySamples(entryId),
        send: (events) => this.deps.port(entryId)?.sendMidi(events),
        schedule: this.deps.schedule,
      });
      const schedulerDeps: EditMidiSchedulerDeps = {
        now: this.deps.now,
        sink,
        clips: () => this.deps.clips().filter((c) => c.trackId === track.trackId),
        // The scheduler plays a clip that has a program; the plugin plays its own preset whatever
        // the number, so a track with none is given one it never hears.
        tracks: () => this.deps.tracks().filter((t) => t.id === track.trackId).map((t) => ({ ...t, instrumentProgram: t.instrumentProgram ?? 0 })),
        global: this.deps.global,
        projectBpm: this.deps.projectBpm,
        envelope: this.deps.envelope,
        lookaheadSec: this.deps.lookaheadSec,
      };
      const scheduler = new EditMidiScheduler(schedulerDeps);
      const pass = { liveClipIds: track.liveClipIds, channelsOf: new Map([[track.trackId, track.channels]]) };
      scheduler.prepare(pass);
      scheduler.start(pass, fromSec, anchorCtx, endSec);
      this.runs.push({ track, scheduler, sink });
    }
  }

  tick(): void {
    for (const r of this.runs) r.scheduler.tick();
  }

  /** End the pass: no more messages, and every plugin releases what it holds. */
  stop(): void {
    for (const r of this.runs) {
      r.scheduler.stop();
      // The note-offs the stop answered queued notes with go first; the panic after them drops
      // what still waits in the host and releases what sounds.
      r.sink.flush();
      this.deps.port(r.track.entry.id)?.midiPanic();
    }
    this.runs = [];
  }
}
