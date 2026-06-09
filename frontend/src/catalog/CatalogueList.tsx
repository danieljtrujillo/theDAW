import React, { useCallback } from 'react';
import { List, type RowComponentProps } from 'react-window';
import { Play, Pause, Star, GitBranch } from 'lucide-react';
import type { LibraryEntry } from '../state/libraryEntry';
import { useLibraryStore } from '../state/libraryStore';
import { usePlayerStore } from '../state/playerStore';
import { logError } from '../state/logStore';
import { HoverTip } from '../components/ui/Tooltip';
import { formatDuration, formatDate, formatSize } from './catalogFormat';
import { CatalogueProviderBadge } from './CatalogueProviderBadge';

const ROW_HEIGHT = 52;

/** Load a library entry into the global player and play it (or toggle if it's
 *  already the current track). Shared by list + grid. */
export async function playCatalogueEntry(entry: LibraryEntry): Promise<void> {
  const player = usePlayerStore.getState();
  const lib = useLibraryStore.getState();
  if (player.currentEntryId === entry.id) {
    if (player.isPlaying) player.pause();
    else player.play();
    return;
  }
  try {
    const blob = await lib.fetchAudioBlob(entry);
    await player.load(blob, { label: entry.title, entryId: entry.id });
    player.play();
  } catch (e) {
    logError('catalogue', `Could not play "${entry.title}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Props forwarded to every row via react-window v2's `rowProps`. */
interface RowProps {
  entries: LibraryEntry[];
  selectedEntryId: string | null;
  currentEntryId: string | null;
  isPlaying: boolean;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => void;
}

/** A single virtualized row. react-window v2 passes `index` + `style` plus
 *  whatever we put in `rowProps`. Always spread `style` onto the root. */
function Row({
  index,
  style,
  entries,
  selectedEntryId,
  currentEntryId,
  isPlaying,
  onSelect,
  onToggleFavorite,
  onContextMenu,
}: RowComponentProps<RowProps>) {
  const entry = entries[index];
  if (!entry) return null;
  const isSelected = selectedEntryId === entry.id;
  const isCurrent = currentEntryId === entry.id;
  const hasChimera = (entry.chimeraSources?.length ?? 0) > 0;

  return (
    <div style={style} className="px-2">
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-stabledaw-library-id', entry.id);
          e.dataTransfer.setData('text/plain', entry.title);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => onSelect(entry.id)}
        onContextMenu={(e) => onContextMenu(e, entry)}
        className={`hardware-card flex flex-row items-center gap-2 p-1.5 h-11.5 cursor-pointer transition-all hover:bg-white/4
          ${isSelected ? 'ring-1 ring-purple-500/60 bg-purple-500/6' : ''}`}
        title="Click to inspect. Drag onto an editor track."
      >
        <HoverTip text={isCurrent && isPlaying ? 'Pause playback.' : 'Play this track through the global player.'}>
          <button
            className="p-1 hover:bg-white/10 rounded shrink-0"
            onClick={(e) => { e.stopPropagation(); void playCatalogueEntry(entry); }}
          >
            {isCurrent && isPlaying
              ? <Pause className="w-3 h-3 text-purple-400" />
              : <Play className="w-3 h-3 text-zinc-400" />}
          </button>
        </HoverTip>

        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <CatalogueProviderBadge model={entry.model} source={entry.source} className="shrink-0" />
            <span className="font-bold text-[10px] truncate text-zinc-200" title={entry.title}>
              {entry.title}
            </span>
            {hasChimera && <GitBranch className="w-2.5 h-2.5 text-cyan-400/70 shrink-0" />}
          </div>
          {entry.prompt && (
            <span className="mono-label text-[8px]! text-zinc-500! truncate" title={entry.prompt}>
              {entry.prompt}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0 text-[8px] font-mono">
          <span className="text-purple-400/80 uppercase tracking-wider">{entry.model}</span>
          <span className="text-zinc-600 w-8 text-right">{formatDuration(entry.duration)}</span>
          <span className="text-zinc-700 w-16 text-right">{formatDate(entry.timestamp)}</span>
          <span className="text-zinc-700 w-12 text-right">{formatSize(entry.fileSizeBytes)}</span>
          <HoverTip text={entry.favorite ? 'Remove from favorites.' : 'Mark as a favorite (star).'}>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleFavorite(entry.id); }}
            >
              <Star className={`w-2.5 h-2.5 ${entry.favorite ? 'text-yellow-500 fill-current' : 'text-zinc-700'}`} />
            </button>
          </HoverTip>
        </div>
      </div>
    </div>
  );
}

interface Props {
  entries: LibraryEntry[];
  onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => void;
}

/**
 * CatalogueList — react-window v2 virtualized list. Scales to tens of
 * thousands of rows (the SunoHarvester Library lesson). The `List` fills its
 * parent's bounded height via the wrapping flex container + style height:'100%'.
 */
export const CatalogueList: React.FC<Props> = ({ entries, onContextMenu }) => {
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);

  const currentEntryId = usePlayerStore((s) => s.currentEntryId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const handleToggleFavorite = useCallback((id: string) => { void toggleFavorite(id); }, [toggleFavorite]);

  return (
    <div className="flex-1 min-h-0">
      <List
        rowComponent={Row}
        rowCount={entries.length}
        rowHeight={ROW_HEIGHT}
        rowProps={{
          entries,
          selectedEntryId,
          currentEntryId,
          isPlaying,
          onSelect: setSelectedEntry,
          onToggleFavorite: handleToggleFavorite,
          onContextMenu,
        }}
        overscanCount={6}
        style={{ height: '100%' }}
      />
    </div>
  );
};
