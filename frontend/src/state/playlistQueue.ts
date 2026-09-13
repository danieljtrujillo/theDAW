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
 */
import { usePlayerStore, setQueueOnEnded } from './playerStore';
import { useLibraryStore } from './libraryStore';
import { logInfo } from './logStore';

let _queue: string[] = [];
let _pos = -1;

const playId = async (id: string): Promise<boolean> => {
  const entry = useLibraryStore.getState().entries.find((e) => e.id === id);
  if (!entry) return false;
  try {
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    await usePlayerStore.getState().load(blob, { label: entry.title, entryId: entry.id });
    usePlayerStore.getState().play();
    useLibraryStore.getState().setPlayingId(entry.id);
    return true;
  } catch {
    return false;
  }
};

const advance = async (): Promise<void> => {
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
  setQueueOnEnded(advance);
  logInfo('library', `Playing ${ids.length} track${ids.length === 1 ? '' : 's'}`);
  await advance();
};

/** Stop the queue. Repeat mode is the user's setting and is left alone. */
export const stopQueue = (): void => {
  _queue = [];
  _pos = -1;
  setQueueOnEnded(null);
};

/** Ids currently queued, for a UI that wants to show what plays next. */
export const queuedIds = (): string[] => _queue.slice();
