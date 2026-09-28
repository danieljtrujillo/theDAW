/**
 * mpeMidi — MIDI Polyphonic Expression in and out of a MIDI file.
 *
 * READ (applyMpeImport, run by lib/midi parseMidi on every file): an MPE file
 * plays each note on a member channel of its own, so the channel's pressure
 * (D0), CC 74 and pitch wheel shape that note alone. The zone comes from its
 * MPE Configuration Message (RPN 6 on manager channel 0 or 15: members 1 up or
 * 14 down); a file without one is read as MPE when one track plays three or
 * more neighbouring channels, one note at a time each, all with per-channel
 * pressure, CC 74 or bend, and at least half of them with pressure or CC 74
 * (a wheel alone is any multi-channel file's bend). Each member note then takes its channel's values
 * where it starts and every change inside it as its own expression (the
 * roll's NoteExpression, lib/noteExpression; the bend at its member channel's
 * range, 48 semitones unless the channel sets one), and goes back to its part's channel:
 * the track's other notes' channel, else the zone's manager. The member
 * channels' pressure, CC 74, wheels and ranges leave the file's tracks, so an
 * import reads one part in one lane, not a part per member.
 *
 * WRITE (planMpeExport, mpeNoteMessages): both MIDI writers put the notes that
 * carry expression on the upper zone's member channels (14 down, never the
 * drum channel 9, at most five), rotated as EDIT's live MIDI rotates them
 * (lib/mpeRotation rotateMembers), declare the zone with an MPE Configuration
 * Message on channel 15, and set each member's range, wheel, CC 74 and
 * pressure to its note's just before it starts, then every curve point at its
 * tick. A file whose parts leave no member channel free writes those notes on
 * their part's channel, and says so.
 *
 * Pure, so node tests load it.
 */
import type { MidiBend, MidiBendRange, MidiControl, MidiNote, MidiPressure, MidiTrack } from './midi';
import type { NoteExpression } from '../state/pianoRollStore';
import { hasExpression, rotateMembers, maxOverlap } from './mpeRotation';
import { EXPRESSION_DIMENSIONS, sanitizeNoteExpression, type ExpressionDimension } from './noteExpression';
import { DEFAULT_BEND_RANGE } from './pitchBend';

/** An MPE member channel's pitch bend range when it sets none: the MPE specification's 48 semitones. */
export const MPE_MEMBER_BEND_RANGE = 48;
/** The upper zone's manager channel, which the writers declare their members on. */
export const MPE_EXPORT_MANAGER = 15;
/** The controllers a member channel keeps for its note's own: CC 74, and the RPN and data entry its bend range is set with. */
const NOTE_OWN_CONTROLLERS: ReadonlySet<number> = new Set([6, 38, 74, 98, 99, 100, 101]);

/**
 * A part's controllers on the member channel its expressive note plays on:
 * the value each holds where the note starts, at its tick, then each change
 * until the next note takes that member (`until`, MpeExportPlan `until`), so
 * the note plays and rings out in the part's pedal, volume, pan and
 * modulation as its other notes do, and a pedal the part lifts after the note
 * lifts there too. `part` is the part's own changes (one channel's, any
 * channel number) in tick order. A member channel is shared by every part's
 * expressive notes in turn, so it is set per note.
 */
export function memberPartControls(
  note: { tick: number },
  member: number,
  part: readonly { tick: number; controller: number; value: number }[],
  until = Infinity,
): MidiControl[] {
  const end = until;
  const held = new Map<number, number>();
  const inside: MidiControl[] = [];
  for (const c of part) {
    if (NOTE_OWN_CONTROLLERS.has(c.controller)) continue;
    if (c.tick <= note.tick) held.set(c.controller, c.value);
    else if (c.tick < end) inside.push({ tick: c.tick, channel: member, controller: c.controller, value: c.value });
    else break;
  }
  return [...[...held].map(([controller, value]) => ({ tick: note.tick, channel: member, controller, value })), ...inside];
}

/** The member channels the writers take, in order: 14 down to 10, clear of the drum channel. */
export const MPE_EXPORT_MEMBERS: readonly number[] = Object.freeze([14, 13, 12, 11, 10]);

