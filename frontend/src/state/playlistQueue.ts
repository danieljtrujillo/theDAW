/**
 * Sequential play queue for the library and the playlist suggester. Plays a
 * list of library entry ids through the global player, advancing when a track
 * ends.
 *
 * Repeat mode decides what "ends" means: 'one' loops the <audio> element
 * natively so the queue never advances, 'all' wraps at the end of the list,
 * and 'off' stops there. The queue no longer forces loop off while it runs --
 * it used to, which is why starting a list silently clobbered the user's loop
 * setting and why playing a track from the library played only that track.
 *
 * ── Paging ────────────────────────────────────────────────────────────────
 * The library store holds only a WINDOW of a 200,000-row result set, so an id
 * queued a minute ago routinely names a row whose page the LRU has since
 * dropped. A queue is therefore a list of IDS, and every play re-resolves its
 * id: the loaded pages first (`getById`), then the store's cached single-entry
 * fetch (`ensureEntry`). An id the library genuinely no longer has is skipped
 * with a line in the log — silence there is what made a half-playing queue
 * look like a broken player.
 */
import { usePlayerStore, setQueueOnEnded } from './playerStore';
import { useLibraryStore, type LibraryEntry } from './libraryStore';
import { logInfo, logWarn } from './logStore';

let _queue: string[] = [];
let _pos = -1;
/** Ids already reported missing, so one dead track is one message. */
let _reportedMissing = new Set<string>();

/**
 * The row behind a queued id, wherever it lives: a loaded page, the store's
 * by-id cache, or one single-entry request. Null when the library has no such
 * entry any more (deleted, or filtered out of existence).
 */
const resolveEntry = async (id: string): Promise<LibraryEntry | null> => {
  const cached = useLibraryStore.getState().getById(id);
  if (cached) return cached;
  return useLibraryStore.getState().ensureEntry(id);
};

const playId = async (id: string): Promise<boolean> => {
  const entry = await resolveEntry(id);
  if (!entry) {
    // Loud, not silent: the user asked for N tracks and is getting fewer.
    if (!_reportedMissing.has(id)) {
      _reportedMissing.add(id);
      logWarn('library', `Skipped a queued track that is no longer in the library (${id})`);
    }
    return false;
  }
  try {
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    await usePlayerStore.getState().load(blob, { label: entry.title, entryId: entry.id });
    usePlayerStore.getState().play();
    useLibraryStore.getState().setPlayingId(entry.id);
    return true;
  } catch (e) {
    if (!_reportedMissing.has(id)) {
      _reportedMissing.add(id);
      logWarn(
        'library',
        `Skipped "${entry.title}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return false;
  }
};

/**
 * Move to the next playable track. This is what the player calls when a track
 * ends; it is exported so a "next" control (and the tests) can drive the queue
 * without reaching into the transport.
 */
export const advanceQueue = async (): Promise<void> => {
  const wrap = usePlayerStore.getState().repeatMode === 'all';
  // A track that fails to load is skipped; the guard counts attempts so a
  // wrapping queue of entirely unloadable tracks cannot spin forever.
  for (let tried = 0; tried < _queue.length; tried += 1) {
    _pos += 1;
    if (_pos >= _queue.length) {
      if (!wrap) break;
      _pos = 0;
    }
    if (await playId(_queue[_pos])) return;
  }
  stopQueue();
};

/** Play `ids` in order, starting at `startIndex`, advancing track to track. */
export const startQueue = async (ids: string[], startIndex = 0): Promise<void> => {
  if (ids.length === 0) return;
  _queue = ids.slice();
  _pos = Math.max(0, Math.min(startIndex, _queue.length - 1)) - 1;
  _reportedMissing = new Set();
  setQueueOnEnded(() => {
    void advanceQueue();
  });
  logInfo('library', `Playing ${ids.length} track${ids.length === 1 ? '' : 's'}`);
  await advanceQueue();
};

/** Stop the queue. Repeat mode is the user's setting and is left alone. */
export const stopQueue = (): void => {
  _queue = [];
  _pos = -1;
  _reportedMissing = new Set();
  setQueueOnEnded(null);
};

/** Ids currently queued, for a UI that wants to show what plays next. */
export const queuedIds = (): string[] => _queue.slice();
