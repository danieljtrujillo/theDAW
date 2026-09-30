/**
 * rollInstruments — the piano roll's parts played through VST3 instruments,
 * live (RollTrack `vstInstrument`).
 *
 * Each part whose instrument is switched on gets the same live host session
 * an EDIT track's instrument slot gets (lib/vstLive/sessionRegistry, keyed by
 * the entry's id and held under ROLL_HOLDER), and while the MIDI tab is open a
 * branch in the engine's graph: a silent source into the entry's live node
 * (lib/vstLive/vstLiveNode, the plugin makes the sound from the notes it is
 * sent) and on into the master, where the soundfont parts beside it go. EDIT
 * closing its project spares these sessions (liveMixer dispose), and EDIT's
 * transport never reaches them: each follows the roll's clock
 * (lib/rollVstPlay), set here as the roll plays, stops and changes tempo.
 *
 * WHAT A PART PLAYS. `rollVstVoiceOf` names a part's plugin only while that
 * plugin can play: its session is live, its host takes MIDI, and its branch is
 * in the graph. Otherwise the part plays its General MIDI program, so a part
 * is never silent: while the plugin opens, after it fails to load, with no
 * live host installed, and with a host built before instrument playback. A
 * failure says so in the LOG, once per reason, with what the part plays
 * instead, and a plugin that comes back says that too.
 *
 * STATE. The plugin's own editor (state/vstEditorStore, opened from the part)
 * captures its state onto the part through the registered entry owner below,
 * and onto the EDIT clip the part was last sent to, so a project save after
 * the plugin was changed keeps the new sound.
 */
import { activeTrackOf, usePianoRollStore, rollTracksOf, type RollTrack } from './pianoRollStore';
import { useVstLiveStore, entryLatencySamples, type VstLiveStatus } from './vstLiveStore';
import { useEditorStore } from './editorStore';
import { registerVstEntryOwner, vstEntryOwnersChanged } from './vstEditorStore';
import { getEngineCtx, getMasterGain } from './playerStore';
import { logError, logInfo } from './logStore';
import type { ChainEntry, VstStateHost } from './effectChainStore';
import { vstSessions, hookVstSessionUnload, type VstSessionRegistry } from '../lib/vstLive/sessionRegistry';
import { ROLL_HOLDER } from '../lib/vstLive/projectSessions';
import { createVstLiveNode, setVstEntryTransport, type VstTransportInfo } from '../lib/vstLive/vstLiveNode';
import type { VstMidiEvent } from '../lib/vstLive/bridgeClient';
import type { RackEffectInstance } from '../lib/rackEffects';
import { activePartVst, isPercussionPart } from '../lib/rollTracks';
import { gmShortName } from '../lib/gmInstruments';
import { drumKitName } from '../lib/clipProgram';
import type { Vst3SwitchMode } from '../lib/articulationMap';
import {
  IDLE_ROLL_VST_CLOCK,
  clockStamp,
  clockTransport,
  playingClock,
  stoppedClock,
  vstBaseChannel,
  type RollVstClock,
} from '../lib/rollVstPlay';
import { setHeldKeyRoute, triggerPianoNote, type PianoNoteVoice } from '../lib/pianoTrigger';

/** What a part's instrument is doing, in the one word its status dot carries. */
export type RollVstState = 'off' | 'opening' | 'live' | 'fallback';

export const ROLL_VST_STATE_WORD: Record<RollVstState, string> = {
  off: 'Off',
  opening: 'Opening',
  live: 'Live',
  fallback: 'Fallback',
};

/** One part instrument's branch in the engine's graph. */
interface Branch {
  entryId: string;
  source: ConstantSourceNode;
  node: RackEffectInstance;
  out: GainNode;
}

/** What this module reaches outside itself: the app passes none, a test its fakes. */
export interface RollInstrumentDeps {
  registry: Pick<VstSessionRegistry, 'hold' | 'unhold' | 'get'>;
  /** The live node of a `vst3` entry (lib/vstLive/vstLiveNode createVstLiveNode). */
  createNode: (ctx: BaseAudioContext, entry: ChainEntry) => RackEffectInstance | null;
  ctx: () => BaseAudioContext;
  /** Where a part instrument's branch plays out: the engine's master. */
  master: () => AudioNode;
  /** Put an entry on the roll's transport (lib/vstLive/vstLiveNode setVstEntryTransport). */
  setTransport: (entryId: string, info: VstTransportInfo | null) => void;
}

