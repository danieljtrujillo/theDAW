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
import { BasicMIDI, MIDIControllers, SoundBankLoader, type BasicSoundBank, type MIDIController } from 'spessasynth_core';
import { getEngineCtx, getMasterGain } from '../state/playerStore';
import { BUNDLED_BANK_URL, useSoundBankStore } from '../state/soundBankStore';
import { getProjectTuning, tuningForExport, useTuningStore } from '../state/tuningStore';
import { BUNDLED_BANK_ID, bankForSelect, bankSelectFor, cleanBankId, type BankPreset, type InstrumentRef, type SoundBank } from './bankRegistry';
import { isStandardTuning, resetMessages, tuningMessages, type ProjectTuning } from './tuning';
import { RANGE_LSB_SPESSA, bendRangeMessages, controlMessage } from './midi';
import { addWorkletModule } from './audioWorkletSupport';
import { pairingHeaderFor } from './apiJson';
import { notesToSmf, type SmfControl, type SmfWheel } from './midiWrite';
import type { RenderNote } from './midiSynth';
import type { GlobalVoice } from './clipProgram';
import { applyChannelGain, renderGainSnapshot, renderGainSteps, routeRenderGains } from './soundbankGain';
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
const DEFAULT_SOUNDFONT_URL = BUNDLED_BANK_URL;

/**
 * The most voices one synth sounds at once. A full orchestra of 24 parts
 * holding chords, each note two to four sample layers ringing into its
 * release, passes SpessaSynth's default of 350 and it steals the oldest
 * voices, which cuts sustained strings under a tutti. The cost is paid only
 * by voices that sound (lib/soundfontEngine.voicecap.test measures it).
 */
export const LIVE_VOICE_CAP = 1024;

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
  /** The bank the active program is picked from (lib/bankRegistry): the bundled bank unless a bank preset was picked. */
  activeBankId: string;
  /** The bank select inside that bank's own file. */
  activeBank: number;
  /** Active procedural synth voice id (see synthVoices); null = soundfont/basic. */
  activeSynthVoice: string | null;
  setUseSoundfont: (b: boolean) => void;
  setActiveProgram: (p: number) => void;
  /** Pick a preset of a bank (a bank preset in the picker): its bank, its bank select and its program. */
  setActivePreset: (ref: InstrumentRef) => void;
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
  activeBankId: BUNDLED_BANK_ID,
  activeBank: 0,
  activeSynthVoice: null,
  // The three instrument modes are mutually exclusive: a soundfont program, a
  // procedural synth voice, or neither ("basic" sawtooth).
  setUseSoundfont: (b) => set(b ? { useSoundfont: true, activeSynthVoice: null } : { useSoundfont: false }),
  // A bare program is a General MIDI program: the bundled bank's bank 0.
  setActiveProgram: (p) => set({ activeProgram: Math.max(0, Math.min(127, Math.round(p))), activeBankId: BUNDLED_BANK_ID, activeBank: 0 }),
  setActivePreset: (ref) =>
    set({
      activeProgram: Math.max(0, Math.min(127, Math.round(ref.program))),
      activeBankId: cleanBankId(ref.bankId),
      activeBank: Math.max(0, Math.min(127, Math.round(ref.bank))),
      useSoundfont: true,
      activeSynthVoice: null,
    }),
  setActiveSynthVoice: (id) => set(id ? { activeSynthVoice: id, useSoundfont: false } : { activeSynthVoice: null }),
}));

