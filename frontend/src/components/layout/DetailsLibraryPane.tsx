/**
 * The whole library, as a column narrow enough to live beside the details.
 *
 * This is the right-hand half of the DETAILS tab's SPLIT layout: click a row
 * and DetailsView on the left inspects it, so the tab becomes one
 * browse-and-inspect pair instead of a details pane with nothing to point it
 * at. (The media bucket — loose files that are not library entries — is still
 * the other choice for this column, and still fills the tab on DETAILS →
 * Media.)
 *
 * ── Paging ────────────────────────────────────────────────────────────────
 * The library store holds a sparse window of a result set that can be 200,000
 * rows long, so this column is a react-window `List` over GLOBAL indices: it
 * renders a screenful, asks the store for the range it rendered, and draws a
 * placeholder for a row whose page is still coming. Filter and sort are the
 * LIBRARY's own — the backend applies both — which is what lets the column
 * scroll the whole library instead of the few hundred rows in hand. Picking a
 * sort or typing a filter here therefore moves the LIBRARY list too; the sort
 * always did, and the filter now does for the same reason.
 *
 * What it deliberately does NOT do: fetch audio, decode, or compute peaks to
 * draw a row. A row is text plus the lazy cover thumbnail the library already
 * served; bytes are fetched only when the user plays, drags or sends a track.
 *
 * Drag and drop, both directions:
 *  - OUT: every row carries `LIBRARY_ID_MIME` plus an `audioDnD` ref, the same
 *    contract LibraryView's rows use, so a track drags from here onto an EDIT
 *    track, a DJ deck, MAKE's init slot — anywhere that already takes a
 *    library drag.
 *  - IN: audio files dropped from Explorer / Finder import into the library
 *    (via `entriesFromDrop`, the one import path) and the newest lands
 *    selected. A library row dropped back on the library is ignored — see
 *    `libraryListDropIntent`.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window';
import { FolderPlus, Library, Loader2, Pause, Play, Search, Send, Star, Volume2, Wand2 } from 'lucide-react';
import { CoverArt } from '../../catalog/CoverArt';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { AUDIO_ACCEPT, AUDIO_EXTS } from '../../lib/fileFilters';
import { KnownFilesMenu } from '../ui/KnownFilesMenu';
import { importAudioFiles, isAudioFile, type AudioImportOrigin } from '../../lib/importAudioFiles';
import {
  DESKTOP_DROP_ORIGIN,
  LIBRARY_ID_MIME,
  entriesFromDrop,
  libraryListDropIntent,
} from '../../lib/libraryDrop';
import { libraryRowText, type LibrarySortBy } from '../../lib/libraryRows';
import { pagedIndexOf } from '../../lib/pagedIndexOf';
import { setAudioDragData } from '../../lib/audioDnD';
import { sendAudioToEditor, sendAudioToInit, type SendableAudio } from '../../lib/sendToTargets';
import { LIBRARY_PAGE_SIZE, useLibraryStore, type LibraryEntry } from '../../state/libraryStore';
import { LibraryIndexProgress } from '../library/LibraryIndexProgress';
import { useLibraryIndexStatus } from '../../state/libraryIndexStatusStore';
import { libraryOpeningText } from '../../lib/libraryIndexStatus';
import { usePlayerStore } from '../../state/playerStore';
import { useStatusBarStore } from '../../state/statusBarStore';
import { logError, logInfo, logWarn } from '../../state/logStore';

const FILTER_ID = 'details-library-filter';
const SORT_ID = 'details-library-sort';
const IMPORT_ID = 'details-library-import-files';
const RECENT_AUDIO_EXTS = [...AUDIO_EXTS];

/** One row: a 28px cover in 4px of padding, plus the 4px gap under it. */
const ROW_HEIGHT = 40;

const PICKER_ORIGIN: AudioImportOrigin = {
  prompt: 'Imported from the details library',
  tags: ['imported'],
};

const SORT_OPTIONS: ReadonlyArray<{ value: LibrarySortBy; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title', label: 'Title' },
  { value: 'duration', label: 'Length' },
  { value: 'plays', label: 'Plays' },
];

/** The audio a row stands for, fetched only if something actually asks. */
const sendable = (entry: LibraryEntry): SendableAudio => ({
  label: entry.title,
  fetcher: () => useLibraryStore.getState().fetchAudioBlob(entry),
  mimeType: entry.mimeType,
  entryId: entry.id,
});

