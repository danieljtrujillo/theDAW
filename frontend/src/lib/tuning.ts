/**
 * tuning — a project's tuning: the pitch of A4 and a temperament (equal, a
 * meantone, a well temperament, or a Scala scale), as the cents each MIDI key
 * sits off twelve-tone equal temperament at A = 440 Hz.
 *
 * Every voice reads the same numbers. The procedural voices ask `keyHz` for
 * a key's frequency (lib/synthVoiceKit mtof). The soundfont synths and every
 * MIDI file get them as MIDI Tuning Standard messages (`tuningMessages`):
 *
 *   - Master Fine Tuning (universal real time 04 03) carries the reference
 *     pitch, up to 100 cents either way. It leaves drum channels alone.
 *   - Scale/Octave Tuning, 2-byte form (universal real time 08 09), carries
 *     the temperament: one offset per pitch class, sent to every channel but
 *     the drum channel (local 9), plus what the reference needs past 100
 *     cents (A = 415 Hz is 101.3 cents under 440).
 *   - A scale that does not repeat every twelve keys (a Scala file of 19
 *     notes, or a stretched octave), or one that sits more than 100 cents off
 *     a key, goes key by key instead: Single Note Tuning Change (08 02) for
 *     each program, every key's pitch to 1/100 of a cent.
 *
 * SpessaSynth (spessasynth_core 4.3) reads all three: 04 03 into its master
 * fine tune, 08 09 into each channel's octave tuning (whole cents), 08 02
 * into its per-program key table. Its KeyModifier (velocity, patch, gain) has
 * no pitch, so tuning goes through these messages; the same bytes go into
 * exported MIDI files, where any MTS receiver reads them.
 *
 * Pure, so node tests load it.
 */

/** The temperaments the project offers. */
export type TemperamentId = 'equal' | 'meantone' | 'werckmeister3' | 'kirnberger3' | 'vallotti' | 'scala';

/** A Scala scale: its degrees above the tonic in cents, the last one the period (usually 1200). */
export interface ScalaScale {
  name: string;
  description: string;
  /** Degrees 1..n in cents; `cents[n - 1]` is the period. */
  cents: number[];
}

export interface ProjectTuning {
  /** A4 in Hz. */
  referenceHz: number;
  temperament: TemperamentId;
  /** The pitch class a temperament is laid from, and a Scala scale's tonic (0 = C). */
  root: number;
  /** The imported scale, for `temperament: 'scala'`. */
  scala?: ScalaScale | null;
}

export const DEFAULT_TUNING: ProjectTuning = Object.freeze({ referenceHz: 440, temperament: 'equal', root: 0, scala: null }) as ProjectTuning;

/** The reference pitches the project offers by name; any 380-480 Hz is accepted. */
export const REFERENCE_PITCHES: ReadonlyArray<{ hz: number; label: string }> = Object.freeze([
  { hz: 415, label: 'A = 415 (Baroque)' },
  { hz: 430, label: 'A = 430 (Classical)' },
  { hz: 440, label: 'A = 440 (modern)' },
  { hz: 442, label: 'A = 442 (orchestral)' },
]);

export const TEMPERAMENTS: ReadonlyArray<{ id: TemperamentId; label: string }> = Object.freeze([
  { id: 'equal', label: 'Equal temperament' },
  { id: 'meantone', label: 'Quarter-comma meantone' },
  { id: 'werckmeister3', label: 'Werckmeister III' },
  { id: 'kirnberger3', label: 'Kirnberger III' },
  { id: 'vallotti', label: 'Vallotti' },
  { id: 'scala', label: 'Scala scale' },
]);

export const PITCH_CLASS_NAMES = Object.freeze(['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B']);

/** The reference pitches a project takes, in Hz. */
export const REF_MIN_HZ = 380;
export const REF_MAX_HZ = 480;

