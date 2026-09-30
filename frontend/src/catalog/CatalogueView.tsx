import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, Loader2, Minimize2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useLibraryStore } from '../state/libraryStore';
import { LibraryIndexProgress } from '../components/library/LibraryIndexProgress';
import { useLibraryIndexStatus } from '../state/libraryIndexStatusStore';
import { libraryOpeningText } from '../lib/libraryIndexStatus';
import { useCatalogueUiStore, selectSearchState } from './catalogueUiStore';
import { applyCatalogueServerQuery, filterAndSort, isServerOnly } from './catalogSearch';
import { CatalogueFilterBar } from './CatalogueFilterBar';
import { CatalogueList } from './CatalogueList';
import { CatalogueGrid } from './CatalogueGrid';
import { CatalogueInspector } from './CatalogueInspector';
import { CatalogueContextMenu, type CatalogueContextMenuState } from './CatalogueContextMenu';
import type { LibraryEntry } from '../state/libraryEntry';

/**
 * CatalogueView — the Catalogue tab. A rich VIEW over the existing library
 * store (single source of truth): robust search, a deep metadata inspector,
 * and a detailed lineage viewer. No new store, no IndexedDB.
 *
 * ── Where the filtering happens ───────────────────────────────────────────
 * The library is paged now, so the Catalogue's query text, favourites, source,
 * provider and sort go to the BACKEND through the shared store and the list
 * renders the result set by index — 200,000 entries scroll without being in
 * memory.
 *
 * Its remaining knobs (a field-scoped target, the stricter match modes, an
 * exact model, a rating, a duration window) have no server equivalent. With
 * any of those set, the view refines the rows it has loaded and says so above
 * the list, rather than quietly claiming to have searched the whole library.
 *
 * Layout: filter bar header · list|grid body · slide-in inspector on the right
 * when an entry is selected · right-click context menu.
 */
