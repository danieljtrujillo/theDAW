import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistBackend, persistStorage } from './persistStorage';
import { uuid } from '../orb-kit/utils';
import { RACK_EFFECTS, rackEffectDefaults } from '../lib/rackEffects';
// Value import, not just the type this file already needed: `recreate()`'s
// re-read (T18 seventh audit, MAJOR 2) has to reach track `fxChain`s and
// `masterVstChain`, not just this store's own MIX chain. Safe here -- unlike
// `sessionRegistry.ts`'s cycle warning, `editorStore` only imports THIS
// file's types (erased at runtime), never a value from it.
import { useEditorStore } from './editorStore';
import {
  areVstStatesLoaded,
  beginVstStatesLoad,
  VstStateStoreTimeoutError,
  deleteVstRawState,
  getVstRawState,
  listVstRawStateIds,
  markVstStatesLoaded,
  putVstRawState,
  setLoadedVstEntryLookup,
  setVstStateUnresolvedLookup,
  vstStatesLoaded,
} from '../lib/vstStateStorage';

export const EFFECT_CATEGORIES: Record<string, string[]> = {
  'Dynamics': ['compression', 'volume', 'loudnorm', 'mastering_chain'],
  'EQ & Tone': ['highpass', 'lowpass', 'eq_mid', 'sub_exciter'],
  'Space': ['reverb_delay', 'delay', 'echo', 'stereo_widener'],
  'Cleanup': ['denoise', 'declick', 'silence_remove'],
  'Creative': ['lofi_vinyl', 'pitch_shift', 'tempo', 'time_pitch', 'vocal_processing', 'phase_isolation'],
  'Fade': ['fade'],
  'Export': ['export_flac', 'export_mp3', 'export_aac', 'export_opus'],
};

export const EFFECT_DEFAULTS: Record<string, Record<string, number>> = {
  mastering_chain: { lowBoost: 0, highBoost: 0, limiterCeiling: 0.95, targetLUFS: -14 },
  compression: { attack: 0.1, decay: 0.3 },
  highpass: { frequency: 80 },
  volume: { level: 1.0 },
  tempo: { rate: 1.0 },
  time_pitch: { tempo: 1.0, semitones: 0 },
  vocal_processing: { highpassFreq: 80, presenceBoost: 2, targetLUFS: -16 },
  lofi_vinyl: { degradation: 3, lowpassFreq: 8000 },
  stereo_widener: { delayMs: 15 },
  reverb_delay: { delayMs: 400, decay: 0.5, reverbDecay: 0.4 },
  sub_exciter: { subBoost: 4, trebleBoost: 2 },
  phase_isolation: { cancelAmount: 0.8 },
  eq_mid: { frequency: 1000, width: 500, gain: 0 },
  loudnorm: { targetLUFS: -14, truePeak: -1 },
  lowpass: { frequency: 8000 },
  pitch_shift: { shift: 0 },
  delay: { leftMs: 250, rightMs: 375 },
  echo: { delayMs: 300, decay: 0.4 },
  fade: { fadeInDuration: 1, fadeOutDuration: 2 },
  denoise: { noiseReduction: 20 },
  declick: { windowSize: 30 },
  silence_remove: { threshold: -40 },
  export_flac: { compressionLevel: 5 },
  export_mp3: { bitrate: 320 },
  export_aac: { bitrate: 256 },
  export_opus: { bitrate: 128 },
};

export const EFFECT_LABELS: Record<string, string> = {
  mastering_chain: 'Mastering Chain',
  compression: 'Compressor',
  highpass: 'High-Pass Filter',
  volume: 'Volume',
  tempo: 'Tempo',
  time_pitch: 'Time + Pitch',
  vocal_processing: 'Vocal Processing',
  lofi_vinyl: 'Lo-Fi / Vinyl',
  stereo_widener: 'Stereo Widener',
  reverb_delay: 'Reverb + Delay',
  sub_exciter: 'Sub / Exciter',
  phase_isolation: 'Phase Isolation',
  eq_mid: 'Parametric EQ',
  loudnorm: 'Loudness Norm',
  lowpass: 'Low-Pass Filter',
  pitch_shift: 'Pitch Shift',
  delay: 'Stereo Delay',
  echo: 'Echo',
  fade: 'Fade In/Out',
  denoise: 'Denoise',
  declick: 'De-Click',
  silence_remove: 'Silence Remove',
  export_flac: 'Export FLAC',
  export_mp3: 'Export MP3',
  export_aac: 'Export AAC',
  export_opus: 'Export Opus',
};

