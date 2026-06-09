import React, { useEffect, useMemo, useState } from 'react';
import { Database, Minimize2 } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useLibraryStore } from '../state/libraryStore';
import { useCatalogueUiStore, selectSearchState } from './catalogueUiStore';
import { filterAndSort } from './catalogSearch';
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
 * Layout: filter bar header · list|grid body · slide-in inspector on the right
 * when an entry is selected · right-click context menu.
 */
export const CatalogueView: React.FC<{ onCollapse?: () => void }> = ({ onCollapse }) => {
  // Library store (source of truth).
  const loaded = useLibraryStore((s) => s.loaded);
  const entries = useLibraryStore((s) => s.entries);
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);

  // Local view UI state.
  const viewMode = useCatalogueUiStore((s) => s.viewMode);
  // CHANGED: wrap `selectSearchState` in `useShallow`. The selector builds a
  // FRESH object every call; under zustand v5 an unstable selector output
  // triggers "Maximum update depth exceeded" (the classic render loop). With
  // `useShallow` the hook returns the SAME reference while the slice is
  // shallow-equal, so this render + the downstream `useMemo(filterAndSort)`
  // stay stable. (Verified against zustand v5 migration docs via context7.)
  const searchState = useCatalogueUiStore(useShallow(selectSearchState));

  const [contextMenu, setContextMenu] = useState<CatalogueContextMenuState | null>(null);

  // CHANGED: REFRESH on every mount (i.e. each time the Catalog tab is opened),
  // not just a first-time load. The old `if (!loaded) load()` left the Catalogue
  // showing stale data when entries changed elsewhere — e.g. a Suno generation
  // that registered into the library after the first (empty) load never appeared
  // until a hard reload. `refresh()` always re-fetches `/api/library/entries`.
  useEffect(() => {
    if (!loaded) void useLibraryStore.getState().load();
    else void useLibraryStore.getState().refresh();
    // run once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive the filtered/sorted result set. Memoized over the stable `entries`
  // reference + the search state so we don't recompute every render.
  const filtered = useMemo(
    () => filterAndSort(entries, searchState),
    [entries, searchState],
  );

  const selectedEntry = useMemo(
    () => entries.find((e) => e.id === selectedEntryId) ?? null,
    [entries, selectedEntryId],
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
          <CatalogueFilterBar resultCount={filtered.length} />
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

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          {filtered.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center opacity-30 italic gap-2">
              <Database className="w-8 h-8" />
              {entries.length === 0 ? (
                <p className="text-[11px]">Library is empty — generate or import a track.</p>
              ) : (
                <p className="text-[11px]">No entries match your search.</p>
              )}
            </div>
          ) : viewMode === 'list' ? (
            <CatalogueList entries={filtered} onContextMenu={handleContextMenu} />
          ) : (
            <CatalogueGrid entries={filtered} onContextMenu={handleContextMenu} />
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
