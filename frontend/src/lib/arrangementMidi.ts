/**
 * arrangementMidi — the whole EDIT arrangement as one type-1 Standard MIDI
 * File: the export dialog's MIDI format and the assistant's editor_export_midi.
 *
 * TRACKS: every EDIT track that holds piano-roll clips becomes one MIDI track,
 * named after it, in timeline order. Each clip's notes (`sourcePianoRoll`, the
 * notes as they sound) land where EDIT plays them: at the clip's offset on the
 * timeline, through the clip's own tempo map (lib/rollTempo stepClock), inside
 * its trim window, a note running past the clip's end cut there, exactly as
 * liveMixer's midiClipNoteTimes plays them. Seconds become ticks through the
 * ARRANGEMENT's tempo map, which the file carries, so any player puts every
 * note at the second EDIT plays it.
 *
 * CHANNELS AND PROGRAMS: a drum track plays on channel 10 with its kit as the
 * program; every other track takes a channel of its own that is not 10
 * (lib/rollTracks partFileChannels): the one its clips' roll parts name when
 * they agree and no earlier track took it, else the next free one. Past
 * fifteen melodic channels they are shared, and `sharedTracks` names the
 * tracks that share. Each clip's voice
 * (lib/clipProgram clipVoice: its program, else its track's, else the
 * picker's) is written as a program change at tick 0, and again at the start
 * of any later clip on the track that sounds another program; the bank select
 * is the clip's roll part's.
 *
 * CONTROLLERS: each clip's roll part carries its controller changes
 * (RollPartRef `controls`: modulation, volume, pan, expression, the sustain
 * pedal). They are written at their seconds, and where a clip's window starts
 * past some of them, the value each held there is written at the clip's start,
 * so a trimmed clip starts with its pedal and volume. The track's fader and pan
 * ride in the same controllers: a fader off EDIT's default (0.8) scales every
 * volume change on the General MIDI volume curve (gain = (CC7/127)^2), or
 * writes one volume change at tick 0 when the parts carry none; a pan off
 * centre moves every pan change, or writes one. A controller acts on a
 * channel, so every change, program change included, goes to each channel
 * the track's notes play on.
 *
 * PITCH BEND: a clip whose roll lanes bend (`sourceBends`) is written as its
 * render plays it (lib/rollClip clipRenderInput, lib/pitchBendVoice): the
 * roll's own notes unrolled across their lanes, each bent lane's notes on a
 * channel of that lane's own with its wheel messages and its range (RPN 0/0),
 * because a wheel bends every note on its channel. The lanes that do not bend
 * stay on the track's channel. Each bent lane's wheel starts at the value its
 * curve has where the clip's window starts, and its messages stop at the
 * window's end. The extra channels come from the same sixteen as the tracks'
 * (a track's lane B keeps one channel across the track's clips), so they count
 * toward `sharedTracks`. A drum track has one wheel for every drum, so it
 * carries no lane bends, as its render carries none.
 *
 * TEMPO AND METER: the file's tempo map is the arrangement's (`tempoMap` when
 * EDIT holds one, else one tempo at `bpm`), written as lib/rollMidi writes a
 * roll's (a ramp as a tempo every 32nd, a fermata as its slowed tempo, the map
 * itself in a `theDAW:tempomap=` text), and its time signatures are the
 * arrangement's meter map (`meterMap`, else its one time signature).
 *
 * RANGE: an export of a span of the timeline starts on the bar line at or
 * before the span's start, so the file's bars are the arrangement's bars, and
 * keeps the notes that start inside the span, each cut at its end.
 *
 * The resolution is the roll's own 960 PPQ. Pure (no stores), so node tests
 * run it; exportArrangementMidi (lib/arrangementMidiApp) reads the stores and
 * saves the file.
 */
