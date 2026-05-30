/**
 * Tiny Standard MIDI File (SMF) encoder + parser.
 *
 * Just enough to round-trip note-on / note-off events with tempo, which is
 * what the sequencer's drum-pattern export and the piano roll's note grid
 * both need.
 */

export interface MidiNote {
  /** Tick offset from the start of the track. */
  tick: number;
  /** MIDI note number 0-127. 60 = middle C. */
  note: number;
  /** Velocity 1-127. */
  velocity: number;
  /** Length in ticks (0 = a "stuck" note; parser sets this from matching offs). */
  durationTicks: number;
  /** Channel 0-15. Drum sounds are conventionally channel 9. */
  channel: number;
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
}

export interface MidiFileData {
  /** Ticks per quarter note. */
  ppq: number;
  /** Beats per minute, derived from the first tempo meta event. Defaults to 120. */
  bpm: number;
  tracks: MidiTrack[];
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

const notesToEvents = (notes: MidiNote[]): RawEvent[] => {
  const evs: RawEvent[] = [];
  for (const n of notes) {
    const ch = (n.channel ?? 0) & 0x0f;
    evs.push({ tick: n.tick, bytes: [0x90 | ch, n.note & 0x7f, Math.max(1, Math.min(127, n.velocity))] });
    evs.push({ tick: n.tick + Math.max(1, n.durationTicks), bytes: [0x80 | ch, n.note & 0x7f, 0] });
  }
  evs.sort((a, b) => a.tick - b.tick);
  return evs;
};

const serializeTrackChunk = (events: RawEvent[], name: string): number[] => {
  const body: number[] = [];
  body.push(...writeVLQ(0), 0xff, 0x03, ...writeVLQ(name.length), ...ascii(name));
  let last = 0;
  for (const ev of events) {
    body.push(...writeVLQ(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  body.push(0, 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...u32be(body.length), ...body];
};

const buildConductor = (bpm: number): number[] => {
  const microsPerQuarter = Math.round(60_000_000 / Math.max(20, bpm));
  const body: number[] = [];
  body.push(...writeVLQ(0), 0xff, 0x03, 5, ...ascii('Tempo'));
  body.push(...writeVLQ(0), 0xff, 0x51, 0x03,
    (microsPerQuarter >>> 16) & 0xff,
    (microsPerQuarter >>> 8) & 0xff,
    microsPerQuarter & 0xff,
  );
  body.push(...writeVLQ(0), 0xff, 0x58, 0x04, 4, 2, 24, 8);
  body.push(0, 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...u32be(body.length), ...body];
};

export const encodeMidi = (file: MidiFileData): Uint8Array => {
  const tracks = file.tracks.map((t) => serializeTrackChunk(notesToEvents(t.notes), t.name));
  const ntrks = 1 + tracks.length;
  const header = [
    ...ascii('MThd'),
    ...u32be(6),
    ...u16be(1),
    ...u16be(ntrks),
    ...u16be(file.ppq),
  ];
  const out: number[] = [...header, ...buildConductor(file.bpm)];
  for (const c of tracks) out.push(...c);
  return new Uint8Array(out);
};

export const downloadMidi = (file: MidiFileData, baseName = 'pattern'): void => {
  const bytes = encodeMidi(file);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `${baseName}-${stamp}.mid`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

const decodeTrack = (chunk: Uint8Array, ppq: number): { name: string; notes: MidiNote[]; tempoBpm: number | null } => {
  const r = new Reader(chunk);
  let runningStatus = 0;
  let tick = 0;
  let name = '';
  let tempoBpm: number | null = null;
  const open = new Map<string, NotePartial>(); // key = `${ch}:${note}`
  const finished: MidiNote[] = [];

  while (r.remaining() > 0) {
    const delta = r.vlq();
    tick += delta;
    let status = r.byte();
    if (status < 0x80) {
      // running status — back up one byte
      r.pos -= 1;
      status = runningStatus;
    } else {
      runningStatus = status;
    }
    if (status === 0xff) {
      const meta = r.byte();
      const len = r.vlq();
      const data = r.bytes(len);
      if (meta === 0x03) {
        // Track name
        name = Array.from(data, (b) => String.fromCharCode(b)).join('').trim();
      } else if (meta === 0x51 && data.length === 3) {
        const microsPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
        if (microsPerQuarter > 0) tempoBpm = 60_000_000 / microsPerQuarter;
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
        open.set(key, { tick, note: d1, velocity: d2, channel: ch });
      } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        // Note Off (or Note On vel=0)
        const key = `${ch}:${d1}`;
        const partial = open.get(key);
        if (partial) {
          finished.push({
            tick: partial.tick,
            note: partial.note,
            velocity: partial.velocity,
            channel: partial.channel,
            durationTicks: Math.max(1, tick - partial.tick),
          });
          open.delete(key);
        }
      }
      // Other channel events (CC, PB, etc.) ignored
    }
  }

  // Any notes left open at end-of-track get a 1-tick duration so they're not lost.
  for (const partial of open.values()) {
    finished.push({
      tick: partial.tick,
      note: partial.note,
      velocity: partial.velocity,
      channel: partial.channel,
      durationTicks: ppq,
    });
  }

  finished.sort((a, b) => a.tick - b.tick);
  return { name, notes: finished, tempoBpm };
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

  let bpm = 120;
  const tracks: MidiTrack[] = [];
  for (let i = 0; i < ntrks; i += 1) {
    if (r.str(4) !== 'MTrk') throw new Error(`Track ${i} missing MTrk marker`);
    const len = r.u32();
    const chunk = r.bytes(len);
    const t = decodeTrack(chunk, ppq);
    if (t.tempoBpm) bpm = t.tempoBpm;
    if (t.notes.length > 0) {
      tracks.push({ name: t.name || `Track ${i}`, notes: t.notes });
    }
  }
  return { ppq, bpm: Math.round(bpm), tracks };
};

