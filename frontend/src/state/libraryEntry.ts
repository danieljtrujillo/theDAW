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
  /**
   * Plain lyrics text (the user's editable copy). Mirrors the backend's
   * `meta["lyrics"]`; Suno imports surface theirs here automatically and the
   * lyrics module keeps it in sync with the timed `lyrics.json` document.
   * Always a string ('' when none).
   */
  lyrics: string;
  source: 'generate' | 'studio' | 'import';
  /**
   * The service the audio actually came from, detected by the backend from the
   * file's own embedded metadata: a stable lowercase slug ('suno', 'udio',
   * 'bandcamp', …). Null/undefined when nothing in the file identified an
   * origin — which is the normal case for theDAW's own generations.
   *
   * Orthogonal to `source`, which stays 'generate' | 'studio' | 'import' and
   * says how the entry entered the library, not who made the audio.
   */
  provider?: string | null;
  /** Display name for `provider`, e.g. 'Suno'. */
  providerLabel?: string | null;
  /** True when the provider is an AI generation service (vs a store/host). */
  providerIsAi?: boolean | null;
  /** The provider's own track id, when the file carried one. */
  providerId?: string | null;
  chimeraSources?: string[];
  /** Persistent play counter, incremented when the track starts in the player. */
  playCount?: number;
  /** Unix seconds of the last play, or null when never played. */
  lastPlayedAt?: number | null;
  /**
   * Media kind. 'audio' is the default and original citizen. 'video' and
   * 'image' entries back the VJ video library + overlays; they carry
   * `mediaUrl` / `thumbUrl` / dimensions / `hasAlpha` instead of audio
   * analysis. `audioUrl` falls back to the media URL for these so generic
   * consumers never see an empty URL. 'score' is a composition: a score with
   * no recording (an imported score file or music21 corpus piece), whose
   * notation artifacts are the whole entry; its `audioUrl` is empty.
   */
  kind?: 'audio' | 'video' | 'image' | 'score';
  mediaUrl?: string;
  thumbUrl?: string | null;
  /**
   * Album/track artwork, extracted from the audio file's embedded picture at
   * import (`/api/library/audio/<id>/cover`). Null when the track shipped
   * without art — the presence is on the record precisely so the UI can draw
   * its placeholder without probing the route for a 404.
   */
  coverUrl?: string | null;
  width?: number | null;
  height?: number | null;
  /** True for transparent PNG/WebP or alpha WebM — overlay-capable media. */
  hasAlpha?: boolean;
  /**
   * Computed musical analysis attached by the backend list/get endpoints when
   * the entry has been analyzed: a FLAT scalar dict (bpm, key, scale,
   * loudness_lufs, rms_db, pitch_*, bars_estimated, genre, semantic_tags, plus
   * a few ffprobe technicals like sample_rate/codec). Undefined until the
   * background analyzer has run. The Catalogue inspector renders every key and
   * `libraryStore.getFiltered` folds the values into its search haystack — both
   * already read this field; it was simply never populated before.
   */
  analysis?: Record<string, unknown>;
  /**
   * Tags embedded INSIDE the audio file (ID3 / Vorbis / iTunes), parsed from
   * the stored analysis row's `embedded_tags_json`. Undefined when the source
   * file carried none (typical for freshly-generated tracks). Surfaced
   * key-by-key in the inspector's EMBEDDED TAGS section.
   */
  embeddedTags?: Record<string, unknown>;
}

/**
 * True when an entry is audio. `kind` is optional and an entry without one is
 * audio, the library's original citizen, so every audio-only list asks here
 * and never compares `kind` to 'audio' directly.
 */
export const isAudioEntry = (entry: Pick<LibraryEntry, 'kind'>): boolean => (entry.kind ?? 'audio') === 'audio';

/** Subset of fields a client is allowed to PATCH. Must match the
 * backend's USER_MUTABLE_FIELDS set in `backend/modules/library/store.py`. */
export interface LibraryEntryPatch {
  title?: string;
  favorite?: boolean;
  rating?: 'like' | 'dislike' | null;
  tags?: string[];
  notes?: string;
  lyrics?: string; // must match backend USER_MUTABLE_FIELDS
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