const PURE_FIFTH = 1200 * Math.log2(3 / 2);
const PYTHAGOREAN_COMMA = 1200 * Math.log2(531441 / 524288);
const SYNTONIC_COMMA = 1200 * Math.log2(81 / 80);
const SCHISMA = PYTHAGOREAN_COMMA - SYNTONIC_COMMA;

/**
 * The twelve fifths of each temperament around the circle from its root
 * (C-G, G-D, D-A, A-E, E-B, B-F♯, F♯-C♯, C♯-G♯, G♯-D♯, D♯-A♯, A♯-F, F-C
 * when the root is C), in cents. They sum to seven octaves.
 */
function fifths(id: TemperamentId): number[] {
  const pure = Array.from({ length: 12 }, () => PURE_FIFTH);
  switch (id) {
    case 'meantone': {
      // Eleven fifths narrowed by a quarter syntonic comma; the wolf between G♯ and E♭.
      const narrow = PURE_FIFTH - SYNTONIC_COMMA / 4;
      const out = Array.from({ length: 12 }, () => narrow);
      out[8] = 8400 - narrow * 11;
      return out;
    }
    case 'werckmeister3':
      // C-G, G-D, D-A and B-F♯ narrowed by a quarter Pythagorean comma.
      for (const i of [0, 1, 2, 5]) pure[i] -= PYTHAGOREAN_COMMA / 4;
      return pure;
    case 'kirnberger3':
      // C-G, G-D, D-A, A-E narrowed by a quarter syntonic comma, F♯-C♯ by the schisma.
      for (const i of [0, 1, 2, 3]) pure[i] -= SYNTONIC_COMMA / 4;
      pure[6] -= SCHISMA;
      return pure;
    case 'vallotti':
      // F-C, C-G, G-D, D-A, A-E, E-B narrowed by a sixth of the Pythagorean comma.
      for (const i of [11, 0, 1, 2, 3, 4]) pure[i] -= PYTHAGOREAN_COMMA / 6;
      return pure;
    default:
      return Array.from({ length: 12 }, () => 700);
  }
}

const pc = (n: number): number => ((Math.round(n) % 12) + 12) % 12;

/**
 * Each pitch class's cents off equal temperament in a temperament laid from
 * `root`, with A at 0, so A sounds at the reference pitch whatever the
 * temperament.
 */
export function temperamentOffsets(id: TemperamentId, root = 0): number[] {
  const out = new Array<number>(12).fill(0);
  if (id === 'equal' || id === 'scala') return out;
  const sizes = fifths(id);
  let pos = 0;
  const r = pc(root);
  for (let i = 0; i < 12; i += 1) {
    const cls = (r + 7 * i) % 12;
    // The class's pitch above the root, folded into the octave, against its equal-tempered place.
    const above = ((pos % 1200) + 1200) % 1200;
    const et = ((cls - r + 12) % 12) * 100;
    let dev = above - et;
    if (dev > 600) dev -= 1200;
    if (dev < -600) dev += 1200;
    out[cls] = dev;
    pos += sizes[i];
  }
  const a = out[9];
  return out.map((d) => d - a);
}

/* ── Scala ─────────────────────────────────────────────────────────────── */

/**
 * A Scala .scl file (https://www.huygens-fokker.org/scala/scl_format.html):
 * `!` lines are comments; the first other line describes the scale, the next
 * counts its notes, then one pitch per line, a number with a period in cents
 * or a ratio (`3/2`, `2`) otherwise, anything after the pitch ignored.
 * Throws with the reason when the text is not a scale.
 */
