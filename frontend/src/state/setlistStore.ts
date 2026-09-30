/**
 * Setlist store — persistent named playlists of library track IDs.
 * Used by the new DJ tab (2-deck virtual mixer) and surfaced in the
 * VJ tab as a SET that can be imported into the VJ playlist.
 *
 * Persistence is via localStorage with the key 'thedaw.setlists.v1'.
 * Each setlist is fully resolved on read (entries that no longer
 * exist in the library are silently skipped) so a saved set survives
 * track deletes without orphaning rows.
 */
import { create, type StoreApi } from 'zustand';
import { persist } from 'zustand/middleware';
import { persistStorage } from './persistStorage';
import { analyzeEntries } from './djAnalysisStore';
import { useLogStore } from './logStore';

export interface SetlistEntry {
  /** Library entry id, or null for an ad-hoc URL/label (e.g. VJ
   *  archive clip referenced into a SET). */
  entryId: string | null;
  /** Human label — copied from the entry at insert time so a set
   *  reads correctly even if the underlying entry's title changes. */
  label: string;
  /** Optional URL hint for non-library entries. */
  url?: string;
  /** For a bundled set: the file inside the set folder this row came from.
   *  What `registerBundled` matches on when it patches ids in — a title can
   *  repeat and the user can reorder the set, a file name does neither. */
  file?: string;
  /** 'audio' | 'video' | 'image' — what kind of media this slot
   *  expects. */
  kind?: 'audio' | 'video' | 'image';
  /** Optional prepared-performance data (imported from Z-AutoDJ sets).
   *  When present the DJ automix uses these instead of its fixed
   *  constants; absent = classic automix behavior. All in seconds. */
  perf?: {
    /** Where the incoming deck should start playing this track. */
    cueIn?: number;
    /** Track position at which the blend OUT of this track begins. */
    mixOut?: number;
    /** Crossfade length for the transition out of this track. */
    transitionSec?: number;
  };
}

export interface Setlist {
  id: string;
  name: string;
  /** Ordered entries in this set. */
  entries: SetlistEntry[];
  /** Creation timestamp, ms since epoch. */
  createdAt: number;
  /** Last-edit timestamp. */
  updatedAt: number;
  /** Free-form notes / set order intent / venue. */
  notes?: string;
}

interface SetlistState {
  setlists: Record<string, Setlist>;
  /** Currently-active setlist (used by the DJ deck loader). */
  activeId: string | null;
  /** Create a fresh empty setlist. Returns its id. */
  create: (name: string) => string;
  /** Rename a setlist. */
  rename: (id: string, name: string) => void;
  /** Delete a setlist. */
  remove: (id: string) => void;
  /** Replace the entries of a setlist atomically. */
  setEntries: (id: string, entries: SetlistEntry[]) => void;
  /** Append entries to a setlist. */
  append: (id: string, entries: SetlistEntry[]) => void;
  /** Mark a setlist as currently active. */
  setActive: (id: string | null) => void;
  /** Update freeform notes. */
  setNotes: (id: string, notes: string) => void;
  /** Merge starter sets shipped by the local backend into browser storage. */
  importBundled: () => Promise<void>;
  /** Register a bundled set's audio files as library entries — the write the
   *  listing above deliberately does not do. Called when the user opens the
   *  set, and before anything starts automix on it; returns its entries with
   *  `entryId`s filled in (or null when there is no such bundled set, e.g. a
   *  locally-created list). Single-flight per set: a second call while the
   *  POST is out joins it. */
  registerBundled: (id: string) => Promise<SetlistEntry[] | null>;
  /** The bundled set whose `/register` POST is in flight, or null. The one
   *  in-flight guard every register caller reads (the DJ tab's START button,
   *  its Automix chip and its Sets rows), so a press on one while another's
   *  register is out can never send a second POST. Never persisted. */
  registeringId: string | null;
}

