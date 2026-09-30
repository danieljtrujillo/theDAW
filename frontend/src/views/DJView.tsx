/**
 * DJ tab — pro-DJ console (see MIX.png). Top: two full-width scrolling-overview
 * waveforms (the hero). Below, five regions edge-to-edge:
 *
 *   SAMPLER rail │ DECK A · MIXER · DECK B │ SOURCE TREE
 *                │ FX/STEMS-A · TRACK BROWSER · FX/STEMS-B │
 *
 * Decks carry their own header (art · title · BPM/KEY/Camelot · elapsed/remain),
 * a jog wheel with an inner PITCH fader, a compact transport, and the hotcue /
 * loop / roll / beat-jump performance pads. The narrow center MIXER holds GAIN,
 * 3-band EQ + single-knob FILTER, channel VOL faders, the crossfader, the
 * quantize / auto-gain toggles and the harmonic key-match chip. The center-
 * bottom TRACK BROWSER lists the selected source (the live Library or a set)
 * as a table; rows drag onto a deck or load via →A / →B. A slim NEXT staging
 * lane sits above the browser — drag tracks in to queue them play-next, reorder,
 * fire onto a deck, or push the queue into the active Automix set. The right
 * SOURCE TREE selects what the browser shows.
 *
 * Every below-waveform control is on the SLIDE surface (SlideKnob / SlideFader /
 * SlidePad / SlideCrossfader / RoundToggle) + the JogWheel — all lag-free. The
 * engine (djEngine) is the real 2-deck AudioBuffer transport. Per-deck logic
 * lives in `useDeck`, shared by the waveform lane and the deck column.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window';
import {
  Disc, Play, Pause, Plus, Save, Trash2, Cast, Music2, Square,
  ChevronDown, ChevronRight, Magnet, Gauge, Lock,
  KeyRound, Pencil, Search, Library as LibraryIcon, ListMusic, Sparkles, Download, Link2, Loader2, Shield, Headphones, Piano, X, Scissors, ArrowDownAZ, Plug, Wand2, Ban, Settings2, Repeat,
} from 'lucide-react';
import { subscribeToMidi } from '../state/midiBus';
import { useDjControlMap, sigLabel, type MidiKind, type MidiSig } from '../state/djControlMap';
import { midiIgnoreLabel, useMidiIgnoreStore } from '../state/midiIgnoreStore';
import { enableMidi } from '../state/midiTriggerStore';
import { useMidiDevicesStore } from '../state/midiDevicesStore';
import { useDjSampler, type SamplerPad } from '../state/djSamplerStore';
import { useDjSideList } from '../state/djSideListStore';
import { useFeatureToggleStore } from '../state/featureToggleStore';
import { IoGlobalSelect } from '../components/audio/IoDeviceSelect';
import { ControlSurface } from '../components/surface/ControlSurface';
import { InfiNightCredit } from '../components/ui/Credit';
import { autoKeylockRef, DJ_TARGETS, setUserKeylock } from '../state/bindableTargets';
import type { WidgetRegistry } from '../components/surface/widgetTypes';
import type { SurfaceLayout } from '../state/surfaceLayoutStore';
import { useAppUiStore } from '../state/appUiStore';
import {
  isBundledSetId,
  isPendingBundledRow,
  useSetlistStore,
  type SetlistEntry,
} from '../state/setlistStore';
import {
  AUTO_DJ_MIN_TRACKS,
  djAutomixEntries,
  firstPlayableOfActiveSet,
  readyActiveSetForAutomix,
  useDjAutomix,
  type AutomixStartMode,
} from '../state/djAutomixStore';
import { useDjDeckLoad } from '../state/djDeckLoadStore';
import { useLibraryStore } from '../state/libraryStore';
import type { LibraryEntry } from '../state/libraryStore';
import { fetchLibraryMatchCount, plainLibraryQuery } from '../lib/backendLocalProvider';
import type { LibrarySortBy } from '../lib/libraryRows';
import { useDjAnalysisStore } from '../state/djAnalysisStore';
import { useDjCuesStore, HOTCUE_SLOTS } from '../state/djCuesStore';
import { useDeckRhythm } from '../state/djRhythmStore';
import { seedCues as computeSeedCues } from '../lib/djCueSeed';
import { toCamelot, keyLabel } from '../lib/camelot';
import { buildBeatgrid } from '../lib/beatgrid';
import {
  automixCamelot, blendTick, createAutomixQueue, deckRun, eqSwap, mixOutPoint, PHASE_DEADBAND_SEC,
  planTransition, residualNudge, startBlend, tempoMatch, type BlendState,
} from '../lib/djAutomixPlan';
import { useDjAutomixPrefs } from '../state/djAutomixPrefsStore';
import { rgb, rgba, type RGB } from '../lib/trackColor';
import { DJSemanticWaveform } from '../components/audio/DJSemanticWaveform';
import { WaveformModeLegend, WaveformModeToggle } from '../components/audio/WaveformModeControl';
import { SlideKnob } from '../components/audio/SlideKnob';
import { SlideFader } from '../components/audio/SlideFader';
import { SlidePad } from '../components/audio/SlidePad';
import { SlideCrossfader } from '../components/audio/SlideCrossfader';
import { RoundToggle } from '../components/audio/RoundToggle';
import { JogWheel } from '../components/audio/JogWheel';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../components/ui/ContextMenu';
import { sendSetToVj, sendTrackToVj, isVjSetTargetActive, type VjSetItem } from '../state/vjSetBus';
import { registerDjMasterHandler, reportDjMasterState } from '../state/djMasterBus';
import { importUrlToLibrary } from '../lib/onlineImport';
import { importAudioFile } from '../lib/importAudioFiles';
import { DESKTOP_DROP_ORIGIN, dropHasLibraryOrFiles, entriesFromDrop } from '../lib/libraryDrop';
import { logInfo, logWarn } from '../state/logStore';
import { useWaveformStyleStore } from '../state/waveformStyleStore';
import { isStemsAborted, listStems, prepareStems, type SeparateOpts, type StemRef } from '../lib/djStems';
import * as djEngine from '../state/djEngine';

const DJ_TRACK_MIME = 'application/x-thedaw-djtrack';
const AUDIO_FILE_EXTENSIONS = new Set(['aac', 'aif', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'weba', 'webm']);

const DECK_RGB: Record<'purple' | 'cyan', RGB> = { purple: [34, 141, 211], cyan: [239, 68, 68] };

const EjectSymbol: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" {...props}>
    <path d="M12 5 5 14h14L12 5Z" fill="currentColor" />
    <path d="M5 19h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

const BEAT_SIZES: Array<{ beats: number; label: string }> = [
  { beats: 0.25, label: '¼' }, { beats: 0.5, label: '½' }, { beats: 1, label: '1' }, { beats: 2, label: '2' }, { beats: 4, label: '4' },
];
const ROLL_SIZES: Array<{ beats: number; label: string }> = [
  { beats: 0.25, label: '¼' }, { beats: 0.5, label: '½' }, { beats: 1, label: '1' },
];
const STEM_PAD_SLOTS = 6;
const AUTO_GAIN_TARGET_DB = -12;
const AUTOMIX_TAIL = 18;   // s before a track ends to begin the blend
const AUTOMIX_XFADE = 10;  // s the auto-crossfade takes
const AUTOMIX_RESCUE_XFADE = 1; // s — dead-air rescue: the outgoing deck is already silent
/** Pitch (%) past which a beatmatch needs key-lock. ~3 % is half a semitone;
 *  beyond that a "harmonic" Camelot pair audibly is not one any more. */
const KEYLOCK_PITCH_PCT = 3;
/* `autoKeylockRef` / `setUserKeylock` live in bindableTargets (imported above):
 * the MIDI `dj.keylock.<deck>` target needs the same flag, and DJView already
 * depends on that module, so putting them there keeps the single entry point
 * without a cycle. Module scope rather than a `useRef` also matches the
 * lifetime of what they describe — djEngine's decks outlive a DJView unmount,
 * so the flag must not reset under a lock that is still engaged. */
/** How long the automix seed waits for the first track's analysis before
 *  starting it anyway (ms) — dead air is worse than an unmatched first bar. */
const AUTOMIX_SEED_WAIT_MS = 3000;
/** How long the automix seed keeps waiting for a deck to DECODE before giving
 *  up entirely (ms). Separate from the analysis wait above: there is nothing
 *  to start without audio, so that wait has no deadline of its own — which is
 *  exactly how a dead URL used to poll every 150 ms for the whole session. */
const AUTOMIX_LOAD_TIMEOUT_MS = 15000;
const STOP_CUE_EPS = 0.05; // treat cue hits inside 50ms as "at this cue"

/** Keeps a ref pointed at the LATEST `value` on every render, so a long-lived
 *  effect that deliberately does not re-subscribe on every render (e.g. the
 *  automix interval below, which must not restart the sequence on every
 *  deck-state change) can still read `ref.current` and get the function from
 *  the render that just committed, instead of the one it closed over when it
 *  last (re)subscribed. Exported so the pattern itself is testable in
 *  isolation from djEngine. */
export function useLatestRef<T>(value: T): React.RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Automix (D7): should the outgoing deck blend into the incoming one right
 *  now? A prepared set's exact `mixOut` point on the outgoing track wins when
 *  present; otherwise it's due `tailSec` before the outgoing track ends. The
 *  assistant's "transition NOW" request (`pendingTransition`) jumps the blend
 *  early. Either way, the incoming deck must actually have a decoded buffer
 *  and the outgoing deck must be playing, or there is nothing to blend.
 *
 *  This is the BARE due rule. The automix interval itself now runs on
 *  `planTransition` (lib/djAutomixPlan), which quantises the same point
 *  (`mixOutPoint`, shared with this function so the two cannot disagree) down
 *  to a 16-beat phrase, refuses to mix into a track whose tempo is still
 *  unknown, and rescues the dead-air case this predicate cannot express — a
 *  stopped outgoing deck is never "due" here, yet that is exactly when the
 *  incoming track must start. */
export function automixTransitionDue(args: {
  playing: boolean;
  currentTime: number;
  duration: number;
  mixOut: number | null | undefined;
  tailSec: number;
  pendingTransition: boolean;
  incomingHasBuffer: boolean;
}): boolean {
  if (!args.playing || !args.incomingHasBuffer) return false;
  const point = mixOutPoint({ duration: args.duration, mixOut: args.mixOut }, args.tailSec);
  return (point != null && args.currentTime >= point) || args.pendingTransition;
}

/** One djEngine call the automix transition into `nxt` must make, in order. */
export type AutomixTransitionStep =
  | { type: 'seek'; deck: djEngine.DeckId; to: number }
  | { type: 'keylock'; deck: djEngine.DeckId; on: boolean }
  | { type: 'play'; deck: djEngine.DeckId }
  | { type: 'sync'; deck: djEngine.DeckId };

/** The ordered engine calls an automix transition into `nxt` makes: seek to
 *  the incoming track's start point, set its key-lock, start it playing,
 *  THEN beatmatch it.
 *
 *  - `keylock` comes before `play`: engaging or releasing it swaps the insert
 *    and re-balances this deck's delay line, which is silent on a deck that
 *    has not started and a warble on one that has. It used to run after the
 *    whole transition, on a playing deck.
 *  - `sync` must come after `play` — syncDeck's phase-align branch (see
 *    syncDeck below) only nudges playback into phase when BOTH decks already
 *    read as playing; called before `play`, the incoming deck always reads
 *    not-playing there, so only the tempo (pitch) half of the beatmatch would
 *    ever apply and phase never would.
 *  - `sync` is left out when the outgoing deck is not playing (the dead-air
 *    rescue). There is nothing to match, and with one deck playing syncDeck
 *    picks the stopped one as the follower, so the rescue pitched the
 *    finished outgoing deck to the incoming one.
 *
 *  Pure so the ORDER is testable without the engine. */
export function automixTransitionSteps(
  nxt: djEngine.DeckId,
  cueIn: number,
  opts: { masterPlaying: boolean; keylock: boolean | null },
): AutomixTransitionStep[] {
  const steps: AutomixTransitionStep[] = [{ type: 'seek', deck: nxt, to: cueIn }];
  if (opts.keylock != null) steps.push({ type: 'keylock', deck: nxt, on: opts.keylock });
  steps.push({ type: 'play', deck: nxt });
  if (opts.masterPlaying) steps.push({ type: 'sync', deck: nxt });
  return steps;
}

/** What automix does with the incoming deck's key-lock: engage it when the
 *  beatmatch pulls the pitch past `KEYLOCK_PITCH_PCT`, release it when a
 *  smaller pull follows a lock automix engaged itself, and otherwise leave it
 *  (a lock the DJ set by hand is theirs). No match without a playing master:
 *  the rescue has no pull to compensate for. */
export function automixKeylockStep(args: { pullPct: number; masterPlaying: boolean; lockedByAutomix: boolean }): boolean | null {
  if (args.masterPlaying && Math.abs(args.pullPct) > KEYLOCK_PITCH_PCT) return true;
  return args.lockedByAutomix ? false : null;
}

/** The decks the DJ master transport's play resumes, or null to start the set.
 *
 *  The master pause remembers which decks it paused, and play puts back
 *  exactly those. Play used to start every deck holding a track, which during
 *  automix also started the track staged on the idle deck. With nothing
 *  remembered and automix running, play resumes the deck automix is on (and
 *  the incoming one when a blend was running). */
export function masterResumeDecks(args: {
  paused: readonly djEngine.DeckId[] | null;
  holds: (d: djEngine.DeckId) => boolean;
  automix: { current: djEngine.DeckId; blending: boolean } | null;
}): djEngine.DeckId[] | null {
  const remembered = (args.paused ?? []).filter(args.holds);
  if (remembered.length) return remembered;
  if (args.automix) {
    const other: djEngine.DeckId = args.automix.current === 'A' ? 'B' : 'A';
    const decks = (args.automix.blending ? [args.automix.current, other] : [args.automix.current]).filter(args.holds);
    if (decks.length) return decks;
  }
  return null;
}

/** Where a deck is as the listener hears it (sec): its source position less
 *  what its delay line and key-lock insert hold back (`latencySec`, in track
 *  time at its rate). Phase sync compares these; two decks aligned by source
 *  position play out of time whenever one of them carries more latency. */
export function heardTime(st: djEngine.DeckStatus): number {
  return st.currentTime - st.latencySec * (1 + st.pitchPct / 100);
}

/** How far the follower's beat is behind the master's, as heard, in beats,
 *  wrapped to (−½, ½]. Positive = the follower is late and must move
 *  forward. Shared by syncDeck (× the beat length, for a nudge) and the
 *  sync-lock PLL. */