export function parseScala(text: string, name = 'scale.scl'): ScalaScale {
  const lines = text.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('!'));
  if (lines.length < 2) throw new Error('A Scala file needs a description line and a note count.');
  const description = lines[0].trim();
  const count = Number.parseInt(lines[1].trim(), 10);
  if (!Number.isFinite(count) || count < 1 || count > 1024) throw new Error(`The note count "${lines[1].trim()}" is not a number of notes.`);
  const cents: number[] = [];
  for (const raw of lines.slice(2)) {
    if (cents.length === count) break;
    const token = raw.trim().split(/\s+/)[0];
    if (!token) continue;
    let value: number;
    if (token.includes('.')) {
      value = Number(token);
    } else {
      const [num, den = '1'] = token.split('/');
      const ratio = Number(num) / Number(den);
      value = ratio > 0 ? 1200 * Math.log2(ratio) : Number.NaN;
    }
    if (!Number.isFinite(value)) throw new Error(`"${token}" is not a pitch.`);
    cents.push(value);
  }
  if (cents.length !== count) throw new Error(`The file lists ${cents.length} of its ${count} notes.`);
  if (!(cents[count - 1] > 0)) throw new Error('The last note (the period) must be above the tonic.');
  return { name, description, cents };
}

/* ── the numbers every voice reads ─────────────────────────────────────── */

/** A tuning with every field in range: a reference of 380-480 Hz, a known temperament, a Scala scale only when it has one. */
export function cleanTuning(raw: unknown): ProjectTuning {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TUNING };
  const r = raw as Record<string, unknown>;
  const hz = Number(r.referenceHz ?? r.reference_hz);
  const referenceHz = Number.isFinite(hz) ? Math.max(REF_MIN_HZ, Math.min(REF_MAX_HZ, hz)) : 440;
  const t = String(r.temperament ?? 'equal') as TemperamentId;
  const known = TEMPERAMENTS.some((x) => x.id === t);
  const s = r.scala as Record<string, unknown> | null | undefined;
  const scala =
    s && Array.isArray(s.cents) && s.cents.length > 0 && s.cents.every((c) => typeof c === 'number' && Number.isFinite(c))
      ? { name: String(s.name ?? 'scale.scl'), description: String(s.description ?? ''), cents: (s.cents as number[]).slice(0, 1024) }
      : null;
  const temperament: TemperamentId = known && (t !== 'scala' || scala) ? t : 'equal';
  return { referenceHz, temperament, root: pc(Number(r.root) || 0), scala: temperament === 'scala' ? scala : scala ?? null };
}

/** The reference pitch's cents off A = 440. */
export const referenceCents = (t: ProjectTuning): number => 1200 * Math.log2(t.referenceHz / 440);

/** True for twelve-tone equal temperament at A = 440 (nothing to send). */
export const isStandardTuning = (t: ProjectTuning): boolean =>
  Math.abs(t.referenceHz - 440) < 1e-9 && (t.temperament === 'equal' || (t.temperament === 'scala' && !t.scala));

/** A short text that names a tuning, empty for standard tuning (a render's signature, lib/midiRender). */
export function tuningSignature(t: ProjectTuning): string {
  if (isStandardTuning(t)) return '';
  return JSON.stringify([t.referenceHz, t.temperament, t.root, t.temperament === 'scala' ? t.scala?.cents ?? null : null]);
}

/**
 * Every key's cents off equal temperament at A = 440 (128 entries). A Scala
 * scale puts its tonic on the root's key in octave 4 (C4 = 60 for root 0),
 * repeats every period, and is moved as a whole so that A4 sounds at the
 * reference pitch.
 */
export function keyCents(t: ProjectTuning): number[] {
  const ref = referenceCents(t);
  if (t.temperament === 'scala' && t.scala?.cents.length) {
    const degrees = [0, ...t.scala.cents.slice(0, -1)];
    const n = degrees.length;
    const period = t.scala.cents[t.scala.cents.length - 1];
    const tonic = 60 + pc(t.root);
    const at = (key: number): number => {
      const d = key - tonic;
      const oct = Math.floor(d / n);
      return oct * period + degrees[d - oct * n];
    };
    const a4 = at(69);
    return Array.from({ length: 128 }, (_, k) => ref + at(k) - a4 - (k - 69) * 100);
  }
  const offs = temperamentOffsets(t.temperament, t.root);
  return Array.from({ length: 128 }, (_, k) => ref + offs[k % 12]);
}

