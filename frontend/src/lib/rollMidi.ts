/**
 * rollMidi — the piano roll as a Standard MIDI File and back, pitch bend included.
 *
 * Export writes the notes as they sound (lane repeats written out) at the
 * roll's tempo and meter. A pitch wheel bends a whole channel, so each lane
 * with bend points plays on its own channel (laneChannels) with its wheel
 * messages and its range as RPN 0/0; every other lane shares one channel. With
 * no bend every note is on channel 0, the file the roll wrote before it had bends.
 *
 * Import gives each channel that bends (a wheel message off centre) its own
 * lane, the lowest MAX_BENT_LANES such channels, with the curve its messages
 * draw at the widest range they were sent at; the notes of every other channel
 * share one lane. Lanes take ids in the order of their lowest channel, so a
 * file this module wrote comes back with its lanes in the same order. With no
 * bend every note is in lane A, as before.
 *
 * TIMING: notes travel on TICKS, not on the 16th grid. An export writes each
 * note's own `tick`/`ticks` at the file's PPQ, which is the roll's own 960
 * (ROLL_PPQ), so every tick goes out as the roll holds it and a septuplet or a
 * quintuplet comes back on the tick it left. An import writes the file's
 * ticks back scaled to 960 and derives the step view from them — so a round
 * trip through a 960 PPQ file is exact and a 480 or 96 PPQ file (every file
 * the roll wrote before, and most other programs') scales rather than
 * snapping to the grid. Bends still speak in steps: a curve is drawn against
 * the grid, not against a note.
 *
 * LANES: a roll with more than lane A writes one track per lane, named
 * "Lane B", holding the lane's notes as they sound and, at tick 0, a
 * `theDAW:lane=` text with the lane itself: its id, name, loop, meter map and
 * tuplet ratio. An import that finds those texts gives each track's notes back
 * to its lane, keeping only a looping lane's first cycle (the rest are its
 * repeats), with the lane's bend read from its channel and cut to its cycle.
 * A roll with lane A alone writes the one "Piano Roll" track it always has, and
 * a file with no lane texts imports as described above.
 *
 * TEMPO: export writes every tempo of the roll's map (lib/rollTempo) as an
 * FF 51 at its tick. A ramp is written as a tempo every 32nd note, each the
 * tempo that makes its 32nd last exactly as long as the ramp's does, and a
 * fermata as its slowed tempo over the held beats and the tempo after it, so
 * any reader plays the notes at the seconds the roll does. The map itself
 * rides beside them in a `theDAW:tempomap=` text (tempoMapText), and import
 * takes it back, ramps and fermatas included, when the file's tempos are still
 * the ones it writes; a file edited elsewhere, or written by anything else,
 * comes in as its tempos, each a step at its tick and each tempo at the exact
 * microseconds its FF 51 holds (lib/midi tempoOfMicros).
 *
 * MARKERS: the roll's named markers (lib/rollMarkers) are written as FF 06
 * markers at their ticks, which every program reads as names, and beside them
 * in one `theDAW:markers=` text with each marker's kind (section or movement)
 * and origin. Import takes that text back when its places and names are still
 * the file's FF 06 markers; a file edited elsewhere, or written by anything
 * else, brings its FF 06 markers in as sections.
 *
 * PARTS: a roll of more than one part (state/pianoRollStore RollTrack) writes
 * one track per part, named after it, on the part's channel (lib/rollTracks
 * partFileChannels: its own, 10 for a percussion part, else the next free
 * channel but 10), with its program and bank at tick 0 and a `theDAW:part=`
 * text holding the part itself, so an import gets every part back with its
 * colour and registry instrument. With lanes past A each part writes one track
 * per lane, carrying both texts. A bent lane of a part plays on a channel of
 * its own while the file's sixteen channels last. A roll of one part writes
 * what it always wrote, plus its program when the part has one and its
 * `theDAW:part=` text, so an import gives the part back as it was (a part that
 * follows the picker stays one, rather than turning into the piano its track
 * name "Piano Roll" seems to name).
 *
 * CONTROLLERS: a part's controller changes (RollTrack `controls`: modulation,
 * volume, pan, expression, the sustain pedal) are written as B0 messages at
 * their ticks on every channel the part plays on, once per channel, so a bent
 * lane's notes take the pedal too.
 *
 * Import reads a file into parts (midiFileToRollParts): the parts a file this
 * module wrote names, else one part per track, or per channel when one track
 * holds several (a format 0 file), each with the track's name, its first
 * program and bank, its channel, the controller changes its channel carries
 * anywhere in the file (a setup track's volume and pan included) and the
 * registry instrument its name or program names (lib/orchestra). A part on
 * MIDI channel 10, or one whose bank select is General MIDI 2's rhythm bank
 * (120), is percussion. The names the roll gives its own tracks ("Piano
 * Roll", "Lane B") name no instrument.
 *
 * No Vite-only imports, so node tests load it.
 */
import {
  BEND_CENTER,
  DEFAULT_BEND_RANGE,
  MAX_BEND_RANGE,
  MAX_BENT_LANES,
  bendImportTolerance,
  bendRawToValue,
  bendStairAllowance,
  bendValueToRaw,
  bendWheelEvents,
  bentLanes,
  cutBend,
  laneChannels,
  playedRollBends,
  playingLane,
  sanitizeBends,
  wheelEventsToBendPoints,
  type BendPoint,
  type LaneBend,
} from './pitchBend';
import { meterMapToMidiEvents, midiEventsToMeterMap, unrollLanes, type MeterSegment, type PolyLane } from './meterMap';
import {
  midiStartTempo,
  tempoMicros,
  tempoOfMicros,
  type MidiBend,
  type MidiBendRange,
  type MidiControl,
  type MidiFileData,
  type MidiNote,
  type MidiProgram,
  type MidiTempo,
  type MidiTrack,
} from './midi';
import { GM_NAMES } from './gmInstruments';
import { PPQ as NOTE_PPQ } from './noteClock';
import { guessInstrument, instrumentForProgram } from './orchestra';
import {
  PERCUSSION_PART_CHANNEL,
  cleanPartBank,
  cleanPartBankLsb,
  cleanPartChannel,
  cleanPartColor,
  cleanPartControls,
  cleanPartName,
  cleanPartProgram,
  isPercussionPart,
  partColorAt,
  partFileChannels,
} from './rollTracks';
import { hasTempoChanges, sanitizeRollTempoMap, startTempoOf } from './rollTempo';
import { sanitizeRollMarkers, type RollMarker, type RollMarkerInput } from './rollMarkers';
import { beatToTime, normalizeTempoMap, type TempoEvent } from './tempoMap';
import {
  DEFAULT_LANES,
  MIN_NOTE_TICKS,
  PPQ,
  laneName,
  noteTick,
  noteTicks,
  sanitizeLanes,
  ticksPerStep,
  type PianoNote,
  type RollControl,
  type RollMeter,
  type RollTrack,
} from '../state/pianoRollStore';