export function beatPhaseError(
  master: djEngine.DeckStatus,
  follower: djEngine.DeckStatus,
  masterBeats: number[] | null,
  followerBeats: number[] | null,
): number {
  let d = beatPhase(heardTime(master), masterBeats) - beatPhase(heardTime(follower), followerBeats);
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/** One step a start request makes, in order. */
export type AutomixStartStep = 'drop-transition' | 'eject' | 'on' | 'reseed';

/** The steps a start request takes once its set is ready, by how it treats
 *  the decks (see `AutomixStartMode`). `continue` only switches automix on:
 *  the automix effect seeds from whichever deck is playing, so a start pressed
 *  mid-track carries the set on from that track, as the Automix chip always
 *  has. `fresh` drops a stale "transition now", ejects both decks, switches
 *  automix on and bumps the restart counter, so a mix that is already running
 *  reseeds from track 1. START AUTO DJ used to take the `fresh` path through
 *  the Send-to-DJ bridge, which stopped a playing track dead and restarted the
 *  set. Pure so the order is testable without the engine. */
export function automixStartSteps(mode: AutomixStartMode): AutomixStartStep[] {
  return mode === 'fresh' ? ['drop-transition', 'eject', 'on', 'reseed'] : ['on'];
}

/** What one run of a deck-load effect tells the engine, and which library
 *  entry the deck holds afterwards (`holds`). */
export type DeckLoadStep =
  | { kind: 'keep'; holds: string | null }
  | { kind: 'clear'; holds: null }
  | { kind: 'load'; url: string; label: string | null; holds: string };

/**
 * The deck-load effect's decision.
 *
 * The effect re-runs whenever the library resolves an entry, because a deck
 * can hold a track on no loaded page (a Send-to-DJ id, a bundled-set id) and
 * only lands its audio once the single-entry lookup comes back. Those re-runs
 * used to call `djEngine.loadDeck` every time: a lookup for ANY other id
 * reloaded both decks and rewound a playing one to 0:00, and while the deck's
 * own entry was unresolved (its lookup in flight, or `refresh()` had just
 * dropped the id cache) the run passed a null URL and ejected the deck.
 *
 * - no entry id: clear the deck if it holds anything;
 * - an entry still unresolved: a deck already holding THAT entry keeps it; a
 *   deck asked for a different track stops the old one now and loads the new
 *   one when its lookup lands;
 * - a resolved entry whose URL the engine already holds, decoded or still
 *   decoding: nothing to do;
 * - otherwise load it. That includes the same URL after its load failed, so
 *   the next resolve of the entry retries it, as `djEngine.loadDeck` allows.
 *
 * @param entry        what `libraryStore.getById(entryId)` answers now; null
 *                     or undefined while it is unresolved.
 * @param loadedEntryId the entry this deck was last loaded with.
 * @param loadedUrl    the URL the engine holds (`djEngine.getStatus(deck)`).
 * @param holdsAudio   the engine has that URL's audio or is decoding it; false
 *                     after a failed load.
 */
export function deckLoadStep(args: {
  entryId: string | null;
  entry: Pick<LibraryEntry, 'audioUrl' | 'title'> | null | undefined;
  loadedEntryId: string | null;
  loadedUrl: string | null;
  holdsAudio: boolean;
}): DeckLoadStep {
  const { entryId, entry, loadedEntryId, loadedUrl, holdsAudio } = args;
  if (!entryId) return loadedUrl ? { kind: 'clear', holds: null } : { kind: 'keep', holds: null };
  if (!entry) {
    if (entryId === loadedEntryId) return { kind: 'keep', holds: loadedEntryId };
    return loadedUrl ? { kind: 'clear', holds: null } : { kind: 'keep', holds: null };
  }
  const url = entry.audioUrl || null;
  if (!url) return loadedUrl ? { kind: 'clear', holds: null } : { kind: 'keep', holds: null };
  if (url === loadedUrl && holdsAudio) return { kind: 'keep', holds: entryId };
  return { kind: 'load', url, label: entry.title ?? null, holds: entryId };
}

/** Run one deck-load step against the engine and record what the deck holds.
 *  The deck-load effects call this and nothing else. */
export function syncDeckToEntry(
  deck: djEngine.DeckId,
  entryId: string | null,
  entry: LibraryEntry | null | undefined,
  held: Record<djEngine.DeckId, string | null>,
): DeckLoadStep {
  const st = djEngine.getStatus(deck);
  const step = deckLoadStep({
    entryId,
    entry,
    loadedEntryId: held[deck],
    loadedUrl: st.loadedUrl,
    holdsAudio: st.hasBuffer || st.decoding,
  });
  held[deck] = step.holds;
  if (step.kind === 'load') void djEngine.loadDeck(deck, step.url, step.label);
  else if (step.kind === 'clear') void djEngine.loadDeck(deck, null, null);
  return step;
}
const PITCH_RANGES = [10, 15] as const;
type PitchRange = typeof PITCH_RANGES[number];

/* ══════════════════ DJ-3: starting a set, and saying why not ═════════════════
 *
 * "its not intuitive to start". Until now the only one-click way in was a
 * 12-pixel ▶ inside the Source Tree's "Sets" group, and the `Automix` chip —
 * the thing that looks like the start button — silently un-toggled itself
 * whenever the active set had fewer than two registered ids, leaving a 10-pixel
 * line in the footer for 2.2 seconds. `startAutoDjState` is the whole decision
 * in one pure function so the header button can SAY what is missing instead.
 *
 * `enabled` is about the automix path, not about the DOM: the button is always
 * a live `<button>` (a `disabled` one loses its tooltip and its place in tab
 * order, so the reason would never reach the user) and carries `aria-disabled`
 * plus the reason in `title` when it cannot start. The "no sets at all" case
 * still acts on click — it makes the set the user is being told to make.
 */
export type StartAutoDjIntent = 'start' | 'stop' | 'create-set' | 'pick-set' | 'add-tracks';

export interface StartAutoDjState {
  label: 'START AUTO DJ' | 'STOP AUTO DJ';
  /** Does this press DO something? False only when the click cannot change
   *  anything — that, and only that, is what `aria-disabled` may claim.
   *  "No sets at all" is `true`: the press creates the set it is asking for,
   *  and announcing a real mutation as unavailable is a lie to a screen
   *  reader. `reason` still carries what is missing. */
  enabled: boolean;
  intent: StartAutoDjIntent;
  /** Exactly what is missing, for `title`. Null when nothing is. */
  reason: string | null;
}

// The minimum and the playable-row predicate live in djAutomixStore, next to
// `readyActiveSetForAutomix`, which every start path (the assistant's
// included) runs before automix turns on. Re-exported so this view stays the
// one import for the DJ-3 decisions.
export { AUTO_DJ_MIN_TRACKS, djAutomixEntries };

/** How many tracks of a set the START button may offer to play: the rows
 *  automix can sequence right now, plus — for a bundled set — the rows that
 *  registering it turns into exactly those. A fresh bundled set lists every
 *  track as `entryId: null` (GET /setlists is read-only; the entries are
 *  created on register), so counting only registered ids would make a full
 *  set look empty until somebody clicked it.
 *
 *  The gap this leaves is real and is the caller's job: while the rows are
 *  still unregistered this count is ABOVE what `djAutomixEntries` finds, so
 *  anything that starts the mix must register first. See
 *  `readyActiveSetForAutomix`, which every start path runs. */
export function djPlayableCount(
  set: { bundled: boolean; entries: readonly SetlistEntry[] } | null | undefined,
): number {
  if (!set) return 0;
  const pending = set.bundled ? set.entries.filter(isPendingBundledRow).length : 0;
  return djAutomixEntries(set.entries).length + pending;
}

export function startAutoDjState(args: {
  /** How many setlists exist at all. */
  setCount: number;
  /** Is one of them active (the automix sequencer reads only the active one)? */
  hasActiveSet: boolean;
  /** Tracks in the active set that can be played — registered, or a bundled
   *  row still waiting for its id (opening the set creates it). */
  playableCount: number;
  automixOn: boolean;
}): StartAutoDjState {
  // A running mix is always stoppable, whatever happened to the set behind it.
  if (args.automixOn) {
    return { label: 'STOP AUTO DJ', enabled: true, intent: 'stop', reason: null };
  }
  const blocked = (intent: StartAutoDjIntent, reason: string): StartAutoDjState => ({
    label: 'START AUTO DJ', enabled: false, intent, reason,
  });
  if (args.setCount === 0) {
    // The press makes the set it is asking for, so it is an action, not a
    // dead control: see `enabled` above.
    return { label: 'START AUTO DJ', enabled: true, intent: 'create-set', reason: 'Create a set first' };
  }
  if (!args.hasActiveSet) return blocked('pick-set', 'Pick a set below');
  if (args.playableCount < AUTO_DJ_MIN_TRACKS) {
    return blocked('add-tracks', `Add at least ${AUTO_DJ_MIN_TRACKS} tracks to this set`);
  }
  return { label: 'START AUTO DJ', enabled: true, intent: 'start', reason: null };
}

const START_AUTO_DJ_TITLE: Record<StartAutoDjIntent, string> = {
  start: 'Start Auto DJ — load, beatmatch and crossfade the active set hands-free',
  stop: 'Stop Auto DJ — the decks keep playing, the sequencer stops',
  'create-set': 'Create a set first — click to make one',
  'pick-set': 'Pick a set below',
  'add-tracks': `Add at least ${AUTO_DJ_MIN_TRACKS} tracks to this set`,
};

/** The accessible name per intent. A blocked press carries its reason here
 *  as well as in `title`: a screen reader announces the name and generally
 *  drops the tooltip, so "Pick a set below" would otherwise never be heard. */
const START_AUTO_DJ_ARIA: Record<StartAutoDjIntent, string> = {
  start: 'Start Auto DJ',
  stop: 'Stop Auto DJ',
  'create-set': 'Create a set',
  'pick-set': 'Start Auto DJ — pick a set below first',
  'add-tracks': `Start Auto DJ — add at least ${AUTO_DJ_MIN_TRACKS} tracks to this set first`,
};

/** The one obvious way in. Lives in the DJ tab header, above the decks. */
export const StartAutoDjButton: React.FC<{
  state: StartAutoDjState;
  onActivate: (intent: StartAutoDjIntent) => void;
}> = ({ state, onActivate }) => {
  const running = state.intent === 'stop';
  return (
    <button
      type="button"
      data-tour="dj-start"
      onClick={() => onActivate(state.intent)}
      aria-disabled={!state.enabled}
      aria-label={START_AUTO_DJ_ARIA[state.intent]}
      title={START_AUTO_DJ_TITLE[state.intent]}
      className={`shrink-0 flex items-center gap-1.5 px-3 py-1 rounded-md border text-xs font-black uppercase tracking-[0.14em] transition-colors ${
        running
          ? 'border-rose-400/60 bg-rose-500/20 text-rose-100 hover:bg-rose-500/30'
          : state.enabled
            ? 'border-emerald-400/70 bg-emerald-500/20 text-emerald-100 shadow-[0_0_18px_rgba(16,185,129,0.3)] hover:bg-emerald-500/30'
            : 'border-white/15 bg-white/5 text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {running ? <Square className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
      <span>{state.label}</span>
    </button>
  );
};

/** Shown over the decks while nothing is loaded and nothing is mixing. Three
 *  lines, no controls — it is a caption, not a wizard, and it disappears the
 *  moment a deck has a track. Rendered outside the ControlSurface so Design
 *  Mode never persists it as a widget.
 *
 *  NOT `aria-hidden`: these are the only start instructions in the tab, and
 *  hiding them from the accessibility tree left a screen-reader user on an
 *  empty DJ view with nothing to read. `pointer-events-none` is what stops
 *  it swallowing clicks meant for the decks, and that is the whole job. */
export const DjStartHint: React.FC = () => (
  <div className="pointer-events-none absolute inset-x-0 top-1/2 z-20 -translate-y-1/2 flex justify-center px-4">
    <div className="max-w-md rounded-lg border border-white/10 bg-black/70 px-4 py-3 text-xs font-bold leading-relaxed text-zinc-400 backdrop-blur-sm">
      <div data-dj-hint-line className="text-zinc-200 font-bold">1 · Pick a set in the list on the left</div>
      <div data-dj-hint-line>2 · Press START AUTO DJ above the decks</div>
      <div data-dj-hint-line>3 · Or drag a track straight onto a deck</div>
    </div>
  </div>
);

/** The "Harmonic order" switch in the START AUTO DJ row. On, automix may play
 *  a Camelot-compatible track ahead of a key clash; every track it plays
 *  ahead of stays in the queue, a prepared performance set still plays as
 *  prepared, and only keys the analysis is confident in count. Off, the set
 *  plays strictly in order. Persisted (`djAutomixPrefsStore`); it used to be a
 *  constant with no way to turn it off. */
export const HarmonicOrderToggle: React.FC<{ on: boolean; onToggle: () => void }> = ({ on, onToggle }) => (
  <button
    type="button"
    aria-pressed={on}
    onClick={onToggle}
    title={on
      ? 'Harmonic order is on: Auto-DJ may play a key-compatible track ahead of a clash. Prepared sets always play as prepared.'
      : 'Harmonic order is off: Auto-DJ plays the set strictly in order.'}
    className={`ml-auto shrink-0 px-2 py-0.5 rounded-md border text-xs font-bold transition-colors ${
      on ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-200' : 'border-white/10 text-zinc-400 hover:text-zinc-200'
    }`}
  >
    Harmonic order
  </button>
);

/** One row of the Source Tree's "Sets" group. Extracted so its state — which
 *  set is ACTIVE, and whether a register is in flight — is testable, and
 *  because the old row highlighted `source.id` while automix played
 *  `activeId`: after a Send-to-DJ those are different sets, so the tree
 *  pointed at one list while the decks played another. */
export const DjSetRow: React.FC<{
  name: string;
  count: number;
  /** Driven by `setlistStore.activeId` — the set automix actually reads. */
  isActive: boolean;
  playable: boolean;
  /** A `/register` POST is in flight for this row. */
  busy: boolean;
  onOpen: () => void;
  onPlay: () => void;
}> = ({ name, count, isActive, playable, busy, onOpen, onPlay }) => (
  <div
    aria-busy={busy}
    className={`w-full flex items-center gap-1.5 pl-4 pr-1.5 py-0.5 text-xs font-bold rounded transition-colors ${isActive ? 'bg-purple-500/15 text-purple-200' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
  >
    <span className={`w-1 h-1 rounded-full shrink-0 ${isActive ? 'bg-purple-300' : 'bg-zinc-700'}`} />
    <button
      type="button"
      onClick={() => { if (!busy) onOpen(); }}
      aria-disabled={busy}
      aria-current={isActive ? true : undefined}
      title={busy ? `Opening "${name}" — registering its tracks…` : `Open set "${name}"`}
      className="flex-1 min-w-0 truncate text-left bg-transparent"
    >
      {name}
    </button>
    {isActive && (
      <span className="shrink-0 rounded-sm bg-purple-400/20 px-1 text-xs font-black tracking-widest text-purple-200">
        ACTIVE
      </span>
    )}
    {busy
      ? <Loader2 className="w-2.5 h-2.5 shrink-0 animate-spin text-purple-300" aria-hidden="true" />
      : <span className="text-xs font-bold text-zinc-500 shrink-0" title={`${count} tracks`}>{count}</span>}
    <button
      type="button"
      onClick={() => { if (playable && !busy) onPlay(); }}
      aria-disabled={!playable || busy}
      title={
        busy ? 'Registering this set’s tracks…'
          : !playable ? `Add at least ${AUTO_DJ_MIN_TRACKS} tracks to Auto-DJ this set`
            : `Auto-DJ "${name}" — load, beatmatch & crossfade the whole set hands-free`
      }
      aria-label={
        // The reason goes in the NAME, not only in `title`: a screen reader
        // reads the accessible name and drops the tooltip, so a user who
        // cannot see the dimmed ▶ was told nothing at all.
        busy
          ? `Play set ${name} with Auto-DJ — registering its tracks, please wait`
          : !playable
            ? `Play set ${name} with Auto-DJ — add at least ${AUTO_DJ_MIN_TRACKS} tracks first`
            : `Play set ${name} with Auto-DJ`
      }
      className={`shrink-0 p-0.5 rounded text-emerald-400 ${playable && !busy ? 'hover:text-emerald-200 hover:bg-emerald-500/15' : 'opacity-25'}`}
    >
      <Play className="w-3 h-3" />
    </button>
  </div>
);

/* ══════════════════ DJ-3: the deck beatgrid ═════════════════════════════════
 *
 * Two bugs in one `useMemo`: every fourth beat was drawn as a bar line
 * (`i % 4 === 0` — wrong from beat one on anything with a pickup, or not in
 * 4/4), and off-beat ticks were dropped entirely above a hard 400 beats, so a
 * six-minute track lost its grid no matter how wide the lane or how far the
 * user had zoomed in. Downbeats now come from the rhythm module when its cache
 * has them, and the cutoff is a pixels-per-tick budget against the real lane.
 */
/** Below this many pixels apart, beat ticks read as a smear — drop to bars. */
const MIN_BEAT_TICK_PX = 3;
/** Used when the lane has not been measured yet (first paint). */
const ASSUMED_LANE_PX = 600;
/** A grid beat this close to a detected downbeat is that bar line, not a
 *  tick of its own. Half a beat at 200bpm — tight enough not to swallow the
 *  neighbouring beat. */
const DOWNBEAT_EPS = 0.08;

export function beatMarkPositions(args: {
  beats: number[] | null;
  downbeats: number[] | null;
  dur: number;
  viewStart: number;
  viewEnd: number;
  visibleFrac: number;
  widthPx: number;
}): Array<{ left: number; down: boolean }> | null {
  const { beats, downbeats, dur, viewStart, viewEnd, visibleFrac } = args;
  if (!beats || beats.length === 0 || dur <= 0 || visibleFrac <= 0) return null;
  const width = args.widthPx > 0 ? args.widthPx : ASSUMED_LANE_PX;
  // How many of these beats are on screen right now, and how much room each
  // would get. Zooming in raises the budget; a narrow lane lowers it.
  const onScreen = Math.max(1, beats.length * visibleFrac);
  const dense = width / onScreen >= MIN_BEAT_TICK_PX;

  const place = (t: number): number | null => {
    const pos = t / dur;
    return pos < viewStart || pos > viewEnd ? null : ((pos - viewStart) / visibleFrac) * 100;
  };
  const out: Array<{ left: number; down: boolean }> = [];

  if (!downbeats || downbeats.length === 0) {
    for (let i = 0; i < beats.length; i++) {
      const down = i % 4 === 0;
      if (!dense && !down) continue;
      const left = place(beats[i]);
      if (left != null) out.push({ left, down });
    }
    return out;
  }

  // Real bar lines: the detected downbeats themselves. They used to be
  // matched against the constant grid within DOWNBEAT_EPS, so on a track
  // whose tempo drifts off its grid every bar past the first few failed the
  // match — and at overview zoom, where only bar lines are drawn, the lane
  // showed no grid at all. Grid beats are ticks between them (dense only),
  // skipping any that sit on a bar line. Both lists are in time order, so
  // one forward pass merges them.
  let di = 0;
  const pushDownbeatsUpTo = (limit: number) => {
    while (di < downbeats.length && downbeats[di] <= limit) {
      const left = place(downbeats[di]);
      if (left != null) out.push({ left, down: true });
      di++;
    }
  };
  let near = 0;
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i];
    pushDownbeatsUpTo(t);
    if (!dense) continue;
    while (near < downbeats.length - 1 && downbeats[near + 1] <= t) near++;
    const onBar = Math.abs(downbeats[near] - t) <= DOWNBEAT_EPS
      || (near + 1 < downbeats.length && Math.abs(downbeats[near + 1] - t) <= DOWNBEAT_EPS);
    if (onBar) continue;
    const left = place(t);
    if (left != null) out.push({ left, down: false });
  }
  pushDownbeatsUpTo(Number.POSITIVE_INFINITY);
  return out;
}

/* DJ MIDI-learn (D6): the bindable actions, grouped for the map panel. CC →
 * continuous (xfader/vol/eq/filter/pitch); note → trigger (play/cue/sync/hotcue). */
const deckMidiActions = (d: 'A' | 'B'): Array<{ id: string; label: string; group: string; kind: MidiKind }> =>
  ([
    { id: `play${d}`, label: 'Play', kind: 'note' as MidiKind },
    { id: `cue${d}`, label: 'Cue', kind: 'note' as MidiKind },
    { id: `stop${d}`, label: 'Stop', kind: 'note' as MidiKind },
    { id: `sync${d}`, label: 'Sync', kind: 'note' as MidiKind },
    { id: `headcue${d}`, label: 'Cue (HP)', kind: 'note' as MidiKind },
    { id: `vol${d}`, label: 'Volume', kind: 'cc' as MidiKind },
    { id: `gain${d}`, label: 'Gain', kind: 'cc' as MidiKind },
    { id: `filter${d}`, label: 'Filter', kind: 'cc' as MidiKind },
    { id: `pitch${d}`, label: 'Pitch', kind: 'cc' as MidiKind },
    { id: `eq${d}.high`, label: 'EQ Hi', kind: 'cc' as MidiKind },
    { id: `eq${d}.mid`, label: 'EQ Mid', kind: 'cc' as MidiKind },
    { id: `eq${d}.low`, label: 'EQ Lo', kind: 'cc' as MidiKind },
    ...Array.from({ length: STEM_PAD_SLOTS }, (_, i) => ({ id: `stem${d}${i}`, label: `Stem ${i + 1}`, kind: 'note' as MidiKind })),
    ...[1, 2, 3, 4].map((n) => ({ id: `hotcue${d}${n}`, label: `Hotcue ${n}`, kind: 'note' as MidiKind })),
  ]).map((a) => ({ ...a, group: `Deck ${d}` }));

const MIDI_ACTIONS: Array<{ id: string; label: string; group: string; kind: MidiKind }> = [
  { id: 'xfader', label: 'Crossfader', group: 'Mixer', kind: 'cc' },
  ...deckMidiActions('A'),
  ...deckMidiActions('B'),
];
const MIDI_ACTION_BY_ID = new Map(MIDI_ACTIONS.map((a) => [a.id, a]));

type DjMidiPreset = {
  id: string;
  label: string;
  match: string[];
  bindings: Record<string, MidiSig>;
};

const cc = (number: number, channel: number | null = null): MidiSig => ({ kind: 'cc', number, channel });
const note = (number: number, channel: number | null = null): MidiSig => ({ kind: 'note', number, channel });

const DJ_MIDI_PRESETS: DjMidiPreset[] = [
  {
    id: 'novation-launch-control-xl-user1',
    label: 'Novation Launch Control XL',
    match: ['launch control xl', 'lcxl'],
    bindings: {
      // Common User Template 1 layout. Channels are intentionally "any" because
      // Launch Control XL templates can be edited or shifted per user template.
      'eqA.high': cc(13),
      'eqA.mid': cc(14),
      'eqA.low': cc(15),
      filterA: cc(16),
      'eqB.high': cc(17),
      'eqB.mid': cc(18),
      'eqB.low': cc(19),
      filterB: cc(20),
      volA: cc(77),
      pitchA: cc(78),
      gainA: cc(79),
      xfader: cc(80),
      gainB: cc(82),
      pitchB: cc(83),
      volB: cc(84),
      playA: note(41),
      cueA: note(42),
      syncA: note(43),
      headcueA: note(44),
      playB: note(45),
      cueB: note(46),
      syncB: note(47),
      headcueB: note(48),
      hotcueA1: note(57),
      hotcueA2: note(58),
      hotcueA3: note(59),
      hotcueA4: note(60),
      hotcueB1: note(61),
      hotcueB2: note(62),
      hotcueB3: note(63),
      hotcueB4: note(64),
    },
  },
];

/** Source feeding the center Track Browser. The non-set kinds are live filtered
 *  views over the library (favorites / by origin) — all real, no placeholders. */
type LibSourceKind = 'library' | 'favorites' | 'gen' | 'import';
type Source = { kind: LibSourceKind } | { kind: 'set'; id: string };

const LIB_SOURCE_LABEL: Record<LibSourceKind, string> = {
  library: 'Library', favorites: 'Favorites', gen: 'Generated', import: 'Imports',
};
/**
 * A source tab as the library store's own filters. The store sends them to the
 * backend, which is what lets the browser page through 200,000 rows instead of
 * filtering the few hundred it happens to hold.
 */
const libSourceQuery = (kind: LibSourceKind): { favorite: boolean; source: string | null } => {
  switch (kind) {
    case 'favorites': return { favorite: true, source: null };
    case 'gen': return { favorite: false, source: 'generate' };
    case 'import': return { favorite: false, source: 'import' };
    default: return { favorite: false, source: null };
  }
};

/** One browser row, whether it came from the library or from a set. */
interface DjBrowserRow {
  entryId: string | null;
  title: string;
  bpm: number | null;
  key: string | null;
  dur: number | null;
  date: string | null;
  source: string;
  order: number;
  setIndex?: number;
}

type DjSortKey = 'order' | 'bpm' | 'title' | 'key' | 'dur' | 'date' | 'source';

/**
 * The library sort that answers this column, or null when only the loaded rows
 * can be put in this order.
 *
 * BPM and KEY come from the DJ's own analysis store, and SOURCE has no server
 * order at all, so those three — plus the two directions the library does not
 * offer — sort what is in hand and say so in the header.
 */
const djServerSort = (key: DjSortKey, dir: 'asc' | 'desc'): LibrarySortBy | null => {
  switch (key) {
    case 'order': return dir === 'asc' ? 'newest' : 'oldest';
    case 'date': return dir === 'asc' ? 'oldest' : 'newest';
    case 'title': return dir === 'asc' ? 'title' : null;
    case 'dur': return dir === 'desc' ? 'duration' : null;
    default: return null;
  }
};

/** The one column template the header and every row share. */
const DJ_BROWSER_GRID = '1.8rem 4.1rem minmax(10rem,1fr) 2.7rem 2.5rem 2.9rem 3.3rem 4.2rem';
/** Row height in px: `py-0.5` around a 9px line, plus its bottom border. */
const DJ_BROWSER_ROW_HEIGHT = 20;

const djDateLabel = (v: string | null): string => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

interface DjBrowserRowProps {
  /** The row at a GLOBAL index, or undefined while its page is coming. */
  rowAt: (index: number) => DjBrowserRow | undefined;
  /** Changes identity whenever the rows behind `rowAt` do. */
  revision: number;
  isSet: boolean;
  onLoadDeck: (entryId: string, deck: djEngine.DeckId) => void;
  onStage: (entryId: string, title: string) => void;
  onSendVj: (row: DjBrowserRow) => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (setIndex: number) => void;
  onContextMenu: (e: React.MouseEvent, row: DjBrowserRow) => void;
}

/** A single virtualized browser row. Drag source and load buttons unchanged. */
function DjBrowserRowView({
  index,
  style,
  ariaAttributes,
  rowAt,
  isSet,
  onLoadDeck,
  onStage,
  onSendVj,
  onReorder,
  onRemove,
  onContextMenu,
}: RowComponentProps<DjBrowserRowProps>) {
  const r = rowAt(index);
  if (!r) {
    return (
      <div style={style} className="px-2 py-0.5" {...ariaAttributes}>
        <div aria-hidden="true" className="h-3 rounded bg-white/5 animate-pulse" />
      </div>
    );
  }
  return (
    <div
      // react-window positions the row; the grid template is the header's, so
      // the columns below line up with the sort buttons above.
      style={{ ...style, gridTemplateColumns: DJ_BROWSER_GRID }}
      {...ariaAttributes}
      draggable={!!r.entryId}
      onContextMenu={(e) => onContextMenu(e, r)}
      onDragStart={(ev) => {
        if (!r.entryId) return;
        ev.dataTransfer.effectAllowed = 'copy';
        ev.dataTransfer.setData(DJ_TRACK_MIME, r.entryId);
        ev.dataTransfer.setData('text/plain', r.title);
      }}
      className="grid items-center gap-1 px-2 overflow-hidden text-xs font-semibold tabular-nums text-zinc-400 hover:bg-white/5 border-b border-white/3 group/row cursor-grab active:cursor-grabbing"
    >
      <span className="text-right text-zinc-600">{String(r.order).padStart(2, '0')}</span>
      <span className="truncate text-zinc-600" title={r.date ?? undefined}>{djDateLabel(r.date)}</span>
      <span className="truncate text-zinc-300" title={r.title}>{r.title}</span>
      <span className="text-right tabular-nums text-zinc-500">{r.bpm != null ? r.bpm.toFixed(0) : '—'}</span>
      <span className="text-zinc-500">{r.key ?? '—'}</span>
      <span className="text-right tabular-nums text-zinc-600">{r.dur != null ? fmtTime(r.dur) : '—'}</span>
      <span className="truncate text-zinc-600 capitalize">{r.source}</span>
      <span className="flex items-center gap-0.5 justify-end pr-0.5">
        {isSet ? (
          <span className="hidden group-hover/row:flex items-center gap-0.5">
            <button onClick={() => onReorder(r.setIndex!, r.setIndex! - 1)} disabled={r.setIndex === 0} className="p-0.5 text-zinc-600 hover:text-zinc-200 disabled:opacity-20" title="Move up"><ChevronDown className="w-2.5 h-2.5 rotate-180" /></button>
            <button onClick={() => onReorder(r.setIndex!, r.setIndex! + 1)} className="p-0.5 text-zinc-600 hover:text-zinc-200" title="Move down"><ChevronDown className="w-2.5 h-2.5" /></button>
            <button onClick={() => onRemove(r.setIndex!)} className="p-0.5 text-zinc-600 hover:text-rose-400" title="Remove from set"><Trash2 className="w-2.5 h-2.5" /></button>
          </span>
        ) : null}
        {r.entryId && <button onClick={() => onStage(r.entryId!, r.title)} className="hidden group-hover/row:inline p-0.5 text-zinc-600 hover:text-purple-300" title="Stage in Next queue"><ListMusic className="w-2.5 h-2.5" /></button>}
        <button onClick={() => r.entryId && onLoadDeck(r.entryId, 'A')} disabled={!r.entryId} className="px-1 py-0.5 rounded text-xs font-black text-purple-300 hover:bg-purple-500/20 disabled:opacity-30" title="Load onto Deck A">→A</button>
        <button onClick={() => r.entryId && onLoadDeck(r.entryId, 'B')} disabled={!r.entryId} className="px-1 py-0.5 rounded text-xs font-black text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-30" title="Load onto Deck B">→B</button>
        {!isSet && r.entryId && <button onClick={() => onSendVj(r)} className="hidden group-hover/row:inline p-0.5 text-zinc-600 hover:text-cyan-300" title="Send to VJ"><Cast className="w-2.5 h-2.5" /></button>}
      </span>
    </div>
  );
}

const isExternalAudioFile = (file: File): boolean => {
  if (file.type.startsWith('audio/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_FILE_EXTENSIONS.has(ext);
};

const hasDeckLoadDragData = (event: React.DragEvent): boolean => {
  const dt = event.dataTransfer;
  if (Array.from(dt.types).includes(DJ_TRACK_MIME)) return true;
  return Array.from(dt.items ?? []).some((item) => item.kind === 'file' && (item.type.startsWith('audio/') || item.type === ''));
};

/** Finder/Explorer drops onto a deck or a set. The same helper as the header
 *  IMPORT button; only the recorded provenance differs (the one every desktop
 *  drop surface shares, from lib/libraryDrop). */
const importAudioFileToLibrary = (file: File): Promise<LibraryEntry> =>
  importAudioFile(file, DESKTOP_DROP_ORIGIN);

const sameStringArray = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const sameNumberRecord = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 0.0001);
};

function sortedCuePoints(cues: Array<number | null> | undefined): number[] {
  return (cues ?? [])
    .filter((c): c is number => c != null && Number.isFinite(c))
    .sort((a, b) => a - b);
}

function nextCueAfter(cues: Array<number | null> | undefined, currentTime: number): number | null {
  const points = sortedCuePoints(cues);
  if (points.length === 0) return null;
  return points.find((c) => c > currentTime + STOP_CUE_EPS) ?? points[0];
}

/* ═══════════════════════════ per-deck controller ═══════════════════════════ */

function useDeck(deckId: djEngine.DeckId, entryId: string | null, hasTrack: boolean, quantize: boolean, autoGain: boolean, manualGain: number) {
  const ensureAnalyzed = useDjAnalysisStore((s) => s.ensureAnalyzed);
  const analysisEntry = useDjAnalysisStore((s) => (entryId ? s.byId[entryId] ?? null : null));
  useEffect(() => { if (entryId) void ensureAnalyzed(entryId); }, [entryId, ensureAnalyzed]);

  const a = analysisEntry?.data ?? null;
  const analyzing = analysisEntry?.status === 'running';
  const cam = a ? toCamelot(a.key, a.scale) : null;
  const bpm = a?.bpm ?? null;
  const beats = a?.beats ?? null;
  const beatLen = bpm && bpm > 0 ? 60 / bpm : null;
  const grid = useMemo(() => buildBeatgrid({ bpm, beats, duration: a?.duration_sec }), [bpm, beats, a?.duration_sec]);
  const gridBeats = grid?.beats ?? beats;
  const firstBeat = beats && beats.length > 0 ? beats[0] : null;

  const cues = useDjCuesStore((s) => (entryId ? s.byEntry[entryId] : undefined));
  const setCue = useDjCuesStore((s) => s.setCue);
  const clearCue = useDjCuesStore((s) => s.clearCue);

  const [loopActive, setLoopActiveSt] = useState(false);
  const [activeLoopBeats, setActiveLoopBeats] = useState<number | null>(null);
  const [slip, setSlipSt] = useState(false);
  const [decoding, setDecoding] = useState(false);
  const [keylock, setKeylockSt] = useState(false);
  // readonly: djEngine hands back a shared frozen empty when a deck has no
  // stems (see DeckStatus), and these hold whatever it handed back.
  const [stemNames, setStemNames] = useState<readonly string[]>(() => djEngine.getDeckStemNames(deckId));
  const [stemLevels, setStemLevels] = useState<Readonly<Record<string, number>>>({});
  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    setLoopActiveSt((p) => (p === st.loopActive ? p : st.loopActive));
    setSlipSt((p) => (p === st.slip ? p : st.slip));
    setDecoding((p) => (p === st.decoding ? p : st.decoding));
    setKeylockSt((p) => (p === st.keylock ? p : st.keylock));
    setStemNames((p) => (sameStringArray(p, st.stems) ? p : st.stems));
    setStemLevels((p) => (sameNumberRecord(p, st.stemLevels) ? p : st.stemLevels));
  }), [deckId]);
  useEffect(() => { if (!loopActive) setActiveLoopBeats(null); }, [loopActive]);

  const autoCuedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!entryId || autoCuedRef.current === entryId) return;
    if (firstBeat == null || firstBeat <= 0.05) return;
    const st = djEngine.getStatus(deckId);
    if (st.duration <= 0) return;
    if (!st.playing && st.currentTime <= 0.05) djEngine.seekDeck(deckId, firstBeat);
    autoCuedRef.current = entryId;
  }, [entryId, firstBeat, deckId, decoding]);

  // ── DJ-3: hot cues, without anybody pressing anything ──
  // This effect used to seek to the first beat and stop there, writing no
  // cue — so the pads stayed empty and the waveform had no markers on it
  // ("i dont see cue points"). Now the analysis that lands here also places
  // the four cues a DJ would: see lib/djCueSeed for the rule.
  //
  // `djCuesStore.seedCues` owns every "may I write here" decision (empty
  // slots only; never on a track the user has touched), so this side can
  // stay a plain "whenever the inputs improve, offer a seed".
  const seedCuesInto = useDjCuesStore((s) => s.seedCues);
  // Cheap GET only, re-asked whenever a rhythm run elsewhere in the app calls
  // `invalidateRhythm` for this entry. See `useDeckRhythm`.
  const rhythm = useDeckRhythm(entryId);
  const durationSec = a?.duration_sec ?? 0;

  useEffect(() => {
    if (!entryId) return;
    const times = computeSeedCues({
      beats: gridBeats,
      firstBeat,
      bpm,
      duration: durationSec,
      downbeats: rhythm?.downbeats ?? null,
      bars: rhythm?.bars ?? null,
    });
    // `null` = no bpm / no beats yet. Re-runs when the rhythm cache lands and
    // moves the phrase cues onto real bar lines — but only while every cue on
    // the track is still one this store placed.
    if (times) seedCuesInto(entryId, times);
  }, [entryId, bpm, gridBeats, firstBeat, durationSec, rhythm, seedCuesInto]);

  // Trim follows loudness-matched auto-gain when enabled, else the manual GAIN knob.
  const autoTrim = a?.rms_db != null ? Math.max(-15, Math.min(15, AUTO_GAIN_TARGET_DB - a.rms_db)) : 0;
  const trimDb = autoGain ? autoTrim : manualGain;
  useEffect(() => { djEngine.setDeckTrim(deckId, trimDb); }, [deckId, trimDb]);

  const setHotcue = (i: number) => {
    if (!entryId) return;
    const c = cues?.[i] ?? null;
    if (c == null) { const pos = djEngine.getStatus(deckId).currentTime; setCue(entryId, i, quantize ? nearestBeat(pos, gridBeats) : pos); }
    else djEngine.seekDeck(deckId, quantize ? nearestBeat(c, gridBeats) : c);
  };
  const dropHotcue = (i: number) => { if (entryId) clearCue(entryId, i); };

  const effBeatLen = beatLen ?? 0.5;
  const toggleBeatLoop = (loopBeats: number) => {
    if (!hasTrack) return;
    if (loopActive && activeLoopBeats === loopBeats) { djEngine.exitLoop(deckId); return; }
    const len = loopBeats * effBeatLen;
    const pos = djEngine.getStatus(deckId).currentTime;
    let inPt = pos;
    if (gridBeats && gridBeats.length) {
      const anchor = snapToBeat(pos, gridBeats);
      inPt = anchor;
      if (loopBeats < 1 && len > 0) inPt = anchor + Math.max(0, Math.floor((pos - anchor) / len)) * len;
    }
    djEngine.setLoop(deckId, inPt, inPt + len);
    setActiveLoopBeats(loopBeats);
  };
  const rollDown = (loopBeats: number) => { if (hasTrack) djEngine.startLoopRoll(deckId, loopBeats * effBeatLen); };
  const rollUp = () => djEngine.endLoopRoll(deckId);
  const beatJump = (n: number) => {
    if (!hasTrack) return;
    const pos = djEngine.getStatus(deckId).currentTime;
    let target = pos + n * effBeatLen;
    if (gridBeats && gridBeats.length) {
      let idx = 0;
      for (let i = 0; i < gridBeats.length; i++) { if (gridBeats[i] <= pos + 0.001) idx = i; else break; }
      target = gridBeats[Math.max(0, Math.min(gridBeats.length - 1, idx + n))];
    }
    djEngine.seekDeck(deckId, target);
  };

  return {
    a, analyzing, cam, bpm, beats, beatLen, gridBeats, firstBeat, cues, trimDb, stemNames, stemLevels,
    // Real bar starts when the rhythm module already had them cached; the
    // deck beatgrid falls back to its every-4th-beat guess when it is null.
    downbeats: rhythm?.bars ?? rhythm?.downbeats ?? null,
    loopActive, activeLoopBeats, slip, decoding, keylock,
    setHotcue, dropHotcue, toggleBeatLoop, rollDown, rollUp, beatJump,
    exitLoop: () => djEngine.exitLoop(deckId),
    // Through the shared entry point, not djEngine directly: it is what clears
    // the ownership flag, and the MIDI key-lock target goes through it too.
    setKeylock: (on: boolean) => setUserKeylock(deckId, on),
    setSlip: (on: boolean) => djEngine.setSlip(deckId, on),
  };
}

type DeckCtl = ReturnType<typeof useDeck>;

function EditableBpmField({
  deck,
  sourceBpm,
  pitchPct,
  analyzing,
  color,
  onCommit,
}: {
  deck: 'A' | 'B';
  sourceBpm: number | null;
  pitchPct: number;
  analyzing: boolean;
  color: RGB;
  onCommit: (bpm: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const effectiveBpm = sourceBpm != null && sourceBpm > 0 ? sourceBpm * (1 + pitchPct / 100) : null;

  const beginEdit = () => {
    if (sourceBpm == null || sourceBpm <= 0 || editing) return;
    setDraft((effectiveBpm ?? sourceBpm).toFixed(1));
    setEditing(true);
  };

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    input?.focus();
    input?.select();
  }, [editing]);

  const commit = () => {
    const bpm = Number.parseFloat(draft.trim());
    if (Number.isFinite(bpm) && bpm > 0) onCommit(bpm);
    setEditing(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
    }
  };

  return (
    <div className="h-full w-full grid place-items-center px-1 overflow-hidden">
      <div
        className="flex items-baseline gap-1.5 px-2.5 py-1 rounded-md border tabular-nums"
        style={{
          borderColor: rgba(color, editing ? 0.85 : 0.5),
          background: `linear-gradient(180deg, ${rgba(color, editing ? 0.28 : 0.18)}, ${rgba(color, 0.04)})`,
          boxShadow: `0 0 12px ${rgba(color, editing ? 0.45 : 0.3)}, inset 0 0 6px ${rgba(color, 0.12)}`,
        }}
        title={sourceBpm != null ? 'Hover and type target BPM, then press Enter' : 'Detected tempo'}
        onMouseEnter={beginEdit}
        onClick={beginEdit}
      >
        <span className="text-xs font-black uppercase tracking-[0.22em]" style={{ color: rgba(color, 0.85) }}>BPM</span>
        {editing ? (
          <input
            ref={inputRef}
            aria-label={`Deck ${deck} target BPM`}
            className="w-[5.5ch] bg-transparent text-right text-[15px] font-black leading-none text-white outline-none"
            inputMode="decimal"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => setEditing(false)}
            style={{ textShadow: `0 0 8px ${rgba(color, 0.6)}` }}
          />
        ) : (
          <span className="w-[5.5ch] text-right text-[15px] font-black leading-none text-white" style={{ textShadow: `0 0 8px ${rgba(color, 0.6)}` }}>
            {effectiveBpm != null ? effectiveBpm.toFixed(1) : analyzing ? '...' : '-'}
          </span>
        )}
      </div>
    </div>
  );
}

/* ═══ Control-surface default layout ═════════════════════════════════════════
 * Reproduces the console arrangement as a structured rows/columns tree. Pinned
 * panels (hero waveforms, sampler, FX racks, Next lane, source tree, library)
 * host a whole component; every mixer + deck control is an individual widget the
 * user can relocate in Design Mode. Nothing moves until the user drags. */
const DJ_LAYOUT_VERSION = 24;

