export interface MidiNote {
  tick: number;
  note: number;
  velocity: number;
  durationTicks: number;
  channel: number;
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
}

export interface MidiFileData {
  ppq: number;
  bpm: number;
  tracks: MidiTrack[];
}

const writeVLQ = (value: number): number[] => {
  const out: number[] = [];
  let v = Math.max(0, Math.round(value));
  out.push(v & 0x7f);
  v >>>= 7;
  while (v > 0) {
    out.unshift(0x80 | (v & 0x7f));
    v >>>= 7;
  }
  return out;
};

const writeUint32BE = (v: number): number[] => [
  (v >>> 24) & 0xff,
  (v >>> 16) & 0xff,
  (v >>> 8) & 0xff,
  v & 0xff,
];

const writeUint16BE = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

const serializeTrackChunk = (track: MidiTrack): number[] => {
  const events: Array<{ tick: number; order: number; bytes: number[] }> = [];
  for (const note of track.notes) {
    const channel = Math.max(0, Math.min(15, note.channel ?? 0));
    const velocity = Math.max(1, Math.min(127, Math.round(note.velocity)));
    const tick = Math.max(0, Math.round(note.tick));
    const end = tick + Math.max(1, Math.round(note.durationTicks));
    events.push({ tick, order: 1, bytes: [0x90 | channel, note.note & 0x7f, velocity] });
    events.push({ tick: end, order: 0, bytes: [0x80 | channel, note.note & 0x7f, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const body: number[] = [];
  const nameBytes = ascii(track.name || 'Track');
  body.push(...writeVLQ(0), 0xff, 0x03, ...writeVLQ(nameBytes.length), ...nameBytes);
  let lastTick = 0;
  for (const ev of events) {
    body.push(...writeVLQ(ev.tick - lastTick), ...ev.bytes);
    lastTick = ev.tick;
  }
  body.push(0, 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...writeUint32BE(body.length), ...body];
};

const buildConductorTrack = (bpm: number): number[] => {
  const microsPerQuarter = Math.round(60_000_000 / Math.max(20, bpm));
  const body: number[] = [];
  body.push(...writeVLQ(0), 0xff, 0x03, 5, ...ascii('Tempo'));
  body.push(
    ...writeVLQ(0),
    0xff,
    0x51,
    0x03,
    (microsPerQuarter >>> 16) & 0xff,
    (microsPerQuarter >>> 8) & 0xff,
    microsPerQuarter & 0xff,
  );
  body.push(...writeVLQ(0), 0xff, 0x58, 0x04, 4, 2, 24, 8);
  body.push(0, 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...writeUint32BE(body.length), ...body];
};

export const buildMidiFile = (data: MidiFileData): Uint8Array => {
  const ppq = Math.max(1, Math.round(data.ppq));
  const chunks = [buildConductorTrack(data.bpm), ...data.tracks.map(serializeTrackChunk)];
  const header = [
    ...ascii('MThd'),
    ...writeUint32BE(6),
    ...writeUint16BE(1),
    ...writeUint16BE(chunks.length),
    ...writeUint16BE(ppq),
  ];
  return new Uint8Array([...header, ...chunks.flat()]);
};

export const downloadMidi = (data: MidiFileData, filenamePrefix = 'stabledaw'): void => {
  const bytes = buildMidiFile(data);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `${filenamePrefix}-${stamp}.mid`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

class MidiReader {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }

  set offset(value: number) {
    this.pos = value;
  }

  read(length: number): Uint8Array {
    if (this.pos + length > this.bytes.length) throw new Error('Unexpected end of MIDI data');
    const out = this.bytes.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  readString(length: number): string {
    return String.fromCharCode(...this.read(length));
  }

  readU16(): number {
    const b = this.read(2);
    return (b[0] << 8) | b[1];
  }

  readU32(): number {
    const b = this.read(4);
    return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
  }

  readVLQ(): number {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = this.read(1)[0];
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Invalid MIDI variable-length quantity');
  }
}

export const parseMidi = (bytes: Uint8Array): MidiFileData => {
  const reader = new MidiReader(bytes);
  if (reader.readString(4) !== 'MThd') throw new Error('Invalid MIDI header');
  const headerLength = reader.readU32();
  const headerEnd = reader.offset + headerLength;
  reader.readU16();
  const trackCount = reader.readU16();
  const division = reader.readU16();
  if (division & 0x8000) throw new Error('SMPTE MIDI timing is not supported');
  const ppq = division || 480;
  reader.offset = headerEnd;

  let bpm = 120;
  const tracks: MidiTrack[] = [];

  for (let t = 0; t < trackCount && reader.offset < bytes.length; t += 1) {
    if (reader.readString(4) !== 'MTrk') throw new Error('Invalid MIDI track chunk');
    const trackEnd = reader.offset + reader.readU32();
    const notes: MidiNote[] = [];
    const openNotes = new Map<string, { tick: number; velocity: number }>();
    let name = `Track ${t + 1}`;
    let tick = 0;
    let runningStatus = 0;

    while (reader.offset < trackEnd) {
      tick += reader.readVLQ();
      let status = reader.read(1)[0];
      if (status < 0x80) {
        if (!runningStatus) throw new Error('Missing MIDI running status');
        reader.offset -= 1;
        status = runningStatus;
      } else if (status < 0xf0) {
        runningStatus = status;
      }

      if (status === 0xff) {
        const type = reader.read(1)[0];
        const length = reader.readVLQ();
        const payload = reader.read(length);
        if (type === 0x03 && payload.length) name = String.fromCharCode(...payload);
        if (type === 0x51 && payload.length === 3) {
          const micros = (payload[0] << 16) | (payload[1] << 8) | payload[2];
          if (micros > 0) bpm = 60_000_000 / micros;
        }
        if (type === 0x2f) break;
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        reader.read(reader.readVLQ());
        continue;
      }

      const eventType = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = reader.read(1)[0];
      const needsSecondByte = eventType !== 0xc0 && eventType !== 0xd0;
      const data2 = needsSecondByte ? reader.read(1)[0] : 0;

      if (eventType === 0x90 && data2 > 0) {
        openNotes.set(`${channel}:${data1}`, { tick, velocity: data2 });
      } else if (eventType === 0x80 || (eventType === 0x90 && data2 === 0)) {
        const key = `${channel}:${data1}`;
        const started = openNotes.get(key);
        if (started) {
          notes.push({
            tick: started.tick,
            note: data1,
            velocity: started.velocity,
            durationTicks: Math.max(1, tick - started.tick),
            channel,
          });
          openNotes.delete(key);
        }
      }
    }

    reader.offset = trackEnd;
    if (notes.length) tracks.push({ name, notes: notes.sort((a, b) => a.tick - b.tick) });
  }

  return { ppq, bpm, tracks };
};
