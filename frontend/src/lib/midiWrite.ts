/**
 * Minimal Standard MIDI File (type-0) writer.
 *
 * Bridges the app's absolute-seconds note model (`RenderNote`) into SMF bytes so
 * the notes can be fed to engines that render from a parsed MIDI sequence rather
 * than loose notes (SpessaSynth's offline render takes a `BasicMIDI`). Writes a
 * 480 PPQ grid at one tempo, 120 BPM unless given, with a matching tempo meta
 * event, so tick time maps back to the original seconds.
 *
 * Time signatures are written only when given (the .mid export), and then at
 * the roll's tempo: notesToRollSmf puts the notes and the roll's meter on that
 * tempo's grid, where a roll step is PPQ / 4 ticks, so bar lines and notes agree.
 * The .mid export also writes the roll's tempo as a `theDAW:tempomap=` text
 * when FF 51 cannot hold it, as the roll's own export does, so the file
 * reopens at the tempo it was made at.
 *
 * Pitch wheels are written only when given (a soundfont render of a roll with
 * bends): each wheel's range as RPN 0/0 at tick 0 and its messages at their
 * ticks, on its channel, with a note's `channel` choosing where it plays. The
 * range's CC 38 counts 1/128 semitones, the way SpessaSynth reads it, since
 * the soundfont render is what reads these wheels.
 *
 * TIMING: this writer's input is absolute SECONDS, so it is the wrong door for
 * the roll's own .mid export — that goes through `lib/rollMidi.rollToMidiFile`,
 * which writes each note's `tick` straight out at the FILE's PPQ (480 by
 * default, so half the model's 960): no second quantise, but an odd model tick
 * rounds by at most half a file tick. Ask it for `PPQ` and nothing moves. What
 * arrives here (a vocal take, a soundfont render's note list) was never on a
 * tick grid to begin with. `SMF_PPQ` is exported so a caller that DOES hold
 * model ticks can convert once, knowingly, instead of guessing the grid.
 */
import { RANGE_LSB_SPESSA, TEMPOMAP_TEXT, bendRangeMessages, meterEventMetas, pitchWheelMessage, tempoOfMicros } from './midi';
import { tempoMapText } from './rollMidi';
import { meterMapToMidiEvents, type MeterEvent, type MeterSegment } from './meterMap';
import type { RenderNote } from './midiSynth';

/** The ticks-per-quarter grid every file this module writes uses. */
export const SMF_PPQ = 480;
const PPQ = SMF_PPQ;
const DEFAULT_BPM = 120;

/** The tempo meta's microseconds per quarter, and the seconds one tick lasts at that tempo. */
function tempoGrid(bpm: number): { usPerQuarter: number; secPerTick: number } {
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM;
  const usPerQuarter = Math.min(0xffffff, Math.round(60_000_000 / Math.max(20, tempo)));
  return { usPerQuarter, secPerTick: usPerQuarter / 1_000_000 / PPQ };
}

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
 * The roll's meter map as signatures on this writer's grid at the roll's own
 * tempo: a roll step is PPQ / 4 ticks, so each bar start is its roll step times
 * that, and the pickup text counts roll steps.
 */
export function rollMeterToSmfEvents(meterMap: readonly MeterSegment[], pickupSteps: number): MeterEvent[] {
  return meterMapToMidiEvents(meterMap, PPQ, pickupSteps);
}

/** One channel's pitch wheel for notesToSmf: its range in semitones and its messages in seconds (raw 0-16383, 8192 the centre). */
export interface SmfWheel {
  channel: number;
  range: number;
  events: ReadonlyArray<{ sec: number; raw: number }>;
}

/**
 * Encode absolute-seconds notes as a single-track Standard MIDI File, with a
 * leading program change so the whole part plays on one GM instrument.
 * `signatures` sit on the grid of `bpm` (rollMeterToSmfEvents). A note with a
 * `channel` plays there, and `wheel` bends channels; every channel used gets
 * the same program. `texts` are FF 01 text events at tick 0, after the
 * signatures' own metas.
 */