/**
 * The resolution a roll export writes: the roll's own PPQ (960, lib/noteClock),
 * so each note leaves on the tick it has and an import reads the same tick
 * back. Files the roll wrote at 480 before, and files at any other resolution,
 * still import: their ticks scale to 960.
 */
export const ROLL_PPQ = NOTE_PPQ;

/** The roll state an export reads. */
export interface RollMidiSource {
  notes: readonly PianoNote[];
  lanes: readonly PolyLane[];
  totalSteps: number;
  bpm: number;
  meterMap: readonly MeterSegment[];
  pickupSteps: number;
  bends: readonly LaneBend[];
  /** The roll's tempo map; left out, the roll holds `bpm`. */
  tempoMap?: readonly TempoEvent[];
  /**
   * Every part with its real notes (pianoRollStore rollTracksOf). Left out, or
   * one part, the roll writes `notes` as it always has; more than one writes a
   * track per part and `notes` is not read.
   */
  tracks?: readonly RollTrack[];
  /**
   * The part whose notes are `notes` (the store's active part, whose entry in
   * `tracks` may be stale). Given, that part's notes are read from `notes`, so
   * the store's state can be passed as it is.
   */
  activeTrackId?: string;
  /** The program each part sounds when it has none of its own (its linked clip's, the picker's), by part id. */
  voices?: ReadonlyMap<string, { program?: number }>;
  /** The roll's named markers, by tick on the roll's clock; left out, none. */
  markers?: readonly RollMarker[];
}

/** What an import hands to the roll's importNotes. */
export interface RollMidiImport {
  notes: PianoNote[];
  /** The file's first tempo: its map's beat-0 tempo. */
  bpm: number;
  meter: RollMeter;
  bends: LaneBend[];
  /** The file's tempo map (sanitized, starting at `bpm`). */
  tempoMap: TempoEvent[];
  /** The file's markers on the roll's clock (midiFileMarkers); none when it has none. */
  markers: RollMarker[];
}

/** The `theDAW:markers=` text of a roll's markers: each one's place (at the file's `ppq`), name, kind and origin. */
export const markersText = (markers: readonly RollMarker[], ppq: number): string =>
  JSON.stringify(markers.map((m) => ({
    tick: Math.round((m.tick * ppq) / PPQ),
    name: m.name,
    kind: m.kind,
    ...(m.origin ? { origin: m.origin } : {}),
  })));

/**
 * A file's markers on the roll's clock: the `theDAW:markers=` text's, with
 * their kinds and origins, while its places and names are still the file's
 * FF 06 markers; else every FF 06 marker as a section. Ticks scale from the
 * file's PPQ to the roll's.
 */
export function midiFileMarkers(data: Pick<MidiFileData, 'ppq' | 'markers' | 'dawMarkers'>): RollMarker[] {
  const ppq = data.ppq || ROLL_PPQ;
  const toModel = PPQ / ppq;
  const plain = data.markers ?? [];
  let own: RollMarkerInput[] | null = null;
  if (data.dawMarkers) {
    try {
      const raw = JSON.parse(data.dawMarkers) as unknown;
      if (Array.isArray(raw)) {
        const list = raw.filter((m): m is Record<string, unknown> => !!m && typeof m === 'object');
        // The text holds while the FF 06 markers are the ones it was written with: the same places and names, in order.
        const same = list.length === plain.length && list.every((m, i) => m.tick === plain[i].tick && m.name === plain[i].text);
        if (same) {
          own = list.map((m) => ({
            tick: typeof m.tick === 'number' ? m.tick * toModel : undefined,
            name: typeof m.name === 'string' ? m.name : undefined,
            kind: m.kind === 'movement' ? 'movement' : 'section',
            ...(m.origin === 'form' ? { origin: 'form' as const } : {}),
          }));
        }
      }
    } catch {
      /* not a text this module wrote: the FF 06 markers stand alone */
    }
  }
  return sanitizeRollMarkers(own ?? plain.map((m) => ({ tick: m.tick * toModel, name: m.text, kind: 'section' as const })));
}

/** A ramp is written to a file as one tempo per this many quarter notes: a 32nd. */
export const RAMP_WRITE_BEATS = 1 / 8;

/**
 * The FF 51 tempos that play `map` at `ppq`: one per tempo change, one per
 * RAMP_WRITE_BEATS along a ramp (the tempo that gives that span its exact
 * seconds), and a fermata's slowed tempo and the tempo after it. A tempo that
 * repeats the one before it, in microseconds, is left out; two at one tick keep
 * the later one.
 */
