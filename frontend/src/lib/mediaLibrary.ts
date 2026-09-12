/**
 * Client for the library's media (video / image) endpoints, plus the cover-art
 * routes that produce the other images the library shows.
 *
 * The audio library flows through the StorageProvider abstraction
 * (`backendLocalProvider`), which is audio-centric and has cloud-provider
 * implications. Media is a separate concern with its own small surface,
 * so it talks to `/api/library/import-media` and `?kind=media` directly
 * rather than widening that interface. Cover art lives here for the same
 * reason: it is picture plumbing, not part of the audio storage contract.
 */

import type { LibraryEntry } from '../state/libraryEntry';

const BASE = '/api/library';

interface ServerMediaRecord {
  id: string;
  title: string;
  prompt: string;
  duration: number;
  audio_url: string;
  audio_filename: string;
  file_size_bytes: number;
  mime_type: string;
  timestamp: string;
  favorite: boolean;
  tags: string[];
  notes: string;
  source: string;
  kind?: 'audio' | 'video' | 'image';
  media_url?: string;
  thumb_url?: string | null;
  cover_url?: string | null;
  width?: number | null;
  height?: number | null;
  has_alpha?: boolean;
}

const toEntry = (r: ServerMediaRecord): LibraryEntry => ({
  id: r.id,
  title: r.title,
  prompt: r.prompt ?? '',
  negativePrompt: '',
  model: '',
  duration: r.duration ?? 0,
  steps: 0,
  cfg: 0,
  seed: 0,
  audioUrl: r.audio_url,
  audioFilename: r.audio_filename,
  fileSizeBytes: r.file_size_bytes ?? 0,
  mimeType: r.mime_type ?? '',
  timestamp: r.timestamp ?? '',
  favorite: !!r.favorite,
  rating: null,
  tags: r.tags ?? [],
  notes: r.notes ?? '',
  lyrics: '',
  source: 'import',
  kind: r.kind ?? 'video',
  mediaUrl: r.media_url ?? r.audio_url,
  thumbUrl: r.thumb_url ?? null,
  // Media entries poster themselves via thumbUrl; the field is carried anyway
  // so one LibraryEntry shape survives both endpoints.
  coverUrl: r.cover_url ?? null,
  width: r.width ?? null,
  height: r.height ?? null,
  hasAlpha: !!r.has_alpha,
});

const errorText = async (r: Response): Promise<string> => {
  try {
    const body = (await r.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') return body.detail;
    if (body?.detail) return JSON.stringify(body.detail);
  } catch {
    /* fall through */
  }
  return `HTTP ${r.status} ${r.statusText}`;
};

/** List media entries (video + image), newest first. */
export async function listMedia(): Promise<LibraryEntry[]> {
  const r = await fetch(`${BASE}/entries?kind=media`);
  if (!r.ok) throw new Error(`media.list: ${await errorText(r)}`);
  const body = (await r.json()) as { entries: ServerMediaRecord[] };
  return (body.entries ?? []).map(toEntry);
}

/** Upload a single video/image file and return its new library entry. */
export async function importMedia(
  file: File,
  metadata: Record<string, unknown> = {},
): Promise<LibraryEntry> {
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('metadata', JSON.stringify(metadata));
  const r = await fetch(`${BASE}/import-media`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`media.import(${file.name}): ${await errorText(r)}`);
  return toEntry((await r.json()) as ServerMediaRecord);
}

/** Delete a media entry (shares the entries DELETE route). */
export async function deleteMedia(id: string): Promise<void> {
  const r = await fetch(`${BASE}/entries/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`media.delete(${id}): ${await errorText(r)}`);
  }
}

/** Add a local folder of audio as a playlist, REFERENCE-IN-PLACE — nothing is
 *  copied; theDAW registers entries that point at the on-disk files. With no
 *  path, the backend opens a native folder picker. Returns the registered
 *  entries (id + title) for the caller to build a setlist from. */
export async function importFolder(
  path?: string,
): Promise<{ cancelled: boolean; folder: string | null; name?: string; entries: { id: string; title: string }[] }> {
  const r = await fetch(`${BASE}/import-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(path ? { path } : {}),
  });
  if (!r.ok) throw new Error(`importFolder: ${await errorText(r)}`);
  return (await r.json()) as {
    cancelled: boolean;
    folder: string | null;
    name?: string;
    entries: { id: string; title: string }[];
  };
}

/** Counts one cover backfill pass returns. */
export interface CoverBackfillResult {
  scanned: number;
  written: number;
  skipped: number;
  no_cover: number;
}

/** Give already-imported entries the artwork their files carry. Idempotent —
 *  entries that already have a cover are left alone unless `overwrite`. */
export async function backfillCoverArt(overwrite = false): Promise<CoverBackfillResult> {
  const r = await fetch(`${BASE}/covers/backfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overwrite }),
  });
  if (!r.ok) throw new Error(`covers.backfill: ${await errorText(r)}`);
  return (await r.json()) as CoverBackfillResult;
}

/** Attach or refresh ONE entry's cover: the given image, or (with no image)
 *  whatever picture is embedded in the entry's audio file. Returns the cover
 *  URL. Rejects when the track has no usable art. */
export async function refreshCoverArt(id: string, image?: File): Promise<string> {
  const init: RequestInit = { method: 'POST' };
  if (image) {
    const form = new FormData();
    form.append('file', image, image.name);
    init.body = form;
  }
  const r = await fetch(`${BASE}/audio/${encodeURIComponent(id)}/cover`, init);
  if (!r.ok) throw new Error(`covers.refresh(${id}): ${await errorText(r)}`);
  return ((await r.json()) as { cover_url: string }).cover_url;
}

/** The MIME types the media import input accepts. */
export const MEDIA_ACCEPT =
  'video/*,image/*,.mp4,.webm,.mov,.mkv,.m4v,.avi,.ogv,.png,.webp,.gif,.jpg,.jpeg,.bmp,.avif,.apng';

/** The extensions in MEDIA_ACCEPT, lower-case, without the dot. */
const MEDIA_EXTS = new Set(
  MEDIA_ACCEPT.split(',').filter((t) => t.startsWith('.')).map((t) => t.slice(1).toLowerCase()),
);

/**
 * Mime OR extension, the way `isAudioFile` works for audio: Windows hands many
 * files over with an empty mime type, and a mime-only check would drop a .mov.
 */
export const isMediaFile = (file: File): boolean => {
  if (file.type.startsWith('video/') || file.type.startsWith('image/')) return true;
  const dot = file.name.lastIndexOf('.');
  return dot > 0 && MEDIA_EXTS.has(file.name.slice(dot + 1).toLowerCase());
};
