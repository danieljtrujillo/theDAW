/**
 * renderTail — how long a soundfont render of a MIDI clip rings past its last
 * note-off, and where the rendered audio falls silent.
 *
 * A released note keeps sounding for its preset's volume-envelope release: a
 * string section for about a second and a half, a harp for five, timpani for
 * nine. A render that stops a fixed 0.6 s after its last event cuts every one
 * of those final chords. The tail here is the longest release among the zones
 * that actually sound the clip's notes (each preset, at each key it plays),
 * capped at RENDER_TAIL_CAP_SEC, and floored at MIN_RENDER_TAIL_SEC so the
 * effects bus has room. The render is then cut where it falls below the 16-bit
 * floor (audibleFrames), so a one-shot sample that ends long before its release
 * does not leave seconds of silence behind it.
 *
 * The release math is the SoundFont 2.04 rule SpessaSynth plays by: an
 * instrument zone's releaseVolEnv (its own, else the instrument's global zone,
 * else the -12000 timecent default) plus the preset zone's offset (its own,
 * else the preset's global zone, else 0), clamped to -12000..8000 timecents,
 * in seconds 2^(tc / 1200). SpessaSynth releases a voice over that whole time
 * to silence (spessasynth_core VolumeEnvelope.startRelease).
 *
 * No Vite-only imports, so node tests load it with the real soundfont.
 */
import { GeneratorTypes, type BasicMIDI, type BasicPreset, type BasicSoundBank, type BasicZone, type GenericRange } from 'spessasynth_core';

/** The shortest tail a soundfont render gets: room for the reverb and chorus returns. */
export const MIN_RENDER_TAIL_SEC = 0.6;
/** The longest: a looped pad or a timpani roll rings out, a one-shot's 30 s release does not render 30 s of silence. */
export const RENDER_TAIL_CAP_SEC = 12;
/** Below this fraction of the render's peak a sample is silence in the 16-bit
 *  WAV the render is saved as (spessasynth_lib audioBufferToWav normalises the
 *  peak to full scale, so one step of 16 bits is the peak / 32768). */
export const SILENCE_FLOOR = 1 / 32768;
/** Kept after the last audible sample, so the cut never lands on a sounding one. */
export const SILENCE_MARGIN_SEC = 0.02;

/** A preset at a key: what one note of a render sounds. */
export interface PresetKey {
  program: number;
  drum: boolean;
  key: number;
}

export type ReleaseLookup = (k: PresetKey) => number;

const MIN_TC = -12000;
const MAX_TC = 8000;
const inRange = (r: GenericRange, key: number): boolean => r.min === -1 || (key >= r.min && key <= r.max);
const generator = (zone: BasicZone, fallback: number): number => zone.getGenerator(GeneratorTypes.releaseVolEnv, fallback);

/** The longest release, in seconds, among the zones of `preset` that sound `key`. 0 when none does. */
export function presetReleaseSec(preset: BasicPreset, key: number): number {
  let longest: number | null = null;
  const presetGlobal = generator(preset.globalZone, 0);
  for (const pz of preset.zones) {
    if (!inRange(pz.keyRange, key)) continue;
    const offset = generator(pz, presetGlobal);
    const inst = pz.instrument;
    const instGlobal = generator(inst.globalZone, MIN_TC);
    for (const iz of inst.zones) {
      if (!inRange(iz.keyRange, key)) continue;
      const tc = Math.max(MIN_TC, Math.min(MAX_TC, generator(iz, instGlobal) + offset));
      longest = longest === null ? tc : Math.max(longest, tc);
    }
  }
  return longest === null ? 0 : 2 ** (longest / 1200);
}

/** Each (preset, key) looked up once. A patch the bank lacks resolves the way the synth resolves it (BasicSoundBank.getPreset). */
export function releaseLookupFromBank(bank: BasicSoundBank): ReleaseLookup {
  const cache = new Map<string, number>();
  return ({ program, drum, key }) => {
    const id = `${drum ? 'd' : 'm'}${program}:${key}`;
    let sec = cache.get(id);
    if (sec === undefined) {
      const preset = bank.getPreset({ program, bankMSB: 0, bankLSB: 0, isGMGSDrum: drum }, 'gs');
      sec = presetReleaseSec(preset, key);
      cache.set(id, sec);
    }
    return sec;
  };
}

/**
 * Every (preset, key) a MIDI file sounds: each note-on with the program its
 * channel holds at that tick (0 until a program change), on the drum channel
 * (9) as a kit. Program changes at a tick apply before the notes at that tick.
 */
export function midiPresetKeys(midi: Pick<BasicMIDI, 'tracks'>): PresetKey[] {
  const events: Array<{ ticks: number; status: number; data: Uint8Array }> = [];
  for (const track of midi.tracks) {
    for (const e of track.events) {
      if (e.statusByte >= 0x80 && e.statusByte < 0xf0) events.push({ ticks: e.ticks, status: e.statusByte, data: e.data });
    }
  }
  const programFirst = (status: number): number => ((status & 0xf0) === 0xc0 ? 0 : 1);
  events.sort((a, b) => a.ticks - b.ticks || programFirst(a.status) - programFirst(b.status));
  const program = new Array<number>(16).fill(0);
  const seen = new Map<string, PresetKey>();
  for (const e of events) {
    const ch = e.status & 0x0f;
    const kind = e.status & 0xf0;
    if (kind === 0xc0) program[ch] = e.data[0] & 0x7f;
    else if (kind === 0x90 && (e.data[1] ?? 0) > 0) {
      const k: PresetKey = { program: program[ch], drum: ch === 9, key: e.data[0] & 0x7f };
      seen.set(`${k.drum ? 'd' : 'm'}${k.program}:${k.key}`, k);
    }
  }
  return [...seen.values()];
}

/** The tail a render of `keys` needs: their longest release, within MIN_RENDER_TAIL_SEC..RENDER_TAIL_CAP_SEC. */
export function renderTailSec(keys: readonly PresetKey[], lookup: ReleaseLookup): number {
  let longest = 0;
  for (const k of keys) longest = Math.max(longest, lookup(k));
  return Math.max(MIN_RENDER_TAIL_SEC, Math.min(RENDER_TAIL_CAP_SEC, longest));
}

/**
 * The frames worth keeping: through the last sample at or above SILENCE_FLOOR
 * of the peak on any channel, plus SILENCE_MARGIN_SEC, never fewer than
 * `floorFrames` and never more than the buffer holds.
 */
export function audibleFrames(channels: readonly Float32Array[], floorFrames: number, sampleRate: number): number {
  const length = channels.reduce((m, c) => Math.max(m, c.length), 0);
  let peak = 0;
  for (const data of channels) for (let i = 0; i < data.length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
  if (peak === 0) return Math.min(length, Math.ceil(floorFrames));
  const threshold = peak * SILENCE_FLOOR;
  let last = -1;
  for (const data of channels) {
    for (let i = data.length - 1; i > last; i -= 1) {
      if (Math.abs(data[i]) >= threshold) {
        last = i;
        break;
      }
    }
  }
  const keep = last + 1 + Math.ceil(SILENCE_MARGIN_SEC * sampleRate);
  return Math.min(length, Math.max(Math.ceil(floorFrames), keep));
}
