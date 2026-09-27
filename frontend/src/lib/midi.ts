/**
 * Tiny Standard MIDI File (SMF) encoder + parser.
 *
 * Just enough to round-trip note-on / note-off events with tempo changes, time
 * signatures, pitch wheel messages and the pitch bend range (RPN 0/0), which is
 * what the sequencer's drum-pattern export and the piano roll's note grid both
 * need. A signature's additive grouping (3+2+2) has no field in FF 58, so it
 * travels in a text event `theDAW:groups=3+2+2` at the signature's tick, which
 * only this parser reads back. A tempo map's ramps and fermatas have no field
 * in FF 51 either: the tempo metas carry what every reader plays, and the map
 * itself rides in one text event `theDAW:tempomap=…` (lib/rollMidi reads it).
 */
import type { MeterEvent } from './meterMap';
import { saveFile, type SaveFileResult } from './saveFile';

export interface MidiNote {
  /** Tick offset from the start of the track. */
  tick: number;
  /** MIDI note number 0-127. 60 = middle C. */
  note: number;
  /** Velocity 1-127. */
  velocity: number;
  /**
   * Length in ticks. Encoded: at least 1 (a 0 is written as 1). Parsed: to the
   * note-off that ends it, which ends the oldest held note of its channel and
   * pitch, or to the track's last tick when no note-off comes.
   */
  durationTicks: number;
  /** Channel 0-15. Drum sounds are conventionally channel 9. */
  channel: number;
}

/** A pitch wheel message (E0). */
export interface MidiBend {
  tick: number;
  /** Channel 0-15; the wheel bends every note on it. */
  channel: number;
  /** 0-16383; 8192 is the centre. */
  value: number;
}

/** A pitch bend range set through RPN 0/0: CC 101 0, CC 100 0, CC 6 semitones, CC 38 cents. */
export interface MidiBendRange {
  tick: number;
  channel: number;
  semitones: number;
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
  /** Pitch wheel messages, sorted by tick. Parsed: absent when the track has none. */
  bends?: MidiBend[];
  /** Bend ranges the track sets, sorted by tick. Parsed: absent when the track sets none. */
  bendRanges?: MidiBendRange[];
}

export interface MidiTempo {
  tick: number;
  bpm: number;
}

export interface MidiFileData {
  /** Ticks per quarter note. */
  ppq: number;
  /**
   * Beats per minute. Parsed: the tempo at tick 0, or the first tempo when none
   * sits at tick 0, as `tempos` holds it; 120 when the file has no tempo.
   * Encoded: written at tick 0 unless `tempos` holds a tick-0 entry.
   */
  bpm: number;
  tracks: MidiTrack[];
  /** Every time signature (FF 58), sorted by tick, merged across tracks. Parsed: absent when the file has none. Encoded: absent or empty writes 4/4 at tick 0. */
  timeSignatures?: MeterEvent[];
  /**
   * Every tempo (FF 51), sorted by tick, merged across tracks. Parsed: absent
   * when the file has none. A parsed tempo is the one its microseconds give,
   * read to three decimals when those three decimals give the same
   * microseconds back (a written 97 reads 97, 97.3 reads 97.3) and exactly
   * otherwise, so no two tempos a file can hold read as one.
   */
  tempos?: MidiTempo[];
  /**
   * The `theDAW:tempomap=` text of the conductor track: a tempo map with its
   * ramps and fermatas, which FF 51 cannot say (lib/rollMidi writes and reads
   * it). Encoded at tick 0 when present; parsed from the last one in the file.
   */
  dawTempoMap?: string;
}

// =============================================================================
// Encoder
// =============================================================================

const writeVLQ = (value: number): number[] => {
  if (value < 0) value = 0;
  const out: number[] = [];
  let v = value;
  out.push(v & 0x7f);
  v >>>= 7;
  while (v > 0) {
    out.unshift(0x80 | (v & 0x7f));
    v >>>= 7;
  }
  return out;
};

const u32be = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u16be = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

interface RawEvent {
  tick: number;
  bytes: number[];
}

/** A track event with its place among the events at its tick. */
type RankedEvent = RawEvent & { rank: number };

