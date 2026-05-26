/**
 * Shared `LibraryEntry` types. Kept in their own module so both the
 * Zustand `libraryStore` and the `StorageProvider` interface can import
 * them without circular-dependency pain.
 */

export interface LibraryEntry {
  id: string;
  title: string;
  prompt: string;
  negativePrompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  /**
   * URL the browser can fetch/stream the audio from. Backed by the
   * configured storage provider (default: `/api/library/audio/<id>`).
   * No `audioBlob` field — bytes are fetched on demand via the provider.
   */
  audioUrl: string;
  audioFilename: string;
  fileSizeBytes: number;
  mimeType: string;
  timestamp: string;
  favorite: boolean;
  rating: 'like' | 'dislike' | null;
  tags: string[];
  notes: string;
  source: 'generate' | 'studio' | 'import';
  chimeraSources?: string[];
}

/** Subset of fields a client is allowed to PATCH. Must match the
 * backend's USER_MUTABLE_FIELDS set in `backend/modules/library/store.py`. */
export interface LibraryEntryPatch {
  title?: string;
  favorite?: boolean;
  rating?: 'like' | 'dislike' | null;
  tags?: string[];
  notes?: string;
  chimeraSources?: string[];
}

/** Payload for uploading a new entry (studio output, bucket import, etc). */
export interface ImportRequest {
  blob: Blob;
  filename: string;
  mimeType?: string;
  metadata?: {
    title?: string;
    prompt?: string;
    negativePrompt?: string;
    model?: string;
    duration?: number;
    steps?: number;
    cfg?: number;
    seed?: number;
    source?: 'generate' | 'studio' | 'import';
    tags?: string[];
    chimeraSources?: string[];
  };
}
