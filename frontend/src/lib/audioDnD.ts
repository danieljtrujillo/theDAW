/**
 * Session-scoped registry for dragging audio between in-app surfaces
 * (Library, Media Bucket, Editor, Chimera stack) without serializing the
 * blob through HTML5 dataTransfer.
 *
 * Pattern:
 *   - Drag source calls `setAudioDragData(event, items)` in onDragStart.
 *     Each entry is registered with either a ready Blob or a Blob-producing
 *     async fetcher (used by Library where the audio lives at a URL).
 *     Only a short id (+ label, mime) is written to dataTransfer.
 *   - Drop target calls `await readAudioDragData(event)` in onDrop. The
 *     registry resolves any deferred fetchers and returns concrete blobs.
 *   - The registry is held in module state for the page session. Entries
 *     auto-expire after REGISTRY_TTL_MS so we don't leak Blobs forever.
 */

export const AUDIO_REF_MIME = 'application/x-thedaw-audio-ref';

export interface AudioDragItem {
  blob: Blob;
  mimeType: string;
  label: string;
  /** Library entry id when the drag originated from a library row. */
  entryId?: string;
}

export type AudioDragInput =
  | { blob: Blob; mimeType: string; label: string; entryId?: string }
  | { fetcher: () => Promise<Blob>; mimeType: string; label: string; entryId?: string };

interface RegistryEntry {
  blob?: Blob;
  fetcher?: () => Promise<Blob>;
  mimeType: string;
  label: string;
  entryId?: string;
  expiresAt: number;
}

const REGISTRY_TTL_MS = 60_000;

const _registry = new Map<string, RegistryEntry>();

const _newId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `audio-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const _sweepExpired = (): void => {
  const now = Date.now();
  for (const [id, entry] of _registry) {
    if (entry.expiresAt < now) _registry.delete(id);
  }
};

export const setAudioDragData = (
  event: React.DragEvent<HTMLElement> | DragEvent,
  items: AudioDragInput[],
): void => {
  if (items.length === 0) return;
  _sweepExpired();
  const refs = items.map((item) => {
    const id = _newId();
    _registry.set(id, {
      blob: 'blob' in item ? item.blob : undefined,
      fetcher: 'fetcher' in item ? item.fetcher : undefined,
      mimeType: item.mimeType,
      label: item.label,
      entryId: item.entryId,
      expiresAt: Date.now() + REGISTRY_TTL_MS,
    });
    return { id, mimeType: item.mimeType, label: item.label };
  });
  const dt = (event as DragEvent).dataTransfer;
  if (!dt) return;
  dt.setData(AUDIO_REF_MIME, JSON.stringify(refs));
  dt.effectAllowed = 'copyMove';
};

export const hasAudioDragData = (event: React.DragEvent<HTMLElement> | DragEvent): boolean => {
  const dt = (event as DragEvent).dataTransfer;
  if (!dt) return false;
  return Array.from(dt.types).includes(AUDIO_REF_MIME);
};

export const readAudioDragData = async (
  event: React.DragEvent<HTMLElement> | DragEvent,
): Promise<AudioDragItem[]> => {
  const dt = (event as DragEvent).dataTransfer;
  if (!dt) return [];
  const raw = dt.getData(AUDIO_REF_MIME);
  if (!raw) return [];
  let refs: Array<{ id: string; mimeType: string; label: string }>;
  try {
    refs = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(refs)) return [];
  const items: AudioDragItem[] = [];
  for (const ref of refs) {
    const entry = _registry.get(ref.id);
    if (!entry) continue;
    let blob: Blob | null = entry.blob ?? null;
    if (!blob && entry.fetcher) {
      try {
        blob = await entry.fetcher();
      } catch {
        blob = null;
      }
    }
    if (blob) {
      items.push({ blob, mimeType: entry.mimeType, label: entry.label, entryId: entry.entryId });
    }
    _registry.delete(ref.id);
  }
  return items;
};