/** At one tick: note-offs, then bend ranges, then wheel messages, then note-ons, so a note that ends there is not bent and one that starts there starts bent. */
const RANK_NOTE_OFF = 0;
const RANK_RANGE = 1;
const RANK_WHEEL = 2;
const RANK_NOTE_ON = 3;

const byTickAndRank = (a: RankedEvent, b: RankedEvent): number => a.tick - b.tick || a.rank - b.rank;

const notesToEvents = (notes: MidiNote[]): RankedEvent[] => {
  const evs: RankedEvent[] = [];
  for (const n of notes) {
    const ch = (n.channel ?? 0) & 0x0f;
    evs.push({ tick: n.tick, rank: RANK_NOTE_ON, bytes: [0x90 | ch, n.note & 0x7f, Math.max(1, Math.min(127, n.velocity))] });
    evs.push({ tick: n.tick + Math.max(1, n.durationTicks), rank: RANK_NOTE_OFF, bytes: [0x80 | ch, n.note & 0x7f, 0] });
  }
  evs.sort(byTickAndRank);
  return evs;
};

/** CC 38 of a bend range in cents, as the MIDI spec has it: what a .mid file carries. */
export const RANGE_LSB_CENTS = 100;
/** CC 38 of a bend range in 1/128 semitones, as SpessaSynth reads it ((CC 6 << 7 | CC 38) / 128): what the soundfont synth gets. */
export const RANGE_LSB_SPESSA = 128;

/**
 * The messages that set a channel's pitch bend range: RPN 0/0 selected, the
 * semitones (CC 6) and the fraction of a semitone (CC 38, `lsbPerSemitone` to
 * a semitone), then the RPN deselected (127/127) so a later data entry changes
 * nothing. midiWrite's writer uses the same bytes.
 */
export const bendRangeMessages = (channel: number, semitones: number, lsbPerSemitone = RANGE_LSB_CENTS): number[][] => {
  const status = 0xb0 | (channel & 0x0f);
  const units = Math.max(0, Math.min(128 * lsbPerSemitone - 1, Math.round((Number.isFinite(semitones) ? semitones : 2) * lsbPerSemitone)));
  return [
    [status, 101, 0],
    [status, 100, 0],
    [status, 6, Math.floor(units / lsbPerSemitone)],
    [status, 38, units % lsbPerSemitone],
    [status, 101, 127],
    [status, 100, 127],
  ];
};

/** A pitch wheel message: E0, the low 7 bits, the high 7 bits. */
export const pitchWheelMessage = (channel: number, value: number): number[] => {
  const v = Math.max(0, Math.min(16383, Math.round(value)));
  return [0xe0 | (channel & 0x0f), v & 0x7f, (v >> 7) & 0x7f];
};

/**
 * A track's events: its notes, and when it has any, its ranges and wheel
 * messages. At one tick the note-offs come first, then the ranges, then the
 * wheel, then the note-ons, so a note that ends there is not bent and a note
 * that starts there starts bent. A track with neither writes the notes' bytes alone.
 */
const trackEvents = (t: MidiTrack): RawEvent[] => {
  const notes = notesToEvents(t.notes);
  const wheel: RankedEvent[] = [];
  for (const r of t.bendRanges ?? []) {
    const tick = tickOf(r.tick);
    for (const bytes of bendRangeMessages(r.channel, r.semitones)) wheel.push({ tick, rank: RANK_RANGE, bytes });
  }
  for (const b of t.bends ?? []) wheel.push({ tick: tickOf(b.tick), rank: RANK_WHEEL, bytes: pitchWheelMessage(b.channel, b.value) });
  if (!wheel.length) return notes;
  return [...wheel, ...notes].sort(byTickAndRank);
};

/**
 * The file's bytes, in one buffer that doubles when it fills. Every byte the
 * encoder writes goes through it: appending a whole chunk to a plain array with
 * `push(...chunk)` passes each byte as an argument, and V8 throws a RangeError
 * past about 125,000 of them, which one roll track reaches at around 13,000 notes.
 */
class ByteSink {
  private buf = new Uint8Array(4096);
  private len = 0;

  get length(): number {
    return this.len;
  }