import type { AudioClip, EditorTrack } from '../state/editorStore';
import { noteEndStep } from './clipNotes/units';
import { GM_STANDARD_KIT, clipVoice, isPercussionTrack, type GlobalVoice } from './clipProgram';
import { barAt, barStartStep, meterAtBar, meterMapToMidiEvents, normalizeMeterMap, roundUpToBar, type MeterSegment } from './meterMap';
import type { MidiBend, MidiBendRange, MidiControl, MidiFileData, MidiNote, MidiProgram, MidiTrack } from './midi';
import { PPQ } from './noteClock';
import { bendWheelEvents, playingLane } from './pitchBend';
import { clipControlTimes, clipNoteSpan, clipRenderInput } from './rollClip';
import { tempoMapText, tempoMapToMidiTempos } from './rollMidi';
import { hasTempoChanges, sanitizeRollTempoMap, stepClock, type StepClock } from './rollTempo';
import { PERCUSSION_PART_CHANNEL, partFileChannels } from './rollTracks';
import { beatToTime, getTempoAtBeat, timeToBeat, type TempoEvent } from './tempoMap';

/** The arrangement an export reads (editorStore's fields). */
export interface ArrangementMidiSource {
  tracks: readonly EditorTrack[];
  clips: readonly AudioClip[];
  bpm: number;
  /** The arrangement's one time signature, read when it has no meter map. */
  timeSignature?: { num: number; den: number };
  /** The arrangement's tempo map (beats from the timeline's start), when EDIT holds one. */
  tempoMap?: readonly TempoEvent[];
  /** The arrangement's time signatures by bar, when EDIT holds a meter map. */
  meterMap?: readonly MeterSegment[];
}

/** Which clips an export takes. `all` follows the mix (mute and solo); the other two take what they name. */
export type ArrangementMidiScope =
  | { kind: 'all' }
  | { kind: 'tracks'; trackIds: readonly string[] }
  | { kind: 'clips'; clipIds: readonly string[] };

export interface ArrangementMidiOptions {
  scope?: ArrangementMidiScope;
  /** A span of the timeline in seconds; left out, the whole arrangement from 0. */
  range?: { startSec: number; endSec: number } | null;
  /** The picker's voice, for a clip and track with no program of their own. */
  global?: GlobalVoice;
  ppq?: number;
}

export interface ArrangementMidiResult {
  file: MidiFileData;
  noteCount: number;
  /** MIDI tracks written, one per EDIT track with notes in the export. */
  trackCount: number;
  /** EDIT tracks that share a channel with another (past fifteen melodic tracks). */
  sharedTracks: string[];
  /** Muted clips left out. */
  mutedClips: number;
  /** Where the file's tick 0 sits on the timeline, in seconds (a range starts on its bar line). */
  startSec: number;
}

/** EDIT's default fader: a track at it writes no volume change of its own. */
export const EDIT_DEFAULT_VOLUME = 0.8;
/** The volume a General MIDI channel starts at, which a track at EDIT's default fader corresponds to. */
const GM_DEFAULT_VOLUME = 100;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp7 = (v: number): number => Math.max(0, Math.min(127, Math.round(v)));

/** The factor a fader applies to CC 7 on the General MIDI curve (gain = (CC7/127)^2): sqrt of the fader over its default. */
export const faderVolumeScale = (volume: number | undefined): number =>
  isNum(volume) && volume >= 0 ? Math.sqrt(volume / EDIT_DEFAULT_VOLUME) : 1;

/** A pan of -1..1 as the amount it moves CC 10 (64 the centre). */
export const panControlOffset = (pan: number | undefined): number => (isNum(pan) ? Math.round(Math.max(-1, Math.min(1, pan)) * 63.5) : 0);

/** The tempo map from `startBeat` on, as beats from there: the tempo in force there at beat 0, later events moved back. */
export function tempoMapFrom(map: readonly TempoEvent[], startBeat: number): TempoEvent[] {
  if (!(startBeat > 0)) return [...map];
  const tempos = map.filter((e) => !e.fermata).sort((a, b) => a.beat - b.beat);
  const owning = [...tempos].reverse().find((e) => e.beat <= startBeat);
  const out: TempoEvent[] = [{ beat: 0, bpm: getTempoAtBeat(map, startBeat), curve: owning?.curve ?? 'step' }];
  for (const e of map) if (e.beat > startBeat) out.push({ ...e, beat: e.beat - startBeat });
  return out;
}