export function tempoMapToMidiTempos(map: readonly TempoEvent[], ppq: number): MidiTempo[] {
  const points = normalizeTempoMap(map);
  const out: MidiTempo[] = [];
  const push = (beat: number, bpm: number) => {
    const tick = Math.max(0, Math.round(beat * ppq));
    const last = out[out.length - 1];
    if (last && last.tick === tick) out.pop();
    const before = out[out.length - 1];
    if (before && tempoMicros(before.bpm) === tempoMicros(bpm)) return;
    out.push({ tick, bpm });
  };
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const next = points[i + 1];
    if (!next || p.slope === 0) {
      push(p.beat, p.bpm);
      continue;
    }
    // Pieces on the file's 32nd grid from the ramp's start to the next point.
    let a = p.beat;
    while (a < next.beat - 1e-9) {
      const b = Math.min(next.beat, (Math.floor(a / RAMP_WRITE_BEATS + 1e-9) + 1) * RAMP_WRITE_BEATS);
      push(a, (60 * (b - a)) / (beatToTime(map, b) - beatToTime(map, a)));
      a = b;
    }
  }
  return out;
}

const fmtNum = (v: number): string => String(v);

/**
 * The `theDAW:tempomap=` text of a map: `beat:bpm` per tempo event, `:l` after
 * one that ramps, `f:beat:beats:stretch` per fermata, joined by `;`. Every
 * number is written in full, so the map comes back exactly.
 */
export function tempoMapText(map: readonly TempoEvent[]): string {
  return map
    .map((e) => (e.fermata
      ? `f:${fmtNum(e.beat)}:${fmtNum(e.fermata.beats)}:${fmtNum(e.fermata.stretch)}`
      : `${fmtNum(e.beat)}:${fmtNum(e.bpm)}${e.curve === 'linear' ? ':l' : ''}`))
    .join(';');
}

/** The map a `theDAW:tempomap=` text holds, or null when any part of it does not read. */
export function parseTempoMapText(text: string): TempoEvent[] | null {
  const out: TempoEvent[] = [];
  for (const part of text.split(';')) {
    const f = part.split(':');
    if (f[0] === 'f' && f.length === 4) {
      const [beat, beats, stretch] = f.slice(1).map(Number);
      if (![beat, beats, stretch].every(Number.isFinite)) return null;
      out.push({ beat, bpm: 0, fermata: { beats, stretch } });
    } else if (f.length === 2 || (f.length === 3 && f[2] === 'l')) {
      const beat = Number(f[0]);
      const bpm = Number(f[1]);
      if (!Number.isFinite(beat) || !Number.isFinite(bpm) || bpm <= 0) return null;
      out.push({ beat, bpm, curve: f.length === 3 ? 'linear' : 'step' });
    } else return null;
  }
  return out.length ? out : null;
}

/** True when two tempo lists put the same microseconds at the same ticks. */
const sameTempos = (a: readonly MidiTempo[], b: readonly MidiTempo[]): boolean =>
  a.length === b.length && a.every((t, i) => t.tick === b[i].tick && tempoMicros(t.bpm) === tempoMicros(b[i].bpm));

/**
 * A parsed file's tempo map: the `theDAW:tempomap=` map when the file's tempos
 * are still exactly the ones it writes, else each tempo as a step at its tick,
 * with the tempo the file plays at from tick 0 at beat 0 (lib/midi
 * midiStartTempo: its tick-0 tempo, else 120 until its first tempo, as SMF
 * has it).
 */
export function midiFileTempoMap(data: MidiFileData): TempoEvent[] {
  const ppq = data.ppq || ROLL_PPQ;
  const start = midiStartTempo(data);
  const tempos = data.tempos ?? [];
  if (data.dawTempoMap) {
    const own = parseTempoMapText(data.dawTempoMap);
    if (own) {
      const map = sanitizeRollTempoMap(own, startTempoOf(own as TempoEvent[]) ?? start);
      // The file's own tempos, first tempo written at tick 0 as the encoder does.
      const written = tempos.some((t) => t.tick === 0) ? tempos : [{ tick: 0, bpm: start }, ...tempos];
      if (sameTempos(tempoMapToMidiTempos(map, ppq), written)) return map;
    }
  }
  return sanitizeRollTempoMap(
    [{ beat: 0, bpm: start }, ...tempos.map((t) => ({ beat: t.tick / ppq, bpm: t.bpm }))],
    start,
  );
}

/** The `theDAW:lane=` text of a lane: the lane as JSON, so an import gets its loop, meter map and ratio back. */
export const laneMetaText = (lane: PolyLane): string => JSON.stringify(sanitizeLanes([lane]).find((l) => l.id === lane.id) ?? lane);

/** The lane a `theDAW:lane=` text names, or null for text that is not one. */
export function parseLaneMeta(text: string | undefined): PolyLane | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Partial<PolyLane>;
    if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.id) || (raw.id as number) < 0) return null;
    return sanitizeLanes([raw as PolyLane]).find((l) => l.id === raw.id) ?? null;
  } catch {
    return null;
  }
}

/** The notes of one part (or of the roll) as a file writes them: each note on its lane's channel, and each lane's wheel and range on its channel. */
interface WrittenNotes {
  notes: MidiNote[];
  /** Each note's lane (as it plays). */
  laneOfNote: number[];
  /** The wheel and range of each lane whose channel is its own, by lane. */
  laneBends: Map<number, { bends: MidiBend[]; bendRanges: MidiBendRange[] }>;
}

/**
 * `own` notes written for a file at `ppq`: lane repeats written out, each note
 * on `channels.get(lane)`, and the wheel of each lane in `wheelLanes` on its
 * channel. Straight from each note's ticks: an unrolled repeat is re-ticked
 * from the step unrollLanes moved it to, which is exact because a lane cycle
 * is a whole number of steps. Nothing is quantised on the way out.
 */
