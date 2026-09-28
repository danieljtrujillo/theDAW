import { create } from 'zustand';
import {
  isBundledSetId,
  isPendingBundledRow,
  useSetlistStore,
  type SetlistEntry,
} from './setlistStore';
import { useAppUiStore } from './appUiStore';

/**
 * How a start request treats the decks.
 *
 * - `continue`: a deck that is already playing keeps playing and the set runs
 *   on from that track; with nothing playing, a loaded deck is started and an
 *   empty one gets track 1. What the Automix chip always did, and what START
 *   AUTO DJ and the assistant's `dj_automix` ask for.
 * - `fresh`: both decks are ejected and the set plays from track 1, even when
 *   automix is already running. For a caller that has just staged a different
 *   list (Send to DJ) or pressed one set's play button, where "play this set"
 *   means from the top.
 */
export type AutomixStartMode = 'continue' | 'fresh';

/**
 * djAutomix — the bridge from "Send to DJ" (suggester, or any track list) into
 * the DJ tab's automix. The DJ deck/automix machinery lives inside DJView as
 * local state, so a caller elsewhere cannot flip it on directly. Instead the
 * caller populates the active setlist + switches to the DJ tab, then trips this
 * one-shot `pendingStart` request; DJView watches it, consumes it, and turns
 * automix on. A plain value (not a persisted one) so it never re-fires on a
 * remount or reload.
 */
interface DjAutomixState {
  /** A start request for the DJ tab and how it treats the decks, or null. */
  pendingStart: AutomixStartMode | null;
  /** Set true to ask the DJ tab to stop automixing (assistant control). */
  pendingStop: boolean;
  /** Set true to ask the running automix to blend into the next track NOW
   *  instead of waiting for the prepared mix-out point. */
  pendingTransition: boolean;
  /** The setlist entryId automix is currently playing, published by DJView so
   *  outside callers (assistant actions) can reason about "what's on now". */
  nowPlayingEntryId: string | null;
  requestStart: (mode: AutomixStartMode) => void;
  consumeStart: () => void;
  requestStop: () => void;
  consumeStop: () => void;
  requestTransition: () => void;
  consumeTransition: () => void;
  setNowPlaying: (entryId: string | null) => void;
}

export const useDjAutomix = create<DjAutomixState>()((set) => ({
  pendingStart: null,
  pendingStop: false,
  pendingTransition: false,
  nowPlayingEntryId: null,
  requestStart: (mode) => set({ pendingStart: mode, pendingStop: false }),
  consumeStart: () => set({ pendingStart: null }),
  requestStop: () => set({ pendingStop: true, pendingStart: null }),
  consumeStop: () => set({ pendingStop: false }),
  requestTransition: () => set({ pendingTransition: true }),
  consumeTransition: () => set({ pendingTransition: false }),
  setNowPlaying: (entryId) => set({ nowPlayingEntryId: entryId }),
}));

/** Automix needs two tracks to have anything to mix between. */
export const AUTO_DJ_MIN_TRACKS = 2;

/** The rows the automix sequencer can actually put on a deck: a registered
 *  library id and nothing else. The one predicate behind the automix effect's
 *  `list.length < AUTO_DJ_MIN_TRACKS` bail-out, DJView's `djPlayableCount` and
 *  `readyActiveSetForAutomix` below, so none of them can drift. */
export function djAutomixEntries(
  entries: readonly SetlistEntry[] | null | undefined,
): Array<SetlistEntry & { entryId: string }> {
  return (entries ?? []).filter((e): e is SetlistEntry & { entryId: string } => !!e.entryId);
}

/** What `readyActiveSetForAutomix` found. `ok` is `reason === 'ready'`.
 *  `message` is the sentence to show or to hand the assistant; for `failed`
 *  the store has already logged why. One flat shape rather than a union on
 *  `ok`: this project compiles without strictNullChecks, where a boolean
 *  discriminant does not narrow. */
export interface ActiveSetReadiness {
  ok: boolean;
  reason: 'ready' | 'no-set' | 'changed' | 'failed' | 'too-few';
  setId: string | null;
  name: string;
  playable: number;
  message: string;
  /** True when this call registered the set's tracks with the backend and
   *  patched their ids into the set. That is a change to the library and to
   *  the set even when automix then cannot start (`changed`, `too-few`), and a
   *  caller that reports "nothing changed" on `ok: false` must not say so. */
  registered: boolean;
}

