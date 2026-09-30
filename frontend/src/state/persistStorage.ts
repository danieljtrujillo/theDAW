/**
 * The storage every persisted zustand store writes through.
 *
 * zustand's default `persist` storage is `window.localStorage`, resolved once
 * when the store is created. When that access throws (a private window, site
 * data blocked, a sandboxed frame) or there is no `window` at all (node, the
 * test runner), `persist` is left with no storage and prints
 * "the given storage is currently unavailable" on every single `setState`,
 * while the setting it was asked to keep is dropped.
 *
 * This backend resolves the real storage on EVERY call, so a storage that
 * appears later (a test installing a shim, a frame gaining access) is used
 * from then on. When localStorage is missing, or an access or write throws,
 * the value goes to an in-memory map instead: the setting stays live for the
 * session and resets on reload, and the LOG says so once.
 *
 * Reads prefer the in-memory copy of a key, because a key lands there only
 * when the localStorage write for it failed, which makes it the newer value.
 * A later successful localStorage write for that key drops the memory copy.
 */
import { createJSONStorage, type PersistStorage, type StateStorage } from 'zustand/middleware';
import { logWarn } from './logStore';

/** The synchronous subset of `Storage` that `persist` needs. */
export interface SyncStateStorage extends StateStorage {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => void;
  removeItem: (name: string) => void;
}

const memory = new Map<string, string>();
let fallbackAnnounced = false;

/** The LOG line written the first time a value has to stay in memory. */
export const MEMORY_FALLBACK_LOG =
  'Browser storage is unavailable (private window or blocked site data), so settings are kept in memory for this session and reset on reload.';

function announceFallback(reason: unknown): void {
  if (fallbackAnnounced) return;
  fallbackAnnounced = true;
  const detail = reason instanceof Error && reason.message ? ` (${reason.name}: ${reason.message})` : '';
  logWarn('storage', `${MEMORY_FALLBACK_LOG}${detail}`);
}

/** `storage` is the usable localStorage, or null with `reason` saying why. */
interface Resolved {
  storage: Storage | null;
  reason: unknown;
}

/** The browser's localStorage right now, or why there is none. Never throws. */
function resolveLocalStorage(): Resolved {
  try {
    const g = globalThis as { localStorage?: Storage; window?: { localStorage?: Storage } };
    const storage = g.localStorage ?? g.window?.localStorage;
    if (storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function') {
      return { storage, reason: null };
    }
    return { storage: null, reason: new Error('localStorage is not available') };
  } catch (err) {
    // Reading `localStorage` itself throws a SecurityError when site data is blocked.
    return { storage: null, reason: err };
  }
}

/**
 * Write one value. Returns the error when localStorage exists but refused the
 * write (full, or denied mid-session), null otherwise. The value is always kept:
 * in localStorage when the write succeeds, in memory when it does not.
 */
function writeItem(name: string, value: string): unknown {
  const r = resolveLocalStorage();
  if (r.storage) {
    try {
      r.storage.setItem(name, value);
      memory.delete(name);
      return null;
    } catch (err) {
      // Full (QuotaExceededError) or refused: keep the value for the session.
      announceFallback(err);
      memory.set(name, value);
      return err;
    }
  }
  announceFallback(r.reason);
  memory.set(name, value);
  return null;
}

export const persistBackend: SyncStateStorage = {
  getItem: (name) => {
    const inMemory = memory.get(name);
    if (inMemory !== undefined) return inMemory;
    const r = resolveLocalStorage();
    if (!r.storage) {
      announceFallback(r.reason);
      return null;
    }
    try {
      return r.storage.getItem(name);
    } catch (err) {
      announceFallback(err);
      return null;
    }
  },
  setItem: (name, value) => {
    writeItem(name, value);
  },
  removeItem: (name) => {
    memory.delete(name);
    const r = resolveLocalStorage();
    if (!r.storage) return;
    try {
      r.storage.removeItem(name);
    } catch (err) {
      announceFallback(err);
    }
  },
};

/**
 * The same backend, except that a write localStorage refused (full, or denied
 * mid-session) is thrown after the value is kept in memory. For a store that
 * reports each failed save to the user itself (the MIX effect chain, whose VST
 * states must never be lost unnoticed). A missing localStorage never throws:
 * that is announced once in the LOG like every other store.
 */
export const reportingPersistBackend: SyncStateStorage = {
  getItem: (name) => persistBackend.getItem(name),
  setItem: (name, value) => {
    const err = writeItem(name, value);
    if (err) throw err;
  },
  removeItem: (name) => persistBackend.removeItem(name),
};

export interface PersistStorageOptions {
  /** Throw a refused localStorage write to the caller of `set` (see
   *  {@link reportingPersistBackend}). Default false: every write is absorbed. */
  reportWriteErrors?: boolean;
}

/**
 * The `storage` option for a `persist` store: JSON over {@link persistBackend}.
 * `createJSONStorage` never returns `undefined` here because its getter
 * cannot throw.
 */
export function persistStorage<S>(options: PersistStorageOptions = {}): PersistStorage<S> {
  const backend = options.reportWriteErrors ? reportingPersistBackend : persistBackend;
  const storage = createJSONStorage<S>(() => backend);
  if (!storage) throw new Error('persistStorage: createJSONStorage returned no storage');
  return storage;
}

/** Test seam: forget the in-memory values and the one-time LOG notice. */
export function resetPersistMemoryForTests(): void {
  memory.clear();
  fallbackAnnounced = false;
}
