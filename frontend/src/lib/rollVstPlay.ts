/**
 * rollVstPlay — a piano-roll part's notes and channel messages as the MIDI its
 * VST3 instrument plays, over the live host's `midi` op
 * (docs/design/vst-live-protocol.md).
 *
 * THE ROLL'S CLOCK. The live host places a message by the timeline position
 * of the audio block that holds it. A roll part's instrument does not follow
 * EDIT's transport: it follows the roll's (lib/vstLive/vstLiveNode
 * setVstEntryTransport), whose position is a line through context time, one
 * segment at a time (`RollVstClock`). While the roll plays, the line starts at
 * PLAY's first downbeat on the roll second of the step PLAY started from and
 * runs on through loop wraps and seeks, so every message the scheduler hands
 * out for a context time has one place on it, and the plugin's own tempo-synced
 * parts keep their phase. While the roll is stopped it runs on as well
 * (`freeRun`), so a note auditioned from the grid or the keyboard plays on
 * time. Stopping continues the line where it was; only PLAY jumps it.
 *
 * LATENCY. The node's position is sent `latencySamples` ahead of the line (the
 * plugin's latency plus the bridge's buffering, vstLiveStore
 * entryLatencySamples), while a message is stamped on the line itself. So a
 * note stamped for context time `t` lands in the block that enters the plugin
 * that much before `t`, and comes out at `t`, in time with the soundfont parts
 * beside it; and the position the plugin reads for a block is the roll's
 * position at the moment that block is heard.
 *
 * No Vite-only imports, so node tests load it.
 */
import type { VstMidiEvent } from './vstLive/bridgeClient';
import type { VstTransportInfo } from './vstLive/vstLiveNode';
import type { RollTickResult, ScheduledRollNote, ScheduledWheel } from './rollPartPlay';

/** One segment of the roll's clock: at context time `atTime` it reads `atSec` roll seconds, and it runs at one second a second from there. */
export interface RollVstClock {
  atTime: number;
  atSec: number;
  /** True while the roll plays; the plugin reads it as its transport playing. */
  playing: boolean;
}

/** The clock before anything played: context time itself, stopped. */
export const IDLE_ROLL_VST_CLOCK: RollVstClock = Object.freeze({ atTime: 0, atSec: 0, playing: false });

/** The roll second the clock reads at context time `t`. */
export const clockSecAt = (clock: RollVstClock, t: number): number => clock.atSec + (t - clock.atTime);

/** Where a message for context time `t` sits on the clock, in sample frames at `sampleRate`: its `pos`. Never below 0. */
export const clockStamp = (clock: RollVstClock, t: number, sampleRate: number): number =>
  Math.max(0, Math.round(clockSecAt(clock, t) * sampleRate));

/** The clock PLAY starts: its first downbeat (context time `origin`) reads `startSec`, the roll second of the step it starts from. */
export const playingClock = (origin: number, startSec: number): RollVstClock => ({
  atTime: origin,
  atSec: Math.max(0, startSec),
  playing: true,
});

/** The clock STOP leaves at context time `now`: the same line, stopped, so a message already stamped keeps its place. */
export const stoppedClock = (clock: RollVstClock, now: number): RollVstClock => ({
  atTime: now,
  atSec: clockSecAt(clock, now),
  playing: false,
});

/**
 * The transport a part instrument's live node follows on `clock`: running
 * whether or not the roll plays (`freeRun`), its position `latencySamples`
 * ahead of the line (see LATENCY above), anchored at the segment's start.
 */
export function clockTransport(
  clock: RollVstClock,
  sampleRate: number,
  latencySamples: number,
  tempoBpm: number,
  discontinuity = false,
): VstTransportInfo {
  return {
    playing: clock.playing,
    freeRun: true,
    positionSamples: Math.round(clock.atSec * sampleRate) + Math.max(0, Math.round(latencySamples)),
    atTime: clock.atTime,
    tempoBpm: Number.isFinite(tempoBpm) && tempoBpm > 0 ? tempoBpm : 0,
    discontinuity,
  };
}

/** The plugin channel (0-15) a VST3 part's own notes play on: its Channel setting, else 1 (0 here). */
export const vstBaseChannel = (partChannel: number | null): number =>
  partChannel !== null && Number.isFinite(partChannel) ? Math.max(0, Math.min(15, Math.round(partChannel) - 1)) : 0;

