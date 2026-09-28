/**
 * SoundFont synthesis engine (SpessaSynth) — the sample/soundfont voice that
 * `midiSynth` delegates to when a soundfont instrument is active. When soundfonts
 * are off or fail to load, callers fall back to midiSynth's built-in sawtooth
 * ("Basic"), so nothing breaks if the soundfont asset is missing.
 *
 * Live preview runs on the app's shared AudioContext (playerStore). Offline
 * bounce builds its own OfflineAudioContext, mirroring midiSynth's render path,
 * so MIDI rendered to WAV (Library, sendToTargets, PianoRoll) uses the soundfont
 * too. Arbitrary notes are bridged to a MIDI sequence via `notesToSmf`, since
 * SpessaSynth renders from a parsed MIDI rather than loose notes.
 *
 * Live synths: the PREVIEW synth plays the piano roll's lanes, the
 * arpeggiator, the hardware keyboard, the Sway pads, DRAW and every preview, all
 * to the engine master. EDIT's live MIDI plays on EDIT BANKS, synths of its own
 * with sixteen channels each (lib/editChannels), whose channels are routed into
 * the tracks' strips. The two never share a channel.
 */
import { create } from 'zustand';
import { WorkletSynthesizer, audioBufferToWav } from 'spessasynth_lib';
import { BasicMIDI, MIDIControllers, SoundBankLoader, type MIDIController } from 'spessasynth_core';
import { getEngineCtx, getMasterGain } from '../state/playerStore';
import { RANGE_LSB_SPESSA, bendRangeMessages, controlMessage } from './midi';
import { addWorkletModule } from './audioWorkletSupport';
import { notesToSmf, type SmfControl, type SmfWheel } from './midiWrite';
import type { RenderNote } from './midiSynth';
import type { GlobalVoice } from './clipProgram';
import { applyChannelGain, renderGainSnapshot } from './soundbankGain';
import { MAX_PREVIEW_CHANNELS, PREVIEW_CHANNEL_COUNT } from './pitchBend';
import { MAX_EDIT_BANKS, bankOfChannel, localChannel } from './editChannels';
import {
  RENDER_TAIL_CAP_SEC,
  keptRenderFrames,
  midiPresetKeys,
  releaseLookupFromBank,
  renderSpan,
  renderTailSec,
  type ReleaseLookup,
  type RenderLength,
} from './renderTail';

/** Bundled default General MIDI soundfont, served from frontend/public. */
const DEFAULT_SOUNDFONT_URL = '/soundfonts/gm.sf3';

interface SoundfontState {
  /** Live synth is initialized and the soundfont is loaded. */
  ready: boolean;
  /** A load is in flight. */
  loading: boolean;
  /** Last load error, if any (lets the UI show a fallback notice). */
  loadError: string | null;
  /** When false, MIDI uses the built-in sawtooth instead of the soundfont. */
  useSoundfont: boolean;
  /** Active General MIDI program (0-127). */
  activeProgram: number;
  /** Active procedural synth voice id (see synthVoices); null = soundfont/basic. */
  activeSynthVoice: string | null;
  setUseSoundfont: (b: boolean) => void;
  setActiveProgram: (p: number) => void;
  setActiveSynthVoice: (id: string | null) => void;
}

export const useSoundfontStore = create<SoundfontState>((set) => ({
  ready: false,
  loading: false,
  loadError: null,
  // Default to the bundled soundfont's Bright Acoustic Piano (GM program 1)
  // instead of the raw sawtooth; falls back to the sawtooth if it fails to load.
  useSoundfont: true,
  activeProgram: 1,
  activeSynthVoice: null,
  // The three instrument modes are mutually exclusive: a soundfont program, a
  // procedural synth voice, or neither ("basic" sawtooth).
  setUseSoundfont: (b) => set(b ? { useSoundfont: true, activeSynthVoice: null } : { useSoundfont: false }),
  setActiveProgram: (p) => set({ activeProgram: Math.max(0, Math.min(127, Math.round(p))) }),
  setActiveSynthVoice: (id) => set(id ? { activeSynthVoice: id, useSoundfont: false } : { activeSynthVoice: null }),
}));

