/**
 * EDIT autosave + crash recovery on a content-addressed OPFS asset layer.
 *
 * The arrangement's JSON side (tracks, clips minus bytes, FX chains,
 * automation, markers, bpm, meter, loop) is written to
 * `thedaw-editor-autosave/manifest.json` in the Origin Private File System,
 * debounced behind the editor store's own document-change signal. Clip audio —
 * the part a refresh used to destroy, since clips hold in-memory Blobs — is
 * stored once per unique content under `assets/<sha256>.bin`: split and
 * duplicated clips share one Blob object (and therefore one hash), so the
 * asset layer maps 1:1 onto the identity model the editor already uses.
 *
 * Lifecycle: `initEditorAutosave()` runs once at app start (idempotent,
 * StrictMode-safe — module-scope guard, not an effect). If a manifest with
 * clips exists, a recovery offer is published to `useAutosaveRecoveryStore`
 * and SAVING STAYS PAUSED until the user restores or discards — a startup
 * edit must never overwrite the only copy of crashed work. After resolution,
 * every document change schedules a debounced save.
 *
 * Deliberately NOT here: `frozenMaster` (documented "never persisted"), undo
 * history, view/transport state. Peaks are derivable and recomputed on
 * restore.
 *
 * DURABILITY (T57). Two hazards the first cut did not cover:
 *
 *   1. A torn manifest. The manifest is written to `manifest.json.tmp` and
 *      then PROMOTED onto `manifest.json` — `FileSystemFileHandle.move()`
 *      where the engine has it (a Chromium extension to the File System spec;
 *      it is not on MDN), else read-back + write + drop the tmp. Chromium's
 *      `createWritable()` already writes into a swap file and only replaces
 *      the target when the stream is CLOSED (MDN, FileSystemFileHandle:
 *      createWritable — "changes … won't be reflected in the file … until the
 *      stream has been closed … typically implemented by writing data to a
 *      temporary file"), so a crash before `close()` is already survivable
 *      there. The tmp+promote is kept anyway: it is two cheap OPFS ops, it
 *      does not depend on an implementation detail the spec only describes as
 *      typical, and it turns "close() was never reached" — the unload case
 *      `flushPendingAutosave` deliberately races — into a leftover tmp beside
 *      an intact manifest rather than an unanswerable question. At startup a
 *      leftover tmp is the candidate only if it PARSES; one that does not is
 *      moved aside (never deleted) and the committed manifest wins.
 *
 *   2. Two tabs, one OPFS directory. The driver takes
 *      `navigator.locks.request('thedaw-editor-autosave', {ifAvailable:true})`
 *      and holds it for the life of the document. The tab that gets it is the
 *      `owner`; a tab that does not is an `observer` and is RECOVERY-ONLY —
 *      it can read and restore, and writes nothing at all, so it cannot
 *      half-overwrite the owner's manifest with its own empty document.
 *      Without Web Locks (`unsupported`) behaviour is exactly as before.
 */
import { create } from 'zustand';
import {
  useEditorStore,
  computePeaks,
  type AudioClip,
  type ClipTake,
  type EditorBus,
  type EditorTrack,
  type TimeSignature,
} from '../state/editorStore';
import type { RoutingGraph } from '../state/routingGraph';
import type { MeterSegment } from './meterMap';
import { copyTempoMap } from './rollTempo';
import type { TempoEvent } from './tempoMap';
import { captureLiveVstStates } from '../state/vstEditorStore';
import { logError, logInfo, logWarn } from '../state/logStore';

const DIR_NAME = 'thedaw-editor-autosave';
const ASSETS_DIR = 'assets';
const MANIFEST = 'manifest.json';
/** Staging name for the manifest. Promoted onto MANIFEST, never read as one. */
const MANIFEST_TMP = 'manifest.json.tmp';
/** Web Locks name. One holder per origin == one autosaving tab. */
const AUTOSAVE_LOCK = 'thedaw-editor-autosave';
const SAVE_DEBOUNCE_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 3;