let currentCents: number[] = new Array<number>(128).fill(0);

/** Make `t` the tuning keyHz reads (tuningStore calls it on every change). */
export function setCurrentTuning(t: ProjectTuning): void {
  currentCents = keyCents(t);
}

/** A key's frequency in the current tuning; a fractional key keeps its fraction. */
export function keyHz(midi: number): number {
  const k = Math.max(0, Math.min(127, Math.round(midi)));
  return 440 * Math.pow(2, (midi - 69) / 12 + (currentCents[k] ?? 0) / 1200);
}

/* ── MIDI Tuning Standard messages ─────────────────────────────────────── */

/** Every channel but the drum channel (9), as the 08 09 channel mask bytes ff, gg, hh. */
const MELODIC_MASK: readonly [number, number, number] = [0x03, 0x7f & ~(1 << (9 - 7)), 0x7f];

const clamp14 = (v: number): number => Math.max(0, Math.min(16383, Math.round(v)));

/** Master Fine Tuning, up to 100 cents either way: F0 7F 7F 04 03 lsb msb F7. */
export function masterFineTuning(cents: number): number[] {
  const v = clamp14(8192 + cents * 81.92);
  return [0xf0, 0x7f, 0x7f, 0x04, 0x03, v & 0x7f, (v >> 7) & 0x7f, 0xf7];
}

/**
 * Scale/Octave Tuning, 2-byte form, to every channel but the drum channel:
 * F0 7F 7F 08 09 ff gg hh, then each pitch class's offset as 14 bits around
 * 8192 (100 cents either way), F7. Each value is the smallest that a receiver
 * rounding down to whole cents (SpessaSynth) reads as the nearest whole cent.
 */
export function octaveTuning(offsets: readonly number[]): number[] {
  const out = [0xf0, 0x7f, 0x7f, 0x08, 0x09, ...MELODIC_MASK];
  for (let i = 0; i < 12; i += 1) {
    const whole = Math.max(-100, Math.min(99, Math.round(offsets[i] ?? 0)));
    const v = clamp14(8192 + Math.ceil(whole * 81.92));
    out.push((v >> 7) & 0x7f, v & 0x7f);
  }
  out.push(0xf7);
  return out;
}

/**
 * Single Note Tuning Change for `program` (F0 7F 7F 08 02 program count
 * [key, semitone, fraction MSB, fraction LSB]... F7), at most 127 keys to a
 * message: each key to its pitch in semitones above note 0 of A = 440 equal
 * temperament, the fraction in 1/16384 of a semitone.
 */
export function keyTuningMessages(program: number, cents: readonly number[]): number[][] {
  const entries: number[][] = [];
  for (let k = 0; k < 128; k += 1) {
    const pitch = Math.max(0, Math.min(127.9999, k + (cents[k] ?? 0) / 100));
    let semi = Math.floor(pitch);
    let frac = Math.round((pitch - semi) * 16384);
    if (frac >= 16384) {
      semi += 1;
      frac = 0;
    }
    if (semi > 127) {
      semi = 127;
      frac = 16383;
    }
    entries.push([k, semi, (frac >> 7) & 0x7f, frac & 0x7f]);
  }
  const out: number[][] = [];
  for (let i = 0; i < entries.length; i += 127) {
    const chunk = entries.slice(i, i + 127);
    out.push([0xf0, 0x7f, 0x7f, 0x08, 0x02, program & 0x7f, chunk.length, ...chunk.flat(), 0xf7]);
  }
  return out;
}