  private reserve(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  bytes(values: readonly number[]): void {
    this.reserve(values.length);
    for (const v of values) this.buf[this.len++] = v & 0xff;
  }

  /** Overwrite four bytes at `at` with `v`, big-endian: a chunk's length once its body is written. */
  u32At(at: number, v: number): void {
    const b = u32be(v);
    for (let i = 0; i < 4; i += 1) this.buf[at + i] = b[i];
  }

  /** The bytes written so far, in an array of their own. */
  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** One MTrk chunk: its name, its events at their ticks, the end of track, and the length patched in once the body is written. */
const writeTrackChunk = (out: ByteSink, events: readonly RawEvent[], name: string): void => {
  out.bytes(ascii('MTrk'));
  const lengthAt = out.length;
  out.bytes([0, 0, 0, 0]);
  out.bytes(writeVLQ(0));
  out.bytes([0xff, 0x03]);
  out.bytes(writeVLQ(name.length));
  out.bytes(ascii(name));
  let last = 0;
  for (const ev of events) {
    out.bytes(writeVLQ(ev.tick - last));
    out.bytes(ev.bytes);
    last = ev.tick;
  }
  out.bytes([0, 0xff, 0x2f, 0x00]);
  out.u32At(lengthAt, out.length - lengthAt - 4);
};

const GROUPS_TEXT = 'theDAW:groups=';
const PICKUP_TEXT = 'theDAW:pickup=';
const TEMPOMAP_TEXT = 'theDAW:tempomap=';

/**
 * FF 51's microseconds a quarter for `bpm`: as slow as the 24-bit field holds
 * (about 3.58 bpm), so a fermata's held beats are written at their own slowed
 * tempo. A tempo that is not a positive number is written as 120.
 */
export const tempoMicros = (bpm: number): number =>
  Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / (Number.isFinite(bpm) && bpm > 0 ? bpm : 120))));

const tempoBytes = (bpm: number): number[] => {
  const microsPerQuarter = tempoMicros(bpm);
  return [0xff, 0x51, 0x03, (microsPerQuarter >>> 16) & 0xff, (microsPerQuarter >>> 8) & 0xff, microsPerQuarter & 0xff];
};

/** FF 58 04 nn dd cc bb: numerator, log2 of the denominator, 96/den MIDI clocks per click, eight 32nds per quarter. */
const signatureBytes = (num: number, den: number): number[] => {
  const dd = Math.max(0, Math.min(7, Math.round(Math.log2(Math.max(1, den)))));
  const clocks = Math.max(1, Math.round(96 / 2 ** dd));
  return [0xff, 0x58, 0x04, Math.max(1, Math.min(255, Math.round(num))), dd, clocks, 8];
};

const textBytes = (text: string): number[] => [0xff, 0x01, ...writeVLQ(text.length), ...ascii(text)];

const tickOf = (tick: number): number => (Number.isFinite(tick) ? Math.max(0, Math.round(tick)) : 0);

/**
 * One signature's meta events, in the order they sit at its tick: the FF 58,
 * its groups text, then its pickup text. midiWrite's writer uses the same bytes.
 */
export const meterEventMetas = (s: MeterEvent): number[][] => {
  const out = [signatureBytes(s.num, s.den)];
  if (s.groups?.length) out.push(textBytes(`${GROUPS_TEXT}${s.groups.join('+')}`));
  if (typeof s.pickupSteps === 'number' && Number.isFinite(s.pickupSteps) && s.pickupSteps >= 0) out.push(textBytes(`${PICKUP_TEXT}${s.pickupSteps}`));
  return out;
};

/**
 * The conductor track's events: every tempo and time signature at its own tick.
 * At one tick the tempo comes first, then the signature, its groups text and
 * its pickup text. With no lists it holds one tempo and a 4/4 at tick 0.
 */
