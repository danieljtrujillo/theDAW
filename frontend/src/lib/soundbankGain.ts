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
 *    ignore messages sent after the render starts. The snapshot holds each
 *    channel's first preset; a later program change to a preset with another
 *    gain is followed on the synth's own output for that channel, a gain node
 *    stepped at the change's second (`renderGainSteps`, `routeRenderGains`).
 *    The synth's shared reverb/chorus output cannot be split by channel, so
 *    it keeps each channel's first-preset gain; the render's whole sum, that
 *    output included, goes through the safety limiter whenever the file plays
 *    a lifted preset (lib/synthOutputStage wireRenderOutput), so it cannot
 *    pass -0.3 dBFS.
 *
 * Registration caps a lift so a single velocity-127 note at CC 7 127 stays
 * under -0.3 dBFS (the manifest's `levelling` clip check gives each preset's
 * peak): the safety limiter then acts only on a sum, never on a lone note.
 *
 * A channel's gain follows the preset it selects: a bank select (CC 0) plus a
 * program. A bank loaded with a bank offset answers bank selects shifted by
 * that offset, so a registered table is looked up at `bankSelect - offset`.
 * The GM drum channel (n % 16 === 9) selects the kit bank, 128, where the
 * bundled bank's kit plays at every program it has one (SpessaSynth takes the
 * first bank's kit), so no user bank's kit gain applies there.
 */
import { SpessaSynthProcessor, type BasicMIDI, type SynthesizerSnapshot } from 'spessasynth_core';

export interface SoundbankGainManifest {
  /** `"bank:program"` -> dB the app adds at playback. */
  playback_gain?: Record<string, number>;
  /**
   * The build's levelling table (scripts/build_orchestra_sf3.py): each
   * preset's clip check, whose `output_peak` is the linear peak of a
   * velocity-127 note on its loudest zone at the default CC 7 (100) with no
   * playback gain.
   */
  levelling?: { presets?: Array<{ bank?: number; program?: number; clip_check?: { output_peak?: number } | null }> };
}

/** The ceiling a single note is held under at registration (dBFS): the safety limiter's (lib/synthOutputStage). */
export const SINGLE_NOTE_CEILING_DB = -0.3;
/** Headroom kept under that ceiling for the notes the clip check did not play (dB). */
export const SINGLE_NOTE_MARGIN_DB = 0.2;
/** A velocity-127 note at CC 7 127 over one at the default CC 7 of 100: SpessaSynth's volume is the square of CC 7. */
const CC7_FULL_OVER_DEFAULT_DB = 40 * Math.log10(127 / 100);

/**
 * The most playback gain (dB) preset output peak `outputPeak` (linear, a
 * velocity-127 note at CC 7 100 with no gain) takes and still plays a single
 * velocity-127 note at CC 7 127 under SINGLE_NOTE_CEILING_DB, less
 * SINGLE_NOTE_MARGIN_DB.
 */
export function singleNoteGainCapDb(outputPeak: number): number {
  const peakDb = 20 * Math.log10(Math.max(outputPeak, 1e-9));
  return SINGLE_NOTE_CEILING_DB - SINGLE_NOTE_MARGIN_DB - CC7_FULL_OVER_DEFAULT_DB - peakDb;
}

interface GainTable {
  bankOffset: number;
  gains: Map<string, number>;
}

/** Registered tables, in registration order; the latest registered wins a tie. */
const tables = new Map<string, GainTable>();

/** GM's kit bank: what a drum channel selects. */
export const DRUM_BANK = 128;

/** The kit programs the bundled bank holds (soundBankStore setBundledPresets). */
let bundledKits: ReadonlySet<number> = new Set();

