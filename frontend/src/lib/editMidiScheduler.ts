/**
 * editMidiScheduler — EDIT's live MIDI on the audio clock.
 *
 * EDIT plays a MIDI clip live through its own synths (soundfontEngine's EDIT
 * banks) when the clip has a program. This module decides what those synths
 * hear and WHEN, in audio-context seconds, so every note-on, note-off, program
 * change and pitch-wheel message is queued on the synth for the moment it
 * belongs to and lands on the render quantum the clips' audio plays in.
 *
 * The scheduler
 * -------------
 * A rolling lookahead: every EDIT_MIDI_TICK_MS a tick hands the synth what
 * falls in the next `lookaheadSec` of the transport. This is the standard Web
 * Audio two-clock pattern (a coarse JS timer deciding what a sample-accurate,
 * time-stamped schedule should contain), as described in Chris Wilson's "A
 * Tale of Two Clocks"; the implementation is written from that description.
 * The transport maps onto the context clock through ONE anchor (the context
 * time a pass started and the transport second it started from), the same
 * anchor liveMixer's playhead and the clips' audio sources use, so a note
 * cannot drift from the audio beside it however long the song runs.
 *
 * Each tick re-reads the clips, the tracks and the global picker. A note, a
 * clip, a program, a mute or a clip gain changed while playing changes what
 * plays next without a restart; a note is handed over at most once, because
 * the window's cursor only moves forward. Each clip's notes are timed once per
 * edit of that clip (the clip object is the cache key; editorStore replaces it
 * on every edit), so a tick costs a binary search per clip.
 *
 * What a clip plays
 * -----------------
 *   - The notes its bounce renders from (lib/rollClip clipRenderInput), each at
 *     its own length (clipNoteSpan: no 16th floor, a triplet 32nd stays a
 *     triplet 32nd), timed through the clip's tempo map (`sourceTempoMap`,
 *     lib/rollTempo stepClock) and cut at the clip's edges.
 *   - Its lanes' pitch bends: a wheel bends a whole channel, so each bent lane
 *     plays on a channel of its own (lib/pitchBend laneChannels; the track is
 *     given that many channels, lib/editChannels), with the lane's bend range
 *     and the wheel messages the bounce writes (bendWheelEvents), each at its
 *     own time. Every clip, bent or not, opens by setting the range and wheel
 *     of the channels it uses, so a clip after a bent one never inherits a bend.
 *   - Its gain and fades: the track's MIDI goes through one envelope gain per
 *     track, which follows the clip that is playing (lib/clipFade
 *     applyFadeAutomation with the clip's gain as the peak), the curve the
 *     clip's audio takes on export.
 *   - Notes already sounding where playback starts are started there (a
 *     "chase", as a DAW chases held notes), so pressing play in the middle of
 *     a held chord plays the chord. A percussion track does not chase: a drum
 *     hit is its onset, and striking it again mid-ring is louder than the take.
 *
 * Late ticks
 * ----------
 * A tick that runs late (a busy main thread, a hidden tab) does not fire a
 * burst of stale onsets: an onset further than `lateSec` behind the clock is
 * chased when its note is still sounding and skipped when it is over, and the
 * pass counts both (`stats`) so liveMixer can say so in the LOG.
 *
 * Stop and seek
 * -------------
 * SpessaSynth has no way to take back a queued event, and its stopAll does not
 * clear the queue. So `stop()` answers every note-on still waiting in the
 * queue with a note-off at the same time (the queue is stable, so the off runs
 * after the on), which ends that voice at the synth's shortest note. A pass
 * that starts while those cancels are still queued (a seek) strikes a note of
 * its own again right after a cancel that would cut it, and holds its wheel
 * messages on a channel until the last stale one has passed. The lookahead is
 * short while the page is visible so that window stays small (liveMixer).
 *
 * No Vite-only imports, so node tests load it.
 */
import type { AudioClip, EditorTrack } from '../state/editorStore';
import { clipPeakGain } from '../state/editorStore';
import { DEFAULT_LANES, sanitizeLanes } from '../state/pianoRollStore';
import { clipBank, effectiveProgramFor, isPercussionTrack, type GlobalVoice } from './clipProgram';
import { applyFadeAutomation, type AudioParamLike } from './clipFade';
import {
  BEND_CENTER,
  BEND_CHANNELS,
  DEFAULT_BEND_RANGE,
  bendValueAt,
  bendValueToRaw,
  bendWheelEvents,
  laneChannels,
  playingLane,
  sanitizeBends,
} from './pitchBend';
import { roundUpToBar } from './meterMap';
import { noteEndStep } from './clipNotes/units';
import { clipNoteSpan, clipRenderInput } from './rollClip';
import { stepClock } from './rollTempo';