const conductorEvents = (file: MidiFileData): RankedEvent[] => {
  const tempos = (file.tempos ?? []).map((t) => ({ tick: tickOf(t.tick), bpm: t.bpm }));
  if (!tempos.some((t) => t.tick === 0)) tempos.unshift({ tick: 0, bpm: file.bpm });
  const signatures = file.timeSignatures?.length ? file.timeSignatures : [{ tick: 0, num: 4, den: 4 }];
  const events: RankedEvent[] = [];
  for (const t of tempos) events.push({ tick: t.tick, rank: 0, bytes: tempoBytes(t.bpm) });
  for (const s of signatures) {
    const tick = tickOf(s.tick);
    meterEventMetas(s).forEach((bytes, i) => events.push({ tick, rank: 1 + i, bytes }));
  }
  // After every other meta at tick 0, so a reader that stops at the first text still meets the signature's own.
  if (file.dawTempoMap) events.push({ tick: 0, rank: 100, bytes: textBytes(`${TEMPOMAP_TEXT}${file.dawTempoMap}`) });
  events.sort(byTickAndRank);
  return events;
};

/** A format-1 file: the header, the conductor track ("Tempo"), then one chunk per track. */
export const encodeMidi = (file: MidiFileData): Uint8Array => {
  const out = new ByteSink();
  out.bytes(ascii('MThd'));
  out.bytes(u32be(6));
  out.bytes(u16be(1));
  out.bytes(u16be(1 + file.tracks.length));
  out.bytes(u16be(file.ppq));
  writeTrackChunk(out, conductorEvents(file), 'Tempo');
  for (const t of file.tracks) writeTrackChunk(out, trackEvents(t), t.name);
  return out.take();
};

/** Save the file as `<baseName>-<timestamp>.mid` through saveFile, which
 *  remembers the chosen path. Resolves with the save's outcome. */
export const downloadMidi = (file: MidiFileData, baseName = 'pattern'): Promise<SaveFileResult> => {
  const bytes = encodeMidi(file);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return saveFile({ blob, suggestedName: `${baseName}-${stamp}.mid`, kind: 'midi' });
};

// =============================================================================
// Parser
// =============================================================================

class Reader {
  constructor(public buf: Uint8Array, public pos = 0) {}
  byte(): number { return this.buf[this.pos++]; }
  u16(): number { return (this.byte() << 8) | this.byte(); }
  u32(): number { return (this.byte() << 24 | this.byte() << 16 | this.byte() << 8 | this.byte()) >>> 0; }
  bytes(n: number): Uint8Array { const out = this.buf.slice(this.pos, this.pos + n); this.pos += n; return out; }
  str(n: number): string { return Array.from(this.bytes(n), (b) => String.fromCharCode(b)).join(''); }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i += 1) {
      const b = this.byte();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    return v;
  }
  remaining(): number { return this.buf.length - this.pos; }
}

interface ChannelEvent {
  status: number;
  data1: number;
  data2: number;
}

interface NotePartial {
  tick: number;
  note: number;
  velocity: number;
  channel: number;
}

interface DecodedTrack {
  name: string;
  notes: MidiNote[];
  tempos: MidiTempo[];
  signatures: MeterEvent[];
  /** `theDAW:groups=` text events, attached to the signature at the same tick by parseMidi. */
  groups: Array<{ tick: number; groups: number[] }>;
  /** `theDAW:pickup=` text events, attached the same way. */
  pickups: Array<{ tick: number; steps: number }>;
  /** The last `theDAW:tempomap=` text's body, or null. */
  tempoMap: string | null;
  bends: MidiBend[];
  ranges: MidiBendRange[];
}

