/**
 * Browse the library and pick one thing out of it.
 *
 * Replaces `LibraryMidiPicker`, which was MIDI-only, un-portaled, id-colliding
 * and (in anchored mode) covered the whole app with an invisible click-eating
 * layer. Every one of those was a live bug; each is called out where it is
 * fixed below.
 *
 * What it browses: the three library kinds that can become a clip — audio
 * takes (`libraryStore.entries`), separated stems and converted MIDI. Video and
 * image entries are filtered out on purpose: the editor store has exactly two
 * clip kinds (`'audio' | 'piano-roll'`), so there is nothing a video could
 * become on a track. A caller narrows the tabs further with `tabs`.
 *
 * Two shapes, and the ARIA matches whichever is in use:
 *   - ANCHORED (`anchor` given): a popover. No overlay at all, dismissed by an
 *     outside mousedown / right-click / Escape, exactly like ContextMenu. It is
 *     NOT `aria-modal` — the rest of the app really is still usable.
 *   - CENTERED (no `anchor`): a real modal — visible scrim, `aria-modal`, and a
 *     Tab loop that keeps focus in the dialog.
 *
 * Keyboard: the search box is a combobox over the row list. Up/Down move the
 * active row, Home/End jump, Enter picks it, Escape closes. The rows are a
 * listbox driven by `aria-activedescendant`, so focus never leaves the input
 * and typing keeps filtering while arrowing.
 */
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, FolderOpen, Music, RefreshCw, Scissors, Search, Star, X } from 'lucide-react';
import { InstrumentPicker } from './InstrumentPicker';
import { MIDI_ACCEPT, midiFileLabel } from '../../lib/fileFilters';
import { fetchMidiBytesWithRetry } from '../../lib/fetchRetry';
import {
  cachedLibraryMidi,
  cachedLibraryStems,
  loadLibraryMidi,
  loadLibraryStems,
  midiRowLabel,
  stemAudioUrl,
  stemRowLabel,
  type LibraryMidiRow,
  type LibraryStemRow,
} from '../../lib/libraryIndex';
import { useLibraryStore, type LibraryEntry } from '../../state/libraryStore';
import { logError } from '../../state/logStore';

export interface PickerAnchor {
  x: number;
  y: number;
}

/** Which library index a tab shows. */
export type LibraryPickerTab = 'audio' | 'stems' | 'midi';

/** What the user chose. MIDI always arrives as bytes — the picker fetches or
 *  reads them — so every caller gets the same thing whether the MIDI came from
 *  the library or from a file on disk. */
export type LibraryPick =
  | { kind: 'audio'; label: string; entry: LibraryEntry }
  | { kind: 'stem'; label: string; row: LibraryStemRow; url: string }
  | {
      kind: 'midi';
      label: string;
      bytes: ArrayBuffer;
      row: LibraryMidiRow | null;
      file: File | null;
    };

export interface LibraryPickerProps {
  open: boolean;
  /** Dialog title. Also the accessible name. */
  title?: string;
  /** A line under the title saying where the pick is going ("Bassline · 12.50s"). */
  subtitle?: React.ReactNode;
  /** Viewport point to open at. Omit for a centered modal. */
  anchor?: PickerAnchor | null;
  /** Tabs to offer, in order. Defaults to all three. */
  tabs?: readonly LibraryPickerTab[];
  /** Tab to open on. Defaults to the first entry of `tabs`. */
  initialTab?: LibraryPickerTab;
  /** Offer "From a file on disk…" on the MIDI tab. Off where the caller has its
   *  own "from system" route (the EDIT add-to-track menu does). */
  allowFiles?: boolean;
  /** Show the global MIDI voice control. Only for callers that synthesize
   *  through it — it writes app-wide state, so a per-track insert leaves it off
   *  and uses the track's own instrument instead. */
  showInstrument?: boolean;
  onClose: () => void;
  onPick: (pick: LibraryPick) => void;
}

const ALL_TABS: readonly LibraryPickerTab[] = ['audio', 'stems', 'midi'];

/** For the two callers that can only use MIDI (the INIT slot renders it to
 *  audio; the Virtuoso learns a groove from its timing). */
export const MIDI_ONLY_TABS: readonly LibraryPickerTab[] = ['midi'];