/** How a tuning goes to a synth: master and octave tuning, or key by key. */
export interface TuningPlan {
  mode: 'octave' | 'keys';
  /** The reference sent as Master Fine Tuning (0 in key mode). */
  masterCents: number;
  /** Each pitch class's offset after the master (octave mode). */
  octave: number[];
  /** Every key's cents (key mode). */
  keys: number[];
}

/** The messages `t` needs: none for standard tuning. */
export function tuningPlan(t: ProjectTuning): TuningPlan {
  const keys = keyCents(t);
  const periodic = keys.every((c, k) => k + 12 >= 128 || Math.abs(c - keys[k + 12]) < 1e-6);
  const master = Math.max(-100, Math.min(100, referenceCents(t)));
  const octave = Array.from({ length: 12 }, (_, i) => keys[60 + i] - master);
  if (periodic && octave.every((c) => c >= -100 && c < 99.5)) return { mode: 'octave', masterCents: master, octave, keys };
  return { mode: 'keys', masterCents: 0, octave: new Array<number>(12).fill(0), keys };
}

/**
 * The tuning's MTS messages, each a whole message from F0 to F7: nothing for
 * standard tuning; else Master Fine Tuning and Scale/Octave Tuning, or, for a
 * scale that needs it, Single Note Tuning for every program.
 */
export function tuningMessages(t: ProjectTuning): number[][] {
  if (isStandardTuning(t)) return [];
  const plan = tuningPlan(t);
  if (plan.mode === 'octave') return [masterFineTuning(plan.masterCents), octaveTuning(plan.octave)];
  const out: number[][] = [masterFineTuning(0), octaveTuning(new Array<number>(12).fill(0))];
  for (let p = 0; p < 128; p += 1) out.push(...keyTuningMessages(p, plan.keys));
  return out;
}

/** The messages that put a synth back on standard tuning after `t` (clears key tables when `t` used them). */
export function resetMessages(t: ProjectTuning | null): number[][] {
  const out: number[][] = [masterFineTuning(0), octaveTuning(new Array<number>(12).fill(0))];
  if (t && !isStandardTuning(t) && tuningPlan(t).mode === 'keys') {
    for (let p = 0; p < 128; p += 1) out.push(...keyTuningMessages(p, new Array<number>(128).fill(0)));
  }
  return out;
}

/* ── MIDI files ────────────────────────────────────────────────────────── */

const varLen = (n: number): number[] => {
  const bytes = [n & 0x7f];
  let v = n >> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
};

/**
 * A Standard MIDI File with `messages` (each F0 ... F7) at tick 0 of its
 * first track, ahead of every event in it, so a player tunes before the first
 * note. The file comes back unchanged when there is nothing to add or it has
 * no track.
 */
export function withSysexAtStart(smf: Uint8Array<ArrayBuffer>, messages: readonly number[][]): Uint8Array<ArrayBuffer> {
  if (!messages.length || smf.length < 22) return smf;
  if (String.fromCharCode(...smf.subarray(0, 4)) !== 'MThd') return smf;
  const headerLen = new DataView(smf.buffer, smf.byteOffset, smf.byteLength).getUint32(4);
  let pos = 8 + headerLen;
  while (pos + 8 <= smf.length) {
    const id = String.fromCharCode(...smf.subarray(pos, pos + 4));
    const len = new DataView(smf.buffer, smf.byteOffset + pos + 4, 4).getUint32(0);
    if (id !== 'MTrk') {
      pos += 8 + len;
      continue;
    }
    const events: number[] = [];
    for (const m of messages) {
      const body = m[0] === 0xf0 ? m.slice(1) : m;
      events.push(0x00, 0xf0, ...varLen(body.length), ...body);
    }
    const out = new Uint8Array(smf.length + events.length);
    out.set(smf.subarray(0, pos + 8), 0);
    new DataView(out.buffer).setUint32(pos + 4, len + events.length);
    out.set(events, pos + 8);
    out.set(smf.subarray(pos + 8), pos + 8 + events.length);
    return out;
  }
  return smf;
}
