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
 * tracks that share: a track whose parts name a channel an earlier track took
 * keeps that channel once no channel is free, so the parts of a file that
 * shared a channel share it again. Each clip's voice
 * (lib/clipProgram clipVoice: its program, else its track's, else the
 * picker's) is written as a program change at tick 0, and again at the start
 * of any later clip on the track that sounds another program or bank. The
 * bank select is the one EDIT plays that program in (clipVoice's bank: a
 * clip's own program in the bank its roll part chose, none on a drum track),
 * so the file sounds what EDIT's live notes and renders sound; the roll
 * part's bank select LSB goes with it while the clip still plays the part's
 * program in the part's bank (clipBankSelect). A clip EDIT plays with no
 * program writes its roll part's program with the part's whole bank select.
 *
 * CONTROLLERS: each clip's roll part carries its controller changes
 * (RollPartRef `controls`: modulation, volume, pan, expression, the sustain
 * pedal). They are written at their seconds, and where a clip's window starts
 * past some of them, the value each held there is written at the clip's start
 * when it is off the General MIDI default, so a trimmed clip starts with its
 * pedal and volume. A clip's controllers end
 * with it, as EDIT renders every clip on its own from a channel at the General
 * MIDI defaults: where the clip ends, each controller it left off its default
 * goes back, the pedal first, so nothing it held rings past the clip and the
 * next clip on the track starts where its render starts (endClipControls). A
 * clip that starts before the one before it ends owns the channel from its
 * start. The track's fader and pan ride in the same controllers: a fader off
 * EDIT's default (0.8) scales every volume change on the General MIDI volume
 * curve (gain = (CC7/127)^2) and writes the fader's volume at tick 0 unless a
 * clip sets one there; a pan off centre moves every pan change and writes its
 * pan at tick 0 the same way. A controller acts on a channel, so every
 * change, program change included, goes to each channel the track's notes
 * play on.
 *
 * ARTICULATIONS: a note's articulation rides with it (the `theDAW:art=` text
 * lib/midi writes, which an import reads back). A note whose articulation
 * plays a soundfont preset of its own (lib/articulationMap, for the clip's
 * instrument: a string part's pizzicato on GM 46) is written on a channel of
 * that preset's, the one EDIT's live MIDI gives it, with the preset's program
 * change and bank select at tick 0; a bent lane's articulation notes take one
 * per lane, which carries the lane's wheel too. Those channels come from the
 * same sixteen; past fifteen melodic channels an articulation that finds none
 * free plays on its track's own channel in the track's program, and
 * `articulationFallback` names the track.
 *
 * PER-NOTE EXPRESSION: a note that carries expression of its own (PianoNote
 * `expr`) is written MPE-style on the upper zone's member channels (lib/
 * mpeMidi: 14 down, rotated across the arrangement's notes as EDIT rotates
 * them live), each member set to its note's range, wheel, CC 74 and pressure
 * just before it starts and then at every point of its curves, with the
 * zone's configuration message on channel 15. An import reads them back onto
 * the notes. With no member channel free, those notes stay on their track's
 * channel and `mpeNoRoom` says so.
 *
 * CONTROLLER AUTOMATION: a track's trackMidiCc automation lanes (lib/
 * midiCcAutomation) are written as that controller's changes on each of the
 * track's channels, the value at the file's start first, then a change where
 * the lane's whole value moves, to the end of the track's last clip (or the
 * span). A lane owns its controller on its track, so the clips' own changes
 * of that controller are left out, as EDIT's live playback leaves them out.
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
 * MARKERS: EDIT's timeline markers (a roll part's sections and movements, and
 * the user's own) are written as FF 06 markers at their seconds, through the
 * arrangement's tempo map, the ones inside a span alone when a span is
 * exported.
 *
 * RANGE: an export of a span of the timeline starts on the bar line at or
 * before the span's start, so the file's bars are the arrangement's bars, and
 * keeps the notes that start inside the span, each cut at its end. A clip that
 * ends before the span starts leaves nothing in it.
 *
 * The resolution is the roll's own 960 PPQ. Pure (no stores), so node tests
 * run it; exportArrangementMidi (lib/arrangementMidiApp) reads the stores and
 * saves the file.
 */