const TAB_LABEL: Record<LibraryPickerTab, string> = {
  audio: 'Tracks',
  stems: 'Stems',
  midi: 'MIDI',
};

/** Rendered at once. A library of thousands of takes would otherwise build
 *  thousands of DOM rows on every keystroke; the footer says what is hidden and
 *  search narrows to it. */
const MAX_ROWS = 300;

const fmtDuration = (sec?: number | null): string | null => {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null;
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const fmtDate = (iso?: string): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
};

const numeric = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** One row, normalized across the three indexes so the list, the search and the
 *  keyboard navigation only ever deal with one shape. */
interface PickerRow {
  key: string;
  label: string;
  /** Second line: everything cheaply known about the row. */
  meta: string[];
  favorite: boolean;
  /** Sort key for "Newest first" where the index carries a time. */
  sortTime: number;
  toPick: () => LibraryPick | Promise<LibraryPick>;
}

const entryRow = (entry: LibraryEntry): PickerRow => {
  const analysis = entry.analysis ?? {};
  const bpm = numeric(analysis.bpm);
  const key = typeof analysis.key === 'string' ? analysis.key : null;
  const scale = typeof analysis.scale === 'string' ? analysis.scale : null;
  const meta = [
    fmtDuration(entry.duration),
    bpm ? `${Math.round(bpm)} bpm` : null,
    key ? [key, scale].filter(Boolean).join(' ') : null,
    fmtDate(entry.timestamp),
  ].filter((v): v is string => !!v);
  return {
    key: `audio:${entry.id}`,
    label: entry.title || `take_${entry.id.slice(0, 6)}`,
    meta,
    favorite: !!entry.favorite,
    sortTime: Date.parse(entry.timestamp) || 0,
    toPick: () => ({ kind: 'audio', label: entry.title || `take_${entry.id.slice(0, 6)}`, entry }),
  };
};

const stemRow = (row: LibraryStemRow): PickerRow => {
  const label = stemRowLabel(row);
  const meta = [row.stem_name || null, fmtDuration(row.duration), row.model || null].filter(
    (v): v is string => !!v,
  );
  return {
    key: `stem:${row.id}`,
    label,
    meta,
    favorite: !!row.favorite,
    sortTime: 0,
    toPick: () => ({ kind: 'stem', label, row, url: stemAudioUrl(row) }),
  };
};

const midiRow = (row: LibraryMidiRow): PickerRow => {
  const label = midiRowLabel(row);
  const meta = [
    typeof row.notes_count === 'number' ? `${row.notes_count} notes` : null,
    row.source || null,
  ].filter((v): v is string => !!v);
  return {
    key: `midi:${row.id}`,
    label,
    meta,
    favorite: !!row.favorite,
    sortTime: 0,
    toPick: async () => {
      const bytes = await fetchMidiBytesWithRetry(`/api/midi/file/${row.id}`, { label });
      return { kind: 'midi', label, bytes, row, file: null };
    },
  };
};

const TAB_ICON: Record<LibraryPickerTab, React.ComponentType<{ className?: string }>> = {
  audio: AudioLines,
  stems: Scissors,
  midi: Music,
};

