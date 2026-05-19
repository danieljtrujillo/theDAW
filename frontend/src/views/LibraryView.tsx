import React, { useEffect, useState } from 'react';
import {
  Search, Database, Clock, Play, Pause, Download, Trash2,
  Music, Star, Tag, Filter, ArrowUpDown,
  LayoutGrid, List as ListIcon, Activity, Scissors, Layers,
} from 'lucide-react';
import { Section } from '../components/ui/Section';
import { useLibraryStore, type LibraryEntry } from '../state/libraryStore';
import { useEditorStore, computePeaks } from '../state/editorStore';
import { usePlayerStore } from '../state/playerStore';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { logError } from '../state/logStore';

const formatDuration = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const formatDate = (iso: string): string => {
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

const downloadEntry = (entry: LibraryEntry, url: string) => {
  const a = document.createElement('a');
  a.href = url;
  a.download = entry.title;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

export const LibraryView: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  const entries = useLibraryStore((s) => s.entries);
  const loaded = useLibraryStore((s) => s.loaded);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const onlyFavorites = useLibraryStore((s) => s.onlyFavorites);
  const sortBy = useLibraryStore((s) => s.sortBy);
  const playingId = useLibraryStore((s) => s.playingId);
  const load = useLibraryStore((s) => s.load);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const setOnlyFavorites = useLibraryStore((s) => s.setOnlyFavorites);
  const setSortBy = useLibraryStore((s) => s.setSortBy);
  const setPlayingId = useLibraryStore((s) => s.setPlayingId);
  const toggleFavorite = useLibraryStore((s) => s.toggleFavorite);
  const removeEntry = useLibraryStore((s) => s.removeEntry);
  const getAudioUrl = useLibraryStore((s) => s.getAudioUrl);
  const getFiltered = useLibraryStore((s) => s.getFiltered);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const filteredEntries = getFiltered();
  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const engineIsPlaying = usePlayerStore((s) => s.isPlaying);
  const engineLoad = usePlayerStore((s) => s.load);
  const enginePlay = usePlayerStore((s) => s.play);
  const enginePause = usePlayerStore((s) => s.pause);

  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const showBottomTab = useBottomPanelStore((s) => s.showTab);

  const handleSelectEntry = (entry: LibraryEntry) => {
    setSelectedEntry(entry.id);
    // Reveal extreme metadata in the bottom panel's Details tab.
    showBottomTab('details');
  };

  const sendEntryToTrack = async (
    entry: LibraryEntry,
    target: 'first-track-tail' | 'new-track',
  ) => {
    const editor = useEditorStore.getState();
    let trackId: string;
    if (target === 'new-track' || editor.tracks.length === 0) {
      trackId = editor.addTrack({ name: entry.title });
    } else {
      trackId = editor.tracks[0].id;
    }
    const tail =
      target === 'new-track'
        ? 0
        : Math.max(
            0,
            ...editor.clips
              .filter((c) => c.trackId === trackId)
              .map((c) => c.startSec + c.durationSec),
          );
    try {
      const { peaks, duration } = await computePeaks(entry.audioBlob, 240);
      // Re-read tracks after potential addTrack so we pick up the right color.
      const trackColor =
        useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#8b5cf6';
      const clipId = editor.addClipToTrack({
        trackId,
        label: entry.title,
        audioBlob: entry.audioBlob,
        mimeType: entry.mimeType,
        sourceDuration: duration || entry.duration,
        offsetIntoSource: 0,
        durationSec: duration || entry.duration,
        startSec: tail,
        color: trackColor,
        libraryEntryId: entry.id,
      });
      editor.cachePeaks(clipId, peaks);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('library', `Could not send to editor: ${msg}`);
    }
  };

  const handleSendToEditor = (entry: LibraryEntry) => void sendEntryToTrack(entry, 'first-track-tail');
  const handleSendToNewTrack = (entry: LibraryEntry) => void sendEntryToTrack(entry, 'new-track');

  const handlePlay = async (entry: LibraryEntry) => {
    // If this entry is already loaded in the global engine, just toggle play/pause.
    if (engineEntryId === entry.id) {
      if (engineIsPlaying) {
        enginePause();
        setPlayingId(null);
      } else {
        enginePlay();
        setPlayingId(entry.id);
      }
      return;
    }
    // Otherwise load and play through the global engine — visualizer + footer follow.
    await engineLoad(entry.audioBlob, { label: entry.title, entryId: entry.id });
    enginePlay();
    setPlayingId(entry.id);
  };

  return (
    <div className="flex flex-col gap-2 h-full text-[11px] pb-0 px-2 pt-2">

      <Section title="LIBRARY" icon={Database} defaultOpen={true} rightNode={
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <span className="text-[8px] font-mono text-zinc-600">{entries.length} TRACKS</span>
          <button onClick={() => setViewMode('list')} className={`p-1 rounded ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-zinc-600'}`} title="List view">
            <ListIcon className="w-3 h-3" />
          </button>
          <button onClick={() => setViewMode('grid')} className={`p-1 rounded ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-600'}`} title="Grid view">
            <LayoutGrid className="w-3 h-3" />
          </button>
        </div>
      }>
        <div className="flex flex-col gap-2 mb-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
            <input
              type="text"
              className="compact-input w-full pl-7"
              placeholder="SEARCH PROMPTS / TITLES / TAGS..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
            <button
              className={`mono-tag flex items-center gap-1 whitespace-nowrap ${onlyFavorites ? '!bg-purple-600/20 !text-purple-300 !border-purple-500/40' : '!bg-white/5 !text-zinc-400'}`}
              onClick={() => setOnlyFavorites(!onlyFavorites)}
            >
              <Star className="w-2 h-2 fill-current" /> FAVS
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'newest' ? '!bg-purple-600/20 !text-purple-300' : '!bg-white/5 !text-zinc-400'}`} onClick={() => setSortBy('newest')}>
              <Clock className="w-2 h-2" /> NEWEST
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'duration' ? '!bg-purple-600/20 !text-purple-300' : '!bg-white/5 !text-zinc-400'}`} onClick={() => setSortBy('duration')}>
              <Tag className="w-2 h-2" /> DURATION
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'title' ? '!bg-purple-600/20 !text-purple-300' : '!bg-white/5 !text-zinc-400'}`} onClick={() => setSortBy('title')}>
              <Filter className="w-2 h-2" /> TITLE
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between px-1 mb-1 text-[8px] font-mono text-zinc-600 uppercase border-b border-white/5 pb-1">
          <button className="flex items-center gap-1 hover:text-zinc-300" onClick={() => setSortBy('title')}>
            <ArrowUpDown className="w-2 h-2" /> NAME
          </button>
          <div className="flex gap-4">
            <span>MODEL</span>
            <span>LEN</span>
            <span>DATE</span>
          </div>
        </div>

        <div className={viewMode === 'list' ? 'flex flex-col gap-1' : 'grid grid-cols-2 gap-2'}>
          {filteredEntries.map((entry) => (
            <div
              key={entry.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-stabledaw-library-id', entry.id);
                e.dataTransfer.setData('text/plain', entry.title);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => handleSelectEntry(entry)}
              className={`hardware-card !p-0 group cursor-grab active:cursor-grabbing transition-all hover:bg-white/[0.04]
                ${selectedEntryId === entry.id ? 'ring-1 ring-purple-500/60 bg-purple-500/[0.06]' : ''}
                ${viewMode === 'list' ? 'flex-row items-center p-1' : 'aspect-square flex-col'}`}
              title="Click to inspect metadata. Drag onto a Waveform Editor track."
            >
              {viewMode === 'grid' && (
                <div className="flex-1 bg-black/40 flex items-center justify-center relative">
                  <Music className="w-6 h-6 text-zinc-800" />
                  <button
                    className="absolute top-1 right-1 p-1 bg-black/80 rounded opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handlePlay(entry)}
                  >
                    {engineEntryId === entry.id && engineIsPlaying ? <Pause className="w-3 h-3 text-purple-300" /> : <Play className="w-3 h-3 text-zinc-300" />}
                  </button>
                </div>
              )}

              <div className={`p-1.5 flex flex-col gap-0.5 ${viewMode === 'list' ? 'flex-1 min-w-0' : ''}`}>
                <div className="flex items-center justify-between overflow-hidden gap-2">
                  <span className="font-bold text-[10px] truncate pr-2 text-zinc-200" title={entry.title}>
                    {entry.title}
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); void toggleFavorite(entry.id); }}
                    className="flex-shrink-0"
                    title={entry.favorite ? 'Unfavorite' : 'Favorite'}
                  >
                    <Star className={`w-2.5 h-2.5 ${entry.favorite ? 'text-yellow-500 fill-current' : 'text-zinc-700'}`} />
                  </button>
                </div>
                {entry.prompt && (
                  <span className="mono-label !text-[8px] !text-zinc-500 truncate" title={entry.prompt}>
                    {entry.prompt}
                  </span>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[8px] font-mono text-purple-400/80 uppercase tracking-wider">{entry.model}</span>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-[8px] font-mono text-zinc-600">{formatDuration(entry.duration)}</span>
                    <span className="text-[8px] font-mono text-zinc-700">{formatDate(entry.timestamp)}</span>
                    <span className="text-[8px] font-mono text-zinc-700">{formatSize(entry.audioBlob.size)}</span>
                    {viewMode === 'list' && (
                      <div className="flex gap-1">
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); handlePlay(entry); }}
                          title={engineEntryId === entry.id && engineIsPlaying ? 'Pause' : 'Play'}
                        >
                          {engineEntryId === entry.id && engineIsPlaying ? <Pause className="w-2.5 h-2.5 text-purple-400" /> : <Play className="w-2.5 h-2.5 text-zinc-400 group-hover:text-purple-400" />}
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); handleSendToEditor(entry); }}
                          title="Append to first editor track"
                        >
                          <Scissors className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); handleSendToNewTrack(entry); }}
                          title="Send to editor as a NEW track"
                        >
                          <Layers className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); downloadEntry(entry, getAudioUrl(entry)); }}
                          title="Download"
                        >
                          <Download className="w-2.5 h-2.5 text-zinc-600 hover:text-white" />
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete "${entry.title}"?`)) void removeEntry(entry.id);
                          }}
                          title="Delete"
                        >
                          <Trash2 className="w-2.5 h-2.5 text-zinc-600 hover:text-red-400" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {filteredEntries.length === 0 && (
          <div className="py-8 flex flex-col items-center justify-center opacity-30 italic gap-2">
            <Database className="w-8 h-8" />
            {entries.length === 0 ? (
              <>
                <p>Library is empty.</p>
                <button
                  className="mono-tag !bg-purple-600/20 !text-purple-300 !border-purple-500/40 cursor-pointer"
                  onClick={() => onSwitchTab?.('create')}
                >
                  Go generate something
                </button>
              </>
            ) : (
              <p>No entries match your filter.</p>
            )}
          </div>
        )}
      </Section>

      <Section title="LIBRARY ANALYSIS [WIP]" icon={Activity} defaultOpen={false}>
        <div className="space-y-2 text-[10px] font-mono text-zinc-500">
          <p>Total entries: <span className="text-zinc-300">{entries.length}</span></p>
          <p>Favorites: <span className="text-zinc-300">{entries.filter((e) => e.favorite).length}</span></p>
          <p>
            Total size:{' '}
            <span className="text-zinc-300">
              {formatSize(entries.reduce((sum, e) => sum + e.audioBlob.size, 0))}
            </span>
          </p>
          <p>
            Total duration:{' '}
            <span className="text-zinc-300">
              {formatDuration(entries.reduce((sum, e) => sum + e.duration, 0))}
            </span>
          </p>
        </div>
      </Section>

    </div>
  );
};