function writeNotes(
  s: RollMidiSource,
  own: readonly PianoNote[],
  ppq: number,
  channels: ReadonlyMap<number, number>,
  wheelLanes: ReadonlySet<number>,
): WrittenNotes {
  const stepTicks = ppq / 4;
  // The note model's ticks rescaled to the file's resolution. At ppq === PPQ
  // this is 1 and every note's tick goes out exactly as it is stored.
  const toFile = ppq / PPQ;
  const played = unrollLanes(own, s.lanes, s.totalSteps);
  // Nothing sounds past the roll's end or its last note's end, so no wheel message is written past it.
  const soundEnd = played.reduce((m, n) => Math.max(m, n.step + n.length), s.totalSteps);
  const laneOfNote = played.map((n) => playingLane(n.lane, s.lanes));
  const notes: MidiNote[] = played.map((n, i) => ({
    tick: Math.round(noteTick(n) * toFile),
    note: n.note,
    velocity: Math.max(1, Math.min(127, n.velocity)),
    durationTicks: Math.max(1, Math.round(noteTicks(n) * toFile)),
    channel: channels.get(laneOfNote[i]) ?? 0,
  }));
  const laneBends = new Map<number, { bends: MidiBend[]; bendRanges: MidiBendRange[] }>();
  for (const [lane, curve] of playedRollBends(s.bends, s.lanes, s.totalSteps)) {
    if (!wheelLanes.has(lane)) continue;
    const channel = channels.get(lane) ?? 0;
    const end = Math.min(curve.points[curve.points.length - 1].step, soundEnd);
    const bends: MidiBend[] = [];
    // Ramp messages on whole ticks with the curve's value there, so an import reads the curve back, not the rounding.
    for (const e of bendWheelEvents(curve.points, 0, end, true, curve.range, 1 / stepTicks)) {
      const tick = Math.round(e.step * stepTicks);
      // Messages that land on one tick: the last one is the one in force, so it is the one written.
      const last = bends[bends.length - 1];
      if (last && last.tick === tick) bends.pop();
      bends.push({ tick, channel, value: e.raw });
    }
    laneBends.set(lane, { bends, bendRanges: [{ tick: 0, channel, semitones: curve.range }] });
  }
  return { notes, laneOfNote, laneBends };
}

/** The conductor fields of a roll's file: its tempo, every tempo of its map, and its time signatures. */
function rollFileHeader(s: RollMidiSource, ppq: number): Omit<MidiFileData, 'tracks'> {
  const tempoMap = sanitizeRollTempoMap(s.tempoMap ?? [], s.bpm);
  return {
    ppq,
    bpm: s.bpm,
    // Every tempo change, ramp and fermata, as tempos any reader plays; the map itself beside them.
    // The map is written for one tempo too when FF 51 cannot hold it: FF 51
    // reads back at its exact microseconds (97.3 is 616650 us, which reads as
    // 97.2999...), and the text brings the roll's typed tempo back as it was.
    // A tempo FF 51 holds exactly (100 is 600000 us) writes the file as before.
    tempos: tempoMapToMidiTempos(tempoMap, ppq),
    ...(hasTempoChanges(tempoMap) || !tempoMap.every((e) => e.fermata || tempoOfMicros(tempoMicros(e.bpm)) === e.bpm)
      ? { dawTempoMap: tempoMapText(tempoMap) }
      : {}),
    // One FF 58 per meter change, a partial bar at tick 0 for a pickup.
    timeSignatures: meterMapToMidiEvents(s.meterMap, ppq, s.pickupSteps),
    // Each marker as FF 06 at its tick, and every marker with its kind in the markers text.
    ...(s.markers?.length
      ? {
          markers: s.markers.map((m) => ({ tick: Math.round((m.tick * ppq) / PPQ), text: m.name })),
          dawMarkers: markersText(s.markers, ppq),
        }
      : {}),
  };
}

/** The tracks of written notes: one named `name` for a roll with lane A alone, one per lane with its `theDAW:lane=` text otherwise. */
function laneTracks(s: RollMidiSource, w: WrittenNotes, name: string, extra: (lane: PolyLane | null) => Partial<MidiTrack>): MidiTrack[] {
  if (s.lanes.length <= 1) {
    const one = [...w.laneBends.values()];
    const bends = one.flatMap((b) => b.bends).sort((a, b) => a.tick - b.tick);
    const bendRanges = one.flatMap((b) => b.bendRanges);
    return [{ name, notes: w.notes, ...(bends.length ? { bends, bendRanges } : {}), ...extra(null) }];
  }
  return [...s.lanes].sort((a, b) => a.id - b.id).map((lane) => {
    const own = w.laneBends.get(lane.id);
    return {
      name: name === 'Piano Roll' ? `Lane ${lane.name}` : `${name} · Lane ${lane.name}`,
      notes: w.notes.filter((_, i) => w.laneOfNote[i] === lane.id),
      ...(own?.bends.length ? { bends: own.bends, bendRanges: own.bendRanges } : {}),
      laneMeta: laneMetaText(lane),
      ...extra(lane),
    };
  });
}

/**
 * Program changes at tick 0 on each of `channels` for a part sounding
 * `program` in `bank` (no bank select for bank 0), with its bank select LSB
 * (CC 32) when it has one.
 */
const partPrograms = (channels: Iterable<number>, program: number | undefined, bank: number, bankLsb: number | undefined): MidiProgram[] =>
  program === undefined
    ? []
    : [...new Set(channels)]
      .sort((a, b) => a - b)
      .map((channel) => ({ tick: 0, channel, program, ...(bank > 0 ? { bank } : {}), ...(bankLsb !== undefined ? { bankLsb } : {}) }));

/**
 * A part's controller changes as a file at `ppq` writes them: every change on
 * each of `channels`, sorted by tick (per tick, channel by channel in the
 * part's own order). The roll's ticks are rescaled from PPQ, which at the
 * roll's own 960 leaves them as they are.
 */
export function partControlEvents(controls: readonly RollControl[] | undefined, channels: Iterable<number>, ppq: number): MidiControl[] {
  if (!controls?.length) return [];
  const toFile = ppq / PPQ;
  const out: MidiControl[] = [];
  for (const channel of [...new Set(channels)].sort((a, b) => a - b)) {
    for (const c of controls) out.push({ tick: Math.max(0, Math.round(c.tick * toFile)), channel, controller: c.controller, value: c.value });
  }
  // Stable, so the changes of one tick keep their channel and part order.
  return out.sort((a, b) => a.tick - b.tick);
}