// ── Serialized shapes ────────────────────────────────────────────────────────

/** A clip's alternate take, stored like the clip itself: the Blob goes to the
 *  content-addressed asset store and the manifest keeps its hash. The take's
 *  cached `peaks` are dropped for the same reason the clip's are — a
 *  Float32Array is not JSON, and the waveform re-derives from the audio. */
type SerializedTake = Omit<ClipTake, 'audioBlob' | 'peaks'> & {
  assetHash: string;
};

/** `takes` is replaced rather than carried through: a `ClipTake` holds a Blob
 *  and a Float32Array, so spreading the live one into the manifest would
 *  `JSON.stringify` each take to `{}` and restore a clip that still claims to
 *  be comped while its takes hold no audio at all. */
type SerializedClip = Omit<AudioClip, 'audioBlob' | 'peaks' | 'takes'> & {
  assetHash: string;
  takes?: SerializedTake[];
};

type SerializedTrack = Omit<EditorTrack, 'frozenOriginal'> & {
  frozenOriginal?: { clips: SerializedClip[]; fxChain: EditorTrack['fxChain'] };
};

interface AutosaveManifest {
  version: 1;
  savedAt: string;
  bpm: number;
  /** Bar 1's meter. Optional on READ only: manifests written before the field
   *  existed have none, and those documents are 4/4 by definition. Still
   *  written, beside `meterMap`, so a build that reads only this opens the
   *  document in the meter it starts in. */
  timeSignature?: TimeSignature;
  /** The arrangement's meter map and tempo map. Optional on READ only: a
   *  manifest written before them opens with `timeSignature` and `bpm`. */
  meterMap?: MeterSegment[];
  tempoMap?: TempoEvent[];
  tracks: SerializedTrack[];
  clips: SerializedClip[];
  masterFxChain: unknown[];
  masterVstChain: unknown[];
  automationLanes: unknown[];
  markers: unknown[];
  loop: { enabled: boolean; startSec: number; endSec: number };
  /** Signal routing + the bus strips. OPTIONAL on read, always written: every
   *  manifest saved before routing existed lacks both keys, and
   *  `loadProject`'s migration is what turns that absence back into the
   *  everything-to-the-master graph. Plain JSON by construction (`RoutingGraph`
   *  holds no Map and no node handles), so it needs no serialized twin the way
   *  clips do. */
  routing?: RoutingGraph;
  buses?: EditorBus[];
}

// ── Recovery offer store (drives the Shell notice) ───────────────────────────

export interface AutosaveRecoveryInfo {
  savedAt: string;
  trackCount: number;
  clipCount: number;
}

/** Which tab owns the autosave, once `initEditorAutosave()` has settled the
 *  Web Lock. `observer` is the recovery-only tab: it restores, it never writes.
 *  `unsupported` is a browser with no Web Locks — one writer, as before. */
export type AutosaveOwnership = 'owner' | 'observer' | 'unsupported';

interface AutosaveRecoveryState {
  offer: AutosaveRecoveryInfo | null;
  busy: boolean;
  /** Mirrors `autosaveOwnership()` so the notice can render it. */
  ownership: AutosaveOwnership;
  restore: () => Promise<void>;
  discard: () => Promise<void>;
}

export const useAutosaveRecoveryStore = create<AutosaveRecoveryState>((set) => ({
  offer: null,
  busy: false,
  ownership: 'unsupported',
  restore: async () => {
    set({ busy: true });
    try {
      await restoreFromAutosave();
      set({ offer: null, busy: false });
    } catch (e) {
      logError('autosave', `Restore failed: ${e instanceof Error ? e.message : String(e)}`);
      set({ busy: false });
    }
  },
  discard: async () => {
    set({ busy: true });
    try {
      await clearAutosave();
    } finally {
      set({ offer: null, busy: false });
      resumeSaving();
    }
  },
}));