/**
 * The psychoacoustic (client-side Web-Audio) effect ids MIX treats as its LIVE
 * rack subset: every RACK_EFFECTS id EXCEPT the four that collide with a backend
 * effect id under a different param shape (stereo_widener, delay, highpass,
 * lowpass). Those four stay owned by the backend effect path so a backend 'delay'
 * is never hijacked by the rack live/bake path. Shared by mixLiveRack (heard
 * live), studioStore.processChain (baked offline vs sent to /api/studio) and
 * MixView (which effects the Psychoacoustics browser offers). Self-maintaining:
 * derived from RACK_EFFECTS minus the backend id set (EFFECT_DEFAULTS keys).
 */
export const MIX_RACK_IDS: Set<string> = new Set(
  RACK_EFFECTS.filter((d) => !(d.id in EFFECT_DEFAULTS)).map((d) => d.id),
);

/**
 * Which host produced a plugin's saved `raw_state`.
 *
 * Plugin state IS interchangeable between theDAW's own live host and the
 * offline pedalboard renderer — measured, not assumed: parameters restore
 * exactly and the captured containers are byte-identical either way. So
 * `state_host` is not a compatibility gate; it names which renderer should
 * process the entry, and the offline render goes back through the SAME host
 * it was captured on for that reason alone.
 *
 * `'pedalboard'` is the old editor sidecar (and the offline renderer). Every
 * project saved before this field existed was captured that way, which is why
 * ABSENT reads as `'pedalboard'` — see `vstStateHost`.
 */
export type VstStateHost = 'thedaw' | 'pedalboard';

/** Identity of a VST3 plugin node in the chain. Present only on VST entries;
 *  FFmpeg/built-in effects leave it undefined. */
export interface VstNode {
  plugin_path: string;
  plugin_name: string;
  /** Base64 plugin state captured from the native editor (show_editor); applied
   *  at process time so the dialed-in sound is reused. Undefined = defaults. */
  raw_state?: string;
  /** Which host captured `raw_state`. Absent on every project written before
   *  the live host existed, and therefore read as `'pedalboard'`. */
  state_host?: VstStateHost;
}

/** The host that produced this node's state, with the compatibility default.
 *  ONE definition, so no caller can silently re-home a legacy entry onto the
 *  live renderer by guessing "absent means live" on its own — `state_host`
 *  selects which renderer processes the entry, it does not gate reuse. */
export const vstStateHost = (vst: VstNode | undefined): VstStateHost =>
  vst?.state_host === 'thedaw' ? 'thedaw' : 'pedalboard';

/** Which IndexedDB operation on a plugin state failed. */
export type VstStateStorageOp = 'save' | 'load' | 'delete';

/**
 * Reports a failure of the IndexedDB plugin-state store (FE-004) — most
 * notably `QuotaExceededError` on a save. The store itself has no UI, so it
 * only reports the failure; `vstEditorStore` installs the handler that
 * surfaces it (status bar text, and the embed's own error banner when the
 * failing entry is the one currently open). `entryId` is `'*'` when the
 * failure is not about one entry (listing the stored ids for the startup GC).
 */
export type VstStateStorageErrorHandler = (entryId: string, error: unknown, op: VstStateStorageOp) => void;
let vstStateStorageErrorHandler: VstStateStorageErrorHandler | null = null;
/** Failures reported before any handler was installed (a startup load can
 *  fail before the module that surfaces it has loaded); delivered on install
 *  rather than dropped. */
const unreportedVstStateStorageErrors: [string, unknown, VstStateStorageOp][] = [];
/** Install (or clear, with `null`) the storage-error listener. */
export function setVstStateStorageErrorHandler(handler: VstStateStorageErrorHandler | null): void {
  vstStateStorageErrorHandler = handler;
  if (!handler) return;
  for (const [entryId, error, op] of unreportedVstStateStorageErrors.splice(0)) handler(entryId, error, op);
}
const reportVstStateStorageError = (entryId: string, error: unknown, op: VstStateStorageOp): void => {
  if (vstStateStorageErrorHandler) vstStateStorageErrorHandler(entryId, error, op);
  else unreportedVstStateStorageErrors.push([entryId, error, op]);
};

/*
 * Where a plugin's `raw_state` lives, and the one rule that keeps it safe:
 * the only copy of a plugin state is never dropped before a second copy is
 * confirmed.
 *
 * The blob lives in memory (every reader uses that), in IndexedDB (keyed by
 * entry id, `vstStateStorage.ts`), and — only until IndexedDB has confirmed
 * it — inline in the localStorage payload. `partialize` strips it from
 * localStorage for an id in `confirmedInIdb` and for no other: a put still in
 * flight, a put that failed (QuotaExceededError, a broken partition), or no
 * IndexedDB at all all leave the blob inline, exactly as before T18.
 */

/** Ids whose CURRENT in-memory `raw_state` IndexedDB has confirmed holding. */
const confirmedInIdb = new Set<string>();
/** Per-id put counter: only the newest put for an id may confirm it. */
const putGeneration = new Map<string, number>();
/** Ids whose startup `get` has not settled: their saved state is not in
 *  memory yet, so a capture now would be one of the plugin's DEFAULTS. */
