import React from 'react';
import { Play, Pause, Star, Music, GitBranch } from 'lucide-react';
import type { LibraryEntry } from '../state/libraryEntry';
import { useLibraryStore } from '../state/libraryStore';
import { usePlayerStore } from '../state/playerStore';
import { HoverTip } from '../components/ui/Tooltip';
import { formatDuration, formatDate } from './catalogFormat';
import { CatalogueProviderBadge } from './CatalogueProviderBadge';
import { playCatalogueEntry } from './CatalogueList';

interface Props {
  entries: LibraryEntry[];
  onContextMenu: (e: React.MouseEvent, entry: LibraryEntry) => void;
}

/**
 * CatalogueGrid — visual card grid alternative to the virtualized list. Not
 * virtualized (used for smaller, browse-y views); the list view handles the
 * huge-count case.
 */
export const CatalogueGrid: React.FC<Props> = ({ entries, onContextMenu }) => {
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);

  const currentEntryId = usePlayerStore((s) => s.currentEntryId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar p-2">
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
        {entries.map((entry) => {
          const isSelected = selectedEntryId === entry.id;
          const isCurrent = currentEntryId === entry.id;
          const hasChimera = (entry.chimeraSources?.length ?? 0) > 0;
          return (
            <div
              key={entry.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-stabledaw-library-id', entry.id);
                e.dataTransfer.setData('text/plain', entry.title);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => setSelectedEntry(entry.id)}
              onContextMenu={(e) => onContextMenu(e, entry)}
              className={`hardware-card group cursor-pointer flex flex-col transition-all hover:bg-white/4
                ${isSelected ? 'ring-1 ring-purple-500/60 bg-purple-500/6' : ''}`}
            >
              <div className="aspect-square bg-black/40 flex items-center justify-center relative">
                <Music className="w-6 h-6 text-zinc-800" />
                <HoverTip text={isCurrent && isPlaying ? 'Pause playback.' : 'Play this track through the global player.'}>
                  <button
                    className="absolute top-1 right-1 p-1 bg-black/80 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => { e.stopPropagation(); void playCatalogueEntry(entry); }}
                  >
                    {isCurrent && isPlaying
                      ? <Pause className="w-3 h-3 text-purple-300" />
                      : <Play className="w-3 h-3 text-zinc-300" />}
                  </button>
                </HoverTip>
                {hasChimera && (
                  <GitBranch className="absolute top-1 left-1 w-3 h-3 text-cyan-400/80" />
                )}
                <CatalogueProviderBadge
                  model={entry.model}
                  source={entry.source}
                  className="absolute bottom-1 left-1"
                />
              </div>
              <div className="p-1.5 flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-bold text-[10px] truncate text-zinc-200" title={entry.title}>
                    {entry.title}
                  </span>
                  <HoverTip text={entry.favorite ? 'Remove from favorites.' : 'Mark as a favorite (star).'}>
                    <button
                      onClick={(e) => { e.stopPropagation(); void toggleFavorite(entry.id); }}
                      className="shrink-0"
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
        })}
      </div>
    </div>
  );
};
