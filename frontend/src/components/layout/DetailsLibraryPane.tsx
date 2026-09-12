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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, Library, Loader2, Pause, Play, Search, Send, Star, Volume2, Wand2 } from 'lucide-react';
import { CoverArt } from '../../catalog/CoverArt';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { AUDIO_ACCEPT } from '../../lib/fileFilters';
import { importAudioFiles, isAudioFile, type AudioImportOrigin } from '../../lib/importAudioFiles';
import {
  DESKTOP_DROP_ORIGIN,
  LIBRARY_ID_MIME,
  entriesFromDrop,
  libraryListDropIntent,
} from '../../lib/libraryDrop';
import {
  libraryCountLabel,
  libraryListRows,
  libraryRowText,
  type LibrarySortBy,
} from '../../lib/libraryRows';
import { setAudioDragData } from '../../lib/audioDnD';
import { sendAudioToEditor, sendAudioToInit, type SendableAudio } from '../../lib/sendToTargets';
import { useLibraryStore, type LibraryEntry } from '../../state/libraryStore';
import { usePlayerStore } from '../../state/playerStore';
import { useStatusBarStore } from '../../state/statusBarStore';
import { logError, logInfo, logWarn } from '../../state/logStore';

const FILTER_ID = 'details-library-filter';
const SORT_ID = 'details-library-sort';
const IMPORT_ID = 'details-library-import-files';

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