/** True when MIDI should render through a soundfont instead of the sawtooth. */
export const isSoundfontActive = (): boolean => useSoundfontStore.getState().useSoundfont;
/** The active GM program (0-127). */
export const getActiveProgram = (): number => useSoundfontStore.getState().activeProgram;
/** The picker's state as lib/clipProgram reads it: whether soundfonts are on and the program. */
export const getGlobalVoice = (): GlobalVoice => {
  const { useSoundfont, activeProgram } = useSoundfontStore.getState();
  return { useSoundfont, activeProgram };
};
/** The active procedural synth voice id, or null when on soundfont/basic. */
export const getActiveSynthVoice = (): string | null => useSoundfontStore.getState().activeSynthVoice;

let sfPromise: Promise<ArrayBuffer> | null = null;
function loadDefaultSoundfont(): Promise<ArrayBuffer> {
  if (!sfPromise) {
    useSoundfontStore.setState({ loading: true, loadError: null });
    sfPromise = fetch(DEFAULT_SOUNDFONT_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`soundfont HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((ab) => {
        useSoundfontStore.setState({ loading: false });
        return ab;
      })
      .catch((e: unknown) => {
        useSoundfontStore.setState({
          loading: false,
          loadError: e instanceof Error ? e.message : String(e),
        });
        sfPromise = null; // allow a later retry
        throw e;
      });
  }
  return sfPromise;
}

/**
 * URL of the SpessaSynth AudioWorklet processor, resolved lazily.
 *
 * Vite rewrites this `?url` specifier to the same emitted asset whether it is
 * written as a static or a dynamic import, so the URL handed to `addModule` is
 * unchanged. Importing it dynamically means merely importing this module no
 * longer evaluates a Vite-only specifier, which Node/tsx (the frontend test
 * runner) cannot resolve. Memoized, so the dynamic import is evaluated once.
 */
let processorUrlPromise: Promise<string> | null = null;
function getProcessorUrl(): Promise<string> {
  if (!processorUrlPromise) {
    processorUrlPromise = import('spessasynth_lib/dist/spessasynth_processor.min.js?url')
      .then((m) => m.default)
      .catch((e: unknown) => {
        processorUrlPromise = null;
        throw e;
      });
  }
  return processorUrlPromise;
}

/** A live synth on the engine context, wired to the master, with the default soundfont loaded. */
async function createLiveSynth(): Promise<WorkletSynthesizer> {
  const ctx = getEngineCtx();
  await addWorkletModule(ctx, await getProcessorUrl());
  const synth = new WorkletSynthesizer(ctx);
  synth.connect(getMasterGain());
  const sf = await loadDefaultSoundfont();
  // Pass a copy: the worklet transfers (detaches) the buffer it receives, and
  // the cached `sf` is reused by the offline render path too.
  await synth.soundBankManager.addSoundBank(sf.slice(0), 'main');
  await synth.isReady;
  return synth;
}

let liveSynth: WorkletSynthesizer | null = null;
let liveSynthPromise: Promise<WorkletSynthesizer> | null = null;
/** The bank and program each preview channel was last switched to, as programSwitch keys them. */
const channelProgram = new Map<number, number>();
/** How many channels the preview synth has now: PREVIEW_CHANNEL_COUNT, and more as the roll's parts ask for them. */
let previewChannels = 0;
function getLiveSynth(): Promise<WorkletSynthesizer> {
  if (!liveSynthPromise) {
    liveSynthPromise = (async () => {
      const synth = await createLiveSynth();
      // Channel 16 is the hardware keyboard's (KEYBOARD_LIVE_CHANNEL) and 17-24
      // are DRAW's (DRAW_LIVE_CHANNELS). The preview synth plays every channel
      // to the engine master, so sharing a dry output with channel n % 16 changes nothing.
      for (let ch = 16; ch < PREVIEW_CHANNEL_COUNT; ch += 1) synth.addNewChannel();
      previewChannels = PREVIEW_CHANNEL_COUNT;
      liveSynth = synth;
      channelProgram.clear();
      useSoundfontStore.setState({ ready: true });
      return synth;
    })().catch((e: unknown) => {
      liveSynthPromise = null;
      throw e;
    });
  }
  return liveSynthPromise;
}

/** A preview-synth channel: 0-15, the keyboard's 16, DRAW's 17-24, or a roll part's from 25 up to MAX_PREVIEW_CHANNELS - 1. */
const previewChannel = (channel: number): number =>
  Math.max(0, Math.min(MAX_PREVIEW_CHANNELS - 1, Number.isFinite(channel) ? Math.round(channel) : 0));

/**
 * Make sure the preview synth has channel `ch`, adding channels up to it. The
 * roll's parts after the first play on channels past DRAW's (lib/rollTracks
 * rollLiveChannels), which the synth does not start with. Every channel plays
 * to the engine master, so one past fifteen sharing a dry output with
 * channel n % 16 changes nothing.
 */
function ensurePreviewChannel(synth: WorkletSynthesizer, ch: number): void {
  while (previewChannels <= ch && previewChannels < MAX_PREVIEW_CHANNELS) {
    synth.addNewChannel();
    previewChannels += 1;
  }
}

/**
 * Warm up the engine (worklet + soundfont) ahead of first use so the first note
 * is not delayed. Safe to call repeatedly; resolves false if the soundfont could
 * not be loaded (caller stays on the sawtooth).
 */
export async function ensureSoundfontReady(): Promise<boolean> {
  try {
    await getLiveSynth();
    return true;
  } catch {
    return false;
  }
}

/** A 0-127 data byte, or 0 for anything that is not a number. */
const dataByte = (v: number): number => Math.max(0, Math.min(127, Number.isFinite(v) ? Math.round(v) : 0));

/**
 * The messages that switch a channel whose last switch was `previous` (a key
 * this returns; undefined for a channel never switched) to `program` in bank
 * `bank` (CC 0, the MSB) and `bankLsb` (CC 32; undefined for a part that has
 * none): the bank select, MSB then LSB, when either differs from the
 * channel's, then the program change, as MIDI orders them. A channel that last
 * had an LSB and now has none is sent LSB 0, so the old one does not pick
 * the preset. `key` is what the channel plays after them; the same key as
 * `previous` sends nothing.
 */
export function programSwitch(
  previous: number | undefined,
  program: number,
  bank = 0,
  bankLsb?: number,
): { key: number; controllers: Array<[controller: 0 | 32, value: number]>; program: number | null } {
  const p = dataByte(program);
  const b = dataByte(bank);
  const lsb = bankLsb === undefined || !Number.isFinite(bankLsb) ? undefined : dataByte(bankLsb);
  // (LSB + 1) * 16384 + MSB * 128 + program: LSB -1 is "none sent".
  const key = ((lsb ?? -1) + 1) * 16384 + b * 128 + p;
  if (previous === key) return { key, controllers: [], program: null };
  const had = previous ?? 0;
  const hadBank = Math.floor((had % 16384) / 128);
  // The LSB the channel holds: the last one sent, else 0 (a channel's reset).
  const hadLsb = Math.max(0, Math.floor(had / 16384) - 1);
  // What CC 32 has to say: the part's LSB, or 0 to clear one the channel holds.
  const wantLsb = lsb ?? (hadLsb > 0 ? 0 : undefined);
  const controllers: Array<[0 | 32, number]> = [];
  if (b !== hadBank || (wantLsb !== undefined && wantLsb !== hadLsb)) {
    controllers.push([0, b]);
    if (wantLsb !== undefined) controllers.push([32, wantLsb]);
  }
  return { key, controllers, program: p };
}

/**
 * Switch a channel to `program` when it plays another one, and remember it in
 * `programs` (that synth's map), so every caller on that channel (a preview, a
 * roll lane, the keyboard) knows what the channel plays and switches it back
 * when it needs its own. With a `time` (audio-context seconds) the change is
 * queued on the synth for then, so a note scheduled ahead switches the channel
 * at its own moment and not while the note before it is still sounding. The
 * bank select before it is `programSwitch`'s: CC 0, and CC 32 for a part
 * that has a bank LSB.
 */
function setChannelProgram(
  synth: WorkletSynthesizer,
  ch: number,
  program: number,
  programs = channelProgram,
  bank = 0,
  time?: number,
  bankLsb?: number,
): void {
  const change = programSwitch(programs.get(ch), program, bank, bankLsb);
  if (change.program === null) return;
  const at = time !== undefined ? { time } : undefined;
  for (const [controller, value] of change.controllers) {
    synth.controllerChange(ch, controller === 0 ? MIDIControllers.bankSelect : MIDIControllers.bankSelectLSB, value, at);
  }
  synth.programChange(ch, change.program, at);
  programs.set(ch, change.key);
  // A downloaded bank's playback gain for this preset (lib/soundbankGain), from the program change on.
  applyChannelGain(synth, ch, dataByte(bank), change.program, time !== undefined ? time - getEngineCtx().currentTime : 0);
}

/**
 * Play a single note live through the soundfont on `channel` (0 unless the
 * caller keeps a channel of its own), at audio-context time `when` (now when
 * left out or already past) for `durationSec`, with `program` (the global
 * picker's when left out). The note-on and note-off are timed on the synth, so
 * a note lands with the wheel messages sent for the same time. Failure-safe
 * (no throw).
 */
export async function previewNoteSF(
  midi: number,
  velocity: number,
  durationSec: number,
  channel = 0,
  when?: number,
  program?: number,
  bank = 0,
): Promise<void> {
  try {
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    const synth = await getLiveSynth();
    const ch = previewChannel(channel);
    ensurePreviewChannel(synth, ch);
    setChannelProgram(synth, ch, program ?? getActiveProgram(), channelProgram, bank);
    const note = Math.round(midi);
    // A time that passed while the synth loaded plays now, and the note keeps its length.
    const start = Math.max(when ?? 0, ctx.currentTime);
    synth.noteOn(ch, note, Math.max(1, Math.min(127, Math.round(velocity))), { time: start });
    synth.noteOff(ch, note, { time: start + Math.max(0.04, durationSec) });
  } catch {
    /* swallow: the caller decides whether to fall back to the sawtooth */
  }
}

/**
 * Each preset's release by key, read once from the default soundfont on the
 * main thread (lib/renderTail). A soundfont the parser refuses gives every note
 * the longest tail, which the silence cut then trims, so no final chord is cut.
 */
let releaseLookupPromise: Promise<ReleaseLookup> | null = null;
function getReleaseLookup(sf: ArrayBuffer): Promise<ReleaseLookup> {
  if (!releaseLookupPromise) {
    releaseLookupPromise = Promise.resolve()
      .then(() => releaseLookupFromBank(SoundBankLoader.fromArrayBuffer(sf.slice(0))))
      .catch((): ReleaseLookup => () => RENDER_TAIL_CAP_SEC);
  }
  return releaseLookupPromise;
}

/** The first `frames` of `buffer`, or `buffer` itself when that is all of it. */
function leadingFrames(buffer: AudioBuffer, frames: number): AudioBuffer {
  if (frames >= buffer.length) return buffer;
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: Math.max(1, frames), sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c += 1) out.copyToChannel(buffer.getChannelData(c).subarray(0, out.length), c);
  return out;
}

async function renderMidiToBlob(
  midiBytes: ArrayBuffer,
  sampleRate: number,
  opts: RenderLength,
): Promise<{ blob: Blob; duration: number }> {
  const sf = await loadDefaultSoundfont();
  const midi = BasicMIDI.fromArrayBuffer(midiBytes, 'render');
  // The span (lib/renderTail renderSpan): at least the last event and
  // minDurationSec, and past the last event a fixed tail or the ring-out.
  const lookup = opts.tailSec === undefined ? await getReleaseLookup(sf) : null;
  const span = renderSpan(midi.duration, opts, () => (lookup ? renderTailSec(midiPresetKeys(midi), lookup) : RENDER_TAIL_CAP_SEC));
  const length = Math.max(1, Math.ceil(sampleRate * span.renderSec));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, sampleRate, length });
  await addWorkletModule(ctx, await getProcessorUrl());
  const synth = new WorkletSynthesizer(ctx, { eventsEnabled: false });
  synth.connect(ctx.destination);
  await synth.startOfflineRender({
    midiSequence: midi,
    // Copy: startOfflineRender transfers (detaches) the buffer, but `sf` is the
    // shared cached soundfont reused by the live synth and later renders.
    soundBankList: [{ bankOffset: 0, soundBankBuffer: sf.slice(0) }],
    loopCount: 0,
    // Each channel's playback gain for a downloaded bank's preset (lib/soundbankGain).
    snapshot: renderGainSnapshot(midi, sampleRate),
  });
  await synth.isReady;
  const rendered = await ctx.startRendering();
  const out = leadingFrames(
    rendered,
    keptRenderFrames(span, Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c)), sampleRate),
  );
  const wav: unknown = audioBufferToWav(out);
  const blob = wav instanceof Blob ? wav : new Blob([wav as ArrayBuffer], { type: 'audio/wav' });
  return { blob, duration: out.duration };
}

/**
 * The MIDI file a soundfont render of absolute-seconds notes plays. Honors an
 * explicit program when the caller knows the clip's instrument; only falls
 * back to the global picker when it doesn't. Pitch wheels and controller
 * changes (a part's volume, pan, expression, modulation and pedal) ride in the
 * same file, and a `bank` past 0 is selected before the program (a roll part's
 * Bank, lib/rollBounce), so the render plays that bank's preset.
 */
export function notesRenderSmf(
  notes: RenderNote[],
  opts: { program?: number; wheel?: SmfWheel[]; bank?: number; controls?: SmfControl[] } = {},
): Uint8Array {
  return notesToSmf(notes, opts.program ?? getActiveProgram(), 0, [], 120, opts.wheel ?? [], { bank: opts.bank ?? 0, controls: opts.controls ?? [] });
}

/** Render absolute-seconds notes to a WAV blob through the soundfont. */
export async function renderNotesToBlobSF(
  notes: RenderNote[],
  opts: { sampleRate?: number; program?: number; wheel?: SmfWheel[]; bank?: number; controls?: SmfControl[] } & RenderLength = {},
): Promise<{ blob: Blob; duration: number }> {
  const smf = notesRenderSmf(notes, opts);
  return renderMidiToBlob(smf.buffer as ArrayBuffer, opts.sampleRate ?? 44100, opts);
}

/** Render a Standard MIDI File buffer to a WAV blob through the soundfont. */
export async function renderMidiBufferToBlobSF(
  buf: ArrayBuffer | Uint8Array,
  opts: { sampleRate?: number } & RenderLength = {},
): Promise<{ blob: Blob; duration: number }> {
  const ab =
    buf instanceof Uint8Array
      ? (buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
      : buf;
  return renderMidiToBlob(ab, opts.sampleRate ?? 44100, opts);
}

/* ── EDIT banks: live synths of EDIT's own, routed per track ──────────────────
 * The worklet exposes 17 outputs: output 0 is the shared effects bus (reverb /
 * chorus returns) and outputs 1-16 are the dry per-MIDI-channel outs.
 * `synth.connect(node)` wires ALL 17 to one destination, which is why live MIDI
 * used to land straight on the engine master — bypassing the track fader, pan,
 * insert FX and the master rack that the very same clip obeys once exported.
 *
 * Rerouting a channel is therefore just: detach it from master, attach it to the
 * track's gain node. `connectChannel(node, ch)` maps to `worklet.connect(node,
 * ch % 16 + 1)`, so this uses the public API only. Output 0 stays on master: the
 * effects bus is shared across all channels and cannot be attributed to one
 * track, so a track's synth reverb tail is the one part that still bypasses its
 * chain.
 *
 * Because a channel past fifteen shares a dry output with channel n % 16, EDIT
 * gets one synth per sixteen channels (lib/editChannels), and none of them is
 * the preview synth, so the roll's lanes, the arpeggiator and the keyboard keep
 * their channels while EDIT plays.
 */
interface EditBank {
  synth: WorkletSynthesizer;
  /** The program each channel was last switched to. */
  programs: Map<number, number>;
  /** Channels taken off the master, and the node each one now feeds. */
  routes: Map<number, AudioNode>;
  /** True while every output is off the master (parkEditRouting), so a note left in the queue sounds nowhere. */
  parked: boolean;
}

const editBanks: EditBank[] = [];
let editBankQueue: Promise<unknown> = Promise.resolve();

/**
 * Make sure `count` EDIT banks exist (at most MAX_EDIT_BANKS), creating the
 * missing ones one after another. Resolves false when a synth or the soundfont
 * cannot load, so the caller keeps playing the clips' bounced audio.
 */
export function ensureEditBanks(count: number): Promise<boolean> {
  const want = Math.max(0, Math.min(MAX_EDIT_BANKS, Math.round(count)));
  const grown = editBankQueue.then(async () => {
    try {
      await getLiveSynth(); // the worklet module and the soundfont, loaded once
      while (editBanks.length < want) {
        editBanks.push({ synth: await createLiveSynth(), programs: new Map(), routes: new Map(), parked: false });
      }
      return true;
    } catch {
      return false;
    }
  });
  editBankQueue = grown;
  return grown;
}

/** The bank and its local channel for a global EDIT channel, or null when that bank does not exist yet. */
function editChannel(channel: number): { bank: EditBank; ch: number } | null {
  const bank = editBanks[bankOfChannel(channel)];
  return bank ? { bank, ch: localChannel(channel) } : null;
}

/** SpessaSynth's event options for audio-context time `time`, or none (now). */
const atTime = (time?: number) => (time !== undefined && Number.isFinite(time) ? { time } : undefined);

/**
 * Note-on on an EDIT channel at audio-context time `time` (now when absent),
 * switching its program first, at the same time, if it changed, in bank
 * select `bankSelect` (a clip's instrumentBank; 0 is the General MIDI set)
 * and `bankLsb` (CC 32, the roll part's bank LSB when the clip plays the
 * part's program in the part's bank; absent when there is none).
 * The synth queues a timed event and plays it on the render quantum it falls
 * in, so a note scheduled ahead (lib/editMidiScheduler) sounds on the audio
 * clock the clips play on. No-op until its synth bank exists.
 */
export function editNoteOn(
  channel: number,
  program: number,
  midi: number,
  velocity: number,
  time?: number,
  bankSelect = 0,
  bankLsb?: number,
): void {
  const at = editChannel(channel);
  if (!at) return;
  setChannelProgram(at.bank.synth, at.ch, program, at.bank.programs, bankSelect, atTime(time)?.time, bankLsb);
  at.bank.synth.noteOn(at.ch, Math.round(midi), Math.max(1, Math.min(127, Math.round(velocity))), atTime(time));
}

/** Note-off on an EDIT channel at audio-context time `time` (now when absent). No-op until its bank exists. */
export function editNoteOff(channel: number, midi: number, time?: number): void {
  const at = editChannel(channel);
  if (!at) return;
  try {
    at.bank.synth.noteOff(at.ch, Math.round(midi), atTime(time));
  } catch {
    /* ignore */
  }
}

/**
 * A controller change on an EDIT channel at `time` (now when absent): a roll
 * part's modulation, volume, pan, expression or sustain pedal, as its render
 * plays it. No-op until its bank exists.
 */
export function editControl(channel: number, controller: number, value: number, time?: number): void {
  const at = editChannel(channel);
  const cc = LIVE_CONTROLLERS.get(controller);
  if (!at || cc === undefined) return;
  try {
    at.bank.synth.controllerChange(at.ch, cc, Math.max(0, Math.min(127, Math.round(value))), atTime(time));
  } catch {
    /* ignore */
  }
}

/** The controllers a roll part sends live (lib/rollTracks PART_CONTROLLERS), as the synth names them. */
const LIVE_CONTROLLERS: ReadonlyMap<number, MIDIController> = new Map<number, MIDIController>([
  [1, MIDIControllers.modulationWheel],
  [7, MIDIControllers.mainVolume],
  [10, MIDIControllers.pan],
  [11, MIDIControllers.expression],
  [64, MIDIControllers.sustainPedal],
]);

/** Move an EDIT channel's pitch wheel (raw 0-16383, 8192 the centre) at `time` (now when absent). No-op until its bank exists. */
export function editPitchWheel(channel: number, raw: number, time?: number): void {
  const at = editChannel(channel);
  if (!at) return;
  try {
    at.bank.synth.pitchWheel(at.ch, Math.max(0, Math.min(16383, Math.round(raw))), atTime(time));
  } catch {
    /* ignore */
  }
}

/**
 * Set an EDIT channel's pitch bend range in semitones at `time` (now when
 * absent): the RPN 0/0 messages the bounce writes (lib/midi bendRangeMessages),
 * so a clip's bend plays live over the range it renders with. No-op until its
 * bank exists.
 */
export function editPitchWheelRange(channel: number, semitones: number, time?: number): void {
  const at = editChannel(channel);
  if (!at) return;
  try {
    for (const bytes of bendRangeMessages(at.ch, Math.max(0, semitones), RANGE_LSB_SPESSA)) at.bank.synth.sendMessage(bytes, 0, atTime(time));
  } catch {
    /* ignore */
  }
}

/** Send EDIT channel `channel` to `dest` (a track's gain node), or back to the
 *  engine master when `dest` is null. No-op until its bank exists. */
export function routeEditChannel(channel: number, dest: AudioNode | null): void {
  const at = editChannel(channel);
  if (!at) return;
  const master = getMasterGain();
  if (at.bank.parked) {
    // Back on the master, all seventeen outputs (the effects bus included), then routed.
    try { at.bank.synth.connect(master); } catch { /* master always valid */ }
    at.bank.parked = false;
  }
  const current = at.bank.routes.get(at.ch) ?? master;
  const next = dest ?? master;
  if (current === next) return;
  try { at.bank.synth.disconnectChannel(current, at.ch); } catch { /* already detached */ }
  try { at.bank.synth.connectChannel(next, at.ch); } catch { /* node gone */ }
  if (dest) at.bank.routes.set(at.ch, dest);
  else at.bank.routes.delete(at.ch);
}

/** Return every rerouted EDIT channel to the engine master. MUST run before the
 *  track nodes it points at are disposed, or channels stay attached to dead nodes. */
export function resetEditRouting(): void {
  const master = getMasterGain();
  for (const bank of editBanks) {
    for (const [ch, node] of bank.routes) {
      try { bank.synth.disconnectChannel(node, ch); } catch { /* already detached */ }
      try { bank.synth.connectChannel(master, ch); } catch { /* master always valid */ }
    }
    bank.routes.clear();
  }
}

/**
 * Take every EDIT bank off the master and its tracks: the channels go back to
 * the master (resetEditRouting), then all seventeen outputs leave it. The
 * scheduler queues notes ahead of the clock and SpessaSynth cannot take a
 * queued event back, so after a stop a note already queued would otherwise
 * sound on the master. The next routeEditChannel puts the bank back. MUST run
 * before the track nodes are disposed, as resetEditRouting must.
 */
export function parkEditRouting(): void {
  resetEditRouting();
  const master = getMasterGain();
  for (const bank of editBanks) {
    if (bank.parked) continue;
    try { bank.synth.disconnect(master); } catch { /* an output already off the master */ }
    bank.parked = true;
  }
}

/** Stop every note on every EDIT bank (transport stop, seek, restart). The preview synth keeps sounding. */
export function editAllNotesOff(): void {
  for (const bank of editBanks) {
    try {
      bank.synth.stopAll(true);
    } catch {
      /* ignore */
    }
  }
}

/* ── live note API on the preview synth (Sway pads, DRAW, the keyboard) ─────── */

/** True when the preview synth is loaded and ready for immediate scheduling. */
export const isLiveSynthReady = (): boolean => liveSynth !== null;

/**
 * Note-on on a preview-synth channel (0-15, the keyboard's 16 or DRAW's 17-24), switching
 * that channel's program first if it changed. No-op (and warms the engine) if
 * the synth is not ready yet.
 */
export function liveNoteOn(channel: number, program: number, midi: number, velocity: number): void {
  const s = liveSynth;
  if (!s) {
    void ensureSoundfontReady();
    return;
  }
  const ch = previewChannel(channel);
  ensurePreviewChannel(s, ch);
  setChannelProgram(s, ch, program);
  s.noteOn(ch, Math.round(midi), Math.max(1, Math.min(127, Math.round(velocity))));
}

/** Note-off on a preview-synth channel. No-op if the synth is not ready. */
export function liveNoteOff(channel: number, midi: number): void {
  const s = liveSynth;
  if (!s) return;
  try {
    s.noteOff(previewChannel(channel), Math.round(midi));
  } catch {
    /* ignore */
  }
}

/**
 * Move a channel's pitch wheel on the live synth: raw 0-16383, 8192 the centre,
 * at audio-context time `time` (now when absent). No-op until the synth is ready.
 */
export function sfPitchWheel(channel: number, raw: number, time?: number): void {
  const s = liveSynth;
  if (!s) return;
  try {
    // The whole channel number: spessasynth_lib sends a channel past fifteen
    // with its offset, so a part's channel from 25 up bends itself, not the
    // channel n % 16 that a mask to four bits used to bend.
    const ch = previewChannel(channel);
    ensurePreviewChannel(s, ch);
    s.pitchWheel(ch, Math.max(0, Math.min(16383, Math.round(raw))), time !== undefined ? { time } : undefined);
  } catch {
    /* ignore */
  }
}

/**
 * Set a channel's pitch bend range on the live synth at `time` (now when
 * absent): the RPN 0/0 messages of lib/midi bendRangeMessages, each at that
 * time, with CC 38 in the 1/128 semitones SpessaSynth reads it as. No-op until
 * the synth is ready.
 */
export function sfPitchWheelRange(channel: number, semitones: number, time?: number): void {
  const s = liveSynth;
  if (!s) return;
  try {
    const options = time !== undefined ? { time } : undefined;
    // The messages carry the channel's low four bits; the offset names its group of sixteen.
    const ch = previewChannel(channel);
    ensurePreviewChannel(s, ch);
    const offset = ch - (ch % 16);
    for (const bytes of bendRangeMessages(ch % 16, Math.max(0, semitones), RANGE_LSB_SPESSA)) s.sendMessage(bytes, offset, options);
  } catch {
    /* ignore */
  }
}

/**
 * Send a controller change (a part's volume, pan, expression, modulation or
 * sustain pedal) to a preview-synth channel at audio-context time `time` (now
 * when absent). The message carries the channel's low four bits and the offset
 * names its group of sixteen, as the wheel's range does, so a part's channel
 * from 25 up takes its own change. No-op until the synth is ready.
 */
export function sfControlChange(channel: number, controller: number, value: number, time?: number): void {
  const s = liveSynth;
  if (!s) return;
  try {
    const ch = previewChannel(channel);
    ensurePreviewChannel(s, ch);
    s.sendMessage(controlMessage(ch % 16, controller, value), ch - (ch % 16), time !== undefined ? { time } : undefined);
  } catch {
    /* ignore */
  }
}

/** Panic: stop every note on the preview synth (a preview's STOP). EDIT's banks stop through editAllNotesOff. */
export function liveAllNotesOff(): void {
  const s = liveSynth;
  if (!s) return;
  try {
    s.stopAll(true);
  } catch {
    /* ignore */
  }
}