/** True when MIDI should render through a soundfont instead of the sawtooth. */
export const isSoundfontActive = (): boolean => useSoundfontStore.getState().useSoundfont;
/** The active GM program (0-127). */
export const getActiveProgram = (): number => useSoundfontStore.getState().activeProgram;
/** The picker's state as lib/clipProgram reads it: whether soundfonts are on and the program. */
export const getGlobalVoice = (): GlobalVoice => {
  const { useSoundfont, activeProgram, activeBankId, activeBank } = useSoundfontStore.getState();
  return activeBankId === BUNDLED_BANK_ID && activeBank === 0
    ? { useSoundfont, activeProgram }
    : { useSoundfont, activeProgram, activeBankId, activeBank };
};
/** The bank select MSB the global picker's program is selected in (its bank's offset plus its bank). */
export const getActiveBankSelect = (): number => {
  const { activeBankId, activeBank } = useSoundfontStore.getState();
  return bankSelectFor(activeBankId, activeBank);
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
 * The bundled bank parsed on the main thread, once: its preset list for the
 * pickers (soundBankStore setBundledPresets) and each preset's release for a
 * render's tail (getReleaseLookup). Null when the parser refuses it.
 */
let bundledParse: Promise<BasicSoundBank | null> | null = null;
function parseBundledBank(sf: ArrayBuffer): Promise<BasicSoundBank | null> {
  if (!bundledParse) {
    bundledParse = Promise.resolve()
      .then(() => SoundBankLoader.fromArrayBuffer(sf.slice(0)))
      .then((bank) => {
        useSoundBankStore.getState().setBundledPresets(bank.soundBankInfo?.name ?? 'General MIDI', bankPresets(bank));
        return bank;
      })
      .catch(() => null);
  }
  return bundledParse;
}

/** A parsed bank's presets as the pickers list them: a kit's bank is 0, as it is selected by program alone. */
export function bankPresets(bank: Pick<BasicSoundBank, 'presets'>): BankPreset[] {
  return bank.presets.map((p) => ({
    bank: p.isGMGSDrum ? 0 : p.bankMSB,
    bankLsb: p.bankLSB,
    program: p.program,
    name: p.name,
    drum: p.isDrum || p.isGMGSDrum,
  }));
}

/**
 * List the bundled bank's presets in every picker (its variation banks and
 * kits), loading the bank if it is not loaded yet. Safe to call repeatedly.
 */
export async function loadBundledBankPresets(): Promise<void> {
  try {
    await parseBundledBank(await loadDefaultSoundfont());
  } catch {
    /* the picker keeps its General MIDI list */
  }
}

/** Each user bank's bytes, fetched once from the backend (backend/modules/soundfonts). */
const userBankBytes = new Map<string, Promise<ArrayBuffer>>();
function bankBytes(bank: Pick<SoundBank, 'id' | 'url'>): Promise<ArrayBuffer> {
  let p = userBankBytes.get(bank.id);
  if (!p) {
    // The pairing header too, so a paired device's desktop UI loads the bank (backend/modules/soundfonts).
    p = fetch(bank.url, { headers: pairingHeaderFor(bank.url) }).then((r) => {
      if (!r.ok) throw new Error(`sound bank HTTP ${r.status}`);
      return r.arrayBuffer();
    });
    p.catch(() => userBankBytes.delete(bank.id));
    userBankBytes.set(bank.id, p);
  }
  return p;
}

const listedUsers = (): SoundBank[] => useSoundBankStore.getState().banks.filter((b) => b.kind === 'user');

/**
 * The user banks a MIDI sequence selects: each bank whose bank-select range
 * holds a CC 0 value the sequence sends. A render loads only those.
 */
export function banksForSelects(selects: Iterable<number>, banks: readonly SoundBank[] = listedUsers()): SoundBank[] {
  const used = [...new Set(selects)];
  return banks.filter((b) => b.kind === 'user' && used.some((m) => m >= b.offset && m < b.offset + Math.max(1, b.span)));
}

/** Every bank select value (CC 0) a parsed MIDI sends. */
export function midiBankSelects(midi: Pick<BasicMIDI, 'tracks'>): Set<number> {
  const out = new Set<number>();
  for (const t of midi.tracks) {
    for (const e of t.events) {
      if ((e.statusByte & 0xf0) === 0xb0 && e.data[0] === 0) out.add(e.data[1]);
    }
  }
  return out;
}

/* ── the user's banks and the project tuning on every live synth ──────────── */

/** The user banks each live synth holds, by id, with the offset each was loaded at. */
const synthBanks = new WeakMap<WorkletSynthesizer, Map<string, number>>();
/**
 * The user banks each live synth is to hold: every listed one for the preview
 * synth (any picker's preset plays on it), and for an EDIT bank the ones its
 * tracks select (lib/editBankBanks), since SpessaSynth parses a copy of a
 * bank into every worklet it is added to and shares none.
 */
const synthWants = new WeakMap<WorkletSynthesizer, Set<string> | 'all'>();
/** Each synth's bank work, one change after another. */
const synthBankQueue = new WeakMap<WorkletSynthesizer, Promise<unknown>>();

/**
 * Bring a live synth's user banks in line with the store: load each listed
 * bank at its offset (SpessaSynth addSoundBank(buffer, id, offset)) and drop
 * each one no longer listed. A bank whose bytes do not arrive is left out and
 * its presets play the bundled bank's.
 */
function syncUserBanks(synth: WorkletSynthesizer): Promise<unknown> {
  const run = (synthBankQueue.get(synth) ?? Promise.resolve()).then(async () => {
    const held = synthBanks.get(synth) ?? new Map<string, number>();
    synthBanks.set(synth, held);
    const wanted = synthWants.get(synth) ?? 'all';
    const want = listedUsers().filter((b) => wanted === 'all' || wanted.has(b.id));
    for (const [id] of held) {
      if (want.some((b) => b.id === id)) continue;
      try {
        await synth.soundBankManager.deleteSoundBank(id);
      } catch {
        /* already gone */
      }
      held.delete(id);
    }
    for (const bank of want) {
      if (held.get(bank.id) === bank.offset) continue;
      try {
        const bytes = await bankBytes(bank);
        // A copy: the worklet takes (detaches) the buffer it is given.
        await synth.soundBankManager.addSoundBank(bytes.slice(0), bank.id, bank.offset);
        held.set(bank.id, bank.offset);
      } catch {
        /* its presets fall back to the bundled bank's */
      }
    }
  });
  synthBankQueue.set(synth, run.catch(() => undefined));
  return run;
}

/** The tuning each live synth was last sent, and how many groups of sixteen channels got it. */
const synthTuning = new WeakMap<WorkletSynthesizer, { tuning: ProjectTuning; groups: number }>();

/**
 * Send the project tuning (lib/tuning tuningMessages) to a synth with
 * `channels` channels: the master tuning once, and the octave tuning to each
 * group of sixteen channels, the group's offset naming it. What the synth was
 * last sent is reset first, so a scale tuned key by key does not linger.
 */
function applyTuning(synth: WorkletSynthesizer, channels: number, tuning: ProjectTuning = getProjectTuning()): void {
  const groups = Math.max(1, Math.floor(channels / 16));
  const last = synthTuning.get(synth);
  if (last ? last.tuning === tuning && last.groups >= groups : isStandardTuning(tuning)) return;
  const send = (msgs: number[][]) => {
    for (const m of msgs) {
      const body = m.slice(1);
      // Octave tuning names channels by a mask of sixteen, so each group gets its own copy.
      const perGroup = m[3] === 0x08 && m[4] === 0x09;
      for (let g = 0; g < (perGroup ? groups : 1); g += 1) {
        try {
          synth.systemExclusive(body, g * 16);
        } catch {
          /* a synth mid-teardown */
        }
      }
    }
  };
  if (last && !isStandardTuning(last.tuning)) send(resetMessages(last.tuning));
  send(tuningMessages(tuning));
  synthTuning.set(synth, { tuning, groups });
}

/** Every live synth: the preview synth and EDIT's banks, with their channel counts. */
function liveSynths(): Array<{ synth: WorkletSynthesizer; channels: number }> {
  const out: Array<{ synth: WorkletSynthesizer; channels: number }> = [];
  if (liveSynth) out.push({ synth: liveSynth, channels: previewChannels });
  for (const b of editBanks) out.push({ synth: b.synth, channels: 16 });
  return out;
}

let watching = false;
/** Follow the bank list and the tuning on every live synth from the first synth on. */
function watchBanksAndTuning(): void {
  if (watching) return;
  watching = true;
  useSoundBankStore.subscribe((s, prev) => {
    if (s.banks === prev.banks) return;
    for (const { synth } of liveSynths()) void syncUserBanks(synth);
  });
  useTuningStore.subscribe((s, prev) => {
    if (s.tuning === prev.tuning) return;
    for (const { synth, channels } of liveSynths()) {
      if (synth === liveSynth) padPreviewGroups(synth);
      applyTuning(synth, synth === liveSynth ? previewChannels : channels, s.tuning);
    }
  });
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

/**
 * A live synth on the engine context, wired to the master, with the default
 * soundfont loaded, the user's banks at their offsets, the voice cap raised
 * for a tutti, and the project tuning sent.
 */
async function createLiveSynth(wanted: Set<string> | 'all' = 'all'): Promise<WorkletSynthesizer> {
  const ctx = getEngineCtx();
  await addWorkletModule(ctx, await getProcessorUrl());
  const synth = new WorkletSynthesizer(ctx);
  synth.connect(getMasterGain());
  const sf = await loadDefaultSoundfont();
  // Pass a copy: the worklet transfers (detaches) the buffer it receives, and
  // the cached `sf` is reused by the offline render path too.
  await synth.soundBankManager.addSoundBank(sf.slice(0), 'main');
  await synth.isReady;
  synth.setSystemParameter('voiceCap', LIVE_VOICE_CAP);
  void parseBundledBank(sf);
  watchBanksAndTuning();
  synthWants.set(synth, wanted);
  await syncUserBanks(synth);
  applyTuning(synth, 16);
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
      padPreviewGroups(synth);
      applyTuning(synth, previewChannels);
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
  if (previewChannels > ch) return;
  while (previewChannels <= ch && previewChannels < MAX_PREVIEW_CHANNELS) {
    synth.addNewChannel();
    previewChannels += 1;
  }
  // A new group of sixteen takes the project tuning too.
  padPreviewGroups(synth);
  applyTuning(synth, previewChannels);
}

/**
 * Fill the preview synth's last group of sixteen channels, so a tuning
 * message addressed to that group (octave tuning names sixteen channels at
 * once) finds every channel it names. Channels past the ones in use only
 * sound when a part asks for them.
 */
function padPreviewGroups(synth: WorkletSynthesizer): void {
  if (isStandardTuning(getProjectTuning())) return;
  const whole = Math.min(MAX_PREVIEW_CHANNELS, Math.ceil(previewChannels / 16) * 16);
  while (previewChannels < whole) {
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
 * none, sent as 0): the whole bank select, MSB then LSB, then the program
 * change, as MIDI orders them. `key` is what the channel plays after them;
 * the same key as `previous` sends nothing.
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
  // Every program change goes out with its whole bank select, CC 0 then CC 32
  // (0 for a voice with no LSB), so the preset it picks never depends on a bank
  // select the channel was left with: a user bank's preset sits at its bank's
  // offset (lib/bankRegistry), and a receiver on a MIDI out port starts from
  // whatever state its last song left.
  return { key, controllers: [[0, b], [32, lsb ?? 0]], program: p };
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
 * left out or already past) for `durationSec`, with `program` in bank select
 * `bank` (the global picker's program and bank when the program is left out).
 * The note-on and note-off are timed on the synth, so
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
  bank?: number,
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
    setChannelProgram(synth, ch, program ?? getActiveProgram(), channelProgram, bank ?? (program === undefined ? getActiveBankSelect() : 0));
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
      .then(() => parseBundledBank(sf))
      .then((bank): ReleaseLookup => (bank ? releaseLookupFromBank(bank) : () => RENDER_TAIL_CAP_SEC))
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
  // The project tuning's messages go first, as an exported file carries them (tuningStore tuningForExport).
  const tuned = tuningForExport(new Uint8Array(midiBytes));
  const midi = BasicMIDI.fromArrayBuffer(tuned.buffer.slice(tuned.byteOffset, tuned.byteOffset + tuned.byteLength) as ArrayBuffer, 'render');
  // The user banks the file selects, each at its offset, after the bundled bank so it keeps its own presets.
  const users = await Promise.all(
    banksForSelects(midiBankSelects(midi)).map(async (b) => {
      try {
        return { bankOffset: b.offset, soundBankBuffer: (await bankBytes(b)).slice(0) };
      } catch {
        return null;
      }
    }),
  );
  // The span (lib/renderTail renderSpan): at least the last event and
  // minDurationSec, and past the last event a fixed tail or the ring-out.
  const lookup = opts.tailSec === undefined ? await getReleaseLookup(sf) : null;
  const span = renderSpan(midi.duration, opts, () => (lookup ? renderTailSec(midiPresetKeys(midi), lookup) : RENDER_TAIL_CAP_SEC));
  const length = Math.max(1, Math.ceil(sampleRate * span.renderSec));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, sampleRate, length });
  await addWorkletModule(ctx, await getProcessorUrl());
  const synth = new WorkletSynthesizer(ctx, { eventsEnabled: false });
  synth.connect(ctx.destination);
  // A program change to a preset with another playback gain steps its channel's output there.
  routeRenderGains(ctx, synth, ctx.destination, renderGainSteps(midi));
  await synth.startOfflineRender({
    midiSequence: midi,
    // Copy: startOfflineRender transfers (detaches) the buffer, but `sf` is the
    // shared cached soundfont reused by the live synth and later renders.
    soundBankList: [{ bankOffset: 0, soundBankBuffer: sf.slice(0) }, ...users.filter((u): u is { bankOffset: number; soundBankBuffer: ArrayBuffer } => u !== null)],
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
 * Bank, lib/rollBounce, or a user bank's preset at its offset), so the render
 * plays that bank's preset. With no program the global picker's program and
 * bank are rendered.
 */
export function notesRenderSmf(
  notes: RenderNote[],
  opts: { program?: number; wheel?: SmfWheel[]; bank?: number; controls?: SmfControl[] } = {},
): Uint8Array {
  const bank = opts.bank ?? (opts.program === undefined ? getActiveBankSelect() : 0);
  return notesToSmf(notes, opts.program ?? getActiveProgram(), 0, [], 120, opts.wheel ?? [], { bank, controls: opts.controls ?? [] });
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
 * missing ones one after another, and that each holds the user banks
 * `needs[i]` names and no other (lib/editBankBanks): a bank no track of it
 * selects any more is dropped, which frees its parsed copy. Resolves false
 * when a synth or the soundfont cannot load, so the caller keeps playing the
 * clips' bounced audio.
 */
export function ensureEditBanks(count: number, needs: ReadonlyArray<ReadonlySet<string>> = []): Promise<boolean> {
  const want = Math.max(0, Math.min(MAX_EDIT_BANKS, Math.round(count)));
  const grown = editBankQueue.then(async () => {
    try {
      await getLiveSynth(); // the worklet module and the soundfont, loaded once
      while (editBanks.length < want) {
        editBanks.push({ synth: await createLiveSynth(new Set(needs[editBanks.length] ?? [])), programs: new Map(), routes: new Map(), parked: false });
        // createLiveSynth tuned the new bank's sixteen channels before it was listed here.
      }
      for (let i = 0; i < editBanks.length; i += 1) {
        const next = new Set(needs[i] ?? []);
        const now = synthWants.get(editBanks[i].synth);
        if (now !== 'all' && now && now.size === next.size && [...next].every((id) => now.has(id))) continue;
        synthWants.set(editBanks[i].synth, next);
        await syncUserBanks(editBanks[i].synth);
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
  // A note with no program (an external-only track's, NO_PROGRAM) keeps whatever the channel plays.
  if (program >= 0) {
    wantBankFor(at.bank.synth, bankSelect);
    setChannelProgram(at.bank.synth, at.ch, program, at.bank.programs, bankSelect, atTime(time)?.time, bankLsb);
  }
  at.bank.synth.noteOn(at.ch, Math.round(midi), Math.max(1, Math.min(127, Math.round(velocity))), atTime(time));
}

/**
 * A voice picked while playing whose user bank this EDIT bank does not hold
 * yet (the plan named the banks when the pass started): the bank is loaded
 * into it now, and plays from the notes after it arrives.
 */
function wantBankFor(synth: WorkletSynthesizer, bankSelect: number): void {
  const wanted = synthWants.get(synth);
  if (!wanted || wanted === 'all' || bankSelect <= 0) return;
  const users = listedUsers();
  const { bankId } = bankForSelect(bankSelect, users);
  if (wanted.has(bankId) || !users.some((b) => b.id === bankId)) return;
  wanted.add(bankId);
  void syncUserBanks(synth);
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

/**
 * The controllers EDIT sends live, as the synth names them: a roll part's
 * (lib/rollTracks PART_CONTROLLERS), a note's timbre (CC 74, the third
 * dimension of per-note expression) and a track's reverb send (EditorTrack
 * synthReverbSend, CC 91).
 */
const LIVE_CONTROLLERS: ReadonlyMap<number, MIDIController> = new Map<number, MIDIController>([
  [1, MIDIControllers.modulationWheel],
  [7, MIDIControllers.mainVolume],
  [10, MIDIControllers.pan],
  [11, MIDIControllers.expression],
  [64, MIDIControllers.sustainPedal],
  [74, MIDIControllers.brightness],
  [91, MIDIControllers.reverbDepth],
]);

/**
 * Channel pressure (aftertouch, 0-127) on an EDIT channel at `time` (now when
 * absent): a note's pressure while it holds a channel of its own (lib/
 * mpeRotation). No-op until its bank exists.
 */
export function editChannelPressure(channel: number, value: number, time?: number): void {
  const at = editChannel(channel);
  if (!at) return;
  try {
    at.bank.synth.channelPressure(at.ch, Math.max(0, Math.min(127, Math.round(value))), atTime(time));
  } catch {
    /* ignore */
  }
}

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
 * that channel's program (in bank select `bank`) first if it changed. No-op (and warms the engine) if
 * the synth is not ready yet.
 */
export function liveNoteOn(channel: number, program: number, midi: number, velocity: number, bank = 0): void {
  const s = liveSynth;
  if (!s) {
    void ensureSoundfontReady();
    return;
  }
  const ch = previewChannel(channel);
  ensurePreviewChannel(s, ch);
  setChannelProgram(s, ch, program, channelProgram, bank);
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