/**
 * The `extra` of laneTracks for a part: its programs on the channels each track
 * plays, and its controller changes once per channel, in the first track that
 * plays on it, so lanes that share a channel do not write a change twice.
 */
function partTrackExtra(
  channels: ReadonlyMap<number, number>,
  program: number | undefined,
  bank: number,
  bankLsb: number | undefined,
  controls: readonly RollControl[] | undefined,
  ppq: number,
  base: Partial<MidiTrack> = {},
): (lane: PolyLane | null) => Partial<MidiTrack> {
  const written = new Set<number>();
  return (lane) => {
    const used = lane === null ? [...channels.values()] : [channels.get(lane.id) as number];
    const programs = partPrograms(used, program, bank, bankLsb);
    const fresh = [...new Set(used)].filter((ch) => !written.has(ch));
    for (const ch of fresh) written.add(ch);
    const ctl = partControlEvents(controls, fresh, ppq);
    return { ...base, ...(programs.length ? { programs } : {}), ...(ctl.length ? { controls: ctl } : {}) };
  };
}

/** The `theDAW:part=` text of a part: its settings as JSON, so an import gets the part back. */
export const partMetaText = (t: RollTrack): string =>
  JSON.stringify({
    id: t.id,
    name: t.name,
    program: t.program,
    bank: t.bank,
    ...(t.bankLsb !== undefined ? { bankLsb: t.bankLsb } : {}),
    channel: t.channel,
    color: t.color,
    mute: t.mute,
    solo: t.solo,
    ...(t.instrumentId ? { instrumentId: t.instrumentId } : {}),
  });

