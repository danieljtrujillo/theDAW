/**
 * Client for the library's media (video / image) endpoints.
 *
 * The audio library flows through the StorageProvider abstraction
 * (`backendLocalProvider`), which is audio-centric and has cloud-provider
 * implications. Media is a separate concern with its own small surface,
 * so it talks to `/api/library/import-media` and `?kind=media` directly
 * rather than widening that interface.
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
  source: 'import',
  kind: r.kind ?? 'video',
  mediaUrl: r.media_url ?? r.audio_url,
  thumbUrl: r.thumb_url ?? null,
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

/** The MIME types the media import input accepts. */
export const MEDIA_ACCEPT =
  'video/*,image/*,.mp4,.webm,.mov,.mkv,.m4v,.avi,.ogv,.png,.webp,.gif,.jpg,.jpeg,.bmp,.avif,.apng';
