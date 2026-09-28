/**
 * djCuesStore — persistent hotcues per library track, for the DJ decks.
 *
 * A hotcue is just a saved position (seconds) on a track; the DJ deck seeks to
 * it sample-accurately via djEngine. We keep this separate from the engine so
 * the cues survive reloads and render reactively as pad state, while the engine
 * stays a stateless transport. Keyed by library entry id; HOTCUE_SLOTS pads per
 * track (VirtualDJ-style).
 *
 * Persisted in localStorage under 'thedaw.djcues.v1'.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './persistStorage';

export const HOTCUE_SLOTS = 4;

/** Each track maps to a fixed-length array of cue positions (sec) or null. */
type CueArray = (number | null)[];

interface DjCuesState {
  byEntry: Record<string, CueArray>;
  /** Entries whose cues were ALL placed by `seedCues` — the only ones a
   *  later, better seed is allowed to move. */
  seeded: Record<string, boolean>;
  /** Entries the user has edited by hand. `seedCues` never writes to one
   *  again: clearing a cue is a decision, and an automatic writer that
   *  undoes it is worse than one that never ran. */
  userTouched: Record<string, boolean>;
  /** Read a track's cues (always returns a HOTCUE_SLOTS-length array). */
  cuesFor: (entryId: string | null) => CueArray;
  /** Store a cue position at a slot. */
  setCue: (entryId: string, index: number, sec: number) => void;
  /** Clear a single cue slot. */
  clearCue: (entryId: string, index: number) => void;
  /** Clear all cues for a track. */
  clearAll: (entryId: string) => void;
  /** Place automatic cues (see lib/djCueSeed) into slots nobody owns.
   *  Ignored entirely once the user has touched the track. An explicit
   *  `null` is a statement ("there is no cue here") and clears a slot this
   *  store placed; `undefined` is silence and leaves the slot alone. */
  seedCues: (entryId: string, times: readonly (number | null | undefined)[]) => void;
}

const empty = (): CueArray => Array<number | null>(HOTCUE_SLOTS).fill(null);

function normalize(arr: CueArray | undefined): CueArray {
  const out = empty();
  if (arr) for (let i = 0; i < HOTCUE_SLOTS; i++) out[i] = arr[i] ?? null;
  return out;
}

export const useDjCuesStore = create<DjCuesState>()(
  persist(
    (set, get) => ({
      byEntry: {},
      seeded: {},
      userTouched: {},
      cuesFor: (entryId) => (entryId ? normalize(get().byEntry[entryId]) : empty()),
      setCue: (entryId, index, sec) => set((s) => {
        if (index < 0 || index >= HOTCUE_SLOTS || !Number.isFinite(sec)) return s;
        const cur = normalize(s.byEntry[entryId]);
        cur[index] = Math.max(0, sec);
        return {
          byEntry: { ...s.byEntry, [entryId]: cur },
          userTouched: { ...s.userTouched, [entryId]: true },
        };
      }),
      clearCue: (entryId, index) => set((s) => {
        if (index < 0 || index >= HOTCUE_SLOTS) return s;
        const cur = normalize(s.byEntry[entryId]);
        cur[index] = null;
        return {
          byEntry: { ...s.byEntry, [entryId]: cur },
          userTouched: { ...s.userTouched, [entryId]: true },
        };
      }),
      clearAll: (entryId) => set((s) => {
        // The flag is set even when there was nothing to clear: the press is
        // the user saying "no cues here", and a seed must respect that.
        const { [entryId]: _drop, ...rest } = s.byEntry;
        return {
          byEntry: rest,
          userTouched: { ...s.userTouched, [entryId]: true },
        };
      }),
      seedCues: (entryId, times) => set((s) => {
        if (!entryId || s.userTouched[entryId]) return s;
        const cur = normalize(s.byEntry[entryId]);
        // Only cues this store placed itself may be moved by a later seed.
        // Anything restored from storage without a `seeded` flag predates
        // this feature and belongs to whoever pressed the pad.
        const mine = !!s.seeded[entryId];
        const next = empty();
        let changed = false;
        for (let i = 0; i < HOTCUE_SLOTS; i++) {
          const incoming = times[i];
          const usable = typeof incoming === 'number' && Number.isFinite(incoming);
          // An explicit null on a slot this store placed CLEARS it. The first
          // seed of a deck often runs before the duration is known and puts a
          // phrase cue past the end of the file; the re-seed with the real
          // duration answers null for that slot, and keeping the old value
          // left a pad that seeks into silence.
          const clearing = incoming === null && mine;
          next[i] = usable && (cur[i] == null || mine) ? Math.max(0, incoming) : clearing ? null : cur[i];
          if (next[i] !== cur[i]) changed = true;
        }
        if (!changed) return s;
        // Claim the track only when every cue on it is now ours — otherwise
        // a later re-seed would walk over the user's surviving cue.
        const ownsAll = mine || cur.every((v) => v == null);
        return {
          byEntry: { ...s.byEntry, [entryId]: next },
          seeded: { ...s.seeded, [entryId]: ownsAll },
        };
      }),
    }),
    { name: 'thedaw.djcues.v1', storage: persistStorage() },
  ),
);
