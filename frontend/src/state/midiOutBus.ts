/**
 * MIDI out: MIDI thru, and each EDIT track's own output port with clock.
 *
 * MIDI thru. Everything that arrives on the MIDI bus (hardware ports, the
 * Quest bridge, the Sway surface) is forwarded byte-for-byte to one chosen
 * output port, so a controller can drive an external synth or a DAW over a
 * virtual cable while theDAW is playing it too. Default is NO target, and
 * with no target thru subscribes to nothing and sends nothing.
 *
 * Track outputs. An EDIT track can name an output port (EditorTrack
 * `midiOut`): while EDIT plays, everything its live MIDI does (lib/
 * editMidiScheduler: bank select and program, notes, wheel and range,
 * controllers, an expressive note's pressure on its member channel) also goes
 * to that port, each message stamped with the moment it sounds, on the
 * track's channel and, for the track's further channels (bent lanes and
 * member channels), the channels after it. A track with `clock` on also sends
 * the port MIDI clock (24 to the quarter note, following EDIT's tempo map),
 * a Song Position Pointer and Start or Continue where playback starts, and
 * Stop where it stops, so the timeline drives an external orchestral host.
 *
 * App.tsx owns the single requestMIDIAccess and hands the output ports here.
 */
import { create } from 'zustand';
import type { DeviceRef, LiveDevice } from '../lib/ioResolve';
import { resolveRef } from '../lib/ioResolve';
import { bendRangeMessages } from '../lib/midi';
import { programSwitch } from '../lib/soundfontEngine';
import type { EditMidiSink } from '../lib/editMidiScheduler';
import { logError, logInfo, logWarn } from './logStore';
import { subscribeToMidi } from './midiBus';

interface OutPort {
  id: string;
  name: string;
  /** Send bytes now, or at `timestamp` (performance.now() milliseconds). */
  send: (data: number[], timestamp?: number) => void;
}

let ports: OutPort[] = [];
let wanted: DeviceRef = { id: '', label: '' };
let activeId = '';
let unsubscribe: (() => void) | null = null;

/** The output ports now, for the controls that list them. */
export const useMidiOutPorts = create<{ ports: LiveDevice[] }>(() => ({ ports: [] }));

/** The output ports as live devices, for the menu. */
export const midiOutDevices = (): LiveDevice[] => ports.map((p) => ({ id: p.id, label: p.name }));

const stop = (): void => {
  unsubscribe?.();
  unsubscribe = null;
  activeId = '';
};