// ── Multi-tab ownership (Web Locks) ──────────────────────────────────────────

let ownership: AutosaveOwnership = 'unsupported';
/** Resolves once the `ifAvailable` request has answered. `performSave` awaits
 *  it so a save can never slip through while the answer is still pending. */
let ownershipReady: Promise<void> | null = null;

/** Which role this tab plays. `unsupported` before `initEditorAutosave()`. */
export function autosaveOwnership(): AutosaveOwnership {
  return ownership;
}

function setOwnership(next: AutosaveOwnership): void {
  ownership = next;
  useAutosaveRecoveryStore.setState({ ownership: next });
}

/** Hold the lock for the life of the document: the browser releases it when
 *  the tab goes away, which is the only release this app ever wants. */
const holdForever = (): Promise<never> => new Promise<never>(() => undefined);

/** Take the autosave lock, or find out another tab already has it.
 *
 *  Two requests, because one cannot answer both questions. `ifAvailable` never
 *  queues, so it answers "can I write RIGHT NOW?" immediately — a second tab
 *  must know its role before it touches OPFS, not whenever the first tab
 *  closes. But a lone tab can lose that race too: on a same-tab RELOAD the old
 *  document's lock is released asynchronously, and the new document's
 *  `ifAvailable` request can land first and be told no. Answering only that
 *  question would leave the only tab a permanent observer, autosaving nothing
 *  for the rest of the session.
 *
 *  So an observer immediately QUEUES a second, ordinary request. It is granted
 *  when the previous holder goes away — the reload above, or the owner tab
 *  being closed — and the tab is promoted to owner and starts saving. */
function acquireOwnership(): void {
  const locks = navigator.locks;
  if (!locks || typeof locks.request !== 'function') {
    setOwnership('unsupported');
    return;
  }
  let settle: () => void = () => undefined;
  ownershipReady = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const giveUp = (): void => {
    // A lock manager that refuses (insecure context, storage partition
    // oddity) must not cost the session its autosave.
    setOwnership('unsupported');
    settle();
  };
  try {
    void locks
      .request(AUTOSAVE_LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          setOwnership('observer');
          settle();
          logInfo(
            'autosave',
            'Another theDAW tab owns autosave — this tab is recovery-only until that tab releases it.',
          );
          waitForHandover();
          return undefined;
        }
        setOwnership('owner');
        settle();
        return holdForever();
      })
      .catch(giveUp);
  } catch {
    giveUp();
  }
}

/** Queue for the lock behind whoever holds it. Granted on the holder's exit. */
function waitForHandover(): void {
  const locks = navigator.locks;
  if (!locks || typeof locks.request !== 'function') return;
  try {
    void locks
      .request(AUTOSAVE_LOCK, () => {
        if (ownership === 'owner') return holdForever();
        setOwnership('owner');
        logInfo('autosave', 'Autosave ownership handed over to this tab — saving is live again.');
        // The document has almost certainly moved while this tab was an
        // observer, and every change it made was dropped by `scheduleSave`.
        // Write the current state rather than wait for the next edit.
        scheduleSave();
        return holdForever();
      })
      .catch(() => undefined);
  } catch {
    /* stay an observer — still recoverable, just never the writer */
  }
}

// ── OPFS plumbing ────────────────────────────────────────────────────────────

async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(DIR_NAME, { create: true });
  } catch {
    return null;
  }
}

/** `move()` is a Chromium extension to the File System spec — feature-detected,
 *  never assumed. Everything here works without it. */
type MovableFileHandle = FileSystemFileHandle & { move?: (name: string) => Promise<void> };

async function readTextFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<{ text: string; lastModified: number } | null> {
  try {
    const fh = await dir.getFileHandle(name);
    const file = await fh.getFile();
    const text = await file.text();
    // Fakes and older engines may not carry a timestamp; 0 makes the tmp win a
    // tie, which is correct — a tmp only exists because it was written LAST.
    const lastModified = typeof file.lastModified === 'number' ? file.lastModified : 0;
    return { text, lastModified };
  } catch {
    return null;
  }
}

