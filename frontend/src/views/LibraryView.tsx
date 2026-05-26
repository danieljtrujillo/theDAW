import React, { useEffect, useMemo, useState } from 'react';
import {
  Search, Database, Clock, Play, Pause, Download, Trash2,
  Music, Star, Tag, Filter, ArrowUpDown,
  LayoutGrid, List as ListIcon, Activity, Scissors, Layers, Wand2, PenLine,
  Package, Network, FileMusic, Loader2,
} from 'lucide-react';
import { LineageModal } from '../components/library/LineageModal';
import { Section } from '../components/ui/Section';
import { useLibraryStore, type LibraryEntry } from '../state/libraryStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useEditorStore, computePeaks } from '../state/editorStore';
import { usePlayerStore } from '../state/playerStore';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { logError, logInfo } from '../state/logStore';
import { addBlobsToChimera } from '../lib/chimeraClient';
import { setAudioDragData } from '../lib/audioDnD';

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
  const [subTab, setSubTab] = useState<'tracks' | 'stems' | 'midi'>('tracks');
  const [lineageOpen, setLineageOpen] = useState<string | null>(null);
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entryId: string } | null>(null);
  const [allStems, setAllStems] = useState<Array<Record<string, unknown>> | null>(null);
  const [allMidis, setAllMidis] = useState<Array<Record<string, unknown>> | null>(null);
  const [runningKind, setRunningKind] = useState<{ id: string; kind: 'analysis' | 'stems' | 'midi' } | null>(null);

  const runJobForEntry = async (
    entryId: string,
    kind: 'analysis' | 'stems' | 'midi',
  ) => {
    setRunningKind({ id: entryId, kind });
    const labels: Record<typeof kind, string> = {
      analysis: 'analysis',
      stems: 'stem separation',
      midi: 'MIDI conversion',
    };
    logInfo('library', `Running ${labels[kind]} on ${entryId.slice(0, 8)}…`);
    try {
      const res = await fetch(`/api/${kind}/${entryId}/run`, { method: 'POST' });
      const payload = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok) {
        const detail =
          (payload && (payload as Record<string, unknown>).detail) ??
          (payload as Record<string, unknown>).error ??
          `HTTP ${res.status}`;
        logError('library', `${labels[kind]} failed: ${detail}`);
        return;
      }

      // The MIDI runner returns a top-level status of failed | partial |
      // complete with per-target results. Stems / analysis use their own
      // shapes. Surface the real outcome rather than a flat "done".
      const status = String((payload as Record<string, unknown>).status ?? '');
      if (kind === 'midi') {
        const results = ((payload as { results?: Array<Record<string, unknown>> }).results) ?? [];
        const failed = results.filter((r) => !r.ok);
        if (status === 'failed') {
          const firstErr = failed[0]?.error ?? 'no engine installed (try: pip install basic-pitch)';
          logError('library', `MIDI conversion FAILED for ${entryId.slice(0, 8)}: ${firstErr}`);
        } else if (status === 'partial') {
          logError(
            'library',
            `MIDI conversion partial for ${entryId.slice(0, 8)}: ${failed.length}/${results.length} target(s) failed; first error: ${failed[0]?.error ?? '—'}`,
          );
        } else {
          logInfo('library', `MIDI conversion done for ${entryId.slice(0, 8)} (${results.length} targets)`);
        }
      } else if (kind === 'stems') {
        const written = (payload as Record<string, unknown>).written ?? 0;
        const stat = status || 'completed';
        logInfo('library', `stem separation ${stat} for ${entryId.slice(0, 8)}: ${written} stem(s) written`);
      } else {
        // analysis — surface bpm / key / pitch summary in the log so
        // the user can verify at a glance without opening Details.
        const a = payload as Record<string, unknown>;
        const bits: string[] = [];
        if (a.bpm != null) bits.push(`bpm=${Number(a.bpm).toFixed(1)}`);
        if (a.key) bits.push(`key=${a.key}${a.scale ? ' ' + a.scale : ''}`);
        if (a.pitch_mean_hz != null) bits.push(`pitch=${Number(a.pitch_mean_hz).toFixed(0)}Hz`);
        if (a.bars_estimated != null) bits.push(`bars=${Number(a.bars_estimated).toFixed(1)}`);
        if (a.rms_db != null) bits.push(`rms=${Number(a.rms_db).toFixed(1)}dB`);
        logInfo('library', `analysis done for ${entryId.slice(0, 8)}: ${bits.join(', ') || 'no useful data'}`);
      }
      // Invalidate sub-tab caches so the new stems/midi show up.
      if (kind === 'stems') setAllStems(null);
      if (kind === 'midi') setAllMidis(null);
    } catch (e) {
      logError('library', `${labels[kind]} request failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunningKind(null);
    }
  };

  // Fetch stems / midi indexes lazily when their sub-tab opens.
  useEffect(() => {
    if (subTab === 'stems' && allStems === null) {
      void fetch('/api/library/_all/stems')
        .then((r) => r.json())
        .then((j) => setAllStems(j.stems || []))
        .catch(() => setAllStems([]));
    }
    if (subTab === 'midi' && allMidis === null) {
      void fetch('/api/library/_all/midi')
        .then((r) => r.json())
        .then((j) => setAllMidis(j.midis || []))
        .catch(() => setAllMidis([]));
    }
  }, [subTab, allStems, allMidis]);

  const stemsByParent = useMemo(() => {
    const map: Record<string, Array<Record<string, unknown>>> = {};
    (allStems || []).forEach((s) => {
      const pid = String(s.parent_id ?? '');
      if (!map[pid]) map[pid] = [];
      map[pid].push(s);
    });
    return map;
  }, [allStems]);

  const midisByParent = useMemo(() => {
    const map: Record<string, Array<Record<string, unknown>>> = {};
    (allMidis || []).forEach((m) => {
      const pid = String(m.parent_id ?? '');
      if (!map[pid]) map[pid] = [];
      map[pid].push(m);
    });
    return map;
  }, [allMidis]);

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
  const selectedEntries = filteredEntries.filter((entry) => selectedEntryIds.includes(entry.id));
  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const engineIsPlaying = usePlayerStore((s) => s.isPlaying);
  const engineLoad = usePlayerStore((s) => s.load);
  const enginePlay = usePlayerStore((s) => s.play);
  const enginePause = usePlayerStore((s) => s.pause);

  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const setSelectedEntry = useLibraryStore((s) => s.setSelectedEntry);
  const showBottomTab = useBottomPanelStore((s) => s.showTab);

  useEffect(() => {
    setSelectedEntryIds((prev) => prev.filter((id) => entries.some((entry) => entry.id === id)));
  }, [entries]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, { capture: true });
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close, { capture: true } as EventListenerOptions);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  const handleSelectEntry = (entry: LibraryEntry, event?: React.MouseEvent) => {
    const additive = !!(event?.ctrlKey || event?.metaKey);
    const range = !!event?.shiftKey;

    if (range && selectionAnchorId) {
      const orderedIds = filteredEntries.map((item) => item.id);
      const anchorIndex = orderedIds.indexOf(selectionAnchorId);
      const targetIndex = orderedIds.indexOf(entry.id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        const rangeIds = orderedIds.slice(start, end + 1);
        setSelectedEntryIds((prev) => (additive ? Array.from(new Set([...prev, ...rangeIds])) : rangeIds));
      } else {
        setSelectedEntryIds([entry.id]);
      }
    } else if (additive) {
      setSelectedEntryIds((prev) => (
        prev.includes(entry.id) ? prev.filter((id) => id !== entry.id) : [...prev, entry.id]
      ));
      setSelectionAnchorId(entry.id);
    } else {
      setSelectedEntryIds([entry.id]);
      setSelectionAnchorId(entry.id);
    }

    setSelectedEntry(entry.id);
    // Reveal extreme metadata in the bottom panel's Details tab.
    showBottomTab('details');
  };

  const handleEntryContextMenu = (event: React.MouseEvent, entry: LibraryEntry) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedEntryIds.includes(entry.id)) {
      setSelectedEntryIds([entry.id]);
      setSelectionAnchorId(entry.id);
      setSelectedEntry(entry.id);
      showBottomTab('details');
    }
    setContextMenu({ x: event.clientX, y: event.clientY, entryId: entry.id });
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
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      const { peaks, duration } = await computePeaks(blob, 240);
      // Re-read tracks after potential addTrack so we pick up the right color.
      const trackColor =
        useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#8b5cf6';
      const clipId = editor.addClipToTrack({
        trackId,
        label: entry.title,
        audioBlob: blob,
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

  const patchGenParams = useGenerateParamsStore((s) => s.patch);

  const handleSendToInit = async (entry: LibraryEntry) => {
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    const file = new File([blob], entry.title, { type: entry.mimeType });
    patchGenParams({
      initAudioFile: file,
      initAudioEnabled: true,
      initAudioSourceLabel: null,
      initAudioSourceClipLabels: [],
    });
  };

  const handleSendSelectedToInit = () => {
    const targets = selectedEntries.length > 0
      ? selectedEntries
      : (() => {
          const ctxEntry = entries.find((entry) => entry.id === contextMenu?.entryId);
          return ctxEntry ? [ctxEntry] : [];
        })();
    if (targets.length === 0) return;

    void (async () => {
      const fetchBlob = useLibraryStore.getState().fetchAudioBlob;
      if (targets.length === 1) {
        await handleSendToInit(targets[0]);
      } else {
        const items = await Promise.all(
          targets.map(async (entry) => ({
            blob: await fetchBlob(entry),
            mimeType: entry.mimeType,
            label: entry.title,
          })),
        );
        addBlobsToChimera(items);
      }
      onSwitchTab?.('create');
      setContextMenu(null);
    })();
  };

  const handleSendToInpaint = async (entry: LibraryEntry) => {
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    const file = new File([blob], entry.title, { type: entry.mimeType });
    patchGenParams({ inpaintAudioFile: file, inpaintEnabled: true, maskStart: 0, maskEnd: 0 });
  };

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
    const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
    await engineLoad(blob, { label: entry.title, entryId: entry.id });
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
              className={`mono-tag flex items-center gap-1 whitespace-nowrap ${onlyFavorites ? 'bg-purple-600/20! text-purple-300! border-purple-500/40!' : 'bg-white/5! text-zinc-400!'}`}
              onClick={() => setOnlyFavorites(!onlyFavorites)}
            >
              <Star className="w-2 h-2 fill-current" /> FAVS
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'newest' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('newest')}>
              <Clock className="w-2 h-2" /> NEWEST
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'duration' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('duration')}>
              <Tag className="w-2 h-2" /> DURATION
            </button>
            <button className={`mono-tag flex items-center gap-1 whitespace-nowrap ${sortBy === 'title' ? 'bg-purple-600/20! text-purple-300!' : 'bg-white/5! text-zinc-400!'}`} onClick={() => setSortBy('title')}>
              <Filter className="w-2 h-2" /> TITLE
            </button>
          </div>
        </div>

        {/* Sub-tabs: Tracks / Stems / MIDI */}
        <div className="flex items-center gap-1 mb-2 border-b border-white/5 pb-1">
          <SubTabButton active={subTab === 'tracks'} onClick={() => setSubTab('tracks')} icon={<Music className="w-3 h-3" />}>
            Tracks ({entries.length})
          </SubTabButton>
          <SubTabButton active={subTab === 'stems'} onClick={() => setSubTab('stems')} icon={<Scissors className="w-3 h-3" />}>
            Stems ({allStems?.length ?? '…'})
          </SubTabButton>
          <SubTabButton active={subTab === 'midi'} onClick={() => setSubTab('midi')} icon={<FileMusic className="w-3 h-3" />}>
            MIDI ({allMidis?.length ?? '…'})
          </SubTabButton>
          <button
            onClick={() => setLineageOpen('__library__')}
            className="ml-auto p-1 rounded hover:bg-purple-500/15 text-purple-300 hover:text-purple-200 transition-colors flex items-center gap-1"
            title="Open the library-wide lineage / knowledge graph"
          >
            <Network className="w-3 h-3" />
            <span className="text-[8px] font-mono uppercase tracking-widest">Graph</span>
          </button>
        </div>

        {subTab === 'tracks' && (<>
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
                e.dataTransfer.effectAllowed = 'copyMove';
                const dragItems = selectedEntryIds.includes(entry.id) && selectedEntries.length > 1
                  ? selectedEntries
                  : [entry];
                const fetchBlob = useLibraryStore.getState().fetchAudioBlob;
                setAudioDragData(e, dragItems.map((en) => ({
                  fetcher: () => fetchBlob(en),
                  mimeType: en.mimeType,
                  label: en.title,
                })));
              }}
              onClick={(e) => handleSelectEntry(entry, e)}
              onContextMenu={(e) => handleEntryContextMenu(e, entry)}
              className={`hardware-card p-0! group cursor-grab active:cursor-grabbing transition-all hover:bg-white/4
                ${selectedEntryIds.includes(entry.id) || selectedEntryId === entry.id ? 'ring-1 ring-purple-500/60 bg-purple-500/6' : ''}
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
                    className="shrink-0"
                    title={entry.favorite ? 'Unfavorite' : 'Favorite'}
                  >
                    <Star className={`w-2.5 h-2.5 ${entry.favorite ? 'text-yellow-500 fill-current' : 'text-zinc-700'}`} />
                  </button>
                </div>
                {entry.prompt && (
                  <span className="mono-label text-[8px]! text-zinc-500! truncate" title={entry.prompt}>
                    {entry.prompt}
                  </span>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[8px] font-mono text-purple-400/80 uppercase tracking-wider">{entry.model}</span>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[8px] font-mono text-zinc-600">{formatDuration(entry.duration)}</span>
                    <span className="text-[8px] font-mono text-zinc-700">{formatDate(entry.timestamp)}</span>
                    <span className="text-[8px] font-mono text-zinc-700">{formatSize(entry.fileSizeBytes)}</span>
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
                          onClick={(e) => { e.stopPropagation(); handleSendToInit(entry); }}
                          title="Send to Init audio"
                        >
                          <Wand2 className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
                        </button>
                        <button
                          className="p-1 hover:bg-white/10 rounded"
                          onClick={(e) => { e.stopPropagation(); handleSendToInpaint(entry); }}
                          title="Send to Inpaint"
                        >
                          <PenLine className="w-2.5 h-2.5 text-zinc-500 hover:text-purple-300" />
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
                  className="mono-tag bg-purple-600/20! text-purple-300! border-purple-500/40! cursor-pointer"
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
        </>)}

        {subTab === 'stems' && (
          <SubTabList
            byParent={stemsByParent}
            parentTitles={Object.fromEntries(entries.map((e) => [e.id, e.title]))}
            kind="stem"
            placeholder={allStems === null ? 'Loading stems…' : 'No stems yet. Enable auto-stems in Settings or right-click a track → Separate stems.'}
          />
        )}
        {subTab === 'midi' && (
          <SubTabList
            byParent={midisByParent}
            parentTitles={Object.fromEntries(entries.map((e) => [e.id, e.title]))}
            kind="midi"
            placeholder={allMidis === null ? 'Loading MIDI…' : 'No MIDI yet. Enable auto-MIDI in Settings or right-click a track → Convert to MIDI.'}
          />
        )}
      </Section>

      {contextMenu && (
        <div
          className="fixed z-200 min-w-48 bg-[#0a080f] border border-purple-500/40 rounded shadow-[0_8px_24px_rgba(0,0,0,0.6)] py-1 text-[10px] font-mono"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="px-3 py-1.5 text-[8px] uppercase tracking-widest text-zinc-600 border-b border-white/5 mb-0.5">
            {selectedEntries.length > 1 ? `${selectedEntries.length} selected` : '1 selected'}
          </div>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-purple-500/15 text-purple-200 flex items-center justify-between"
            disabled={selectedEntries.length === 0}
            onClick={handleSendSelectedToInit}
          >
            <span className="flex items-center gap-1.5"><Wand2 className="w-3 h-3" /> Send selected to Init</span>
            <span className="text-zinc-600 text-[8px]">
              {selectedEntries.length > 1 ? `${selectedEntries.length} → Chimera` : 'single'}
            </span>
          </button>
          <div className="my-1 border-t border-white/5" />
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-purple-500/15 text-purple-200 flex items-center justify-between disabled:opacity-50"
            disabled={runningKind?.id === contextMenu.entryId && runningKind?.kind === 'analysis'}
            onClick={() => {
              const id = contextMenu.entryId;
              setContextMenu(null);
              void runJobForEntry(id, 'analysis');
            }}
          >
            <span className="flex items-center gap-1.5">
              {runningKind?.id === contextMenu.entryId && runningKind?.kind === 'analysis'
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Activity className="w-3 h-3" />}
              Run analysis
            </span>
            <span className="text-zinc-600 text-[8px]">bpm/key/pitch</span>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-purple-500/15 text-purple-200 flex items-center justify-between disabled:opacity-50"
            disabled={runningKind?.id === contextMenu.entryId && runningKind?.kind === 'stems'}
            onClick={() => {
              const id = contextMenu.entryId;
              setContextMenu(null);
              void runJobForEntry(id, 'stems');
            }}
          >
            <span className="flex items-center gap-1.5">
              {runningKind?.id === contextMenu.entryId && runningKind?.kind === 'stems'
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Scissors className="w-3 h-3" />}
              Separate stems
            </span>
            <span className="text-zinc-600 text-[8px]">demucs</span>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-purple-500/15 text-purple-200 flex items-center justify-between disabled:opacity-50"
            disabled={runningKind?.id === contextMenu.entryId && runningKind?.kind === 'midi'}
            onClick={() => {
              const id = contextMenu.entryId;
              setContextMenu(null);
              void runJobForEntry(id, 'midi');
            }}
          >
            <span className="flex items-center gap-1.5">
              {runningKind?.id === contextMenu.entryId && runningKind?.kind === 'midi'
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <FileMusic className="w-3 h-3" />}
              Convert to MIDI
            </span>
            <span className="text-zinc-600 text-[8px]">basic-pitch</span>
          </button>
          <div className="my-1 border-t border-white/5" />
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-purple-500/15 text-purple-200 flex items-center justify-between"
            onClick={() => {
              const url = `/api/library/${contextMenu.entryId}/bundle`;
              const a = document.createElement('a');
              a.href = url;
              a.download = '';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setContextMenu(null);
            }}
          >
            <span className="flex items-center gap-1.5"><Package className="w-3 h-3" /> Download bundle</span>
            <span className="text-zinc-600 text-[8px]">.zip</span>
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-purple-500/15 text-purple-200 flex items-center justify-between"
            onClick={() => {
              setLineageOpen(contextMenu.entryId);
              setContextMenu(null);
            }}
          >
            <span className="flex items-center gap-1.5"><Network className="w-3 h-3" /> Show lineage</span>
            <span className="text-zinc-600 text-[8px]">graph</span>
          </button>
        </div>
      )}

      <LineageModal
        open={lineageOpen !== null}
        rootEntryId={lineageOpen === '__library__' ? null : lineageOpen}
        onClose={() => setLineageOpen(null)}
      />

      <Section title="LIBRARY ANALYSIS [WIP]" icon={Activity} defaultOpen={false}>
        <div className="space-y-2 text-[10px] font-mono text-zinc-500">
          <p>Total entries: <span className="text-zinc-300">{entries.length}</span></p>
          <p>Favorites: <span className="text-zinc-300">{entries.filter((e) => e.favorite).length}</span></p>
          <p>
            Total size:{' '}
            <span className="text-zinc-300">
              {formatSize(entries.reduce((sum, e) => sum + e.fileSizeBytes, 0))}
            </span>
          </p>
          <p>
            Total duration:{' '}
            <span className="text-zinc-300">
              {formatDuration(entries.reduce((sum, e) => sum + e.duration, 0))}
            </span>
          </p>
        </div>

        <div className="mt-3 pt-3 border-t border-white/5 flex flex-col gap-2">
          <p className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">Library maintenance</p>
          <button
            type="button"
            className="btn-ghost text-[9px] py-1 px-2 flex items-center gap-1.5 justify-center self-start hover:bg-orange-500/15 hover:text-orange-200 border border-orange-500/30"
            disabled={entries.filter((e) => !e.favorite).length === 0}
            onClick={async () => {
              const targets = entries.filter((e) => !e.favorite);
              if (targets.length === 0) return;
              const ok = window.confirm(
                `Delete ${targets.length} non-favorite entr${targets.length === 1 ? 'y' : 'ies'} from disk? Favorites and their audio files are kept.`,
              );
              if (!ok) return;
              const { deleted, failed } = await useLibraryStore.getState().removeMany(targets.map((t) => t.id));
              window.alert(`Removed ${deleted} entr${deleted === 1 ? 'y' : 'ies'}${failed > 0 ? `, ${failed} failed` : ''}.`);
            }}
            title="Delete every non-favorite library entry from the server's data folder."
          >
            <Trash2 className="w-2.5 h-2.5" />
            CLEAR NON-FAVORITES ({entries.filter((e) => !e.favorite).length})
          </button>
          <button
            type="button"
            className="btn-ghost text-[9px] py-1 px-2 flex items-center gap-1.5 justify-center self-start hover:bg-red-500/15 hover:text-red-200 border border-red-500/40"
            disabled={entries.length === 0}
            onClick={async () => {
              const ok = window.confirm(
                `Delete ALL ${entries.length} library entr${entries.length === 1 ? 'y' : 'ies'} including favorites from the server's data folder?\n\nThis cannot be undone.`,
              );
              if (!ok) return;
              const { deleted, failed } = await useLibraryStore.getState().clearAll();
              window.alert(`Removed ${deleted} entr${deleted === 1 ? 'y' : 'ies'}${failed > 0 ? `, ${failed} failed` : ''}.`);
            }}
            title="Nuke the library entirely. The audio files on disk are deleted by the backend."
          >
            <Trash2 className="w-2.5 h-2.5" />
            CLEAR ALL ({entries.length})
          </button>
          <p className="text-[8px] font-mono text-zinc-700 leading-relaxed">
            Library entries (and their audio) live on the server's filesystem now — the browser only holds metadata. Use these buttons to prune the on-disk collection.
          </p>
        </div>
      </Section>

    </div>
  );
};