const DRUM = 9;

/** The member channels a zone declares. */
export const zoneMembers = (manager: number, members: number): number[] => {
  const n = Math.max(0, Math.min(15, Math.round(members)));
  if (manager === 0) return Array.from({ length: n }, (_, i) => 1 + i);
  if (manager === 15) return Array.from({ length: n }, (_, i) => 14 - i);
  return [];
};

/** The member channels a file's MPE zone uses, and its manager (null for a zone read from its notes). */
function findZone(tracks: readonly MidiTrack[]): { members: Set<number>; manager: number | null; track: number | null } | null {
  const declared = tracks.flatMap((t) => t.mpeZones ?? []).filter((z) => z.channel === 0 || z.channel === 15);
  const last = declared.sort((a, b) => a.tick - b.tick).filter((z) => z.members > 0).pop();
  if (last) return { members: new Set(zoneMembers(last.channel, last.members)), manager: last.channel, track: null };
  // No configuration: a track playing three or more neighbouring channels, one note at a time on each, each shaped per channel.
  for (const [k, t] of tracks.entries()) {
    const byCh = new Map<number, MidiNote[]>();
    for (const n of t.notes) if (n.channel !== DRUM) byCh.set(n.channel, [...(byCh.get(n.channel) ?? []), n]);
    // Pressure or CC 74 on a channel is MPE's own; a wheel alone is any multi-channel file's bend.
    const pressed = (ch: number) =>
      tracks.some((x) => (x.pressures ?? []).some((p) => p.channel === ch) || (x.controls ?? []).some((c) => c.channel === ch && c.controller === 74));
    const shaped = (ch: number) => pressed(ch) || tracks.some((x) => (x.bends ?? []).some((b) => b.channel === ch));
    const mono = (ns: MidiNote[]) => maxOverlap(ns.map((n) => ({ start: n.tick, end: n.tick + n.durationTicks }))) <= 1;
    const cands = [...byCh.keys()].filter((ch) => mono(byCh.get(ch)!) && shaped(ch)).sort((a, b) => a - b);
    // The longest run of neighbouring channels.
    let best: number[] = [];
    let run: number[] = [];
    for (const ch of cands) {
      run = run.length && ch === run[run.length - 1] + 1 ? [...run, ch] : [ch];
      if (run.length > best.length) best = run;
    }
    if (best.length >= 3 && best.filter(pressed).length * 2 >= best.length) return { members: new Set(best), manager: null, track: k };
  }
  return null;
}

/** The last event at or before `tick` and every one after it before `end`, from a list sorted by tick. */
function streamIn<T extends { tick: number }>(list: readonly T[], tick: number, end: number): { start: T | undefined; inside: T[] } {
  let start: T | undefined;
  const inside: T[] = [];
  for (const e of list) {
    if (e.tick <= tick) start = e;
    else if (e.tick < end) inside.push(e);
    else break;
  }
  return { start, inside };
}

/**
 * Read a file's MPE zone onto its notes (see the header). Changes `tracks`
 * in place: each member note gets `expr` and its part's channel, and the
 * members' pressure, CC 74, wheel and range messages leave the tracks. A file
 * with no zone is left as it is.
 */