const decodeTrack = (chunk: Uint8Array): DecodedTrack => {
  const r = new Reader(chunk);
  let runningStatus = 0;
  let tick = 0;
  let name = '';
  const tempos: MidiTempo[] = [];
  const signatures: MeterEvent[] = [];
  const groups: DecodedTrack['groups'] = [];
  const pickups: DecodedTrack['pickups'] = [];
  let tempoMap: string | null = null;
  // The notes held down, by `${ch}:${note}`, oldest first. A note-off ends the
  // OLDEST held note of its channel and pitch, so two notes of one pitch that
  // overlap (a unison between two voices, a repeated note played legato) are
  // both kept, each with its own length.
  const open = new Map<string, NotePartial[]>();
  const finished: MidiNote[] = [];
  const bends: MidiBend[] = [];
  const ranges: MidiBendRange[] = [];
  // Per channel: the RPN selected by CC 101 / 100 (127/127 is none), and the range its last CC 6 wrote, which a CC 38 refines.
  const rpn = new Map<number, { msb: number; lsb: number; range: MidiBendRange | null }>();

  while (r.remaining() > 0) {
    const delta = r.vlq();
    tick += delta;
    let status = r.byte();
    if (status < 0x80) {
      // Running status: the data byte belongs to the last channel message's status. Back up one byte.
      r.pos -= 1;
      status = runningStatus;
    } else if (status < 0xf0) {
      // Only a channel message sets the running status. A meta or sysex event leaves it as it was:
      // SMF 1.0 cancels it there, but some writers carry it across a meta event, and a file that
      // follows the spec never puts a data byte after one.
      runningStatus = status;
    }
    if (status === 0xff) {
      const meta = r.byte();
      const len = r.vlq();
      const data = r.bytes(len);
      if (meta === 0x03) {
        // Track name
        name = Array.from(data, (b) => String.fromCharCode(b)).join('').trim();
      } else if (meta === 0x01) {
        const text = Array.from(data, (b) => String.fromCharCode(b)).join('');
        if (text.startsWith(GROUPS_TEXT)) {
          const g = text.slice(GROUPS_TEXT.length).split('+').map(Number);
          if (g.length && g.every((x) => Number.isInteger(x) && x >= 1)) groups.push({ tick, groups: g });
        } else if (text.startsWith(PICKUP_TEXT)) {
          const steps = Number(text.slice(PICKUP_TEXT.length));
          if (Number.isFinite(steps) && steps >= 0) pickups.push({ tick, steps });
        } else if (text.startsWith(TEMPOMAP_TEXT)) {
          tempoMap = text.slice(TEMPOMAP_TEXT.length);
        }
      } else if (meta === 0x51 && data.length === 3) {
        const microsPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
        if (microsPerQuarter > 0) tempos.push({ tick, bpm: tempoOfMicros(microsPerQuarter) });
      } else if (meta === 0x58 && data.length >= 2) {
        if (data[0] > 0) signatures.push({ tick, num: data[0], den: 2 ** data[1] });
      } else if (meta === 0x2f) {
        break;
      }
      // Other meta: ignored
    } else if (status === 0xf0 || status === 0xf7) {
      // SysEx — skip length bytes
      const len = r.vlq();
      r.pos += len;
    } else {
      const type = status & 0xf0;
      const ch = status & 0x0f;
      const d1 = r.byte();
      let d2 = 0;
      // Two-data-byte events: 0x80, 0x90, 0xA0, 0xB0, 0xE0
      // One-data-byte: 0xC0, 0xD0
      if (type !== 0xc0 && type !== 0xd0) d2 = r.byte();
      if (type === 0x90 && d2 > 0) {
        // Note On with velocity > 0
        const key = `${ch}:${d1}`;
        const partial = { tick, note: d1, velocity: d2, channel: ch };
        const held = open.get(key);
        if (held) held.push(partial);
        else open.set(key, [partial]);
      } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        // Note Off (or Note On vel=0): the oldest held note of this channel and pitch ends here.
        const key = `${ch}:${d1}`;
        const held = open.get(key);
        const partial = held?.shift();
        if (partial) {
          finished.push({
            tick: partial.tick,
            note: partial.note,
            velocity: partial.velocity,
            channel: partial.channel,
            durationTicks: Math.max(1, tick - partial.tick),
          });
          if (held?.length === 0) open.delete(key);
        }
      } else if (type === 0xe0) {
        bends.push({ tick, channel: ch, value: d1 | (d2 << 7) });
      } else if (type === 0xb0) {
        const sel = rpn.get(ch) ?? { msb: 127, lsb: 127, range: null };
        if (d1 === 101) {
          sel.msb = d2;
          sel.range = null;
        } else if (d1 === 100) {
          sel.lsb = d2;
          sel.range = null;
        } else if (d1 === 99 || d1 === 98 || d1 === 121) {
          // An NRPN selection, or Reset All Controllers (RP-015 leaves no parameter selected):
          // a data entry no longer sets the bend range.
          sel.msb = 127;
          sel.lsb = 127;
          sel.range = null;
        } else if (d1 === 6 && sel.msb === 0 && sel.lsb === 0) {
          sel.range = { tick, channel: ch, semitones: d2 };
          ranges.push(sel.range);
        } else if (d1 === 38 && sel.msb === 0 && sel.lsb === 0 && sel.range) {
          sel.range.semitones = Math.floor(sel.range.semitones) + Math.min(99, d2) / 100;
        }
        rpn.set(ch, sel);
      }
      // Other channel events (aftertouch, program, other CCs) ignored
    }
  }

  // A note still held when the track ends lasts to the track's last tick: its
  // end-of-track event's, or its last event's when the chunk has none. A note
  // that starts on that tick keeps one tick, so it is not lost.
  for (const held of open.values()) {
    for (const partial of held) {
      finished.push({
        tick: partial.tick,
        note: partial.note,
        velocity: partial.velocity,
        channel: partial.channel,
        durationTicks: Math.max(1, tick - partial.tick),
      });
    }
  }

  finished.sort((a, b) => a.tick - b.tick);
  return { name, notes: finished, tempos, signatures, groups, pickups, tempoMap, bends, ranges };
};