interface SubTabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}

const SubTabButton: React.FC<SubTabButtonProps> = ({ active, onClick, icon, children }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1.5 px-2 py-1 rounded text-[9px] font-black uppercase tracking-widest border transition-colors ${
      active
        ? 'bg-purple-500/15 border-purple-500/40 text-purple-200'
        : 'border-white/5 text-zinc-500 hover:text-zinc-300'
    }`}
  >
    {icon}
    {children}
  </button>
);


interface SubTabListProps {
  byParent: Record<string, Array<Record<string, unknown>>>;
  parentTitles: Record<string, string>;
  kind: 'stem' | 'midi';
  placeholder: string;
}

const SubTabList: React.FC<SubTabListProps> = ({ byParent, parentTitles, kind, placeholder }) => {
  const parentIds = Object.keys(byParent);
  if (parentIds.length === 0) {
    return <p className="text-[10px] text-zinc-500 italic py-4 text-center">{placeholder}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {parentIds.map((pid) => (
        <div key={pid} className="border border-white/5 rounded p-2 bg-white/3">
          <div className="text-[9px] font-black uppercase tracking-widest text-purple-300 mb-1 truncate">
            {parentTitles[pid] ?? pid}
          </div>
          <div className="flex flex-col gap-0.5">
            {byParent[pid].map((row, idx) => (
              <div
                key={String(row.id ?? idx)}
                className="flex items-center justify-between text-[10px] font-mono text-zinc-300 px-1 py-0.5 hover:bg-white/5 rounded"
              >
                <span className="truncate">
                  {kind === 'stem' ? String(row.stem_name ?? 'stem') : String(row.source ?? 'midi')}
                </span>
                <span className="text-[8px] text-zinc-600 ml-2">
                  {kind === 'stem'
                    ? `${row.model ?? ''} ${row.model_variant ?? ''}`.trim()
                    : `${row.engine ?? ''}`}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