const APP_DEPS: RollInstrumentDeps = {
  registry: vstSessions,
  createNode: (ctx, entry) => createVstLiveNode(ctx, entry),
  ctx: getEngineCtx,
  master: getMasterGain,
  setTransport: setVstEntryTransport,
};
let deps: RollInstrumentDeps = APP_DEPS;

/** Tests only: run on fakes (null: the app's own). Everything held is forgotten. */
export function __setRollInstrumentDepsForTest(next: Partial<RollInstrumentDeps> | null): void {
  deps = next ? { ...APP_DEPS, ...next } : APP_DEPS;
  held.clear();
  branches.clear();
  sentLatency.clear();
  reported.clear();
  clock = IDLE_ROLL_VST_CLOCK;
  clockTempo = 0;
}

let attachCount = 0;
/** Entries held under ROLL_HOLDER, by id. */
const held = new Map<string, ChainEntry>();
const branches = new Map<string, Branch>();
let clock: RollVstClock = IDLE_ROLL_VST_CLOCK;
let clockTempo = 0;
/** The latency each entry's transport was last sent with, so a change re-sends it. */
const sentLatency = new Map<string, number>();
/** The reason each entry's failure was last logged for, so each is logged once. */
const reported = new Map<string, string>();
let unsubRoll: (() => void) | null = null;
let unsubLive: (() => void) | null = null;

const sampleRate = (): number => deps.ctx().sampleRate;

/** Every part with a VST3 instrument switched on, and that instrument. */
function activeParts(): Array<{ part: RollTrack; entry: ChainEntry }> {
  const out: Array<{ part: RollTrack; entry: ChainEntry }> = [];
  for (const part of rollTracksOf(usePianoRollStore.getState())) {
    const entry = activePartVst(part);
    if (entry) out.push({ part, entry });
  }
  return out;
}

/** The part that holds instrument entry `entryId`, whether it is on or off. */
const partOfEntry = (entryId: string): RollTrack | undefined =>
  usePianoRollStore.getState().tracks.find((t) => t.vstInstrument?.id === entryId);

/** The plugin's name as a part shows it. */
export const rollVstName = (entry: ChainEntry | undefined): string =>
  entry?.vst?.plugin_name || entry?.vst?.plugin_path.split(/[\\/]/).pop()?.replace(/\.vst3$/i, '') || 'the VST3 instrument';

/** What a part plays while its plugin cannot: its own program or kit, else the roll's voice. */
export function rollFallbackText(part: Pick<RollTrack, 'program' | 'channel'>): string {
  if (part.program === null) return isPercussionPart(part) ? 'the Standard kit' : 'the roll voice';
  return isPercussionPart(part) ? `the ${drumKitName(part.program)} kit` : gmShortName(part.program);
}

/** The session row of an entry, and whether its host takes MIDI. */
function liveOf(entryId: string): { status: VstLiveStatus | undefined; reason?: string; deaf: boolean } {
  const row = useVstLiveStore.getState().entries[entryId];
  const client = deps.registry.get(entryId)?.client;
  return { status: row?.status, reason: row?.reason, deaf: row?.status === 'live' && client?.acceptsMidi !== true };
}

/**
 * What part instrument `entryId` is doing: `live` when its notes reach the
 * plugin, `opening` while the session starts, `fallback` when the part plays
 * its program because the plugin cannot (it failed, no host is installed, or
 * the host predates instrument playback), `off` when it is switched off or the
 * roll is not hosting it.
 */
export function rollVstState(entryId: string): RollVstState {
  const part = partOfEntry(entryId);
  if (!part?.vstInstrument?.enabled || !held.has(entryId)) return 'off';
  const { status, deaf } = liveOf(entryId);
  if (status === 'error' || status === 'unavailable' || deaf) return 'fallback';
  if (status === 'live' && branches.has(entryId)) return 'live';
  return 'opening';
}