/** The meter map from `bar` on, as bars from there. */
export function meterMapFrom(map: readonly MeterSegment[], bar: number): MeterSegment[] {
  if (bar <= 0) return normalizeMeterMap(map);
  const segs = normalizeMeterMap(map, false);
  return normalizeMeterMap([
    { bar: 0, meter: meterAtBar(segs, bar) },
    ...segs.filter((s) => s.bar > bar).map((s) => ({ bar: s.bar - bar, meter: s.meter })),
  ]);
}

/** One clip's contribution to its MIDI track, in timeline seconds. */
interface ClipEvents {
  startSec: number;
  program: number | undefined;
  bank: number;
  /** Each note with the bent lane it plays in; null for a lane that does not bend (the track's own channel). */
  notes: Array<{ onSec: number; offSec: number; note: number; velocity: number; lane: number | null }>;
  controls: Array<{ sec: number; controller: number; value: number }>;
  /** Each bent lane's range and wheel messages, the value where the clip's window starts first. */
  wheels: Array<{ lane: number; range: number; events: Array<{ sec: number; raw: number }> }>;
}

/** The steps a clip's render covers (lib/clipRerender's rule): its grid length, else the bar line after its last note. */
const clipTotalSteps = (clip: AudioClip): number =>
  clip.sourceTotalSteps ?? roundUpToBar(clip.sourceMeterMap ?? [], noteEndStep(clip.sourcePianoRoll ?? [], 1), clip.sourcePickupSteps ?? 0);

/**
 * A clip's notes, controller changes and lane bends at their timeline seconds,
 * as EDIT plays them: through the clip's clock, inside its trim window, a note
 * cut at the clip's end; the controllers that fall before the window come in at
 * the clip's start with the value each held there, and so does each bent
 * lane's wheel.
 */
function clipEvents(clip: AudioClip, track: EditorTrack, global: GlobalVoice, fallbackBpm: number): ClipEvents {
  const clock: StepClock = stepClock(clip.sourceBpm ?? fallbackBpm, clip.sourceTempoMap);
  const offset = clip.offsetIntoSource ?? 0;
  const percussion = isPercussionTrack(track);
  // The notes its render plays: with bent lanes, the roll's own notes unrolled with their lanes (a drum track bends nothing).
  const input = percussion ? null : clipRenderInput(clip, clipTotalSteps(clip));
  const bends = input?.bends;
  const notes: ClipEvents['notes'] = [];
  for (const n of bends && input ? input.notes : (clip.sourcePianoRoll ?? [])) {
    const { relStart, relEnd } = clipNoteSpan(n, clock, offset);
    if (relEnd <= 0 || relStart >= clip.durationSec) continue;
    const lane = bends ? playingLane(n.lane, bends.lanes) : 0;
    notes.push({
      onSec: clip.startSec + Math.max(0, relStart),
      offSec: clip.startSec + Math.min(clip.durationSec, relEnd),
      note: n.note,
      velocity: n.velocity,
      lane: bends?.played.has(lane) ? lane : null,
    });
  }
  // Each bent lane with notes in the window: its wheel from the window's first step to its last point or the window's end.
  const wheels: ClipEvents['wheels'] = [];
  if (bends) {
    const firstStep = Math.max(0, clock.stepAt(offset));
    const endStep = clock.stepAt(offset + clip.durationSec);
    for (const [lane, played] of bends.played) {
      if (!played.points.length || !notes.some((n) => n.lane === lane)) continue;
      const to = Math.max(firstStep, Math.min(played.points[played.points.length - 1].step, endStep));
      const events: Array<{ sec: number; raw: number }> = [];
      for (const e of bendWheelEvents(played.points, firstStep, to, true, played.range)) {
        const rel = clock.at(e.step) - offset;
        if (rel >= clip.durationSec) continue;
        events.push({ sec: clip.startSec + Math.max(0, rel), raw: e.raw });
      }
      wheels.push({ lane, range: played.range, events });
    }
  }
  // The part's controller changes where EDIT plays them, the state at the window's start first (lib/rollClip).
  const controls: ClipEvents['controls'] = clipControlTimes(clip, fallbackBpm);
  const voice = clipVoice(clip, track, global);
  // The voice EDIT plays the clip with; with none (no program anywhere, the picker off the soundfont), its roll part's.
  const program = voice.program ?? clip.sourceRollPart?.program ?? undefined;
  return {
    startSec: clip.startSec,
    program: percussion ? (program ?? GM_STANDARD_KIT) : program,
    bank: percussion ? 0 : Math.max(0, Math.min(127, Math.round(clip.sourceRollPart?.bank ?? 0))),
    notes,
    controls,
    wheels,
  };
}

