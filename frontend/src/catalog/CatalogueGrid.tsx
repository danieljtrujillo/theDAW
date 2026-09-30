import React, { useCallback, useState } from 'react';
import { List, type RowComponentProps } from 'react-window';
import { Play, Pause, Star, GitBranch } from 'lucide-react';
import type { LibraryEntry } from '../state/libraryEntry';
import { CoverArt } from './CoverArt';
import { useLibraryStore } from '../state/libraryStore';
import { usePlayerStore } from '../state/playerStore';
import { HoverTip } from '../components/ui/Tooltip';
import { formatDuration, formatDate } from './catalogFormat';
import { ProviderBadge } from '../components/library/ProviderBadge';
import { playCatalogueEntry } from './CatalogueList';

/** `gap-2` between cards, in CSS px. */
const GRID_GAP = 8;
/** The width at which the grid goes from two columns to three (Tailwind `lg`). */
const LG_BREAKPOINT = 1024;
/** Height of the text block under a card's square artwork, in CSS px. */
const CARD_TEXT_HEIGHT = 46;

interface Props {
  /** Rows in the result set — every match, not just the ones loaded. */
  rowCount: number;
  /** The row at a global index, or undefined while its page is coming. */
  entryAt: (index: number) => LibraryEntry | undefined;
  /** The rows currently loaded; its identity is the re-render trigger. */
  loadedRows: readonly LibraryEntry[];
  /** Called with the inclusive index range react-window has rendered. */
  onRangeRendered?: (start: number, end: number) => void;
  onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => void;
}

interface GridRowData {
  columns: number;
  rowCount: number;
  entryAt: (index: number) => LibraryEntry | undefined;
  loadedRows: readonly LibraryEntry[];
  selectedEntryId: string | null;
  currentEntryId: string | null;
  isPlaying: boolean;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => void;
}

const CardSkeleton: React.FC = () => (
  <div aria-hidden="true" className="hardware-card flex flex-col animate-pulse">
    <div className="aspect-square bg-white/5" />
    <div className="p-1.5 flex flex-col gap-1">
      <div className="h-2 w-2/3 rounded bg-white/5" />
      <div className="h-1.5 w-1/3 rounded bg-white/5" />
    </div>
  </div>
);

const Card: React.FC<{
  entry: LibraryEntry;
  isSelected: boolean;
  isCurrent: boolean;
  isPlaying: boolean;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => void;
}> = ({ entry, isSelected, isCurrent, isPlaying, onSelect, onToggleFavorite, onContextMenu }) => {
  const hasChimera = (entry.chimeraSources?.length ?? 0) > 0;
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-thedaw-library-id', entry.id);
        e.dataTransfer.setData('text/plain', entry.title);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => onSelect(entry.id)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      className={`hardware-card group cursor-pointer flex flex-col overflow-hidden transition-all hover:bg-white/4
        ${isSelected ? 'ring-1 ring-purple-500/60 bg-purple-500/6' : ''}`}
    >
      <div className="aspect-square bg-black/40 relative">
        <CoverArt
          coverUrl={entry.coverUrl}
          title={entry.title}
          className="absolute inset-0 w-full h-full"
        />
        <HoverTip text={isCurrent && isPlaying ? 'Pause playback.' : 'Play this track through the global player.'}>
          <button
            className="absolute top-1 right-1 p-1 bg-black/80 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => { e.stopPropagation(); void playCatalogueEntry(entry); }}
            aria-label={isCurrent && isPlaying ? `Pause ${entry.title}` : `Play ${entry.title}`}
          >
            {isCurrent && isPlaying
              ? <Pause className="w-3 h-3 text-purple-300" />
              : <Play className="w-3 h-3 text-zinc-300" />}
          </button>
        </HoverTip>
        {hasChimera && (
          <GitBranch className="absolute top-1 left-1 w-3 h-3 text-cyan-400/80" />
        )}
        {/* One badge for the entry's one provider: detected when the file said
            who made it, derived from model/source when it did not. */}
        <ProviderBadge entry={entry} className="absolute bottom-1 left-1" />
      </div>
      <div className="p-1.5 flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-1">
          <span className="font-bold text-[10px] truncate text-zinc-200" title={entry.title}>
            {entry.title}
          </span>
          <HoverTip text={entry.favorite ? 'Remove from favorites.' : 'Mark as a favorite (star).'}>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleFavorite(entry.id); }}
              className="shrink-0"
              aria-label={entry.favorite ? `Unfavorite ${entry.title}` : `Favorite ${entry.title}`}
            >
              <Star className={`w-2.5 h-2.5 ${entry.favorite ? 'text-yellow-500 fill-current' : 'text-zinc-700'}`} />
            </button>
          </HoverTip>
        </div>
        <div className="flex items-center justify-between text-[8px] font-mono">
          <span className="text-purple-400/80 uppercase tracking-wider truncate">{entry.model}</span>
          <span className="text-zinc-600">{formatDuration(entry.duration)}</span>
        </div>
        <span className="text-[8px] font-mono text-zinc-700">{formatDate(entry.timestamp)}</span>
      </div>
    </div>
  );
};