const start = (port: OutPort): void => {
  if (activeId === port.id && unsubscribe) return;
  stop();
  activeId = port.id;
  unsubscribe = subscribeToMidi((msg) => {
    try {
      port.send(msg.data);
    } catch (e) {
      // A port that vanished mid-stream throws on every message; stop rather
      // than flooding the log, and let the next re-sync pick it up again.
      logError('midi', `MIDI thru to ${port.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      stop();
    }
  });
  logInfo('midi', `MIDI thru -> ${port.name}`);
};

/** Re-evaluate the wanted target against the ports currently open. */
const sync = (): void => {
  if (!wanted.id && !wanted.label) {
    if (activeId) logInfo('midi', 'MIDI thru off');
    stop();
    return;
  }
  const resolved = resolveRef(wanted, midiOutDevices(), true);
  const port = ports.find((p) => p.id === resolved.deviceId);
  if (!port) {
    stop();
    return;
  }
  start(port);
};

/** App.tsx publishes the open output ports here (initial + every statechange). */
export const setMidiOutputPorts = (list: OutPort[]): void => {
  ports = list;
  useMidiOutPorts.setState({ ports: midiOutDevices() });
  sync();
};

/** The chosen thru target. An empty ref means nothing is forwarded at all. */
export const setMidiThruTarget = (ref: DeviceRef): void => {
  wanted = { id: ref.id ?? '', label: ref.label ?? '' };
  sync();
};

/* ── track outputs ─────────────────────────────────────────────────────── */

/** A track's output, as EditorTrack `midiOut` holds it. */
export interface TrackMidiOut {
  id: string;
  label: string;
  /** The channel (1-16) the track's first live channel goes out on. */
  channel: number;
  clock?: boolean;
}

/** Where one of EDIT's live channels goes: a port and a channel 0-15 on it. */
export interface OutRoute {
  portId: string;
  channel: number;
}

/**
 * Each live EDIT channel's destination: for every track with an output its
 * channels in order (editChannels channelsOf), the first on the track's
 * channel and each next one on the channel after, wrapping past 16. A track
 * whose port is not open is left out and named in `missing`.
 */
export function planTrackRoutes(
  tracks: ReadonlyArray<{ id: string; name?: string; midiOut?: TrackMidiOut }>,
  channelsOf: ReadonlyMap<string, readonly number[]>,
  live: readonly LiveDevice[],
): { routes: Map<number, OutRoute>; clockPorts: string[]; missing: string[] } {
  const routes = new Map<number, OutRoute>();
  const clockPorts = new Set<string>();
  const missing: string[] = [];
  for (const t of tracks) {
    if (!t.midiOut) continue;
    const chans = channelsOf.get(t.id);
    const resolved = resolveRef({ id: t.midiOut.id, label: t.midiOut.label }, live, true);
    if (!resolved.deviceId || !live.some((d) => d.id === resolved.deviceId)) {
      missing.push(t.name ?? t.id);
      continue;
    }
    if (t.midiOut.clock) clockPorts.add(resolved.deviceId);
    if (!chans?.length) continue;
    const base = Math.max(1, Math.min(16, Math.round(t.midiOut.channel || 1))) - 1;
    chans.forEach((ch, i) => routes.set(ch, { portId: resolved.deviceId, channel: (base + i) % 16 }));
  }
  return { routes, clockPorts: [...clockPorts], missing };
}

/** Maps an audio-context time to performance.now() milliseconds (Web MIDI's clock). */
export type ContextToPerf = (ctxTime: number) => number;

/**
 * The sink that sends EDIT's live MIDI to the tracks' ports (the scheduler's
 * messages, lib/editMidiScheduler EditMidiSink). Every program change goes
 * out with CC 0 and CC 32 before it (lib/soundfontEngine programSwitch), and
 * a bend range as RPN 0/0 in the standard cents LSB.
 */
export class TrackOutSink implements EditMidiSink {
  private programs = new Map<string, number>();
  /** Notes sounding on each port channel, so a stop can end them. */
  private held = new Map<string, Set<number>>();

  constructor(
    private routes: ReadonlyMap<number, OutRoute>,
    private send: (portId: string, bytes: number[], timestamp: number) => void,
    private toPerf: ContextToPerf,
  ) {}

  private out(channel: number, time: number, build: (ch: number) => number[][]): void {
    const r = this.routes.get(channel);
    if (!r) return;
    const at = this.toPerf(time);
    for (const bytes of build(r.channel)) this.send(r.portId, bytes, at);
  }

  noteOn(channel: number, program: number, midi: number, velocity: number, time: number, bank: number, bankLsb?: number): void {
    const r = this.routes.get(channel);
    if (!r) return;
    const key = `${r.portId}:${r.channel}`;
    // An external-only track's notes carry no program (NO_PROGRAM): the host keeps its own patch.
    const change = program < 0 ? { controllers: [] as Array<[0 | 32, number]>, program: null, key: this.programs.get(key) } : programSwitch(this.programs.get(key), program, bank, bankLsb);
    if (change.key !== undefined) this.programs.set(key, change.key);
    this.out(channel, time, (ch) => [
      ...change.controllers.map(([cc, v]) => [0xb0 | ch, cc, v]),
      ...(change.program === null ? [] : [[0xc0 | ch, change.program]]),
      [0x90 | ch, midi & 0x7f, Math.max(1, Math.min(127, Math.round(velocity)))],
    ]);
    const set = this.held.get(key) ?? new Set<number>();
    set.add(midi & 0x7f);
    this.held.set(key, set);
  }

  noteOff(channel: number, midi: number, time: number): void {
    const r = this.routes.get(channel);
    if (r) this.held.get(`${r.portId}:${r.channel}`)?.delete(midi & 0x7f);
    this.out(channel, time, (ch) => [[0x80 | ch, midi & 0x7f, 0]]);
  }

  wheel(channel: number, raw: number, time: number): void {
    const v = Math.max(0, Math.min(16383, Math.round(raw)));
    this.out(channel, time, (ch) => [[0xe0 | ch, v & 0x7f, (v >> 7) & 0x7f]]);
  }

  wheelRange(channel: number, semitones: number, time: number): void {
    this.out(channel, time, (ch) => bendRangeMessages(ch, Math.max(0, semitones)));
  }

  control(channel: number, controller: number, value: number, time: number): void {
    this.out(channel, time, (ch) => [[0xb0 | ch, controller & 0x7f, Math.max(0, Math.min(127, Math.round(value)))]]);
  }

  pressure(channel: number, value: number, time: number): void {
    this.out(channel, time, (ch) => [[0xd0 | ch, Math.max(0, Math.min(127, Math.round(value)))]]);
  }

  /** End every note this sink started, at `timestamp` (a stop, a seek). */
  allNotesOff(timestamp: number): void {
    for (const [key, notes] of this.held) {
      const [portId, chText] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
      const ch = Number(chText);
      for (const n of notes) this.send(portId, [0x80 | ch, n, 0], timestamp);
    }
    this.held.clear();
  }
}

/**
 * MIDI clock for a pass: 24 clocks to the quarter note on EDIT's tempo map,
 * scheduled ahead on the same anchor as the pass's audio, with a Song
 * Position Pointer (sixteenths from the start) and Start (from the top) or
 * Continue (from anywhere else) where the pass starts, and Stop at its end.
 */
export class MidiClockScheduler {
  private anchorCtx = 0;
  private anchorT = 0;
  /** The next clock, in 24ths of a quarter note from the timeline's start. */
  private next = 0;
  private running = false;

  constructor(
    private deps: {
      send: (bytes: number[], timestamp: number) => void;
      toPerf: ContextToPerf;
      now: () => number;
      /** Quarter notes at a timeline second, and back (lib/tempoMap). */
      beatAt: (sec: number) => number;
      secAt: (beat: number) => number;
    },
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Start at transport second `fromSec`, heard at context time `anchorCtx`, with the first `lookaheadSec` of clocks sent now. */
  start(fromSec: number, anchorCtx: number, lookaheadSec = 0): void {
    this.anchorCtx = anchorCtx;
    this.anchorT = fromSec;
    this.running = true;
    const beat = Math.max(0, this.deps.beatAt(fromSec));
    // Song position is in sixteenths; the clock resumes at the next one so the host lands on the grid.
    const sixteenth = Math.ceil(beat * 4 - 1e-9);
    this.next = sixteenth * 6;
    const at = this.deps.toPerf(Math.max(this.deps.now(), anchorCtx));
    const spp = Math.min(16383, sixteenth);
    this.deps.send([0xf2, spp & 0x7f, (spp >> 7) & 0x7f], at);
    this.deps.send([sixteenth === 0 ? 0xfa : 0xfb], at);
    this.tick(lookaheadSec);
  }

  /** Send every clock that falls before `lookaheadSec` past now. */
  tick(lookaheadSec: number): void {
    if (!this.running) return;
    const until = this.anchorT + (this.deps.now() + lookaheadSec - this.anchorCtx);
    for (let guard = 0; guard < 4096; guard += 1) {
      const sec = this.deps.secAt(this.next / 24);
      if (sec > until) break;
      const ctx = this.anchorCtx + (sec - this.anchorT);
      this.deps.send([0xf8], this.deps.toPerf(Math.max(ctx, this.deps.now())));
      this.next += 1;
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.deps.send([0xfc], this.deps.toPerf(this.deps.now()));
  }
}

/* ── the pass: what liveMixer starts, ticks and stops ──────────────────── */

let passSink: TrackOutSink | null = null;
let passClock: MidiClockScheduler | null = null;

const sendTo = (portId: string, bytes: number[], timestamp: number): void => {
  const port = ports.find((p) => p.id === portId);
  if (!port) return;
  try {
    port.send(bytes, timestamp);
  } catch (e) {
    logError('midi', `MIDI out to ${port.name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** What a pass's track outputs read: the tracks, the audio clock, and the tempo map for the clock. */
export interface TrackOutputOptions {
  tracks: ReadonlyArray<{ id: string; name?: string; midiOut?: TrackMidiOut; externalOnly?: boolean }>;
  now: () => number;
  toPerf: ContextToPerf;
}

/**
 * Start the tracks' routes for a pass of live MIDI: each live track with an
 * output port sends what the scheduler plays on its channels to that port.
 * Returns the sink the scheduler's messages go to as well, or null when no
 * live track has an open port.
 */
export function startTrackRoutes(opts: TrackOutputOptions & { channelsOf: ReadonlyMap<string, readonly number[]> }): TrackOutSink | null {
  passSink?.allNotesOff(opts.toPerf(opts.now()));
  passSink = null;
  if (!opts.tracks.some((t) => t.midiOut)) return null;
  const plan = planTrackRoutes(opts.tracks, opts.channelsOf, midiOutDevices());
  if (plan.missing.length) logWarn('midi', `MIDI out port not open for ${plan.missing.join(', ')}: those tracks send nothing to it`);
  passSink = plan.routes.size ? new TrackOutSink(plan.routes, sendTo, opts.toPerf) : null;
  return passSink;
}

/**
 * Start MIDI clock for a transport pass that plays `fromSec` at context time
 * `anchorCtx`, to every open port a track sends clock to, whether or not the
 * pass plays any MIDI (an arrangement of audio alone drives the host too).
 * Returns true when a clock started.
 */
export function startTransportClock(
  opts: TrackOutputOptions & {
    fromSec: number;
    anchorCtx: number;
    beatAt: (sec: number) => number;
    secAt: (beat: number) => number;
    /** How far ahead the first clocks are sent (the scheduler's lookahead). */
    lookaheadSec?: number;
  },
): boolean {
  passClock?.stop();
  passClock = null;
  if (!opts.tracks.some((t) => t.midiOut?.clock)) return false;
  const clockPorts = planTrackRoutes(opts.tracks, new Map(), midiOutDevices()).clockPorts;
  if (!clockPorts.length) return false;
  passClock = new MidiClockScheduler({
    send: (bytes, ts) => {
      for (const id of clockPorts) sendTo(id, bytes, ts);
    },
    toPerf: opts.toPerf,
    now: opts.now,
    beatAt: opts.beatAt,
    secAt: opts.secAt,
  });
  passClock.start(opts.fromSec, opts.anchorCtx, opts.lookaheadSec ?? 0);
  return true;
}

/** The routes and the clock together (startTrackRoutes, startTransportClock). */
export function startTrackOutputs(
  opts: TrackOutputOptions & {
    channelsOf: ReadonlyMap<string, readonly number[]>;
    fromSec: number;
    anchorCtx: number;
    beatAt: (sec: number) => number;
    secAt: (beat: number) => number;
    lookaheadSec?: number;
  },
): TrackOutSink | null {
  stopTrackOutputs(opts.toPerf(opts.now()));
  const sink = startTrackRoutes(opts);
  startTransportClock(opts);
  return sink;
}

/**
 * The sink EDIT's live scheduler plays into: theDAW's synths (`internal`) for
 * every channel but an external-only track's (`externalChannels`, which no
 * synth of theDAW's sounds), and the tracks' ports (`external`) for all of
 * them.
 */
export function passMidiSink(
  internal: EditMidiSink,
  external: () => EditMidiSink | null,
  externalChannels: () => ReadonlySet<number>,
): EditMidiSink {
  const inside = (ch: number) => !externalChannels().has(ch);
  return {
    noteOn: (...a) => {
      if (inside(a[0])) internal.noteOn(...a);
      external()?.noteOn(...a);
    },
    noteOff: (...a) => {
      if (inside(a[0])) internal.noteOff(...a);
      external()?.noteOff(...a);
    },
    wheel: (...a) => {
      if (inside(a[0])) internal.wheel(...a);
      external()?.wheel(...a);
    },
    wheelRange: (...a) => {
      if (inside(a[0])) internal.wheelRange(...a);
      external()?.wheelRange(...a);
    },
    control: (...a) => {
      if (inside(a[0])) internal.control(...a);
      external()?.control(...a);
    },
    pressure: (...a) => {
      if (inside(a[0])) internal.pressure?.(...a);
      external()?.pressure?.(...a);
    },
  };
}

/** The live channels of the external-only tracks in a plan. */
export function externalOnlyChannels(
  tracks: ReadonlyArray<{ id: string; externalOnly?: boolean }>,
  channelsOf: ReadonlyMap<string, readonly number[]>,
): Set<number> {
  const out = new Set<number>();
  for (const t of tracks) if (t.externalOnly) for (const ch of channelsOf.get(t.id) ?? []) out.add(ch);
  return out;
}

/** True while a pass has a track output or a clock running. */
export const trackOutputsActive = (): boolean => passSink !== null || passClock !== null;

/** Send the clock ahead by `lookaheadSec` (the scheduler's tick). */
export function tickTrackOutputs(lookaheadSec: number): void {
  passClock?.tick(lookaheadSec);
}

/** End the pass on every port: its notes off, and Stop to the clocked ones. */
export function stopTrackOutputs(timestamp: number): void {
  passSink?.allNotesOff(timestamp);
  passSink = null;
  passClock?.stop();
  passClock = null;
}
