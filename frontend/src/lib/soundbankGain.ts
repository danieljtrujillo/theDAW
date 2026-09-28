/**
 * Playback gain for downloaded sound banks: the part of a preset's level its
 * samples could not take.
 *
 * `scripts/build_orchestra_sf3.py` levels each preset against the bundled
 * gm.sf3, but peak limits a sample by at most 3 dB, so a quiet, spiky preset
 * (a flute staccato, a horn stab) stays short. The build writes the shortfall
 * into the bank's manifest as `playback_gain`, `{"bank:program": dB}`. This
 * module holds those tables, keyed by the bank registry's bankId, and hands
 * the gain to the synth after the voice:
 *
 *  - live, as the channel's system gain (`setSystemParameter('gain', x)`),
 *    which SpessaSynth multiplies after the voice, so it can pass unity where
 *    CC 7 at 127 cannot (`applyChannelGain`, from the engine's program switch);
 *  - in a render, as the same per-channel gain carried in the snapshot the
 *    offline worklet applies before it plays the MIDI
 *    (`renderGainSnapshot`), because an OfflineAudioContext worklet may
 *    ignore messages sent after the render starts.
 *
 * A channel's gain follows the preset it selects: a bank select (CC 0) plus a
 * program. A bank loaded with a bank offset answers bank selects shifted by
 * that offset, so a registered table is looked up at `bankSelect - offset`.
 * The GM drum channel (n % 16 === 9) selects the kit bank, 128.
 */
import { SpessaSynthProcessor, type BasicMIDI, type SynthesizerSnapshot } from 'spessasynth_core';

export interface SoundbankGainManifest {
  /** `"bank:program"` -> dB the app adds at playback. */
  playback_gain?: Record<string, number>;
}

interface GainTable {
  bankOffset: number;
  gains: Map<string, number>;
}

/** Registered tables, in registration order; the latest registered wins a tie. */
const tables = new Map<string, GainTable>();

/** GM's kit bank: what a drum channel selects. */
export const DRUM_BANK = 128;
/** No gain step past this (dB) is applied, whatever a manifest says. */
export const MAX_PLAYBACK_GAIN_DB = 24;

const key = (bank: number, program: number): string => `${Math.round(bank)}:${Math.round(program)}`;

export const dbToGain = (db: number): number => 10 ** (db / 20);

/**
 * Register a downloaded bank's playback gains under the registry's `bankId`,
 * loaded at `bankOffset`. Replaces an earlier table for the same id. Returns
 * how many preset slots carry a gain.
 */
export function registerSoundbankGains(bankId: string, manifest: SoundbankGainManifest | null | undefined, bankOffset = 0): number {
  const gains = new Map<string, number>();
  for (const [slot, db] of Object.entries(manifest?.playback_gain ?? {})) {
    const m = /^(\d+):(\d+)$/.exec(slot);
    if (!m || typeof db !== 'number' || !Number.isFinite(db)) continue;
    gains.set(key(Number(m[1]), Number(m[2])), Math.max(-MAX_PLAYBACK_GAIN_DB, Math.min(MAX_PLAYBACK_GAIN_DB, db)));
  }
  tables.delete(bankId);
  tables.set(bankId, { bankOffset: Number.isFinite(bankOffset) ? Math.round(bankOffset) : 0, gains });
  return gains.size;
}

export function unregisterSoundbankGains(bankId: string): void {
  tables.delete(bankId);
}

export function clearSoundbankGains(): void {
  tables.clear();
}

/** The playback gain (dB) of preset `bank:program` in bank `bankId`; 0 when none is registered. */
export function soundbankGainDb(bankId: string, bank: number, program: number): number {
  return tables.get(bankId)?.gains.get(key(bank, program)) ?? 0;
}

/**
 * The playback gain (dB) for what a channel selects: bank select `bankSelect`
 * and `program`, across every registered bank at its offset. `channel` makes
 * the GM drum channel select the kit bank.
 */
export function selectionGainDb(bankSelect: number, program: number, channel?: number): number {
  const bank = channel !== undefined && channel % 16 === 9 ? DRUM_BANK : bankSelect;
  let found = 0;
  for (const table of tables.values()) {
    const inFile = bank === DRUM_BANK ? bank : bank - table.bankOffset;
    const db = table.gains.get(key(inFile, program));
    if (db !== undefined) found = db;
  }
  return found;
}