/** How far ahead of the clock a tick schedules while the page is visible. */
export const EDIT_MIDI_LOOKAHEAD_SEC = 0.1;
/** The lookahead while the page is hidden, where timers fire about once a second. */
export const EDIT_MIDI_HIDDEN_LOOKAHEAD_SEC = 1.5;
/** How often the driving timer fires. Comfortably inside the lookahead. */
export const EDIT_MIDI_TICK_MS = 25;
/** An onset further than this behind the clock is late: chased or skipped, never fired as a burst. */
export const EDIT_MIDI_LATE_SEC = 0.03;
/** Where a held-back wheel message lands after the last stale one on its channel. */
const AFTER_STALE_SEC = 1e-6;
const EPS = 1e-9;

/**
 * What EDIT's synths are told. Every time is audio-context seconds. `bank` is
 * the bank select sent before `program` (lib/clipProgram clipBank: a clip's
 * own program in a roll part's Bank); 0 is the General MIDI set.
 */
export interface EditMidiSink {
  noteOn(channel: number, program: number, midi: number, velocity: number, time: number, bank: number): void;
  noteOff(channel: number, midi: number, time: number): void;
  wheel(channel: number, raw: number, time: number): void;
  wheelRange(channel: number, semitones: number, time: number): void;
}

/** A track's MIDI envelope gain: an AudioParam, or a recorder in tests. */
export interface EnvelopeParam extends AudioParamLike {
  cancelScheduledValues(time: number): unknown;
}

/** The clips a pass plays live and each track's channels (liveMixer planLiveMidi). */
export interface EditMidiPass {
  liveClipIds: ReadonlySet<string>;
  channelsOf: ReadonlyMap<string, readonly number[]>;
}

export interface EditMidiSchedulerDeps {
  /** The audio context's clock. */
  now: () => number;
  sink: EditMidiSink;
  /** Read on every tick. */
  clips: () => readonly AudioClip[];
  tracks: () => readonly EditorTrack[];
  global: () => GlobalVoice;
  /** The project tempo, which times a clip with no `sourceBpm`. */
  projectBpm: () => number | undefined;
  /** The track's envelope gain; absent or null and clip gain and fades are left alone. */
  envelope?: (trackId: string) => EnvelopeParam | null;
  /** Seconds ahead each tick schedules. Absent: EDIT_MIDI_LOOKAHEAD_SEC. */
  lookaheadSec?: () => number;
  /** Absent: EDIT_MIDI_LATE_SEC. */
  lateSec?: number;
}

/** One note of a clip on the transport, in seconds, on the clip's `slot`-th channel. */
export interface TimedNote {
  on: number;
  off: number;
  midi: number;
  velocity: number;
  slot: number;
}

/** One channel message of a clip on the transport: a bend range or a wheel position. */
export interface TimedCtl {
  t: number;
  slot: number;
  kind: 'range' | 'wheel';
  value: number;
}

/** A clip as the scheduler plays it: notes sorted by onset, channel messages sorted by time, and how many channels it uses. */
export interface ClipTiming {
  notes: TimedNote[];
  ctl: TimedCtl[];
  slots: number;
}

/** What a pass did, for the LOG. */
export interface EditMidiStats {
  notes: number;
  chased: number;
  late: number;
  skipped: number;
}

/** The fields clipLiveTiming reads. */
export type TimedClip = Pick<
  AudioClip,
  | 'startSec'
  | 'durationSec'
  | 'offsetIntoSource'
  | 'sourcePianoRoll'
  | 'sourceRollNotes'
  | 'sourceLanes'
  | 'sourceBends'
  | 'sourceBpm'
  | 'sourceTempoMap'
  | 'sourceTotalSteps'
  | 'sourceMeterMap'
  | 'sourcePickupSteps'
>;

/** A clip's grid length, as its re-render reads it (lib/clipRerender). */
const clipTotalSteps = (clip: TimedClip): number =>
  clip.sourceTotalSteps ?? roundUpToBar(clip.sourceMeterMap ?? [], noteEndStep(clip.sourcePianoRoll ?? [], 1), clip.sourcePickupSteps ?? 0);

