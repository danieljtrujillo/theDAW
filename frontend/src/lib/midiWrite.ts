/**
 * Minimal Standard MIDI File (type-0) writer.
 *
 * Bridges the app's absolute-seconds note model (`RenderNote`) into SMF bytes so
 * the notes can be fed to engines that render from a parsed MIDI sequence rather
 * than loose notes (SpessaSynth's offline render takes a `BasicMIDI`). Uses a
 * fixed 120 BPM / 480 PPQ grid with a matching tempo meta event, so tick time
 * maps back to the original seconds exactly.
 */
import type { RenderNote } from './midiSynth';

const PPQ = 480;
const BPM = 120;
const SEC_PER_TICK = 60 / BPM / PPQ;

/** Append a variable-length quantity (MIDI delta-time encoding). */
function pushVlq(out: number[], value: number): void {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  for (const b of bytes) out.push(b);
}

/**
 * Encode absolute-seconds notes as a single-track Standard MIDI File, with a
 * leading program change so the whole part plays on one GM instrument.
 */
export function notesToSmf(notes: RenderNote[], program = 0, channel = 0): Uint8Array {
  const ch = channel & 0x0f;
  interface Ev {
    tick: number;
    order: number; // tie-break at equal ticks: note-off (0) before note-on (1)
    data: number[];
  }
  const evs: Ev[] = [{ tick: 0, order: 0, data: [0xc0 | ch, program & 0x7f] }];
  for (const n of notes) {
    const start = Math.max(0, Math.round(n.startSec / SEC_PER_TICK));
    const end = Math.max(start + 1, Math.round((n.startSec + n.durationSec) / SEC_PER_TICK));
    const note = Math.max(0, Math.min(127, Math.round(n.midi)));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
    evs.push({ tick: start, order: 1, data: [0x90 | ch, note, vel] });
    evs.push({ tick: end, order: 0, data: [0x80 | ch, note, 0] });
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  // Tempo meta (FF 51 03 tttttt) at tick 0.
  const usPerQuarter = Math.round(60_000_000 / BPM);
  pushVlq(track, 0);
  track.push(0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
  let last = 0;
  for (const e of evs) {
    pushVlq(track, e.tick - last);
    last = e.tick;
    for (const b of e.data) track.push(b);
  }
  // End of track.
  pushVlq(track, 0);
  track.push(0xff, 0x2f, 0x00);

  const len = track.length;
  const head = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff, // MThd, format 0, 1 track, PPQ
    0x4d, 0x54, 0x72, 0x6b, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, // MTrk + length
  ];
  const out = new Uint8Array(head.length + track.length);
  out.set(head, 0);
  out.set(track, head.length);
  return out;
}