/** Props every row gets through react-window v2's `rowProps`. */
interface PaneRowProps {
  /** The row at a GLOBAL index, or undefined while its page is coming. */
  entryAt: (index: number) => LibraryEntry | undefined;
  /** New reference whenever a page lands, so rows re-read `entryAt`. */
  loadedRows: readonly LibraryEntry[];
  /** Ids are built from this so `aria-activedescendant` can point at a row. */
  rowIdPrefix: string;
  selectedEntryId: string | null;
  focusIndex: number;
  playingEntryId: string | null;
  playerIsPlaying: boolean;
  onSelect: (index: number, entry: LibraryEntry) => void;
  onPlay: (entry: LibraryEntry) => void;
  onContextMenu: (e: React.MouseEvent, index: number, entry: LibraryEntry) => void;
}

function PaneRow({
  index,
  style,
  ariaAttributes,
  entryAt,
  rowIdPrefix,
  selectedEntryId,
  focusIndex,
  playingEntryId,
  playerIsPlaying,
  onSelect,
  onPlay,
  onContextMenu,
}: RowComponentProps<PaneRowProps>) {
  const entry = entryAt(index);
  if (!entry) {
    // The page is still coming: the same box, so the scrollbar does not jump.
    // It stays an `option` — a listbox may only contain options, and a bare
    // div here would make the whole list invalid while pages are in flight.
    return (
      <div style={style} className="px-1.5">
        <div
          {...ariaAttributes}
          role="option"
          id={`${rowIdPrefix}-${index}`}
          aria-selected={false}
          aria-label="Loading this track"
          className="flex h-9 items-center gap-2 rounded border border-white/5 bg-black/20 px-1.5 animate-pulse"
        >
          <div aria-hidden="true" className="h-7 w-7 shrink-0 rounded-sm bg-white/5" />
          <div aria-hidden="true" className="flex-1 min-w-0 flex flex-col gap-1">
            <div className="h-2 w-1/2 rounded bg-white/5" />
            <div className="h-1.5 w-1/3 rounded bg-white/5" />
          </div>
        </div>
      </div>
    );
  }

  const text = libraryRowText(entry);
  const selected = entry.id === selectedEntryId;
  const sounding = playingEntryId === entry.id && playerIsPlaying;

  return (
    <div style={style} className="px-1.5">
      <div
        {...ariaAttributes}
        role="option"
        id={`${rowIdPrefix}-${index}`}
        data-entry-id={entry.id}
        aria-selected={selected}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(LIBRARY_ID_MIME, entry.id);
          e.dataTransfer.setData('text/plain', entry.title);
          e.dataTransfer.effectAllowed = 'copyMove';
          setAudioDragData(e, [{
            fetcher: () => useLibraryStore.getState().fetchAudioBlob(entry),
            mimeType: entry.mimeType,
            label: entry.title,
            entryId: entry.id,
          }]);
        }}
        onClick={() => onSelect(index, entry)}
        onDoubleClick={() => onPlay(entry)}
        onContextMenu={(e) => onContextMenu(e, index, entry)}
        title={`${text.title}\nClick to inspect · double-click to play · drag onto a track, a deck or the INIT slot`}
        className={`flex h-9 items-center gap-2 rounded border px-1.5 cursor-grab active:cursor-grabbing transition-colors hover:bg-white/4 ${
          selected
            ? 'border-purple-400/50 ring-1 ring-purple-500/40 bg-purple-500/6'
            : 'border-white/5 bg-black/20'
        } ${index === focusIndex ? 'outline outline-1 outline-purple-400/70' : ''}`}
      >
        <CoverArt
          coverUrl={entry.coverUrl}
          title={text.title}
          className="w-7 h-7 shrink-0 rounded-sm"
          iconClassName="w-3 h-3"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <p className="text-xs leading-4 font-bold text-zinc-200 truncate">{text.title}</p>
            {entry.favorite && (
              <Star className="w-2.5 h-2.5 shrink-0 text-yellow-500 fill-current" aria-hidden="true" />
            )}
          </div>
          <p className="text-xs leading-4 font-bold text-zinc-500 truncate">{text.meta}</p>
        </div>
        {sounding && <Volume2 className="w-3 h-3 shrink-0 text-purple-300" aria-hidden="true" />}
      </div>
    </div>
  );
}