/**
 * How many channels a clip plays on: one, or one per lane of its that bends
 * plus one its other lanes share (lib/pitchBend laneChannels), exactly the
 * channels its bounce renders on. A percussion clip plays on its one drum channel.
 */
export function clipLiveSlots(clip: Pick<AudioClip, 'sourceRollNotes' | 'sourceLanes' | 'sourceBends'>, percussion = false): number {
  if (percussion || !clip.sourceBends?.length || !clip.sourceRollNotes?.length) return 1;
  const lanes = sanitizeLanes(clip.sourceLanes?.length ? clip.sourceLanes : DEFAULT_LANES);
  return Math.max(1, new Set(laneChannels(lanes, sanitizeBends(clip.sourceBends)).values()).size);
}

const byOn = (a: TimedNote, b: TimedNote) => a.on - b.on;

/**
 * Every note and channel message of `clip` on the transport, in seconds. The
 * notes are the ones its bounce renders from (clipRenderInput), at their own
 * lengths through the clip's clock, inside the clip's window: the trim offset
 * is taken off and a note running past an edge is cut at it. A percussion clip
 * ignores bends and plays on one channel.
 */
export function clipLiveTiming(clip: TimedClip, fallbackBpm: number | undefined, percussion = false): ClipTiming {
  const clock = stepClock(clip.sourceBpm ?? fallbackBpm ?? 120, clip.sourceTempoMap);
  const offset = clip.offsetIntoSource ?? 0;
  const dur = clip.durationSec;
  const start = clip.startSec;
  const input = clipRenderInput(clip, clipTotalSteps(clip));
  const bends = percussion ? undefined : input.bends;
  const slotOf = new Map<number, number>();
  if (bends) for (const [lane, ch] of bends.channels) slotOf.set(lane, Math.max(0, BEND_CHANNELS.indexOf(ch)));
  const laneSlot = (lane: number | undefined): number => (bends ? slotOf.get(playingLane(lane, bends.lanes)) ?? 0 : 0);

  const notes: TimedNote[] = [];
  for (const n of input.notes) {
    const { relStart, relEnd } = clipNoteSpan(n, clock, offset);
    if (relEnd <= 0 || relStart >= dur) continue; // outside this clip's window
    notes.push({
      on: start + Math.max(0, relStart),
      off: start + Math.min(dur, relEnd),
      midi: n.note,
      velocity: n.velocity,
      slot: laneSlot(n.lane),
    });
  }
  notes.sort(byOn);

  const used = bends && slotOf.size ? Math.max(...slotOf.values()) + 1 : 1;
  const ctl: TimedCtl[] = [];
  // Every channel the clip uses opens at the clip's start: its range and its
  // wheel where the clip's source begins. A channel no lane bends goes back to
  // the default range at the centre.
  const bentSlots = new Set<number>();
  if (bends) {
    const fromStep = clock.stepAt(offset);
    const toStep = clock.stepAt(offset + dur);
    for (const [lane, played] of bends.played) {
      const slot = slotOf.get(lane) ?? 0;
      bentSlots.add(slot);
      ctl.push({ t: start, slot, kind: 'range', value: played.range });
      ctl.push({ t: start, slot, kind: 'wheel', value: bendValueToRaw(bendValueAt(played.points, fromStep)) });
      const last = played.points.length ? played.points[played.points.length - 1].step : fromStep;
      for (const e of bendWheelEvents(played.points, fromStep, Math.min(toStep, last), false, played.range)) {
        const t = start + clock.at(e.step) - offset;
        if (t > start + EPS && t < start + dur) ctl.push({ t, slot, kind: 'wheel', value: e.raw });
      }
    }
  }
  for (let slot = 0; slot < used; slot += 1) {
    if (bentSlots.has(slot)) continue;
    ctl.push({ t: start, slot, kind: 'range', value: DEFAULT_BEND_RANGE });
    ctl.push({ t: start, slot, kind: 'wheel', value: BEND_CENTER });
  }
  // Stable: at one time a channel's range stays ahead of its wheel.
  ctl.sort((a, b) => a.t - b.t);
  return { notes, ctl, slots: used };
}

