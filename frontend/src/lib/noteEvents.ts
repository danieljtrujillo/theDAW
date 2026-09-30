/**
 * noteEvents — the roll's notes as a flat, ordered note-on/note-off stream.
 *
 * A `PianoNote` is a SPAN (a tick and a length). Everything that actually plays
 * or writes MIDI wants EDGES in time order instead, and every path that needs
 * them has so far built its own pair-and-sort: the SMF writer, the step
 * sequencer's exporter, the live scheduler. This is that one arithmetic, pure
 * and testable, for those paths to consume.
 *
 * ORDERING is the whole point, and it is the MIDI one:
 *
 *   1. by tick, ascending;
 *   2. at the same tick, every note-OFF before every note-ON. A note that ends
 *      exactly where the next one starts must release first, or a synth holding
 *      one voice per pitch kills the note that just began and the line goes
 *      silent. (`lib/midi.encodeMidi` orders its bytes by the same rule.)
 *   3. then by pitch, then by the source note's id — so two runs over the same
 *      notes produce byte-identical output.
 *
 * `channel` here is the note model's 1-16, NOT the 0-15 wire value: subtract one
 * before putting it in a status byte.
 *
 * LANES are the caller's job. This emits one pair per note in the list it is
 * handed and nothing else: a note in a LOOPING polymeter lane sounds once per
 * cycle, and those repeats do not exist until `meterMap.unrollLanes` has made
 * them into notes. Call that first (as `rollMidi.rollToMidiFile` does before
 * building its track) or the export/playback loses every repeat but the first.
 *
 * Everything is pure — no store, no DOM — so the node test checks it directly.
 *
 * Design source (design only — nothing copied): Tracktion Engine
 * `modules/tracktion_engine/midi/tracktion_MidiNote.h` (GPL-3 / commercial),
 * whose MidiNote hands out its two edges (`startEdge` / `endEdge`) from one
 * stored span rather than storing the edges.
 */
import {
  MIN_NOTE_TICKS,
  noteTick,
  noteTicks,
  type NoteExpression,
  type PianoNote,
} from '../state/pianoRollStore';

/** The channel a note without one of its own plays on (model numbering, 1-16). */
export const DEFAULT_NOTE_CHANNEL = 1;

/** One edge of one note. */
export interface MidiEvent {
  /** Ticks from the roll's start, at the note model's PPQ. */
  tick: number;
  type: 'on' | 'off';
  /** MIDI note number 0-127. */
  note: number;
  /** 1-127 on a note-on; 0 on a note-off. */
  velocity: number;
  /** MIDI channel 1-16 (model numbering — the wire value is this minus one). */
  channel: number;
  /** The `PianoNote.id` this edge came from, so a consumer can match the pair. */
  id: string;
  /** The note's expression, carried on the ON edge only and only when it has one. */
  expr?: NoteExpression;
}

const clampMidi = (v: number, lo: number, hi: number, fallback: number): number =>
  Math.max(lo, Math.min(hi, Math.round(typeof v === 'number' && Number.isFinite(v) ? v : fallback)));

const rank = (e: MidiEvent): number => (e.type === 'off' ? 0 : 1);

/**
 * `notes` as note-on/note-off pairs in play order. Notes that carry no `tick`
 * are migrated on the way through (`noteTick`), so an un-migrated list — a
 * paste, a freshly imported file, a note built by an older helper — is handled
 * without the caller having to think about it. `stepsPerBeat` only matters for
 * those: it is the grid their `step` was counted on, defaulting to the roll's
 * sixteenths.
 */
export function noteEvents(notes: readonly PianoNote[], stepsPerBeat?: number): MidiEvent[] {
  const out: MidiEvent[] = [];
  for (const n of notes) {
    const tick = noteTick(n, stepsPerBeat);
    const ticks = Math.max(MIN_NOTE_TICKS, noteTicks(n, stepsPerBeat));
    const note = clampMidi(n.note, 0, 127, 0);
    const channel = clampMidi(n.channel as number, 1, 16, DEFAULT_NOTE_CHANNEL);
    const id = String(n.id);
    const on: MidiEvent = { tick, type: 'on', note, velocity: clampMidi(n.velocity, 1, 127, 1), channel, id };
    if (n.expr) on.expr = n.expr;
    out.push(on);
    out.push({ tick: tick + ticks, type: 'off', note, velocity: 0, channel, id });
  }
  return out.sort(
    (a, b) => a.tick - b.tick || rank(a) - rank(b) || a.note - b.note || a.channel - b.channel || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