export function applyMpeImport(tracks: MidiTrack[]): void {
  const zone = findZone(tracks);
  if (!zone) return;
  const { members } = zone;
  const bendsOf = new Map<number, MidiBend[]>();
  const timbreOf = new Map<number, MidiControl[]>();
  const pressureOf = new Map<number, MidiPressure[]>();
  const rangesOf = new Map<number, MidiBendRange[]>();
  const add = <T>(m: Map<number, T[]>, ch: number, e: T) => m.set(ch, [...(m.get(ch) ?? []), e]);
  for (const t of tracks) {
    for (const b of t.bends ?? []) if (members.has(b.channel)) add(bendsOf, b.channel, b);
    for (const c of t.controls ?? []) if (members.has(c.channel) && c.controller === 74) add(timbreOf, c.channel, c);
    for (const p of t.pressures ?? []) if (members.has(p.channel)) add(pressureOf, p.channel, p);
    for (const r of t.bendRanges ?? []) if (members.has(r.channel)) add(rangesOf, r.channel, r);
  }
  for (const m of [bendsOf, timbreOf, pressureOf, rangesOf] as Map<number, Array<{ tick: number }>>[]) for (const l of m.values()) l.sort((a, b) => a.tick - b.tick);

  tracks.forEach((t, k) => {
    if (zone.track !== null && zone.track !== k) return;
    // The part's channel: the most used channel of the track's other notes, else the zone's manager, else its first member.
    const counts = new Map<number, number>();
    for (const n of t.notes) if (!members.has(n.channel)) counts.set(n.channel, (counts.get(n.channel) ?? 0) + 1);
    const home = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? zone.manager ?? Math.min(...members);
    for (const n of t.notes) {
      if (!members.has(n.channel)) continue;
      const ch = n.channel;
      const end = n.tick + Math.max(1, n.durationTicks);
      const range = streamIn(rangesOf.get(ch) ?? [], n.tick, end).start?.semitones ?? MPE_MEMBER_BEND_RANGE;
      const raw: Record<ExpressionDimension, { start?: number; curve: Array<{ tick: number; value: number }> }> = {
        pressure: { curve: [] },
        timbre: { curve: [] },
        pitchBend: { curve: [] },
      };
      const p = streamIn(pressureOf.get(ch) ?? [], n.tick, end);
      raw.pressure = { start: p.start ? p.start.value / 127 : undefined, curve: p.inside.map((e) => ({ tick: e.tick - n.tick, value: e.value / 127 })) };
      const c = streamIn(timbreOf.get(ch) ?? [], n.tick, end);
      raw.timbre = { start: c.start ? c.start.value / 127 : undefined, curve: c.inside.map((e) => ({ tick: e.tick - n.tick, value: e.value / 127 })) };
      const b = streamIn(bendsOf.get(ch) ?? [], n.tick, end);
      const bendValue = (v: number) => (v - 8192) / (v >= 8192 ? 8191 : 8192);
      raw.pitchBend = { start: b.start ? bendValue(b.start.value) : undefined, curve: b.inside.map((e) => ({ tick: e.tick - n.tick, value: bendValue(e.value) })) };
      const e: NoteExpression = {};
      const curves: NonNullable<NoteExpression['curves']> = {};
      for (const dim of EXPRESSION_DIMENSIONS) {
        const r = raw[dim];
        // A dimension that only moves inside the note starts where a fresh channel rests.
        const start = r.start ?? (r.curve.length ? (dim === 'timbre' ? 64 / 127 : 0) : undefined);
        if (start !== undefined) e[dim] = start;
        if (r.curve.length) curves[dim] = r.curve;
      }
      if (e.pitchBend !== undefined || curves.pitchBend) e.bendRange = range;
      if (Object.keys(curves).length) e.curves = curves;
      const clean = sanitizeNoteExpression(e);
      if (clean) n.expr = clean;
      n.channel = home;
    }
  });
  // The member channels' own messages leave the file: they were the notes' expression.
  for (const t of tracks) {
    if (t.bends) t.bends = t.bends.filter((x) => !members.has(x.channel));
    if (t.controls) t.controls = t.controls.filter((x) => !(members.has(x.channel) && x.controller === 74));
    if (t.pressures) t.pressures = t.pressures.filter((x) => !members.has(x.channel));
    if (t.bendRanges) t.bendRanges = t.bendRanges.filter((x) => !members.has(x.channel));
    for (const key of ['bends', 'controls', 'pressures', 'bendRanges'] as const) {
      if ((t[key] as unknown[] | undefined)?.length === 0) delete t[key];
    }
  }
}

/* ── writing ─────────────────────────────────────────────────────────────── */

/** One expressive note a writer places: an id of its own, its span in file ticks, and its expression. */
export interface MpeExportNote {
  key: string;
  start: number;
  end: number;
}

/** Where a file's expressive notes go: each note's member channel, the members used, and whether the zone had room. */
export interface MpeExportPlan {
  /** Each note's member channel, by key; empty when the zone had no room. */
  channelOf: Map<string, number>;
  /** The member channels in use, 14 down. */
  members: number[];
  /** True when there were expressive notes and no member channel free (they stay on their parts' channels). */
  noRoom: boolean;
  /** Each note's member is its own from its start to here: the next note on that member starts (absent: none does). */
  until: Map<string, number>;
}