/** The part a `theDAW:part=` text names, or null for text that is not one. */
export function parsePartMeta(text: string | undefined): (Partial<RollTrack> & { id: string }) | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
    const bankLsb = cleanPartBankLsb(raw.bankLsb);
    return {
      id: raw.id,
      name: cleanPartName(raw.name, 'Part'),
      program: cleanPartProgram(raw.program),
      bank: cleanPartBank(raw.bank),
      ...(bankLsb !== undefined ? { bankLsb } : {}),
      channel: cleanPartChannel(raw.channel),
      color: cleanPartColor(raw.color, partColorAt(0)),
      mute: raw.mute === true,
      solo: raw.solo === true,
      ...(typeof raw.instrumentId === 'string' && raw.instrumentId ? { instrumentId: raw.instrumentId } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The roll as MIDI at its own tempo and time signatures, with each bent lane's
 * wheel and range on its channel: one track for a roll with lane A alone, and
 * one track per lane, each with its `theDAW:lane=` text, for a roll with more.
 * A roll of several parts writes each part's tracks on its own channel with its
 * program (rollPartsToMidiFile).
 */
export function rollToMidiFile(s: RollMidiSource, ppq = ROLL_PPQ): MidiFileData {
  const parts = s.tracks && s.activeTrackId !== undefined
    ? s.tracks.map((t) => (t.id === s.activeTrackId ? { ...t, notes: [...s.notes] } : t))
    : s.tracks;
  if (parts && parts.length > 1) return rollPartsToMidiFile(s, parts, ppq);
  const part = parts?.[0];
  const notes = part ? part.notes : s.notes;
  const header = rollFileHeader(s, ppq);
  // The part itself rides beside its notes, so an import gets it back exactly.
  const meta = part ? { partMeta: partMetaText(part) } : {};
  // A percussion part is on channel 10, where its program is the kit.
  if (part && isPercussionPart(part)) {
    const drums = new Map(s.lanes.map((l) => [l.id, 9]));
    const w = writeNotes(s, notes, ppq, drums, new Set());
    return { ...header, tracks: laneTracks(s, w, 'Piano Roll', partTrackExtra(drums, part.program ?? undefined, 0, undefined, part.controls, ppq, meta)) };
  }
  // Any other roll of one part writes the channels it always did.
  const channels = laneChannels(s.lanes, s.bends);
  const w = writeNotes(s, notes, ppq, channels, bentLanes(s.lanes, s.bends));
  // A part with a program of its own writes it; a roll that follows the picker writes none, as before parts.
  const program = part && part.program !== null ? part.program : undefined;
  return { ...header, tracks: laneTracks(s, w, 'Piano Roll', partTrackExtra(channels, program, part?.bank ?? 0, part?.bankLsb, part?.controls, ppq, meta)) };
}

/** Zero-based file channels a bent lane of a part may take once every part has its own: every channel but 9. */
const FILE_CHANNELS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);

/**
 * A roll of several parts as MIDI: each part's tracks named after it on its
 * own channel (lib/rollTracks partFileChannels), with its program and bank at
 * tick 0 and its `theDAW:part=` text. A bent lane of a melodic part with notes
 * in it takes a channel no part has, while one is free, and writes its wheel
 * there; with none free its notes stay on the part's channel, unbent.
 */
export function rollPartsToMidiFile(s: RollMidiSource, parts: readonly RollTrack[], ppq = ROLL_PPQ): MidiFileData {
  const header = rollFileHeader(s, ppq);
  const { channels: base } = partFileChannels(parts);
  const taken = new Set(base.values());
  const free = FILE_CHANNELS.filter((ch) => !taken.has(ch));
  const bent = [...bentLanes(s.lanes, s.bends)].sort((a, b) => a - b);
  const tracks: MidiTrack[] = [];
  for (const part of parts) {
    const ch = base.get(part.id) as number;
    const channels = new Map<number, number>(s.lanes.map((l) => [l.id, ch]));
    const wheelLanes = new Set<number>();
    if (!isPercussionPart(part)) {
      for (const lane of bent) {
        if (!free.length || !part.notes.some((n) => playingLane(n.lane, s.lanes) === lane)) continue;
        channels.set(lane, free.shift() as number);
        wheelLanes.add(lane);
      }
    }
    const w = writeNotes(s, part.notes, ppq, channels, wheelLanes);
    const program = part.program ?? s.voices?.get(part.id)?.program;
    const percussion = isPercussionPart(part);
    const extra = partTrackExtra(channels, program, percussion ? 0 : part.bank, percussion ? undefined : part.bankLsb, part.controls, ppq, { partMeta: partMetaText(part) });
    tracks.push(...laneTracks(s, w, part.name, extra));
  }
  return { ...header, tracks };
}

/** Every note the file carries, across all its tracks: what an export reports it wrote. */
export const midiFileNoteCount = (file: MidiFileData): number => file.tracks.reduce((sum, t) => sum + t.notes.length, 0);

/** The range in force on a channel at `tick` (`ranges` sorted by tick): the last range set at or before it, else the channel's first range, else 2. */
const rangeAt = (ranges: readonly MidiBendRange[], tick: number): number => {
  if (!ranges.length) return DEFAULT_BEND_RANGE;
  let range = ranges[0].semitones;
  for (const r of ranges) {
    if (r.tick > tick) break;
    range = r.semitones;
  }
  return range;
};

/**
 * A channel's wheel messages (sorted by tick) as a lane's range and curve. The
 * lane takes the widest range an off-centre message was sent at (at most 48),
 * and a message sent at a narrower range is scaled into it, so a range change
 * partway through the file keeps every bend at its pitch.
 */
const channelBend = (
  messages: readonly MidiBend[],
  ranges: readonly MidiBendRange[],
  stepTicks: number,
  idPrefix: string,
): { range: number; points: BendPoint[] } => {
  const sentAt = messages.map((b) => rangeAt(ranges, b.tick));
  const range = Math.min(MAX_BEND_RANGE, messages.reduce((m, b, i) => (b.value !== BEND_CENTER ? Math.max(m, sentAt[i]) : m), 0));
  const events = messages.map((b, i) => ({
    step: b.tick / stepTicks,
    raw: sentAt[i] === range || !(range > 0) ? b.value : bendValueToRaw((bendRawToValue(b.value) * sentAt[i]) / range),
  }));
  return { range, points: wheelEventsToBendPoints(events, idPrefix, bendImportTolerance(range), bendStairAllowance(range)) };
};

/**
 * A file whose tracks carry `theDAW:lane=` texts, as the roll's notes, lanes
 * and bends: each track's notes in its lane (a track without a lane text goes
 * to lane A), a looping lane's notes only in its first cycle, and each bent
 * lane's curve from its notes' channel, cut to its cycle when it loops.
 */
function laneTracksToRoll(
  data: MidiFileData, ppq: number, idPrefix: string, wheel: Map<number, MidiBend[]>, ranges: Map<number, MidiBendRange[]>,
  origins?: Map<string, NoteOrigin>,
): { notes: PianoNote[]; lanes: PolyLane[]; bends: LaneBend[] } {
  const stepTicks = ppq / 4;
  const toModel = PPQ / ppq;
  const perStep = ticksPerStep();
  const metas = data.tracks.map((t) => parseLaneMeta(t.laneMeta));
  const lanes = sanitizeLanes(metas.filter((l): l is PolyLane => l !== null));
  const stamp = Math.random().toString(36).slice(2);
  const notes: PianoNote[] = [];
  const bends: LaneBend[] = [];
  let i = 0;
  data.tracks.forEach((t, k) => {
    const lane = metas[k] ? lanes.find((l) => l.id === metas[k]!.id) ?? lanes[0] : lanes[0];
    const cycleTicks = lane.cycleSteps ? lane.cycleSteps * perStep : Infinity;
    for (const n of t.notes) {
      const tick = Math.max(0, Math.round(n.tick * toModel));
      // A looping lane's notes past its first cycle are its repeats.
      if (tick >= cycleTicks - 0.5) continue;
      const ticks = Math.max(MIN_NOTE_TICKS, Math.round(n.durationTicks * toModel));
      const id = `${idPrefix}-${stamp}-${i++}`;
      origins?.set(id, { track: k, channel: n.channel });
      notes.push({
        id,
        note: n.note,
        step: tick / perStep,
        length: ticks / perStep,
        velocity: n.velocity,
        tick,
        ticks,
        ...(lane.id > 0 ? { lane: lane.id } : {}),
      });
    }
    const channel = t.bends?.[0]?.channel ?? t.notes[0]?.channel;
    const messages = channel === undefined ? [] : wheel.get(channel) ?? [];
    if (metas[k] && messages.some((b) => b.value !== BEND_CENTER) && !bends.some((b) => b.lane === lane.id)) {
      const curve = channelBend(messages, ranges.get(channel as number) ?? [], stepTicks, `bp${lane.id}`);
      bends.push({ lane: lane.id, range: curve.range, points: lane.cycleSteps ? cutBend(curve.points, lane.cycleSteps) : curve.points });
    }
  });
  notes.sort((a, b) => a.step - b.step);
  return { notes, lanes, bends: sanitizeBends(bends) };
}

/** Where an imported note came from: its track in the file and its channel (0-15). */
interface NoteOrigin {
  track: number;
  channel: number;
}

/** A parsed file as the roll's notes, meter, lanes and bends. */
export function midiFileToRoll(data: MidiFileData, idPrefix = 'imp'): RollMidiImport {
  return readMidiFile(data, idPrefix);
}

/** midiFileToRoll, recording each note's track and channel in `origins` when given. */
function readMidiFile(data: MidiFileData, idPrefix: string, origins?: Map<string, NoteOrigin>): RollMidiImport {
  const ppq = data.ppq || ROLL_PPQ;
  const stepTicks = ppq / 4;
  const { map, pickupSteps } = midiEventsToMeterMap(data.timeSignatures ?? [], ppq);

  // A channel belongs to the file, not to a track, so its messages merge across tracks.
  const wheel = new Map<number, MidiBend[]>();
  const ranges = new Map<number, MidiBendRange[]>();
  for (const t of data.tracks) {
    for (const b of t.bends ?? []) wheel.set(b.channel, [...(wheel.get(b.channel) ?? []), b]);
    for (const r of t.bendRanges ?? []) ranges.set(r.channel, [...(ranges.get(r.channel) ?? []), r]);
  }
  for (const list of wheel.values()) list.sort((a, b) => a.tick - b.tick);
  for (const list of ranges.values()) list.sort((a, b) => a.tick - b.tick);

  // The file's tempo map, ramps and fermatas included when the roll wrote it.
  const tempoMap = midiFileTempoMap(data);
  const bpm = startTempoOf(tempoMap) ?? data.bpm;
  const markers = midiFileMarkers(data);

  // A file the roll wrote with its lanes gives every lane back.
  if (data.tracks.some((t) => parseLaneMeta(t.laneMeta))) {
    const own = laneTracksToRoll(data, ppq, idPrefix, wheel, ranges, origins);
    return { notes: own.notes, bpm, meter: { meterMap: map, pickupSteps, lanes: own.lanes }, bends: own.bends, tempoMap, markers };
  }

  const raw = data.tracks.flatMap((t) => t.notes);
  const rawTrack = data.tracks.flatMap((t, k) => t.notes.map(() => k));
  const noteChannels = [...new Set(raw.map((n) => n.channel))];
  // A channel whose wheel leaves the centre bends, the lowest MAX_BENT_LANES of them; the rest play unbent in the shared lane.
  const bent = noteChannels
    .filter((ch) => (wheel.get(ch) ?? []).some((b) => b.value !== BEND_CENTER))
    .sort((a, b) => a - b)
    .slice(0, MAX_BENT_LANES);
  const plain = noteChannels.filter((ch) => !bent.includes(ch));
  const groups = [
    ...bent.map((ch) => ({ first: ch, channels: [ch], bent: true })),
    ...(plain.length ? [{ first: Math.min(...plain), channels: plain, bent: false }] : []),
  ].sort((a, b) => a.first - b.first);
  const laneOf = new Map<number, number>();
  groups.forEach((g, id) => g.channels.forEach((ch) => laneOf.set(ch, id)));

  const stamp = Math.random().toString(36).slice(2);
  // The file's ticks rescaled to the model's PPQ (960): a 480 file doubles, a 96
  // file is x10, a 960 file comes through untouched. `step`/`length` are then
  // derived from those ticks, so an off-grid note keeps where it really was
  // instead of being snapped to the nearest 16th on the way in.
  const toModel = PPQ / ppq;
  const perStep = ticksPerStep();
  const notes: PianoNote[] = raw
    .map((n, i) => {
      const lane = laneOf.get(n.channel) ?? 0;
      const tick = Math.max(0, Math.round(n.tick * toModel));
      const ticks = Math.max(MIN_NOTE_TICKS, Math.round(n.durationTicks * toModel));
      const id = `${idPrefix}-${stamp}-${i}`;
      origins?.set(id, { track: rawTrack[i], channel: n.channel });
      return {
        id,
        note: n.note,
        step: tick / perStep,
        length: ticks / perStep,
        velocity: n.velocity,
        tick,
        ticks,
        ...(lane > 0 ? { lane } : {}),
      };
    })
    .sort((a, b) => a.step - b.step);

  const lanes = bent.length ? sanitizeLanes(groups.map((_, id) => ({ id, name: laneName(id), cycleSteps: null }))) : [...DEFAULT_LANES];
  const bends = sanitizeBends(
    groups.flatMap((g, id) =>
      g.bent ? [{ lane: id, ...channelBend(wheel.get(g.first) ?? [], ranges.get(g.first) ?? [], stepTicks, `bp${id}`) }] : [],
    ),
  );
  return { notes, bpm, meter: { meterMap: map, pickupSteps, lanes }, bends, tempoMap, markers };
}

/** One part of an imported file: the part's fields and its notes. */
export interface RollMidiPart {
  track: Partial<RollTrack>;
  notes: PianoNote[];
}

/** What an import of a file into parts hands to the roll's importParts (or, for one part, importNotes). */
export type RollMidiPartsImport = Omit<RollMidiImport, 'notes'> & { parts: RollMidiPart[] };

/** The names the roll gives its own tracks when it writes no part names ("Piano Roll", "Lane B"): they name no instrument. */
const ROLL_TRACK_NAME = /^(?:Piano Roll|Lane [A-Z]+)$/;

/** A track's first program change on `channel`, else undefined. */
const firstProgram = (programs: readonly MidiProgram[] | undefined, channel: number): MidiProgram | undefined =>
  (programs ?? []).find((p) => p.channel === channel);

/**
 * Bank selects that name a drum set on any channel: General MIDI 2's rhythm
 * bank (120). A part a file puts on it is percussion, wherever its channel is.
 * XG's kits (126, 127) are not read as drums: GS gives bank 127 to its
 * MT-32 melodic map, so the number alone cannot tell a kit from a melody, and
 * a part on either keeps its channel (the parts column's Sound list makes it
 * a drum kit by hand).
 */
const DRUM_BANKS: ReadonlySet<number> = new Set([120]);

/** True when a program change's bank select names a drum set (DRUM_BANKS). */
export const isDrumBank = (bank: number | undefined): boolean => bank !== undefined && DRUM_BANKS.has(bank);

/** File controller changes as a part keeps them: on the roll's clock (ticks scaled from `ppq` to PPQ), cleaned. */
const controlsOnRollClock = (controls: readonly MidiControl[], ppq: number): RollControl[] | undefined => {
  const toModel = PPQ / (ppq || ROLL_PPQ);
  return cleanPartControls(controls.map((c) => ({ tick: Math.round(c.tick * toModel), controller: c.controller, value: c.value })));
};

/**
 * A parsed file as the roll's parts, with the document's meter, lanes, bends
 * and tempo map (read as midiFileToRoll reads them).
 *
 * A file this module wrote with parts gives each part back from its
 * `theDAW:part=` text, its lane tracks joined, with the controller changes
 * its tracks carry. Any other file gives one part per track that has notes,
 * or per channel of a track that holds several (a format 0 file), in file
 * order. Each takes the track's name (for a split track, the channel's GM
 * program, or the track's name and the channel), the first program and bank
 * its channel sets (in its track, else anywhere in the file), its channel,
 * and every controller change its channel carries in any track (a channel is
 * the file's, so a setup track's volume and pan reach it). Notes on MIDI
 * channel 10, or on a channel whose bank select names a drum set
 * (isDrumBank), make a percussion part. A part whose name names a registry
 * instrument (lib/orchestra guessInstrument) takes it when the file sets no
 * program or sets that instrument's program; otherwise the program names the
 * instrument (instrumentForProgram) when the registry has one for it.
 */
export function midiFileToRollParts(data: MidiFileData, idPrefix = 'imp'): RollMidiPartsImport {
  const origins = new Map<string, NoteOrigin>();
  const read = readMidiFile(data, idPrefix, origins);
  const ppq = data.ppq || ROLL_PPQ;
  const metas = data.tracks.map((t) => parsePartMeta(t.partMeta));
  const own = metas.some((m) => m !== null);
  // Every kept controller change by channel, across the file's tracks, in track order within a tick.
  const channelControls = new Map<number, MidiControl[]>();
  for (const t of data.tracks) {
    for (const c of t.controls ?? []) {
      const list = channelControls.get(c.channel);
      if (list) list.push(c);
      else channelControls.set(c.channel, [c]);
    }
  }
  for (const list of channelControls.values()) list.sort((a, b) => a.tick - b.tick);
  // Each track's note channels, so a track holding several is split by channel.
  const trackChannels = data.tracks.map((t) => [...new Set(t.notes.map((n) => n.channel))].sort((a, b) => a - b));
  const keyOf = (o: NoteOrigin): string => {
    const meta = metas[o.track];
    if (own) return meta ? `part:${meta.id}` : `track:${o.track}`;
    return trackChannels[o.track].length > 1 ? `track:${o.track}:${o.channel}` : `track:${o.track}`;
  };
  // The parts in file order: a meta part at its first track, a track, or a split track's channels in order.
  const order: Array<{ key: string; track: number; channel: number | null }> = [];
  const seen = new Set<string>();
  data.tracks.forEach((t, k) => {
    const meta = metas[k];
    if (own && meta) {
      const key = `part:${meta.id}`;
      if (!seen.has(key)) {
        seen.add(key);
        order.push({ key, track: k, channel: null });
      }
      return;
    }
    const chans = trackChannels[k];
    if (!chans.length) return;
    if (!own && chans.length > 1) {
      for (const ch of chans) order.push({ key: `track:${k}:${ch}`, track: k, channel: ch });
      return;
    }
    order.push({ key: `track:${k}`, track: k, channel: chans[0] });
  });
  const notesOf = new Map<string, PianoNote[]>(order.map((o) => [o.key, []]));
  for (const n of read.notes) {
    const o = origins.get(n.id);
    const list = (o ? notesOf.get(keyOf(o)) : undefined) ?? (order.length ? notesOf.get(order[0].key) : undefined);
    list?.push(n);
  }
  const parts: RollMidiPart[] = order.map((o, index) => {
    const notes = notesOf.get(o.key) ?? [];
    const meta = own ? metas[o.track] : null;
    if (meta) {
      // The part's own tracks: it wrote its changes on each channel it plays, so the copies fold into one.
      const mine = data.tracks.filter((_, k) => metas[k]?.id === meta.id).flatMap((t) => t.controls ?? []);
      const controls = controlsOnRollClock(mine.sort((a, b) => a.tick - b.tick), ppq);
      return { track: { ...meta, id: undefined, ...(controls ? { controls } : {}) }, notes };
    }
    const t = data.tracks[o.track];
    const channel = o.channel ?? 0;
    const change = firstProgram(t.programs, channel) ?? data.tracks.map((x) => firstProgram(x.programs, channel)).find((p) => p !== undefined);
    const percussion = channel === 9 || isDrumBank(change?.bank);
    const split = trackChannels[o.track].length > 1;
    const fileProgram = change?.program;
    const bank = percussion ? 0 : change?.bank ?? 0;
    // The bank select LSB (CC 32) the file sends with the program: XG and GS pick a voice's variations with it.
    const bankLsb = percussion ? undefined : cleanPartBankLsb(change?.bankLsb);
    const controls = controlsOnRollClock(channelControls.get(channel) ?? [], ppq);
    const name = !split
      ? t.name
      : percussion
        ? `${t.name} drums`
        : fileProgram !== undefined
          ? GM_NAMES[fileProgram]
          : `${t.name} channel ${channel + 1}`;
    // A track the roll named itself names no instrument; with a program the program decides anyway.
    const named = fileProgram === undefined && ROLL_TRACK_NAME.test(name.trim()) ? undefined : guessInstrument(name);
    const byName = named && named.percussion === percussion && (fileProgram === undefined || named.program === fileProgram) ? named : undefined;
    const byProgram = fileProgram !== undefined ? instrumentForProgram(fileProgram, bank, percussion) : undefined;
    const inst = byName ?? byProgram;
    const program = fileProgram ?? byName?.program ?? null;
    return {
      track: {
        name: cleanPartName(name, `Part ${index + 1}`),
        program,
        bank,
        ...(bankLsb !== undefined ? { bankLsb } : {}),
        channel: percussion ? PERCUSSION_PART_CHANNEL : channel + 1,
        color: partColorAt(index),
        ...(inst ? { instrumentId: inst.id } : {}),
        ...(controls ? { controls } : {}),
      },
      notes,
    };
  });
  return { bpm: read.bpm, meter: read.meter, bends: read.bends, tempoMap: read.tempoMap, markers: read.markers, parts };
}