import type { AudioClip, AutomationLane, EditorTrack, TimelineMarker } from '../state/editorStore';
import type { RollPartRef } from '../state/pianoRollStore';
import { noteEndStep } from './clipNotes/units';
import { GM_STANDARD_KIT, clipVoice, isPercussionTrack, type ClipVoice, type GlobalVoice } from './clipProgram';
import { barAt, barStartStep, meterAtBar, meterMapToMidiEvents, normalizeMeterMap, roundUpToBar, type MeterSegment } from './meterMap';
import type { MidiBend, MidiBendRange, MidiControl, MidiFileData, MidiNote, MidiPressure, MidiProgram, MidiTrack } from './midi';
import { PPQ } from './noteClock';
import { bendWheelEvents, playingLane } from './pitchBend';
import { clipControlTimes, clipNoteSpan, clipRenderInput } from './rollClip';
import { tempoMapText, tempoMapToMidiTempos } from './rollMidi';
import { hasTempoChanges, sanitizeRollTempoMap, stepClock, type StepClock } from './rollTempo';
import { PERCUSSION_PART_CHANNEL, cleanPartBank, cleanPartBankLsb, partController, partFileChannels } from './rollTracks';
import { beatToTime, getTempoAtBeat, timeToBeat, type TempoEvent } from './tempoMap';
import { automatedControllers, ccLaneEvents, ccLaneValueAt, trackCcLanes } from './midiCcAutomation';
import { articulatedNotes, clipArticulationInstrument, type Articulation, type SoundfontArticulationTarget } from './articulationMap';
import { artChannelKey } from './rollMidi';
import { mpeNoteMessages, mpeZoneEvent, planMpeExport, writesAsMpe, type MpeExportNote } from './mpeMidi';
import { EXPRESSION_DIMENSIONS, type ExpressionDimension } from './noteExpression';
import type { NoteExpression } from '../state/pianoRollStore';

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
  /** EDIT's timeline markers, each at its second; written as FF 06 markers. */
  markers?: readonly TimelineMarker[];
  /** EDIT's automation lanes; the trackMidiCc ones are written as controller changes. */
  automationLanes?: readonly AutomationLane[];
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
  /** True when notes carried expression of their own and no MPE member channel was free: they play on their track's channel. */
  mpeNoRoom?: boolean;
  /** Tracks whose preset articulations (a pizzicato's GM 46) found no channel of their own past fifteen melodic channels: they play in the track's program. */
  articulationFallback: string[];
}