/**
 * The upper zone for `notes`: as many members (14 down, at most five, never
 * one of `taken` or the drum channel, and the manager 15 free) as the notes
 * overlap, each note on a member by lib/mpeRotation's rotation.
 */
export function planMpeExport(notes: readonly MpeExportNote[], taken: ReadonlySet<number>): MpeExportPlan {
  const channelOf = new Map<string, number>();
  const until = new Map<string, number>();
  if (!notes.length) return { channelOf, members: [], noRoom: false, until };
  const free: number[] = [];
  if (!taken.has(MPE_EXPORT_MANAGER)) {
    for (const ch of MPE_EXPORT_MEMBERS) {
      if (taken.has(ch)) break; // the zone's members run down from 14 without a gap
      free.push(ch);
    }
  }
  if (!free.length) return { channelOf, members: [], noRoom: true, until };
  const want = Math.max(1, Math.min(free.length, maxOverlap(notes)));
  const members = free.slice(0, want);
  const byMember = new Map<number, MpeExportNote[]>();
  rotateMembers(notes, members.length).forEach((m, i) => {
    channelOf.set(notes[i].key, members[m]);
    if (m < 0) return;
    const list = byMember.get(members[m]);
    if (list) list.push(notes[i]);
    else byMember.set(members[m], [notes[i]]);
  });
  for (const list of byMember.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i + 1 < list.length; i += 1) until.set(list[i].key, list[i + 1].start);
  }
  return { channelOf, members, noRoom: false, until };
}

/** The MPE Configuration Message a file with `members` member channels carries on channel 15 at tick 0. */
export const mpeZoneEvent = (members: number): { tick: number; channel: number; members: number } => ({ tick: 0, channel: MPE_EXPORT_MANAGER, members });

/**
 * What a member channel is sent for one note: its range when it changes from
 * `lastRange`, then the note's start values at its tick (wheel, CC 74,
 * pressure), then each curve point at the note's tick plus the point's, the
 * curve ticks scaled by `toFile` (the roll's ticks to the file's).
 */
export function mpeNoteMessages(
  n: { tick: number; durationTicks: number; expr: NoteExpression },
  channel: number,
  toFile: number,
  lastRange: number | undefined,
): { bends: MidiBend[]; controls: MidiControl[]; pressures: MidiPressure[]; ranges: MidiBendRange[]; range: number } {
  const e = n.expr;
  const range = e.bendRange ?? DEFAULT_BEND_RANGE;
  const raw = (v: number) => Math.max(0, Math.min(16383, Math.round(8192 + v * (v >= 0 ? 8191 : 8192))));
  const at = (t: number) => Math.min(n.tick + Math.max(1, n.durationTicks) - 1, n.tick + Math.max(1, Math.round(t * toFile)));
  const ranges: MidiBendRange[] = range !== lastRange ? [{ tick: n.tick, channel, semitones: range }] : [];
  const bends: MidiBend[] = [{ tick: n.tick, channel, value: raw(e.pitchBend ?? 0) }];
  const controls: MidiControl[] = [{ tick: n.tick, channel, controller: 74, value: Math.round((e.timbre ?? 64 / 127) * 127) }];
  const pressures: MidiPressure[] = [{ tick: n.tick, channel, value: Math.round((e.pressure ?? 0) * 127) }];
  for (const p of e.curves?.pitchBend ?? []) bends.push({ tick: at(p.tick), channel, value: raw(p.value) });
  for (const p of e.curves?.timbre ?? []) controls.push({ tick: at(p.tick), channel, controller: 74, value: Math.round(p.value * 127) });
  for (const p of e.curves?.pressure ?? []) pressures.push({ tick: at(p.tick), channel, value: Math.round(p.value * 127) });
  return { bends, controls, pressures, ranges, range };
}

/** True when a roll note carries expression a writer puts on a member channel. */
export const writesAsMpe = (e: NoteExpression | undefined): e is NoteExpression => hasExpression(e);