function parseManifest(text: string): AutosaveManifest | null {
  try {
    const parsed = JSON.parse(text) as AutosaveManifest;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Rename `from` to `to` inside one directory, replacing `to`. Uses `move()`
 *  when the engine has it, else copies the bytes across and drops the source —
 *  the same outcome, one write wider. */
async function renameWithin(
  dir: FileSystemDirectoryHandle,
  from: string,
  to: string,
  knownText?: string,
): Promise<void> {
  const fh = (await dir.getFileHandle(from)) as MovableFileHandle;
  if (typeof fh.move === 'function') {
    try {
      await fh.move(to);
      return;
    } catch {
      // `move()` is not specified by MDN and its behaviour when the
      // destination already exists is not something this app can verify per
      // engine. A rejection here must NOT become a failed save — that would
      // fail every save after the first and latch autosave off after three.
      // Fall through to the copy path, which has no such question.
    }
  }
  const text = knownText ?? (await (await fh.getFile()).text());
  const out = await dir.getFileHandle(to, { create: true });
  const writable = await out.createWritable();
  try {
    await writable.write(text);
  } finally {
    await writable.close();
  }
  await dir.removeEntry(from);
}

/** Move a tmp out of the read path without deleting it (project rule, and the
 *  bytes are the only evidence of what the dead session was doing).
 *
 *  `corrupt` is a tmp that does not parse — the fingerprint of a crash
 *  mid-write. `stale` is a tmp that parses but is OLDER than the committed
 *  manifest, which is litter rather than damage and must not be reported as a
 *  torn file. The stamp carries a short random tail so two quarantines in the
 *  same millisecond cannot land on one name. */
async function quarantineTmp(
  dir: FileSystemDirectoryHandle,
  text: string,
  reason: 'corrupt' | 'stale',
): Promise<void> {
  if (ownership === 'observer') return; // recovery-only tabs touch nothing
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const name = `${MANIFEST_TMP}.${reason}-${stamp}`;
  try {
    await renameWithin(dir, MANIFEST_TMP, name, text);
    if (reason === 'corrupt') {
      logWarn(
        'autosave',
        `A partially written manifest was found and set aside as ${name}; the previous autosave is intact.`,
      );
    } else {
      logInfo(
        'autosave',
        `A staged manifest older than the committed one was set aside as ${name}; nothing was lost.`,
      );
    }
  } catch {
    /* best effort — never let a quarantine failure block recovery */
  }
}

/** Read the manifest, resolving a leftover `.tmp` first.
 *
 *  A tmp exists only when a save wrote it and the promote never happened. If it
 *  PARSES it is the newer, complete manifest and is promoted; if it does not it
 *  is set aside and the committed manifest — untouched by the failed save — is
 *  what recovers. An observer tab reads the same answer without promoting. */
async function readManifest(): Promise<AutosaveManifest | null> {
  const dir = await opfsRoot();
  if (!dir) return null;

  const committed = await readTextFile(dir, MANIFEST);
  const committedManifest = committed ? parseManifest(committed.text) : null;

  const tmp = await readTextFile(dir, MANIFEST_TMP);
  if (!tmp) return committedManifest;

  const tmpManifest = parseManifest(tmp.text);
  if (!tmpManifest) {
    await quarantineTmp(dir, tmp.text, 'corrupt');
    return committedManifest;
  }
  if (committedManifest && tmp.lastModified < (committed?.lastModified ?? 0)) {
    // Older than what is already committed: not a candidate, just litter.
    await quarantineTmp(dir, tmp.text, 'stale');
    return committedManifest;
  }
  if (ownership !== 'observer') {
    try {
      await renameWithin(dir, MANIFEST_TMP, MANIFEST, tmp.text);
      logInfo('autosave', 'Promoted a leftover manifest staged by the previous session.');
    } catch {
      /* the bytes are still readable below even if the promote fails */
    }
  }
  return tmpManifest;
}

/** Content hashes are cached per Blob object — split/duplicate clips share the
 *  Blob, so each unique byte-content hashes exactly once per session. */
const hashCache = new WeakMap<Blob, Promise<string>>();

function hashBlob(blob: Blob): Promise<string> {
  let p = hashCache.get(blob);
  if (!p) {
    p = (async () => {
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    })();
    hashCache.set(blob, p);
  }
  return p;
}

async function writeAsset(
  assets: FileSystemDirectoryHandle,
  hash: string,
  blob: Blob,
): Promise<void> {
  const name = `${hash}.bin`;
  try {
    // Already stored (content-addressed: same hash == same bytes).
    await assets.getFileHandle(name);
    return;
  } catch {
    /* not present yet — write it */
  }
  const fh = await assets.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

// ── Serialization ────────────────────────────────────────────────────────────

async function serializeClip(
  clip: AudioClip,
  assets: FileSystemDirectoryHandle,
): Promise<SerializedClip> {
  const hash = await hashBlob(clip.audioBlob);
  await writeAsset(assets, hash, clip.audioBlob);
  const { audioBlob: _blob, peaks: _peaks, takes, ...rest } = clip;
  const out: SerializedClip = { ...rest, assetHash: hash };
  if (takes && takes.length > 0) {
    // The ACTIVE take is the same Blob object as the clip's own (the invariant
    // `AudioClip.takes` states), so the hash cache answers without re-reading
    // it and `writeAsset` finds the file already there: one copy per unique
    // content, exactly as for split and duplicated clips.
    out.takes = await Promise.all(
      takes.map(async (t) => {
        const takeHash = await hashBlob(t.audioBlob);
        await writeAsset(assets, takeHash, t.audioBlob);
        const { audioBlob: _takeBlob, peaks: _takePeaks, ...takeRest } = t;
        return { ...takeRest, assetHash: takeHash };
      }),
    );
  }
  return out;
}

async function buildManifest(assets: FileSystemDirectoryHandle): Promise<AutosaveManifest> {
  const s = useEditorStore.getState();
  const clips = await Promise.all(s.clips.map((c) => serializeClip(c, assets)));
  const tracks: SerializedTrack[] = await Promise.all(
    s.tracks.map(async (t) => {
      const { frozenOriginal, ...rest } = t;
      if (!frozenOriginal) return rest;
      return {
        ...rest,
        frozenOriginal: {
          clips: await Promise.all(frozenOriginal.clips.map((c) => serializeClip(c, assets))),
          fxChain: frozenOriginal.fxChain,
        },
      };
    }),
  );
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    bpm: s.bpm,
    timeSignature: { num: s.meterMap[0]?.meter.num ?? 4, den: s.meterMap[0]?.meter.den ?? 4 },
    meterMap: s.meterMap.map((m) => ({ bar: m.bar, meter: { num: m.meter.num, den: m.meter.den, groups: [...m.meter.groups] } })),
    tempoMap: copyTempoMap(s.tempoMap),
    tracks,
    clips,
    masterFxChain: s.masterFxChain as unknown[],
    masterVstChain: s.masterVstChain as unknown[],
    automationLanes: s.automationLanes as unknown[],
    markers: s.markers as unknown[],
    loop: { enabled: s.loopEnabled, startSec: s.loopStart, endSec: s.loopEnd },
    routing: s.routing,
    buses: s.buses,
  };
}

// ── Save driver ──────────────────────────────────────────────────────────────

let started = false;
let paused = true; // saving stays paused until recovery is resolved
let saveTimer: number | null = null;
let saveInFlight = false;
let saveQueued = false;
let failures = 0;
let disabled = false;

function resumeSaving(): void {
  paused = false;
}

/**
 * @param captureLive Ask every live plugin that is ahead of its stored state
 *   for a fresh one before the snapshot. FALSE only on the unload flush: that
 *   path is racing the document's death and must spend its budget on the OPFS
 *   write, not on a 750 ms round trip to a host process that is being reaped at
 *   the same moment (the registry's shutdown DELETE rescues that state instead).
 */
async function performSave(captureLive = true): Promise<void> {
  if (saveInFlight) {
    saveQueued = true;
    return;
  }
  saveInFlight = true;
  try {
    // Never write while the lock answer is still outstanding, and never at all
    // from the tab that lost it.
    if (ownershipReady) await ownershipReady;
    if (ownership === 'observer') return;
    // Ahead of the manifest, and only in the tab that will actually write it:
    // a plugin driven from the FX row with its editor closed is otherwise saved
    // at the state it held the last time an editor happened to be open. Bounded
    // and parallel, and it never rejects — see `captureLiveVstStates`.
    if (captureLive) await captureLiveVstStates();
    const dir = await opfsRoot();
    if (!dir) throw new Error('OPFS unavailable');
    const assets = await dir.getDirectoryHandle(ASSETS_DIR, { create: true });
    const manifest = await buildManifest(assets);
    // Stage, then promote: a crash anywhere before the promote leaves the
    // previous manifest.json whole and recoverable.
    const body = JSON.stringify(manifest);
    const staged = await dir.getFileHandle(MANIFEST_TMP, { create: true });
    const writable = await staged.createWritable();
    try {
      await writable.write(body);
    } finally {
      await writable.close();
    }
    await renameWithin(dir, MANIFEST_TMP, MANIFEST, body);
    await gcAssets(assets, manifest);
    failures = 0;
  } catch (e) {
    failures += 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES && !disabled) {
      disabled = true;
      logWarn(
        'autosave',
        `Autosave disabled after ${failures} failures (${e instanceof Error ? e.message : String(e)}). ` +
          'The Ctrl+S / unload guard still protects the session.',
      );
    }
  } finally {
    saveInFlight = false;
    if (saveQueued) {
      saveQueued = false;
      scheduleSave();
    }
  }
}

/** Delete asset files no clip (live or frozen) references any more. */
async function gcAssets(
  assets: FileSystemDirectoryHandle,
  manifest: AutosaveManifest,
): Promise<void> {
  const referenced = new Set<string>();
  // A clip's alternate takes are assets too — counting only the clip's own
  // would have this delete the take audio moments after writing it.
  const keep = (c: SerializedClip): void => {
    referenced.add(`${c.assetHash}.bin`);
    for (const t of c.takes ?? []) referenced.add(`${t.assetHash}.bin`);
  };
  for (const c of manifest.clips) keep(c);
  for (const t of manifest.tracks) {
    for (const c of t.frozenOriginal?.clips ?? []) keep(c);
  }
  try {
    const names: string[] = [];
    // OPFS directory iteration (async iterator of [name, handle]).
    for await (const name of (assets as unknown as { keys(): AsyncIterable<string> }).keys()) {
      names.push(name);
    }
    for (const name of names) {
      if (!referenced.has(name)) {
        await assets.removeEntry(name).catch(() => undefined);
      }
    }
  } catch {
    /* GC is best-effort */
  }
}

function scheduleSave(): void {
  if (paused || disabled || ownership === 'observer') return;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void performSave();
  }, SAVE_DEBOUNCE_MS);
}