export const LibraryPicker: React.FC<LibraryPickerProps> = ({
  open,
  title = 'Add from library',
  subtitle,
  anchor = null,
  tabs = ALL_TABS,
  initialTab,
  allowFiles = false,
  showInstrument = false,
  onClose,
  onPick,
}) => {
  const anchored = !!anchor;
  // Every id is derived from a per-instance useId. The old picker hardcoded
  // `library-midi-picker-search` / `-file` and embedded an InstrumentPicker
  // whose select is hardcoded `id="pr-instrument"` — the Piano Roll's id — so
  // opening it beside the roll produced duplicate ids and labels that named the
  // wrong control.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const searchId = `libpick-${uid}-search`;
  const listId = `libpick-${uid}-list`;
  const panelId = `libpick-${uid}-panel`;
  const fileId = `libpick-${uid}-file`;
  const titleId = `libpick-${uid}-title`;
  const optionId = (i: number) => `libpick-${uid}-opt-${i}`;

  const tabList = tabs.length > 0 ? tabs : ALL_TABS;
  const [tab, setTab] = useState<LibraryPickerTab>(initialTab ?? tabList[0]);
  const [query, setQuery] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [sortBy, setSortBy] = useState<'favorites' | 'name' | 'newest'>('favorites');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);

  const [stems, setStems] = useState<LibraryStemRow[] | null>(cachedLibraryStems);
  const [midis, setMidis] = useState<LibraryMidiRow[] | null>(cachedLibraryMidi);
  const [loading, setLoading] = useState<Partial<Record<LibraryPickerTab, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<LibraryPickerTab, string>>>({});

  const entries = useLibraryStore((s) => s.entries);
  const loadLibrary = useLibraryStore((s) => s.load);
  const refreshLibrary = useLibraryStore((s) => s.refresh);
  const libraryLoaded = useLibraryStore((s) => s.loaded);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<PickerAnchor | null>(null);

  // Reopening resets the transient view state but keeps whatever is cached.
  useEffect(() => {
    if (!open) return;
    setTab(initialTab ?? tabList[0]);
    setQuery('');
    setActive(0);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open is the reset edge
  }, [open, initialTab]);

  const refresh = useCallback(
    (which: LibraryPickerTab, force: boolean) => {
      setErrors((e) => ({ ...e, [which]: undefined }));
      if (which === 'audio') {
        // Audio takes live in a store the whole app keeps current, so opening
        // the picker does not refetch them — only the explicit reload does.
        if (!force && libraryLoaded) return;
        setLoading((l) => ({ ...l, audio: true }));
        void (force ? refreshLibrary() : loadLibrary())
          .catch((e: unknown) =>
            setErrors((prev) => ({
              ...prev,
              audio: e instanceof Error ? e.message : String(e),
            })),
          )
          .finally(() => setLoading((l) => ({ ...l, audio: false })));
        return;
      }
      const load = which === 'stems' ? loadLibraryStems : loadLibraryMidi;
      setLoading((l) => ({ ...l, [which]: true }));
      void load({ force })
        .then((rows) => {
          if (which === 'stems') setStems(rows as LibraryStemRow[]);
          else setMidis(rows as LibraryMidiRow[]);
        })
        .catch((e: unknown) =>
          setErrors((prev) => ({
            ...prev,
            [which]: e instanceof Error ? e.message : String(e),
          })),
        )
        .finally(() => setLoading((l) => ({ ...l, [which]: false })));
    },
    [libraryLoaded, loadLibrary, refreshLibrary],
  );

  // Revalidate the visible tab each time the picker opens (and when the user
  // switches tabs), painting the cached rows meanwhile — a stale index would
  // otherwise hide a take the user just made.
  useEffect(() => {
    if (!open) return;
    // The two index fetches are small, so they revalidate every open — a stale
    // index would hide MIDI the user converted a minute ago. The audio tab
    // reads the already-live library store instead.
    refresh(tab, tab !== 'audio');
  }, [open, tab, refresh]);

  const rows = useMemo((): PickerRow[] => {
    if (tab === 'audio') {
      // Video and image entries have no clip kind; they are not offered rather
      // than offered and then rejected at insert time.
      return entries.filter((e) => (e.kind ?? 'audio') === 'audio').map(entryRow);
    }
    if (tab === 'stems') return (stems ?? []).map(stemRow);
    return (midis ?? []).map(midiRow);
  }, [tab, entries, stems, midis]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = rows.filter((r) => {
      if (favOnly && !r.favorite) return false;
      if (!q) return true;
      return r.label.toLowerCase().includes(q) || r.meta.join(' ').toLowerCase().includes(q);
    });
    const byName = (a: PickerRow, b: PickerRow) => a.label.localeCompare(b.label);
    const sorted = [...matched].sort((a, b) => {
      if (sortBy === 'name') return byName(a, b);
      if (sortBy === 'newest') return b.sortTime - a.sortTime || byName(a, b);
      const fav = (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
      return fav !== 0 ? fav : byName(a, b);
    });
    return sorted;
  }, [rows, query, favOnly, sortBy]);

  const shown = visible.slice(0, MAX_ROWS);
  const hidden = visible.length - shown.length;

  useEffect(() => {
    setActive(0);
  }, [tab, query, favOnly, sortBy]);

  // A background refresh can shorten the list under the cursor. Clamp rather
  // than leave `aria-activedescendant` pointing at an option that no longer
  // exists, which reads to a screen reader as nothing being active at all.
  useEffect(() => {
    setActive((i) => (i >= shown.length ? 0 : i));
  }, [shown.length]);

  // Keep the active row on screen while arrowing.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`#${CSS.escape(optionId(active))}`)
      ?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId is derived from uid
  }, [active, open, shown.length]);

  /* --- Position ----------------------------------------------------------
     Portaled to document.body: the Shell scales the DAW with CSS `zoom`
     (.dense-layout), so a `position: fixed` panel rendered inside that tree
     drifts away from raw clientX/Y. The old picker was not portaled, which is
     why it never landed at the cursor.
     The clamp re-runs on every size change, not just on open: the old one had
     deps `[open, anchor]` and measured an EMPTY card before the fetch resolved,
     so a panel that grew when its rows arrived hung off the bottom forever.
     It depends on the anchor's two NUMBERS, not the object: every caller builds
     `{ x, y }` inline, so an object dep re-runs this effect on each parent
     render — disconnecting and re-observing the ResizeObserver and forcing a
     synchronous layout every time, for coordinates that did not move. */
  const anchorX = anchor ? anchor.x : null;
  const anchorY = anchor ? anchor.y : null;
  const clamp = useCallback(() => {
    const card = cardRef.current;
    if (!card || anchorX === null || anchorY === null) return;
    const rect = card.getBoundingClientRect();
    const pad = 8;
    setPos((prev) => {
      const x = Math.max(pad, Math.min(anchorX, window.innerWidth - rect.width - pad));
      const y = Math.max(pad, Math.min(anchorY, window.innerHeight - rect.height - pad));
      return prev && prev.x === x && prev.y === y ? prev : { x, y };
    });
  }, [anchorX, anchorY]);

  useLayoutEffect(() => {
    if (!open || anchorX === null || anchorY === null) {
      setPos(null);
      return;
    }
    clamp();
    const card = cardRef.current;
    if (!card || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => clamp());
    ro.observe(card);
    window.addEventListener('resize', clamp);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', clamp);
    };
  }, [open, anchorX, anchorY, clamp]);

  /* --- Dismissal ---------------------------------------------------------
     Anchored: no overlay, so the app underneath stays clickable (the old
     picker's transparent `fixed inset-0` layer ate every click in the app while
     it was open). Outside mousedown / right-click / Escape close it, and the
     listeners attach one macrotask late because the click that opened the
     picker is still mid-dispatch — attaching synchronously closes it instantly.
     Centered: the scrim is a real element, so only Escape is needed here.

     `onClose` is read through a ref rather than being a dep. Callers pass an
     inline arrow, so a dep would rebuild this effect on every parent render —
     clearing the pending `setTimeout` and scheduling a fresh one each time. A
     parent that re-renders faster than a macrotask (the editor does while the
     transport moves the playhead in automation-follow mode) would then never
     get the listeners attached at all, and the popover would stop closing on an
     outside click. */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    if (!anchored) return () => window.removeEventListener('keydown', onKey);

    const onDown = (e: MouseEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      onCloseRef.current();
    };
    let attached = false;
    const attach = () => {
      attached = true;
      window.addEventListener('mousedown', onDown);
      window.addEventListener('contextmenu', onDown);
    };
    const timer = window.setTimeout(attach, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      if (attached) {
        window.removeEventListener('mousedown', onDown);
        window.removeEventListener('contextmenu', onDown);
      }
    };
  }, [open, anchored]);

  // Focus the search box on open so typing filters immediately.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const choose = useCallback(
    async (row: PickerRow) => {
      setBusy(true);
      try {
        onPick(await row.toPick());
        onClose();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setErrors((prev) => ({ ...prev, [tab]: message }));
        logError('library-picker', `Could not load "${row.label}": ${message}`);
      } finally {
        setBusy(false);
      }
    },
    [onPick, onClose, tab],
  );

  const pickMidiFile = useCallback(
    async (file: File) => {
      try {
        const bytes = await file.arrayBuffer();
        onPick({ kind: 'midi', label: midiFileLabel(file.name), bytes, row: null, file });
        onClose();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setErrors((prev) => ({ ...prev, midi: message }));
        logError('library-picker', `Could not read ${file.name}: ${message}`);
      }
    },
    [onPick, onClose],
  );

  /** Tab cycling for the modal shape. A non-modal popover deliberately does not
   *  trap — the app behind it is genuinely reachable, and claiming otherwise is
   *  what made the old `aria-modal="true"` a lie. */
  const trapTab = (e: React.KeyboardEvent) => {
    if (anchored || e.key !== 'Tab') return;
    const card = cardRef.current;
    if (!card) return;
    const focusable = Array.from(
      card.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (shown.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % shown.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + shown.length) % shown.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(shown.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = shown[active];
      if (row && !busy) void choose(row);
    }
  };

  if (!open) return null;

  const isLoading = !!loading[tab];
  const error = errors[tab];
  const RowIcon = TAB_ICON[tab];
  const emptyText =
    tab === 'audio'
      ? 'No audio in the library yet'
      : tab === 'stems'
        ? 'No separated stems yet — run Separate Stems on a take'
        : 'No library MIDI yet';

  const card = (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={anchored ? title : undefined}
      aria-labelledby={anchored ? undefined : titleId}
      aria-modal={anchored ? undefined : true}
      onKeyDown={trapTab}
      className="z-200 w-100 max-w-[92vw] max-h-[70vh] bg-[#0a080f] border border-purple-500/30 rounded-lg shadow-[0_8px_40px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden"
      style={anchored ? { position: 'fixed', left: pos?.x ?? -9999, top: pos?.y ?? -9999 } : undefined}
      onContextMenu={(e) => {
        // Right-clicking inside the picker must not paint the OS menu on top of
        // it, and must not bubble out to the dismiss listener.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Title + where the pick is going */}
      <div className="flex items-start justify-between gap-2 px-3 py-2 border-b border-white/10 shrink-0">
        <div className="min-w-0">
          <div id={titleId} className="text-[11px] font-black uppercase tracking-widest text-purple-300 truncate">
            {title}
          </div>
          {subtitle != null && (
            <div className="text-[9px] font-mono text-zinc-500 truncate">{subtitle}</div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the library picker"
          className="p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-white transition-colors shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Kind tabs — only rendered when the caller offers more than one. */}
      {tabList.length > 1 && (
        <div role="tablist" aria-label="Library kind" className="flex gap-0.5 px-2 pt-2 shrink-0">
          {tabList.map((t) => {
            const Icon = TAB_ICON[t];
            const on = t === tab;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls={panelId}
                onClick={() => setTab(t)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-t text-[10px] uppercase tracking-wider transition-colors ${
                  on
                    ? 'bg-purple-500/20 text-purple-200 border-b border-purple-400'
                    : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/5'
                }`}
              >
                <Icon className="w-3 h-3" />
                {TAB_LABEL[t]}
              </button>
            );
          })}
        </div>
      )}

      {/* Search + facets */}
      <div className="px-3 py-2 flex flex-col gap-2 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-1.5 bg-black/40 border border-white/10 rounded px-2">
          <Search className="w-3 h-3 text-zinc-500 shrink-0" />
          <label htmlFor={searchId} className="sr-only">
            Search the library
          </label>
          <input
            ref={searchRef}
            id={searchId}
            name={searchId}
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={shown.length > 0 ? optionId(active) : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search — arrows to move, Enter to add"
            className="flex-1 min-w-0 bg-transparent border-none outline-none py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600"
          />
          <button
            type="button"
            onClick={() => refresh(tab, true)}
            aria-label={`Reload ${TAB_LABEL[tab]}`}
            title={`Reload ${TAB_LABEL[tab]}`}
            className="p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-purple-200 transition-colors shrink-0"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label
            htmlFor={`${searchId}-fav`}
            className="flex items-center gap-1.5 text-[9px] uppercase tracking-wider text-zinc-500 cursor-pointer"
          >
            <input
              id={`${searchId}-fav`}
              name={`${searchId}-fav`}
              type="checkbox"
              checked={favOnly}
              onChange={(e) => setFavOnly(e.target.checked)}
              className="accent-purple-500"
            />
            Favourites only
          </label>
          <span className="grow" />
          <label htmlFor={`${searchId}-sort`} className="text-[9px] uppercase tracking-wider text-zinc-500">
            Sort
          </label>
          <select
            id={`${searchId}-sort`}
            name={`${searchId}-sort`}
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-[9px] text-zinc-300 outline-none"
            style={{ colorScheme: 'dark' }}
          >
            <option value="favorites">Favourites first</option>
            <option value="name">A–Z</option>
            <option value="newest">Newest first</option>
          </select>
        </div>
        {allowFiles && tabList.includes('midi') && tab === 'midi' && (
          <>
            <button
              type="button"
              // Synchronous inside the click: any await here loses the user
              // activation and the browser silently refuses to open the dialog.
              onClick={() => fileRef.current?.click()}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-white/3 hover:bg-white/8 border border-white/10 text-[10px] text-zinc-200 transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5 text-purple-300 shrink-0" />
              From a file on disk…
            </button>
            {/* sr-only, not display:none — hiding it with `hidden` drops it from
                the accessibility tree and leaves the label naming nothing. */}
            <label htmlFor={fileId} className="sr-only">
              MIDI file to add
            </label>
            <input
              ref={fileRef}
              id={fileId}
              name={fileId}
              type="file"
              accept={MIDI_ACCEPT}
              tabIndex={-1}
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void pickMidiFile(f);
              }}
            />
          </>
        )}
        {showInstrument && tab === 'midi' && (
          <InstrumentPicker idPrefix={`libpick-${uid}-instrument`} />
        )}
      </div>

      {/* Rows. The scroll container is the tabs' panel; the listbox inside it
          holds options and nothing else, so a status line never reads as a
          choosable row. */}
      <div
        ref={listRef}
        id={panelId}
        role={tabList.length > 1 ? 'tabpanel' : undefined}
        aria-label={tabList.length > 1 ? `${TAB_LABEL[tab]} in the library` : undefined}
        className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5 p-2"
      >
        {error && (
          <div className="m-1 px-2 py-2 rounded border border-red-500/40 bg-red-500/10 text-[9px] text-red-200 flex flex-col gap-1.5">
            <span className="break-words">Could not load {TAB_LABEL[tab]}: {error}</span>
            <button
              type="button"
              onClick={() => refresh(tab, true)}
              className="self-start px-2 py-0.5 rounded border border-red-400/40 hover:bg-red-500/20 text-red-100 transition-colors"
            >
              Try again
            </button>
          </div>
        )}
        {isLoading && shown.length === 0 && (
          <span className="text-[9px] font-mono text-zinc-600 px-2 py-3 text-center">loading…</span>
        )}
        {!isLoading && !error && shown.length === 0 && (
          <span className="text-[9px] font-mono text-zinc-600 px-2 py-3 text-center">
            {rows.length === 0 ? emptyText : 'No matches'}
          </span>
        )}
        <div
          id={listId}
          role="listbox"
          aria-label={`${TAB_LABEL[tab]} in the library`}
          tabIndex={-1}
          className="flex flex-col gap-0.5"
        >
          {shown.map((row, i) => (
            <div
              key={row.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                if (!busy) void choose(row);
              }}
              title={`Add "${row.label}"`}
              className={`w-full flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition-colors ${
                i === active ? 'bg-purple-500/20' : 'hover:bg-purple-500/10'
              }`}
            >
              {row.favorite ? (
                <Star className="w-3 h-3 text-amber-400 fill-amber-400 shrink-0" />
              ) : (
                <RowIcon className="w-3 h-3 text-zinc-600 shrink-0" />
              )}
              <span className="flex-1 min-w-0 flex flex-col">
                <span className="truncate text-[10px] text-zinc-200">{row.label}</span>
                {row.meta.length > 0 && (
                  <span className="truncate text-[8px] font-mono text-zinc-600">
                    {row.meta.join(' · ')}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
        {hidden > 0 && (
          <span className="text-[8px] font-mono text-zinc-600 px-2 py-2 text-center">
            {hidden} more — narrow the search to reach them
          </span>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-white/5 text-[8px] font-mono text-zinc-600 shrink-0">
        {busy ? 'loading the pick…' : `${visible.length} of ${rows.length} ${TAB_LABEL[tab].toLowerCase()}`}
      </div>
    </div>
  );

  return createPortal(
    anchored ? (
      card
    ) : (
      <div
        className="fixed inset-0 z-200 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {card}
      </div>
    ),
    document.body,
  );
};