export const DetailsLibraryPane: React.FC = () => {
  const entries = useLibraryStore((s) => s.entries);
  const total = useLibraryStore((s) => s.total);
  const entryAt = useLibraryStore((s) => s.entryAt);
  const ensureRange = useLibraryStore((s) => s.ensureRange);
  const loaded = useLibraryStore((s) => s.loaded);
  const libraryOpening = useLibraryStore((s) => s.libraryOpening);
  const indexStatus = useLibraryIndexStatus((s) => s.status);
  const loading = useLibraryStore((s) => s.loading);
  const pageError = useLibraryStore((s) => s.pageError);
  const sortBy = useLibraryStore((s) => s.sortBy);
  const setSortBy = useLibraryStore((s) => s.setSortBy);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  const playingEntryId = usePlayerStore((s) => s.currentEntryId);
  const playerIsPlaying = usePlayerStore((s) => s.isPlaying);

  // The store debounces the request; this keeps the field itself instant.
  const [queryDraft, setQueryDraft] = useState(searchQuery);
  const [dragOver, setDragOver] = useState(false);
  /** The row the keyboard is on — the list's one tab stop lives on the list. */
  const [focusIndex, setFocusIndex] = useState(0);
  // The focus as of the last commit, for the selection follower below: it
  // reads the focus but must not run again when only the focus moves (the
  // keyboard moving off the selected row would be pulled straight back).
  const focusIndexRef = useRef(focusIndex);
  useEffect(() => {
    focusIndexRef.current = focusIndex;
  }, [focusIndex]);
  const listRef = useRef<ListImperativeAPI | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rowMenu = useContextMenu<LibraryEntry>();
  const rowIdPrefix = React.useId();
  const listboxId = `${rowIdPrefix}-listbox`;

  // The Shell loads the library on startup; this covers the case where the
  // DETAILS tab is opened before the backend was ready to answer.
  useEffect(() => {
    if (!isBackendReady || loaded) return;
    void useLibraryStore.getState().load();
  }, [isBackendReady, loaded]);

  // The search box follows the library when something else changes it.
  useEffect(() => {
    setQueryDraft(searchQuery);
  }, [searchQuery]);

  // Whatever selected the entry — a row here, a LIBRARY row's "Open details",
  // the orb — bring the browsed row into view. A selection made HERE already
  // knows its index, so the lookup only runs for one that came from outside,
  // and it walks loaded pages only (see `pagedIndexOf`). A row on no loaded
  // page is left alone rather than chased: the list is where the user is.
  useEffect(() => {
    if (!selectedEntryId) return;
    if (entryAt(focusIndexRef.current)?.id === selectedEntryId) return;
    const at = pagedIndexOf(selectedEntryId, total, entryAt, LIBRARY_PAGE_SIZE);
    if (at < 0) return;
    setFocusIndex(at);
    listRef.current?.scrollToRow({ index: at, align: 'smart' });
    // `entries` is in the deps because a page landing can make a previously
    // unlocatable selection locatable; `entryAt` reads the pages it holds.
  }, [selectedEntryId, entries, total, entryAt]);

  const playEntry = useCallback(async (entry: LibraryEntry) => {
    const player = usePlayerStore.getState();
    if (player.currentEntryId === entry.id) {
      if (player.isPlaying) player.pause();
      else player.play();
      return;
    }
    try {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      await usePlayerStore.getState().load(blob, { label: entry.title, entryId: entry.id });
      usePlayerStore.getState().play();
      useLibraryStore.getState().setPlayingId(entry.id);
    } catch (e) {
      logError('library', `Could not play ${entry.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const importFiles = async (files: File[], origin: AudioImportOrigin) => {
    const audio = files.filter(isAudioFile);
    const skipped = files.filter((f) => !isAudioFile(f));
    if (skipped.length > 0) {
      logWarn('import', `${skipped.length} non-audio file(s) skipped: ${skipped.map((f) => f.name).join(', ')}`);
    }
    if (audio.length === 0) return;
    const { imported } = await importAudioFiles(audio, origin);
    const newest = imported[imported.length - 1];
    if (newest) setSelectedEntry(newest.id);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (libraryListDropIntent(e.dataTransfer) !== 'import') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    setDragOver(false);
    const dt = e.dataTransfer;
    if (libraryListDropIntent(dt) !== 'import') return;
    e.preventDefault();
    // Every DataTransfer read happens inside entriesFromDrop before its first
    // await — the browser protects it the moment this handler yields.
    void entriesFromDrop(dt, { mimes: [], entries: [], origin: DESKTOP_DROP_ORIGIN }).then((imported) => {
      const newest = imported[imported.length - 1];
      if (!newest) return;
      setSelectedEntry(newest.id);
      logInfo('library', `Imported ${imported.length} file(s) from the desktop into the library`);
    });
  };

  const handleRowsRendered = useCallback((
    _visible: { startIndex: number; stopIndex: number },
    rendered: { startIndex: number; stopIndex: number },
  ) => {
    void ensureRange(rendered.startIndex, rendered.stopIndex);
  }, [ensureRange]);

  const selectAt = useCallback((index: number, entry: LibraryEntry) => {
    setFocusIndex(index);
    setSelectedEntry(entry.id);
  }, [setSelectedEntry]);

  /**
   * Arrows move the keyboard row through the WHOLE result set, not just the
   * rows in hand: the target index is scrolled to and its page requested, and
   * the selection follows so the details pane on the left keeps up.
   */
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (total === 0) return;
    if (e.key === 'Enter') {
      const entry = entryAt(focusIndex);
      if (!entry) return;
      e.preventDefault();
      void playEntry(entry);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) return;
    e.preventDefault();
    const page = 10;
    let next: number;
    switch (e.key) {
      case 'Home': next = 0; break;
      case 'End': next = total - 1; break;
      case 'PageDown': next = focusIndex + page; break;
      case 'PageUp': next = focusIndex - page; break;
      case 'ArrowDown': next = focusIndex + 1; break;
      default: next = focusIndex - 1; break;
    }
    next = Math.min(total - 1, Math.max(0, next));
    setFocusIndex(next);
    listRef.current?.scrollToRow({ index: next, align: 'smart' });
    void ensureRange(next, next).then(() => {
      const entry = useLibraryStore.getState().entryAt(next);
      if (entry) setSelectedEntry(entry.id);
    });
  };

  const emptyMessage = (): string => {
    if (pageError) return `The library could not be read: ${pageError}`;
    if (libraryOpening) return libraryOpeningText(indexStatus);
    if (!loaded) return loading ? 'Loading the library…' : 'Waiting for the backend…';
    if (searchQuery.trim()) return `No track matches “${searchQuery.trim()}”.`;
    return 'The library is empty — drop audio files here, or click IMPORT.';
  };

  const countLabel = searchQuery.trim()
    ? `${total.toLocaleString()} matching`
    : `${total.toLocaleString()} ${total === 1 ? 'track' : 'tracks'}`;

  const menuEntry = rowMenu.payload;
  const menuItems: ContextMenuItem[] = menuEntry
    ? [
        {
          type: 'item',
          label: playingEntryId === menuEntry.id && playerIsPlaying ? 'Pause' : 'Play',
          icon: playingEntryId === menuEntry.id && playerIsPlaying
            ? <Pause className="w-3 h-3" />
            : <Play className="w-3 h-3" />,
          onSelect: () => { void playEntry(menuEntry); },
        },
        {
          type: 'item',
          label: 'Send to editor (new track)',
          icon: <Send className="w-3 h-3" />,
          onSelect: () => { void sendAudioToEditor(sendable(menuEntry), 'editor-new-track'); },
        },
        {
          type: 'item',
          label: 'Send to INIT',
          icon: <Wand2 className="w-3 h-3" />,
          onSelect: () => { void sendAudioToInit(sendable(menuEntry)); },
        },
        { type: 'separator' },
        {
          type: 'item',
          label: menuEntry.favorite ? 'Unfavorite' : 'Favorite',
          icon: <Star className="w-3 h-3" />,
          onSelect: () => { void useLibraryStore.getState().toggleFavorite(menuEntry.id); },
        },
      ]
    : [];

  return (
    <div className="h-full flex flex-col bg-[#0a080f]">
      {/* Toolbar: what the list is showing, and the keyboard route to import. */}
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-white/5 bg-black/40 shrink-0">
        <span className="text-xs font-bold text-zinc-400 truncate flex items-center gap-1.5">
          <Library className="w-3 h-3 text-purple-300 shrink-0" aria-hidden="true" />
          {countLabel}
        </span>
        {/* A real labelled field, visually hidden with sr-only rather than
            display:none (which would drop it out of the accessibility tree and
            leave its label naming nothing). It stays out of the Tab order
            because the IMPORT button beside it is the keyboard route. */}
        <label htmlFor={IMPORT_ID} className="sr-only">
          Audio files to import into the library
        </label>
        <input
          ref={fileInputRef}
          id={IMPORT_ID}
          name={IMPORT_ID}
          type="file"
          accept={AUDIO_ACCEPT}
          multiple
          tabIndex={-1}
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) void importFiles(files, PICKER_ORIGIN);
          }}
        />
        <div className="flex items-center gap-1.5 shrink-0">
          <KnownFilesMenu
            id="details-library-recent-audio"
            exts={RECENT_AUDIO_EXTS}
            label="Recent"
            onFiles={(files) => void importFiles(files, PICKER_ORIGIN)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="btn-ghost text-xs font-bold py-1 flex items-center gap-1.5 shrink-0"
            title="Import audio files into the library — or drop them anywhere in this list"
          >
            <FolderPlus className="w-3 h-3 text-purple-300" aria-hidden="true" /> IMPORT
          </button>
        </div>
      </div>

      {/* The backend opening the library (upgrade, first read, search index
          build); hidden once it is ready. */}
      <div className="px-2 pt-1.5 empty:hidden">
        <LibraryIndexProgress />
      </div>

      {/* Filter + sort. Both are the LIBRARY's own and the backend applies
          them, which is what lets this column scroll past the rows in hand —
          so choosing either here reorders/narrows the LIBRARY list too. */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-white/5 bg-black/20 shrink-0">
        <Search className="w-3 h-3 text-purple-300 shrink-0" aria-hidden="true" />
        <label htmlFor={FILTER_ID} className="sr-only">Search the library</label>
        <input
          id={FILTER_ID}
          name={FILTER_ID}
          type="text"
          value={queryDraft}
          onChange={(e) => {
            setQueryDraft(e.target.value);
            setSearchQuery(e.target.value);
          }}
          placeholder="Search title / prompt / tags…"
          spellCheck={false}
          className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded px-2 py-1 text-xs font-bold text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-purple-400/50"
        />
        <label htmlFor={SORT_ID} className="sr-only">Sort the library</label>
        <select
          id={SORT_ID}
          name={SORT_ID}
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as LibrarySortBy)}
          className="bg-black/40 border border-white/10 rounded px-1 py-1 text-xs font-bold text-zinc-300 focus:outline-none focus:border-purple-400/50"
          title="The library's sort order"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* The list, and the drop target for files off the desktop. ring-inset so
          the highlight is not clipped by the scroll container's own edge. */}
      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex-1 min-h-0 py-1.5 transition-colors ${
          dragOver ? 'ring-1 ring-inset ring-purple-400/60 bg-purple-500/5' : ''
        }`}
      >
        {total === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 px-4 text-center text-zinc-700 italic">
            {loading && !loaded ? (
              <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
            ) : (
              <Library className="w-6 h-6" aria-hidden="true" />
            )}
            <p className="text-xs font-bold font-sans not-italic">{emptyMessage()}</p>
          </div>
        ) : (
          <List
            listRef={listRef}
            rowComponent={PaneRow}
            rowCount={total}
            rowHeight={ROW_HEIGHT}
            rowProps={{
              entryAt,
              loadedRows: entries,
              rowIdPrefix,
              selectedEntryId,
              focusIndex,
              playingEntryId,
              playerIsPlaying,
              onSelect: selectAt,
              onPlay: (entry: LibraryEntry) => { void playEntry(entry); },
              onContextMenu: (e: React.MouseEvent, index: number, entry: LibraryEntry) => {
                selectAt(index, entry);
                rowMenu.open(e, entry);
              },
            }}
            overscanCount={8}
            onRowsRendered={handleRowsRendered}
            onKeyDown={onListKeyDown}
            // react-window's root is a `role="list"`; this column has always
            // been a single-select listbox, and the rows override `listitem`
            // with `option` to match.
            role="listbox"
            id={listboxId}
            tabIndex={0}
            aria-label="Library tracks"
            aria-activedescendant={`${rowIdPrefix}-${focusIndex}`}
            style={{ height: '100%' }}
          />
        )}
      </div>

      {menuEntry && (
        <ContextMenu
          position={rowMenu.position}
          onClose={rowMenu.close}
          items={menuItems}
          title={menuEntry.title}
          minWidth="13rem"
        />
      )}
    </div>
  );
};