/** The partFileChannels id of a track's extra channel for bent lane `lane`. */
const laneChannelId = (trackId: string, lane: number): string => `${trackId}\u0001lane:${lane}`;

/** The clips of `track` the scope takes, in timeline order. */
function scopedClips(source: ArrangementMidiSource, track: EditorTrack, scope: ArrangementMidiScope, soloed: boolean): AudioClip[] {
  if (scope.kind === 'all' && (track.mute || (soloed && !track.solo))) return [];
  if (scope.kind === 'tracks' && !scope.trackIds.includes(track.id)) return [];
  return source.clips
    .filter((c) => c.trackId === track.id && c.sourceKind === 'piano-roll' && (c.sourcePianoRoll?.length ?? 0) > 0)
    .filter((c) => scope.kind !== 'clips' || scope.clipIds.includes(c.id))
    .sort((a, b) => a.startSec - b.startSec);
}

/** The whole arrangement (or the part the options name) as a type-1 MIDI file. */
export function arrangementToMidiFile(source: ArrangementMidiSource, options: ArrangementMidiOptions = {}): ArrangementMidiResult {
  const ppq = options.ppq ?? PPQ;
  const scope = options.scope ?? { kind: 'all' };
  const global = options.global ?? { useSoundfont: false, activeProgram: 0 };
  const bpm = isNum(source.bpm) && source.bpm > 0 ? source.bpm : 120;
  const map = sanitizeRollTempoMap(source.tempoMap?.length ? source.tempoMap : [], bpm);
  const meterMap = normalizeMeterMap(
    source.meterMap?.length
      ? source.meterMap
      : [{ bar: 0, meter: { num: source.timeSignature?.num ?? 4, den: source.timeSignature?.den ?? 4, groups: [] } }],
  );

  // A span starts the file on the bar line at or before it, so the file's bars are the arrangement's.
  const range = options.range && options.range.endSec > options.range.startSec ? options.range : null;
  const rangeStartBeat = range ? timeToBeat(map, Math.max(0, range.startSec)) : 0;
  const startBar = range ? barAt(meterMap, rangeStartBeat * 4, 0) : null;
  const startBeat = startBar ? barStartStep(meterMap, startBar.bar, 0) / 4 : 0;
  const startSec = startBeat > 0 ? Math.max(0, beatToTime(map, startBeat)) : 0;
  const tickOf = (sec: number): number => Math.max(0, Math.round((timeToBeat(map, sec) - startBeat) * ppq));
  const inRange = (sec: number): boolean => !range || (sec >= range.startSec - 1e-9 && sec < range.endSec - 1e-9);
  const cutEnd = (sec: number): number => (range ? Math.min(sec, range.endSec) : sec);

  const soloed = source.tracks.some((t) => t.solo && !t.isFolder);
  let mutedClips = 0;
  // Every EDIT track with notes in the export, with its clips' events and the channels its notes need:
  // `null` for the lanes that do not bend, then each bent lane, lowest id first.
  const tracks: Array<{ track: EditorTrack; events: ClipEvents[]; partChannel: number | null; keys: Array<number | null> }> = [];
  for (const track of source.tracks) {
    if (track.isFolder) continue;
    const clips = scopedClips(source, track, scope, soloed);
    const kept = clips.filter((c) => {
      if (c.muted) mutedClips += 1;
      return !c.muted;
    });
    const events = kept.map((c) => clipEvents(c, track, global, bpm));
    for (const e of events) {
      e.notes = e.notes.filter((n) => inRange(n.onSec)).map((n) => ({ ...n, offSec: cutEnd(n.offSec) }));
      e.controls = e.controls.filter((c) => !range || c.sec < range.endSec - 1e-9);
      // A bent lane's wheel only where the lane still has notes in the span, and none past its end.
      e.wheels = e.wheels
        .filter((w) => e.notes.some((n) => n.lane === w.lane))
        .map((w) => ({ ...w, events: w.events.filter((x) => !range || x.sec < range.endSec - 1e-9) }));
    }
    if (!events.some((e) => e.notes.length)) continue;
    // A channel the clips' roll parts agree on (an imported file's own channel) is kept.
    const named = new Set(kept.map((c) => c.sourceRollPart?.channel ?? null));
    const only = named.size === 1 ? [...named][0] : null;
    const partChannel = only !== null && only !== PERCUSSION_PART_CHANNEL ? only : null;
    const lanes = new Set<number>();
    let plain = false;
    for (const e of events) for (const n of e.notes) {
      if (n.lane === null) plain = true;
      else lanes.add(n.lane);
    }
    const keys: Array<number | null> = [...(plain ? [null] : []), ...[...lanes].sort((a, b) => a - b)];
    tracks.push({ track, events, partChannel, keys });
  }

  // A channel two tracks' parts name (two files imported as tracks, each with a part on channel 1) stays with
  // the first track; the next takes a free channel, so two tracks never share a channel while one is free.
  const claimed = new Set<number>();
  for (const t of tracks) {
    if (t.partChannel === null) continue;
    if (claimed.has(t.partChannel)) t.partChannel = null;
    else claimed.add(t.partChannel);
  }
  // The track's first channel takes its id (and the channel its parts name); each further bent lane takes one more.
  const { channels, shared } = partFileChannels(
    tracks.flatMap((t) =>
      t.keys.map((key, i) =>
        i === 0
          ? { id: t.track.id, channel: isPercussionTrack(t.track) ? PERCUSSION_PART_CHANNEL : t.partChannel }
          : { id: laneChannelId(t.track.id, key as number), channel: null },
      ),
    ),
  );
  const sharedIds = new Set(shared);

  const out: MidiTrack[] = [];
  let noteCount = 0;
  for (const { track, events, keys } of tracks) {
    const channelOf = (key: number | null): number =>
      channels.get(key === keys[0] ? track.id : laneChannelId(track.id, key as number)) as number;
    const trackChannels = [...new Set(keys.map(channelOf))];
    const notes: MidiNote[] = [];
    const programs: MidiProgram[] = [];
    const controls: MidiControl[] = [];
    // Each channel's wheel messages in time order, and the range it bends by.
    const wheelOn = new Map<number, MidiBend[]>();
    const bendRanges: MidiBendRange[] = [];
    const rangeOn = new Map<number, number>();
    let current: string | null = null;
    for (const e of events) {
      if (!e.notes.length && !e.controls.length) continue;
      // A program change where the clip's voice differs from the one sounding: tick 0 for the first, on each of the track's channels.
      const key = `${e.program ?? 'none'}:${e.bank}`;
      if (e.program !== undefined && key !== current) {
        const tick = current === null ? 0 : tickOf(Math.max(startSec, e.startSec));
        for (const channel of trackChannels) programs.push({ tick, channel, program: e.program, ...(e.bank > 0 ? { bank: e.bank } : {}) });
        current = key;
      }
      for (const n of e.notes) {
        const tick = tickOf(n.onSec);
        notes.push({ tick, note: n.note, velocity: Math.max(1, Math.min(127, Math.round(n.velocity))), durationTicks: Math.max(1, tickOf(n.offSec) - tick), channel: channelOf(n.lane) });
      }
      for (const c of e.controls) {
        const tick = tickOf(Math.max(startSec, c.sec));
        for (const channel of trackChannels) controls.push({ tick, channel, controller: c.controller, value: c.value });
      }
      for (const w of e.wheels) {
        const channel = channelOf(w.lane);
        const list = wheelOn.get(channel) ?? [];
        wheelOn.set(channel, list);
        for (const [i, x] of w.events.entries()) {
          const tick = tickOf(Math.max(startSec, x.sec));
          // The lane's range (RPN 0/0) with its first message, and again where a later clip's lane bends by another.
          if (i === 0 && rangeOn.get(channel) !== w.range) {
            bendRanges.push({ tick, channel, semitones: w.range });
            rangeOn.set(channel, w.range);
          }
          // A message at the tick of the one before it replaces it: the wheel goes where the later one says.
          if (list.length && list[list.length - 1].tick === tick) list.pop();
          list.push({ tick, channel, value: x.raw });
        }
      }
    }
    // The fader and pan, on the General MIDI volume curve and around the centre.
    const scale = faderVolumeScale(track.volume);
    const panOffset = panControlOffset(track.pan);
    const hasVolume = controls.some((c) => c.controller === 7);
    const hasPan = controls.some((c) => c.controller === 10);
    for (const c of controls) {
      if (c.controller === 7 && Math.abs(scale - 1) > 1e-9) c.value = clamp7(c.value * scale);
      if (c.controller === 10 && panOffset !== 0) c.value = clamp7(c.value + panOffset);
    }
    for (const channel of trackChannels) {
      if (!hasVolume && Math.abs(scale - 1) > 1e-9) controls.push({ tick: 0, channel, controller: 7, value: clamp7(GM_DEFAULT_VOLUME * scale) });
      if (!hasPan && panOffset !== 0) controls.push({ tick: 0, channel, controller: 10, value: clamp7(64 + panOffset) });
    }
    notes.sort((a, b) => a.tick - b.tick);
    controls.sort((a, b) => a.tick - b.tick);
    const bends = [...wheelOn.values()].flat().sort((a, b) => a.tick - b.tick);
    bendRanges.sort((a, b) => a.tick - b.tick);
    noteCount += notes.length;
    out.push({
      name: track.name,
      notes,
      ...(programs.length ? { programs } : {}),
      ...(controls.length ? { controls } : {}),
      ...(bends.length ? { bends, bendRanges } : {}),
    });
  }

  const fileMap = sanitizeRollTempoMap(tempoMapFrom(map, startBeat), getTempoAtBeat(map, startBeat));
  const fileMeter = startBar ? meterMapFrom(meterMap, startBar.bar) : meterMap;
  const file: MidiFileData = {
    ppq,
    bpm: fileMap[0]?.bpm ?? bpm,
    tempos: tempoMapToMidiTempos(fileMap, ppq),
    ...(hasTempoChanges(fileMap) ? { dawTempoMap: tempoMapText(fileMap) } : {}),
    timeSignatures: meterMapToMidiEvents(fileMeter, ppq, 0),
    tracks: out,
  };
  return {
    file,
    noteCount,
    trackCount: out.length,
    // A track whose own channel or any of its bent lanes' channels is shared.
    sharedTracks: tracks
      .filter((t) => t.keys.some((key, i) => sharedIds.has(i === 0 ? t.track.id : laneChannelId(t.track.id, key as number))))
      .map((t) => t.track.name),
    mutedClips,
    startSec,
  };
}