/** A set as `GET /api/library/setlists` lists it. `legacyIds` are ids an
 *  older build gave the same folder: main hashed a bundled set's id over its
 *  entry ids, this build hashes the timeline, so a copy saved under one of
 *  them is this set and not another one. */
interface ListedSetlist extends Setlist {
  legacyIds?: unknown;
}

const STORAGE_KEY = 'thedaw.setlists.v1';

/** Backend-bundled sets are `zad-<slug>-<hash>`; locally-created ones `set-…`. */
const BUNDLED_ID_PREFIX = 'zad-';

/** Is this a backend-bundled set? Only those have tracks a register call can
 *  fill in. */
export function isBundledSetId(id: string): boolean {
  return id.startsWith(BUNDLED_ID_PREFIX);
}

/** A bundled track the read-only listing could not name yet, which
 *  `registerBundled` WILL fill in: no entry id, and not one of the user's own
 *  ad-hoc/VJ rows (those carry a `url`) or a non-audio slot, neither of which
 *  has a library entry waiting for it. */
export function isPendingBundledRow(entry: SetlistEntry): boolean {
  return entry.entryId === null && !entry.url && entry.kind === 'audio';
}

/** Has the user changed this set since it was imported? The import stamps
 *  `createdAt` and `updatedAt` with the same file time, and every edit action
 *  (rename, reorder, add, remove, notes) moves `updatedAt`; filling ids in on
 *  register does not. */
function wasEdited(set: Setlist): boolean {
  return set.updatedAt !== set.createdAt;
}

/** The legacy ids a listed set carries, as strings. */
function legacyIdsOf(raw: ListedSetlist): string[] {
  return Array.isArray(raw.legacyIds)
    ? raw.legacyIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
}

/** A listed set as the store keeps it. */
function fromListing(raw: ListedSetlist): Setlist {
  return {
    id: raw.id,
    name: raw.name || 'Imported Set',
    entries: Array.isArray(raw.entries) ? raw.entries : [],
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    notes: raw.notes || '',
  };
}

/** A copy the user edited under an old id, moved to the new one with every
 *  edit kept: their name, order, notes and own tracks. Rows saved before the
 *  listing carried file names get theirs from the listing by entry id, so a
 *  later register binds each row to its own file. */
function carryOver(old: Setlist, id: string, listed: readonly SetlistEntry[]): Setlist {
  const fileById = new Map<string, string>();
  for (const e of listed) if (e.entryId && e.file) fileById.set(e.entryId, e.file);
  return {
    ...old,
    id,
    entries: old.entries.map((e) => {
      if (e.file || !e.entryId) return e;
      const file = fileById.get(e.entryId);
      return file ? { ...e, file } : e;
    }),
  };
}

/** The in-flight register POSTs, by set id: `registerBundled`'s single flight. */
const registerInFlight = new Map<string, Promise<SetlistEntry[] | null>>();

/** The register POST for one bundled set, and the patch of the ids it gets
 *  back into the set the user has. `registerBundled` decides whether to call
 *  it and keeps it single-flight. */