/** Fire a pending debounced save now. Wired to beforeunload and pagehide: the
 *  2 s debounce otherwise drops the last edits on a clean close, and the
 *  Ctrl+S / unload guard only prompts, it never writes. The save is async and
 *  cannot be awaited during unload; starting it synchronously gives OPFS the
 *  best chance to land it before the document goes away. A save that is not
 *  pending (no timer) has nothing to flush. */
export function flushPendingAutosave(): void {
  if (saveTimer === null) return;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  void performSave(false);
}

// ── Recovery ─────────────────────────────────────────────────────────────────

async function restoreFromAutosave(): Promise<void> {
  const dir = await opfsRoot();
  if (!dir) throw new Error('OPFS unavailable');
  const manifest = await readManifest();
  if (!manifest) throw new Error('no autosave manifest');
  const assets = await dir.getDirectoryHandle(ASSETS_DIR, { create: true });

  const blobCache = new Map<string, Blob>();
  const loadAsset = async (hash: string, mime: string): Promise<Blob> => {
    const cached = blobCache.get(hash);
    if (cached) return cached;
    const fh = await assets.getFileHandle(`${hash}.bin`);
    const file = await fh.getFile();
    const blob = new Blob([await file.arrayBuffer()], { type: mime || 'audio/wav' });
    blobCache.set(hash, blob);
    return blob;
  };

  const reviveClip = async (sc: SerializedClip): Promise<AudioClip> => {
    const { assetHash, takes, ...rest } = sc;
    const audioBlob = await loadAsset(assetHash, sc.mimeType);
    const clip: AudioClip = { ...(rest as Omit<AudioClip, 'audioBlob' | 'takes'>), audioBlob };
    if (takes && takes.length > 0) {
      try {
        clip.takes = await Promise.all(
          takes.map(async (st): Promise<ClipTake> => {
            const { assetHash: takeHash, ...takeRest } = st;
            // `loadAsset` caches by hash, so the ACTIVE take — whose content is
            // the clip's content — comes back as the SAME Blob object the clip
            // holds. That identity is what `lib/decodeCache` keys decoded audio
            // on: without it the same bytes would decode and be cached twice.
            return { ...takeRest, audioBlob: await loadAsset(takeHash, st.mimeType) };
          }),
        );
      } catch (e) {
        // One missing asset costs this clip its takes, not the user the whole
        // recovery: the clip's OWN audio is a separate asset and is already
        // loaded, so it still comes back playing the take it was on. The comp
        // and the active index go with the list — a comp indexes takes by
        // position, so a partial list would repoint its regions at the wrong
        // recording. Same all-or-nothing-per-clip rule as `loadTakes` in
        // projectImport.ts, for the same reason.
        delete clip.takes;
        delete clip.comp;
        delete clip.activeTakeIndex;
        logWarn(
          'autosave',
          `Clip "${clip.label}": take audio missing from the autosave store — takes dropped (${
            e instanceof Error ? e.message : String(e)
          })`,
        );
      }
    }
    try {
      const { peaks } = await computePeaks(audioBlob, 240);
      clip.peaks = peaks;
      // Re-mirror onto the active take, which the clip's peaks ARE. The other
      // takes stay lazy — nothing draws one until it is selected.
      const active = clip.takes?.[clip.activeTakeIndex ?? 0];
      if (active && active.audioBlob === audioBlob) active.peaks = peaks;
    } catch {
      /* waveform re-derives lazily if decode fails here */
    }
    return clip;
  };

  const clips = await Promise.all(manifest.clips.map(reviveClip));
  const tracks: EditorTrack[] = await Promise.all(
    manifest.tracks.map(async (st) => {
      const { frozenOriginal, ...rest } = st;
      if (!frozenOriginal) return rest as EditorTrack;
      return {
        ...(rest as EditorTrack),
        frozenOriginal: {
          clips: await Promise.all(frozenOriginal.clips.map(reviveClip)),
          fxChain: frozenOriginal.fxChain ?? [],
        },
      };
    }),
  );

  const store = useEditorStore.getState();
  // routing/buses go through loadProject rather than the setState below, so the
  // ONE migration path handles them: a manifest written before routing existed
  // passes `undefined` here and is migrated exactly like an old `.tasmo`.
  //
  // The meter is passed the same way, and for the mirror-image reason: a
  // manifest with no meter predates the field, such a document is 4/4, and
  // saying so explicitly beats letting it inherit whatever meter the session
  // being replaced happened to hold.
  store.loadProject({
    tracks,
    clips,
    bpm: manifest.bpm,
    timeSignature: manifest.timeSignature ?? { num: 4, den: 4 },
    ...(Array.isArray(manifest.meterMap) && manifest.meterMap.length ? { meterMap: manifest.meterMap } : {}),
    ...(Array.isArray(manifest.tempoMap) && manifest.tempoMap.length ? { tempoMap: manifest.tempoMap } : {}),
    routing: manifest.routing,
    buses: manifest.buses,
  });
  // loadProject clears the per-project extras; put the autosaved ones back.
  // dirty stays TRUE: a restored autosave is by definition unsaved work.
  useEditorStore.setState({
    masterFxChain: manifest.masterFxChain as never,
    masterVstChain: manifest.masterVstChain as never,
    automationLanes: manifest.automationLanes as never,
    markers: manifest.markers as never,
    loopEnabled: manifest.loop.enabled,
    loopStart: manifest.loop.startSec,
    loopEnd: manifest.loop.endSec,
    dirty: true,
  });
  logInfo(
    'autosave',
    `Restored autosaved arrangement: ${tracks.length} track(s), ${clips.length} clip(s) from ${manifest.savedAt}`,
  );
  resumeSaving();
}

