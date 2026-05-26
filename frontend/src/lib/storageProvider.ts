/**
 * Storage provider abstraction.
 *
 * The library used to keep blobs in IndexedDB / Cache API. That model
 * hits browser quota on large WAV outputs and is the wrong layer for
 * persistent audio storage anyway. Now every library entry lives on
 * the server (or, eventually, on a user-selected cloud target) and the
 * frontend only holds metadata + a URL.
 *
 * `StorageProvider` is the interface every backing store implements:
 *
 *   - `BackendLocalProvider` — talks to `/api/library/*` (default; this
 *     turn). Audio lives in the project's `data/generations/` folder.
 *   - Future providers (e.g. `S3Provider`, `DriveProvider`) plug in here
 *     without any consumer change.
 *
 * Consumers go through the provider exclusively. The library Zustand
 * store wraps the provider and adds React reactivity.
 */

import type { LibraryEntry, LibraryEntryPatch, ImportRequest } from '../state/libraryEntry';

export interface StorageProvider {
  /** Pretty name for logs/UI. */
  readonly name: string;

  /** Fetch all entries. */
  list(): Promise<LibraryEntry[]>;

  /** Fetch a single entry by id, or null if missing. */
  get(id: string): Promise<LibraryEntry | null>;

  /** Upload an audio blob, returning the persisted entry. */
  import(req: ImportRequest): Promise<LibraryEntry>;

  /** Mutate the user-editable fields of an existing entry. */
  update(id: string, patch: LibraryEntryPatch): Promise<LibraryEntry>;

  /** Remove an entry (audio + metadata). */
  delete(id: string): Promise<void>;

  /**
   * Synchronous accessor for a URL the browser can stream the audio from.
   * Used by `<audio>` elements and download anchors so we don't have to
   * round-trip the bytes for every play.
   */
  getAudioUrl(entry: LibraryEntry): string;

  /**
   * Fetch the raw blob for code paths that need bytes (send-to-editor,
   * send-to-Chimera, send-to-init, peak computation, etc.).
   * Providers may cache per session.
   */
  fetchAudioBlob(entry: LibraryEntry): Promise<Blob>;
}