/**
 * The plugin channel (0-15) of each of a VST3 part's live channels (`live`,
 * its own first, as the scheduler's partChannels lists them): its own on the
 * part's MIDI channel (the Channel setting, else 1; a percussion part's is 10),
 * each next one (a bent lane's, an expressive note's member channel) the
 * channel up from the one before, wrapping past 16. On Auto that is an MPE
 * lower zone: the part's notes on channel 1, its expressive notes on 2 up.
 */
export function vstPartChannels(live: readonly number[], partChannel: number | null): Map<number, number> {
  const base = vstBaseChannel(partChannel);
  const out = new Map<number, number>();
  live.forEach((ch, i) => {
    if (!out.has(ch)) out.set(ch, (base + i) % 16);
  });
  return out;
}

const b7 = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));

/** A scheduler channel message as MIDI bytes on plugin channel `ch`: one message, or the four of a bend range's RPN 0/0. */
export function wheelBytes(w: Pick<ScheduledWheel, 'kind' | 'value' | 'controller'>, ch: number): number[][] {
  const c = ch & 0x0f;
  if (w.kind === 'wheel') {
    const v = Math.max(0, Math.min(16383, Math.round(w.value)));
    return [[0xe0 | c, v & 0x7f, v >> 7]];
  }
  if (w.kind === 'range') {
    // RPN 0/0, pitch bend sensitivity: select it, the semitones in the data entry MSB, 0 cents in the LSB.
    return [[0xb0 | c, 101, 0], [0xb0 | c, 100, 0], [0xb0 | c, 6, b7(w.value)], [0xb0 | c, 38, 0]];
  }
  if (w.kind === 'pressure') return [[0xd0 | c, b7(w.value)]];
  return [[0xb0 | c, b7(w.controller ?? 0), b7(w.value)]];
}

/** Where one VST3 part's messages go: its instrument entry, the plugin channel of each of its live channels, and its clock's stamp. */
export interface RollVstRoute {
  entryId: string;
  channels: ReadonlyMap<number, number>;
  /** The `pos` of a message for context time `t`. */
  stamp: (t: number) => number;
}

/** One scheduler window split between the synth and the parts' plugins. */
export interface RollTickSplit {
  /** What the soundfont or the built-in voice plays, as the scheduler handed it over. */
  notes: ScheduledRollNote[];
  wheels: ScheduledWheel[];
  /** Each VST3 part's messages, by instrument entry id, channel messages ahead of notes at one time. */
  midi: Map<string, VstMidiEvent[]>;
}

/**
 * Split a scheduler window (lib/rollPartPlay tick or release): every note and
 * channel message of a part `routeOf` gives a route goes to its plugin as
 * stamped MIDI (a note as its note-on at `when` and its note-off `duration`
 * later), and everything else stays for the synth. A channel message finds
 * its part through `ownerOf` (the scheduler's channelOwner). A message with
 * no time plays at `now`.
 */
export function splitRollTick(
  out: Pick<RollTickResult, 'notes' | 'wheels'>,
  routeOf: (partId: string) => RollVstRoute | undefined,
  ownerOf: (channel: number) => string | undefined,
  now: number,
): RollTickSplit {
  const notes: ScheduledRollNote[] = [];
  const wheels: ScheduledWheel[] = [];
  const midi = new Map<string, VstMidiEvent[]>();
  const push = (route: RollVstRoute, events: VstMidiEvent[]): void => {
    const list = midi.get(route.entryId);
    if (list) list.push(...events);
    else midi.set(route.entryId, events);
  };
  for (const w of out.wheels) {
    const owner = ownerOf(w.channel);
    const route = owner !== undefined ? routeOf(owner) : undefined;
    if (!route) {
      wheels.push(w);
      continue;
    }
    const pos = route.stamp(w.time ?? now);
    const ch = route.channels.get(w.channel) ?? 0;
    push(route, wheelBytes(w, ch).map((data) => ({ pos, data })));
  }
  for (const n of out.notes) {
    const route = routeOf(n.partId);
    if (!route) {
      if (!n.keyswitch) notes.push(n);
      continue;
    }
    const ch = (route.channels.get(n.channel) ?? 0) & 0x0f;
    const key = b7(n.note);
    push(route, [
      { pos: route.stamp(n.when), data: [0x90 | ch, key, Math.max(1, b7(n.velocity))] },
      { pos: route.stamp(n.when + Math.max(0, n.duration)), data: [0x80 | ch, key, 0] },
    ]);
  }
  return { notes, wheels, midi };
}