/** Name the bundled bank's kit programs: a drum channel selecting one plays the bundled kit, at unity. */
export function setBundledKits(programs: Iterable<number>): void {
  bundledKits = new Set([...programs].map((p) => Math.round(p)));
}
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
  // Each preset's single-note cap, from the build's clip check where it has one.
  const caps = new Map<string, number>();
  for (const row of manifest?.levelling?.presets ?? []) {
    const peak = row?.clip_check?.output_peak;
    if (typeof row?.bank !== 'number' || typeof row.program !== 'number' || typeof peak !== 'number' || !(peak > 0)) continue;
    caps.set(key(row.bank, row.program), singleNoteGainCapDb(peak));
  }
  const gains = new Map<string, number>();
  for (const [slot, db] of Object.entries(manifest?.playback_gain ?? {})) {
    const m = /^(\d+):(\d+)$/.exec(slot);
    if (!m || typeof db !== 'number' || !Number.isFinite(db)) continue;
    const k = key(Number(m[1]), Number(m[2]));
    // A lift is capped so a single velocity-127 note at CC 7 127 stays under the ceiling; a cut is kept as it is.
    const cap = caps.get(k);
    const capped = db > 0 && cap !== undefined ? Math.max(0, Math.min(db, cap)) : db;
    gains.set(k, Math.max(-MAX_PLAYBACK_GAIN_DB, Math.min(MAX_PLAYBACK_GAIN_DB, capped)));
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
  // The bundled kit plays there, whatever kit a user bank also has at that program.
  if (bank === DRUM_BANK && bundledKits.has(Math.round(program))) return 0;
  let found = 0;
  for (const table of tables.values()) {
    const inFile = bank === DRUM_BANK ? bank : bank - table.bankOffset;
    const db = table.gains.get(key(inFile, program));
    if (db !== undefined) found = db;
  }
  return found;
}

/** True when any of `voices` (a bank select, a program, and a drum voice's flag) plays a preset its playback gain lifts above unity. */
export function anyLiftedVoice(voices: Iterable<{ bank?: number; program?: number; percussion?: boolean }>): boolean {
  for (const v of voices) {
    if (v.program === undefined) continue;
    if (selectionGainDb(v.bank ?? 0, v.program, v.percussion ? 9 : 0) > 0) return true;
  }
  return false;
}

/** Anything with SpessaSynth channels whose system gain can be set: a WorkletSynthesizer or a SpessaSynthProcessor. */
export interface ChannelGainTarget {
  readonly midiChannels: ReadonlyArray<{ setSystemParameter(parameter: 'gain', value: number): void } | undefined>;
}

const applied = new WeakMap<object, Map<number, number>>();

/**
 * Set channel `ch`'s gain for the preset it now selects. `delaySec` holds the
 * change back until a program change queued that far ahead takes effect, so
 * the note before it keeps its own gain. Every queued change takes effect at
 * its own time, in time order, as the synth's own queue plays the program
 * changes (a queued SpessaSynth event cannot be taken back), so two program
 * changes one lookahead window holds each bring their preset's gain. Setting
 * the gain a channel already has sends nothing.
 */
