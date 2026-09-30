/**
 * One object URL per Blob, shared by every mounted consumer of that Blob.
 *
 * The EDIT timeline's clip waveforms used to mint a fresh `blob:` URL on
 * every mount. The waveform decode cache (`lib/djAudioCache`) is keyed by
 * URL, so every remount of a clip — a re-render with new keys, a track moved,
 * React StrictMode's double mount — was a cache miss: another fetch, another
 * decode, and a new entry that pushed the DJ decks' buffers out of the
 * four-slot cache while the old key was never read again. Two clips cut from
 * the same source Blob also decoded it twice.
 *
 * Here a Blob keeps one URL while anything holds it. When the last holder
 * releases, the URL is revoked after {@link OBJECT_URL_GRACE_MS}, so a
 * remount inside that window (StrictMode's mount -> cleanup -> remount among
 * them) gets the SAME, still-live URL instead of a revoked one.
 */

/** How long a released URL outlives its last holder. */
export const OBJECT_URL_GRACE_MS = 3000;

type Entry = { url: string; holders: number; revokeTimer: ReturnType<typeof setTimeout> | null };

const entries = new Map<Blob, Entry>();

/**
 * The object URL for `blob`, and the release that gives it back. Calling the
 * release more than once is harmless.
 */
export function acquireObjectUrl(blob: Blob): { url: string; release: () => void } {
  let entry = entries.get(blob);
  if (!entry) {
    entry = { url: URL.createObjectURL(blob), holders: 0, revokeTimer: null };
    entries.set(blob, entry);
  }
  if (entry.revokeTimer !== null) {
    clearTimeout(entry.revokeTimer);
    entry.revokeTimer = null;
  }
  entry.holders += 1;
  const held = entry;
  let released = false;
  return {
    url: held.url,
    release: () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders > 0) return;
      held.revokeTimer = setTimeout(() => {
        held.revokeTimer = null;
        if (held.holders > 0 || entries.get(blob) !== held) return;
        entries.delete(blob);
        try {
          URL.revokeObjectURL(held.url);
        } catch {
          /* already revoked */
        }
      }, OBJECT_URL_GRACE_MS);
    },
  };
}

/** How many Blobs hold a live URL right now. Introspection for tests. */
export function liveObjectUrlCount(): number {
  return entries.size;
}