/** A file's channels a melodic track can take: all sixteen but channel 10, the drums'. */
const MELODIC_FILE_CHANNELS = 15;

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
  /** Where the clip's window ends on the timeline. */
  endSec: number;
  program: number | undefined;
  bank: number;
  /** The part's bank select LSB (CC 32), when it sends one. */
  bankLsb: number | undefined;
  /**
   * Each note with the bent lane it plays in (null for a lane that does not
   * bend: the track's own channel), its articulation, and the articulation
   * channel it plays on when its articulation plays a preset of its own.
   */
  notes: Array<{
    onSec: number;
    offSec: number;
    note: number;
    velocity: number;
    lane: number | null;
    articulation?: Articulation;
    art: { key: string; target: SoundfontArticulationTarget } | null;
    /** The note's own expression, its curves' points at timeline seconds (null when it carries none). */
    expr: { e: NoteExpression; curves: Partial<Record<ExpressionDimension, Array<{ sec: number; value: number }>>> } | null;
  }>;
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
  const voice = clipVoice(clip, track, global);
  // The notes' articulations, as they resolve for the voice EDIT plays the clip with.
  const source = bends && input ? input.notes : (clip.sourcePianoRoll ?? []);
  const arts = articulatedNotes(source, clipArticulationInstrument(clip, voice.program ?? clip.sourceRollPart?.program ?? undefined, percussion)).notes;
  source.forEach((n, i) => {
    const { relStart, relEnd } = clipNoteSpan(n, clock, offset);
    if (relEnd <= 0 || relStart >= clip.durationSec) return;
    const laneId = bends ? playingLane(n.lane, bends.lanes) : 0;
    const lane = bends?.played.has(laneId) ? laneId : null;
    const target = arts[i]?.target ?? null;
    notes.push({
      onSec: clip.startSec + Math.max(0, relStart),
      offSec: clip.startSec + Math.min(clip.durationSec, relEnd),
      note: n.note,
      velocity: n.velocity,
      lane,
      ...(n.articulation ? { articulation: n.articulation } : {}),
      art: target ? { key: artChannelKey(target, lane), target } : null,
      // The note's own expression, its curve points at their seconds through the clip's clock.
      expr: writesAsMpe(n.expr)
        ? {
            e: n.expr,
            curves: Object.fromEntries(
              EXPRESSION_DIMENSIONS.filter((d) => n.expr?.curves?.[d]?.length).map((d) => [
                d,
                (n.expr?.curves?.[d] ?? []).map((p) => ({
                  sec: clip.startSec + clock.at(((n.tick ?? Math.round(n.step * 240)) + p.tick) / 240) - offset,
                  value: p.value,
                })),
              ]),
            ),
          }
        : null,
    });
  });
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
  // A state at the General MIDI default is left out: the channel is there already at the clip's start (the
  // file's start, or the reset where the clip before it ends, endClipControls), so a file read back and
  // written again gains no change the part never made.
  const controls: ClipEvents['controls'] = clipControlTimes(clip, fallbackBpm)
    .filter((c) => !(c.held && c.value === controllerDefault(c.controller)))
    .map((c) => ({ sec: c.sec, controller: c.controller, value: c.value }));
  // The voice EDIT plays the clip with; with none (no program anywhere, the picker off the soundfont), its roll part's.
  const program = voice.program ?? clip.sourceRollPart?.program ?? undefined;
  const { bank, bankLsb } = clipBankSelect(voice, clip.sourceRollPart);
  return {
    startSec: clip.startSec,
    endSec: clip.startSec + clip.durationSec,
    program: percussion ? (program ?? GM_STANDARD_KIT) : program,
    bank,
    bankLsb,
    notes,
    controls,
    wheels,
  };
}

/**
 * The bank select a clip's program change carries. The MSB is the bank EDIT
 * plays the clip's program in (lib/clipProgram clipVoice: a clip's own program
 * in its `instrumentBank`, 0 on a drum track, where the kit is chosen by
 * program), the one its live notes and every render select, so a clip whose
 * instrument was picked again in EDIT (which drops the bank) writes bank 0.
 * The LSB is the roll part's (`bankLsb`, which only a file carries) while the
 * clip still plays the part's program in the part's bank: a part that follows
 * the roll voice (no program of its own) plays whatever its clip plays, so its
 * bank alone decides. A clip EDIT plays with no program (none anywhere and the
 * picker off the soundfont) writes its part's own program, so the part's whole
 * bank select goes with it.
 */
export function clipBankSelect(voice: ClipVoice, part: RollPartRef | undefined): { bank: number; bankLsb: number | undefined } {
  if (voice.percussion) return { bank: 0, bankLsb: undefined };
  if (voice.program === undefined) {
    return part && part.program !== null ? { bank: cleanPartBank(part.bank), bankLsb: cleanPartBankLsb(part.bankLsb) } : { bank: 0, bankLsb: undefined };
  }
  const bank = voice.bank ?? 0;
  const partsVoice = !!part && bank === cleanPartBank(part.bank) && (part.program === null || part.program === voice.program);
  return { bank, bankLsb: partsVoice ? cleanPartBankLsb(part.bankLsb) : undefined };
}