export function applyChannelGain(target: ChannelGainTarget, ch: number, bankSelect: number, program: number, delaySec = 0): void {
  const gain = dbToGain(selectionGainDb(bankSelect, program, ch));
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
  if (delaySec > 0.005) setTimeout(set, delaySec * 1000);
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

/** One step of a channel's render gain: from `sec` on, its dry output plays at `gain` (linear). */
export interface RenderGainStep {
  sec: number;
  gain: number;
}

/**
 * The playback gain (dB) each channel of `midi` plays at, from its first
 * selection (the snapshot's, midiChannelSelections) through each program
 * change after it, at the tick it takes effect.
 */
function channelGainTimeline(midi: BasicMIDI): Map<number, Array<{ ticks: number; db: number }>> {
  interface Ev { ticks: number; ch: number; type: number; data: Uint8Array }
  const events: Ev[] = [];
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
  const out = new Map<number, Array<{ ticks: number; db: number }>>();
  for (const [ch, sel] of midiChannelSelections(midi)) out.set(ch, [{ ticks: 0, db: selectionGainDb(sel.bank, sel.program, ch) }]);
  const bankNow = new Map<number, number>();
  const seenFirst = new Set<number>();
  for (const e of events) {
    if (e.type === 0xb0) {
      if (e.data[0] === 0) bankNow.set(e.ch, e.data[1]);
      continue;
    }
    if (e.type === 0x90) {
      if (e.data[1] > 0) seenFirst.add(e.ch);
      continue;
    }
    // A program change. The channel's first selection is the snapshot's.
    if (!seenFirst.has(e.ch)) {
      seenFirst.add(e.ch);
      continue;
    }
    out.get(e.ch)?.push({ ticks: e.ticks, db: selectionGainDb(bankNow.get(e.ch) ?? 0, e.data[0], e.ch) });
  }
  return out;
}

/**
 * The gain steps a render of `midi` puts on each synth output (a channel's
 * dry output, `channel % 16`) so a program change partway through the file
 * plays its new preset's playback gain. Each step is relative to the gain the
 * snapshot gave the channel (its first preset, midiChannelSelections), so a
 * channel that keeps one preset has no step and its output is left alone.
 *
 * The synth sends each channel's reverb and chorus to one shared effects
 * output, which follows the first preset's gain. An output two channels of the
 * file share (channels 16 apart, on a second port) takes no steps: a step
 * there would move the other channel too.
 */
export function renderGainSteps(midi: BasicMIDI): Map<number, RenderGainStep[]> {
  const timeline = channelGainTimeline(midi);
  const usersOf = new Map<number, number>();
  for (const ch of timeline.keys()) usersOf.set(ch % 16, (usersOf.get(ch % 16) ?? 0) + 1);
  const byOutput = new Map<number, RenderGainStep[]>();
  for (const [ch, [base, ...changes]] of timeline) {
    const list: RenderGainStep[] = [];
    let now = base.db;
    for (const c of changes) {
      if (c.db === now) continue;
      now = c.db;
      list.push({ sec: midi.midiTicksToSeconds(c.ticks), gain: dbToGain(c.db - base.db) });
    }
    if (list.length === 0 || (usersOf.get(ch % 16) ?? 0) > 1) continue;
    byOutput.set(ch % 16, list);
  }
  return byOutput;
}

/**
 * True when some channel of `midi` plays a preset whose playback gain lifts
 * it above unity (over 0 dB) at some point: the render then puts the safety
 * limiter after the synth (lib/synthOutputStage), so a chord in that preset
 * cannot clip.
 */
export function renderBoosted(midi: BasicMIDI): boolean {
  for (const list of channelGainTimeline(midi).values()) if (list.some((x) => x.db > 0)) return true;
  return false;
}

/** The parts of a WorkletSynthesizer `routeRenderGains` wires. */
export interface ChannelOutputs {
  connectChannel(target: AudioNode, channel: number): AudioNode;
  disconnectChannel(target: AudioNode, channel: number): void;
}

/**
 * Put each output of `steps` (renderGainSteps) through a gain node stepped at
 * its program changes, between the synth and `destination`. The synth must
 * already be connected to `destination` (all seventeen outputs). Returns the
 * nodes made, one per stepped output.
 */
export function routeRenderGains(
  ctx: Pick<BaseAudioContext, 'createGain'>,
  synth: ChannelOutputs,
  destination: AudioNode,
  steps: ReadonlyMap<number, readonly RenderGainStep[]>,
): GainNode[] {
  const made: GainNode[] = [];
  for (const [output, list] of steps) {
    const node = ctx.createGain();
    node.gain.setValueAtTime(1, 0);
    for (const step of list) node.gain.setValueAtTime(step.gain, Math.max(0, step.sec));
    synth.disconnectChannel(destination, output);
    synth.connectChannel(node, output);
    node.connect(destination);
    made.push(node);
  }
  return made;
}