const startupLoadPending = new Set<string>();
/**
 * Ids whose `get` failed (an error, or the timeout below): the saved row may
 * still hold the user's state, and we have no way to tell. Nothing may
 * overwrite such a row — not even in a LATER session, which is why a capture
 * on one of these is refused outright rather than kept inline: an inline blob
 * is exactly what the next launch would put over the surviving row, and a
 * capture needs no user action at all (the registry sinks a host's state when
 * it is released; the editor captures every 5 s). The read is retried instead
 * — `retryVstStateLoad`, which the editor open asks for.
 */
const startupLoadFailed = new Set<string>();
/** Reads in flight, by entry id, so N callers for one entry share ONE read —
 *  whoever started it (the startup pass, or an editor open's retry). */
const loadPromises = new Map<string, Promise<void>>();
/** Save failures already reported this session, by entry id: with no
 *  IndexedDB at all the live editor's 5 s capture would otherwise put a
 *  status-bar line up every 5 s for the same dead store. Cleared when a save
 *  for that entry succeeds. */
const reportedSaveFailures = new Set<string>();
/** Entries already marked as running on defaults with an unreadable state, so
 *  the refused 5 s capture does not re-report every 5 s. */
const reportedLoadFailures = new Set<string>();
/** Captures whose put has not settled: the value is the only copy there is,
 *  so a rehydrate must not drop it. */
const putsInFlight = new Map<string, { rawState: string; stateHost: string | undefined }>();

/** Reads running right now, so a retry never starts a second one. */
const loadsInFlight = new Set<string>();

/** Is this entry's saved state one we could not READ this session (a real
 *  rejection — not merely a slow store, which leaves it unresolved)? */
export const isVstStateLoadFailed = (entryId: string): boolean => startupLoadFailed.has(entryId);

/** Does this entry still have no answer about its saved state — failed, or
 *  given up on for now — with no read in flight? Captures are refused for
 *  these, and the editor open retries them. */
export const isVstStateUnresolved = (entryId: string): boolean =>
  (startupLoadFailed.has(entryId) || startupLoadPending.has(entryId)) && !loadsInFlight.has(entryId);

/**
 * What the app does about an entry whose saved state could not be read, and
 * about one that was read after the plugin had already started.
 *
 * `effectChainStore` has no way to reach the live host (importing the session
 * registry here would close the rackEffects cycle), so `vstEditorStore`
 * installs this.
 */
export interface VstStateLoadListener {
  /** The state cannot be read: whatever is running is at its DEFAULTS, and
   *  the row should say so, with the reason. */
  unreadable: (entryId: string, reason: string) => void;
  /** The state was read. Hand it to whatever is running and answer whether it
   *  was HANDED OVER — not that the plugin verifiably took it; there is no
   *  wire acknowledgement for `set_state` to check against (T18 fourth audit,
   *  MAJOR 2). False keeps captures refused, because a capture would
   *  otherwise write the plugin's defaults over the row that was just read
   *  (T18 third audit, CRITICAL 1). */
  restored: (entryId: string, rawState: string) => boolean;
}
let vstStateLoadListener: VstStateLoadListener | null = null;
/** Entries found unreadable before any listener was installed (a startup read
 *  fails before the module that shows it has loaded); replayed on install
 *  rather than dropped, so the row still ends up saying so. */
const unmarkedUnreadable: [string, string][] = [];
/** Install (or clear, with `null`) the load listener. */
export function setVstStateLoadListener(listener: VstStateLoadListener | null): void {
  vstStateLoadListener = listener;
  if (!listener) return;
  for (const [entryId, reason] of unmarkedUnreadable.splice(0)) listener.unreadable(entryId, reason);
}

/**
 * `vstStatesLoaded` settles once every startup `get` has finished, success or
 * failure (a failed one is reported as a `'load'` error and leaves the entry
 * with whatever it carried inline). Anything that hands an entry's
 * `raw_state` to a plugin — the editor open, the MIX render, the live node's
 * host spawn — awaits it first, so it can never read the empty value a
 * not-yet-loaded entry has. It lives in `vstStateStorage` (no runtime
 * imports) so the live node can wait on it without an import cycle.
 */
export { vstStatesLoaded, areVstStatesLoaded };

let resolveStartupGc: () => void = () => {};
/** Settles when the startup GC of orphan IndexedDB rows has finished (or was
 *  skipped). Exported for tests and diagnostics. */
export const vstStateStartupGc: Promise<void> = new Promise((resolve) => {
  resolveStartupGc = resolve;
});

/** True when hydration found a stored chain (not a first run). */
let hydratedFromStorage = false;
let startupStarted = false;

/** Report a failed save ONCE per entry per session: with no IndexedDB (or a
 *  dead one) the live editor's 5 s capture would otherwise repeat the same
 *  line forever. A save that succeeds clears the mark. */
