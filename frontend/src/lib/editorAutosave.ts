/**
 * EDIT autosave + crash recovery on a content-addressed OPFS asset layer.
 *
 * The arrangement's JSON side (tracks, clips minus bytes, FX chains,
 * automation, markers, bpm, loop) is written to
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
 */
import { create } from 'zustand';
import {
  useEditorStore,
  computePeaks,
  type AudioClip,
  type EditorTrack,
} from '../state/editorStore';
import { logError, logInfo, logWarn } from '../state/logStore';

const DIR_NAME = 'thedaw-editor-autosave';
const ASSETS_DIR = 'assets';
const MANIFEST = 'manifest.json';
const SAVE_DEBOUNCE_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 3;

// ── Serialized shapes ────────────────────────────────────────────────────────

type SerializedClip = Omit<AudioClip, 'audioBlob' | 'peaks'> & {
  assetHash: string;
};

type SerializedTrack = Omit<EditorTrack, 'frozenOriginal'> & {
  frozenOriginal?: { clips: SerializedClip[]; fxChain: EditorTrack['fxChain'] };
};

interface AutosaveManifest {
  version: 1;
  savedAt: string;
  bpm: number;
  tracks: SerializedTrack[];
  clips: SerializedClip[];
  masterFxChain: unknown[];
  masterVstChain: unknown[];
  automationLanes: unknown[];
  markers: unknown[];
  loop: { enabled: boolean; startSec: number; endSec: number };
}

// ── Recovery offer store (drives the Shell notice) ───────────────────────────

export interface AutosaveRecoveryInfo {
  savedAt: string;
  trackCount: number;
  clipCount: number;
}

interface AutosaveRecoveryState {
  offer: AutosaveRecoveryInfo | null;
  busy: boolean;
  restore: () => Promise<void>;
  discard: () => Promise<void>;
}

export const useAutosaveRecoveryStore = create<AutosaveRecoveryState>((set) => ({
  offer: null,
  busy: false,
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

async function readManifest(): Promise<AutosaveManifest | null> {
  const dir = await opfsRoot();
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(MANIFEST);
    const file = await fh.getFile();
    const parsed = JSON.parse(await file.text()) as AutosaveManifest;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
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
  const { audioBlob: _blob, peaks: _peaks, ...rest } = clip;
  return { ...rest, assetHash: hash };
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
    tracks,
    clips,
    masterFxChain: s.masterFxChain as unknown[],
    masterVstChain: s.masterVstChain as unknown[],
    automationLanes: s.automationLanes as unknown[],
    markers: s.markers as unknown[],
    loop: { enabled: s.loopEnabled, startSec: s.loopStart, endSec: s.loopEnd },
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

async function performSave(): Promise<void> {
  if (saveInFlight) {
    saveQueued = true;
    return;
  }
  saveInFlight = true;
  try {
    const dir = await opfsRoot();
    if (!dir) throw new Error('OPFS unavailable');
    const assets = await dir.getDirectoryHandle(ASSETS_DIR, { create: true });
    const manifest = await buildManifest(assets);
    const fh = await dir.getFileHandle(MANIFEST, { create: true });
    const writable = await fh.createWritable();
    try {
      await writable.write(JSON.stringify(manifest));
    } finally {
      await writable.close();
    }
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
  for (const c of manifest.clips) referenced.add(`${c.assetHash}.bin`);
  for (const t of manifest.tracks) {
    for (const c of t.frozenOriginal?.clips ?? []) referenced.add(`${c.assetHash}.bin`);
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
  if (paused || disabled) return;
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void performSave();
  }, SAVE_DEBOUNCE_MS);
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
    const { assetHash, ...rest } = sc;
    const audioBlob = await loadAsset(assetHash, sc.mimeType);
    const clip: AudioClip = { ...(rest as Omit<AudioClip, 'audioBlob'>), audioBlob };
    try {
      const { peaks } = await computePeaks(audioBlob, 240);
      clip.peaks = peaks;
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
  store.loadProject({ tracks, clips, bpm: manifest.bpm });
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
  const dir = await opfsRoot();
  if (!dir) return;
  await dir.removeEntry(MANIFEST).catch(() => undefined);
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

  void (async () => {
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
      state.loopEnabled === prev.loopEnabled &&
      state.loopStart === prev.loopStart &&
      state.loopEnd === prev.loopEnd
    ) {
      return;
    }
    scheduleSave();
  });
}