/** Why part instrument `entryId` falls back, in words, or null when it does not. */
export function rollVstFallbackReason(entryId: string): string | null {
  if (rollVstState(entryId) !== 'fallback') return null;
  const { reason, deaf } = liveOf(entryId);
  if (deaf) return 'the installed live VST host predates instrument playback; update theDAW to hear it';
  return reason || 'the plugin could not start';
}

/** The plugin part `part` plays through now, and how it hears articulations; undefined while it plays its program. */
export function rollVstVoiceOf(part: Pick<RollTrack, 'vstInstrument' | 'articulationSwitch'>): { entryId: string; mode: Vst3SwitchMode } | undefined {
  const entry = activePartVst(part);
  if (!entry || rollVstState(entry.id) !== 'live') return undefined;
  return { entryId: entry.id, mode: part.articulationSwitch ?? 'keyswitch' };
}

/** The port of a live part instrument, or null while it cannot take notes. */
function portOf(entryId: string): { sendMidi: (e: readonly VstMidiEvent[]) => void; midiPanic: () => void } | null {
  if (rollVstState(entryId) !== 'live') return null;
  const client = deps.registry.get(entryId)?.client;
  if (!client?.sendMidi || !client.midiPanic) return null;
  return { sendMidi: (e) => client.sendMidi?.(e), midiPanic: () => client.midiPanic?.() };
}

/** Send entry `entryId`'s plugin the roll's clock, with its latency now. */
function sendTransport(entryId: string, discontinuity = false): void {
  const latency = entryLatencySamples(useVstLiveStore.getState().entries[entryId]);
  sentLatency.set(entryId, latency);
  deps.setTransport(entryId, clockTransport(clock, sampleRate(), latency, clockTempo || usePianoRollStore.getState().bpm, discontinuity));
}

function buildBranch(entry: ChainEntry): void {
  if (branches.has(entry.id)) return;
  const ctx = deps.ctx();
  // The roll's clock first, so the node goes live on it and never on EDIT's.
  sendTransport(entry.id, true);
  const node = deps.createNode(ctx, entry);
  if (!node) return; // no worklet, or no host binary: the row says so, and the part plays its program
  const source = ctx.createConstantSource();
  source.offset.value = 0;
  const out = ctx.createGain();
  out.gain.value = 1;
  source.connect(node.input);
  node.output.connect(out);
  out.connect(deps.master());
  source.start();
  branches.set(entry.id, { entryId: entry.id, source, node, out });
}

function disposeBranch(entryId: string): void {
  const b = branches.get(entryId);
  if (!b) return;
  branches.delete(entryId);
  try {
    b.source.stop();
  } catch {
    /* never started */
  }
  try {
    b.source.disconnect();
    b.out.disconnect();
  } catch {
    /* already gone */
  }
  b.node.dispose();
}

/**
 * Bring the held sessions and the graph in line with the parts: hold every
 * switched-on instrument and build its branch, and let go of one that left
 * (its part removed, switched off or given another plugin).
 */
function reconcile(): void {
  const wanted = new Map(activeParts().map(({ entry }) => [entry.id, entry]));
  for (const id of [...held.keys()]) {
    if (wanted.has(id)) continue;
    held.delete(id);
    disposeBranch(id);
    deps.registry.unhold(id, ROLL_HOLDER);
    deps.setTransport(id, null);
    sentLatency.delete(id);
    reported.delete(id);
  }
  for (const [id, entry] of wanted) {
    if (!held.has(id)) {
      held.set(id, entry);
      // Never rejects by contract; a failure (no host binary, a refused spawn) lands on the row.
      void deps.registry.hold(entry, sampleRate(), ROLL_HOLDER).catch(() => {});
    } else held.set(id, entry);
    buildBranch(entry);
  }
  reportStates();
}

/** Log each part instrument that falls back, once per reason, and one that comes back. */
function reportStates(): void {
  for (const { part, entry } of activeParts()) {
    const state = rollVstState(entry.id);
    if (state === 'fallback') {
      const why = rollVstFallbackReason(entry.id) ?? '';
      if (reported.get(entry.id) === why) continue;
      reported.set(entry.id, why);
      logError('piano-roll', `${part.name}: ${rollVstName(entry)} could not play (${why}). The part plays ${rollFallbackText(part)} instead.`);
    } else if (state === 'live' && reported.has(entry.id)) {
      reported.delete(entry.id);
      logInfo('piano-roll', `${part.name} plays through ${rollVstName(entry)} again.`);
    }
    // A latency the plugin reports once it is live moves where its notes are sent.
    if (state === 'live' && sentLatency.get(entry.id) !== entryLatencySamples(useVstLiveStore.getState().entries[entry.id])) {
      sendTransport(entry.id);
    }
  }
}

