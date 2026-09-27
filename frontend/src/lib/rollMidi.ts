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
 * note's own `tick`/`ticks` rescaled from the model's PPQ (960) to the file's,
 * and an import writes the file's ticks back scaled to 960 and derives the
 * step view from them — so a round trip through a 960 PPQ file is exact and a
 * 480 or 96 PPQ file scales rather than snapping to the grid. Bends still speak
 * in steps: a curve is drawn against the grid, not against a note.
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
import type { MidiBend, MidiBendRange, MidiFileData, MidiNote } from './midi';
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
  type RollMeter,
} from '../state/pianoRollStore';

export const ROLL_PPQ = 480;

/** The roll state an export reads. */
export interface RollMidiSource {
  notes: readonly PianoNote[];
  lanes: readonly PolyLane[];
  totalSteps: number;
  bpm: number;
  meterMap: readonly MeterSegment[];
  pickupSteps: number;
  bends: readonly LaneBend[];
}

/** What an import hands to the roll's importNotes. */
export interface RollMidiImport {
  notes: PianoNote[];
  bpm: number;
  meter: RollMeter;
  bends: LaneBend[];
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

/**
 * The roll as MIDI at its own tempo and time signatures, with each bent lane's
 * wheel and range on its channel: one track for a roll with lane A alone, and
 * one track per lane, each with its `theDAW:lane=` text, for a roll with more.
 */
export function rollToMidiFile(s: RollMidiSource, ppq = ROLL_PPQ): MidiFileData {
  const stepTicks = ppq / 4;
  // The note model's ticks rescaled to the file's resolution. At ppq === PPQ
  // this is 1 and every note's tick goes out exactly as it is stored.
  const toFile = ppq / PPQ;
  const channels = laneChannels(s.lanes, s.bends);
  const played = unrollLanes(s.notes, s.lanes, s.totalSteps);
  // Nothing sounds past the roll's end or its last note's end, so no wheel message is written past it.
  const soundEnd = played.reduce((m, n) => Math.max(m, n.step + n.length), s.totalSteps);
  // Straight from each note's ticks — an unrolled repeat is re-ticked from the
  // step unrollLanes moved it to, which is exact because a lane cycle is a whole
  // number of steps. Nothing is quantised on the way out.
  const notes: MidiNote[] = played.map((n) => ({
    tick: Math.round(noteTick(n) * toFile),
    note: n.note,
    velocity: Math.max(1, Math.min(127, n.velocity)),
    durationTicks: Math.max(1, Math.round(noteTicks(n) * toFile)),
    channel: channels.get(playingLane(n.lane, s.lanes)) ?? 0,
  }));
  // Each bent lane's wheel and range, by lane.
  const laneBends = new Map<number, { bends: MidiBend[]; bendRanges: MidiBendRange[] }>();
  for (const [lane, curve] of playedRollBends(s.bends, s.lanes, s.totalSteps)) {
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
  const header = {
    ppq,
    bpm: s.bpm,
    tempos: [{ tick: 0, bpm: s.bpm }],
    // One FF 58 per meter change, a partial bar at tick 0 for a pickup.
    timeSignatures: meterMapToMidiEvents(s.meterMap, ppq, s.pickupSteps),
  };
  if (s.lanes.length <= 1) {
    const one = [...laneBends.values()];
    const bends = one.flatMap((b) => b.bends).sort((a, b) => a.tick - b.tick);
    const bendRanges = one.flatMap((b) => b.bendRanges);
    return { ...header, tracks: [{ name: 'Piano Roll', notes, ...(bends.length ? { bends, bendRanges } : {}) }] };
  }
  const laneOfNote = played.map((n) => playingLane(n.lane, s.lanes));
  const tracks = [...s.lanes].sort((a, b) => a.id - b.id).map((lane) => {
    const own = laneBends.get(lane.id);
    return {
      name: `Lane ${lane.name}`,
      notes: notes.filter((_, i) => laneOfNote[i] === lane.id),
      ...(own?.bends.length ? { bends: own.bends, bendRanges: own.bendRanges } : {}),
      laneMeta: laneMetaText(lane),
    };
  });
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
      notes.push({
        id: `${idPrefix}-${stamp}-${i++}`,
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

/** A parsed file as the roll's notes, meter, lanes and bends. */
export function midiFileToRoll(data: MidiFileData, idPrefix = 'imp'): RollMidiImport {
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

  // A file the roll wrote with its lanes gives every lane back.
  if (data.tracks.some((t) => parseLaneMeta(t.laneMeta))) {
    const own = laneTracksToRoll(data, ppq, idPrefix, wheel, ranges);
    return { notes: own.notes, bpm: data.bpm, meter: { meterMap: map, pickupSteps, lanes: own.lanes }, bends: own.bends };
  }

  const raw = data.tracks.flatMap((t) => t.notes);
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
      return {
        id: `${idPrefix}-${stamp}-${i}`,
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
  return { notes, bpm: data.bpm, meter: { meterMap: map, pickupSteps, lanes }, bends };
}