/**
 * The tempo FF 51's microseconds a quarter give. The microsecond rounding
 * reads a written 97 back as 96.99995, so the tempo is read to three decimals
 * when those give the same microseconds back; when they do not (below about
 * 40 bpm, one thousandth of a bpm spans several microseconds), it is read
 * exactly, so a slow tempo is not moved and two tempos never read as one.
 */
export const tempoOfMicros = (microsPerQuarter: number): number => {
  const exact = 60_000_000 / microsPerQuarter;
  const short = Math.round(exact * 1000) / 1000;
  return Math.round(60_000_000 / short) === microsPerQuarter ? short : exact;
};

export const parseMidi = (buf: ArrayBuffer | Uint8Array): MidiFileData => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(bytes);
  if (r.str(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd)');
  const headerLen = r.u32();
  /* format */ r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  // skip any extra header bytes
  if (headerLen > 6) r.pos += headerLen - 6;

  // Division: positive value = ticks per quarter; negative would be SMPTE (not supported).
  const ppq = (division & 0x8000) ? 480 : division;

  const tracks: MidiTrack[] = [];
  const tempos: MidiTempo[] = [];
  const signatures: MeterEvent[] = [];
  const groups: DecodedTrack['groups'] = [];
  const pickups: DecodedTrack['pickups'] = [];
  let dawTempoMap: string | null = null;
  for (let i = 0; i < ntrks; i += 1) {
    if (r.str(4) !== 'MTrk') throw new Error(`Track ${i} missing MTrk marker`);
    const len = r.u32();
    const chunk = r.bytes(len);
    const t = decodeTrack(chunk);
    // One push per event: a spread passes every event as an argument, which V8
    // refuses past about 125,000 of them.
    for (const e of t.tempos) tempos.push(e);
    for (const e of t.signatures) signatures.push(e);
    for (const e of t.groups) groups.push(e);
    for (const e of t.pickups) pickups.push(e);
    if (t.tempoMap !== null) dawTempoMap = t.tempoMap;
    // A track that only bends is kept: its channel's wheel bends notes another track holds.
    if (t.notes.length > 0 || t.bends.length > 0) {
      tracks.push({
        name: t.name || `Track ${i}`,
        notes: t.notes,
        ...(t.bends.length ? { bends: t.bends } : {}),
        ...(t.ranges.length ? { bendRanges: t.ranges } : {}),
      });
    }
  }
  // Stable sorts: at one tick, events keep track order, so the last one written is the one in force.
  tempos.sort((a, b) => a.tick - b.tick);
  signatures.sort((a, b) => a.tick - b.tick);
  for (const g of groups) {
    for (const s of signatures) if (s.tick === g.tick) s.groups = [...g.groups];
  }
  for (const p of pickups) {
    for (const s of signatures) if (s.tick === p.tick) s.pickupSteps = p.steps;
  }
  const atZero = tempos.filter((t) => t.tick === 0);
  const bpm = atZero.length ? atZero[atZero.length - 1].bpm : tempos.length ? tempos[0].bpm : 120;
  return {
    ppq,
    bpm,
    tracks,
    ...(signatures.length ? { timeSignatures: signatures } : {}),
    ...(tempos.length ? { tempos } : {}),
    ...(dawTempoMap !== null ? { dawTempoMap } : {}),
  };
};