/**
 * Host the roll's part instruments while the MIDI tab is open (its transport
 * key calls this on mount). Returns the detach: the branches come down and the
 * sessions are let go, to the registry's grace period.
 */
export function attachRollInstruments(): () => void {
  attachCount += 1;
  if (attachCount === 1) {
    hookVstSessionUnload();
    setHeldKeyRoute(heldKeyToActivePart);
    unsubRoll = usePianoRollStore.subscribe((state, prev) => {
      if (state.tracks !== prev.tracks) reconcile();
    });
    unsubLive = useVstLiveStore.subscribe((state, prev) => {
      if (state.entries !== prev.entries || state.host !== prev.host) {
        // A session that came back live needs its branch (a host found late), and every change may be one to report.
        for (const id of held.keys()) {
          const entry = held.get(id) as ChainEntry;
          if (!branches.has(id) && state.entries[id]?.status === 'live') buildBranch(entry);
        }
        reportStates();
      }
    });
  }
  reconcile();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    attachCount -= 1;
    if (attachCount > 0) return;
    setHeldKeyRoute(null);
    unsubRoll?.();
    unsubRoll = null;
    unsubLive?.();
    unsubLive = null;
    for (const id of [...held.keys()]) {
      disposeBranch(id);
      deps.registry.unhold(id, ROLL_HOLDER);
      deps.setTransport(id, null);
    }
    held.clear();
    sentLatency.clear();
    reported.clear();
  };
}

/** Where a message for context time `t` sits on the roll's clock now: its `pos`. */
export const rollVstStamp = (t: number): number => clockStamp(clock, t, sampleRate());

/** Hand each part instrument its messages (splitRollTick `midi`). */
export function sendRollVstMidi(midi: ReadonlyMap<string, VstMidiEvent[]>): void {
  for (const [entryId, events] of midi) if (events.length) portOf(entryId)?.sendMidi(events);
}

/** Every part instrument drops the MIDI it holds and releases every sounding note. */
export function panicRollVst(): void {
  for (const id of held.keys()) portOf(id)?.midiPanic();
}

/**
 * PLAY: the roll's clock reads `startSec` (the roll second of the step PLAY
 * starts from) at context time `origin`, its first downbeat. Every part
 * instrument drops what an audition left waiting, and takes the new clock as
 * a jump, so the plugin starts clean on the roll's position and tempo.
 */
export function startRollVstClock(origin: number, startSec: number, tempoBpm: number): void {
  panicRollVst();
  clock = playingClock(origin, startSec);
  clockTempo = tempoBpm;
  for (const id of held.keys()) sendTransport(id, true);
}

/** While the roll plays: the tempo where it is, sent to every plugin when it changes (a tempo map). */
export function tickRollVstClock(tempoBpm: number): void {
  if (!clock.playing || !Number.isFinite(tempoBpm) || tempoBpm <= 0 || Math.abs(tempoBpm - clockTempo) < 1e-6) return;
  clockTempo = tempoBpm;
  for (const id of held.keys()) sendTransport(id);
}

/**
 * STOP: every part instrument releases what it holds, then gets `release`
 * (the scheduler's controller and wheel resets) now, and the clock runs on,
 * stopped, from where it was.
 */
export function stopRollVstClock(now: number, release?: ReadonlyMap<string, VstMidiEvent[]>): void {
  panicRollVst();
  if (release) {
    const nowPos = new Map([...release].map(([id, events]) => [id, events.map((e) => ({ ...e, pos: -1 }))]));
    sendRollVstMidi(nowPos);
  }
  clock = stoppedClock(clock, now);
  for (const id of held.keys()) sendTransport(id);
}