const reportSaveFailure = (id: string, error: unknown): void => {
  // A chain edit is a USER action, not a 5 s timer: every failed one says so.
  // Suppressing after the first left every later edit failing in silence, and
  // those edits' IndexedDB rows are what the GC later collects as orphans
  // (T18 fourth audit, MINOR 5).
  if (id !== CHAIN_WRITE) {
    if (reportedSaveFailures.has(id)) return;
    reportedSaveFailures.add(id);
  }
  reportVstStateStorageError(id, error, 'save');
};

/**
 * Run a store write that persists, and route a failing localStorage write
 * (a full quota) through the reporting path instead of throwing it at the
 * caller. zustand applies the in-memory update BEFORE persisting, so the
 * update itself always stands; only the payload on disk is behind.
 *
 * Every action in this store goes through this: a knob move arrives inside a
 * timer callback where a throw is an unhandled error nobody sees
 * (T18 third audit, MAJOR 5).
 */
const persistSafely = (id: string, write: () => void): void => {
  try {
    write();
  } catch (err) {
    reportSaveFailure(id, err);
  }
};
/** The id a chain-wide write (add, remove, reorder, clear) reports under. */
const CHAIN_WRITE = '*';

/** The chain, as the payload in localStorage describes it, with every
 *  `raw_state` removed: what this tab last saw, for comparison. */
const chainShape = (payload: string | null): string | null => {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { state?: { chain?: ChainEntry[] } };
    const chain = parsed.state?.chain;
    if (!Array.isArray(chain)) return null;
    return JSON.stringify(chain.map((e) => (e.vst ? { ...e, vst: { ...e.vst, raw_state: undefined } } : e)));
  } catch {
    return null;
  }
};

/**
 * Rewrite the localStorage payload now: a put was just confirmed, so the
 * stripped payload replaces the one still carrying the blob inline.
 *
 * This runs from an IndexedDB callback, long after the state it writes was
 * read — so if the stored payload no longer describes THIS tab's chain,
 * another tab wrote in between and its edit would be lost. Leave it: the blob
 * stays inline in that payload, which costs space, not data, and the next
 * write from this tab (or the other tab's own confirm) tidies it up.
 */
const writePersisted = (): void => {
  const opts = useEffectChainStore.persist.getOptions();
  if (!opts.storage || !opts.name || !opts.partialize) return;
  const next = opts.partialize(useEffectChainStore.getState()) as { chain: ChainEntry[] };
  try {
    const stored = persistBackend.getItem(opts.name);
    const storedShape = chainShape(stored);
    const nextShape = JSON.stringify(
      next.chain.map((e) => (e.vst ? { ...e, vst: { ...e.vst, raw_state: undefined } } : e)),
    );
    if (storedShape !== null && storedShape !== nextShape) return; // another tab wrote in between
    void opts.storage.setItem(opts.name, { state: next, version: opts.version ?? 0 });
  } catch {
    // The previous payload stays, and it still carries the blob inline:
    // nothing is lost, and the next store write tries again.
  }
};

/** Put `rawState` into IndexedDB; confirm it (and so strip it from
 *  localStorage) only when that put succeeded AND it is still the entry's
 *  current state. */
const storeVstRawState = (id: string, rawState: string, stateHost: string | undefined): void => {
  const gen = (putGeneration.get(id) ?? 0) + 1;
  putGeneration.set(id, gen);
  confirmedInIdb.delete(id);
  putsInFlight.set(id, { rawState, stateHost });
  const done = () => {
    if (putGeneration.get(id) === gen) putsInFlight.delete(id);
  };
  putVstRawState(id, rawState, stateHost).then(
    () => {
      done();
      if (putGeneration.get(id) !== gen) return;
      reportedSaveFailures.delete(id);
      const still = useEffectChainStore.getState().chain.find((e) => e.id === id);
      if (still?.vst?.raw_state !== rawState) return;
      confirmedInIdb.add(id);
      writePersisted();
    },
    (err) => {
      done();
      if (putGeneration.get(id) === gen) confirmedInIdb.delete(id);
      reportSaveFailure(id, err);
    },
  );
};

/** Drop all bookkeeping for an id whose row is being deleted, so a put still
 *  in flight for it can never confirm it. */
const forgetVstRawState = (id: string): void => {
  putGeneration.set(id, (putGeneration.get(id) ?? 0) + 1);
  confirmedInIdb.delete(id);
  startupLoadPending.delete(id);
  startupLoadFailed.delete(id);
  putsInFlight.delete(id);
  // An id can come back (an undo of a delete re-adds the SAME id), and the
  // entry that comes back deserves to be told about its own first failure
  // (T18 third audit, MINOR 8).
  reportedSaveFailures.delete(id);
  reportedLoadFailures.delete(id);
};