const defaultDjLayout: SurfaceLayout = {
  version: DJ_LAYOUT_VERSION,
  root: 'root',
  nodes: {
    root: { id: 'root', type: 'container', axis: 'column', children: ['topDecks', 'heroP', 'browserDock'], fr: { topDecks: 5.25, heroP: 1.45, browserDock: 3.45 } },
    topDecks: { id: 'topDecks', type: 'container', axis: 'row', children: ['deckAcont', 'mixer', 'deckBcont'], fr: { deckAcont: 4.25, mixer: 2.75, deckBcont: 4.25 } },
    heroP: { id: 'heroP', type: 'panel', title: 'Waveforms', flow: 'row', widgets: [], pinned: 'hero' },
    browserDock: { id: 'browserDock', type: 'container', axis: 'row', children: ['browserLeft', 'libraryP'], fr: { browserLeft: 2.45, libraryP: 9.6 }, framed: true, frameTitle: 'Browser' },
    browserLeft: { id: 'browserLeft', type: 'container', axis: 'column', children: ['sourceTreeP', 'nextP'], fr: { sourceTreeP: 3.4, nextP: 1.25 } },
    // Left/right rails equalized by default (samplerP == browser).
    body: { id: 'body', type: 'container', axis: 'row', children: ['samplerP', 'center', 'browser'], fr: { samplerP: 2.0, center: 14.963177570093462, browser: 2.0 } },
    samplerP: { id: 'samplerP', type: 'panel', title: 'Sampler', flow: 'row', widgets: [], pinned: 'sampler', uniform: false },
    center: { id: 'center', type: 'container', axis: 'column', children: ['deckmix', 'fxrow'], fr: { deckmix: 5, fxrow: 2 } },
    deckmix: { id: 'deckmix', type: 'container', axis: 'row', children: ['deckAcont', 'mixer', 'deckBcont'], fr: { deckAcont: 4.17953863997903, mixer: 5.180662235484642, deckBcont: 4.439799124536327 } },
    // ── Deck A (pad-rows wrapped with spacer panels in cont-* containers) ──
    deckAcont: { id: 'deckAcont', type: 'container', axis: 'column', children: ['pdA-head', 'waveAOverview', 'cont-10-e11250c4', 'cont-A-transport', 'cont-A-stems', 'fxAP', 'perfAP'], fr: { 'pdA-head': 1.12, waveAOverview: 0.72, 'cont-10-e11250c4': 4.9, 'cont-A-transport': 1.02, 'cont-A-stems': 1.1, fxAP: 3.15, perfAP: 1.35 }, framed: true },
    'pdA-head': { id: 'pdA-head', type: 'panel', title: 'A', flow: 'row', widgets: ['spacer:s-2-7f6f8905', 'keylockA', 'keyA', 'bpmA', 'headerA'], widgetFr: { keylockA: 0.49871465295629847, keyA: 0.8892624085426142, bpmA: 0.8514435436029266, headerA: 2.255932370970932, 'spacer:s-2-7f6f8905': 0.8892624085426142 }, widgetJustify: { headerA: 'start' }, widgetMargins: { 'spacer:s-2-7f6f8905': { t: 0, r: 8, b: 0, l: 0 } }, mirror: false, uniform: false },
    'pdA-jog': { id: 'pdA-jog', type: 'panel', title: 'A · Jog', flow: 'row', widgets: ['jogA'], widgetMargins: { jogA: { t: 1, r: 4, b: 3, l: 4 } }, mirror: true },
    'pdA-mode': { id: 'pdA-mode', type: 'panel', title: 'A · Mode', flow: 'column', widgets: ['syncLockA', 'headCueA'], mirror: true, uniform: true },
    'pdA-trans': { id: 'pdA-trans', type: 'panel', title: 'A · Transport', flow: 'row', widgets: ['cueA', 'playA', 'stopA', 'ejectA', 'syncA'], uniform: true, mirror: true },
    'pdA-stems': { id: 'pdA-stems', type: 'panel', title: 'A · Stems', flow: 'row', widgets: ['stemBankA'], mirror: true },
    'pdA-hc': { id: 'pdA-hc', type: 'panel', title: 'A · Hotcues', flow: 'row', widgets: ['hcA1', 'hcA2', 'hcA3', 'hcA4'], uniform: true, mirror: true },
    'pdA-loop': { id: 'pdA-loop', type: 'panel', title: 'A · Loop', flow: 'row', widgets: ['loopA_0', 'loopA_1', 'loopA_2', 'loopA_3', 'loopA_4', 'loopOutA'], uniform: true, mirror: true },
    'pdA-perf': { id: 'pdA-perf', type: 'panel', title: 'A · Perf', flow: 'row', widgets: ['rollA_0', 'rollA_1', 'rollA_2', 'slipA', 'jumpA_0', 'jumpA_1', 'jumpA_2', 'jumpA_3'], uniform: true, mirror: true },
    // ── Deck B ──
    deckBcont: { id: 'deckBcont', type: 'container', axis: 'column', children: ['pdB-head', 'waveBOverview', 'cont-2-a0e79010', 'cont-B-transport', 'cont-B-stems', 'fxBP', 'perfBP'], fr: { 'pdB-head': 1.12, waveBOverview: 0.72, 'cont-2-a0e79010': 4.9, 'cont-B-transport': 1.02, 'cont-B-stems': 1.1, fxBP: 3.15, perfBP: 1.35 }, framed: true },
    waveAOverview: { id: 'waveAOverview', type: 'panel', title: 'A · Overview', flow: 'row', widgets: [], pinned: 'waveAOverview', mirror: true },
    waveBOverview: { id: 'waveBOverview', type: 'panel', title: 'B · Overview', flow: 'row', widgets: [], pinned: 'waveBOverview' },
    'pdB-head': { id: 'pdB-head', type: 'panel', title: 'B', flow: 'row', widgets: ['spacer:s-1-95993441', 'keylockB', 'keyB', 'bpmB', 'headerB'], widgetFr: { keylockB: 0.5522110739502047, keyB: 1.1040505388331472, bpmB: 1.039483463396507, headerB: 2.209123002601264, 'spacer:s-1-95993441': 0.4797473058342624 }, widgetJustify: { headerB: 'end' }, widgetMargins: { 'spacer:s-1-95993441': { t: 0, r: 0, b: 0, l: 64 } }, mirror: true, uniform: false },
    'pdB-jog': { id: 'pdB-jog', type: 'panel', title: 'B · Jog', flow: 'row', widgets: ['jogB'], widgetMargins: { jogB: { t: 1, r: 4, b: 3, l: 4 } } },
    'pdB-mode': { id: 'pdB-mode', type: 'panel', title: 'B · Mode', flow: 'column', widgets: ['syncLockB', 'headCueB'], uniform: true },
    'pdB-trans': { id: 'pdB-trans', type: 'panel', title: 'B · Transport', flow: 'row', widgets: ['cueB', 'playB', 'stopB', 'ejectB', 'syncB'], uniform: true },
    'pdB-stems': { id: 'pdB-stems', type: 'panel', title: 'B · Stems', flow: 'row', widgets: ['stemBankB'] },
    'pdB-hc': { id: 'pdB-hc', type: 'panel', title: 'B · Hotcues', flow: 'row', widgets: ['hcB1', 'hcB2', 'hcB3', 'hcB4'], uniform: true },
    'pdB-loop': { id: 'pdB-loop', type: 'panel', title: 'B · Loop', flow: 'row', widgets: ['loopB_0', 'loopB_1', 'loopB_2', 'loopB_3', 'loopB_4', 'loopOutB'], uniform: true },
    'pdB-perf': { id: 'pdB-perf', type: 'panel', title: 'B · Perf', flow: 'row', widgets: ['rollB_0', 'rollB_1', 'rollB_2', 'slipB', 'jumpB_0', 'jumpB_1', 'jumpB_2', 'jumpB_3'], uniform: true },
    // ── Mixer ──
    mixer: { id: 'mixer', type: 'container', axis: 'column', children: ['mixToggles', 'mixChans', 'mixXfade'], fr: { mixToggles: 1, mixChans: 6, mixXfade: 1.6 }, framed: true },
    mixToggles: { id: 'mixToggles', type: 'panel', title: 'Modes', flow: 'row', widgets: ['spacer:s-24-02c5d864', 'pitchRange', 'qtz', 'autoGain', 'automix', 'lim', 'midiMap', 'spacer:s-23-936b468e'], widgetMargins: { pitchRange: { t: 0, r: 5, b: 0, l: 5 }, qtz: { t: 0, r: 5, b: 0, l: 5 }, autoGain: { t: 0, r: 5, b: 0, l: 5 }, automix: { t: 0, r: 5, b: 0, l: 5 }, lim: { t: 0, r: 5, b: 0, l: 5 }, midiMap: { t: 0, r: 5, b: 0, l: 5 } }, uniform: true },
    mixChans: { id: 'mixChans', type: 'container', axis: 'row', children: ['eqAP', 'chAP', 'chBP', 'eqBP'], fr: { eqAP: 1.35, chAP: 1.15, chBP: 1.15, eqBP: 1.35 } },
    pchAP: { id: 'pchAP', type: 'panel', title: 'Pitch A', flow: 'column', widgets: ['pitchA'], widgetMargins: { pitchA: { t: 3, r: 4, b: 3, l: 4 } }, mirror: true },
    eqAP: { id: 'eqAP', type: 'panel', title: 'EQ A', flow: 'column', widgets: ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'], mirror: true },
    chAP: { id: 'chAP', type: 'panel', title: 'Ch A', flow: 'column', widgets: ['volA', 'gainA'], widgetFr: { gainA: 1, volA: 3 }, widgetMargins: { volA: { t: 8, r: 0, b: 8, l: 24 } }, mirror: true },
    chBP: { id: 'chBP', type: 'panel', title: 'Ch B', flow: 'column', widgets: ['gainB', 'volB'], widgetFr: { gainB: 1, volB: 3 }, widgetMargins: { volB: { t: 8, r: 24, b: 8, l: 0 } } },
    eqBP: { id: 'eqBP', type: 'panel', title: 'EQ B', flow: 'column', widgets: ['eqB.hi', 'eqB.mid', 'eqB.lo', 'fltB'] },
    pchBP: { id: 'pchBP', type: 'panel', title: 'Pitch B', flow: 'column', widgets: ['pitchB'], widgetMargins: { pitchB: { t: 3, r: 4, b: 3, l: 4 } }, uniform: false },
    mixXfade: { id: 'mixXfade', type: 'panel', title: 'Crossfade', flow: 'row', widgets: ['spacer:s-22-ffca8259', 'crossfader', 'spacer:s-21-cb584c7d'], widgetFr: { 'spacer:s-22-ffca8259': 0.4556701030927834, crossfader: 2.039175257731959, 'spacer:s-21-cb584c7d': 0.5051546391752577 }, widgetMargins: { crossfader: { t: 16, r: 0, b: 0, l: 0 } }, uniform: false },
    // ── FX row + rails ──
    fxrow: { id: 'fxrow', type: 'container', axis: 'row', children: ['fxAP', 'nextP', 'fxBP'], fr: { fxAP: 0.7703206562266971, nextP: 1.9175988068605512, fxBP: 0.812080536912752 } },
    fxAP: { id: 'fxAP', type: 'panel', title: 'Onboard FX A', flow: 'row', widgets: [], pinned: 'fxA', mirror: true },
    perfAP: { id: 'perfAP', type: 'panel', title: 'Performance Pads A', flow: 'row', widgets: [], pinned: 'perfA', mirror: true },
    nextP: { id: 'nextP', type: 'panel', title: 'Next', flow: 'row', widgets: [], pinned: 'next' },
    fxBP: { id: 'fxBP', type: 'panel', title: 'Onboard FX B', flow: 'row', widgets: [], pinned: 'fxB', uniform: false },
    perfBP: { id: 'perfBP', type: 'panel', title: 'Performance Pads B', flow: 'row', widgets: [], pinned: 'perfB', uniform: false },
    browser: { id: 'browser', type: 'container', axis: 'column', children: ['sourceTreeP', 'libraryP'], fr: { sourceTreeP: 2, libraryP: 3 } },
    sourceTreeP: { id: 'sourceTreeP', type: 'panel', title: 'Sources', flow: 'row', widgets: [], pinned: 'sourceTree' },
    libraryP: { id: 'libraryP', type: 'panel', title: 'Library', flow: 'row', widgets: [], pinned: 'library', uniform: true },
    // ── Deck B pad-row wrappers (pad row + spacer panel) ──
    'panel-1-eff655d2': { id: 'panel-1-eff655d2', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-25-e6518f32'] },
    'cont-2-a0e79010': { id: 'cont-2-a0e79010', type: 'container', axis: 'row', children: ['pdB-mode', 'pdB-jog', 'pchBP', 'panel-1-eff655d2'], fr: { 'pdB-mode': 0.38, 'pdB-jog': 1.56, pchBP: 0.45, 'panel-1-eff655d2': 0.6 } },
    'panel-B-transport-tail': { id: 'panel-B-transport-tail', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-B-transport-tail'] },
    'cont-B-transport': { id: 'cont-B-transport', type: 'container', axis: 'row', children: ['panel-B-transport-tail', 'pdB-trans'], fr: { 'panel-B-transport-tail': 0.48, 'pdB-trans': 2.51 } },
    'panel-B-stems-tail': { id: 'panel-B-stems-tail', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-B-stems-tail'] },
    'cont-B-stems': { id: 'cont-B-stems', type: 'container', axis: 'row', children: ['panel-B-stems-tail', 'pdB-stems'], fr: { 'panel-B-stems-tail': 0.48, 'pdB-stems': 2.51 } },
    'panel-3-e0911657': { id: 'panel-3-e0911657', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-32-4c52fb39'] },
    'cont-4-4f4c96d2': { id: 'cont-4-4f4c96d2', type: 'container', axis: 'row', children: ['pdB-hc', 'panel-3-e0911657'], fr: { 'pdB-hc': 1, 'panel-3-e0911657': 1 } },
    'panel-5-e8707245': { id: 'panel-5-e8707245', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-31-c7e28dbf'] },
    'cont-6-29de8ab7': { id: 'cont-6-29de8ab7', type: 'container', axis: 'row', children: ['pdB-loop', 'panel-5-e8707245'], fr: { 'pdB-loop': 1.3444976076555022, 'panel-5-e8707245': 0.6555023923444977 } },
    'panel-8-81228019': { id: 'panel-8-81228019', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-30-3282c3a3'] },
    'cont-9-aebcd780': { id: 'cont-9-aebcd780', type: 'container', axis: 'row', children: ['pdB-perf', 'panel-8-81228019'], fr: { 'pdB-perf': 1.5358851674641145, 'panel-8-81228019': 0.46411483253588537 } },
    // ── Deck A pad-row wrappers ──
    'cont-10-e11250c4': { id: 'cont-10-e11250c4', type: 'container', axis: 'row', children: ['panel-11-95a4a261', 'pchAP', 'pdA-jog', 'pdA-mode'], fr: { 'panel-11-95a4a261': 0.7, pchAP: 0.45, 'pdA-jog': 1.87, 'pdA-mode': 0.5 } },
    'panel-11-95a4a261': { id: 'panel-11-95a4a261', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-26-79f129b0'] },
    'panel-A-transport-head': { id: 'panel-A-transport-head', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-A-transport-head'] },
    'cont-A-transport': { id: 'cont-A-transport', type: 'container', axis: 'row', children: ['panel-A-transport-head', 'pdA-trans'], fr: { 'panel-A-transport-head': 1.15, 'pdA-trans': 2.37 } },
    'panel-A-stems-head': { id: 'panel-A-stems-head', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-A-stems-head'] },
    'cont-A-stems': { id: 'cont-A-stems', type: 'container', axis: 'row', children: ['panel-A-stems-head', 'pdA-stems'], fr: { 'panel-A-stems-head': 1.15, 'pdA-stems': 2.37 } },
    'panel-12-8772ebc6': { id: 'panel-12-8772ebc6', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-29-e3c2d4fe'] },
    'cont-13-90c67ecb': { id: 'cont-13-90c67ecb', type: 'container', axis: 'row', children: ['panel-12-8772ebc6', 'pdA-hc'], fr: { 'pdA-hc': 1.0814249363867683, 'panel-12-8772ebc6': 0.9185750636132315 } },
    'panel-15-4eb1b108': { id: 'panel-15-4eb1b108', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-28-3698f484'] },
    'cont-16-c9fc3a59': { id: 'cont-16-c9fc3a59', type: 'container', axis: 'row', children: ['panel-15-4eb1b108', 'pdA-loop'], fr: { 'pdA-loop': 1.3664122137404573, 'panel-15-4eb1b108': 0.6335877862595417 } },
    'panel-17-44cba1fb': { id: 'panel-17-44cba1fb', type: 'panel', title: 'Panel', flow: 'row', widgets: ['spacer:s-27-8799ff7e'] },
    'cont-18-cd01de17': { id: 'cont-18-cd01de17', type: 'container', axis: 'row', children: ['panel-17-44cba1fb', 'pdA-perf'], fr: { 'pdA-perf': 1.4885496183206104, 'panel-17-44cba1fb': 0.5114503816793893 } },
  },
};

/* ═══════════════════════════════ DJView ════════════════════════════════════ */

export const DJView: React.FC = () => {
  const [deckATrack, setDeckATrack] = useState<string | null>(null);
  const [deckBTrack, setDeckBTrack] = useState<string | null>(null);
  const [deckAPlaying, setDeckAPlaying] = useState(false);
  const [deckBPlaying, setDeckBPlaying] = useState(false);
  const [crossfader, setCrossfader] = useState(() => djEngine.getCrossfade());
  const [deckAPitch, setDeckAPitch] = useState(0);
  const [deckBPitch, setDeckBPitch] = useState(0);
  const [pitchRange, setPitchRange] = useState<PitchRange>(10);
  const [syncLock, setSyncLock] = useState<djEngine.DeckId | null>(null);
  const [quantize, setQuantize] = useState(false);
  const [autoGain, setAutoGain] = useState(true);
  const [vinylSpinA, setVinylSpinA] = useState(false);
  const [vinylSpinB, setVinylSpinB] = useState(false);
  const [gainA, setGainA] = useState(0);
  const [gainB, setGainB] = useState(0);
  const [eqA, setEqA] = useState({ low: 0, mid: 0, high: 0 });
  const [eqB, setEqB] = useState({ low: 0, mid: 0, high: 0 });
  const [filterA, setFilterA] = useState(0);
  const [filterB, setFilterB] = useState(0);
  const [stemKnobModeA, setStemKnobModeA] = useState(false);
  const [stemKnobModeB, setStemKnobModeB] = useState(false);
  const [volA, setVolA] = useState(1);
  const [volB, setVolB] = useState(1);
  const [cueA, setCueA] = useState(false);
  const [cueB, setCueB] = useState(false);
  const [midiMapOpen, setMidiMapOpen] = useState(false);
  const [automixOn, setAutomixOn] = useState(false);
  const [automixRestart, setAutomixRestart] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  // `started`: has the deck in `current` actually PLAYED during this automix
  // run? A deck that is still decoding reads `playing: false` exactly like a
  // track that ran out, and planTransition needs to tell the two apart (DJ-5).
  // `blend`: the running crossfade (lib/djAutomixPlan `BlendState`), null
  // between transitions.
  const automixRef = useRef<{ current: djEngine.DeckId; started: boolean; blend: BlendState | null } | null>(null);
  const [source, setSource] = useState<Source>({ kind: 'library' });
  // Lifted out of the old Mixer so the surface widget closures can drive them.
  const [limiterOn, setLimiterOn] = useState(() => djEngine.getLimiter());
  // The cue device is a GLOBAL slot in Settings -> Inputs & outputs, so the
  // choice survives a reload (it used to live in a module variable and reset
  // to the system default every time) and the DJ tab and the menu always
  // agree. The one-shot enumerate that used to live here is gone: DJView never
  // calls getUserMedia, so on this surface the labels could never fill in.
  const cueSupported = djEngine.isCueSupported();

  // The loaded WINDOW of the library (T31), not the library: `libTotal` is how
  // many rows the current filters match, and `lookupVersion` re-renders when a
  // single-entry lookup for a row on no loaded page lands.
  const entries = useLibraryStore((s) => s.entries);
  const libTotal = useLibraryStore((s) => s.total);
  const libLookupVersion = useLibraryStore((s) => s.lookupVersion);
  const analyzeAll = useDjAnalysisStore((s) => s.analyzeAll);
  const preferHarmonic = useDjAutomixPrefs((s) => s.preferHarmonic);
  const setPreferHarmonic = useDjAutomixPrefs((s) => s.setPreferHarmonic);
  const djTabActive = useAppUiStore((s) => s.centerTab === 'dj');
  const setlists = useSetlistStore((s) => s.setlists);
  const activeId = useSetlistStore((s) => s.activeId);
  const appendToSet = useSetlistStore((s) => s.append);
  const createSetlist = useSetlistStore((s) => s.create);
  const setActiveSetlist = useSetlistStore((s) => s.setActive);
  const importBundledSetlists = useSetlistStore((s) => s.importBundled);
  const activeSet = activeId ? setlists[activeId] : null;
  useEffect(() => { void importBundledSetlists(); }, [importBundledSetlists]);
  // Deck tracks and their waveform lanes decode through the engine's context,
  // so both land on one `djAudioCache` entry. Registered here, on mount, while
  // no deck holds a track yet: a lane's effect runs before this view's
  // deck-load effect, so registering only inside `loadDeck` left the first
  // track of a session decoded twice.
  useEffect(() => { djEngine.shareDecodeContext(); }, []);

  // A deck can hold a track whose page the library's LRU dropped an hour ago,
  // so this goes through the store's id lookup (which fetches the one row it
  // needs and re-renders through `lookupVersion`) rather than the loaded rows.
  const trackById = (id: string | null): LibraryEntry | null => {
    void libLookupVersion;
    void entries;
    return id ? useLibraryStore.getState().getById(id) ?? null : null;
  };
  const deckAEntry = trackById(deckATrack);
  const deckBEntry = trackById(deckBTrack);
  const deckATitle = deckAEntry?.title ?? null;
  const deckBTitle = deckBEntry?.title ?? null;
  const deckAUrl = deckAEntry?.audioUrl ?? null;
  const deckBUrl = deckBEntry?.audioUrl ?? null;

  const ctlA = useDeck('A', deckATrack, !!deckATrack, quantize, autoGain, gainA);
  const ctlB = useDeck('B', deckBTrack, !!deckBTrack, quantize, autoGain, gainB);

  const camA = ctlA.cam;
  const camB = ctlB.cam;
  const harmonic = camA && camB ? camA.compatible.includes(camB.code) : null;
  const canSync = !!ctlA.a?.bpm && !!ctlB.a?.bpm;
  const clampToPitchRange = (v: number) => clamp(v, -pitchRange, pitchRange);

  const deckATrackRef = useRef<string | null>(deckATrack);
  const deckBTrackRef = useRef<string | null>(deckBTrack);
  deckATrackRef.current = deckATrack;
  deckBTrackRef.current = deckBTrack;
  const pendingPlayRef = useRef<djEngine.DeckId | null>(null);
  const masterPlayingRef = useRef(false);
  // The decks the master transport last paused (see masterResumeDecks).
  // Forgotten as soon as any deck plays again.
  const masterPausedRef = useRef<djEngine.DeckId[] | null>(null);

  const loadDeck = (entryId: string, deck: djEngine.DeckId) => { if (deck === 'A') setDeckATrack(entryId); else setDeckBTrack(entryId); };
  const loadDropOntoDeck = async (event: React.DragEvent, deck: djEngine.DeckId): Promise<boolean> => {
    const entryId = event.dataTransfer.getData(DJ_TRACK_MIME);
    if (entryId) {
      event.preventDefault();
      loadDeck(entryId, deck);
      return true;
    }

    const file = Array.from(event.dataTransfer.files).find(isExternalAudioFile);
    if (!file) return false;

    event.preventDefault();
    setFlash(`Importing "${file.name}" to Deck ${deck}…`);
    try {
      const entry = await importAudioFileToLibrary(file);
      loadDeck(entry.id, deck);
      setFlash(`Loaded "${entry.title}" on Deck ${deck}`);
      return true;
    } catch (e) {
      setFlash(`Deck ${deck} import failed`);
      return false;
    }
  };
  const ejectDeck = (deck: djEngine.DeckId) => {
    djEngine.stopDeck(deck);
    if (deck === 'A') setDeckATrack(null);
    else setDeckBTrack(null);
    setFlash(`Deck ${deck} ejected`);
  };

  useEffect(() => {
    return djEngine.subscribe((a, b) => {
      setDeckAPlaying(a.playing);
      setDeckBPlaying(b.playing);
      const pend = pendingPlayRef.current;
      if (pend) {
        const st = pend === 'A' ? a : b;
        if (st.hasBuffer && !st.decoding && !st.playing) { djEngine.playDeck(pend); pendingPlayRef.current = null; }
      }
      const playing = a.playing || b.playing;
      if (playing) masterPausedRef.current = null;
      if (playing !== masterPlayingRef.current) { masterPlayingRef.current = playing; reportDjMasterState(playing ? 'playing' : 'paused'); }
    });
  }, []);

  useEffect(() => {
    const startSet = () => {
      const aHas = !!deckATrackRef.current;
      const bHas = !!deckBTrackRef.current;
      const mix = automixRef.current;
      const resume = masterResumeDecks({
        paused: masterPausedRef.current,
        holds: (d) => (d === 'A' ? aHas : bHas),
        automix: mix ? { current: mix.current, blending: !!mix.blend } : null,
      });
      masterPausedRef.current = null;
      if (resume) { for (const d of resume) djEngine.playDeck(d); return; }
      if (aHas || bHas) { if (aHas) djEngine.playDeck('A'); if (bHas) djEngine.playDeck('B'); return; }
      // The active set's first track goes on Deck A and plays. A bundled set
      // nobody has opened is registered first; it used to have no entry id
      // to find, and play did nothing.
      void firstPlayableOfActiveSet().then((firstId) => {
        // The user may have loaded a deck while a register was out.
        if (!firstId || deckATrackRef.current || deckBTrackRef.current) return;
        pendingPlayRef.current = 'A';
        setDeckATrack(firstId);
      });
    };
    return registerDjMasterHandler({
      toggle: () => {
        const aPlaying = djEngine.getStatus('A').playing;
        const bPlaying = djEngine.getStatus('B').playing;
        if (aPlaying || bPlaying) {
          const paused: djEngine.DeckId[] = [];
          if (aPlaying) { djEngine.pauseDeck('A'); paused.push('A'); }
          if (bPlaying) { djEngine.pauseDeck('B'); paused.push('B'); }
          masterPausedRef.current = paused;
          reportDjMasterState('paused');
        } else { startSet(); reportDjMasterState('playing'); }
      },
      getState: () => djEngine.getStatus('A').playing || djEngine.getStatus('B').playing ? 'playing' : 'paused',
    });
  }, []);

  // BPM/key analysis is a per-track backend job — a real decode each — so the
  // store takes a capped WINDOW, not the whole page: everything past the cap
  // is dropped, and this call's order is what decides which rows survive it.
  // Rank them the way they are needed: the two loaded decks first (a deck
  // without a beatgrid is the one thing the user can see), then the active
  // set's tracks (the next things to be loaded), then the visible rows.
  // Each run REPLACES the window, so scrolling re-aims it instead of piling
  // another page onto a backlog; ids already analysed or in flight are
  // skipped, so re-running this as pages land costs nothing.
  useEffect(() => {
    if (!djTabActive || !entries.length) return;
    void analyzeAll([
      deckATrack,
      deckBTrack,
      ...(activeSet?.entries ?? []).map((e) => e.entryId),
      ...entries.map((e) => e.id),
    ].filter((id): id is string => !!id));
  }, [djTabActive, entries, analyzeAll, deckATrack, deckBTrack, activeSet]);

  useEffect(() => {
    setDeckAPitch((prev) => {
      const next = clamp(prev, -pitchRange, pitchRange);
      if (next !== prev) djEngine.setDeckPitch('A', next);
      return next;
    });
    setDeckBPitch((prev) => {
      const next = clamp(prev, -pitchRange, pitchRange);
      if (next !== prev) djEngine.setDeckPitch('B', next);
      return next;
    });
  }, [pitchRange]);

  // The resolved entry is load-bearing (DJ-3): `trackById` goes through
  // `libraryStore.getById`, which returns undefined for a track on no loaded
  // page and kicks off an async single-entry fetch. With `[deckATrack]` alone
  // nothing re-ran when that fetch landed, so the deck was loaded with `null`
  // and stayed silently empty — which is every Send-to-DJ id and every
  // bundled-set id, and is why automix then stalled on `incomingHasBuffer`
  // forever. `lookupVersion` re-renders this view when the fetch lands, and
  // the new entry object re-runs the effect. What a re-run may do is
  // `deckLoadStep`'s call: an entry still unresolved and a URL the deck
  // already holds both leave the deck alone, so a playing track is never
  // rewound or ejected by a lookup for some other row.
  const deckEntryRef = useRef<Record<djEngine.DeckId, string | null>>({ A: null, B: null });
  useEffect(() => {
    syncDeckToEntry('A', deckATrack, deckAEntry, deckEntryRef.current);
  }, [deckATrack, deckAEntry]);
  useEffect(() => {
    syncDeckToEntry('B', deckBTrack, deckBEntry, deckEntryRef.current);
  }, [deckBTrack, deckBEntry]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2200);
    return () => window.clearTimeout(t);
  }, [flash]);

  const addDeckToSet = (which: 'A' | 'B') => {
    if (!activeId) { setFlash('Create a set first (Lists & Advice ›)'); return; }
    const track = trackById(which === 'A' ? deckATrack : deckBTrack);
    if (!track) return;
    appendToSet(activeId, [{ entryId: track.id, label: track.title, kind: 'audio' }]);
    setFlash(`Added "${track.title}" to ${activeSet?.name ?? 'set'}`);
  };
  const sendDeckToVj = (which: 'A' | 'B') => {
    const track = trackById(which === 'A' ? deckATrack : deckBTrack);
    if (!track) return;
    sendTrackToVj({ entryId: track.id, label: track.title, url: track.audioUrl, kind: 'audio' });
    setFlash(isVjSetTargetActive() ? `Sent "${track.title}" to VJ` : `Queued "${track.title}" — opens with VJ tab`);
  };

  const syncDeck = (which: djEngine.DeckId): djEngine.DeckId | null => {
    // djEngine reuses one status object per deck (see statusOf), so these are
    // live views, not snapshots — read what must not change into consts.
    const aPlaying = djEngine.getStatus('A').playing;
    const bPlaying = djEngine.getStatus('B').playing;
    const oneDeckPlaying = aPlaying !== bPlaying;
    const follower: djEngine.DeckId = oneDeckPlaying
      ? (aPlaying ? 'B' : 'A')
      : which;
    const master: djEngine.DeckId = follower === 'A' ? 'B' : 'A';

    const followerCtl = follower === 'A' ? ctlA : ctlB;
    const masterCtl = master === 'A' ? ctlA : ctlB;
    const followerBpm = followerCtl.a?.bpm ?? null;
    const masterBpm = masterCtl.a?.bpm ?? null;
    if (!followerBpm || !masterBpm) return null;
    const masterPitch = master === 'A' ? deckAPitch : deckBPitch;
    const masterEffBpm = masterBpm * (1 + masterPitch / 100);
    // The ±range clamp used to happen silently: a pair the fader cannot reach
    // (140 → 95 BPM needs −26 %) was pitched to the limit and still announced
    // as a sync. tempoMatch reports the truncation so the flash can be honest.
    const match = tempoMatch(masterEffBpm, followerBpm, pitchRange);
    // DJ-5: a match the ±range cannot reach must pull NOTHING. The old code
    // applied the CLAMPED value regardless — a bogus 36.6 BPM detection parked
    // Deck A at +10 % and Deck B at −10 %, both running at the wrong speed and
    // no closer to the master's tempo than they were at 0 %, while the flash
    // below honestly said "NOT beatmatched". `appliedPct` is 0 in that case,
    // which also leaves `Math.abs(pct) > KEYLOCK_PITCH_PCT` false: no key-lock
    // either, since there is no pitch pull to compensate for.
    const pct = match.appliedPct;
    if (follower === 'A') setDeckAPitch(pct); else setDeckBPitch(pct);
    djEngine.setDeckPitch(follower, pct);
    // Key-lock above a few percent: a 6 % pull is ~1 semitone of pitch shift,
    // which turns a "harmonic" Camelot match into a clash the listener hears.
    // Released as well as engaged: the old form only ever turned it ON, so a
    // deck key-locked for one track stayed locked through every later match —
    // including the 0 % ones an unreachable tempo now produces — carrying the
    // previous track's formant processing with it. But ONLY a lock this path
    // engaged itself; a plain boolean write switched off the user's own.
    const want = Math.abs(pct) > KEYLOCK_PITCH_PCT;
    if (want) {
      // Claim ownership only if the lock was actually OFF. setDeckKeylock
      // early-returns when the deck already matches, so a >3 % pull on a deck
      // the USER had locked by hand did nothing to the engine but still
      // flipped the flag — and the next ≤3 % sync then released their lock.
      const wasOn = djEngine.getStatus(follower).keylock;
      void djEngine.setDeckKeylock(follower, true);
      if (!wasOn) autoKeylockRef.current[follower] = true;
    } else if (autoKeylockRef.current[follower]) {
      void djEngine.setDeckKeylock(follower, false);
      autoKeylockRef.current[follower] = false;
    }
    // Phase off the CONSTANT beatgrid, not the jittery raw beats — and read
    // both decks AFTER setDeckPitch, which re-anchors the follower's position
    // clock (the old code measured against a position captured before it).
    const followerBeats = followerCtl.gridBeats;
    const masterBeats = masterCtl.gridBeats;
    const ms = djEngine.getStatus(master);
    const fs = djEngine.getStatus(follower);
    // No phase nudge on an unmatchable pair (DJ-5): two decks running at
    // different tempos drift straight back out of phase, so the bend buys
    // nothing and the platter pull is audible for no reason.
    if (match.matched && followerBeats && masterBeats && ms.playing && fs.playing) {
      const interval = 60 / (followerBpm * match.rate);
      // By ear, not by source position: a key-locked deck plays its
      // insert's latency behind its own clock (see heardTime).
      const delta = beatPhaseError(ms, fs, masterBeats, followerBeats) * interval;
      // Nudge the platter instead of seeking: seekDeck restarts the source
      // node, which right after playDeck is an audible stutter/restart. A big
      // correction comes back short (the bend is bounded), so hand the
      // remainder to the PLL rather than dropping it.
      const delivered = djEngine.nudgePhase(follower, delta);
      const owed = residualNudge(delta, delivered, PHASE_DEADBAND_SEC);
      pendingNudgeRef.current = owed !== 0 ? { deck: follower, seconds: owed } : null;
    }
    setFlash(match.matched
      ? `BPM Sync: Deck ${follower} follows Deck ${master} at ${masterEffBpm.toFixed(1)} BPM${match.folded ? ' (half/double time)' : ''}`
      : `Deck ${follower}: ${masterEffBpm.toFixed(1)} BPM needs more than ±${pitchRange}% — NOT beatmatched`);
    return follower;
  };
  // syncDeck closes over ctlA/ctlB/deckAPitch/deckBPitch, so it is redefined
  // every render. The automix interval effect below only re-subscribes on
  // [automixOn, automixRestart] (by design — it must not restart the sequence
  // on every tick), so calling `syncDeck` directly from inside it would freeze
  // the beatmatch at whatever deck state existed the moment automix turned on.
  // Read the CURRENT function through a ref instead (same pattern as
  // deckATrackRef below) so every tick beatmatches against live deck state.
  const syncDeckRef = useLatestRef(syncDeck);
  // What a phase nudge could not deliver in one bend window (djEngine bounds
  // both the bend and its length). The sync-lock PLL finishes it on a later
  // tick; without this the decks sit permanently out of phase by the shortfall.
  const pendingNudgeRef = useRef<{ deck: djEngine.DeckId; seconds: number } | null>(null);
  // Same reason, same pattern: the automix interval mounts once but needs LIVE
  // per-deck analysis (tempo + beatgrid), the live pitch range, and the DJ's
  // own low-EQ setting (the bass swap cuts RELATIVE to it, and must put it
  // back afterwards rather than snapping the band to 0).
  const ctlARef = useLatestRef(ctlA);
  const ctlBRef = useLatestRef(ctlB);
  const pitchRangeRef = useLatestRef(pitchRange);
  const eqLowRef = useLatestRef({ A: eqA.low, B: eqB.low });
  const toggleSyncLock = (which: djEngine.DeckId) => {
    const synced = syncDeck(which);
    if (!synced) return;
    if (syncLock === synced) { setSyncLock(null); return; }
    setSyncLock(synced);
    setFlash(`Sync-Lock: Deck ${synced} follows Deck ${synced === 'A' ? 'B' : 'A'}`);
  };

  const aData = ctlA.a;
  const bData = ctlB.a;
  useEffect(() => {
    if (!syncLock) return;
    const follower = syncLock;
    const fBpm = (follower === 'A' ? aData : bData)?.bpm ?? null;
    const mBpm = (follower === 'A' ? bData : aData)?.bpm ?? null;
    // Constant beatgrid, not raw analysis beats: a dropped/jittery detected
    // beat throws the phase error and the PLL chases the jitter (fix 9).
    const fBeats = (follower === 'A' ? ctlA : ctlB).gridBeats;
    const mBeats = (follower === 'A' ? ctlB : ctlA).gridBeats;
    if (!fBpm || !mBpm || !fBeats || !mBeats) return;
    const KP = 12, MAX_BEND = 4, DEADBAND = 0.02;
    const master: djEngine.DeckId = follower === 'A' ? 'B' : 'A';
    const id = window.setInterval(() => {
      const fs = djEngine.getStatus(follower);
      const ms = djEngine.getStatus(master);
      if (!fs.playing || !ms.playing) return;
      // A phase bend is still running: the setDeckPitch below would cancel it
      // (it must — a ramp back to the OLD rate would drag the deck there), so
      // a tick landing inside the bend window threw most of the nudge away.
      if (djEngine.hasPendingBend(follower)) return;
      // Bend finished but came back short: finish the job before touching
      // pitch again, and keep whatever is still owed after that.
      const owed = pendingNudgeRef.current;
      if (owed && owed.deck === follower) {
        const done = djEngine.nudgePhase(follower, owed.seconds);
        const left = residualNudge(owed.seconds, done, PHASE_DEADBAND_SEC);
        pendingNudgeRef.current = left !== 0 ? { deck: follower, seconds: left } : null;
        return;
      }
      const mEff = mBpm * (1 + ms.pitchPct / 100);
      const base = tempoMatch(mEff, fBpm, pitchRange);
      const dPhase = beatPhaseError(ms, fs, mBeats, fBeats);
      // DJ-5: a tempo the pitch fader cannot reach cannot be HELD either.
      // Bending around a clamped pitch just walks the follower to its rail and
      // parks it there, 350 ms at a time. Apply 0 and add no bend instead.
      const bend = base.matched && Math.abs(dPhase) > DEADBAND
        ? Math.max(-MAX_BEND, Math.min(MAX_BEND, dPhase * KP))
        : 0;
      const pct = clampToPitchRange(base.appliedPct + bend);
      djEngine.setDeckPitch(follower, pct);
      if (follower === 'A') setDeckAPitch(pct); else setDeckBPitch(pct);
    }, 350);
    return () => { window.clearInterval(id); pendingNudgeRef.current = null; };
  }, [syncLock, aData, bData, pitchRange]);

  const onPitch = (which: djEngine.DeckId, v: number) => {
    const pitch = clampToPitchRange(v);
    if (syncLock === which) setSyncLock(null);
    if (which === 'A') setDeckAPitch(pitch); else setDeckBPitch(pitch);
    djEngine.setDeckPitch(which, pitch);
  };
  const onTargetBpm = (which: djEngine.DeckId, bpm: number) => {
    const sourceBpm = (which === 'A' ? ctlA.bpm : ctlB.bpm) ?? null;
    if (!sourceBpm || sourceBpm <= 0) return;
    const rawPitch = (bpm / sourceBpm - 1) * 100;
    const pitch = clampToPitchRange(rawPitch);
    onPitch(which, pitch);
    const effectiveBpm = sourceBpm * (1 + pitch / 100);
    if (Math.abs(effectiveBpm - bpm) > 0.05) {
      setFlash(`Deck ${which}: ${bpm.toFixed(1)} BPM is outside pitch range; set ${effectiveBpm.toFixed(1)} BPM`);
    } else {
      setFlash(`Deck ${which}: ${effectiveBpm.toFixed(1)} BPM`);
    }
  };
  const onEq = (which: djEngine.DeckId, band: 'low' | 'mid' | 'high', v: number) => {
    if (which === 'A') setEqA((p) => ({ ...p, [band]: v })); else setEqB((p) => ({ ...p, [band]: v }));
    djEngine.setDeckEq(which, band, v);
  };
  const onFilter = (which: djEngine.DeckId, v: number) => { if (which === 'A') setFilterA(v); else setFilterB(v); djEngine.setDeckFilter(which, v); };
  const onVol = (which: djEngine.DeckId, v: number) => { if (which === 'A') setVolA(v); else setVolB(v); djEngine.setDeckVolume(which, v); };
  const onGain = (which: djEngine.DeckId, v: number) => { if (which === 'A') setGainA(v); else setGainB(v); };
  const toggleCue = (which: djEngine.DeckId) => {
    const next = which === 'A' ? !cueA : !cueB;
    if (which === 'A') setCueA(next); else setCueB(next);
    djEngine.setDeckCue(which, next);
  };
  const toggleDeckWithSpin = (which: djEngine.DeckId) => {
    const spin = which === 'A' ? vinylSpinA : vinylSpinB;
    if (djEngine.getStatus(which).playing) djEngine.pauseDeck(which);
    else djEngine.playDeck(which, { spinUp: spin });
  };
  const stopDeckAtNextCue = (which: djEngine.DeckId) => {
    const spin = which === 'A' ? vinylSpinA : vinylSpinB;
    const ctl = which === 'A' ? ctlA : ctlB;
    const status = djEngine.getStatus(which);
    const cue = nextCueAfter(ctl.cues, status.currentTime);
    if (cue == null) {
      djEngine.stopDeck(which, { windDown: spin });
      return;
    }
    const target = quantize ? nearestBeat(cue, ctl.gridBeats) : cue;
    djEngine.stopDeck(which, { windDown: spin, targetOffset: target });
    setFlash(`Deck ${which} cue -> ${fmtTime(target)}`);
  };
  const applyCrossfade = useCallback((v: number) => { setCrossfader(v); djEngine.setCrossfade(v); }, []);

  // DJ MIDI-learn (D6): rebuild the action→handler map each render (cheap; closes
  // over current state) and read it from a ref inside the one midiBus subscriber.
  const midiHandlersRef = useRef<Record<string, (v: number) => void>>({});
  midiHandlersRef.current = (() => {
    const h: Record<string, (v: number) => void> = { xfader: (v) => applyCrossfade((v / 127) * 2 - 1) };
    for (const d of ['A', 'B'] as djEngine.DeckId[]) {
      const ctl = d === 'A' ? ctlA : ctlB;
      h[`play${d}`] = () => toggleDeckWithSpin(d);
      h[`cue${d}`] = () => djEngine.cueDeck(d);
      h[`stop${d}`] = () => stopDeckAtNextCue(d);
      h[`sync${d}`] = () => syncDeck(d);
      h[`headcue${d}`] = () => toggleCue(d);
      h[`vol${d}`] = (v) => onVol(d, v / 127);
      h[`gain${d}`] = (v) => onGain(d, (v / 127) * 24 - 12);
      h[`filter${d}`] = (v) => {
        const mode = d === 'A' ? stemKnobModeA : stemKnobModeB;
        const stem = mode ? findStemForSlot(ctl.stemNames, STEM_MIXER_KNOB_SLOTS.flt.aliases) : null;
        if (stem) djEngine.setStemGain(d, stem, v / 127);
        else onFilter(d, (v / 127) * 2 - 1);
      };
      h[`pitch${d}`] = (v) => onPitch(d, (v / 127) * (pitchRange * 2) - pitchRange);
      h[`eq${d}.high`] = (v) => {
        const mode = d === 'A' ? stemKnobModeA : stemKnobModeB;
        const stem = mode ? findStemForSlot(ctl.stemNames, STEM_MIXER_KNOB_SLOTS.hi.aliases) : null;
        if (stem) djEngine.setStemGain(d, stem, v / 127);
        else onEq(d, 'high', (v / 127) * 24 - 12);
      };
      h[`eq${d}.mid`] = (v) => {
        const mode = d === 'A' ? stemKnobModeA : stemKnobModeB;
        const stem = mode ? findStemForSlot(ctl.stemNames, STEM_MIXER_KNOB_SLOTS.mid.aliases) : null;
        if (stem) djEngine.setStemGain(d, stem, v / 127);
        else onEq(d, 'mid', (v / 127) * 24 - 12);
      };
      h[`eq${d}.low`] = (v) => {
        const mode = d === 'A' ? stemKnobModeA : stemKnobModeB;
        const stem = mode ? findStemForSlot(ctl.stemNames, STEM_MIXER_KNOB_SLOTS.lo.aliases) : null;
        if (stem) djEngine.setStemGain(d, stem, v / 127);
        else onEq(d, 'low', (v / 127) * 24 - 12);
      };
      for (let i = 0; i < STEM_PAD_SLOTS; i++) {
        h[`stem${d}${i}`] = () => {
          const name = ctl.stemNames[i];
          if (!name) return;
          const cur = djEngine.getStemGain(d, name);
          djEngine.setStemGain(d, name, cur > 0.001 ? 0 : 1);
        };
      }
      for (const n of [1, 2, 3, 4]) h[`hotcue${d}${n}`] = () => ctl.setHotcue(n - 1);
    }
    return h;
  })();
  useEffect(() => {
    return subscribeToMidi((msg) => {
      const data = msg.data;
      if (!data || data.length < 2) return;
      const status = data[0] & 0xf0;
      const channel = data[0] & 0x0f;
      const number = data[1];
      const value = data.length > 2 ? data[2] : 0;
      const kind: MidiKind | null = status === 0xb0 ? 'cc' : (status === 0x90 || status === 0x80) ? 'note' : null;
      if (!kind) return;
      const store = useDjControlMap.getState();
      if (store.learnAction) { store.bind(store.learnAction, { kind, number, channel }); return; }
      for (const actionId in store.bindings) {
        const sig = store.bindings[actionId];
        if (sig.kind !== kind || sig.number !== number || (sig.channel !== null && sig.channel !== channel)) continue;
        const fn = midiHandlersRef.current[actionId];
        if (!fn) continue;
        const action = MIDI_ACTION_BY_ID.get(actionId);
        if (kind === 'note') { if (status === 0x90 && value > 0) fn(value); }
        else if (action?.kind === 'note') { if (value > 0) fn(value); }
        else fn(value);
      }
    });
  }, []);

  // The one way into automix. START AUTO DJ, the Automix chip and every
  // bridged request (a Sets row's play button, Send to DJ, the assistant) come
  // through here, so each of them registers a bundled set before automix turns
  // on: the automix effect sequences entry ids only, and an unregistered set
  // used to stop it at once with "needs ≥2 tracks". `mode` says what happens
  // to the decks (see `automixStartSteps`). The crossfade normalisation lives
  // in the automix seed block below, so every path gets it.
  const beginAutomix = async (mode: AutomixStartMode): Promise<void> => {
    const sl = useSetlistStore.getState();
    const set = sl.activeId ? sl.setlists[sl.activeId] : null;
    if (set && isBundledSetId(set.id) && set.entries.some(isPendingBundledRow)) {
      setFlash('Registering the set…');
    }
    const ready = await readyActiveSetForAutomix();
    if (!ready.ok) {
      // Never a silent no-op. A register failure was already logged by the
      // store; "not enough tracks" goes to the log here, where the user reads
      // failures, as well as to the footer.
      if (ready.reason === 'too-few') logWarn('dj', ready.message);
      setFlash(ready.message);
      return;
    }
    for (const step of automixStartSteps(mode)) {
      if (step === 'drop-transition') useDjAutomix.getState().consumeTransition(); // so a restart does not blend off track 1
      else if (step === 'eject') { ejectDeck('A'); ejectDeck('B'); }
      else if (step === 'on') setAutomixOn(true);
      else setAutomixRestart((n) => n + 1); // re-run the automix effect for a fresh seed even if already on
    }
  };
  const beginAutomixRef = useLatestRef(beginAutomix);

  // "Send to DJ" bridge: a caller (suggester, a Sets row, the assistant)
  // staged the active setlist and asked for a start, with how that start
  // treats the decks. Consume it and take the one start path above.
  const automixPendingStart = useDjAutomix((s) => s.pendingStart);
  const automixPendingStop = useDjAutomix((s) => s.pendingStop);
  useEffect(() => {
    if (!automixPendingStart) return;
    useDjAutomix.getState().consumeStart();
    void beginAutomixRef.current(automixPendingStart);
  }, [automixPendingStart, beginAutomixRef]);
  useEffect(() => {
    if (!automixPendingStop) return;
    useDjAutomix.getState().consumeStop();
    setAutomixOn(false);
  }, [automixPendingStop]);

  // Deck-load bridge: the footer track menu asked for a library entry on a
  // deck. A request made while DJ was closed lands here when the tab mounts.
  const deckLoadPending = useDjDeckLoad((s) => s.pending);
  useEffect(() => {
    if (!deckLoadPending) return;
    useDjDeckLoad.getState().consume();
    (deckLoadPending.deck === 'A' ? setDeckATrack : setDeckBTrack)(deckLoadPending.entryId);
  }, [deckLoadPending]);

  // Automix (D7): auto-sequence the active set across the 2 decks — beatmatch
  // the next track and crossfade at each tail, then advance. Pure orchestration
  // over the existing engine (no new deps). Drives the real deck loaders + sync.
  useEffect(() => {
    if (!automixOn) { automixRef.current = null; useDjAutomix.getState().setNowPlaying(null); return; }
    const seqEntries = (): Array<SetlistEntry & { entryId: string }> => {
      const sl = useSetlistStore.getState();
      const set = sl.activeId ? sl.setlists[sl.activeId] : null;
      // The same predicate the START button counts with, so what the header
      // calls playable and what this effect can sequence can never disagree
      // about a row. See `djPlayableCount`.
      return djAutomixEntries(set?.entries);
    };
    const seq = (): string[] => seqEntries().map((e) => e.entryId as string);
    // Prepared-performance data for a track in the active set (undefined for
    // classic setlists — everything below falls back to the fixed constants).
    const perfOf = (entryId: string | null) =>
      entryId ? seqEntries().find((e) => e.entryId === entryId)?.perf : undefined;
    const list = seq();
    if (list.length < AUTO_DJ_MIN_TRACKS) { setFlash(`Automix needs an active set with ≥${AUTO_DJ_MIN_TRACKS} tracks`); setAutomixOn(false); return; }
    const other = (d: djEngine.DeckId): djEngine.DeckId => (d === 'A' ? 'B' : 'A');
    const loadOnto = (d: djEngine.DeckId, entryId: string) => (d === 'A' ? setDeckATrack : setDeckBTrack)(entryId);
    // The run's play queue (fix 10): set order, plus a harmonic choice made
    // once per track when "Harmonic order" is on. A prepared set plays as
    // prepared, and a key under KEY_CONFIDENCE_MIN is not trusted to reorder.
    const queue = createAutomixQueue({
      order: seq,
      camelotOf: (entryId) => automixCamelot(useDjAnalysisStore.getState().byId[entryId]?.data),
      preferHarmonic: () => useDjAutomixPrefs.getState().preferHarmonic,
      prepared: () => seqEntries().some((e) => e.perf != null),
    });
    const nextEntryIdAfter = queue.nextAfter;
    const loadNextAfter = (entryId: string | null, onto: djEngine.DeckId) => {
      const nextId = nextEntryIdAfter(entryId);
      if (nextId && nextId !== deckATrackRef.current && nextId !== deckBTrackRef.current) loadOnto(onto, nextId);
    };

    // Init: current = a playing deck, else Deck A seeded with the first track.
    const current: djEngine.DeckId = djEngine.getStatus('A').playing ? 'A' : djEngine.getStatus('B').playing ? 'B' : 'A';
    const curEntry = current === 'A' ? deckATrackRef.current : deckBTrackRef.current;
    let seedPoll = 0;
    // An EMPTY deck gets track 1; a deck that already holds one keeps it.
    if (!curEntry) loadOnto(current, list[0]);
    // …but the seed POLL is what actually starts a deck, and it has to run for
    // a deck that is loaded-but-paused as well (DJ-5). `started` now gates the
    // dead-air rescue, so with the old `!curEntry`-only gate the manual Automix
    // toggle armed nothing: the deck the user had loaded was never played, and
    // the interval sat on `outgoing-not-started` until they pressed play by
    // hand. A deck that is ALREADY playing needs neither — it has started.
    if (!curEntry || !djEngine.getStatus(current).playing) {
      // Crossfade normalisation belongs HERE, with the seed (fix 11): every
      // path into automix seeds a deck — the "Send to DJ" bridge AND the
      // manual toggle — and a fader parked at the far side silences the deck
      // the seed just loaded. Doing it in the bridge effect only fixed one.
      applyCrossfade(current === 'A' ? -1 : 1);
      // First track (fix 8): do NOT punch play the instant the buffer decodes.
      // Analysis lands a moment later, so the track would start at 0 — before
      // its first beat, with no grid and no tempo — and the first transition
      // out of it would then be unmatched. Wait for the tempo (up to
      // AUTOMIX_SEED_WAIT_MS), then start on the first beat.
      const seedStart = performance.now();
      const seedDeadline = seedStart + AUTOMIX_SEED_WAIT_MS;
      const loadDeadline = seedStart + AUTOMIX_LOAD_TIMEOUT_MS;
      seedPoll = window.setInterval(() => {
        const st = djEngine.getStatus(current);
        // Someone beat us to it — the deck IS playing, which is the whole of
        // what `started` records, so mark the run started before standing down.
        if (st.playing) {
          if (automixRef.current) automixRef.current.started = true;
          window.clearInterval(seedPoll); seedPoll = 0; return;
        }
        if (!st.hasBuffer || st.decoding) {
          // No audio yet. There is nothing to start, so this wait has no
          // ANALYSIS deadline — but it does need an end: a dead URL or a
          // failed decode used to poll every 150 ms for the whole session.
          if (performance.now() >= loadDeadline) {
            window.clearInterval(seedPoll);
            seedPoll = 0;
            setFlash(`Automix: Deck ${current} never finished loading`);
            // `started` stays false, so the interval will never transition out
            // of a deck that never played (DJ-5) — and nothing else would ever
            // switch automix off, leaving it ticking over silence forever.
            setAutomixOn(false);
          }
          return;
        }
        const ctl = current === 'A' ? ctlARef.current : ctlBRef.current;
        const analyzed = ctl.bpm != null;
        if (!analyzed && performance.now() < seedDeadline) return;
        window.clearInterval(seedPoll);
        seedPoll = 0;
        const firstBeat = ctl.firstBeat ?? (ctl.gridBeats?.[0] ?? null);
        // Seeking to the first beat is a START-of-track courtesy (fix 8): it
        // stops a fresh track opening on the silence before its downbeat. Now
        // that the gate also seeds a deck that is loaded-but-PAUSED, that seek
        // would rewind a deck the user parked mid-track back to the top. Only
        // pull FORWARD to the first beat, never back to it.
        // Re-read the position rather than trusting the `st` bound at the top
        // of this callback: djEngine hands back ONE status object per deck and
        // rewrites it in place, so `st.currentTime` is whatever the last engine
        // call left there, not the position this decision is about.
        if (analyzed && firstBeat != null && firstBeat > 0.02 && djEngine.getStatus(current).currentTime < firstBeat) {
          djEngine.seekDeck(current, firstBeat);
        }
        djEngine.playDeck(current);
        // The set has begun: a deck that stops at its end (or is ejected) is
        // now dead air and is rescued; a paused deck holds the plan (deckRun).
        if (automixRef.current) automixRef.current.started = true;
        if (!analyzed) setFlash('Automix: starting before analysis landed — first mix may be unmatched');
      }, 150);
    }
    // The deck was already running when automix came on (the "Send to DJ"
    // bridge, or the user hit play first): it has played, so the dead-air
    // rescue is allowed from the first tick. Otherwise the seed poll above
    // flips this the moment it actually starts the deck.
    automixRef.current = { current, started: djEngine.getStatus(current).playing, blend: null };
    useDjAutomix.getState().setNowPlaying(curEntry ?? list[0]);
    loadNextAfter(curEntry ?? list[0], other(current));
    setFlash('Automix on — sequencing the set');

    const id = window.setInterval(() => {
      const mix = automixRef.current;
      if (!mix) return;
      const cur = mix.current;
      const nxt = other(cur);
      // djEngine hands back one reused status object per deck, and every
      // engine call below rewrites it — read the fields that must not move
      // under us into consts first.
      const cs = djEngine.getStatus(cur);
      const ns = djEngine.getStatus(nxt);
      const outPos = cs.currentTime;
      const outDur = cs.duration;
      const outPlaying = cs.playing;
      const outPitchPct = cs.pitchPct;
      const outHasBuffer = cs.hasBuffer;
      const outDecoding = cs.decoding;
      const inHasBuffer = ns.hasBuffer;
      const inRun = deckRun(ns);
      // The AudioContext clock, not performance.now(): a fade timed off the
      // wall clock drifts against the audio it is fading whenever the tab is
      // throttled, and the interval's own 500 ms cadence is not reliable.
      const now = cs.ctxTime;
      const outCtl = cur === 'A' ? ctlARef.current : ctlBRef.current;
      const inCtl = nxt === 'A' ? ctlARef.current : ctlBRef.current;
      // Phrase lines count from the first REAL beat. gridBeats[0] is the grid
      // line nearest 0:00, which sits whole beats before the first detected
      // beat on any track with an intro, so every "phrase" it produced was
      // that many beats off the music. With downbeats cached the plan
      // prefers those anyway.
      const outGrid = outCtl.gridBeats;
      const outAnchor = outCtl.firstBeat ?? (outGrid && outGrid.length > 0 ? outGrid[0] : null);
      const outBeatLen = outCtl.beatLen ?? (outGrid && outGrid.length > 1 ? outGrid[1] - outGrid[0] : null);
      if (!mix.blend) {
        const outEntry = cur === 'A' ? deckATrackRef.current : deckBTrackRef.current;
        // Reconcile the idle deck every tick: a mid-show reorder (assistant
        // dj_set_next) must replace a stale pre-load. No-op when it already
        // holds the right track.
        loadNextAfter(outEntry, nxt);
        const outPerf = perfOf(outEntry);
        const incomingEntryId = nextEntryIdAfter(outEntry);
        const inPerf = incomingEntryId ? perfOf(incomingEntryId) : undefined;
        // Prepared sets carry an exact mix-out point on the OUTGOING track;
        // classic sets use the fixed distance-from-end rule. Either way the
        // plan quantises it DOWN to a 16-beat phrase boundary, refuses to mix
        // into a track whose tempo is still unknown (until the outgoing one is
        // nearly gone), and starts immediately when the outgoing deck already
        // ran out — the old predicate answered "not due" forever in that case
        // and the set played to silence. Assistant override: "transition NOW".
        const plan = planTransition({
          outgoing: {
            currentTime: outPos,
            duration: outDur,
            bpm: outCtl.bpm,
            gridAnchor: outAnchor,
            beatLen: outBeatLen,
            playing: outPlaying,
            // Has this deck ever played in this run? Without it a deck that
            // is merely still decoding takes the dead-air rescue on the very
            // first tick, and the set churns through tracks in silence.
            started: mix.started,
            mixOut: outPerf?.mixOut,
            // Real bar lines when djRhythmStore has them cached (DJ-3), so a
            // blend starts on an actual phrase and not merely on a 16-beat
            // multiple of the first beat; null falls back to the grid.
            downbeats: outCtl.downbeats,
            // Tells a pause from a track that ran out (see deckRun).
            hasBuffer: outHasBuffer,
            decoding: outDecoding,
          },
          incoming: { bpm: inCtl.bpm, hasBuffer: inHasBuffer, cueIn: inPerf?.cueIn },
          fadeSec: outPerf?.transitionSec != null && outPerf.transitionSec > 0 ? outPerf.transitionSec : AUTOMIX_XFADE,
          tailSec: AUTOMIX_TAIL,
          now,
          forced: useDjAutomix.getState().pendingTransition,
        });
        // The tempo pull the incoming deck will need, from the same inputs
        // syncDeck uses. Known before it plays, so key-lock can be set while
        // the deck is still silent.
        const pull = tempoMatch((outCtl.bpm ?? 0) * (1 + outPitchPct / 100), inCtl.bpm, pitchRangeRef.current);
        // Load the key-lock insert ahead of the blend that will need it, so
        // engaging it before `play` does not wait on the WASM load.
        if (inHasBuffer && outPlaying && Math.abs(pull.appliedPct) > KEYLOCK_PITCH_PCT) djEngine.prepareKeylock(nxt);
        if (plan.start) {
          useDjAutomix.getState().consumeTransition();
          // Only a playing outgoing deck can be matched. In the dead-air
          // rescue nothing is playing: no sync, no sync-lock, no key-lock pull.
          const masterPlaying = outPlaying;
          const lockStep = automixKeylockStep({
            pullPct: pull.appliedPct,
            masterPlaying,
            lockedByAutomix: autoKeylockRef.current[nxt],
          });
          // Dispatches automixTransitionSteps' order verbatim — seek, key-lock,
          // play, THEN sync — rather than calls written out by hand, so the
          // tested order and the executed order can never drift apart.
          // syncDeck's phase-align branch (see syncDeck above,
          // `masterStatus.playing && followerStatus.playing`) only nudges
          // playback into phase when BOTH decks already read as playing —
          // dispatched before `play`, the incoming deck always reads
          // not-playing there, so only the tempo (pitch) half of the beatmatch
          // would ever apply and phase never would. Key-lock goes before
          // `play` so its insert and delay line change on a silent deck.
          for (const step of automixTransitionSteps(nxt, plan.cueIn, { masterPlaying, keylock: lockStep })) {
            if (step.type === 'seek') djEngine.seekDeck(step.deck, step.to);
            else if (step.type === 'keylock') {
              // Ownership, same rule as syncDeck: only a lock this path
              // switched on is one it may switch off; a lock the DJ set by
              // hand survives.
              if (step.on) {
                const wasOn = djEngine.getStatus(step.deck).keylock;
                void djEngine.setDeckKeylock(step.deck, true);
                if (!wasOn) autoKeylockRef.current[step.deck] = true;
              } else {
                void djEngine.setDeckKeylock(step.deck, false);
                autoKeylockRef.current[step.deck] = false;
              }
            } else if (step.type === 'play') djEngine.playDeck(step.deck);
            else syncDeckRef.current(step.deck);   // via ref: see syncDeckRef
          }
          // Hold the beatmatch for the whole blend (fix 3): syncDeck matches
          // tempo + phase ONCE, and two decoded buffers at slightly different
          // real tempos drift apart audibly over a 10 s fade. The sync-lock
          // PLL already exists — automix just never armed it, because only the
          // user's SYNC-LOCK button ever did.
          if (masterPlaying) setSyncLock(nxt);
          // Dead air: the outgoing deck is already silent, so a 10 s fade is
          // 10 s of a half-open fader. Get the incoming track up fast instead.
          mix.blend = startBlend(
            now,
            plan.immediate ? AUTOMIX_RESCUE_XFADE : plan.fadeSec,
            djEngine.getCrossfade(),
            nxt === 'B' ? 1 : -1,
            plan.immediate,
          );
          // Say what actually happened. The old flash claimed a blend even
          // when the tempo was a guess or the pitch fader could not reach it.
          const honest = !plan.matched
            ? (inCtl.bpm == null ? 'incoming BPM unknown' : 'outgoing BPM unknown')
            : !pull.matched ? `BPM out of the ±${pitchRangeRef.current}% range` : null;
          setFlash(honest
            ? `Automix: mixing unmatched → Deck ${nxt} (${honest})`
            : `Automix: blending → Deck ${nxt}${plan.phraseAligned ? ', on the phrase' : ''}`);
        }
      } else {
        // The fade (lib/djAutomixPlan `blendTick`): held while either deck is
        // paused, cut over to the short rescue fade from where the fader is
        // when the outgoing track runs out, and handed over only when the
        // fade has run its length.
        const outRun = deckRun({ playing: outPlaying, currentTime: outPos, duration: outDur, hasBuffer: outHasBuffer, decoding: outDecoding });
        const step = blendTick(mix.blend, now, outRun, inRun, AUTOMIX_RESCUE_XFADE);
        mix.blend = step.state;
        if (step.action === 'hold') return;
        applyCrossfade(step.fader);
        // Bass swap (fix 1): two basslines on top of each other for ten
        // seconds is the sound of an amateur automix. Hand the low end over
        // across the middle third of the fade, relative to the DJ's own EQ.
        const swap = eqSwap(step.progress);
        djEngine.setDeckEq(cur, 'low', eqLowRef.current[cur] + swap.outLowDb);
        djEngine.setDeckEq(nxt, 'low', eqLowRef.current[nxt] + swap.inLowDb);
        if (step.action === 'finish') {
          // Land the fader EXACTLY on the destination (fix 7).
          applyCrossfade(mix.blend.fadeTo);
          djEngine.setDeckEq(cur, 'low', eqLowRef.current[cur]);
          djEngine.setDeckEq(nxt, 'low', eqLowRef.current[nxt]);
          if (outPlaying) djEngine.pauseDeck(cur);
          // The old pair is gone; the PLL must not keep bending a deck that
          // is now the master (or a freshly loaded track on the freed deck).
          setSyncLock(null);
          mix.current = nxt;
          // The transition played the incoming deck, but asserting that it
          // WORKED puts the dead-air rescue back in charge of exactly the case
          // DJ-5 took it out of: a play that never took (an evicted buffer, an
          // engine refusal) would latch `started` true over a deck making no
          // sound. Read the deck instead — and never clear a `started` the run
          // has already earned, since a track that ran out still counts.
          mix.started = djEngine.getStatus(nxt).playing || mix.started;
          mix.blend = null;
          const nowEntry = nxt === 'A' ? deckATrackRef.current : deckBTrackRef.current;
          useDjAutomix.getState().setNowPlaying(nowEntry);
          loadNextAfter(nowEntry, cur); // queue the following track on the freed deck
        }
      }
    }, 500);
    return () => {
      window.clearInterval(id);
      if (seedPoll) window.clearInterval(seedPoll);
      // Switching automix off mid-blend must not leave the half-swapped state
      // behind: a deck stuck at −26 dB of bass, and a sync-lock the user never
      // armed still bending its pitch. The swap branch undoes both; so does this.
      if (automixRef.current?.blend) {
        djEngine.setDeckEq('A', 'low', eqLowRef.current.A);
        djEngine.setDeckEq('B', 'low', eqLowRef.current.B);
        setSyncLock(null);
      }
    };
    // Re-runs only on the two inputs that start a run. Everything else it
    // reads is stable: state setters, `applyCrossfade` (useCallback over a
    // setter), and refs to the live per-render values (useLatestRef), which
    // is how the interval sees current deck state without restarting the
    // sequence on every render.
  }, [automixOn, automixRestart, applyCrossfade, ctlARef, ctlBRef, pitchRangeRef, eqLowRef, syncDeckRef]);

  /* ── DJ-3: the header START AUTO DJ button ── */
  // Same count the Sets rows use: registered entries plus the bundled rows
  // that opening the set will register. See `djPlayableCount`.
  const autoDjPlayable = djPlayableCount(
    activeSet ? { bundled: isBundledSetId(activeSet.id), entries: activeSet.entries } : null,
  );
  const startAutoDj = startAutoDjState({
    setCount: Object.keys(setlists).length,
    hasActiveSet: !!activeSet,
    playableCount: autoDjPlayable,
    automixOn,
  });
  // A register is out for some set: the store's one in-flight guard, shared
  // with the Sets rows. A press then says so and does nothing else; a button
  // that does nothing at all reads as broken, which is the complaint DJ-3
  // started from.
  const registerBusy = (): boolean => {
    if (!useSetlistStore.getState().registeringId) return false;
    setFlash('Registering the set…');
    return true;
  };
  const onToggleAutomix = () => {
    if (automixOn) { setAutomixOn(false); return; }
    if (registerBusy()) return;
    void beginAutomix('continue');
  };
  const onStartAutoDj = async (intent: StartAutoDjIntent) => {
    switch (intent) {
      case 'start': {
        if (registerBusy()) return;
        // `autoDjPlayable` counts bundled rows that have no library entry
        // yet, so the button offers to start a set the automix effect would
        // find empty until it is registered; `beginAutomix` registers first.
        // `continue`, the Automix chip's behavior: a deck that is playing
        // keeps playing and the set runs on from that track. Through the
        // Send-to-DJ bridge this press ejected both decks and restarted the
        // set from track 1 under a playing track.
        await beginAutomix('continue');
        break;
      }
      case 'stop': useDjAutomix.getState().requestStop(); break;
      case 'create-set': {
        // The button said "Create a set first" — so make it, and put the
        // browser on it, rather than leaving the user to find the + .
        const id = createSetlist(`Set ${new Date().toLocaleDateString()}`);
        setActiveSetlist(id);
        setSource({ kind: 'set', id });
        setFlash('New set created — drag tracks in, then press START AUTO DJ');
        break;
      }
      // Nothing to do but say why again, loudly — never a silent no-op.
      default: setFlash(startAutoDj.reason ?? 'Auto-DJ is not ready'); break;
    }
  };
  // The "how do I start" block: only while there is nothing to look at.
  const showStartHint = !deckATrack && !deckBTrack && !automixOn;

  // Build the surface widget registry every render so each control's closure
  // carries live state/wiring; relocating a widget only changes where it draws.
  const registry = buildDjRegistry({
    ctlA, ctlB,
    deckATitle, deckBTitle, camA, camB, harmonic,
    hasA: !!deckATrack, hasB: !!deckBTrack,
    playingA: deckAPlaying, playingB: deckBPlaying,
    cueA, cueB, syncLock, canSync,
    onPlayA: () => toggleDeckWithSpin('A'), onPlayB: () => toggleDeckWithSpin('B'),
    onCueA: () => djEngine.cueDeck('A'), onCueB: () => djEngine.cueDeck('B'),
    onStop: stopDeckAtNextCue, onEject: ejectDeck,
    onSync: syncDeck, onSyncLock: toggleSyncLock, onHeadCue: toggleCue,
    onSendVj: sendDeckToVj, onAddSet: addDeckToSet,
    deckAUrl, deckBUrl, deckATrack, deckBTrack, setDeckATrack, setDeckBTrack,
    source, setSource, libCount: libTotal, loadDeck, loadDropOntoDeck,
    gainA, gainB, eqA, eqB, filterA, filterB, volA, volB,
    stemKnobModeA, stemKnobModeB, setStemKnobModeA, setStemKnobModeB,
    pitchA: deckAPitch, pitchB: deckBPitch, bpmA: ctlA.bpm ?? null, bpmB: ctlB.bpm ?? null,
    pitchRange, setPitchRange,
    onGain, onEq, onFilter, onVol, onPitch, onTargetBpm,
    crossfader, onCrossfade: applyCrossfade,
    quantize, setQuantize, autoGain, setAutoGain,
    vinylSpinA, setVinylSpinA, vinylSpinB, setVinylSpinB,
    limiterOn, setLimiterOn, cueSupported,
    midiMapOn: midiMapOpen, onToggleMidiMap: () => setMidiMapOpen((v) => !v),
    automixOn, onToggleAutomix,
  });

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#07050a] text-white flex flex-col">
      {/* DJ-3 — "its not intuitive to start". One obvious control, above the
          decks, that either starts the set or says in words what is missing.
          Deliberately OUTSIDE the ControlSurface: the way in must not be
          something a user can drag away (or lose) in Design Mode. */}
      <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-white/5 bg-black/30">
        <StartAutoDjButton state={startAutoDj} onActivate={onStartAutoDj} />
        <span className="min-w-0 truncate text-xs font-bold text-zinc-400">
          {automixOn
            ? `Auto-DJ running · ${activeSet?.name ?? 'set'}`
            : activeSet
              ? `${activeSet.name} · ${autoDjPlayable} playable`
              : startAutoDj.reason ?? ''}
        </span>
        <HarmonicOrderToggle on={preferHarmonic} onToggle={() => setPreferHarmonic(!preferHarmonic)} />
      </div>
      {showStartHint && <DjStartHint />}
      {/* The console is laid out on fr fractions of its area, so on a short
          work area every cell shrinks below its content and clips. Below the
          design minimum the surface scrolls instead: the wrapper is
          overflow-auto and the surface keeps a minimum logical size. */}
      <div data-tour="dj-console" className="flex-1 min-h-0 min-w-0 overflow-auto">
        <div className="h-full w-full min-h-210 min-w-300">
          <ControlSurface
            surfaceId="dj"
            registry={registry}
            defaultLayout={defaultDjLayout}
            targets={DJ_TARGETS}
            legacyKeyToClear="thedaw.dj.layout.v1"
            className="p-1.5"
          />
        </div>
      </div>
      {midiMapOpen && (
        <DjMidiMap
          onClose={() => {
            setMidiMapOpen(false);
            useDjControlMap.getState().arm(null);
          }}
        />
      )}
      {/* In flow — as an absolute bottom-right overlay it covered the
          library's "load onto deck" buttons. The flash status line (BPM
          sync, automix state, import/eject results, set additions, …) lives
          here too, on the empty left side of this bar: an absolute overlay
          over the console (the first place this was tried) sat on top of
          the Modes row (pitchRange/qtz/automix, mixToggles in
          defaultDjLayout above) and hid it right after those controls were
          pressed. The wrapper is always mounted with `role="status"` so a
          screen reader hears every message — only the text inside is
          conditional — instead of the whole live region appearing already
          filled each time. */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-2 py-0.5 border-t border-white/5 bg-black/40">
        <div role="status" aria-live="polite" className="min-w-0 flex-1">
          {flash && <span className="block truncate text-xs tabular-nums font-bold text-purple-300">{flash}</span>}
        </div>
        <InfiNightCredit feature="DJ" />
      </div>
    </div>
  );
};

/* ═══════════════════════════════ WaveLane ═══════════════════════════════════ */

interface WaveLaneProps {
  deckId: djEngine.DeckId; accent: 'purple' | 'cyan'; entryId: string | null;
  hasTrack: boolean; audioUrl: string | null; ctl: DeckCtl; onLoadDrop: (event: React.DragEvent, deck: djEngine.DeckId) => Promise<boolean>;
  mode?: 'overview' | 'detail';
  compact?: boolean;
}

const WaveLane: React.FC<WaveLaneProps> = ({ deckId, accent, hasTrack, audioUrl, ctl, onLoadDrop, mode = 'detail', compact = false }) => {
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const accentBorder = accent === 'purple' ? 'border-purple-500/30' : 'border-cyan-500/30';
  const [dropHover, setDropHover] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    if (!hasDeckLoadDragData(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropHover(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropHover(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    setDropHover(false);
    if (!hasDeckLoadDragData(e)) return;
    e.stopPropagation();
    await onLoadDrop(e, deckId);
  };
  const height = compact ? 34 : mode === 'overview' ? 44 : 62;
  return (
    <div
      className={`flex-1 min-h-0 relative rounded border ${accentBorder} bg-black/40 overflow-hidden ${dropHover ? 'ring-2 ring-inset ring-white/50' : ''}`}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => { void onDrop(e); }}
    >
      {!compact && (
        <span className={`absolute top-1 left-2 z-30 flex items-center gap-1 text-xs font-black uppercase tracking-[0.18em] pointer-events-none ${accentText}`}>
          <Disc className="w-2.5 h-2.5" /> Deck {deckId} · {mode === 'overview' ? 'overview' : 'scroll'}
        </span>
      )}
      {audioUrl ? <DeckWaveform deckId={deckId} audioUrl={audioUrl} beats={ctl.gridBeats} downbeats={ctl.downbeats} cues={ctl.cues ?? null} accent={accent} height={height} mode={mode} />
        : <div className="h-full grid place-items-center text-xs font-semibold tabular-nums text-zinc-700">{hasTrack ? '…' : 'drop a song here →'}</div>}
    </div>
  );
};

const PlatterDropTarget: React.FC<{
  deckId: djEngine.DeckId;
  color: RGB;
  hasTrack: boolean;
  bpm: number | null;
  pitchPct: number;
  onLoadDrop: (event: React.DragEvent, deck: djEngine.DeckId) => Promise<boolean>;
}> = ({ deckId, color, hasTrack, bpm, pitchPct, onLoadDrop }) => {
  const [dropHover, setDropHover] = useState(false);
  const onDragOver = (e: React.DragEvent) => {
    if (!hasDeckLoadDragData(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropHover(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropHover(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    setDropHover(false);
    if (!hasDeckLoadDragData(e)) return;
    e.stopPropagation();
    await onLoadDrop(e, deckId);
  };

  return (
    <div
      className={`relative h-full w-full grid place-items-center rounded overflow-hidden transition-colors ${dropHover ? 'bg-white/6 ring-2 ring-inset' : ''}`}
      style={{ '--deck-ring': rgba(color, 0.9), '--deck-glow': rgba(color, 0.28) } as React.CSSProperties}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={(e) => { void onDrop(e); }}
      title={`Drop a track on Deck ${deckId} platter`}
    >
      <div className={`absolute inset-1 rounded-full pointer-events-none transition-opacity ${dropHover ? 'opacity-100' : 'opacity-0'}`} style={{ border: `1px solid ${rgba(color, 0.75)}`, boxShadow: `0 0 22px ${rgba(color, 0.45)}, inset 0 0 18px ${rgba(color, 0.16)}` }} />
      <JogWheel deckId={deckId} color={color} bpm={bpm} pitchPct={pitchPct} disabled={!hasTrack} fill fillScale={0.88} />
      {dropHover && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <div className="rounded bg-black/75 border px-2 py-1 text-xs font-black uppercase tracking-wider" style={{ borderColor: rgba(color, 0.7), color: rgb(color), boxShadow: `0 0 14px ${rgba(color, 0.35)}` }}>
            Drop on {deckId}
          </div>
        </div>
      )}
    </div>
  );
};

/* ═══════════════════════════════ SamplerRail ════════════════════════════════ */

const SAMPLER_SLOTS = 10;
// A single instance of the pad-options panel ever mounts at once (whichever
// pad is `editingPad`), so every pad's gear button can share one id.
const SAMPLER_PAD_OPTIONS_ID = 'dj-sampler-pad-options';

/** The per-pad options (gain/loop/choke) a persisted pad carries into
 *  `djEngine.triggerSample`. An absent pad (nothing assigned yet) or an
 *  absent field defaults to a plain, non-looping, non-choking one-shot at
 *  full volume — exactly the behavior before per-pad options existed, so an
 *  untouched pad's playback never changes. Pure so the defaulting is
 *  testable without the audio engine. */
export function samplerTriggerOpts(pad: Pick<SamplerPad, 'gain' | 'loop' | 'choke'> | undefined): { gain: number; loop: boolean; choke: boolean } {
  return { gain: pad?.gain ?? 1, loop: !!pad?.loop, choke: !!pad?.choke };
}

/** What a press of the pad options panel's Loop toggle should do. djEngine
 *  only stops a looping voice when the NEXT trigger carries `loop: true`
 *  (djEngine.ts:894 — `if (opts.loop && ... > 0) { stopSample(padId); return; }`)
 *  — pressing the pad again fires the option's re-press-to-stop behavior.
 *  Flipping the stored option to `false` while a right-click hasn't cleared
 *  the pad left a looping voice with no way to press it again into silence,
 *  since the next press would now trigger a plain one-shot instead of
 *  hitting that stop branch. Turning Loop OFF here must stop the pad
 *  directly instead. Pure so the toggle is testable without the engine. */
export function samplerLoopToggle(currentLoop: boolean): { loop: boolean; stopSample: boolean } {
  const loop = !currentLoop;
  return { loop, stopSample: !loop };
}

/** Sampler bank (D7): 10 one-shot pads. Drop a library track — or an audio file
 *  from the desktop, which imports to the library first — onto a pad to load
 *  it; click fires it (polyphonic, through the DJ master); right-click clears.
 *  Pad→track assignments persist (djSamplerStore); buffers re-decode on mount.
 *  A loaded pad's gear icon opens its gain/loop/choke controls inline. */
const SamplerRail: React.FC = () => {
  const pads = useDjSampler((s) => s.pads);
  const setPad = useDjSampler((s) => s.setPad);
  const setPadOpts = useDjSampler((s) => s.setPadOpts);
  const clearPad = useDjSampler((s) => s.clearPad);
  const [editingPad, setEditingPad] = useState<number | null>(null);
  const entries = useLibraryStore((s) => s.entries);
  const lookupVersion = useLibraryStore((s) => s.lookupVersion);
  const [over, setOver] = useState<number | null>(null);
  const loadedRef = useRef<Set<string>>(new Set());

  // Decode each persisted pad's sample into the engine once (after a reload).
  // A pad persists an ENTRY ID, and the row behind it is usually on no loaded
  // page after a restart, so the store fetches the one record it needs and the
  // `lookupVersion` bump brings this effect back round with the answer.
  useEffect(() => {
    for (const [k, pad] of Object.entries(pads)) {
      const i = Number(k);
      const tag = `sampler:${i}:${pad.entryId}`;
      if (loadedRef.current.has(tag)) continue;
      const entry = useLibraryStore.getState().getById(pad.entryId);
      if (!entry?.audioUrl) continue;
      loadedRef.current.add(tag);
      void djEngine.loadSample(`sampler:${i}`, entry.audioUrl).catch(() => loadedRef.current.delete(tag));
    }
  }, [pads, entries, lookupVersion]);

  const drop = async (i: number, e: React.DragEvent) => {
    setOver(null);
    const dt = e.dataTransfer;
    if (!dropHasLibraryOrFiles(dt, [DJ_TRACK_MIME])) return;
    e.preventDefault();
    // The library id is read here, synchronously, before anything awaits:
    // protected mode empties the DataTransfer the moment this handler yields.
    const draggedId = dt.getData(DJ_TRACK_MIME);
    const fromDesktop = !draggedId;
    // A library drop resolves through the store (the dragged row may sit on a
    // page that has since been evicted); a desktop drop imports its first audio
    // file to the library, then loads the pad exactly as a library drop does.
    const entry = draggedId
      ? await useLibraryStore.getState().ensureEntry(draggedId)
      : (await entriesFromDrop(dt, { mimes: [], entries: [], max: 1 }))[0];
    if (!entry?.audioUrl) return;
    try {
      await djEngine.loadSample(`sampler:${i}`, entry.audioUrl);
      loadedRef.current.add(`sampler:${i}:${entry.id}`);
      setPad(i, { entryId: entry.id, name: entry.title });
      if (fromDesktop) logInfo('dj', `Imported "${entry.title}" from the desktop onto sampler pad ${i === 9 ? 0 : i + 1}`);
    } catch { /* decode/fetch failed — leave the pad empty */ }
  };

  return (
    <div className="hardware-card flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        <Sparkles className="w-3 h-3 text-amber-300 shrink-0" />
        <span className="text-xs font-black uppercase tracking-wider text-amber-200 leading-tight">Sampler</span>
        <span className="ml-auto text-xs font-semibold tabular-nums text-zinc-600">drag tracks →</span>
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-2 gap-1 p-1.5 content-start">
        {Array.from({ length: SAMPLER_SLOTS }, (_, i) => {
          const pad = pads[i];
          return (
            <div key={i} className="relative min-w-0 min-h-0">
              <button type="button"
                onClick={() => { if (pad) djEngine.triggerSample(`sampler:${i}`, samplerTriggerOpts(pad)); }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!pad) return;
                  djEngine.clearSample(`sampler:${i}`);
                  clearPad(i);
                  setEditingPad((p) => (p === i ? null : p));
                }}
                onDragOver={(e) => { if (dropHasLibraryOrFiles(e.dataTransfer, [DJ_TRACK_MIME])) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(i); } }}
                onDragLeave={() => setOver((o) => (o === i ? null : o))}
                onDrop={(e) => void drop(i, e)}
                title={pad ? `${pad.name} — click to fire, right-click to clear` : 'Drop a library track or an audio file here to load a one-shot'}
                className={`w-full h-full flex flex-col items-center justify-center gap-0.5 rounded-md border py-1.5 transition-colors active:scale-95 ${
                  over === i ? 'border-amber-400/70 bg-amber-500/15'
                    : pad ? 'border-amber-500/40 bg-amber-500/8 text-amber-200 hover:bg-amber-500/15'
                      : 'border-white/10 bg-black/40 text-zinc-600 hover:border-white/20'
                }`}>
                <span className="text-xs font-black leading-none">{i === 9 ? 0 : i + 1}</span>
                <span className="text-xs font-bold uppercase tracking-wide leading-none truncate max-w-full px-0.5">{pad ? pad.name : '—'}</span>
              </button>
              {/* A sibling, not a child of the pad button — a nested button is
                  invalid DOM (see the Sets-row comment further down this file
                  for the same constraint). */}
              {pad && (
                <button type="button"
                  onClick={() => setEditingPad((p) => (p === i ? null : i))}
                  aria-expanded={editingPad === i}
                  aria-controls={SAMPLER_PAD_OPTIONS_ID}
                  aria-label={`Pad ${i === 9 ? 0 : i + 1} gain, loop and choke options`}
                  title="Gain / loop / choke options"
                  className={`absolute top-0.5 right-0.5 rounded p-0.5 ${editingPad === i ? 'text-amber-100 bg-black/50' : 'text-amber-300/60 hover:text-amber-100 hover:bg-black/40'}`}>
                  <Settings2 className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {editingPad != null && pads[editingPad] && (() => {
        const i = editingPad;
        const pad = pads[i] as SamplerPad;
        const opts = samplerTriggerOpts(pad);
        const gainId = `dj-sampler-gain-${i}`;
        return (
          <div id={SAMPLER_PAD_OPTIONS_ID} className="shrink-0 border-t border-white/5 px-1.5 py-1.5 flex flex-col gap-1">
            <div className="flex items-center justify-between gap-1">
              <span className="min-w-0 truncate text-xs font-bold uppercase tracking-wide text-amber-200">Pad {i === 9 ? 0 : i + 1} · {pad.name}</span>
              <button type="button" onClick={() => setEditingPad(null)} aria-label="Close pad options" title="Close" className="shrink-0 text-zinc-500 hover:text-zinc-200">
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor={gainId} className="shrink-0 text-xs font-bold uppercase tracking-wide text-zinc-500">Gain</label>
              <input
                id={gainId}
                name={gainId}
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={opts.gain}
                onChange={(e) => setPadOpts(i, { gain: Number(e.target.value) })}
                className="flex-1 accent-amber-400"
              />
              <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-zinc-400">{Math.round(opts.gain * 100)}%</span>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" aria-pressed={opts.loop} onClick={() => {
                const { loop, stopSample } = samplerLoopToggle(opts.loop);
                setPadOpts(i, { loop });
                if (stopSample) djEngine.stopSample(`sampler:${i}`);
              }}
                className={`flex-1 flex items-center justify-center gap-1 rounded border px-1 py-0.5 text-xs font-black uppercase tracking-wide ${
                  opts.loop ? 'border-amber-400/70 bg-amber-500/20 text-amber-200' : 'border-white/10 text-zinc-500 hover:text-zinc-200 hover:border-white/25'
                }`} title="Loop the sample; re-press the pad to stop">
                <Repeat className="w-2.5 h-2.5" /> Loop
              </button>
              <button type="button" aria-pressed={opts.choke} onClick={() => setPadOpts(i, { choke: !opts.choke })}
                className={`flex-1 flex items-center justify-center gap-1 rounded border px-1 py-0.5 text-xs font-black uppercase tracking-wide ${
                  opts.choke ? 'border-amber-400/70 bg-amber-500/20 text-amber-200' : 'border-white/10 text-zinc-500 hover:text-zinc-200 hover:border-white/25'
                }`} title="Choke group: firing this pad cuts every other choke pad">
                <Ban className="w-2.5 h-2.5" /> Choke
              </button>
            </div>
          </div>
        );
      })()}
      <div className="shrink-0 px-1.5 pb-1.5 text-xs font-semibold tabular-nums text-zinc-600 text-center">click fires · right-click clears · gear = gain/loop/choke</div>
    </div>
  );
};

/* elapsed / remaining time — updated imperatively off the engine (no re-render). */
const DeckTimes: React.FC<{ deckId: djEngine.DeckId; mirror?: boolean }> = ({ deckId, mirror }) => {
  const elapRef = useRef<HTMLSpanElement>(null);
  const remRef = useRef<HTMLSpanElement>(null);
  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    if (elapRef.current) elapRef.current.textContent = fmtTime(st.currentTime);
    if (remRef.current) remRef.current.textContent = '-' + fmtTime(Math.max(0, st.duration - st.currentTime));
  }), [deckId]);
  return (
    <span className={`flex items-center gap-1.5 text-xs font-semibold tabular-nums text-zinc-500 leading-tight ${mirror ? 'flex-row-reverse' : ''}`}>
      <span ref={elapRef}>0:00</span>
      <span className="text-zinc-700" ref={remRef}>-0:00</span>
    </span>
  );
};

/* ═══════════════════════════════ OnboardFxPanel (FX + STEMS) ════════════════ */
const FX_PAD_BT = 'w-full h-full px-1 py-1 min-w-0 tracking-normal leading-tight';
const STEM_COUNT_OPTIONS = [2, 4, 6, 12] as const;
type StemCount = typeof STEM_COUNT_OPTIONS[number];
const toStemCount = (n: number | undefined): StemCount =>
  STEM_COUNT_OPTIONS.includes(n as StemCount) ? (n as StemCount) : 4;
const STEM_LABEL: Record<string, string> = {
  vocals: 'Voc', drums: 'Drm', bass: 'Bass', other: 'Oth', guitar: 'Gtr', piano: 'Pno',
  accompaniment: 'Instr', instrumental: 'Instr', instrument: 'Instr', instr: 'Instr',
  kick: 'Kick', snare: 'Snr', hihat: 'Hat', hats: 'Hat', cymbals: 'Cym', toms: 'Tom',
};
const stemLabel = (n: string) => {
  const key = n.toLowerCase().replace(/^drums?[_-]/, '');
  return STEM_LABEL[key] ?? (n.charAt(0).toUpperCase() + n.slice(1, 4));
};
const STEM_PAD_FALLBACKS = ['vocals', 'drums', 'bass', 'other', 'kick', 'hihat'];
const STEM_MIXER_KNOB_SLOTS = {
  hi: { id: 'hi', fallback: 'Vocal', aliases: ['vocals', 'vocal', 'voice', 'singing'], tint: 0.83 },
  mid: { id: 'mid', fallback: 'Kick', aliases: ['kick', 'kick drum', 'bd', 'drums', 'drum'], tint: 0.62 },
  lo: { id: 'lo', fallback: 'Bass', aliases: ['bass', 'sub', 'sub bass'], tint: 0.36 },
  flt: { id: 'flt', fallback: 'Other', aliases: ['other', 'instrumental', 'accompaniment', 'music'], tint: 0.12 },
} as const;
const STEM_MIXER_KNOB_SLOT_LIST = [
  STEM_MIXER_KNOB_SLOTS.hi,
  STEM_MIXER_KNOB_SLOTS.mid,
  STEM_MIXER_KNOB_SLOTS.lo,
  STEM_MIXER_KNOB_SLOTS.flt,
] as const;
const findStemForSlot = (names: readonly string[], aliases: readonly string[]) => {
  const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').trim();
  const normalized = names.map((name) => ({ name, key: norm(name) }));
  return aliases
    .map(norm)
    .map((alias) => normalized.find((stem) => stem.key === alias || stem.key.includes(alias))?.name)
    .find((name): name is string => !!name) ?? null;
};
const STEM_PAD_COLORS: RGB[] = [
  [34, 197, 94],
  [245, 158, 11],
  [239, 68, 68],
  [168, 85, 247],
  [244, 114, 182],
  [45, 212, 191],
];

/* One deck's stem split.
   The split runs through `prepareStems` (analysis, then the stems backend's
   foreground run, or the cached stems) and lands on the deck through
   `djEngine.loadDeckStems`. While it runs, the stem-load pad IS the Abort
   control: its press aborts the run through `POST /api/stems/{entry}/abort`
   (the route the old deck rack's Abort button used) via the split's
   AbortSignal, and the deck keeps whatever stems it had before the split. */

export type StemSplitOutcome = 'loaded' | 'aborted' | 'failed';

export interface StemSplitDeps {
  prepare: typeof prepareStems;
  load: (deck: djEngine.DeckId, refs: StemRef[]) => Promise<unknown>;
}

const liveStemSplitDeps: StemSplitDeps = {
  prepare: prepareStems,
  load: (deck, refs) => djEngine.loadDeckStems(deck, refs),
};

/** Run one deck's stem split to the end: separate (or fetch the cached
 *  stems), then load them on the deck. An abort through `opts.signal` leaves
 *  the deck as it was: nothing is loaded and nothing is reported as failed. */
export async function runDeckStemSplit(
  deck: djEngine.DeckId,
  entryId: string,
  opts: SeparateOpts,
  onMsg: (msg: string) => void,
  deps: StemSplitDeps = liveStemSplitDeps,
): Promise<{ outcome: StemSplitOutcome; error?: string }> {
  try {
    const refs = await deps.prepare(
      entryId,
      opts,
      (pct, phase) => onMsg(pct > 0 ? `${pct}%` : phase.replace(/_/g, ' ')),
    );
    if (opts.signal?.aborted) return { outcome: 'aborted' };
    onMsg('loading');
    await deps.load(deck, refs);
    return { outcome: 'loaded' };
  } catch (e) {
    if (isStemsAborted(e) || opts.signal?.aborted) return { outcome: 'aborted' };
    return { outcome: 'failed', error: e instanceof Error ? e.message : 'failed' };
  }
}

/** The stem-load pad's face. While a split runs the pad is the Abort control:
 *  one word, enabled, named for the deck it stops. */
export const stemLoadPadFace = (
  busy: boolean,
  entryId: string | null,
  deck: djEngine.DeckId,
  stemCount: number,
  msg: string | null,
): { label: string; disabled: boolean; ariaLabel: string; title: string } => {
  if (busy) {
    const abort = `Abort stem separation for Deck ${deck}`;
    return { label: 'Abort', disabled: false, ariaLabel: abort, title: msg ? `${abort} (${msg})` : abort };
  }
  const load = `Load or separate ${stemCount} stems for Deck ${deck}`;
  return {
    label: msg ?? 'Stems',
    disabled: !entryId,
    ariaLabel: load,
    title: entryId ? load : 'Load a track first',
  };
};

export interface DeckStemSplit {
  busy: boolean;
  /** What the split is doing (a phase or a percentage) while it runs; the
   *  failure, briefly, after one fails. */
  msg: string | null;
  stemCount: StemCount;
  start: () => Promise<void>;
  abort: () => void;
}

const useDeckStemSplit = (deck: djEngine.DeckId, entryId: string | null): DeckStemSplit => {
  const stemSettings = useFeatureToggleStore((s) => s.settings.stems);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const stemCount = toStemCount(stemSettings.default_count);
  const start = async () => {
    if (!entryId || busy) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setMsg('checking');
    const { outcome, error } = await runDeckStemSplit(deck, entryId, {
      stems: stemCount,
      device: stemSettings.device || 'auto',
      quality: stemSettings.quality || 'balanced',
      signal: controller.signal,
    }, setMsg);
    controllerRef.current = null;
    setBusy(false);
    if (outcome === 'failed') {
      setMsg((error ?? 'failed').slice(0, 18));
      window.setTimeout(() => setMsg(null), 2600);
    } else {
      setMsg(null);
    }
  };
  const abort = () => {
    const controller = controllerRef.current;
    if (!controller || controller.signal.aborted) return;
    setMsg('aborting');
    controller.abort();
  };
  return { busy, msg, stemCount, start, abort };
};

const StemLoadPad: React.FC<{
  deck: djEngine.DeckId;
  entryId: string | null;
  color: RGB;
  shape?: React.ComponentProps<typeof SlidePad>['shape'];
  /** The bank's split, when the pad sits in a StemPadBank: one Abort then
   *  covers a split started from the load pad or from an empty stem pad. */
  split?: DeckStemSplit;
}> = ({ deck, entryId, color, shape, split: shared }) => {
  const own = useDeckStemSplit(deck, entryId);
  const split = shared ?? own;
  const face = stemLoadPadFace(split.busy, entryId, deck, split.stemCount, split.msg);
  return (
    <SlidePad
      color={color}
      danger={split.busy}
      on={split.busy}
      disabled={face.disabled}
      onClick={() => { if (split.busy) split.abort(); else void split.start(); }}
      className="w-full h-full px-1 py-1 min-w-0 min-h-0 overflow-hidden"
      shape={shape}
      ariaLabel={face.ariaLabel}
      title={face.title}
    >
      {split.busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Scissors className="w-3 h-3" />}
      <span className="truncate">{face.label}</span>
    </SlidePad>
  );
};

const StemTogglePad: React.FC<{
  deck: djEngine.DeckId;
  name: string | null;
  label: string;
  level: number;
  color: RGB;
  preparing?: boolean;
  onPrepare?: () => void;
  prepareLabel?: string | null;
}> = ({ deck, name, label, level, color, preparing = false, onPrepare, prepareLabel }) => {
  const on = !!name && level > 0.001;
  const canPrepare = !name && !!onPrepare;
  const shownLabel = preparing && !name ? (prepareLabel ?? 'Prep') : label;
  return (
    <SlidePad
      color={color}
      on={on || preparing}
      disabled={!name && !canPrepare}
      onClick={() => {
        if (name) {
          const current = djEngine.getStemGain(deck, name);
          djEngine.setStemGain(deck, name, current > 0.001 ? 0 : 1);
        }
        else onPrepare?.();
      }}
      className="w-full h-full px-1 py-1 min-w-0 min-h-0 overflow-hidden"
      title={name ? `Deck ${deck} ${name}: ${on ? 'click to mute' : 'click to restore'}` : canPrepare ? `Prepare stems for Deck ${deck}` : 'Load a track first'}
    >
      {preparing && !name ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
      <span className="truncate">{shownLabel}</span>
    </SlidePad>
  );
};

const StemPadBank: React.FC<{ deck: djEngine.DeckId; entryId: string | null; color: RGB; ctl: DeckCtl; mirror?: boolean }> = ({ deck, entryId, color, ctl, mirror }) => {
  // One split for the whole bank: an empty stem pad starts it, the load pad
  // shows it and aborts it.
  const split = useDeckStemSplit(deck, entryId);
  const cells: React.ReactNode[] = [
    <StemLoadPad key="load" deck={deck} entryId={entryId} color={color} split={split} />,
    ...Array.from({ length: STEM_PAD_SLOTS }, (_, i) => {
      const name = ctl.stemNames[i] ?? null;
      const label = stemLabel(name ?? STEM_PAD_FALLBACKS[i] ?? `Stem ${i + 1}`);
      const level = name ? (ctl.stemLevels[name] ?? djEngine.getStemGain(deck, name)) : 0;
      return (
        <StemTogglePad
          key={i}
          deck={deck}
          name={name}
          label={label}
          level={level}
          color={STEM_PAD_COLORS[i] ?? color}
          preparing={split.busy}
          prepareLabel={split.busy ? split.msg : null}
          onPrepare={entryId ? () => void split.start() : undefined}
        />
      );
    }),
    <SlidePad key="fx" disabled className="w-full h-full px-1 py-1 min-w-0 min-h-0 overflow-hidden" title="Open slot for the next stem layer">
      FX
    </SlidePad>,
  ];
  return (
    <div className="h-full w-full min-w-0 min-h-0 grid grid-cols-4 grid-rows-2 gap-1 p-0.5">
      {(mirror ? [...cells].reverse() : cells).map((cell) => cell)}
    </div>
  );
};

const OnboardFxPanel: React.FC<{ deck: 'A' | 'B'; accent: 'purple' | 'cyan'; entryId: string | null; ctl: DeckCtl }> = ({ deck, accent, entryId, ctl }) => {
  const color = DECK_RGB[accent];
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const hasTrack = !!entryId;
  const [fx, setFx] = useState<Record<string, number>>({ flanger: 0, reverb: 0, wahwah: 0 });
  const onFx = (k: djEngine.DjFx, v: number) => {
    setFx((p) => ({ ...p, [k]: v }));
    djEngine.setDeckFx(deck, k, v);
  };
  const triggerFx = (k: djEngine.DjFx, amount = 0.72) => onFx(k, fx[k] > 0.001 ? 0 : amount);
  const padLabel = (top: string, bottom: string) => (
    <span className="flex flex-col items-center gap-0.5 leading-none">
      <span className="text-xs font-black">{top}</span>
      <span className="text-xs font-black">{bottom}</span>
    </span>
  );

  return (
    <div className="hardware-card h-full w-full min-h-0 min-w-0 overflow-hidden p-1.5">
      <div className="h-full w-full min-h-0 grid grid-cols-[1.15fr_1.2fr_1.05fr_1.15fr] gap-1.5 items-stretch">
        <div className="min-w-0 flex flex-col gap-1">
          <div className={`flex items-center gap-1 text-xs font-black uppercase tracking-widest ${accentText}`}>
            <Sparkles className="w-3 h-3 shrink-0" />
            <span className="truncate">Onboard FX {deck}</span>
          </div>
          <div className="grid grid-cols-2 gap-1 flex-1 min-h-0">
            <SlidePad className={FX_PAD_BT} on={fx.flanger > 0.001} color={color} disabled={!hasTrack} onClick={() => triggerFx('flanger')} title="Toggle flanger">
              {padLabel('FX', 'Flanger')}
            </SlidePad>
            <SlidePad className={FX_PAD_BT} on={fx.reverb > 0.001} color={color} disabled={!hasTrack} onClick={() => triggerFx('reverb', 0.65)} title="Toggle reverb">
              {padLabel('FX', 'Reverb')}
            </SlidePad>
          </div>
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-1 text-xs font-black uppercase tracking-widest text-zinc-500">
            <Magnet className="w-2.5 h-2.5" />
            <span>Beat Grid</span>
          </div>
          <div className="grid grid-cols-4 gap-1 flex-1 min-h-0">
            {([[-4, '«4'], [-1, '‹1'], [1, '1›'], [4, '4»']] as const).map(([n, label]) => (
              <SlidePad key={label} className={FX_PAD_BT} color={color} disabled={!hasTrack} onClick={() => ctl.beatJump(n)} title={`Jump ${n > 0 ? '+' : ''}${n} beat${Math.abs(n) === 1 ? '' : 's'}`}>
                {padLabel('Jump', `${n > 0 ? '+' : ''}${n}`)}
              </SlidePad>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <div className="flex items-center gap-1 text-xs font-black uppercase tracking-widest text-zinc-500">
            <Link2 className="w-2.5 h-2.5" />
            <span>Loop Roll</span>
          </div>
          <div className="grid grid-cols-3 gap-1 flex-1 min-h-0">
            {ROLL_SIZES.map((b) => (
              <SlidePad
                key={b.label}
                className={FX_PAD_BT}
                color={color}
                disabled={!hasTrack}
                onPointerDown={(e) => { e.preventDefault(); ctl.rollDown(b.beats); }}
                onPointerUp={ctl.rollUp}
                onPointerLeave={(e) => { if (e.buttons) ctl.rollUp(); }}
                title={`${b.label}-beat loop-roll (hold)`}
              >
                {padLabel('Roll', b.label)}
              </SlidePad>
            ))}
          </div>
        </div>
        <div className="min-w-0 grid grid-cols-3 gap-1 place-items-center">
          <SlideKnob label="Reverb" value={fx.reverb} onChange={(v) => onFx('reverb', v)} min={0} max={1} step={0.01} size={34} centerReadout />
          <SlideKnob label="Flanger" value={fx.flanger} onChange={(v) => onFx('flanger', v)} min={0} max={1} step={0.01} size={34} centerReadout />
          <SlideKnob label="Wah" value={fx.wahwah} onChange={(v) => onFx('wahwah', v)} min={0} max={1} step={0.01} size={34} centerReadout />
        </div>
      </div>
    </div>
  );
};

const PERF_PAD_BT = 'w-full h-full px-1 py-0.5 min-w-0 min-h-0 overflow-hidden tracking-normal leading-tight';
/** Pad grids are height size-containers (index.css .dj-pad-grid) so the pads
 *  take the cell's height instead of overflowing it and being clipped. */
const PERF_PAD_GRID = 'dj-pad-grid grid gap-1 flex-1 min-h-0 auto-rows-fr';

const CompactPerformancePads: React.FC<{ deck: 'A' | 'B'; accent: 'purple' | 'cyan'; entryId: string | null; ctl: DeckCtl }> = ({ deck, accent, entryId, ctl }) => {
  const color = DECK_RGB[accent];
  const accentText = accent === 'purple' ? 'text-purple-300' : 'text-cyan-300';
  const hasTrack = !!entryId;
  const padLabel = (top: string, bottom: string) => (
    <span className="flex flex-col items-center gap-0.5 leading-none">
      <span className="dj-pad-top text-xs font-black opacity-80">{top}</span>
      <span className="text-xs font-black">{bottom}</span>
    </span>
  );
  return (
    <div className="hardware-card h-full w-full min-h-0 min-w-0 overflow-hidden p-1.5">
      <div className="h-full w-full min-h-0 grid grid-cols-[0.8fr_1.15fr_1.35fr] gap-1.5 items-stretch">
        <div className="min-w-0 flex flex-col gap-1">
          <div className={`text-xs font-black uppercase tracking-widest ${accentText}`}>Hot Cues</div>
          <div className={`${PERF_PAD_GRID} grid-cols-4`}>
            {Array.from({ length: HOTCUE_SLOTS }, (_, i) => {
              const c = ctl.cues?.[i] ?? null;
              const set = c != null;
              return (
                <SlidePad
                  key={i}
                  on={set}
                  color={color}
                  disabled={!hasTrack}
                  className={PERF_PAD_BT}
                  onClick={() => ctl.setHotcue(i)}
                  onContextMenu={(e) => { e.preventDefault(); ctl.dropHotcue(i); }}
                  title={set ? `Hot cue ${i + 1} at ${fmtTime(c)} — click to jump, right-click to clear` : `Set hot cue ${i + 1}`}
                >
                  {padLabel('Cue', String(i + 1))}
                </SlidePad>
              );
            })}
          </div>
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <div className="text-xs font-black uppercase tracking-widest text-zinc-500">Beat Loops</div>
          <div className={`${PERF_PAD_GRID} grid-cols-6`}>
            {BEAT_SIZES.map((b) => (
              <SlidePad key={b.label} className={PERF_PAD_BT} on={ctl.loopActive && ctl.activeLoopBeats === b.beats} color={color} disabled={!hasTrack} onClick={() => ctl.toggleBeatLoop(b.beats)} title={`${b.label}-beat loop`}>
                {padLabel('Loop', b.label)}
              </SlidePad>
            ))}
            <SlidePad className={PERF_PAD_BT} danger disabled={!ctl.loopActive} onClick={ctl.exitLoop} title="Exit beat loop">
              {padLabel('Loop', 'Out')}
            </SlidePad>
          </div>
        </div>
        <div className="min-w-0 flex flex-col gap-1">
          <div className="text-xs font-black uppercase tracking-widest text-zinc-500">Roll / Jump</div>
          <div className={`${PERF_PAD_GRID} grid-cols-8`}>
            {ROLL_SIZES.map((b) => (
              <SlidePad
                key={b.label}
                className={PERF_PAD_BT}
                color={color}
                disabled={!hasTrack}
                onPointerDown={(e) => { e.preventDefault(); ctl.rollDown(b.beats); }}
                onPointerUp={ctl.rollUp}
                onPointerLeave={(e) => { if (e.buttons) ctl.rollUp(); }}
                title={`${b.label}-beat loop-roll (hold)`}
              >
                {padLabel('Roll', b.label)}
              </SlidePad>
            ))}
            <SlidePad className={PERF_PAD_BT} on={ctl.slip} color={[245, 158, 11]} disabled={!hasTrack} onClick={() => ctl.setSlip(!ctl.slip)} title="Slip mode">
              {padLabel('Mode', 'Slip')}
            </SlidePad>
            {([[-4, '-4'], [-1, '-1'], [1, '+1'], [4, '+4']] as const).map(([n, label]) => (
              <SlidePad key={label} className={PERF_PAD_BT} color={color} disabled={!hasTrack} onClick={() => ctl.beatJump(n)} title={`Jump ${n > 0 ? '+' : ''}${n} beat${Math.abs(n) === 1 ? '' : 's'}`}>
                {padLabel('Jump', label)}
              </SlidePad>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

/* ═══════════════════════════════ SideListLane ═══════════════════════════════ */

/** Staging queue ("prepare / play-next") — a compact card in the center-bottom
 *  rack row, flanked by the FX racks. Drag library/set rows in to stage them
 *  (audio files from the desktop import to the library first, then stage);
 *  reorder into play order; fire each onto a deck (→A/→B) or push the whole
 *  queue into the active Automix set. Staged rows re-emit the shared
 *  DJ_TRACK_MIME so they also drop straight onto the waveform lanes / sampler.
 *  Backed by the ephemeral useDjSideList store. */
const SideListLane: React.FC<{ onLoadDeck: (entryId: string, deck: djEngine.DeckId) => void }> = ({ onLoadDeck }) => {
  const items = useDjSideList((s) => s.items);
  const add = useDjSideList((s) => s.add);
  const setItems = useDjSideList((s) => s.setItems);
  const remove = useDjSideList((s) => s.remove);
  const reorder = useDjSideList((s) => s.reorder);
  const clear = useDjSideList((s) => s.clear);
  // `entries` + `lookupVersion` are the re-render triggers for the id lookups
  // below; neither is read directly any more.
  useLibraryStore((s) => s.entries);
  useLibraryStore((s) => s.lookupVersion);
  const analysisById = useDjAnalysisStore((s) => s.byId);
  const activeId = useSetlistStore((s) => s.activeId);
  const appendToSet = useSetlistStore((s) => s.append);
  const [over, setOver] = useState(false);
  const [queueSort, setQueueSort] = useState<{ key: 'title' | 'bpm'; dir: 'asc' | 'desc' } | null>(null);

  const onDrop = (e: React.DragEvent) => {
    setOver(false);
    const dt = e.dataTransfer;
    if (!dropHasLibraryOrFiles(dt, [DJ_TRACK_MIME])) return;
    e.preventDefault();
    // Read the library id synchronously — protected mode empties the
    // DataTransfer as soon as this handler yields.
    const draggedId = dt.getData(DJ_TRACK_MIME);
    if (draggedId) {
      // Staged by ID: the row may be on an evicted page, so ask the store.
      void useLibraryStore.getState().ensureEntry(draggedId).then((lib) => {
        if (lib) add({ entryId: lib.id, label: lib.title });
      });
      return;
    }
    // A desktop drop imports every audio file to the library, then stages each.
    void entriesFromDrop(dt, { mimes: [], entries: [] }).then((dropped) => {
      for (const lib of dropped) add({ entryId: lib.id, label: lib.title });
      if (dropped.length > 0) logInfo('dj', `Imported ${dropped.length} file(s) from the desktop into the Next queue`);
    });
  };
  const pushToSet = () => {
    if (!activeId || items.length === 0) return;
    appendToSet(activeId, items.map((it) => ({ entryId: it.entryId, label: it.label, kind: 'audio' as const })));
  };
  const sortQueue = (key: 'title' | 'bpm') => {
    if (items.length < 2) return;
    const dir: 'asc' | 'desc' = queueSort?.key === key && queueSort.dir === 'asc' ? 'desc' : 'asc';
    const signed = dir === 'asc' ? 1 : -1;
    const sorted = [...items].sort((a, b) => {
      if (key === 'title') {
        const byTitle = a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
        return byTitle !== 0 ? byTitle * signed : a.entryId.localeCompare(b.entryId);
      }
      const abpm = analysisById[a.entryId]?.data?.bpm ?? null;
      const bbpm = analysisById[b.entryId]?.data?.bpm ?? null;
      if (abpm == null && bbpm == null) {
        return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
      }
      if (abpm == null) return 1;
      if (bbpm == null) return -1;
      const byBpm = abpm - bbpm;
      return byBpm !== 0 ? byBpm * signed : a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
    });
    setItems(sorted);
    setQueueSort({ key, dir });
  };
  const sortIconClass = (key: 'title' | 'bpm') =>
    `transition-transform ${queueSort?.key === key ? 'opacity-100 text-purple-200' : 'opacity-45'} ${queueSort?.key === key && queueSort.dir === 'desc' ? 'rotate-180' : ''}`;

  return (
    <div
      onDragOver={(e) => { if (dropHasLibraryOrFiles(e.dataTransfer, [DJ_TRACK_MIME])) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`hardware-card min-h-0 overflow-hidden transition-colors ${over ? 'ring-1 ring-purple-400/60 bg-purple-500/5' : ''}`}
    >
      {/* header band */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        <ListMusic className="w-3.5 h-3.5 text-purple-400 shrink-0" />
        <span className="text-xs font-black uppercase tracking-widest text-purple-300">Next</span>
        <span className="text-xs font-semibold text-zinc-600 tabular-nums">{items.length}</span>
        <div className="flex items-center gap-0.5 ml-auto">
          <button onClick={() => sortQueue('title')} disabled={items.length < 2} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-25" title="Sort queue by title"><ArrowDownAZ className={`w-3 h-3 ${sortIconClass('title')}`} /></button>
          <button onClick={() => sortQueue('bpm')} disabled={items.length < 2} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-25" title="Sort queue by BPM"><Gauge className={`w-3 h-3 ${sortIconClass('bpm')}`} /></button>
          <button onClick={pushToSet} disabled={!activeId || items.length === 0} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-25" title={activeId ? 'Append the whole queue to the active set' : 'Open or create a set first (Source Tree ›)'}><Plus className="w-3 h-3" /></button>
          <button onClick={clear} disabled={items.length === 0} className="p-0.5 text-zinc-500 hover:text-rose-400 disabled:opacity-25" title="Clear the queue"><Trash2 className="w-3 h-3" /></button>
        </div>
      </div>

      {/* staged-track list (vertical, fills the cell) */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {items.length === 0 ? (
          <div className="h-full grid place-items-center text-xs font-semibold tabular-nums text-zinc-600 px-3 text-center">Drag tracks here to stage them play-next.</div>
        ) : items.map((it, i) => {
          // The queue holds ids and its own labels, so a staged track stays
          // usable while its library row is on no loaded page: the store
          // fetches the record and `lookupVersion` brings this list back round.
          const lib = useLibraryStore.getState().getById(it.entryId) ?? null;
          const bpm = analysisById[it.entryId]?.data?.bpm ?? null;
          return (
            <div
              key={it.entryId}
              draggable={!!lib}
              onDragStart={(ev) => { if (!lib) return; ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData(DJ_TRACK_MIME, it.entryId); ev.dataTransfer.setData('text/plain', it.label); }}
              className={`group/chip grid items-center gap-1 px-2 py-0.5 border-b border-white/3 hover:bg-white/5 ${lib ? 'cursor-grab active:cursor-grabbing' : 'opacity-40'}`}
              style={{ gridTemplateColumns: '1.4rem minmax(0,1fr) 2.4rem 3.6rem' }}
              title={lib ? it.label : `${it.label} — no longer in library`}
            >
              <span className="text-xs font-semibold text-zinc-600 tabular-nums text-right">{String(i + 1).padStart(2, '0')}</span>
              <span className="text-xs font-semibold tabular-nums text-zinc-300 truncate">{it.label}</span>
              <span className="text-xs font-semibold text-zinc-500 tabular-nums text-right">{bpm != null ? bpm.toFixed(0) : '—'}</span>
              <span className="flex items-center justify-end gap-0.5">
                <span className="hidden group-hover/chip:flex items-center gap-0.5">
                  <button onClick={() => reorder(i, i - 1)} disabled={i === 0} className="text-zinc-600 hover:text-zinc-200 disabled:opacity-20" title="Move earlier"><ChevronDown className="w-2.5 h-2.5 rotate-180" /></button>
                  <button onClick={() => reorder(i, i + 1)} disabled={i === items.length - 1} className="text-zinc-600 hover:text-zinc-200 disabled:opacity-20" title="Move later"><ChevronDown className="w-2.5 h-2.5" /></button>
                  <button onClick={() => remove(it.entryId)} className="text-zinc-600 hover:text-rose-400" title="Remove from queue"><X className="w-2.5 h-2.5" /></button>
                </span>
                <button onClick={() => lib && onLoadDeck(it.entryId, 'A')} disabled={!lib} className="px-0.5 rounded text-xs font-black text-purple-300 hover:bg-purple-500/20 disabled:opacity-30" title="Load onto Deck A">→A</button>
                <button onClick={() => lib && onLoadDeck(it.entryId, 'B')} disabled={!lib} className="px-0.5 rounded text-xs font-black text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-30" title="Load onto Deck B">→B</button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ═══════════════════════════════ TrackBrowser ═══════════════════════════════ */

const TrackBrowser: React.FC<{ source: Source; setSource: (s: Source) => void; onLoadDeck: (entryId: string, deck: djEngine.DeckId) => void }> = ({ source, setSource, onLoadDeck }) => {
  // The library store is PAGED (T31): `entries` is the loaded window and
  // `total` is how many rows the current filters match. This browser therefore
  // scrolls by global index and asks the store for the range it rendered.
  const entries = useLibraryStore((s) => s.entries);
  const libTotal = useLibraryStore((s) => s.total);
  const libLoading = useLibraryStore((s) => s.pagesLoading);
  const entryAt = useLibraryStore((s) => s.entryAt);
  const ensureRange = useLibraryStore((s) => s.ensureRange);
  const libSearch = useLibraryStore((s) => s.searchQuery);
  const lookupVersion = useLibraryStore((s) => s.lookupVersion);
  const analysisById = useDjAnalysisStore((s) => s.byId);
  const stemSettings = useFeatureToggleStore((s) => s.settings.stems);
  const setlists = useSetlistStore((s) => s.setlists);
  const renameSetlist = useSetlistStore((s) => s.rename);
  const removeSetlist = useSetlistStore((s) => s.remove);
  const setEntries = useSetlistStore((s) => s.setEntries);
  const appendToSet = useSetlistStore((s) => s.append);
  const stage = useDjSideList((s) => s.add);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [dropOverSet, setDropOverSet] = useState(false);
  const [sort, setSort] = useState<{ key: DjSortKey; dir: 'asc' | 'desc' }>({ key: 'order', dir: 'asc' });
  const [appliedSetSort, setAppliedSetSort] = useState<{ key: 'title' | 'bpm'; dir: 'asc' | 'desc' } | null>(null);
  type StemCache = { status: 'checking' | 'none' | 'ready' | 'running' | 'error'; count?: number; message?: string };
  const [stemCache, setStemCache] = useState<Record<string, StemCache>>({});
  const [stemRun, setStemRun] = useState<{ entryId: string; title: string; phase: string; progress: number } | null>(null);
  const listRef = useRef<ListImperativeAPI | null>(null);

  const set = source.kind === 'set' ? setlists[source.id] ?? null : null;
  const isSet = source.kind === 'set' && !!set;
  const rowMenu = useContextMenu<{ row: DjBrowserRow }>();

  // ── The library's own query ───────────────────────────────────────────────
  // A source tab IS a library filter, and the backend applies it. The store's
  // setters no-op when nothing changed, so this is cheap to re-run.
  useEffect(() => {
    if (source.kind === 'set') return;
    const store = useLibraryStore.getState();
    const { favorite, source: src } = libSourceQuery(source.kind as LibSourceKind);
    store.setOnlyFavorites(favorite);
    store.setSourceFilter(src);
  }, [source]);

  // The search box is the LIBRARY's search while a library source is open, so
  // the backend narrows 200,000 rows instead of this component filtering the
  // few hundred in hand. Over a SET it stays a local filter — a set is small.
  useEffect(() => {
    if (source.kind === 'set') return;
    setQ(libSearch);
  }, [source.kind, libSearch]);

  const onSearchChange = (value: string) => {
    setQ(value);
    if (source.kind !== 'set') useLibraryStore.getState().setSearchQuery(value);
  };

  // A server-backed order is the library's; anything else can only order the
  // rows in hand, and the header says so.
  const serverSort = isSet ? null : djServerSort(sort.key, sort.dir);
  useEffect(() => {
    if (!serverSort) return;
    useLibraryStore.getState().setSortBy(serverSort);
  }, [serverSort]);

  // ── Rows ──────────────────────────────────────────────────────────────────
  const libRow = useCallback((entry: LibraryEntry, order: number): DjBrowserRow => {
    const d = analysisById[entry.id]?.data ?? null;
    return {
      entryId: entry.id,
      title: entry.title,
      bpm: d?.bpm ?? null,
      key: d?.key ? keyLabel(d.key, d.scale) : null,
      dur: d?.duration_sec ?? entry.duration ?? null,
      date: entry.timestamp,
      source: entry.source,
      order,
    };
  }, [analysisById]);

  /**
   * The rows this browser MATERIALIZES: a set's entries, or — when the sort is
   * one the library cannot do — the loaded library rows put in that order.
   * Empty when the library is answering the order itself, in which case rows
   * come straight off `entryAt` and never exist as an array.
   */
  const materialized: DjBrowserRow[] | null = useMemo(() => {
    const compare = (a: DjBrowserRow, b: DjBrowserRow): number => {
      const value = (r: DjBrowserRow) => (sort.key === 'date' ? (r.date ? Date.parse(r.date) : null) : r[sort.key]);
      const av = value(a);
      const bv = value(b);
      if (av == null && bv == null) return a.order - b.order;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sort.dir === 'asc' ? cmp : -cmp;
    };

    if (isSet) {
      const rows = set!.entries.map((e, i): DjBrowserRow => {
        const lib = e.entryId ? useLibraryStore.getState().getById(e.entryId) ?? null : null;
        const d = e.entryId ? analysisById[e.entryId]?.data ?? null : null;
        return {
          entryId: e.entryId,
          title: e.label,
          bpm: d?.bpm ?? null,
          key: d?.key ? keyLabel(d.key, d.scale) : null,
          dur: d?.duration_sec ?? lib?.duration ?? null,
          date: lib?.timestamp ?? null,
          source: lib?.source ?? 'set',
          order: i + 1,
          setIndex: i,
        };
      });
      const needle = q.trim().toLowerCase();
      const filtered = needle ? rows.filter((r) => r.title.toLowerCase().includes(needle)) : rows;
      return [...filtered].sort(compare);
    }

    if (serverSort) return null;
    // A client-only order (BPM, KEY, SOURCE, or a direction the library does
    // not offer): the loaded rows, in that order. The header says how many.
    return entries.map((e, i) => libRow(e, i + 1)).sort(compare);
    // `lookupVersion` is a dependency because a set row's library record can
    // arrive after the first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSet, set, q, sort, entries, serverSort, libRow, analysisById, lookupVersion]);

  const rowCount = materialized ? materialized.length : libTotal;
  const rowAt = useCallback((index: number): DjBrowserRow | undefined => {
    if (materialized) return materialized[index];
    const entry = entryAt(index);
    return entry ? libRow(entry, index + 1) : undefined;
  }, [materialized, entryAt, libRow]);

  const handleRowsRendered = useCallback((
    _visible: { startIndex: number; stopIndex: number },
    rendered: { startIndex: number; stopIndex: number },
  ) => {
    if (materialized) return; // already in hand
    void ensureRange(rendered.startIndex, rendered.stopIndex);
  }, [materialized, ensureRange]);

  // The library has moved under the list (new filter, new sort): go back to
  // the top so the user is not left staring at row 40,000 of a new result set.
  useEffect(() => {
    if (materialized) return;
    listRef.current?.scrollToRow({ index: 0, align: 'start' });
  }, [serverSort, libSearch, source, materialized]);

  const sourceLabel = isSet ? set!.name : (LIB_SOURCE_LABEL[source.kind as LibSourceKind] ?? 'Library');
  const setSortKey = (key: DjSortKey) => setSort((p) => (p.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'order' || key === 'title' ? 'asc' : 'desc' }));
  const SortHeader: React.FC<{ id: DjSortKey; children: React.ReactNode; align?: 'left' | 'right' }> = ({ id, children, align = 'left' }) => (
    <button
      type="button"
      onClick={() => setSortKey(id)}
      className={`min-w-0 flex items-center gap-1 truncate hover:text-zinc-300 ${align === 'right' ? 'justify-end text-right' : ''} ${sort.key === id ? 'text-zinc-200' : ''}`}
      title={`Sort by ${String(children)}`}
    >
      <span className="truncate">{children}</span>
      <ChevronDown className={`w-2.5 h-2.5 shrink-0 transition-transform ${sort.key === id ? 'opacity-100' : 'opacity-20'} ${sort.key === id && sort.dir === 'asc' ? 'rotate-180' : ''}`} />
    </button>
  );

  const commitRename = () => { if (set && editName.trim()) renameSetlist(set.id, editName.trim()); setEditing(false); };
  const reorder = (from: number, to: number) => {
    if (!set || to < 0 || to >= set.entries.length) return;
    const arr = [...set.entries];
    const [it] = arr.splice(from, 1);
    arr.splice(to, 0, it);
    setEntries(set.id, arr);
  };
  const removeEntry = (i: number) => { if (set) setEntries(set.id, set.entries.filter((_, idx) => idx !== i)); };
  const hasSetDropData = (e: React.DragEvent): boolean => {
    if (!set) return false;
    if (e.dataTransfer.types.includes(DJ_TRACK_MIME)) return true;
    return Array.from(e.dataTransfer.files).some(isExternalAudioFile)
      || Array.from(e.dataTransfer.items ?? []).some((item) => item.kind === 'file' && (item.type.startsWith('audio/') || item.type === ''));
  };
  const onSetDragOver = (e: React.DragEvent) => {
    if (!hasSetDropData(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDropOverSet(true);
  };
  const onSetDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropOverSet(false);
  };
  const onSetDrop = async (e: React.DragEvent) => {
    setDropOverSet(false);
    if (!set || !hasSetDropData(e)) return;
    e.preventDefault();
    e.stopPropagation();

    const entryId = e.dataTransfer.getData(DJ_TRACK_MIME);
    const fallbackLabel = e.dataTransfer.getData('text/plain');
    if (entryId) {
      // The dragged row can sit on a page the cache dropped, so the title comes
      // from the store's id lookup rather than from the loaded rows.
      const lib = await useLibraryStore.getState().ensureEntry(entryId);
      appendToSet(set.id, [{ entryId, label: lib?.title || fallbackLabel || 'Untitled', kind: 'audio' }]);
      return;
    }

    const imported: SetlistEntry[] = [];
    for (const file of Array.from(e.dataTransfer.files).filter(isExternalAudioFile)) {
      const entry = await importAudioFileToLibrary(file);
      imported.push({ entryId: entry.id, label: entry.title, kind: 'audio' });
    }
    if (imported.length > 0) appendToSet(set.id, imported);
  };
  const sendEntry = (e: SetlistEntry) => {
    const lib = e.entryId ? useLibraryStore.getState().getById(e.entryId) ?? null : null;
    sendTrackToVj({ entryId: e.entryId, label: e.label, url: lib?.audioUrl ?? e.url, kind: e.kind ?? 'audio' });
  };
  const sendWholeSet = () => {
    if (!set) return;
    const items: VjSetItem[] = set.entries.map((e) => {
      const lib = e.entryId ? useLibraryStore.getState().getById(e.entryId) ?? null : null;
      return { entryId: e.entryId, label: e.label, url: lib?.audioUrl ?? e.url, kind: e.kind ?? 'audio' };
    });
    sendSetToVj({ setId: set.id, name: set.name, items });
  };
  const sortSetEntries = (key: 'title' | 'bpm') => {
    if (!set || set.entries.length < 2) return;
    const dir: 'asc' | 'desc' = appliedSetSort?.key === key && appliedSetSort.dir === 'asc' ? 'desc' : 'asc';
    const signed = dir === 'asc' ? 1 : -1;
    const next = [...set.entries].sort((a, b) => {
      if (key === 'title') {
        return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) * signed;
      }
      const abpm = a.entryId ? analysisById[a.entryId]?.data?.bpm ?? null : null;
      const bbpm = b.entryId ? analysisById[b.entryId]?.data?.bpm ?? null : null;
      if (abpm == null && bbpm == null) {
        return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
      }
      if (abpm == null) return 1;
      if (bbpm == null) return -1;
      const byBpm = abpm - bbpm;
      return byBpm !== 0 ? byBpm * signed : a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
    });
    setEntries(set.id, next);
    setSort({ key: 'order', dir: 'asc' });
    setAppliedSetSort({ key, dir });
  };
  const setSortIconClass = (key: 'title' | 'bpm') =>
    `w-3 h-3 transition-transform ${appliedSetSort?.key === key ? 'opacity-100 text-purple-200' : 'opacity-55'} ${appliedSetSort?.key === key && appliedSetSort.dir === 'desc' ? 'rotate-180' : ''}`;

  const stemCount = toStemCount(stemSettings.default_count);
  const refreshStemCache = async (entryId: string) => {
    setStemCache((p) => ({ ...p, [entryId]: { status: 'checking' } }));
    try {
      const refs = await listStems(entryId);
      setStemCache((p) => ({
        ...p,
        [entryId]: refs.length >= stemCount
          ? { status: 'ready', count: refs.length }
          : { status: 'none', count: refs.length },
      }));
    } catch (e) {
      setStemCache((p) => ({
        ...p,
        [entryId]: { status: 'error', message: e instanceof Error ? e.message : 'Stem check failed' },
      }));
    }
  };
  const openSetRowMenu = (e: React.MouseEvent, row: DjBrowserRow) => {
    if (!isSet || !row.entryId) return;
    rowMenu.open(e, { row });
    const cached = stemCache[row.entryId];
    if (!cached || cached.status === 'error') void refreshStemCache(row.entryId);
  };
  const separateSetRowStems = async (row: DjBrowserRow) => {
    if (!row.entryId) return;
    const entryId = row.entryId;
    setStemCache((p) => ({ ...p, [entryId]: { status: 'running', count: p[entryId]?.count } }));
    setStemRun({ entryId, title: row.title, phase: 'starting', progress: 0 });
    try {
      const refs = await prepareStems(
        entryId,
        {
          stems: stemCount,
          device: stemSettings.device || 'auto',
          quality: stemSettings.quality || 'balanced',
        },
        (pct, phase) => {
          setStemRun({ entryId, title: row.title, phase: phase.replace(/_/g, ' '), progress: pct });
        },
      );
      setStemCache((p) => ({ ...p, [entryId]: { status: 'ready', count: refs.length } }));
      setStemRun({ entryId, title: row.title, phase: 'complete', progress: 100 });
      window.setTimeout(() => {
        setStemRun((cur) => (cur?.entryId === entryId ? null : cur));
      }, 2200);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Stem separation failed';
      setStemCache((p) => ({ ...p, [entryId]: { status: 'error', message, count: p[entryId]?.count } }));
      setStemRun({ entryId, title: row.title, phase: message.slice(0, 36), progress: 0 });
      window.setTimeout(() => {
        setStemRun((cur) => (cur?.entryId === entryId ? null : cur));
      }, 3600);
    }
  };
  const menuRow = rowMenu.payload?.row ?? null;
  const menuStem = menuRow?.entryId ? stemCache[menuRow.entryId] : null;
  const menuItems: ContextMenuItem[] = menuRow ? [
    {
      type: 'item',
      label: menuStem?.status === 'checking'
        ? 'Checking stems…'
        : menuStem?.status === 'running'
          ? 'Running stems…'
          : menuStem?.status === 'ready'
            ? 'Stems already cached'
            : (menuStem?.count ? `Upgrade to ${stemCount} stems…` : `Separate ${stemCount} stems…`),
      icon: menuStem?.status === 'checking' || menuStem?.status === 'running'
        ? <Loader2 className="w-3 h-3 animate-spin" />
        : <Scissors className="w-3 h-3" />,
      hint: menuStem?.count ? `${menuStem.count}` : undefined,
      disabled: !menuRow.entryId || menuStem?.status === 'checking' || menuStem?.status === 'running' || menuStem?.status === 'ready',
      onSelect: () => { void separateSetRowStems(menuRow); },
    },
    { type: 'separator' },
    {
      type: 'item',
      label: 'Load on Deck A',
      onSelect: () => { if (menuRow.entryId) onLoadDeck(menuRow.entryId, 'A'); },
    },
    {
      type: 'item',
      label: 'Load on Deck B',
      onSelect: () => { if (menuRow.entryId) onLoadDeck(menuRow.entryId, 'B'); },
    },
    {
      type: 'item',
      label: 'Remove from set',
      icon: <Trash2 className="w-3 h-3" />,
      danger: true,
      disabled: menuRow.setIndex == null,
      onSelect: () => { if (menuRow.setIndex != null) removeEntry(menuRow.setIndex); },
    },
  ] : [];

  // What the count in the header means, honestly: the whole result set when the
  // library is doing the ordering, the rows in hand when it cannot.
  const countLabel = isSet
    ? `${rowCount} tracks`
    : serverSort
      ? `${libTotal.toLocaleString()} files`
      : `${rowCount.toLocaleString()} of ${libTotal.toLocaleString()} loaded`;

  return (
    <div
      className={`hardware-card h-full w-full flex flex-col min-h-0 overflow-hidden ${dropOverSet ? 'ring-2 ring-inset ring-purple-300/60' : ''}`}
      onDragEnter={isSet ? onSetDragOver : undefined}
      onDragOver={isSet ? onSetDragOver : undefined}
      onDragLeave={isSet ? onSetDragLeave : undefined}
      onDrop={isSet ? (e) => { void onSetDrop(e); } : undefined}
    >
      {/* header: source name + count + search + (set actions) */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        {isSet ? <ListMusic className="w-3.5 h-3.5 text-purple-400 shrink-0" /> : <LibraryIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
        {editing && set ? (
          <>
            <label htmlFor="dj-set-rename" className="sr-only">Set name</label>
            <input
              id="dj-set-rename"
              name="dj-set-rename"
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false); }}
              onBlur={commitRename}
              className="bg-black/50 border border-purple-400/50 rounded px-1.5 py-0.5 text-xs text-zinc-100 focus:outline-none w-36"
            />
          </>
        ) : (
          <span className="text-xs font-black uppercase tracking-wider text-purple-300 truncate max-w-40" title={sourceLabel}>{sourceLabel}</span>
        )}
        <span
          className="text-xs font-semibold tabular-nums text-zinc-600"
          title={!isSet && !serverSort ? 'BPM, KEY and SOURCE can only be ordered over the tracks already loaded — scroll to bring more in, or sort by #, Date, Title or Len to order the whole library.' : undefined}
        >
          {countLabel}
        </span>
        {libLoading > 0 && !isSet && (
          <Loader2 role="img" className="w-2.5 h-2.5 animate-spin text-purple-300/70" aria-label="Loading more of the library" />
        )}
        {stemRun && (
          <span className="min-w-0 max-w-48 truncate text-xs font-semibold tabular-nums text-emerald-300" title={`${stemRun.title}: ${stemRun.phase}`}>
            stems · {stemRun.progress > 0 ? `${Math.round(stemRun.progress)}%` : stemRun.phase}
          </span>
        )}
        <div className="flex items-center gap-1 ml-auto bg-black/40 border border-white/10 rounded px-1.5 w-36 max-w-[40%]">
          <Search className="w-3 h-3 text-zinc-600 shrink-0" />
          <label htmlFor="dj-browser-search" className="sr-only">
            {isSet ? 'Filter this set' : 'Search the library'}
          </label>
          <input
            id="dj-browser-search"
            name="dj-browser-search"
            value={q}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="search…"
            className="flex-1 min-w-0 bg-transparent text-xs font-mono text-zinc-200 py-1 focus:outline-none placeholder:text-zinc-600"
          />
        </div>
        {isSet && set && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={() => sortSetEntries('title')} disabled={set.entries.length < 2} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-30" title="Reorder this playlist by title"><ArrowDownAZ className={setSortIconClass('title')} /></button>
            <button onClick={() => sortSetEntries('bpm')} disabled={set.entries.length < 2} className="p-0.5 text-zinc-500 hover:text-purple-300 disabled:opacity-30" title="Reorder this playlist by BPM"><Gauge className={setSortIconClass('bpm')} /></button>
            <button onClick={() => { setEditName(set.name); setEditing(true); }} className="p-0.5 text-zinc-500 hover:text-zinc-200" title="Rename set"><Pencil className="w-3 h-3" /></button>
            <button onClick={sendWholeSet} disabled={set.entries.length === 0} className="p-0.5 text-zinc-500 hover:text-cyan-300 disabled:opacity-30" title="Send whole set to VJ"><Cast className="w-3.5 h-3.5" /></button>
            <button onClick={() => { removeSetlist(set.id); setSource({ kind: 'library' }); }} className="p-0.5 text-zinc-500 hover:text-rose-400" title="Delete set"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        )}
      </div>

      {/* column header */}
      <div className="shrink-0 grid items-center gap-1 px-2 py-0.5 border-b border-white/5 text-xs font-black uppercase tracking-wider text-zinc-600" style={{ gridTemplateColumns: DJ_BROWSER_GRID }}>
        <SortHeader id="order" align="right">#</SortHeader>
        <SortHeader id="date">Date</SortHeader>
        <SortHeader id="title">Title</SortHeader>
        <SortHeader id="bpm" align="right">BPM</SortHeader>
        <SortHeader id="key">Key</SortHeader>
        <SortHeader id="dur" align="right">Len</SortHeader>
        <SortHeader id="source">Source</SortHeader>
        <span className="text-right pr-1">Load</span>
      </div>

      {/* rows */}
      <div className="flex-1 min-h-0">
        {rowCount === 0 ? (
          <div className="h-full grid place-items-center text-xs font-semibold tabular-nums text-zinc-600 px-3 text-center">
            {isSet ? 'Empty set — drag tracks here, or Save a loaded deck.' : (libTotal === 0 && !q.trim() ? 'Library empty — generate or import audio.' : 'No matches.')}
          </div>
        ) : (
          <List
            listRef={listRef}
            rowComponent={DjBrowserRowView}
            rowCount={rowCount}
            rowHeight={DJ_BROWSER_ROW_HEIGHT}
            rowProps={{
              rowAt,
              revision: lookupVersion,
              isSet,
              onLoadDeck,
              onStage: (entryId: string, title: string) => stage({ entryId, label: title }),
              onSendVj: (row: DjBrowserRow) => sendEntry({ entryId: row.entryId, label: row.title, kind: 'audio' }),
              onReorder: reorder,
              onRemove: removeEntry,
              onContextMenu: openSetRowMenu,
            }}
            overscanCount={10}
            onRowsRendered={handleRowsRendered}
            aria-label={isSet ? 'Set tracks' : 'Library tracks'}
            style={{ height: '100%' }}
          />
        )}
      </div>
      <ContextMenu
        position={rowMenu.position}
        onClose={rowMenu.close}
        items={menuItems}
        title={menuRow ? `Set track · ${menuRow.title}` : undefined}
        minWidth="14rem"
      />
    </div>
  );
};

/* ═══════════════════════════════ SourceTree ═════════════════════════════════ */

/** Source tree — every entry is live: filtered views over the library
 *  (Library / Favorites / Generated / Imports), real Online Download, and the
 *  user's Sets. No placeholder/streaming stubs. */
const SourceTree: React.FC<{ source: Source; setSource: (s: Source) => void; libCount: number }> = ({ source, setSource, libCount }) => {
  const entries = useLibraryStore((s) => s.entries);
  const libRevision = useLibraryStore((s) => s.revision);
  const libPaged = useLibraryStore((s) => s.paged);
  const setlists = useSetlistStore((s) => s.setlists);
  const createSetlist = useSetlistStore((s) => s.create);
  const setActive = useSetlistStore((s) => s.setActive);
  const activeSetId = useSetlistStore((s) => s.activeId);
  const registerBundled = useSetlistStore((s) => s.registerBundled);
  const sets = Object.values(setlists).sort((a, b) => b.updatedAt - a.updatedAt);
  // Which set has a `/register` POST in flight: the store's one guard, shared
  // with START AUTO DJ and the Automix chip, so a row pressed while either of
  // those is registering cannot POST again. The rows used to keep their own
  // flag, which the header never saw.
  const registeringId = useSetlistStore((s) => s.registeringId);

  /** Activate + register a set. Reports through the ProcessingLog instead of
   *  the 2.2-second footer flash, which is where the user already reads
   *  failures — and never returns silently on "not enough tracks", which used
   *  to be an outright no-op. */
  const openSet = async (id: string, name: string, autoDj: boolean): Promise<void> => {
    if (useSetlistStore.getState().registeringId) return;
    setActive(id);
    setSource({ kind: 'set', id });
    const registered = await registerBundled(id);
    if (registered === null) return; // registerBundled already logged why
    const playable = djAutomixEntries(registered).length;
    if (!autoDj) return;
    if (playable < AUTO_DJ_MIN_TRACKS) {
      logWarn(
        'dj',
        `"${name}" has ${playable} playable track${playable === 1 ? '' : 's'} — Auto-DJ needs ${AUTO_DJ_MIN_TRACKS}.`,
      );
      return;
    }
    // This set's play button means "play this set", from the top, even
    // over a mix already running on another set.
    useDjAutomix.getState().requestStart('fresh');
  };

  /**
   * The numbers beside Favorites / Generated / Imports.
   *
   * Counting the loaded rows would print "43 favorites" for a library with
   * four thousand, so each is one `limit=1` request read for its `total`, taken
   * again whenever the library's revision moves. An unpaged backend has every
   * row in hand, so there it still counts them locally — which is the truth
   * there.
   */
  const [libCounts, setLibCounts] = useState<{ fav: number; gen: number; imp: number } | null>(null);
  useEffect(() => {
    if (!libPaged) {
      setLibCounts(null);
      return;
    }
    let live = true;
    const base = useLibraryStore.getState().getQuery();
    // Every filter cleared, provider included: these three numbers count the
    // whole library of this kind, so a provider left in would have printed
    // "12 imports" for a library holding thousands.
    const plain = plainLibraryQuery(base);
    void Promise.all([
      fetchLibraryMatchCount({ ...plain, favorite: true }),
      fetchLibraryMatchCount({ ...plain, source: 'generate' }),
      fetchLibraryMatchCount({ ...plain, source: 'import' }),
    ])
      .then(([fav, gen, imp]) => {
        if (!live || fav == null || gen == null || imp == null) return;
        setLibCounts({ fav, gen, imp });
      })
      .catch(() => { /* a count that did not arrive simply is not shown */ });
    return () => { live = false; };
  }, [libPaged, libRevision]);

  const favCount = libCounts ? libCounts.fav : entries.filter((e) => e.favorite).length;
  const genCount = libCounts ? libCounts.gen : entries.filter((e) => e.source === 'generate').length;
  const impCount = libCounts ? libCounts.imp : entries.filter((e) => e.source === 'import').length;

  // Online Download — same backend as the Media tab (/api/ytimport/fetch),
  // routed straight into the library so the imported track appears below.
  const [dlOpen, setDlOpen] = useState(false);
  const [dlUrl, setDlUrl] = useState('');
  const [dlBusy, setDlBusy] = useState(false);
  const [dlErr, setDlErr] = useState<string | null>(null);
  const runImport = async () => {
    const u = dlUrl.trim();
    if (!u || dlBusy) return;
    setDlBusy(true); setDlErr(null);
    try {
      await importUrlToLibrary(u);
      setDlUrl(''); setDlOpen(false);
      setSource({ kind: 'library' });
    } catch (e) {
      setDlErr(e instanceof Error ? e.message : 'Import failed');
    } finally { setDlBusy(false); }
  };

  // `soon` (a disabled "coming soon" state) is never passed by any caller
  // below — every source is actually available — so keeping the branch would
  // claim a feature-gate that doesn't exist. Removed rather than left dead
  // (FE-032-adjacent: this repo doesn't ship unreachable disabled-state code).
  const Item: React.FC<{ active?: boolean; onClick?: () => void; children: React.ReactNode; right?: React.ReactNode; title?: string }> = ({ active, onClick, children, right, title }) => (
    <button type="button" onClick={onClick} title={title}
      className={`w-full flex items-center gap-1.5 pl-4 pr-1.5 py-0.5 text-xs font-semibold tabular-nums rounded transition-colors ${active ? 'bg-purple-500/15 text-purple-200' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}>
      <span className={`w-1 h-1 rounded-full shrink-0 ${active ? 'bg-purple-300' : 'bg-zinc-700'}`} />
      <span className="flex-1 truncate text-left">{children}</span>
      {right}
    </button>
  );
  const Group: React.FC<{ icon?: React.ReactNode; label: string; right?: React.ReactNode }> = ({ icon, label, right }) => (
    <div className="flex items-center gap-1 px-1 mt-1.5 mb-0.5 text-xs font-black uppercase tracking-widest text-zinc-500">
      <ChevronRight className="w-2.5 h-2.5" />{icon}{label}{right}
    </div>
  );

  return (
    <div className="hardware-card h-full w-full flex flex-col min-h-0 overflow-hidden">
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-white/5">
        <LibraryIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />
        <span className="text-xs font-black uppercase tracking-wider text-purple-300 leading-tight">Source Tree</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain py-1">
        <Group label="Library" />
        <Item active={source.kind === 'library'} onClick={() => setSource({ kind: 'library' })} right={<span className="text-xs font-semibold text-zinc-600">{libCount}</span>} title="All of your generated + imported audio">Library</Item>
        <Item active={source.kind === 'favorites'} onClick={() => setSource({ kind: 'favorites' })} right={<span className="text-xs font-semibold text-zinc-600">{favCount}</span>} title="Tracks you've starred">Favorites</Item>
        <Item active={source.kind === 'gen'} onClick={() => setSource({ kind: 'gen' })} right={<span className="text-xs font-semibold text-zinc-600">{genCount}</span>} title="Tracks made in MAKE / MIX">Generated</Item>
        <Item active={source.kind === 'import'} onClick={() => setSource({ kind: 'import' })} right={<span className="text-xs font-semibold text-zinc-600">{impCount}</span>} title="Tracks imported from disk or online">Imports</Item>

        <Group label="Online Music" />
        <Item active={dlOpen} onClick={() => setDlOpen((v) => !v)} title="Download a track from a YouTube / SoundCloud / Bandcamp URL straight into your library">
          <span className="inline-flex items-center gap-1.5"><Download className="w-3 h-3" /> Online Download</span>
        </Item>
        {dlOpen && (
          <div className="px-2 py-1 flex flex-col gap-1">
            <div className="flex items-center gap-1 bg-black/40 border border-white/10 rounded px-1.5">
              <Link2 className="w-3 h-3 text-zinc-600 shrink-0" />
              <label htmlFor="dj-online-download-url" className="sr-only">Online import URL</label>
              <input id="dj-online-download-url" name="dj-online-download-url" value={dlUrl} onChange={(e) => setDlUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void runImport(); }}
                placeholder="paste URL…" disabled={dlBusy}
                className="flex-1 min-w-0 bg-transparent text-xs font-mono text-zinc-200 py-1 focus:outline-none placeholder:text-zinc-600 disabled:opacity-50" />
              <button onClick={() => void runImport()} disabled={dlBusy || !dlUrl.trim()} className="shrink-0 text-purple-300 hover:text-purple-100 disabled:opacity-30" title="Download into library">
                {dlBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
              </button>
            </div>
            {dlErr && <span className="text-xs font-semibold tabular-nums text-rose-400 px-1 truncate" title={dlErr}>{dlErr}</span>}
            <span className="text-xs font-semibold tabular-nums text-zinc-600 px-1 leading-tight">YouTube · SoundCloud · Bandcamp — Spotify is DRM-locked</span>
          </div>
        )}

        <Group label="Sets" right={<button onClick={() => { const id = createSetlist(`Set ${new Date().toLocaleDateString()}`); setActive(id); setSource({ kind: 'set', id }); }} className="ml-auto p-0.5 text-purple-300 hover:text-purple-100" title="New set"><Plus className="w-3 h-3" /></button>} />
        {sets.length === 0 ? (
          <div className="pl-4 pr-1.5 py-0.5 text-xs font-semibold tabular-nums text-zinc-700 leading-tight">
            No sets yet — click + above, then drag tracks in and press START AUTO DJ.
          </div>
        ) : sets.map((s) => {
          // Highlighted by `activeId`, NOT by the browser's `source` (DJ-3):
          // a Send-to-DJ makes a set active without touching the source, so
          // the tree used to point at one list while automix played another.
          const isActive = activeSetId === s.id;
          // Auto-DJ needs >=2 real entries. A bundled set nobody has opened
          // lists with `entryId: null` on every track -- GET /setlists is
          // read-only, and the entries are created when the set is opened --
          // so those count here too, or a fresh set could never be Auto-DJ'd
          // without being clicked first. Only tracks that CAN be registered
          // count: an ad-hoc/VJ row (a `url`, or a non-audio slot) has no
          // entry waiting for it and never will.
          const playable =
            djPlayableCount({ bundled: isBundledSetId(s.id), entries: s.entries }) >= AUTO_DJ_MIN_TRACKS;
          return (
            <DjSetRow
              key={s.id}
              name={s.name}
              count={s.entries.length}
              isActive={isActive}
              playable={playable}
              busy={registeringId === s.id}
              onOpen={() => { void openSet(s.id, s.name, false); }}
              onPlay={() => { void openSet(s.id, s.name, true); }}
            />
          );
        })}
      </div>
    </div>
  );
};

/* ═══════════════════════════════ DjMidiMap (D6) ═════════════════════════════ */

const DJ_MIDI_GROUPS = ['Mixer', 'Deck A', 'Deck B'];

/** Learn overlay: arm an action, move a control on your MIDI gear, it binds.
 *  Binding + dispatch run in DJView's one midiBus subscriber. */
const DjMidiMap: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const bindings = useDjControlMap((s) => s.bindings);
  const learnAction = useDjControlMap((s) => s.learnAction);
  const arm = useDjControlMap((s) => s.arm);
  const clear = useDjControlMap((s) => s.clear);
  const clearAll = useDjControlMap((s) => s.clearAll);
  const replaceAll = useDjControlMap((s) => s.replaceAll);
  const midiInputs = useMidiDevicesStore((s) => s.inputs);
  const ignoredControls = useMidiIgnoreStore((s) => s.controls);
  const ignoreControl = useMidiIgnoreStore((s) => s.ignoreControl);
  const ignoreChannel = useMidiIgnoreStore((s) => s.ignoreChannel);
  const removeIgnoredControl = useMidiIgnoreStore((s) => s.removeIgnoredControl);
  const clearIgnoredControls = useMidiIgnoreStore((s) => s.clearIgnoredControls);
  const detectedPreset = useMemo(() => {
    const names = midiInputs.map((n) => n.toLowerCase());
    return DJ_MIDI_PRESETS.find((p) => p.match.some((m) => names.some((n) => n.includes(m)))) ?? null;
  }, [midiInputs]);
  const [selectedPresetId, setSelectedPresetId] = useState(() => detectedPreset?.id ?? DJ_MIDI_PRESETS[0]?.id ?? '');
  const [lastSeen, setLastSeen] = useState<MidiSig | null>(null);
  const selectedPreset = DJ_MIDI_PRESETS.find((p) => p.id === selectedPresetId) ?? null;

  useEffect(() => {
    enableMidi();
  }, []);

  useEffect(() => {
    if (detectedPreset) setSelectedPresetId(detectedPreset.id);
  }, [detectedPreset]);

  useEffect(() => subscribeToMidi((msg) => {
    const [rawStatus, data1] = msg.data;
    if (typeof rawStatus !== 'number' || typeof data1 !== 'number') return;
    const status = rawStatus & 0xf0;
    const channel = rawStatus & 0x0f;
    if (status === 0xb0) setLastSeen({ kind: 'cc', number: data1, channel });
    else if (status === 0x90 || status === 0x80) setLastSeen({ kind: 'note', number: data1, channel });
  }), []);

  const applyPreset = () => {
    if (!selectedPreset) return;
    replaceAll(selectedPreset.bindings);
  };

  return (
    <div className="fixed inset-0 z-200 grid place-items-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-115 max-h-[82%] overflow-y-auto rounded-lg border border-purple-500/30 bg-[#0c0a14] shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-white/5 sticky top-0 bg-[#0c0a14]">
          <Piano className="w-3.5 h-3.5 text-purple-300 shrink-0" />
          <span className="text-xs font-black uppercase tracking-widest text-purple-300 shrink-0">DJ MIDI Map</span>
          <span className="text-xs font-semibold tabular-nums text-zinc-500 truncate">Click Learn, then move a control</span>
          <button onClick={clearAll} className="ml-auto shrink-0 text-xs font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border border-white/10 text-zinc-400 hover:text-rose-300">Clear all</button>
          <button onClick={onClose} className="shrink-0 p-1 text-zinc-500 hover:text-white rounded hover:bg-white/5"><X className="w-3.5 h-3.5" /></button>
        </div>
        <div className="p-3 flex flex-col gap-2">
          <div className="rounded border border-white/8 bg-black/30 p-2 flex flex-col gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Plug className={`w-3.5 h-3.5 shrink-0 ${midiInputs.length ? 'text-emerald-300' : 'text-zinc-600'}`} />
              <span className="flex-1 min-w-0 text-xs font-semibold tabular-nums text-zinc-500 truncate">
                {midiInputs.length ? midiInputs.join(', ') : 'Waiting for a MIDI input'}
              </span>
              {lastSeen && (
                <>
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-emerald-300">
                    {sigLabel(lastSeen)}
                  </span>
                  <button
                    type="button"
                    onClick={() => ignoreControl({ kind: lastSeen.kind, number: lastSeen.number, channel: lastSeen.channel ?? 0 })}
                    className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-rose-500/30 bg-rose-500/10 text-xs font-black uppercase tracking-wider text-rose-200 hover:bg-rose-500/20"
                    title={`Ignore ${sigLabel(lastSeen)}`}
                  >
                    <Ban className="w-2.5 h-2.5" /> Ignore
                  </button>
                  <button
                    type="button"
                    onClick={() => ignoreControl({ kind: lastSeen.kind, number: lastSeen.number, channel: lastSeen.channel ?? 0 }, { anyChannel: true })}
                    className="shrink-0 px-1.5 py-0.5 rounded border border-rose-500/20 bg-rose-500/5 text-xs font-black uppercase tracking-wider text-rose-200 hover:bg-rose-500/15"
                    title={`Ignore ${lastSeen.kind.toUpperCase()} ${lastSeen.number} on any MIDI channel`}
                  >
                    Any ch
                  </button>
                  {lastSeen.channel !== null && (
                    <button
                      type="button"
                      onClick={() => { if (lastSeen.channel !== null) ignoreChannel(lastSeen.kind, lastSeen.channel); }}
                      className="shrink-0 px-1.5 py-0.5 rounded border border-rose-500/20 bg-rose-500/5 text-xs font-black uppercase tracking-wider text-rose-200 hover:bg-rose-500/15"
                      title={`Ignore all ${lastSeen.kind.toUpperCase()} messages on channel ${lastSeen.channel + 1}`}
                    >
                      Ch
                    </button>
                  )}
                </>
              )}
            </div>
            {ignoredControls.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {ignoredControls.map((control) => (
                  <button
                    key={control.id}
                    type="button"
                    onClick={() => removeIgnoredControl(control.id)}
                    className="inline-flex items-center gap-1 rounded border border-rose-500/25 bg-rose-500/10 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wider text-rose-200 hover:bg-rose-500/20"
                    title="Stop ignoring this MIDI control"
                  >
                    <Ban className="w-2.5 h-2.5" />
                    {midiIgnoreLabel(control)}
                    <X className="w-2.5 h-2.5" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={clearIgnoredControls}
                  className="inline-flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-xs font-bold uppercase tracking-wider text-zinc-500 hover:text-zinc-200 hover:bg-white/5"
                  title="Clear all ignored MIDI controls"
                >
                  Clear
                </button>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <label htmlFor="dj-midi-preset" className="sr-only">MIDI preset</label>
              <select
                id="dj-midi-preset"
                value={selectedPresetId}
                onChange={(e) => setSelectedPresetId(e.target.value)}
                className="min-w-0 flex-1 bg-black/50 border border-white/10 rounded px-2 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-purple-400"
              >
                {DJ_MIDI_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
              <button
                onClick={applyPreset}
                disabled={!selectedPreset}
                className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border border-purple-500/30 bg-purple-500/10 text-xs font-black uppercase tracking-wider text-purple-200 hover:bg-purple-500/20 disabled:opacity-40"
                title="Load the selected preset mappings"
              >
                <Wand2 className="w-3 h-3" /> Apply
              </button>
            </div>
          </div>
          {DJ_MIDI_GROUPS.map((g) => (
            <div key={g}>
              <div className="text-xs font-black uppercase tracking-widest text-zinc-500 mb-1">{g}</div>
              <div className="grid grid-cols-2 gap-1">
                {MIDI_ACTIONS.filter((a) => a.group === g).map((a) => {
                  const sig = bindings[a.id];
                  const learning = learnAction === a.id;
                  return (
                    <div key={a.id} className={`flex items-center gap-1 px-1.5 py-1 rounded border ${learning ? 'border-amber-400/60 bg-amber-500/10' : 'border-white/8 bg-black/30'}`}>
                      <span className="flex-1 min-w-0 text-xs font-semibold tabular-nums text-zinc-300 truncate" title={a.label}>{a.label}</span>
                      <span className={`text-xs font-semibold tabular-nums shrink-0 ${sig ? 'text-emerald-300' : 'text-zinc-600'}`}>{sigLabel(sig)}</span>
                      <button onClick={() => arm(learning ? null : a.id)} className={`shrink-0 text-xs font-bold uppercase px-1 py-0.5 rounded border ${learning ? 'border-amber-400 text-amber-300 animate-pulse' : 'border-white/10 text-zinc-400 hover:text-zinc-100'}`}>{learning ? '…' : 'Learn'}</button>
                      {sig && <button onClick={() => clear(a.id)} className="shrink-0 text-zinc-600 hover:text-rose-400" title="Clear binding"><X className="w-2.5 h-2.5" /></button>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------- helpers ----------------------------------- */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));

function snapToBeat(t: number, beats: number[] | null): number {
  if (!beats || beats.length === 0) return t;
  let best = beats[0];
  for (const b of beats) { if (b <= t) best = b; else break; }
  return best;
}

function nearestBeat(t: number, beats: number[] | null): number {
  if (!beats || beats.length === 0) return t;
  let best = beats[0];
  let bestD = Math.abs(t - best);
  for (const b of beats) { const d = Math.abs(t - b); if (d < bestD) { best = b; bestD = d; } if (b > t && d > bestD) break; }
  return best;
}

function beatPhase(t: number, beats: number[] | null): number {
  if (!beats || beats.length < 2) return 0;
  let i = 0;
  while (i < beats.length - 1 && beats[i + 1] <= t) i++;
  const prev = beats[i];
  const next = beats[i + 1] ?? prev + (beats[i] - (beats[i - 1] ?? prev - 0.5));
  const interval = next - prev || 0.5;
  return clamp01((t - prev) / interval);
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function sameLoop(a: { in: number; out: number } | null, b: { in: number; out: number } | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.in === b.in && a.out === b.out;
}

const DeckWaveform: React.FC<{
  deckId: djEngine.DeckId;
  audioUrl: string;
  beats: number[] | null;
  /** Real bar starts from the rhythm module; null falls back to every 4th beat. */
  downbeats?: number[] | null;
  cues: (number | null)[] | null;
  accent: 'purple' | 'cyan';
  height?: number;
  mode?: 'overview' | 'detail';
}> = ({ deckId, audioUrl, beats, downbeats = null, cues, accent, height = 48, mode = 'overview' }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [dur, setDur] = useState(0);
  const [loop, setLoop] = useState<{ in: number; out: number } | null>(null);
  const [zoom, setZoom] = useState(mode === 'detail' ? 8 : 1);
  const [viewStart, setViewStart] = useState(0);
  const visibleFrac = 1 / zoom;
  const viewEnd = viewStart + visibleFrac;
  const viewMin = mode === 'detail' ? -visibleFrac / 2 : 0;
  const viewMax = mode === 'detail' ? 1 - visibleFrac / 2 : Math.max(0, 1 - visibleFrac);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const viewStartRef = useRef(viewStart);
  const visibleFracRef = useRef(visibleFrac);
  viewStartRef.current = viewStart;
  visibleFracRef.current = visibleFrac;

  useEffect(() => djEngine.subscribe((sa, sb) => {
    const st = deckId === 'A' ? sa : sb;
    const d = st.duration || 0;
    setDur((p) => (p === d ? p : d));
    const currentNorm = d > 0 ? clamp01(st.currentTime / d) : 0;
    if (modeRef.current === 'detail') {
      const vf = visibleFracRef.current;
      const nextStart = clamp(currentNorm - vf / 2, -vf / 2, 1 - vf / 2);
      if (Math.abs(nextStart - viewStartRef.current) > 0.0008) setViewStart(nextStart);
      if (playheadRef.current) {
        playheadRef.current.style.left = '50%';
        playheadRef.current.style.opacity = '0';
      }
    } else if (playheadRef.current) {
      const vs = viewStartRef.current;
      const vf = visibleFracRef.current;
      const pos = vf > 0 ? (currentNorm - vs) / vf : 0;
      playheadRef.current.style.left = `${clamp01(pos) * 100}%`;
      playheadRef.current.style.opacity = pos >= 0 && pos <= 1 ? '1' : '0';
    }
    const nl = st.loopActive && st.loopIn != null && st.loopOut != null ? { in: st.loopIn, out: st.loopOut } : null;
    setLoop((p) => (sameLoop(p, nl) ? p : nl));
  }), [deckId]);

  useEffect(() => {
    const nextZoom = mode === 'detail' ? 8 : 1;
    setZoom(nextZoom);
    setViewStart(mode === 'detail' ? -(1 / nextZoom) / 2 : 0);
  }, [audioUrl, mode]);

  // DJ-3: the lane's real width decides how many ticks fit — the old fixed
  // 400-beat cutoff dropped every off-beat on a long track no matter how wide
  // the lane was or how far in the user had zoomed. Measured, not guessed.
  const [laneWidth, setLaneWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      setLaneWidth((p) => (p === w ? p : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const beatMarks = useMemo(
    () => beatMarkPositions({ beats, downbeats, dur, viewStart, viewEnd, visibleFrac, widthPx: laneWidth }),
    [beats, downbeats, dur, viewEnd, viewStart, visibleFrac, laneWidth],
  );

  const loopView = useMemo(() => {
    if (!loop || dur <= 0) return null;
    const start = Math.max(loop.in / dur, viewStart);
    const end = Math.min(loop.out / dur, viewEnd);
    if (end <= start) return null;
    return { left: ((start - viewStart) / visibleFrac) * 100, width: ((end - start) / visibleFrac) * 100 };
  }, [dur, loop, viewEnd, viewStart, visibleFrac]);

  const accentColor = accent === 'purple' ? '#a855f7' : '#22d3ee';
  const scrubbing = useRef(false);
  const pendingX = useRef<number | null>(null);
  const scrubRaf = useRef(0);
  const seekToClientX = (clientX: number) => {
    const el = containerRef.current; if (!el) return;
    const d = djEngine.getStatus(deckId).duration; if (d <= 0) return;
    const rect = el.getBoundingClientRect();
    djEngine.seekDeck(deckId, clamp01(viewStart + clamp01((clientX - rect.left) / rect.width) * visibleFrac) * d);
  };
  const onWheelZoom = (e: React.WheelEvent) => {
    const el = containerRef.current; if (!el || dur <= 0) return;
    e.preventDefault();
    const minZoom = mode === 'detail' ? 2 : 1;
    const maxZoom = mode === 'detail' ? 36 : 24;
    const rect = el.getBoundingClientRect();
    const pointer = clamp01((e.clientX - rect.left) / rect.width);
    const panIntent = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (panIntent && zoom > 1) {
      const delta = (e.deltaX || e.deltaY) / Math.max(160, rect.width);
      setViewStart((s) => clamp(s + delta * visibleFrac, viewMin, viewMax));
      return;
    }
    const nextZoom = clamp(zoom * Math.exp(-e.deltaY * 0.002), 1, maxZoom);
    const snappedZoom = nextZoom < minZoom + 0.04 ? minZoom : Math.max(minZoom, nextZoom);
    const underPointer = viewStart + pointer * visibleFrac;
    const nextVisible = 1 / snappedZoom;
    const nextMin = mode === 'detail' ? -nextVisible / 2 : 0;
    const nextMax = mode === 'detail' ? 1 - nextVisible / 2 : Math.max(0, 1 - nextVisible);
    setZoom(snappedZoom);
    setViewStart(clamp(underPointer - pointer * nextVisible, nextMin, nextMax));
  };
  const applyScrub = () => { scrubRaf.current = 0; const x = pendingX.current; pendingX.current = null; if (x != null) seekToClientX(x); };
  const queueScrub = (clientX: number) => { pendingX.current = clientX; if (!scrubRaf.current) scrubRaf.current = requestAnimationFrame(applyScrub); };
  const onScrubDown = (e: React.PointerEvent) => { if (djEngine.getStatus(deckId).duration <= 0) return; scrubbing.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); seekToClientX(e.clientX); };
  const onScrubMove = (e: React.PointerEvent) => { if (scrubbing.current) queueScrub(e.clientX); };
  const onScrubUp = (e: React.PointerEvent) => { scrubbing.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId); };
  useEffect(() => () => { if (scrubRaf.current) cancelAnimationFrame(scrubRaf.current); }, []);
  const waveformMode = useWaveformStyleStore((s) => s.mode);

  return (
    <div ref={containerRef} className="relative h-full" style={{ minHeight: height }} onWheel={onWheelZoom}>
      <DJSemanticWaveform audioUrl={audioUrl} height={height} viewportStart={viewStart} viewportEnd={viewEnd} mode={waveformMode} />
      <div className="absolute inset-0 z-10 cursor-ew-resize touch-none" onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={onScrubUp} title="Scroll to zoom · Shift-scroll to pan · drag to scrub" />
      {beatMarks && (<div className="absolute inset-0 z-20 pointer-events-none">{beatMarks.map((m, i) => (<div key={i} className="absolute top-0 bottom-0" style={{ left: `${m.left}%`, width: '1px', background: m.down ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.10)' }} />))}</div>)}
      {loopView && (<div className="absolute top-0 bottom-0 z-20 pointer-events-none" style={{ left: `${loopView.left}%`, width: `${loopView.width}%`, background: 'rgba(245,200,66,0.18)', borderLeft: '1px solid rgba(245,200,66,0.7)', borderRight: '1px solid rgba(245,200,66,0.7)' }} />)}
      {dur > 0 && cues && cues.map((c, i) => {
        if (c == null) return null;
        const pos = c / dur;
        if (pos < viewStart || pos > viewEnd) return null;
        return (<div key={i} className="absolute top-0 bottom-0 z-20 pointer-events-none" style={{ left: `${((pos - viewStart) / visibleFrac) * 100}%`, width: '2px', background: accentColor }}><span className="absolute top-0 left-0 text-xs font-black text-black px-0.5 leading-tight" style={{ background: accentColor }}>{i + 1}</span></div>);
      })}
      {zoom > 1.04 && <div className="absolute bottom-1 right-1 z-30 rounded bg-black/70 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-white/70 pointer-events-none">{zoom.toFixed(2)}x</div>}
      <div ref={playheadRef} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: '0%', width: '2px', background: '#ffffff', boxShadow: '0 0 4px rgba(255,255,255,0.8)' }} />
    </div>
  );
};

/* ═══════════════════════════ control-surface registry ═══════════════════════
 * Every relocatable DJ control as a WidgetDef. Built each render (inside DJView)
 * so each `render` closure carries live state + wiring; relocating a widget only
 * changes where it draws, never what it calls. Pinned composites (hero, sampler,
 * FX racks, Next lane, source tree, library) host a whole component and stay out
 * of the palette; the source/library are never decomposed (per the design). */
interface DjRegArgs {
  ctlA: DeckCtl; ctlB: DeckCtl;
  deckATitle: string | null; deckBTitle: string | null;
  camA: ReturnType<typeof toCamelot> | null; camB: ReturnType<typeof toCamelot> | null; harmonic: boolean | null;
  hasA: boolean; hasB: boolean;
  playingA: boolean; playingB: boolean;
  cueA: boolean; cueB: boolean;
  syncLock: djEngine.DeckId | null; canSync: boolean;
  onPlayA: () => void; onPlayB: () => void;
  onCueA: () => void; onCueB: () => void;
  onStop: (d: djEngine.DeckId) => void; onEject: (d: djEngine.DeckId) => void;
  onSync: (d: djEngine.DeckId) => void; onSyncLock: (d: djEngine.DeckId) => void; onHeadCue: (d: djEngine.DeckId) => void;
  onSendVj: (d: 'A' | 'B') => void; onAddSet: (d: 'A' | 'B') => void;
  deckAUrl: string | null; deckBUrl: string | null;
  deckATrack: string | null; deckBTrack: string | null;
  setDeckATrack: (id: string) => void; setDeckBTrack: (id: string) => void;
  source: Source; setSource: (s: Source) => void; libCount: number; loadDeck: (entryId: string, deck: djEngine.DeckId) => void;
  loadDropOntoDeck: (event: React.DragEvent, deck: djEngine.DeckId) => Promise<boolean>;
  gainA: number; gainB: number;
  eqA: { low: number; mid: number; high: number }; eqB: { low: number; mid: number; high: number };
  filterA: number; filterB: number; volA: number; volB: number;
  stemKnobModeA: boolean; stemKnobModeB: boolean;
  setStemKnobModeA: (v: boolean) => void; setStemKnobModeB: (v: boolean) => void;
  pitchA: number; pitchB: number; bpmA: number | null; bpmB: number | null;
  pitchRange: PitchRange; setPitchRange: (range: PitchRange) => void;
  onGain: (which: djEngine.DeckId, v: number) => void;
  onEq: (which: djEngine.DeckId, band: 'low' | 'mid' | 'high', v: number) => void;
  onFilter: (which: djEngine.DeckId, v: number) => void; onVol: (which: djEngine.DeckId, v: number) => void;
  onPitch: (which: djEngine.DeckId, v: number) => void;
  onTargetBpm: (which: djEngine.DeckId, bpm: number) => void;
  crossfader: number; onCrossfade: (v: number) => void;
  quantize: boolean; setQuantize: (v: boolean) => void; autoGain: boolean; setAutoGain: (v: boolean) => void;
  vinylSpinA: boolean; setVinylSpinA: (v: boolean) => void;
  vinylSpinB: boolean; setVinylSpinB: (v: boolean) => void;
  limiterOn: boolean; setLimiterOn: (v: boolean) => void;
  cueSupported: boolean;
  midiMapOn: boolean; onToggleMidiMap: () => void;
  automixOn: boolean; onToggleAutomix: () => void;
}

const PAD_SM = 'px-1.5 py-1 min-w-0';
// min-w, not w: a 12px label that needs more room widens its pad by that much.
const PAD_HC = 'min-w-8 px-1 py-1';
const PAD_BT = 'min-w-7 px-1 py-1';

function buildDjRegistry(p: DjRegArgs): WidgetRegistry {
  const reg: WidgetRegistry = {};
  type SizeOpts = { match?: boolean; flow?: 'row' | 'column' } | undefined;
  // Control sizing: grow to fill the cell. When `match` is on, size to the
  // SHARED cross-axis (row → cell height, column → cell width) so same-kind
  // controls line up (equal height across a row / width down a column), clamped
  // so a narrow cell never overflows.
  const fitDim = (s: { w: number; h: number }, opts: SizeOpts, labelH: number, cap: number) => {
    const byH = s.h - labelH;
    const byW = s.w - 6;
    const base = opts?.match
      ? opts.flow === 'row'
        ? byH
        : opts.flow === 'column'
          ? byW
          : Math.min(byW, byH)
      : Math.min(byW, byH);
    return Math.min(base, byW, byH, cap);
  };
  const knobSize = (s: { w: number; h: number }, opts?: SizeOpts) => Math.max(20, fitDim(s, opts, 26, 112));
  const toggleBox = (s: { w: number; h: number }, opts?: SizeOpts) => Math.max(24, fitDim(s, opts, 12, 84));
  // grid-cols-1 (= repeat(1,minmax(0,1fr))): the single track is the cell width,
  // so a child sized w-full (e.g. the AUTOMIX button, which truncates its label)
  // really is the cell width instead of the label's max-content overflowing it.
  const center = (node: React.ReactNode) => <div className="h-full w-full grid grid-cols-1 place-items-center overflow-hidden">{node}</div>;
  // Pads render LANDSCAPE (like CUE/PLAY): fill the cell width, cap the height so
  // the button stays wider than tall, centred vertically in its cell.
  const padBox = (s: { w: number; h: number }, node: React.ReactNode) => (
    <div className="h-full w-full grid place-items-center overflow-hidden">
      <div className="w-full grid" style={{ height: Math.max(22, Math.min(s.h, s.w * 0.6)) }}>{node}</div>
    </div>
  );
  const faderWrap = (node: React.ReactNode) => <div className="h-full w-full min-h-0 flex justify-center">{node}</div>;
  const pinned = (id: string, label: string, node: React.ReactNode) => {
    reg[id] = { id, label, group: 'Panels', kind: 'fixed', source: 'builtin', render: () => <div className="h-full w-full min-h-0 overflow-hidden">{node}</div> };
  };
  const knob = (
    id: string,
    label: string,
    group: string,
    value: number,
    onChange: (v: number) => void,
    min: number,
    max: number,
    step: number,
    extra?: { center?: boolean; onLabelClick?: () => void; onLabelDoubleClick?: () => void; labelTitle?: string; tint?: number },
  ) => {
    reg[id] = {
      id,
      label,
      group,
      kind: 'knob',
      source: 'builtin',
      render: (s, opts) => center(
        <SlideKnob
          label={label}
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          size={knobSize(s, opts)}
          center={extra?.center ?? true}
          centerReadout
          onLabelClick={extra?.onLabelClick}
          onLabelDoubleClick={extra?.onLabelDoubleClick}
          labelTitle={extra?.labelTitle}
          tint={extra?.tint}
        />,
      ),
    };
  };

  /* ── pinned composites ── */
  pinned('waveAOverview', 'Deck A Overview', (
    <WaveLane deckId="A" accent="purple" entryId={p.deckATrack} hasTrack={p.hasA} audioUrl={p.deckAUrl} ctl={p.ctlA} onLoadDrop={p.loadDropOntoDeck} mode="overview" compact />
  ));
  pinned('waveBOverview', 'Deck B Overview', (
    <WaveLane deckId="B" accent="cyan" entryId={p.deckBTrack} hasTrack={p.hasB} audioUrl={p.deckBUrl} ctl={p.ctlB} onLoadDrop={p.loadDropOntoDeck} mode="overview" compact />
  ));
  pinned('hero', 'Waveforms', (
    <div className="h-full w-full flex flex-col gap-1">
      {/* The decks draw in the app-wide waveform colour mode: its legend and
          its toggle sit here, above the lanes, where the colours are. */}
      <div className="shrink-0 flex items-center gap-2 min-w-0">
        <WaveformModeToggle variant="toolbar" className="shrink-0" />
        <WaveformModeLegend className="flex-1" />
      </div>
      <div className="relative flex-1 min-h-0 flex flex-col gap-1.5">
        <WaveLane deckId="A" accent="purple" entryId={p.deckATrack} hasTrack={p.hasA} audioUrl={p.deckAUrl} ctl={p.ctlA} onLoadDrop={p.loadDropOntoDeck} mode="detail" />
        <WaveLane deckId="B" accent="cyan" entryId={p.deckBTrack} hasTrack={p.hasB} audioUrl={p.deckBUrl} ctl={p.ctlB} onLoadDrop={p.loadDropOntoDeck} mode="detail" />
        <div className="absolute top-0 bottom-0 left-1/2 z-40 w-px -translate-x-1/2 pointer-events-none bg-white shadow-[0_0_7px_rgba(255,255,255,0.95)]">
          <div className="absolute -top-0.5 left-1/2 h-0 w-0 -translate-x-1/2 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent border-t-white" />
        </div>
      </div>
    </div>
  ));
  pinned('sampler', 'Sampler', <SamplerRail />);
  pinned('fxA', 'Onboard FX A', <OnboardFxPanel deck="A" accent="purple" entryId={p.deckATrack} ctl={p.ctlA} />);
  pinned('fxB', 'Onboard FX B', <OnboardFxPanel deck="B" accent="cyan" entryId={p.deckBTrack} ctl={p.ctlB} />);
  pinned('perfA', 'Performance Pads A', <CompactPerformancePads deck="A" accent="purple" entryId={p.deckATrack} ctl={p.ctlA} />);
  pinned('perfB', 'Performance Pads B', <CompactPerformancePads deck="B" accent="cyan" entryId={p.deckBTrack} ctl={p.ctlB} />);
  pinned('next', 'Next / Staging', <SideListLane onLoadDeck={p.loadDeck} />);
  pinned('sourceTree', 'Source Tree', <SourceTree source={p.source} setSource={p.setSource} libCount={p.libCount} />);
  pinned('library', 'Library', <TrackBrowser source={p.source} setSource={p.setSource} onLoadDeck={p.loadDeck} />);

  /* ── per-deck performance controls ── */
  const addDeck = (d: 'A' | 'B') => {
    const accent = d === 'A' ? 'purple' : 'cyan';
    const rgbc = DECK_RGB[accent];
    const ctl = d === 'A' ? p.ctlA : p.ctlB;
    const hasTrack = d === 'A' ? p.hasA : p.hasB;
    const isPlaying = d === 'A' ? p.playingA : p.playingB;
    const title = d === 'A' ? p.deckATitle : p.deckBTitle;
    const entryId = d === 'A' ? p.deckATrack : p.deckBTrack;
    const cam = d === 'A' ? p.camA : p.camB;
    const headCued = d === 'A' ? p.cueA : p.cueB;
    const pitch = d === 'A' ? p.pitchA : p.pitchB;
    const onPlay = d === 'A' ? p.onPlayA : p.onPlayB;
    const onCue = d === 'A' ? p.onCueA : p.onCueB;
    const vinylSpin = d === 'A' ? p.vinylSpinA : p.vinylSpinB;
    const setVinylSpin = d === 'A' ? p.setVinylSpinA : p.setVinylSpinB;
    const stopTitle = sortedCuePoints(ctl.cues).length > 0 ? 'Stop and jump to next hotcue' : 'Stop and return to start';
    const syncLocked = p.syncLock === d;
    const grp = `Deck ${d}`;

    reg[`header${d}`] = { id: `header${d}`, label: `Deck ${d} Info`, group: grp, kind: 'fixed', source: 'builtin', render: (_s, opts) => (
      <div className={`h-full w-full flex items-center gap-1.5 px-1 overflow-hidden ${opts?.mirror ? 'flex-row-reverse' : ''}`}>
        <div className="shrink-0 grid place-items-center rounded border w-7 h-7" style={{ borderColor: rgba(rgbc, 0.6), background: rgba(rgbc, 0.2) }} title={`Deck ${d}`}>
          <span className="text-[18px] font-black leading-none text-white" style={{ textShadow: `0 0 6px ${rgba(rgbc, 0.9)}, 0 1px 2px rgba(0,0,0,0.9)` }}>{d}</span>
        </div>
        <div className={`min-w-0 flex-1 flex flex-col ${opts?.mirror ? 'items-end text-right' : ''}`}>
          <span
            draggable={!!entryId}
            onDragStart={(ev) => {
              if (!entryId) return;
              ev.dataTransfer.effectAllowed = 'copy';
              ev.dataTransfer.setData(DJ_TRACK_MIME, entryId);
              ev.dataTransfer.setData('text/plain', title ?? `Deck ${d} track`);
            }}
            className={`text-xs font-bold text-zinc-200 truncate max-w-full leading-tight ${entryId ? 'cursor-grab active:cursor-grabbing hover:text-white' : ''}`}
            title={entryId ? `Drag "${title ?? 'this track'}" into a set or playlist` : ''}
          >
            {title ?? 'Empty deck'}
          </span>
          <DeckTimes deckId={d} mirror={opts?.mirror} />
        </div>
        <div className="shrink-0 flex flex-col gap-0.5">
          <button onClick={() => p.onSendVj(d)} disabled={!hasTrack} className="p-0.5 text-zinc-600 hover:text-cyan-300 disabled:opacity-30 disabled:pointer-events-none transition-colors" title="Send this deck's track to the VJ"><Cast className="w-3 h-3" /></button>
          <button onClick={() => p.onAddSet(d)} disabled={!hasTrack} className="p-0.5 text-zinc-600 hover:text-emerald-300 disabled:opacity-30 disabled:pointer-events-none transition-colors" title="Add this deck's track to the active set"><Save className="w-3 h-3" /></button>
        </div>
      </div>
    ) };

    reg[`bpm${d}`] = { id: `bpm${d}`, label: `BPM ${d}`, group: grp, kind: 'fixed', source: 'builtin', render: () => (
      <EditableBpmField
        deck={d}
        sourceBpm={ctl.bpm}
        pitchPct={pitch}
        analyzing={ctl.analyzing}
        color={rgbc}
        onCommit={(bpm) => p.onTargetBpm(d, bpm)}
      />
    ) };

    reg[`key${d}`] = { id: `key${d}`, label: `Key ${d}`, group: grp, kind: 'fixed', source: 'builtin', render: () => (
      <div className="h-full w-full grid place-items-center px-1 overflow-hidden">
        {cam ? (
          <div
            className="flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-md border"
            style={{
              borderColor: `hsl(${cam.hue} 70% 55% / 0.6)`,
              background: `linear-gradient(180deg, hsl(${cam.hue} 70% 50% / 0.22), hsl(${cam.hue} 70% 50% / 0.05))`,
              boxShadow: `0 0 12px hsl(${cam.hue} 80% 55% / 0.4)`,
            }}
            title={`Camelot ${cam.code} — mixes with ${cam.compatible.join(', ')}`}
          >
            <span className="grid place-items-center size-6 rounded-full text-xs font-black shrink-0" style={{ background: `hsl(${cam.hue} 85% 62%)`, color: '#0a0a0a', boxShadow: `0 0 6px hsl(${cam.hue} 85% 60% / 0.7)` }}>
              {cam.code.replace(/[AB]/i, '')}
            </span>
            <span className="text-[15px] font-black leading-none" style={{ color: `hsl(${cam.hue} 85% 70%)`, textShadow: `0 0 8px hsl(${cam.hue} 80% 55% / 0.55)` }}>{cam.code}</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-1.5 px-2.5 py-1 rounded-md border border-white/10 bg-black/40">
            <span className="text-xs font-black uppercase tracking-[0.22em] text-zinc-500">KEY</span>
            <span className="text-[13px] font-black leading-none text-zinc-300">{ctl.a?.key ? keyLabel(ctl.a.key, ctl.a.scale) : '—'}</span>
          </div>
        )}
      </div>
    ) };

    reg[`jog${d}`] = { id: `jog${d}`, label: `Jog ${d}`, group: grp, kind: 'jog', source: 'builtin', render: () => (
      <PlatterDropTarget deckId={d} color={rgbc} hasTrack={hasTrack} bpm={ctl.bpm ?? null} pitchPct={d === 'A' ? p.pitchA : p.pitchB} onLoadDrop={p.loadDropOntoDeck} />
    ) };
    reg[`stemBank${d}`] = { id: `stemBank${d}`, label: `Stem Pads ${d}`, group: grp, kind: 'fixed', source: 'builtin', render: (_s, opts) => (
      <StemPadBank deck={d} entryId={entryId} color={rgbc} ctl={ctl} mirror={opts?.mirror} />
    ) };

    // Each pad is its own relocatable widget (atomized transport / hotcues / loop / perf).
    const padW = (id: string, label: string, node: React.ReactElement) => {
      reg[id] = {
        id, label, group: grp, kind: 'pad', source: 'builtin',
        // Pads render LANDSCAPE filling the cell width. Forward the per-widget
        // shape (Design-Mode shape grip) into the pad.
        render: (s, opts) =>
          padBox(
            s,
            opts?.shape && opts.shape !== 'default'
              ? React.cloneElement(node as React.ReactElement<{ shape?: typeof opts.shape }>, { shape: opts.shape })
              : node,
          ),
      };
    };
    const StopSpinPad: React.FC<{ shape?: unknown }> = ({ shape: _shape }) => (
      <div className="h-full w-full grid grid-cols-[1fr_1.35rem] gap-0.5">
        <SlidePad color={rgbc} disabled={!hasTrack} onClick={() => p.onStop(d)} className="px-2 py-1 min-w-0" title={stopTitle}>
          <Square className="w-3 h-3 fill-current" />
        </SlidePad>
        <SlidePad
          color={rgbc}
          on={vinylSpin}
          disabled={!hasTrack}
          onClick={() => setVinylSpin(!vinylSpin)}
          className="px-1 py-1 min-w-0"
          title={vinylSpin ? 'Turntable spin-up/down on' : 'Turntable spin-up/down off'}
        >
          <Disc className="w-2.5 h-2.5" />
        </SlidePad>
      </div>
    );

    padW(`cue${d}`, `Cue ${d}`, <SlidePad color={rgbc} disabled={!hasTrack} onClick={onCue} className={PAD_SM} title="Cue to start">Cue</SlidePad>);
    padW(`play${d}`, `Play ${d}`, <SlidePad color={rgbc} disabled={!hasTrack} onClick={onPlay} className="px-3 py-1" title={isPlaying ? 'Pause' : 'Play'}>{isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}</SlidePad>);
    padW(`stop${d}`, `Stop ${d}`, <StopSpinPad />);
    padW(`eject${d}`, `Eject ${d}`, <SlidePad danger disabled={!hasTrack} onClick={() => p.onEject(d)} className={`px-2 py-1 ${hasTrack ? 'dj-eject-heartbeat' : ''}`} title="Eject this deck"><EjectSymbol className="w-3 h-3" /></SlidePad>);
    padW(`sync${d}`, `Sync ${d}`, <SlidePad color={rgbc} disabled={!p.canSync} onClick={() => p.onSync(d)} className={PAD_SM} title={p.canSync ? 'BPM Sync — when one deck is playing, match the stopped incoming deck to it' : 'SYNC needs BPM on both decks'}>Sync</SlidePad>);
    padW(`syncLock${d}`, `Sync-Lock ${d}`, <SlidePad color={rgbc} on={syncLocked} disabled={!p.canSync} onClick={() => p.onSyncLock(d)} className="px-1.5 py-1" title="Sync-Lock — hold tempo + phase"><Lock className="w-3 h-3" /></SlidePad>);
    padW(`headCue${d}`, `HP Cue ${d}`, <SlidePad color={[34, 211, 238]} on={headCued} disabled={!hasTrack} onClick={() => p.onHeadCue(d)} className="px-1.5 py-1" title="Cue — pre-listen in the headphone output"><Headphones className="w-3 h-3" /></SlidePad>);
    padW(`stemLoad${d}`, `Load Stems ${d}`, <StemLoadPad deck={d} entryId={entryId} color={rgbc} />);
    for (let i = 0; i < STEM_PAD_SLOTS; i++) {
      const name = ctl.stemNames[i] ?? null;
      const label = stemLabel(name ?? STEM_PAD_FALLBACKS[i] ?? `Stem ${i + 1}`);
      const level = name ? (ctl.stemLevels[name] ?? djEngine.getStemGain(d, name)) : 0;
      const on = !!name && level > 0.001;
      const color = STEM_PAD_COLORS[i] ?? rgbc;
      padW(`stem${d}${i}`, `${label} ${d}`, (
        <SlidePad
          color={color}
          on={on}
          disabled={!name}
          onClick={() => {
            if (!name) return;
            const current = djEngine.getStemGain(d, name);
            djEngine.setStemGain(d, name, current > 0.001 ? 0 : 1);
          }}
          className="px-1 py-1 min-w-0"
          title={name ? `Deck ${d} ${name}: ${on ? 'click to mute' : 'click to restore'}` : 'Load stems first'}
        >
          <span className="truncate">{label}</span>
        </SlidePad>
      ));
    }

    for (let i = 0; i < HOTCUE_SLOTS; i++) {
      const c = ctl.cues?.[i] ?? null; const set = c != null;
      padW(`hc${d}${i + 1}`, `Hotcue ${d}${i + 1}`, <SlidePad on={set} color={rgbc} disabled={!hasTrack} className={PAD_HC} onClick={() => ctl.setHotcue(i)} onContextMenu={(e) => { e.preventDefault(); ctl.dropHotcue(i); }} title={set ? `Cue ${i + 1} @ ${fmtTime(c)} — click to jump, right-click to clear` : `Set cue ${i + 1} at the playhead`}>{set ? `▶${i + 1}` : `○${i + 1}`}</SlidePad>);
    }

    BEAT_SIZES.forEach((b, bi) => padW(`loop${d}_${bi}`, `Loop ${b.label} ${d}`, <SlidePad className={PAD_BT} on={ctl.loopActive && ctl.activeLoopBeats === b.beats} color={rgbc} disabled={!hasTrack} onClick={() => ctl.toggleBeatLoop(b.beats)} title={`${b.label}-beat loop`}>{b.label}</SlidePad>));
    padW(`loopOut${d}`, `Loop Out ${d}`, <SlidePad className={PAD_BT} danger disabled={!ctl.loopActive} onClick={ctl.exitLoop} title="Exit loop">Out</SlidePad>);

    ROLL_SIZES.forEach((b, ri) => padW(`roll${d}_${ri}`, `Roll ${b.label} ${d}`, <SlidePad className={PAD_BT} color={rgbc} disabled={!hasTrack} onPointerDown={(e) => { e.preventDefault(); ctl.rollDown(b.beats); }} onPointerUp={ctl.rollUp} onPointerLeave={(e) => { if (e.buttons) ctl.rollUp(); }} title={`${b.label}-beat loop-roll (hold)`}>{b.label}</SlidePad>));
    padW(`slip${d}`, `Slip ${d}`, <SlidePad className={PAD_BT} on={ctl.slip} color={[245, 158, 11]} disabled={!hasTrack} onClick={() => ctl.setSlip(!ctl.slip)} title="Slip mode">Slip</SlidePad>);
    ([[-4, '«4'], [-1, '‹1'], [1, '1›'], [4, '4»']] as const).forEach(([n, lbl], ji) => padW(`jump${d}_${ji}`, `Jump ${lbl} ${d}`, <SlidePad className={PAD_BT} color={rgbc} disabled={!hasTrack} onClick={() => ctl.beatJump(n)} title={`Jump ${n > 0 ? '+' : ''}${n} beat${Math.abs(n) === 1 ? '' : 's'}`}>{lbl}</SlidePad>));
    padW(`keylock${d}`, `Keylock ${d}`, <SlidePad className="px-1.5 py-1" on={ctl.keylock} color={rgbc} disabled={!hasTrack} onClick={() => ctl.setKeylock(!ctl.keylock)} title="Key-lock / Master Tempo"><KeyRound className="w-3 h-3" /></SlidePad>);
  };
  addDeck('A');
  addDeck('B');

  /* ── per-deck mixer controls ── */
  const addMixerDeck = (d: 'A' | 'B') => {
    const grp = `Mixer ${d}`;
    const eq = d === 'A' ? p.eqA : p.eqB;
    const ctl = d === 'A' ? p.ctlA : p.ctlB;
    const stemKnobMode = d === 'A' ? p.stemKnobModeA : p.stemKnobModeB;
    const setStemKnobMode = d === 'A' ? p.setStemKnobModeA : p.setStemKnobModeB;
    const toggleStemKnobs = () => setStemKnobMode(!stemKnobMode);
    const modeTitle = stemKnobMode
      ? 'Click to return these knobs to deck EQ/filter'
      : 'Click to make these knobs control stem volumes';

    const eqKnob = (id: string, label: string, value: number, onChange: (v: number) => void, min: number, max: number, step: number) =>
      knob(id, label, grp, value, onChange, min, max, step, { onLabelClick: toggleStemKnobs, labelTitle: modeTitle });

    const stemVolKnob = (widgetId: string, fallback: string, aliases: readonly string[], tint: number) => {
      const name = findStemForSlot(ctl.stemNames, aliases);
      const label = name ? stemLabel(name) : fallback;
      const value = name ? (ctl.stemLevels[name] ?? djEngine.getStemGain(d, name)) : 0;
      knob(
        widgetId,
        label,
        grp,
        value,
        (v) => { if (name) djEngine.setStemGain(d, name, v); },
        0,
        1,
        0.01,
        { center: false, onLabelClick: toggleStemKnobs, labelTitle: modeTitle, tint },
      );
    };

    if (stemKnobMode) {
      for (const slot of STEM_MIXER_KNOB_SLOT_LIST) {
        const widgetId = slot.id === 'flt' ? `flt${d}` : `eq${d}.${slot.id}`;
        stemVolKnob(widgetId, slot.fallback, slot.aliases, slot.tint);
      }
    } else {
      eqKnob(`eq${d}.hi`, 'Hi', eq.high, (v) => p.onEq(d, 'high', v), -12, 12, 0.5);
      eqKnob(`eq${d}.mid`, 'Mid', eq.mid, (v) => p.onEq(d, 'mid', v), -12, 12, 0.5);
      eqKnob(`eq${d}.lo`, 'Lo', eq.low, (v) => p.onEq(d, 'low', v), -12, 12, 0.5);
      eqKnob(`flt${d}`, 'Flt', d === 'A' ? p.filterA : p.filterB, (v) => p.onFilter(d, v), -1, 1, 0.01);
    }
    knob(`gain${d}`, 'Gain', grp, d === 'A' ? p.gainA : p.gainB, (v) => p.onGain(d, v), -12, 12, 0.5);
    reg[`vol${d}`] = { id: `vol${d}`, label: `Vol ${d}`, group: grp, kind: 'fader', source: 'builtin', render: () => faderWrap(<SlideFader label={d} value={d === 'A' ? p.volA : p.volB} onChange={(v) => p.onVol(d, v)} min={0} max={1} step={0.01} rulerSide={d === 'B' ? 'right' : 'left'} />) };
    const pitch = d === 'A' ? p.pitchA : p.pitchB;
    const bpm = d === 'A' ? p.bpmA : p.bpmB;
    const effBpm = bpm != null ? (bpm * (1 + pitch / 100)).toFixed(1) : '—';
    reg[`pitch${d}`] = { id: `pitch${d}`, label: `Pitch ${d}`, group: grp, kind: 'fader', source: 'builtin', render: () => (
      <div className="h-full w-full min-h-0 flex flex-col items-center">
        <div className="flex-1 min-h-0 flex justify-center"><SlideFader label={`Pch ${d}`} value={pitch} onChange={(v) => p.onPitch(d, v)} min={-p.pitchRange} max={p.pitchRange} step={0.1} rulerSide={d === 'A' ? 'left' : 'right'} /></div>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-zinc-500" title="Effective BPM at this pitch">{effBpm}</span>
      </div>
    ) };
  };
  addMixerDeck('A');
  addMixerDeck('B');

  /* ── shared mixer controls ── */
  reg.pitchRange = { id: 'pitchRange', label: 'Pitch Range', group: 'Mixer', kind: 'button', source: 'builtin', render: () => center(
    <button
      type="button"
      onClick={() => p.setPitchRange(p.pitchRange === 10 ? 15 : 10)}
      title="Pitch range"
      className="flex flex-col items-center justify-center gap-0.5 min-w-12 px-2 py-1 rounded-md border border-amber-400/50 bg-amber-500/15 text-amber-100 shadow-[0_0_14px_rgba(245,158,11,0.25)] hover:bg-amber-500/25 transition-colors"
    >
      <span className="text-xs font-black uppercase tracking-wider leading-none">Range</span>
      <span className="text-[12px] font-black tabular-nums leading-none">±{p.pitchRange}%</span>
    </button>
  ) };
  reg.qtz = { id: 'qtz', label: 'Quantize', group: 'Mixer', kind: 'toggle', source: 'builtin', render: (s, opts) => center(<RoundToggle label="Qtz" icon={Magnet} on={p.quantize} onChange={p.setQuantize} box={toggleBox(s, opts)} />) };
  reg.autoGain = { id: 'autoGain', label: 'Auto-gain', group: 'Mixer', kind: 'toggle', source: 'builtin', render: (s, opts) => center(<RoundToggle label="Gain" icon={Gauge} on={p.autoGain} onChange={p.setAutoGain} box={toggleBox(s, opts)} />) };
  reg.lim = { id: 'lim', label: 'Limiter', group: 'Mixer', kind: 'toggle', source: 'builtin', render: (s, opts) => center(<RoundToggle label="Lim" icon={Shield} on={p.limiterOn} onChange={(v) => { p.setLimiterOn(v); djEngine.setLimiter(v); }} box={toggleBox(s, opts)} />) };
  reg.midiMap = { id: 'midiMap', label: 'MIDI Map', group: 'Mixer', kind: 'toggle', source: 'builtin', render: (s, opts) => center(<RoundToggle label="MIDI" icon={Piano} on={p.midiMapOn} onChange={() => p.onToggleMidiMap()} box={toggleBox(s, opts)} />) };

  reg.crossfader = { id: 'crossfader', label: 'Crossfader', group: 'Mixer', kind: 'crossfader', source: 'builtin', render: () => (
    <div className="h-full w-full flex flex-col justify-center px-1">
      <div className="flex items-center gap-1">
        <span className="text-xs font-black text-purple-300">A</span>
        <div className="flex-1"><SlideCrossfader value={p.crossfader} onChange={p.onCrossfade} ariaLabel="Crossfader" title="Crossfade A ↔ B (double-click to center)" /></div>
        <span className="text-xs font-black text-cyan-300">B</span>
      </div>
      <div className="text-center text-xs font-semibold text-zinc-600 tabular-nums leading-tight mt-0.5">{p.crossfader < -0.05 ? `A ${Math.round(-p.crossfader * 100)}%` : p.crossfader > 0.05 ? `B ${Math.round(p.crossfader * 100)}%` : 'CENTER'}</div>
    </div>
  ) };

  reg.automix = { id: 'automix', label: 'Automix', group: 'Mixer', kind: 'button', source: 'builtin', render: () => center(
    <button type="button" onClick={p.onToggleAutomix} aria-pressed={p.automixOn} title="Automix — auto-sequence + beatmatch-crossfade the active set" className={`w-full min-w-0 px-1 py-0.5 rounded font-sans text-xs font-black uppercase tracking-wider truncate border transition-colors ${p.automixOn ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200 animate-pulse' : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:border-white/25'}`}>{p.automixOn ? 'Automix ●' : 'Automix'}</button>
  ) };

  reg.keymatch = { id: 'keymatch', label: 'Key Match', group: 'Mixer', kind: 'button', source: 'builtin', render: () => center(
    p.camA && p.camB ? (
      <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-bold border ${p.harmonic ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`} title={p.harmonic ? `In key — ${p.camA.code} / ${p.camB.code}` : `Key clash — ${p.camA.code} vs ${p.camB.code}`}><Music2 className="w-2.5 h-2.5" />{p.harmonic ? 'In Key' : 'Clash'}</div>
    ) : <span className="text-xs font-semibold tabular-nums text-zinc-700">key</span>
  ) };

  reg.cueDevice = { id: 'cueDevice', label: 'Cue Output', group: 'Mixer', kind: 'button', source: 'builtin', render: () => (
    // grid-cols-1 is a minmax(0,1fr) track, so the picker narrows with a narrow cell.
    <div className="h-full w-full grid grid-cols-1 place-items-center px-1">
      {p.cueSupported ? (
        <div className="flex items-center gap-1 w-full">
          <Headphones className="w-2.5 h-2.5 text-zinc-500 shrink-0" />
          {/* Was the app's oldest device picker and had only a `title` — no id,
              no name, no <label>, no aria-label. Now the shared control. */}
          {/* A widget cell has no room for a status sentence: the picker keeps it as its description and tooltip. */}
          <IoGlobalSelect slot="cue_output" id="dj-cue-output" label="Headphone (cue) output" className="flex-1 max-w-none" dense quietStatus />
        </div>
      ) : <span className="font-sans font-bold text-xs text-zinc-500">cue n/a</span>}
    </div>
  ) };

  return reg;
}