/** One note on part instrument `entryId`, from context time `when` for `duration` seconds, stamped on the roll's clock. False when the plugin cannot take it now. */
export function auditionRollVstNote(entryId: string, channel: number, note: number, velocity: number, when: number, duration: number): boolean {
  const port = portOf(entryId);
  if (!port) return false;
  const ch = channel & 0x0f;
  const key = Math.max(0, Math.min(127, Math.round(note)));
  port.sendMidi([
    { pos: rollVstStamp(when), data: [0x90 | ch, key, Math.max(1, Math.min(127, Math.round(velocity)))] },
    { pos: rollVstStamp(when + Math.max(0.01, duration)), data: [0x80 | ch, key, 0] },
  ]);
  return true;
}

/** A hardware key down on part instrument `entryId`: its note-on now. False when the plugin cannot take it. */
export function rollVstNoteOn(entryId: string, channel: number, note: number, velocity: number): boolean {
  const port = portOf(entryId);
  if (!port) return false;
  port.sendMidi([{ pos: -1, data: [0x90 | (channel & 0x0f), note & 0x7f, Math.max(1, Math.min(127, Math.round(velocity)))] }]);
  return true;
}

/** The key up: its note-off now. */
export function rollVstNoteOff(entryId: string, channel: number, note: number): void {
  // Sent whatever the state now: a plugin that took the note-on must hear its note-off.
  deps.registry.get(entryId)?.client.sendMidi?.([{ pos: -1, data: [0x80 | (channel & 0x0f), note & 0x7f, 0] }]);
}

/** A hardware key through the roll's active part's plugin, while it has one live: the key's release, or null. */
function heldKeyToActivePart(note: number, velocity: number): (() => void) | null {
  const part = activeTrackOf(usePianoRollStore.getState());
  const vst = part ? rollVstVoiceOf(part) : undefined;
  if (!vst) return null;
  const channel = vstBaseChannel(part.channel);
  if (!rollVstNoteOn(vst.entryId, channel, note, velocity)) return null;
  return () => rollVstNoteOff(vst.entryId, channel, note);
}

/**
 * Sound one note in a part's voice (lib/rollPartVoice): through its plugin
 * when it plays one now, on its program otherwise. What the grid, the roll's
 * keyboard and the arpeggiator audition with.
 */
export function auditionRollVoice(
  midi: number,
  velocity: number,
  when: number,
  duration: number,
  master: number,
  voice: PianoNoteVoice & { vst?: { entryId: string; channel: number | null } },
): void {
  if (voice.vst && auditionRollVstNote(voice.vst.entryId, vstBaseChannel(voice.vst.channel), midi, velocity, when, duration)) return;
  triggerPianoNote(midi, velocity, when, duration, master, voice);
}

/** True while the MIDI tab hosts the roll's part instruments. */
export const rollInstrumentsAttached = (): boolean => attachCount > 0;

// A part that loses its instrument (or goes) takes the plugin's open window with it.
usePianoRollStore.subscribe((state, prev) => {
  if (state.tracks !== prev.tracks) vstEntryOwnersChanged();
});

// The live editor's captured state finds a part's instrument here, and a
// part's instrument counts as an entry that exists (state/vstEditorStore).
registerVstEntryOwner({
  find: (entryId) => partOfEntry(entryId)?.vstInstrument,
  setRawState: (entryId, rawState, stateHost) => storeRollVstState(entryId, rawState, stateHost),
});

/**
 * Keep a state captured from part instrument `entryId`'s plugin: on the part,
 * and on the EDIT clip the part was last sent to, whose part record a project
 * save writes, so the save keeps the sound. Neither write is an undo step.
 */
export function storeRollVstState(entryId: string, rawState: string, stateHost: VstStateHost): void {
  if (!rawState) return;
  usePianoRollStore.getState().setPartVstState(entryId, rawState, stateHost);
  const editor = useEditorStore.getState();
  for (const clip of editor.clips) {
    const ref = clip.sourceRollPart;
    if (ref?.vstInstrument?.id !== entryId || !ref.vstInstrument.vst) continue;
    const vstInstrument = { ...ref.vstInstrument, vst: { ...ref.vstInstrument.vst, raw_state: rawState, state_host: stateHost } };
    editor.applyClipRender(clip.id, { sourceRollPart: { ...ref, vstInstrument } });
  }
}
