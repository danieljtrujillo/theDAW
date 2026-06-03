import { useLibraryStore } from '../state/libraryStore';
import type { LibraryEntry } from '../state/libraryStore';
import { logError, logInfo } from '../state/logStore';

/* Online import — the same backend the Media tab uses (`/api/ytimport/fetch`:
 * YouTube / SoundCloud / Bandcamp → best-audio Opus) — but routed straight
 * into the library so it shows up immediately in any Library-backed browser
 * (e.g. the DJ Source Tree). Spotify is DRM-locked and will be rejected by
 * the backend. Throws with the backend's `detail` message on failure. */
export async function importUrlToLibrary(url: string): Promise<LibraryEntry> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('Empty URL');
  logInfo('online-import', `Fetching ${trimmed}`);

  const res = await fetch('/api/ytimport/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: trimmed }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.detail) detail = j.detail; } catch { /* non-JSON body — keep status */ }
    throw new Error(detail);
  }

  const blob = await res.blob();
  const titleHdr = res.headers.get('X-Title');
  const fnameHdr = res.headers.get('X-Filename');
  const title = titleHdr ? decodeURIComponent(titleHdr) : 'import';
  const filename = fnameHdr ? decodeURIComponent(fnameHdr) : `${title}.opus`;
  const mimeType = blob.type || 'audio/ogg';

  // Best-effort duration for the library card (decode is off-thread).
  let duration = 0;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    const decoded = await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0));
    duration = decoded.duration;
    await ctx.close();
  } catch { /* duration is non-critical */ }

  const entry = await useLibraryStore.getState().importEntry({
    blob, filename, mimeType,
    metadata: {
      title,
      prompt: 'Imported from online URL',
      model: 'imported',
      duration,
      source: 'import',
      tags: ['imported', 'online'],
    },
  });
  logInfo('online-import', `Imported "${title}" into library`);
  return entry;
}

/** Fire-and-log wrapper for callers that don't need the entry back. */
export async function importUrlToLibrarySafe(url: string): Promise<LibraryEntry | null> {
  try { return await importUrlToLibrary(url); }
  catch (e) { logError('online-import', `URL import failed: ${e instanceof Error ? e.message : String(e)}`); return null; }
}