/** Anything with SpessaSynth channels whose system gain can be set: a WorkletSynthesizer or a SpessaSynthProcessor. */
export interface ChannelGainTarget {
  readonly midiChannels: ReadonlyArray<{ setSystemParameter(parameter: 'gain', value: number): void } | undefined>;
}

const applied = new WeakMap<object, Map<number, number>>();
const pending = new WeakMap<object, Map<number, ReturnType<typeof setTimeout>>>();

/**
 * Set channel `ch`'s gain for the preset it now selects. `delaySec` holds the
 * change back until a program change queued that far ahead takes effect, so
 * the note before it keeps its own gain. Setting the gain a channel already
 * has sends nothing.
 */
export function applyChannelGain(target: ChannelGainTarget, ch: number, bankSelect: number, program: number, delaySec = 0): void {
  const gain = dbToGain(selectionGainDb(bankSelect, program, ch));
  const timers = pending.get(target) ?? new Map<number, ReturnType<typeof setTimeout>>();
  pending.set(target, timers);
  const waiting = timers.get(ch);
  if (waiting !== undefined) clearTimeout(waiting);
  timers.delete(ch);
  const set = () => {
    const seen = applied.get(target) ?? new Map<number, number>();
    applied.set(target, seen);
    if ((seen.get(ch) ?? 1) === gain) return;
    try {
      target.midiChannels[ch]?.setSystemParameter('gain', gain);
      seen.set(ch, gain);
    } catch {
      /* a channel that is not there yet keeps unity */
    }
  };
  if (delaySec > 0.005) timers.set(ch, setTimeout(set, delaySec * 1000));
  else set();
}

/**
 * The preset each channel of a MIDI file selects first (the bank select in
 * force at its first program change, channel numbers offset by the track's
 * port as SpessaSynth plays them), and what each channel plays when it never
 * changes program: bank 0, program 0.
 */
export function midiChannelSelections(midi: BasicMIDI): Map<number, { bank: number; program: number }> {
  const bankNow = new Map<number, number>();
  const out = new Map<number, { bank: number; program: number }>();
  const events: Array<{ ticks: number; ch: number; type: number; data: Uint8Array }> = [];
  midi.tracks.forEach((track) => {
    const offset = midi.portChannelOffsetMap?.[track.port] ?? 0;
    for (const e of track.events) {
      const status = e.statusByte as number;
      const type = status & 0xf0;
      if (type !== 0xb0 && type !== 0xc0 && type !== 0x90) continue;
      events.push({ ticks: e.ticks, ch: (status & 0x0f) + offset, type, data: e.data });
    }
  });
  events.sort((a, b) => a.ticks - b.ticks);
  for (const e of events) {
    if (out.has(e.ch)) continue;
    if (e.type === 0xb0 && e.data[0] === 0) bankNow.set(e.ch, e.data[1]);
    else if (e.type === 0xc0) out.set(e.ch, { bank: bankNow.get(e.ch) ?? 0, program: e.data[0] });
    else if (e.type === 0x90 && e.data[1] > 0) out.set(e.ch, { bank: bankNow.get(e.ch) ?? 0, program: 0 });
  }
  return out;
}

/** Channel -> linear gain for a render of `midi`, for the channels whose preset has one. */
export function renderChannelGains(midi: BasicMIDI): Map<number, number> {
  const gains = new Map<number, number>();
  for (const [ch, sel] of midiChannelSelections(midi)) {
    const db = selectionGainDb(sel.bank, sel.program, ch);
    if (db !== 0) gains.set(ch, dbToGain(db));
  }
  return gains;
}

/**
 * The snapshot an offline render applies before it plays `midi`: a fresh
 * synth's state with each channel's playback gain. Undefined when no channel
 * needs one, so a render of the default bank is untouched.
 */
export function renderGainSnapshot(midi: BasicMIDI, sampleRate: number): SynthesizerSnapshot | undefined {
  const gains = renderChannelGains(midi);
  if (gains.size === 0) return undefined;
  // The render synth's own settings: effects on (the default), events off.
  const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
  try {
    const want = Math.max(...gains.keys()) + 1;
    while (synth.midiChannels.length < want) synth.createMIDIChannel();
    for (const [ch, gain] of gains) synth.midiChannels[ch].setSystemParameter('gain', gain);
    return synth.getSnapshot();
  } finally {
    synth.destroySynthProcessor();
  }
}