export const CatalogueView: React.FC<{ onCollapse?: () => void }> = ({ onCollapse }) => {
  // Library store (source of truth).
  const entries = useLibraryStore((s) => s.entries);
  const total = useLibraryStore((s) => s.total);
  const pagesLoading = useLibraryStore((s) => s.pagesLoading);
  const pageError = useLibraryStore((s) => s.pageError);
  const libraryOpening = useLibraryStore((s) => s.libraryOpening);
  const indexStatus = useLibraryIndexStatus((s) => s.status);
  const entryAt = useLibraryStore((s) => s.entryAt);
  const ensureRange = useLibraryStore((s) => s.ensureRange);
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);

  // Local view UI state.
  const viewMode = useCatalogueUiStore((s) => s.viewMode);
  // CHANGED: wrap `selectSearchState` in `useShallow`. The selector builds a
  // FRESH object every call; under zustand v5 an unstable selector output
  // triggers "Maximum update depth exceeded" (the classic render loop). With
  // `useShallow` the hook returns the SAME reference while the slice is
  // shallow-equal, so this render + the downstream `useMemo` stay stable.
  const searchState = useCatalogueUiStore(useShallow(selectSearchState));

  const [contextMenu, setContextMenu] = useState<CatalogueContextMenuState | null>(null);

  // CHANGED: REFRESH on every mount (i.e. each time the Catalog tab is opened),
  // not just a first-time load. The old `if (!loaded) load()` left the Catalogue
  // showing stale data when entries changed elsewhere — e.g. a Suno generation
  // that registered into the library after the first (empty) load never appeared
  // until a hard reload.
  useEffect(() => {
    // Read at mount, never subscribed: this runs once per mount.
    const library = useLibraryStore.getState();
    if (!library.loaded) void library.load();
    else void library.refresh();
  }, []);

  // Drive the SERVER query from the filter bar — text, favourites, sort,
  // source AND provider, all through the one sync path. The store debounces
  // the text, so typing costs one request per pause rather than one per
  // keystroke, and each setter is a no-op when the value already matches, so
  // opening the tab does not throw the page cache away and fetch it again.
  useEffect(() => {
    applyCatalogueServerQuery(searchState, useLibraryStore.getState());
  }, [searchState]);

  // Everything the backend applied is already in the result set; only the
  // knobs it cannot apply need a client-side pass, and that pass can only see
  // the rows in hand.
  const serverOnly = isServerOnly(searchState);
  const refined = useMemo(
    () => (serverOnly ? null : filterAndSort([...entries], searchState)),
    [serverOnly, entries, searchState],
  );

  const rowCount = refined ? refined.length : total;
  const refinedEntryAt = useCallback(
    (index: number) => (refined ? refined[index] : undefined),
    [refined],
  );
  const rowAt = refined ? refinedEntryAt : entryAt;
  const onRangeRendered = useCallback((start: number, end: number) => {
    void ensureRange(start, end);
  }, [ensureRange]);

  // A store selector: it runs again on every store change, so a page landing
  // or a single-entry fetch that makes this id resolvable re-renders here.
  const selectedEntry = useLibraryStore((s) =>
    selectedEntryId ? s.getById(selectedEntryId) ?? null : null,
  );

  const handleContextMenu = (e: React.MouseEvent, entry: LibraryEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedEntry(entry.id);
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  };

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center">
        <div className="flex-1 min-w-0">
          <CatalogueFilterBar resultCount={rowCount} />
        </div>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            className="shrink-0 mx-2 p-1.5 rounded border border-teal-500/30 bg-teal-500/10 hover:bg-teal-500/20 text-teal-300 transition-colors"
            title="Collapse to side panel"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* One honest line about what was searched, plus the loading and error
          states the paged store reports. */}
      <div className="shrink-0 flex items-center gap-2 px-2 pb-1 text-xs font-bold text-zinc-400">
        <span>
          {rowCount.toLocaleString()} {rowCount === 1 ? 'track' : 'tracks'}
          {searchState.query.trim() ? ` · showing results for “${searchState.query.trim()}”` : ''}
        </span>
        {!serverOnly && (
          <span className="text-amber-300/80" title="These filters have no server equivalent, so they narrow the rows already loaded.">
            · refined over {entries.length.toLocaleString()} loaded rows
          </span>
        )}
        {pagesLoading > 0 && (
          <Loader2 className="w-2.5 h-2.5 animate-spin text-purple-400" aria-label="Loading more rows" />
        )}
      </div>
      {/* The backend opening the library (upgrade, first read, search index
          build); hidden once it is ready. */}
      <div className="shrink-0 mx-2 mb-1 empty:hidden">
        <LibraryIndexProgress />
      </div>
      {pageError && (
        <div
          role="alert"
          className="shrink-0 mx-2 mb-1 flex items-center gap-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs font-bold text-rose-200"
        >
          <span className="flex-1 min-w-0 truncate" title={pageError}>{pageError}</span>
          <button
            type="button"
            onClick={() => { void useLibraryStore.getState().retryPages(); }}
            className="shrink-0 rounded border border-rose-400/40 px-1.5 py-0.5 text-rose-200 hover:bg-rose-500/20"
          >
            Retry
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          {rowCount === 0 && pagesLoading === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center opacity-30 italic gap-2">
              <Database className="w-8 h-8" />
              {libraryOpening ? (
                <p className="text-xs font-bold not-italic">{libraryOpeningText(indexStatus)}</p>
              ) : searchState.query.trim() || !serverOnly || searchState.onlyFavorites ? (
                <p className="text-xs font-bold">No entries match your search.</p>
              ) : (
                <p className="text-xs font-bold">Library is empty — generate or import a track.</p>
              )}
            </div>
          ) : viewMode === 'list' ? (
            <CatalogueList
              rowCount={rowCount}
              entryAt={rowAt}
              loadedRows={entries}
              onRangeRendered={refined ? undefined : onRangeRendered}
              onContextMenu={handleContextMenu}
            />
          ) : (
            <CatalogueGrid
              rowCount={rowCount}
              entryAt={rowAt}
              loadedRows={entries}
              onRangeRendered={refined ? undefined : onRangeRendered}
              onContextMenu={handleContextMenu}
            />
          )}
        </div>

        {selectedEntry && <CatalogueInspector entry={selectedEntry} />}
      </div>

      {contextMenu && (
        <CatalogueContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
      )}
    </div>
  );
};