async function postRegister(
  set: StoreApi<SetlistState>['setState'],
  id: string,
  cur: Setlist,
  pending: number,
): Promise<SetlistEntry[] | null> {
  try {
    const res = await fetch(`/api/library/setlists/${encodeURIComponent(id)}/register`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { setlist?: { entries?: SetlistEntry[] } };
    const incoming = Array.isArray(body.setlist?.entries) ? body.setlist.entries : null;
    if (!incoming) throw new Error('no entries in the answer');
    // Patch ids INTO the set the user has; never replace the array. They
    // may have reordered it, removed a track, or dragged their own in
    // (DJView "Sets" editing), and none of that is the backend's to
    // overwrite. Matched by file, then by label, each taken in order so two
    // tracks sharing a title still land on their own entry.
    const byFile = new Map<string, string[]>();
    const byLabel = new Map<string, string[]>();
    for (const entry of incoming) {
      if (!entry?.entryId) continue;
      if (entry.file) {
        const queue = byFile.get(entry.file) ?? [];
        queue.push(entry.entryId);
        byFile.set(entry.file, queue);
      }
      const queue = byLabel.get(entry.label) ?? [];
      queue.push(entry.entryId);
      byLabel.set(entry.label, queue);
    }
    // An id may sit in both maps; whichever claims it first owns it.
    const used = new Set<string>();
    const take = (queue: string[] | undefined): string | undefined => {
      while (queue && queue.length > 0) {
        const next = queue.shift();
        if (next && !used.has(next)) return next;
      }
      return undefined;
    };
    let patched: SetlistEntry[] = cur.entries;
    const filled: string[] = [];
    set((s) => {
      const live = s.setlists[id];
      if (!live) return s;
      patched = live.entries.map((e) => {
        if (!isPendingBundledRow(e)) return e;
        // File first, label only for a set persisted before the
        // listing carried file names.
        const got =
          (e.file ? take(byFile.get(e.file)) : undefined) ?? take(byLabel.get(e.label));
        if (!got) return e;
        used.add(got);
        filled.push(got);
        return { ...e, entryId: got };
      });
      return {
        setlists: {
          ...s.setlists,
          // `updatedAt` is left alone on purpose: the DJ tab's set
          // list is sorted by it, and filling ids in is not an edit the
          // user made -- touching it would jump the row they just
          // clicked to the top of the list under their cursor.
          [id]: { ...live, entries: patched },
        },
      };
    });
    if (filled.length > 0) analyzeEntries(filled);
    return patched;
  } catch (err) {
    // Silence here looked exactly like success: the set simply stayed
    // unplayable. Say so once, where the user already reads failures.
    useLogStore
      .getState()
      .append(
        'warn',
        'setlists',
        `Could not register ${pending} track${pending === 1 ? '' : 's'} of "${cur.name}": ${
          err instanceof Error ? err.message : 'request failed'
        }`,
      );
    return null;
  }
}

function nextId(): string {
  return `set-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export const useSetlistStore = create<SetlistState>()(
  persist(
    (set, get) => ({
      setlists: {},
      activeId: null,
      create: (name) => {
        const id = nextId();
        const now = Date.now();
        set((s) => ({
          setlists: {
            ...s.setlists,
            [id]: { id, name, entries: [], createdAt: now, updatedAt: now },
          },
        }));
        return id;
      },
      rename: (id, name) => set((s) => {
        const cur = s.setlists[id];
        if (!cur) return s;
        return {
          setlists: { ...s.setlists, [id]: { ...cur, name, updatedAt: Date.now() } },
        };
      }),
      remove: (id) => set((s) => {
        const { [id]: _, ...rest } = s.setlists;
        return { setlists: rest, activeId: s.activeId === id ? null : s.activeId };
      }),
      setEntries: (id, entries) => {
        analyzeEntries(entries.map((e) => e.entryId)); // keep set tracks analyzed
        set((s) => {
          const cur = s.setlists[id];
          if (!cur) return s;
          return {
            setlists: {
              ...s.setlists,
              [id]: { ...cur, entries, updatedAt: Date.now() },
            },
          };
        });
      },
      append: (id, entries) => {
        analyzeEntries(entries.map((e) => e.entryId)); // analyze added tracks now
        set((s) => {
          const cur = s.setlists[id];
          if (!cur) return s;
          return {
            setlists: {
              ...s.setlists,
              [id]: { ...cur, entries: [...cur.entries, ...entries], updatedAt: Date.now() },
            },
          };
        });
      },
      setActive: (id) => set({ activeId: id }),
      setNotes: (id, notes) => set((s) => {
        const cur = s.setlists[id];
        if (!cur) return s;
        return {
          setlists: {
            ...s.setlists,
            [id]: { ...cur, notes, updatedAt: Date.now() },
          },
        };
      }),
      importBundled: async () => {
        try {
          const res = await fetch('/api/library/setlists');
          if (!res.ok) return;
          const body = (await res.json()) as { setlists?: ListedSetlist[] };
          const incoming = Array.isArray(body.setlists) ? body.setlists : [];
          if (incoming.length === 0) return;
          let madeActive: string | null = null;
          set((s) => {
            const next = { ...s.setlists };
            let activeId = s.activeId;
            let added = false;
            for (const raw of incoming) {
              if (!raw?.id) continue;
              const listed = fromListing(raw);
              // A copy saved under an id an older build gave this folder is
              // this set. Without this every set saved by main showed twice
              // after the upgrade: the old copy, plus the same set again
              // under its new id. The old id is retired, the active-set
              // choice follows it, and a copy the user edited keeps every
              // edit under the new id.
              for (const oldId of legacyIdsOf(raw)) {
                const old = next[oldId];
                if (!old || oldId === raw.id) continue;
                const held = next[raw.id];
                // Both edited: two lists the user has made. Neither is
                // dropped; an edit is never thrown away to save a row.
                if (held && wasEdited(held) && wasEdited(old)) continue;
                next[raw.id] = wasEdited(old)
                  ? carryOver(old, raw.id, listed.entries)
                  : held ?? listed;
                delete next[oldId];
                if (activeId === oldId) activeId = raw.id;
                added = true;
              }
              if (next[raw.id]) continue;
              next[raw.id] = listed;
              added = true;
            }
            if (!added) return s;
            const preferred = incoming.find((item) => item.id === 'set-infinite-glitch-performance')?.id;
            const nextActive = activeId ?? preferred ?? incoming[0]?.id ?? null;
            if (s.activeId === null && nextActive !== null) madeActive = nextActive;
            return { setlists: next, activeId: nextActive };
          });
          // A bundled set this import made active (a first run) is the one
          // every start path reaches for: the master transport's play, the
          // Automix chip, the assistant. Register it now, the way opening it
          // would, so none of them finds a set of unregistered rows.
          if (madeActive) {
            const cur = get().setlists[madeActive];
            if (cur && isBundledSetId(madeActive) && cur.entries.some(isPendingBundledRow)) {
              void get().registerBundled(madeActive);
            }
          }
        } catch {
          /* Starter sets are optional; ignore failures while the backend warms. */
        }
      },
      registeringId: null,
      registerBundled: (id) => {
        // A register for this set is already out: join it. Each caller (a
        // Sets row, START AUTO DJ) used to guard on its own flag, so one of
        // each pressed together POSTed twice.
        const running = registerInFlight.get(id);
        if (running) return running;
        // Only a bundled set has anything to register: a locally-created list
        // (`set-…` id) has no folder behind it, so there is no request to make.
        const cur = get().setlists[id];
        if (!cur) return Promise.resolve(null);
        if (!isBundledSetId(id)) return Promise.resolve(cur.entries);
        // A track the user added by hand carries a `url` or an id already;
        // only a bundled track the listing left unregistered is pending.
        const pending = cur.entries.filter(isPendingBundledRow).length;
        if (pending === 0) return Promise.resolve(cur.entries);
        const run = postRegister(set, id, cur, pending).finally(() => {
          registerInFlight.delete(id);
          const other = registerInFlight.keys().next();
          set({ registeringId: other.done ? null : other.value });
        });
        registerInFlight.set(id, run);
        set({ registeringId: id });
        return run;
      },
    }),
    {
      name: STORAGE_KEY,
      storage: persistStorage(),
      // The sets and the active choice, the shape every build has stored.
      // `registeringId` is live state: persisted, a reload in the middle of a
      // register would leave every Sets row refusing clicks.
      partialize: (s) => ({ setlists: s.setlists, activeId: s.activeId }),
    },
  ),
);