/** One line of the grid: `columns` cards, or fewer on the last line. */
function GridRow({ index, style, ariaAttributes, ...data }: RowComponentProps<GridRowData>) {
  const { columns, rowCount, entryAt, selectedEntryId, currentEntryId, isPlaying } = data;
  const first = index * columns;
  const cells: React.ReactNode[] = [];
  for (let column = 0; column < columns; column += 1) {
    const at = first + column;
    if (at >= rowCount) break;
    const entry = entryAt(at);
    cells.push(
      entry ? (
        <Card
          key={entry.id}
          entry={entry}
          isSelected={selectedEntryId === entry.id}
          isCurrent={currentEntryId === entry.id}
          isPlaying={isPlaying}
          onSelect={data.onSelect}
          onToggleFavorite={data.onToggleFavorite}
          onContextMenu={data.onContextMenu}
        />
      ) : (
        <CardSkeleton key={`skeleton-${at}`} />
      ),
    );
  }
  return (
    <div
      style={style}
      {...ariaAttributes}
      className={`grid gap-2 pb-2 ${columns === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}
    >
      {cells}
    </div>
  );
}

/**
 * CatalogueGrid — the card view, virtualized over the SAME paged store the
 * list view uses. It used to render every entry, which at 200,000 of them is
 * 200,000 cover images; now it renders the line of cards on screen and asks
 * the store for the pages that line needs.
 */
export const CatalogueGrid: React.FC<Props> = ({
  rowCount,
  entryAt,
  loadedRows,
  onRangeRendered,
  onContextMenu,
}) => {
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);

  const currentEntryId = usePlayerStore((s) => s.currentEntryId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  // Measured, not guessed: the cards are square, so a line is as tall as one
  // card is wide plus its text block. Three columns from `lg` up, matching the
  // `grid-cols-2 lg:grid-cols-3` this view had before it was virtualized.
  const [width, setWidth] = useState(0);
  const handleResize = useCallback((size: { width: number; height: number }) => setWidth(size.width), []);
  const columns = width >= LG_BREAKPOINT ? 3 : 2;
  const cardWidth = Math.max(80, (width - GRID_GAP * (columns - 1)) / columns);
  const lineHeight = Math.round(cardWidth) + CARD_TEXT_HEIGHT + GRID_GAP;

  const handleToggleFavorite = useCallback((id: string) => { void toggleFavorite(id); }, [toggleFavorite]);

  const handleRowsRendered = useCallback((
    _visible: { startIndex: number; stopIndex: number },
    rendered: { startIndex: number; stopIndex: number },
  ) => {
    onRangeRendered?.(rendered.startIndex * columns, (rendered.stopIndex + 1) * columns - 1);
  }, [columns, onRangeRendered]);

  return (
    <div className="flex-1 min-h-0 p-2">
      <List
        className="no-scrollbar"
        rowComponent={GridRow}
        rowCount={Math.ceil(rowCount / columns)}
        rowHeight={lineHeight}
        rowProps={{
          columns,
          rowCount,
          entryAt,
          loadedRows,
          selectedEntryId,
          currentEntryId,
          isPlaying,
          onSelect: setSelectedEntry,
          onToggleFavorite: handleToggleFavorite,
          onContextMenu,
        }}
        overscanCount={8}
        onResize={handleResize}
        onRowsRendered={handleRowsRendered}
        aria-label="Catalogue tracks"
        style={{ height: '100%' }}
      />
    </div>
  );
};