/** The value a channel starts at for `controller` (General MIDI's reset, lib/rollTracks PART_CONTROLLERS). */
const controllerDefault = (controller: number): number => partController(controller)?.initial ?? 0;

/**
 * End each clip's controllers with the clip (`events` in timeline order, one
 * track's). EDIT renders every clip on its own, from a channel at the General
 * MIDI defaults, so where a clip ends each controller it left off its default
 * goes back to it, the pedal first, so nothing it held rings past the clip's
 * end. A later clip that starts before that end owns the channel from its
 * start: the earlier clip's changes stop there and its reset lands there,
 * leaving out the controllers the later clip sets at its own start.
 */
function endClipControls(events: ClipEvents[]): void {
  events.forEach((e, i) => {
    const next = events[i + 1];
    const end = next && next.startSec < e.endSec - 1e-9 ? next.startSec : e.endSec;
    const kept = e.controls.filter((c) => c.sec < end - 1e-9);
    const state = new Map<number, number>();
    for (const c of kept) state.set(c.controller, c.value);
    const nextSets = new Set(
      next && Math.abs(next.startSec - end) < 1e-9 ? next.controls.filter((c) => Math.abs(c.sec - end) < 1e-9).map((c) => c.controller) : [],
    );
    const resets = [...state.entries()]
      .filter(([controller, value]) => value !== controllerDefault(controller) && !nextSets.has(controller))
      .map(([controller]) => controller)
      .sort((a, b) => (a === 64 ? -1 : b === 64 ? 1 : a - b))
      .map((controller) => ({ sec: end, controller, value: controllerDefault(controller) }));
    e.controls = kept.concat(resets);
  });
}

/** The partFileChannels id of a track's extra channel for bent lane `lane`. */
const laneChannelId = (trackId: string, lane: number): string => `${trackId}\u0001lane:${lane}`;