/** The first index in `xs` whose key is at or past `t`. */
function lowerBound<T>(xs: readonly T[], t: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(xs[mid]) < t - EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A message the tick hands over, ordered at one time as a MIDI file orders them: off, range, wheel, on. */
interface Out {
  time: number;
  order: number;
  send: () => void;
}

/** A note-on handed to the synth, until its note-off is. */
interface Sounding {
  clipId: string;
  channel: number;
  midi: number;
  off: number; // transport seconds
}

/** A note-on waiting in the synth's queue (its time still ahead of the clock). */
interface Queued {
  channel: number;
  midi: number;
  time: number;
}

/** What a track's envelope follows, and the clip fields it was scheduled from. */
interface EnvelopeOwner {
  clipId: string;
  sig: string;
}

const envelopeSig = (c: AudioClip): string =>
  `${c.startSec}|${c.durationSec}|${c.gain ?? ''}|${c.fadeInSec ?? ''}|${c.fadeOutSec ?? ''}|${c.fadeInCurve ?? ''}|${c.fadeOutCurve ?? ''}`;

const muteSoloOpen = (t: EditorTrack, anySolo: boolean): boolean => !t.mute && !(anySolo && !t.solo);

/**
 * The rolling-lookahead scheduler. It owns no timer: `tick()` is public, and
 * liveMixer (or a test) decides when it runs. One instance lives across passes,
 * so a pass can see what the one before it left in the synth's queue.
 */
export class EditMidiScheduler {
  private readonly deps: EditMidiSchedulerDeps;
  private running = false;
  private first = false;
  private pass: EditMidiPass = { liveClipIds: new Set(), channelsOf: new Map() };
  private anchorCtx = 0;
  private anchorT = 0;
  private fromT = 0;
  private cursor = 0;
  private endAt: () => number = () => Infinity;
  private sounding: Sounding[] = [];
  private queued: Queued[] = [];
  /** Note-offs `stop()` queued to cancel a note-on, still ahead of the clock. */
  private cancels: Queued[] = [];
  /** Per channel: the latest wheel or range message queued, so a new pass's wheel waits for it. */
  private ctlQueued = new Map<number, number>();
  private ctlFloor = new Map<number, number>();
  private envelopes = new Map<string, EnvelopeOwner>();
  private timing = new WeakMap<object, { bpm: number | undefined; percussion: boolean; timing: ClipTiming }>();
  private counts: EditMidiStats = { notes: 0, chased: 0, late: 0, skipped: 0 };

  constructor(deps: EditMidiSchedulerDeps) {
    this.deps = deps;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** What the current (or last) pass did. */
  get stats(): EditMidiStats {
    return { ...this.counts };
  }

  /**
   * Time every clip `pass` plays live, ahead of `start`. Timing a clip walks
   * all its notes (about 2 ms for 4000), so a caller that takes its anchor
   * after this keeps that work out of the first window.
   */
  prepare(pass: EditMidiPass): void {
    const trackById = new Map<string, EditorTrack>(this.deps.tracks().map((t): [string, EditorTrack] => [t.id, t]));
    const bpm = this.deps.projectBpm();
    for (const clip of this.deps.clips()) {
      if (!pass.liveClipIds.has(clip.id)) continue;
      this.timingOf(clip, bpm, isPercussionTrack(trackById.get(clip.trackId)));
    }
  }

  /**
   * Start a pass: transport second `fromSec` sounds at context time
   * `anchorCtx`, and nothing is scheduled at or past `endSec()` (read every
   * tick: the loop's end, or the song's). The first window is scheduled now.
   */
  start(pass: EditMidiPass, fromSec: number, anchorCtx: number, endSec: () => number = () => Infinity): void {
    const now = this.deps.now();
    this.pass = pass;
    this.anchorCtx = anchorCtx;
    this.anchorT = fromSec;
    this.fromT = fromSec;
    this.cursor = fromSec;
    this.endAt = endSec;
    this.sounding = [];
    this.envelopes = new Map();
    this.counts = { notes: 0, chased: 0, late: 0, skipped: 0 };
    // A wheel message of this pass on a channel waits until the last stale one
    // queued there has passed; a cancel only matters while it is still queued.
    this.ctlFloor = new Map([...this.ctlQueued].filter(([, t]) => t > now));
    this.cancels = this.cancels.filter((c) => c.time > now);
    this.queued = [];
    this.running = true;
    this.first = true;
    this.tick();
  }

  /**
   * End the pass: every note-on still waiting in the synth's queue gets a
   * note-off at its own time, and nothing more is handed over. Notes already
   * sounding are the caller's to silence (soundfontEngine editAllNotesOff).
   */
  stop(): void {
    if (!this.running) return;
    const now = this.deps.now();
    for (const q of this.queued) {
      if (q.time <= now) continue;
      this.deps.sink.noteOff(q.channel, q.midi, q.time);
      this.cancels.push(q);
    }
    this.queued = [];
    this.sounding = [];
    this.running = false;
  }

  private ctxOf(t: number): number {
    return this.anchorCtx + (t - this.anchorT);
  }

  private timingOf(clip: AudioClip, bpm: number | undefined, percussion: boolean): ClipTiming {
    const hit = this.timing.get(clip);
    if (hit && hit.bpm === bpm && hit.percussion === percussion) return hit.timing;
    const timing = clipLiveTiming(clip, bpm, percussion);
    this.timing.set(clip, { bpm, percussion, timing });
    return timing;
  }

  /** Schedule the track's envelope for `clip` from transport second `fromT` on. */
  private scheduleEnvelope(trackId: string, clip: AudioClip, fromT: number, now: number): void {
    this.envelopes.set(trackId, { clipId: clip.id, sig: envelopeSig(clip) });
    const param = this.deps.envelope?.(trackId);
    if (!param) return;
    const at = Math.max(now, this.ctxOf(fromT));
    param.cancelScheduledValues(at);
    applyFadeAutomation(param, clip, this.ctxOf(clip.startSec), Math.max(0, fromT - clip.startSec), { peak: clipPeakGain(clip) });
  }

  /** One pass of the lookahead. Safe to call at any rate, including too often. */
  tick(): void {
    if (!this.running) return;
    const { sink } = this.deps;
    const now = this.deps.now();
    const nowT = this.anchorT + (now - this.anchorCtx);
    const lookahead = Math.max(0, this.deps.lookaheadSec?.() ?? EDIT_MIDI_LOOKAHEAD_SEC);
    const lateSec = this.deps.lateSec ?? EDIT_MIDI_LATE_SEC;
    // The window is [cursor, until); a tick that comes early finds it empty.
    const until = Math.max(this.cursor, Math.min(nowT + lookahead, this.endAt()));
    const from = this.cursor;
    const first = this.first;
    this.first = false;
    this.queued = this.queued.filter((q) => q.time > now);
    this.cancels = this.cancels.filter((c) => c.time > now);

    const clips = this.deps.clips();
    const tracks = this.deps.tracks();
    const trackById = new Map<string, EditorTrack>(tracks.map((t): [string, EditorTrack] => [t.id, t]));
    const anySolo = tracks.some((t) => t.solo);
    const global = this.deps.global();
    const bpm = this.deps.projectBpm();
    const out: Out[] = [];
    const live = new Set<string>();

    const pushCtl = (channel: number, c: TimedCtl, time: number) => {
      const floor = this.ctlFloor.get(channel);
      const at = floor !== undefined && time <= floor ? floor + AFTER_STALE_SEC : time;
      out.push(
        c.kind === 'range'
          ? { time: at, order: 0.25, send: () => sink.wheelRange(channel, c.value, at) }
          : { time: at, order: 0.5, send: () => sink.wheel(channel, c.value, at) },
      );
      this.ctlQueued.set(channel, Math.max(this.ctlQueued.get(channel) ?? 0, at));
    };

    const pushOn = (clipId: string, channel: number, program: number, bank: number, n: TimedNote, time: number) => {
      // A note of this key still held on the channel ends where this one starts,
      // or its later note-off would cut this one.
      for (let i = this.sounding.length - 1; i >= 0; i -= 1) {
        const s = this.sounding[i];
        if (s.channel !== channel || s.midi !== n.midi || s.off <= n.on + EPS) continue;
        out.push({ time, order: 0, send: () => sink.noteOff(channel, n.midi, time) });
        this.sounding.splice(i, 1);
      }
      out.push({ time, order: 1, send: () => sink.noteOn(channel, program, n.midi, n.velocity, time, bank) });
      // A cancel `stop()` left for this key, still ahead: strike this note again right after it.
      for (const c of this.cancels) {
        if (c.channel !== channel || c.midi !== n.midi || c.time < time - EPS) continue;
        const again = c.time;
        out.push({ time: again, order: 1, send: () => sink.noteOn(channel, program, n.midi, n.velocity, again, bank) });
      }
      if (time > now) this.queued.push({ channel, midi: n.midi, time });
      this.sounding.push({ clipId, channel, midi: n.midi, off: n.off });
      this.counts.notes += 1;
    };

    for (const clip of clips) {
      if (!this.pass.liveClipIds.has(clip.id) || clip.muted) continue;
      const track = trackById.get(clip.trackId);
      const chans = track ? this.pass.channelsOf.get(track.id) : undefined;
      if (!track || !chans?.length) continue;
      const program = effectiveProgramFor(clip, track, global);
      if (program === undefined) continue;
      const bank = clipBank(clip, track);
      live.add(clip.id);
      const percussion = isPercussionTrack(track);
      const timing = this.timingOf(clip, bpm, percussion);
      const chOf = (slot: number) => chans[Math.min(slot, chans.length - 1)];
      const clipEnd = clip.startSec + clip.durationSec;
      const open = muteSoloOpen(track, anySolo);

      // Envelope: a clip entering the window takes the track's envelope at its
      // start; playback starting inside a clip takes it from there; an edit to
      // the gain or fades of the clip that holds it reschedules it from now.
      const owner = this.envelopes.get(track.id);
      if (first && clip.startSec < this.fromT - EPS && clipEnd > this.fromT + EPS) {
        this.scheduleEnvelope(track.id, clip, this.fromT, now);
      } else if (clip.startSec >= from - EPS && clip.startSec < until - EPS) {
        this.scheduleEnvelope(track.id, clip, clip.startSec, now);
      } else if (owner?.clipId === clip.id && owner.sig !== envelopeSig(clip) && clipEnd > nowT) {
        this.scheduleEnvelope(track.id, clip, Math.max(nowT, clip.startSec), now);
      } else if (!owner && clip.startSec < nowT && clipEnd > nowT) {
        // A clip unmuted (or given a program) mid-way takes the envelope from now.
        this.scheduleEnvelope(track.id, clip, nowT, now);
      }

      // Channel messages: where each channel is at the start point, then the window's.
      if (first && clip.startSec < this.fromT - EPS && clipEnd > this.fromT + EPS) {
        const lastOf = new Map<string, TimedCtl>();
        for (const c of timing.ctl) {
          if (c.t > this.fromT + EPS) break;
          lastOf.set(`${c.slot}:${c.kind}`, c);
        }
        const at = this.ctxOf(this.fromT);
        for (const c of [...lastOf.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'range' ? -1 : 1))) pushCtl(chOf(c.slot), c, at);
      }
      for (let i = lowerBound(timing.ctl, from, (c) => c.t); i < timing.ctl.length; i += 1) {
        const c = timing.ctl[i];
        if (c.t >= until - EPS) break;
        pushCtl(chOf(c.slot), c, Math.max(now, this.ctxOf(c.t)));
      }

      if (!open) continue;
      // Chase: notes sounding where playback starts start there.
      if (first && !percussion) {
        for (const n of timing.notes) {
          if (n.on >= this.fromT - EPS) break;
          if (n.off <= this.fromT + EPS) continue;
          pushOn(clip.id, chOf(n.slot), program, bank, n, Math.max(now, this.ctxOf(this.fromT)));
          this.counts.chased += 1;
        }
      }
      for (let i = lowerBound(timing.notes, from, (n) => n.on); i < timing.notes.length; i += 1) {
        const n = timing.notes[i];
        if (n.on >= until - EPS) break;
        const at = this.ctxOf(n.on);
        if (at < now - lateSec) {
          // Late: chase a note still sounding, skip one that is over.
          if (!percussion && n.off > nowT + EPS) {
            pushOn(clip.id, chOf(n.slot), program, bank, n, now);
            this.counts.late += 1;
          } else {
            this.counts.skipped += 1;
          }
          continue;
        }
        pushOn(clip.id, chOf(n.slot), program, bank, n, Math.max(now, at));
      }
    }

    // Note-offs: a note whose clip went away, was muted or stopped playing live
    // ends now; every other ends at its time once that falls in the window.
    const keep: Sounding[] = [];
    for (const s of this.sounding) {
      if (!live.has(s.clipId)) {
        out.push({ time: now, order: 0, send: () => sink.noteOff(s.channel, s.midi, now) });
      } else if (s.off < until - EPS) {
        const at = Math.max(now, this.ctxOf(s.off));
        out.push({ time: at, order: 0, send: () => sink.noteOff(s.channel, s.midi, at) });
      } else {
        keep.push(s);
      }
    }
    this.sounding = keep;

    out.sort((a, b) => a.time - b.time || a.order - b.order);
    for (const o of out) o.send();
    if (until > this.cursor) this.cursor = until;
  }
}