export function notesToSmf(
  notes: RenderNote[],
  program = 0,
  channel = 0,
  signatures: readonly MeterEvent[] = [],
  bpm = DEFAULT_BPM,
  wheel: readonly SmfWheel[] = [],
  texts: readonly string[] = [],
): Uint8Array<ArrayBuffer> {
  const ch = channel & 0x0f;
  const { usPerQuarter, secPerTick } = tempoGrid(bpm);
  interface Ev {
    tick: number;
    order: number; // tie-break at equal ticks: meta (-1), then program and note-off (0), range (0.25), wheel (0.5), then note-on (1)
    data: number[];
  }
  const evs: Ev[] = [{ tick: 0, order: 0, data: [0xc0 | ch, program & 0x7f] }];
  const others = new Set<number>();
  for (const n of notes) if (typeof n.channel === 'number') others.add(n.channel & 0x0f);
  for (const w of wheel) others.add(w.channel & 0x0f);
  others.delete(ch);
  for (const c of [...others].sort((a, b) => a - b)) evs.push({ tick: 0, order: 0, data: [0xc0 | c, program & 0x7f] });
  for (const s of signatures) {
    const tick = Number.isFinite(s.tick) ? Math.max(0, Math.round(s.tick)) : 0;
    for (const data of meterEventMetas(s)) evs.push({ tick, order: -1, data });
  }
  for (const text of texts) {
    const bytes = [...text].map((c) => c.charCodeAt(0) & 0x7f);
    const data = [0xff, 0x01];
    pushVlq(data, bytes.length);
    evs.push({ tick: 0, order: -1, data: [...data, ...bytes] });
  }
  for (const w of wheel) {
    for (const data of bendRangeMessages(w.channel, w.range, RANGE_LSB_SPESSA)) evs.push({ tick: 0, order: 0.25, data });
    let lastTick = -1;
    for (const e of w.events) {
      const tick = Number.isFinite(e.sec) ? Math.max(0, Math.round(e.sec / secPerTick)) : 0;
      // Messages that land on one tick: the last one is the one in force, so it is the one written.
      if (tick === lastTick) evs.pop();
      evs.push({ tick, order: 0.5, data: pitchWheelMessage(w.channel, e.raw) });
      lastTick = tick;
    }
  }
  for (const n of notes) {
    const start = Math.max(0, Math.round(n.startSec / secPerTick));
    const end = Math.max(start + 1, Math.round((n.startSec + n.durationSec) / secPerTick));
    const note = Math.max(0, Math.min(127, Math.round(n.midi)));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
    const nch = typeof n.channel === 'number' ? n.channel & 0x0f : ch;
    evs.push({ tick: start, order: 1, data: [0x90 | nch, note, vel] });
    evs.push({ tick: end, order: 0, data: [0x80 | nch, note, 0] });
  }
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  // Tempo meta (FF 51 03 tttttt) at tick 0.
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

/**
 * The .mid export's bytes: the notes at the roll's tempo with the roll's meter
 * on the same grid, so a signature lands on the bar line its notes are placed
 * against and each note keeps its time in seconds to the tick.
 */
export function notesToRollSmf(
  notes: RenderNote[],
  meter: { meterMap: readonly MeterSegment[]; pickupSteps: number; bpm: number },
): Uint8Array<ArrayBuffer> {
  // FF 51 holds whole microseconds a quarter: 90 BPM (666667 us) reads back as
  // 89.999955, so the typed tempo also rides in the roll's tempo map text
  // (lib/rollMidi midiFileTempoMap reads it back exactly). The notes stay on the
  // FF 51 grid (tempoGrid), which is the tempo every other reader plays.
  const { usPerQuarter } = tempoGrid(meter.bpm);
  const texts = tempoOfMicros(usPerQuarter) === meter.bpm ? [] : [`${TEMPOMAP_TEXT}${tempoMapText([{ beat: 0, bpm: meter.bpm }])}`];
  return notesToSmf(notes, 0, 0, rollMeterToSmfEvents(meter.meterMap, meter.pickupSteps), meter.bpm, [], texts);
}