/** The partFileChannels id of a track's articulation channel `key` (rollMidi artChannelKey). */
const artChannelId = (trackId: string, key: string): string => `${trackId}\u0001art:${key}`;

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
  const ccLanes = trackCcLanes(source.automationLanes);
  const owned = automatedControllers(ccLanes);
  let mutedClips = 0;
  // Every EDIT track with notes in the export, with its clips' events and the channels its notes need:
  // `null` for the lanes that do not bend, then each bent lane, lowest id first.
  const tracks: Array<{
    track: EditorTrack;
    events: ClipEvents[];
    partChannel: number | null;
    keys: Array<number | null>;
    /** Its articulation channels, each with its preset and the bent lane it follows. */
    arts: Array<{ key: string; target: SoundfontArticulationTarget; lane: number | null }>;
  }> = [];
  for (const track of source.tracks) {
    if (track.isFolder) continue;
    const clips = scopedClips(source, track, scope, soloed);
    const kept = clips
      .filter((c) => {
        if (c.muted) mutedClips += 1;
        return !c.muted;
      })
      // A clip that ends before the span starts has no note in it, and its controllers end with it.
      .filter((c) => !range || c.startSec + c.durationSec > range.startSec + 1e-9);
    const events = kept.map((c) => clipEvents(c, track, global, bpm));
    endClipControls(events);
    // The controllers the track's automation owns leave the clips' own changes out.
    const ownedHere = owned.get(track.id);
    if (ownedHere) for (const e of events) e.controls = e.controls.filter((c) => !ownedHere.has(c.controller));
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
    // A drum track is written on channel 10 whatever its parts name, so it names no melodic channel.
    const partChannel = only !== null && only !== PERCUSSION_PART_CHANNEL && !isPercussionTrack(track) ? only : null;
    const lanes = new Set<number>();
    let plain = false;
    for (const e of events) for (const n of e.notes) {
      if (n.lane === null) plain = true;
      else lanes.add(n.lane);
    }
    const keys: Array<number | null> = [...(plain ? [null] : []), ...[...lanes].sort((a, b) => a - b)];
    const arts: Array<{ key: string; target: SoundfontArticulationTarget; lane: number | null }> = [];
    for (const e of events) for (const n of e.notes) {
      if (n.art && !arts.some((a) => a.key === n.art?.key)) arts.push({ key: n.art.key, target: n.art.target, lane: n.lane });
    }
    tracks.push({ track, events, partChannel, keys, arts });
  }

  // A channel two tracks' parts name (two files imported as tracks, each with a part on channel 1) stays with
  // the first track; the next takes a free channel, so two tracks never share a channel while one is free.
  // When none is left (a 24-part orchestral file, whose parts already share channels), the next keeps the
  // channel its part names, sharing it as the file did, rather than going onto another part's channel in turn.
  const partChannels = new Set(tracks.map((t) => t.partChannel).filter((ch): ch is number => ch !== null));
  // The channels no part names, less those the tracks with no channel of their own and their bent lanes take.
  let spare =
    MELODIC_FILE_CHANNELS -
    partChannels.size -
    tracks.reduce((n, t) => n + (t.partChannel === null && !isPercussionTrack(t.track) ? 1 : 0) + Math.max(0, t.keys.length - 1) + t.arts.length, 0);
  const claimed = new Set<number>();
  for (const t of tracks) {
    if (t.partChannel === null) continue;
    if (!claimed.has(t.partChannel)) claimed.add(t.partChannel);
    else if (spare > 0) {
      t.partChannel = null;
      spare -= 1;
    }
  }
  // The track's first channel takes its id (and the channel its parts name); each further bent lane takes one more.
  const { channels, shared } = partFileChannels(
    tracks.flatMap((t) => [
      ...t.keys.map((key, i) =>
        i === 0
          ? { id: t.track.id, channel: isPercussionTrack(t.track) ? PERCUSSION_PART_CHANNEL : t.partChannel }
          : { id: laneChannelId(t.track.id, key as number), channel: null },
      ),
      ...t.arts.map((a) => ({ id: artChannelId(t.track.id, a.key), channel: null })),
    ]),
  );
  const sharedIds = new Set(shared);
  // Every expressive note of the export, on the upper MPE zone's members, clear of every channel the tracks took.
  const mpeSpans: MpeExportNote[] = [];
  for (const t of tracks) {
    let i = 0;
    for (const e of t.events) for (const n of e.notes) {
      if (n.expr && !isPercussionTrack(t.track)) mpeSpans.push({ key: `${t.track.id}#${i}`, start: tickOf(n.onSec), end: Math.max(tickOf(n.onSec) + 1, tickOf(n.offSec)) });
      i += 1;
    }
  }
  const mpe = planMpeExport(mpeSpans, new Set(channels.values()));
  const memberRange = new Map<number, number>();
  // The tracks whose preset articulations found no channel of their own.
  const articulationFallback = new Set<string>();
  const memberProgram = new Map<number, string>();

  const out: MidiTrack[] = [];
  let noteCount = 0;
  for (const { track, events, keys, arts } of tracks) {
    const channelOf = (key: number | null): number =>
      channels.get(key === keys[0] ? track.id : laneChannelId(track.id, key as number)) as number;
    // An articulation channel that would be shared with another track (no channel left) is not taken: its notes stay home.
    const artChannelOf = (key: string): number | undefined => {
      const id = artChannelId(track.id, key);
      return sharedIds.has(id) ? undefined : channels.get(id);
    };
    // The channels the clips' voice plays on, and every channel the track's notes play on (its articulation channels too).
    const voiceChannels = [...new Set(keys.map(channelOf))];
    const trackChannels = [...new Set([...voiceChannels, ...arts.map((a) => artChannelOf(a.key)).filter((ch): ch is number => ch !== undefined)])];
    const notes: MidiNote[] = [];
    const programs: MidiProgram[] = [];
    const controls: MidiControl[] = [];
    // Each channel's wheel messages in time order, and the range it bends by.
    const wheelOn = new Map<number, MidiBend[]>();
    const bendRanges: MidiBendRange[] = [];
    const rangeOn = new Map<number, number>();
    const pressures: MidiPressure[] = [];
    const mpeBends: MidiBend[] = [];
    let current: string | null = null;
    let noteIndex = 0;
    for (const e of events) {
      if (!e.notes.length && !e.controls.length) continue;
      // A program change where the clip's voice differs from the one sounding: tick 0 for the first, on each of the track's channels.
      const key = `${e.program ?? 'none'}:${e.bank}:${e.bankLsb ?? 'none'}`;
      if (e.program !== undefined && key !== current) {
        const tick = current === null ? 0 : tickOf(Math.max(startSec, e.startSec));
        for (const channel of voiceChannels) {
          programs.push({ tick, channel, program: e.program, ...(e.bank > 0 ? { bank: e.bank } : {}), ...(e.bankLsb !== undefined ? { bankLsb: e.bankLsb } : {}) });
        }
        current = key;
      }
      for (const n of e.notes) {
        const tick = tickOf(n.onSec);
        const durationTicks = Math.max(1, tickOf(n.offSec) - tick);
        const home = channelOf(n.lane);
        const member = n.expr ? mpe.channelOf.get(`${track.id}#${noteIndex}`) : undefined;
        noteIndex += 1;
        const artChannel = n.art ? artChannelOf(n.art.key) : undefined;
        if (n.art && artChannel === undefined && member === undefined) articulationFallback.add(track.name);
        const channel = member ?? artChannel ?? home;
        if (member !== undefined && n.expr) {
          // The member channel: the clip's voice, then the note's range, wheel, CC 74 and pressure, then its curves.
          const voice = `${e.program ?? ''}:${e.bank}`;
          if (e.program !== undefined && memberProgram.get(member) !== voice) {
            programs.push({ tick, channel: member, program: e.program, ...(e.bank > 0 ? { bank: e.bank } : {}) });
            memberProgram.set(member, voice);
          }
          const curves: NonNullable<NoteExpression['curves']> = {};
          for (const [dim, pts] of Object.entries(n.expr.curves) as Array<[ExpressionDimension, Array<{ sec: number; value: number }>]>) {
            curves[dim] = pts.map((p) => ({ tick: Math.max(1, tickOf(p.sec) - tick), value: p.value }));
          }
          const m = mpeNoteMessages({ tick, durationTicks, expr: { ...n.expr.e, curves } }, member, 1, memberRange.get(member));
          memberRange.set(member, m.range);
          bendRanges.push(...m.ranges);
          mpeBends.push(...m.bends);
          controls.push(...m.controls);
          pressures.push(...m.pressures);
        }
        notes.push({
          tick,
          note: n.note,
          velocity: Math.max(1, Math.min(127, Math.round(n.velocity))),
          durationTicks,
          channel,
          ...(n.articulation ? { articulation: n.articulation } : {}),
          ...(member === undefined && channel !== home ? { homeChannel: home } : {}),
        });
      }
      for (const c of e.controls) {
        const tick = tickOf(Math.max(startSec, c.sec));
        for (const channel of trackChannels) controls.push({ tick, channel, controller: c.controller, value: c.value });
      }
      for (const w of e.wheels) {
        // The lane's own channel, and each articulation channel of the lane, which bends with it.
        for (const channel of [channelOf(w.lane), ...arts.filter((a) => a.lane === w.lane).map((a) => artChannelOf(a.key)).filter((ch): ch is number => ch !== undefined)]) {
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
    }
    // The track's controller automation: its value at the file's start, then each change to the end of its last clip.
    const trackEnd = cutEnd(events.reduce((m, e) => Math.max(m, e.endSec), 0));
    for (const l of ccLanes) {
      if (l.trackId !== track.id) continue;
      const from = range ? Math.max(startSec, range.startSec) : startSec;
      const held = ccLaneValueAt(l.lane, from);
      for (const channel of trackChannels) controls.push({ tick: tickOf(from), channel, controller: l.controller, value: held });
      for (const e of ccLaneEvents(l.lane, from + 1e-6, trackEnd, held).events) {
        for (const channel of trackChannels) controls.push({ tick: tickOf(e.sec), channel, controller: l.controller, value: e.value });
      }
    }
    // Each articulation channel's preset at tick 0, with its bank select.
    for (const a of arts) {
      const channel = artChannelOf(a.key);
      if (channel !== undefined) programs.push({ tick: 0, channel, program: a.target.program, ...(a.target.bank > 0 ? { bank: a.target.bank } : {}) });
    }
    programs.sort((a, b) => a.tick - b.tick);
    // The fader and pan, on the General MIDI volume curve and around the centre.
    const scale = faderVolumeScale(track.volume);
    const panOffset = panControlOffset(track.pan);
    for (const c of controls) {
      if (c.controller === 7 && Math.abs(scale - 1) > 1e-9) c.value = clamp7(c.value * scale);
      if (c.controller === 10 && panOffset !== 0) c.value = clamp7(c.value + panOffset);
    }
    // From tick 0 each channel plays at the fader's volume and pan, unless a clip sets its own there:
    // a clip with none of its own, before a clip that has some, plays at the track's.
    const setAtZero = (channel: number, controller: number): boolean =>
      controls.some((c) => c.tick === 0 && c.channel === channel && c.controller === controller);
    for (const channel of trackChannels) {
      if (Math.abs(scale - 1) > 1e-9 && !setAtZero(channel, 7)) controls.push({ tick: 0, channel, controller: 7, value: clamp7(GM_DEFAULT_VOLUME * scale) });
      if (panOffset !== 0 && !setAtZero(channel, 10)) controls.push({ tick: 0, channel, controller: 10, value: clamp7(64 + panOffset) });
    }
    notes.sort((a, b) => a.tick - b.tick);
    controls.sort((a, b) => a.tick - b.tick);
    const bends = [...[...wheelOn.values()].flat(), ...mpeBends].sort((a, b) => a.tick - b.tick);
    bendRanges.sort((a, b) => a.tick - b.tick);
    pressures.sort((a, b) => a.tick - b.tick);
    programs.sort((a, b) => a.tick - b.tick);
    noteCount += notes.length;
    out.push({
      name: track.name,
      notes,
      ...(programs.length ? { programs } : {}),
      ...(controls.length ? { controls } : {}),
      ...(bends.length || bendRanges.length ? { bends, bendRanges } : {}),
      ...(pressures.length ? { pressures } : {}),
      // The MPE zone's configuration message, once, in the first track.
      ...(out.length === 0 && mpe.members.length ? { mpeZones: [mpeZoneEvent(mpe.members.length)] } : {}),
    });
  }

  const fileMap = sanitizeRollTempoMap(tempoMapFrom(map, startBeat), getTempoAtBeat(map, startBeat));
  const fileMeter = startBar ? meterMapFrom(meterMap, startBar.bar) : meterMap;
  // The timeline's markers inside the export, each at its second's tick; a blank label writes none.
  const markers = (source.markers ?? [])
    .filter((m) => isNum(m.t) && m.t >= startSec - 1e-9 && m.label.trim() && (!range || (m.t >= range.startSec - 1e-9 && m.t < range.endSec - 1e-9)))
    .map((m) => ({ tick: tickOf(m.t), text: m.label.trim() }))
    .sort((a, b) => a.tick - b.tick);
  const file: MidiFileData = {
    ppq,
    bpm: fileMap[0]?.bpm ?? bpm,
    tempos: tempoMapToMidiTempos(fileMap, ppq),
    ...(hasTempoChanges(fileMap) ? { dawTempoMap: tempoMapText(fileMap) } : {}),
    timeSignatures: meterMapToMidiEvents(fileMeter, ppq, 0),
    ...(markers.length ? { markers } : {}),
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
    ...(mpe.noRoom ? { mpeNoRoom: true } : {}),
    articulationFallback: [...articulationFallback],
  };
}
