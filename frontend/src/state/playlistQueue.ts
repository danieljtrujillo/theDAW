/**
 * Sequential play queue for the playlist suggester. Plays a list of library
 * entry ids in order through the global player, auto-advancing when each track
 * ends. Loop is turned off while a queue is active (so tracks actually end) and
 * the user's loop preference is restored when the queue finishes.
 */
import { usePlayerStore, setQueueOnEnded } from './playerStore';
import { useLibraryStore } from './libraryStore';
import { logInfo } from './logStore';

let _queue: string[] = [];
let _pos = -1;
let _restoreLoop = false;

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
  _pos += 1;
  while (_pos < _queue.length) {
    if (await playId(_queue[_pos])) return;
    _pos += 1; // skip a track that failed to load and try the next
  }
  stopQueue();
};

/** Play the given entry ids in order, auto-advancing track to track. */
export const startQueue = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  _queue = ids.slice();
  _pos = -1;
  // Loop must be off so each track ends and the queue can advance.
  const ps = usePlayerStore.getState();
  _restoreLoop = ps.isLooping;
  if (ps.isLooping) ps.toggleLoop();
  setQueueOnEnded(advance);
  logInfo('library', `Playing a suggested playlist of ${ids.length} tracks`);
  await advance();
};

/** Stop the queue and restore the prior loop preference. */
export const stopQueue = (): void => {
  _queue = [];
  _pos = -1;
  setQueueOnEnded(null);
  const ps = usePlayerStore.getState();
  if (_restoreLoop && !ps.isLooping) ps.toggleLoop();
  _restoreLoop = false;
};