async function clearAutosave(): Promise<void> {
  // Recovery-only: discarding here would delete the OWNER tab's live autosave.
  // The offer is still dismissed locally by the caller.
  if (ownership === 'observer') return;
  const dir = await opfsRoot();
  if (!dir) return;
  await dir.removeEntry(MANIFEST).catch(() => undefined);
  // A staged manifest left behind would be picked up as a candidate on the next
  // start and resurrect the work the user just discarded.
  await dir.removeEntry(MANIFEST_TMP).catch(() => undefined);
  await dir.removeEntry(ASSETS_DIR, { recursive: true }).catch(() => undefined);
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Start the autosave driver + publish a recovery offer if one exists.
 *  Idempotent — safe under StrictMode double-mount. */
export function initEditorAutosave(): void {
  if (started) return;
  started = true;
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    logWarn('autosave', 'OPFS not available in this browser — editor autosave off.');
    disabled = true;
    return;
  }

  // pagehide is the reliable one (bfcache, mobile, Electron close); beforeunload
  // covers the browsers that still fire only it. Idempotent, so both may run.
  window.addEventListener('beforeunload', flushPendingAutosave);
  window.addEventListener('pagehide', flushPendingAutosave);

  // Before the first read: a leftover tmp is promoted by the OWNER only, and
  // the recovery offer below must never be answered by a write from a tab that
  // lost the lock.
  acquireOwnership();

  void (async () => {
    if (ownershipReady) await ownershipReady;
    const manifest = await readManifest();
    if (manifest && manifest.clips.length > 0) {
      useAutosaveRecoveryStore.setState({
        offer: {
          savedAt: manifest.savedAt,
          trackCount: manifest.tracks.length,
          clipCount: manifest.clips.length,
        },
      });
      // paused stays true until the user restores or discards.
    } else {
      resumeSaving();
    }
  })();

  // Document-change watcher: the same slices as undo/dirty, plus the master
  // VST chain and loop region (project state that history deliberately skips).
  useEditorStore.subscribe((state, prev) => {
    if (
      state.tracks === prev.tracks &&
      state.clips === prev.clips &&
      state.masterFxChain === prev.masterFxChain &&
      state.masterVstChain === prev.masterVstChain &&
      state.automationLanes === prev.automationLanes &&
      state.markers === prev.markers &&
      state.bpm === prev.bpm &&
      state.tempoMap === prev.tempoMap &&
      state.meterMap === prev.meterMap &&
      state.loopEnabled === prev.loopEnabled &&
      state.loopStart === prev.loopStart &&
      state.loopEnd === prev.loopEnd &&
      state.routing === prev.routing &&
      state.buses === prev.buses
    ) {
      return;
    }
    scheduleSave();
  });
}