/** The localStorage key the chain persists under — shared by every tab. */
const STORAGE_NAME = 'thedaw-effect-chain';
/** Where the previous startup's orphan sightings are kept (see below). */
const ORPHAN_KEY = 'thedaw-vst-state-orphans';
const readSeenOrphans = (): Set<string> => {
  try {
    const raw = globalThis.localStorage?.getItem(ORPHAN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
};
const writeSeenOrphans = (ids: string[]): void => {
  try {
    if (ids.length === 0) globalThis.localStorage?.removeItem(ORPHAN_KEY);
    else globalThis.localStorage?.setItem(ORPHAN_KEY, JSON.stringify(ids));
  } catch {
    // Full or unavailable: the GC simply waits for a startup that can record.
  }
};

/**
 * Delete the IndexedDB rows no chain refers to. Runs once, after hydration
 * and every startup read, and never without a stored chain to compare against
 * (on a first run it deletes nothing).
 *
 * A row missing from the hydrated chain is NOT proof of an orphan: every tab
 * of the app shares one localStorage key, so the chain that hydrated is
 * whichever tab wrote last, and another tab may be holding rows this one has
 * never seen. So a row is only deleted after being seen orphaned on two
 * consecutive startups, and the first sighting is recorded rather than acted
 * on (T18 re-audit, MAJOR 3).
 */
const runStartupGc = async (hydratedIds: Set<string>): Promise<void> => {
  if (typeof indexedDB === 'undefined') return;
  let ids: string[];
  try {
    ids = await listVstRawStateIds();
  } catch (err) {
    reportVstStateStorageError('*', err, 'delete');
    return;
  }
  const seenBefore = readSeenOrphans();
  const firstSightings: string[] = [];
  for (const id of ids) {
    if (hydratedIds.has(id)) continue;
    // Added in this session since hydration: its row is live, not an orphan.
    if (useEffectChainStore.getState().chain.some((e) => e.id === id)) continue;
    if (!seenBefore.has(id)) {
      firstSightings.push(id);
      continue;
    }
    await deleteVstRawState(id).catch((err) => reportVstStateStorageError(id, err, 'delete'));
  }
  writeSeenOrphans(firstSightings);
};

const finishStartup = (runGc: boolean, hydratedIds: Set<string>): void => {
  startupStarted = true;
  markVstStatesLoaded();
  if (!runGc) {
    resolveStartupGc();
    return;
  }
  void runStartupGc(hydratedIds).finally(resolveStartupGc);
};

/**
 * Right after hydration: every VST entry either carries its blob inline (a
 * pre-T18 chain being migrated, or a previous session's put that was never
 * confirmed) — stored to IndexedDB now, and inline until that is confirmed —
 * or carries none, and is loaded back from IndexedDB.
 *
 * Runs inside `create()` (zustand hydrates a synchronous storage there), so
 * nothing in here may touch `useEffectChainStore` synchronously.
 */
/**
 * Read ONE entry's saved state back into memory. Bounded; never rejects.
 *
 * Failure (an error, or the timeout) is recorded and reported, and leaves the
 * entry with whatever it already carried — the row itself is left alone.
 */
const loadVstStateInto = async (id: string): Promise<void> => {
  startupLoadPending.add(id);
  loadsInFlight.add(id);
  let stayPending = false;
  try {
    const stored = await getVstRawState(id);
    if (!stored) {
      // At its defaults: nothing was ever captured for this entry.
      startupLoadFailed.delete(id);
      return;
    }
    const current = useEffectChainStore.getState();
    const still = current.chain.find((e) => e.id === id);
    if (still?.vst && !still.vst.raw_state) {
      // IndexedDB holds exactly what goes into memory: confirmed, so the
      // write this setState makes keeps it out of localStorage.
      confirmedInIdb.add(id);
      useEffectChainStore.setState({
        chain: current.chain.map((e) =>
          e.id === id && e.vst
            ? {
                ...e,
                vst: {
                  ...e.vst,
                  raw_state: stored.rawState,
                  state_host: (stored.stateHost as VstStateHost | undefined) ?? e.vst.state_host,
                },
              }
            : e,
        ),
      });
    }
    // Reading the row is not enough: a plugin that started while the row was
    // unreadable is running at its DEFAULTS, and its next capture would put
    // those over the row. Hand the row to whatever is running, and release
    // the refusal latch once the state has been handed over — that is all
    // this can honestly claim; see the `restored` doc above (T18 fourth
    // audit, MAJOR 2).
    const handedOver = vstStateLoadListener ? vstStateLoadListener.restored(id, stored.rawState) : true;
    if (!handedOver) {
      stayPending = true;
      return;
    }
    startupLoadFailed.delete(id);
    reportedLoadFailures.delete(id);
  } catch (err) {
    if (err instanceof VstStateStoreTimeoutError) {
      // A slow store is not a failed read, but the plugin that starts while it
      // is still pending is at its DEFAULTS regardless of why — so the row
      // does say so (via markUnreadable, below), same as any other unreadable
      // state, and the entry stays pending so captures stay refused (the safe
      // answer) until the slow read finally lands (T18 fifth audit, MINOR 4:
      // this comment used to claim the opposite of what the next line does).
      stayPending = true;
      markUnreadable(id, err.message);
      return;
    }
    startupLoadFailed.add(id);
    markUnreadable(id, err instanceof Error ? err.message : String(err));
    reportVstStateStorageError(id, err, 'load');
  } finally {
    // Always, however this ended — except where the entry must deliberately
    // stay pending: an entry left pending by accident would refuse every
    // capture for the rest of the session.
    loadsInFlight.delete(id);
    if (!stayPending) startupLoadPending.delete(id);
  }
};

/** Say ONCE that this entry's plugin is running on defaults because its saved
 *  state could not be read: the refused capture comes back every 5 s. */
const markUnreadable = (id: string, reason: string): void => {
  if (reportedLoadFailures.has(id)) return;
  reportedLoadFailures.add(id);
  const text = `its saved state could not be read (${reason})`;
  if (vstStateLoadListener) vstStateLoadListener.unreadable(id, text);
  else unmarkedUnreadable.push([id, text]);
};

/**
 * Read an entry's saved state again after a failed read — what the editor
 * open asks for, so a transient error costs one open, not the state. Shares
 * one read between concurrent callers; a no-op for an entry that loaded.
 */
export function retryVstStateLoad(entryId: string): Promise<void> {
  // A read already running is checked FIRST: an entry with one in flight does
  // not read as "unresolved", so asking the other way round handed the second
  // caller a resolved promise while the state was still absent, and `open()`
  // carried on as if it were there (T18 fourth audit, MINOR 4).
  const running = loadPromises.get(entryId);
  if (running) return running;
  if (!isVstStateUnresolved(entryId)) return Promise.resolve();
  return startVstStateLoad(entryId);
}

/** One read per entry at a time; every caller gets the same promise. */
function startVstStateLoad(entryId: string): Promise<void> {
  const running = loadPromises.get(entryId);
  if (running) return running;
  const p = loadVstStateInto(entryId).finally(() => loadPromises.delete(entryId));
  loadPromises.set(entryId, p);
  return p;
}

/** Store the inline blobs of a hydrated chain, and read back the ones that
 *  carry none. Used by the startup pass and by a rehydrate from another tab. */
const loadHydratedVstStates = (chain: ChainEntry[]): Promise<void>[] => {
  const gets: Promise<void>[] = [];
  for (const entry of chain) {
    if (!entry.vst) continue;
    const id = entry.id;
    if (entry.vst.raw_state) {
      // Already on its way to IndexedDB (a capture rescued by a rehydrate):
      // putting it a second time would only bump its generation.
      if (putsInFlight.get(id)?.rawState === entry.vst.raw_state) continue;
      storeVstRawState(id, entry.vst.raw_state, entry.vst.state_host);
      continue;
    }
    gets.push(startVstStateLoad(id));
  }
  return gets;
};

/**
 * Another tab wrote the shared payload and this tab rehydrated from it: the
 * chain is now theirs, and the blobs this tab had in memory went with the old
 * one. Read back what the new chain needs. No signal, no GC — this is not a
 * startup.
 */
const reloadAfterRehydrate = (chain: ChainEntry[]): void => {
  // A capture whose put has not landed is the ONLY copy of that state: the
  // rehydrate just replaced the entry that held it in memory, so put it back
  // rather than reading an older row over the top of it (T18 third audit,
  // MINOR 6).
  const rescued = chain.filter((e) => e.vst && !e.vst.raw_state && putsInFlight.has(e.id));
  if (rescued.length > 0) {
    const inFlight = new Map(rescued.map((e) => [e.id, putsInFlight.get(e.id)!]));
    useEffectChainStore.setState({
      chain: useEffectChainStore.getState().chain.map((e) => {
        const held = e.vst ? inFlight.get(e.id) : undefined;
        return held
          ? { ...e, vst: { ...e.vst!, raw_state: held.rawState, state_host: held.stateHost as VstStateHost | undefined } }
          : e;
      }),
    });
  }
  void Promise.all(loadHydratedVstStates(useEffectChainStore.getState().chain));
};

const startVstStateStartup = (chain: ChainEntry[]): void => {
  startupStarted = true;
  const hydratedIds = new Set(chain.map((e) => e.id));
  const gets = loadHydratedVstStates(chain);
  // Nothing to load: loaded now, not a microtask later, so a caller acting
  // right after import never waits for no reason.
  if (gets.length === 0) {
    finishStartup(hydratedFromStorage, hydratedIds);
    return;
  }
  beginVstStatesLoad();
  void Promise.all(gets).then(() => finishStartup(hydratedFromStorage, hydratedIds));
};

export interface ChainEntry {
  id: string;
  effect: string;
  params: Record<string, number>;
  enabled: boolean;
  /** Set when this entry is a hosted VST3 plugin (effect === 'vst3'). */
  vst?: VstNode;
  /** Display name for entries with no live rack definition — imported VST3 or a
   *  source-DAW effect theDAW preserves but can't render live per-track yet. */
  label?: string;
}

interface EffectChainState {
  chain: ChainEntry[];
  addEffect: (effect: string) => void;
  /** Add a psychoacoustic (client-side rack) effect to the chain, seeded from its
   *  rackEffects descriptor. Separate from addEffect because EFFECT_DEFAULTS is
   *  backend-only and four rack ids (delay/highpass/lowpass/stereo_widener)
   *  collide with backend ids under different param shapes — so rack effects must
   *  never seed from EFFECT_DEFAULTS. This is the only seeding path for rack ids. */
  addRackEffect: (effect: string) => void;
  addVst: (plugin: VstNode) => void;
  /** Store a captured plugin state on a VST entry, together with the host that
   *  produced it. `stateHost` defaults to `'pedalboard'` because the caller that
   *  omits it is the OLD editor sidecar path — the live capture path names
   *  `'thedaw'` explicitly. Returns false when the capture was refused: no
   *  such VST entry, or the entry's saved state is still loading (a capture
   *  then can only be the plugin's defaults, and must not replace it). */
  setVstRawState: (id: string, rawState: string, stateHost?: VstStateHost) => boolean;
  removeEffect: (id: string) => void;
  updateParams: (id: string, params: Record<string, number>) => void;
  toggleEnabled: (id: string) => void;
  reorder: (fromIndex: number, toIndex: number) => void;
  clearChain: () => void;
}

export const useEffectChainStore = create<EffectChainState>()(
  persist(
    (set, get) => ({
      chain: [],
      addEffect: (effect) =>
        persistSafely(CHAIN_WRITE, () =>
          set((s) => ({
            chain: [...s.chain, { id: uuid(), effect, params: { ...(EFFECT_DEFAULTS[effect] || {}) }, enabled: true }],
          })),
        ),
      addRackEffect: (effect) =>
        persistSafely(CHAIN_WRITE, () =>
          set((s) => ({
            chain: [...s.chain, { id: uuid(), effect, params: { ...rackEffectDefaults(effect) }, enabled: true }],
          })),
        ),
      addVst: (plugin) =>
        persistSafely(CHAIN_WRITE, () =>
          set((s) => ({
            chain: [...s.chain, { id: uuid(), effect: 'vst3', params: {}, enabled: true, vst: plugin }],
          })),
        ),
      setVstRawState: (id, rawState, stateHost = 'pedalboard') => {
        if (!get().chain.some((e) => e.id === id && e.vst)) return false;
        // The saved state is not in memory: this capture is the plugin's
        // defaults, and the row it would replace is the user's real state.
        // Pending (still reading) and failed (could not read, and a capture
        // kept inline would be put over that row on the NEXT launch) are the
        // same answer — the read is retried instead, see retryVstStateLoad.
        if (startupLoadPending.has(id) || startupLoadFailed.has(id)) return false;
        // Unconfirmed from this moment on: the write `set` makes below keeps
        // the new blob inline until its own put is confirmed.
        confirmedInIdb.delete(id);
        // persist's localStorage write runs inside `set` and can throw (a
        // capture too big for the quota). zustand has already applied the
        // in-memory update, so the capture is NOT lost: the failed write is
        // reported and this carries on to IndexedDB, which is where a blob
        // that large belongs anyway.
        persistSafely(id, () =>
          set((s) => ({
            chain: s.chain.map((e) =>
              e.id === id && e.vst
                ? { ...e, vst: { ...e.vst, raw_state: rawState, state_host: stateHost } }
                : e,
            ),
          })),
        );
        // Fire-and-forget, but never silently: a failure (FE-004, most
        // notably QuotaExceededError) is reported, and the blob stays inline.
        storeVstRawState(id, rawState, stateHost);
        return true;
      },
      removeEffect: (id) => {
        persistSafely(CHAIN_WRITE, () => set((s) => ({ chain: s.chain.filter((e) => e.id !== id) })));
        forgetVstRawState(id);
        deleteVstRawState(id).catch((err) => reportVstStateStorageError(id, err, 'delete'));
      },
      updateParams: (id, params) =>
        persistSafely(id, () => set((s) => ({ chain: s.chain.map((e) => (e.id === id ? { ...e, params } : e)) }))),
      toggleEnabled: (id) =>
        persistSafely(id, () =>
          set((s) => ({ chain: s.chain.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
        ),
      reorder: (from, to) =>
        persistSafely(CHAIN_WRITE, () =>
          set((s) => {
            const next = [...s.chain];
            const [item] = next.splice(from, 1);
            next.splice(to, 0, item);
            return { chain: next };
          }),
        ),
      clearChain: () => {
        // Only THIS chain's rows: another open tab shares the database, and
        // its chain's rows are not ours to delete.
        const ids = get().chain.filter((e) => e.vst).map((e) => e.id);
        persistSafely(CHAIN_WRITE, () => set({ chain: [] }));
        for (const id of ids) {
          forgetVstRawState(id);
          deleteVstRawState(id).catch((err) => reportVstStateStorageError(id, err, 'delete'));
        }
      },
    }),
    {
      name: STORAGE_NAME,
      // A refused write (quota) still throws here, after the shared backend
      // has kept the value in memory: every action reports its own failed save.
      storage: persistStorage({ reportWriteErrors: true }),
      // Bumped from the implicit 0: version 0 payloads carried `vst.raw_state`
      // inline (see `migrate` below); version 1 never does.
      version: 1,
      // The raw_state blob leaves localStorage only once IndexedDB has
      // confirmed holding it (see `confirmedInIdb` above); until then it is
      // the only persisted copy and stays inline.
      partialize: (s) => ({
        chain: s.chain.map((e) =>
          e.vst?.raw_state && confirmedInIdb.has(e.id) ? { ...e, vst: { ...e.vst, raw_state: undefined } } : e,
        ),
      }),
      // Every chain saved before this migration existed carries `raw_state`
      // inline (version 0, or no version key at all — zustand reports that as
      // 0). The chain is returned UNCHANGED: zustand writes it straight back
      // after this returns, before any IndexedDB put could have finished, so
      // the blob must still be in it. The startup pass stores each blob and
      // strips it once that put is confirmed.
      migrate: (persisted) => {
        const state = persisted as { chain?: ChainEntry[] } | null | undefined;
        const chain = Array.isArray(state?.chain) ? state.chain : [];
        return { chain };
      },
      // zustand's default merge, plus: remember whether there WAS a stored
      // chain, which the startup GC needs before it may delete anything.
      merge: (persisted, current) => {
        hydratedFromStorage = persisted !== undefined && persisted !== null;
        return { ...current, ...(persisted as Partial<EffectChainState> | undefined) };
      },
      // Right after hydration: store inline blobs, load the others back from
      // IndexedDB (settling `vstStatesLoaded`), then collect orphan rows.
      onRehydrateStorage: () => (hydrated) => {
        if (!hydrated) {
          if (!startupStarted) finishStartup(false, new Set());
          return;
        }
        // A rehydrate AFTER startup is another tab's write arriving here (see
        // the `storage` listener below): follow it, but this is not a startup.
        if (startupStarted) {
          reloadAfterRehydrate(hydrated.chain);
          return;
        }
        startVstStateStartup(hydrated.chain);
      },
    },
  ),
);

// The persist backend is synchronous, so hydration above has already started
// the startup pass (from localStorage, or from the in-memory fallback when
// there is none). If it somehow did not, nothing is loading and there is
// nothing to collect.
if (!startupStarted) finishStartup(false, new Set());

// The live node re-reads a MIX entry through this once the states have loaded.
// Walks all three chains a live session can belong to -- the MIX chain this
// store owns, every track's `fxChain`, and `masterVstChain` -- same as
// `sinkLiveRawState` in `vstEditorStore.ts`. Returning `undefined` for
// anything but a MIX entry used to leave `sessionRegistry.recreate()`'s
// re-read INERT for a track or master entry: it fell through to the stale
// `slot.entry`, so a capture recorded after the last chain rebuild but before
// a socket loss was silently discarded on respawn (T18 seventh audit,
// MAJOR 2).
setLoadedVstEntryLookup((id) => {
  const mix = useEffectChainStore.getState().chain.find((e) => e.id === id);
  if (mix) return mix;
  const ed = useEditorStore.getState();
  for (const t of ed.tracks) {
    const e = (t.fxChain ?? []).find((x) => x.id === id);
    if (e) return e;
  }
  return ed.masterVstChain.find((e) => e.id === id);
});
// And the session registry asks this before a fresh spawn claims the plugin
// holds the entry's state: with no readable state it was handed nothing.
setVstStateUnresolvedLookup((id) => startupLoadFailed.has(id) || startupLoadPending.has(id));

// Every tab of the app persists under ONE key and therefore holds the SAME
// entry ids. A tab that keeps its own older chain would go on claiming rows
// another tab has already removed (and strip blobs from a payload the other
// tab owns), so the tab that did not make the change follows it: rehydrate,
// then read back the states of whatever it now holds.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (ev: StorageEvent) => {
    if (ev.key !== null && ev.key !== STORAGE_NAME) return;
    void useEffectChainStore.persist.rehydrate();
  });
}