/**
 * Make the active set something automix can sequence, before anything turns
 * automix on.
 *
 * A bundled set lists its tracks with `entryId: null` until it is registered
 * (GET /setlists is read-only), and the automix effect sequences entry ids
 * only, so starting one unregistered found an empty set and stopped with
 * "Automix needs an active set with ≥2 tracks". Every start path comes
 * through here: START AUTO DJ, the Automix chip, a Sets row, the assistant and
 * Send to DJ. A register already in flight for the set is joined, never
 * repeated: `registerBundled` is single-flight per set.
 *
 * The active set is read again after the register. The user can switch sets
 * while it is out, and starting the set they left would sequence a list nobody
 * is looking at.
 */
export async function readyActiveSetForAutomix(): Promise<ActiveSetReadiness> {
  const sl = useSetlistStore.getState();
  const setId = sl.activeId;
  const set = setId ? sl.setlists[setId] : null;
  if (!setId || !set) {
    return { ok: false, reason: 'no-set', setId: null, name: '', playable: 0, message: 'Pick a set first', registered: false };
  }
  let entries: readonly SetlistEntry[] = set.entries;
  let didRegister = false;
  if (isBundledSetId(setId) && entries.some(isPendingBundledRow)) {
    const registered = await sl.registerBundled(setId);
    if (useSetlistStore.getState().activeId !== setId) {
      return {
        ok: false, reason: 'changed', setId, name: set.name, playable: 0,
        message: 'The active set changed while it was registering — start Auto DJ again',
        registered: registered !== null,
      };
    }
    if (registered === null) {
      return {
        ok: false, reason: 'failed', setId, name: set.name, playable: 0,
        message: `Could not register the tracks of "${set.name}"`,
        registered: false,
      };
    }
    entries = registered;
    didRegister = true;
  }
  const playable = djAutomixEntries(entries).length;
  if (playable < AUTO_DJ_MIN_TRACKS) {
    return {
      ok: false, reason: 'too-few', setId, name: set.name, playable,
      message: `"${set.name}" has ${playable} playable track${playable === 1 ? '' : 's'} — Auto-DJ needs ${AUTO_DJ_MIN_TRACKS}.`,
      registered: didRegister,
    };
  }
  return { ok: true, reason: 'ready', setId, name: set.name, playable, message: `"${set.name}" is ready`, registered: didRegister };
}

/** The first track of the active set that can go on a deck, registering a
 *  bundled set first while any of its rows still waits for an id, so the set
 *  starts from its own first track. Null when there is no active set, the
 *  register failed, the active set changed while it was out, or nothing in the
 *  set is playable. The DJ master transport's play (the footer button while
 *  DJ has the transport) starts an idle set through this: for a bundled set
 *  nobody had opened, it found no entry id and did nothing at all. */
export async function firstPlayableOfActiveSet(): Promise<string | null> {
  const sl = useSetlistStore.getState();
  const setId = sl.activeId;
  const set = setId ? sl.setlists[setId] : null;
  if (!setId || !set) return null;
  let entries: readonly SetlistEntry[] = set.entries;
  if (isBundledSetId(setId) && entries.some(isPendingBundledRow)) {
    const registered = await sl.registerBundled(setId);
    if (!registered || useSetlistStore.getState().activeId !== setId) return null;
    entries = registered;
  }
  return djAutomixEntries(entries)[0]?.entryId ?? null;
}

/** The reserved set name reused for suggester sends, so repeated sends update
 *  one "Suggested mix" list in place instead of piling up new setlists. */
const SUGGESTED_SET_NAME = 'Suggested mix';

/**
 * Load an ordered track list as the active automix set, switch to the DJ tab,
 * and request an automix start from the top of that list. Reuses the
 * "Suggested mix" setlist if it exists.
 * Returns the number of tracks staged (0 if none had a library id).
 */
export function sendToDjAutomix(tracks: Array<{ entryId: string; label: string }>): number {
  const usable = tracks.filter((t) => t.entryId);
  if (usable.length === 0) return 0;
  const entries: SetlistEntry[] = usable.map((t) => ({
    entryId: t.entryId,
    label: t.label,
    kind: 'audio',
  }));

  const sl = useSetlistStore.getState();
  const existing = Object.values(sl.setlists).find((s) => s.name === SUGGESTED_SET_NAME);
  const id = existing?.id ?? sl.create(SUGGESTED_SET_NAME);
  sl.setEntries(id, entries);
  sl.setActive(id);

  useAppUiStore.getState().setCenterTab('dj');
  useDjAutomix.getState().requestStart('fresh');
  return entries.length;
}