export const DetailsLibraryPane: React.FC = () => {
  const entries = useLibraryStore((s) => s.entries);
  const loaded = useLibraryStore((s) => s.loaded);
  const loading = useLibraryStore((s) => s.loading);
  const sortBy = useLibraryStore((s) => s.sortBy);
  const setSortBy = useLibraryStore((s) => s.setSortBy);
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  const playingEntryId = usePlayerStore((s) => s.currentEntryId);
  const playerIsPlaying = usePlayerStore((s) => s.isPlaying);

  const [query, setQuery] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rowMenu = useContextMenu<LibraryEntry>();

  // The Shell loads the library on startup; this covers the case where the
  // DETAILS tab is opened before the backend was ready to answer.
  useEffect(() => {
    if (!isBackendReady || loaded) return;
    void useLibraryStore.getState().load();
  }, [isBackendReady, loaded]);

  const rows = useMemo(() => libraryListRows(entries, sortBy, query), [entries, sortBy, query]);
  // Roving tabindex: exactly one row is a tab stop — the browsed one, or the
  // first row when the selection is elsewhere (or filtered out), so Tab can
  // always reach the list and the arrows take over from there.
  const tabStopId = rows.find((r) => r.id === selectedEntryId)?.id ?? rows[0]?.id;

  const rowEl = (id: string): HTMLElement | null =>
    listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${id}"]`) ?? null;

  // Whatever selected the entry — a row here, a LIBRARY row's "Open details",
  // the orb — the browsed row is brought into view.
  useEffect(() => {
    if (!selectedEntryId) return;
    rowEl(selectedEntryId)?.scrollIntoView({ block: 'nearest' });
  }, [selectedEntryId, rows]);

  const playEntry = async (entry: LibraryEntry) => {
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
  };

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

  // Roving focus through the list: the browsed row is the one tab stop, and
  // the arrows move the selection (so the details pane follows the keyboard).
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const current = rows.find((r) => r.id === selectedEntryId);
      if (current) {
        e.preventDefault();
        void playEntry(current);
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    if (rows.length === 0) return;
    e.preventDefault();
    const at = rows.findIndex((r) => r.id === selectedEntryId);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else if (at < 0) next = e.key === 'ArrowDown' ? 0 : rows.length - 1;
    else next = Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    const target = rows[next];
    if (!target) return;
    setSelectedEntry(target.id);
    rowEl(target.id)?.focus();
  };

  const emptyMessage = (): string => {
    if (!loaded) return loading ? 'Loading the library…' : 'Waiting for the backend…';
    if (entries.length === 0) return 'The library is empty — drop audio files here, or click IMPORT.';
    return `No track matches “${query.trim()}”.`;
  };

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
        <span className="text-[9px] font-mono text-zinc-500 truncate flex items-center gap-1.5">
          <Library className="w-3 h-3 text-purple-300 shrink-0" aria-hidden="true" />
          {libraryCountLabel(entries.length, rows.length)}
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
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="btn-ghost text-[9px] py-1 flex items-center gap-1.5 shrink-0"
          title="Import audio files into the library — or drop them anywhere in this list"
        >
          <FolderPlus className="w-3 h-3 text-purple-300" aria-hidden="true" /> IMPORT
        </button>
      </div>

      {/* Filter + sort. The filter is local to this pane, so the column always
          opens on the whole library; the sort IS the library's own, so picking
          one here reorders the LIBRARY list too. */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-white/5 bg-black/20 shrink-0">
        <Search className="w-3 h-3 text-purple-300 shrink-0" aria-hidden="true" />
        <label htmlFor={FILTER_ID} className="sr-only">Filter the library</label>
        <input
          id={FILTER_ID}
          name={FILTER_ID}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter title / prompt / tags…"
          spellCheck={false}
          className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-purple-400/50"
        />
        <label htmlFor={SORT_ID} className="sr-only">Sort the library</label>
        <select
          id={SORT_ID}
          name={SORT_ID}
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as LibrarySortBy)}
          className="bg-black/40 border border-white/10 rounded px-1 py-1 text-[9px] font-mono text-zinc-300 focus:outline-none focus:border-purple-400/50"
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
        ref={listRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`flex-1 min-h-0 overflow-y-auto p-1.5 transition-colors ${
          dragOver ? 'ring-1 ring-inset ring-purple-400/60 bg-purple-500/5' : ''
        }`}
      >
        {rows.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 px-4 text-center text-zinc-700 italic">
            {loading && !loaded ? (
              <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
            ) : (
              <Library className="w-6 h-6" aria-hidden="true" />
            )}
            <p className="text-[10px] font-mono uppercase tracking-widest">{emptyMessage()}</p>
          </div>
        ) : (
          <div
            role="listbox"
            aria-label="Library tracks"
            onKeyDown={onListKeyDown}
            className="flex flex-col gap-1"
          >
            {rows.map((entry) => {
              const text = libraryRowText(entry);
              const selected = entry.id === selectedEntryId;
              const sounding = playingEntryId === entry.id && playerIsPlaying;
              return (
                <div
                  key={entry.id}
                  data-entry-id={entry.id}
                  role="option"
                  aria-selected={selected}
                  tabIndex={entry.id === tabStopId ? 0 : -1}
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
                  onClick={() => setSelectedEntry(entry.id)}
                  onDoubleClick={() => { void playEntry(entry); }}
                  onContextMenu={(e) => {
                    setSelectedEntry(entry.id);
                    rowMenu.open(e, entry);
                  }}
                  title={`${text.title}\nClick to inspect · double-click to play · drag onto a track, a deck or the INIT slot`}
                  className={`flex items-center gap-2 px-1.5 py-1 rounded border cursor-grab active:cursor-grabbing transition-colors hover:bg-white/4 focus:outline-none focus-visible:ring-1 focus-visible:ring-purple-400/80 ${
                    selected
                      ? 'border-purple-400/50 ring-1 ring-purple-500/40 bg-purple-500/6'
                      : 'border-white/5 bg-black/20'
                  }`}
                >
                  <CoverArt
                    coverUrl={entry.coverUrl}
                    title={text.title}
                    className="w-7 h-7 shrink-0 rounded-sm"
                    iconClassName="w-3 h-3"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <p className="text-[10px] font-bold text-zinc-200 truncate">{text.title}</p>
                      {entry.favorite && (
                        <Star className="w-2.5 h-2.5 shrink-0 text-yellow-500 fill-current" aria-hidden="true" />
                      )}
                    </div>
                    <p className="text-[8px] font-mono text-zinc-600 truncate">{text.meta}</p>
                  </div>
                  {sounding && (
                    <Volume2 className="w-3 h-3 shrink-0 text-purple-300" aria-hidden="true" />
                  )}
                </div>
              );
            })}
          </div>
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
