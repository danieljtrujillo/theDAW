import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Database, Clock, Play, Pause, Download, Trash2,
  Music, Star, Tag, Filter, ArrowUpDown,
  LayoutGrid, List as ListIcon, Activity, Scissors, Layers, Wand2, PenLine,
  Package, Network, FileMusic, Loader2, Mic, Piano, ListOrdered,
} from 'lucide-react';
import { LineageModal } from '../components/library/LineageModal';
import { StemsRunModal, type StemsRunOptions } from '../components/library/StemsRunModal';
import { MicRecorder } from '../components/audio/MicRecorder';
import { Section } from '../components/ui/Section';
import { useLibraryStore, type LibraryEntry } from '../state/libraryStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useEditorStore, computePeaks } from '../state/editorStore';
import { usePlayerStore } from '../state/playerStore';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { useStatusBarStore } from '../state/statusBarStore';
import { useFeatureToggleStore } from '../state/featureToggleStore';
import { logError, logInfo } from '../state/logStore';
import { addBlobsToChimera } from '../lib/chimeraClient';
import { setAudioDragData } from '../lib/audioDnD';
import {
  loadMidiIntoPianoRoll,
  sendAudioToChimera,
  sendAudioToEditor,
  sendAudioToInit,
  sendAudioToInpaint,
  sendMidiIdToTarget,
  stemRowToSendable,
} from '../lib/sendToTargets';


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
  const [stemsBanner, setStemsBanner] = useState<{ phase: string; progress: number; message: string } | null>(null);
  const stemsAbortControllerRef = useRef<AbortController | null>(null);
  // Pre-run modal state for stem separation. The modal opens whenever
  // the user picks "Separate stems" from a context menu so they can pick
  // count / device / quality before kicking the heavy demucs run.
  const [stemsModal, setStemsModal] = useState<{ entryId: string; entryTitle: string } | null>(null);
  // Mic-in panel — toggled by a button at the top of the LIBRARY section.
  const [micOpen, setMicOpen] = useState(false);
  const midiFileInputRef = useRef<HTMLInputElement | null>(null);
  const patchFeatures = useFeatureToggleStore((s) => s.patch);


  const abortStems = async () => {
    if (!runningKind || runningKind.kind !== 'stems') return;
    logInfo('library', `Aborting stems for ${runningKind.id.slice(0, 8)}…`);
    try {
      await fetch(`/api/stems/${runningKind.id}/abort`, { method: 'POST' });
    } catch (e) {
      logError('library', `Abort request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Also tear down the client-side fetch so the UI returns quickly.
    if (stemsAbortControllerRef.current) {
      stemsAbortControllerRef.current.abort();
      stemsAbortControllerRef.current = null;
    }
  };

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

    // For stems, poll /progress every ~1.5s while the /run request is
    // in-flight so the user sees install/download/separate phases in
    // the ProcessingLog instead of an opaque 5-minute "running…".
    // Includes a 30-second heartbeat that logs elapsed time even when
    // the sidecar phase / message hasn't changed (demucs can sit at a
    // single percentage point for minutes while it processes shifts).
    let stemsPoller: ReturnType<typeof setInterval> | null = null;
    if (kind === 'stems') {
      let lastPhase = '';
      let lastMessage = '';
      let lastProgress = -1;
      let lastChangeAt = Date.now();
      let lastHeartbeatAt = Date.now();
      const runStartedAt = Date.now();
      stemsPoller = setInterval(() => {
        void fetch(`/api/stems/${entryId}/progress`)
          .then((r) => r.json())
          .then((p: { phase?: string; message?: string; progress?: number }) => {
            const phase = p.phase || 'idle';
            const message = p.message || '';
            const progress = typeof p.progress === 'number' ? p.progress : -1;
            // Banner state so the user can see + abort from anywhere
            // in the right panel.
            setStemsBanner({ phase, progress: progress >= 0 ? progress : 0, message });
            if (phase === 'idle') return;
            const now = Date.now();
            const elapsedTotal = Math.round((now - runStartedAt) / 1000);
            const fmtElapsed = (s: number) =>
              s >= 60 ? `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, '0')}s` : `${s}s`;
            const pctText = progress >= 0 ? ` ${Math.round(progress)}%` : '';

            const changed =
              phase !== lastPhase || message !== lastMessage || progress !== lastProgress;
            if (changed) {
              lastPhase = phase;
              lastMessage = message;
              lastProgress = progress;
              lastChangeAt = now;
              lastHeartbeatAt = now;
              logInfo(
                'library',
                `stems[${entryId.slice(0, 8)}] ${phase}${pctText} @ ${fmtElapsed(elapsedTotal)}: ${message}`,
              );
              return;
            }

            // No change since last poll. Emit a heartbeat every 30s so
            // the user knows the run is still alive (demucs commonly
            // pauses ~minutes at a single percent during shifts).
            if (now - lastHeartbeatAt >= 30_000) {
              lastHeartbeatAt = now;
              const stuckFor = Math.round((now - lastChangeAt) / 1000);
              logInfo(
                'library',
                `stems[${entryId.slice(0, 8)}] still ${phase}${pctText} — no update for ${fmtElapsed(stuckFor)} (total ${fmtElapsed(elapsedTotal)})`,
              );
            }
          })
          .catch(() => {
            /* swallow — poll loop continues */
          });
      }, 1500);
    }

    // Build the run URL — stems honours the user's device + count
    // preferences from Settings → Background features.
    let runUrl = `/api/${kind}/${entryId}/run`;
    if (kind === 'stems') {
      const stemsCfg = useFeatureToggleStore.getState().settings.stems;
      const params = new URLSearchParams({
        stems: String(stemsCfg.default_count || 4),
      });
      if (stemsCfg.device && stemsCfg.device !== 'auto') {
        params.set('device', stemsCfg.device);
      }
      if (stemsCfg.quality) {
        params.set('quality', stemsCfg.quality);
      }
      runUrl += `?${params.toString()}`;
    }

    // Wire an AbortController so the user-side Abort button can tear
    // the in-flight fetch down promptly (the backend abort endpoint
    // takes care of the actual demucs cancellation).
    const ctrl = new AbortController();
    if (kind === 'stems') stemsAbortControllerRef.current = ctrl;
    try {
      const res = await fetch(runUrl, { method: 'POST', signal: ctrl.signal });
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
      const msg = e instanceof Error ? e.message : String(e);
      if (kind === 'stems' && /aborted|AbortError/i.test(msg)) {
        logInfo('library', `stem separation cancelled for ${entryId.slice(0, 8)}`);
      } else {
        logError('library', `${labels[kind]} request failed: ${msg}`);
      }
    } finally {
      if (stemsPoller) clearInterval(stemsPoller);
      if (kind === 'stems') {
        stemsAbortControllerRef.current = null;
        setStemsBanner(null);
      }
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

  // Gate the library fetch on backend readiness. The Shell mounts
  // immediately (so state stores initialize), but a /api/library/entries
  // call before uvicorn binds returns ECONNREFUSED and leaves the panel
  // stuck empty until the user hard-refreshes. We watch isBackendReady
  // and auto-fetch as soon as it flips true.
  //
  // The actual load() is wrapped in requestIdleCallback (with a
  // setTimeout fallback) so it doesn't pile on top of the vite HMR
  // commit / first paint — that's what produces the "message handler
  // took Xms" perf violations during initial connect.
  const isBackendReady = useStatusBarStore((s) => s.isBackendReady);
  useEffect(() => {
    if (!isBackendReady || loaded) return;
    type IdleCb = (cb: () => void, opts?: { timeout: number }) => number;
    const ric = (window as unknown as { requestIdleCallback?: IdleCb }).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(() => void load(), { timeout: 1500 });
    } else {
      setTimeout(() => void load(), 0);
    }
  }, [isBackendReady, loaded, load]);

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

  // Handler invoked from StemsRunModal — applies the user's per-run
  // choices (writing them back as defaults if they ticked the checkbox)
  // and kicks the actual /api/stems/<id>/run with those query params.
  const onConfirmStemsModal = async (opts: StemsRunOptions) => {
    const modal = stemsModal;
    if (!modal) return;
    setStemsModal(null);
    if (opts.persistAsDefault) {
      // Fire-and-forget — backend persists to data/settings.json and the
      // feature store reconciles on next refresh. Don't block the run.
      void patchFeatures({
        stems: {
          default_count: opts.stems,
          device: opts.device,
          quality: opts.quality,
        },
      });
    } else {
      // Even when not persisting, set the in-memory store so the
      // existing runJobForEntry() (which reads from the store) picks up
      // the user's per-run choice without a backend round-trip.
      useFeatureToggleStore.setState((s) => ({
        settings: {
          ...s.settings,
          stems: {
            ...s.settings.stems,
            default_count: opts.stems,
            device: opts.device,
            quality: opts.quality,
          },
        },
      }));
    }
    await runJobForEntry(modal.entryId, 'stems');
  };

  // Picks a .mid file off disk and loads it straight into the piano roll
  // — gives the user a "MIDI IN" path that doesn't require running the
  // basic-pitch engine first. Reusable for any /mid file on disk.
  const onLoadMidiFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      loadMidiIntoPianoRoll(buf, 'piano-roll', file.name);
    } catch (e) {
      logError('library', `MIDI import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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

  // Compact analytics strip at the very top of the panel — the user
  // wanted the prior "LIBRARY ANALYSIS" section's stats hoisted up
  // here as small chip-style features instead of taking up real
  // estate at the bottom of the panel.
  const totalSize = entries.reduce((s, e) => s + e.fileSizeBytes, 0);
  const totalDur = entries.reduce((s, e) => s + e.duration, 0);
  const favCount = entries.filter((e) => e.favorite).length;

  return (
    // h-full + overflow-y-auto on the outer scroll container ensures
    // the Library is ALWAYS fully scrollable inside the right rail —
    // never clipped behind the always-on Log section that pins to the
    // rail's bottom. min-h-0 lets the flex parent collapse properly.
    <div className="flex flex-col gap-2 h-full min-h-0 overflow-y-auto text-[11px] pb-2 px-2 pt-2">

      {/* Top stats strip — compact "features" version of the old
          LIBRARY ANALYSIS section. */}
      <div className="flex items-center gap-1 flex-wrap text-[8px] font-mono uppercase tracking-widest text-zinc-500 pb-1 border-b border-white/5">
        <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">
          <span className="text-zinc-300">{entries.length}</span> entries
        </span>
        <span className="px-1.5 py-0.5 rounded bg-yellow-500/10 border border-yellow-500/20">
          <Star className="w-2 h-2 fill-current inline-block text-yellow-400 -mt-0.5" />{' '}
          <span className="text-yellow-200">{favCount}</span>
        </span>
        <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">
          <span className="text-zinc-300">{formatSize(totalSize)}</span>
        </span>
        <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">
          <span className="text-zinc-300">{formatDuration(totalDur)}</span>
        </span>
      </div>

      {/* Stems running banner. Shows live phase + progress + an Abort
          button so the user can bail without right-click-finding the
          original entry. */}
      {runningKind?.kind === 'stems' && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-purple-500/40 bg-purple-500/15 text-[10px] font-mono">
          <Loader2 className="w-3 h-3 text-purple-300 animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-purple-200 truncate">
              Stems · {runningKind.id.slice(0, 8)} · {stemsBanner?.phase ?? '…'}
              {typeof stemsBanner?.progress === 'number' && stemsBanner.progress > 0
                ? ` · ${Math.round(stemsBanner.progress)}%`
                : ''}
            </div>
            {stemsBanner?.message && (
              <div className="text-[8px] text-zinc-400 truncate">{stemsBanner.message}</div>
            )}
          </div>
          <button
            onClick={() => void abortStems()}
            className="shrink-0 text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/15"
            title="Abort the running stem separation"
          >
            Abort
          </button>
        </div>
      )}

      {/* Stems pre-run modal — picks count / device / quality, optionally
          saves them as the new defaults, then kicks runJobForEntry. */}
      <StemsRunModal
        open={stemsModal !== null}
        entryLabel={stemsModal?.entryTitle}
        onCancel={() => setStemsModal(null)}
        onConfirm={(opts) => void onConfirmStemsModal(opts)}
      />

      {/* Hidden file picker — used by the "Import MIDI" toolbar button.
          Drives loadMidiIntoPianoRoll() so users can pull a .mid off
          disk straight into the piano roll without running basic-pitch. */}
      <input
        ref={midiFileInputRef}
        type="file"
        accept=".mid,.midi,audio/midi"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onLoadMidiFile(file);
          // Reset so picking the same file twice re-fires onChange.
          e.target.value = '';
        }}
      />

      <Section title="LIBRARY" icon={Database} defaultOpen={true} rightNode={
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <span className="text-[8px] font-mono text-zinc-600">{entries.length} TRACKS</span>
          <button
            onClick={() => setMicOpen((v) => !v)}
            className={`p-1 rounded ${micOpen ? 'bg-red-500/20 text-red-300' : 'text-zinc-500 hover:text-zinc-300'}`}
            title="Mic-in recorder"
          >
            <Mic className="w-3 h-3" />
          </button>
          <button
            onClick={() => midiFileInputRef.current?.click()}
            className="p-1 rounded text-zinc-500 hover:text-purple-300"
            title="Import a .mid file → piano roll"
          >
            <FileMusic className="w-3 h-3" />
          </button>
          <button onClick={() => setViewMode('list')} className={`p-1 rounded ${viewMode === 'list' ? 'bg-white/10 text-white' : 'text-zinc-600'}`} title="List view">
            <ListIcon className="w-3 h-3" />
          </button>
          <button onClick={() => setViewMode('grid')} className={`p-1 rounded ${viewMode === 'grid' ? 'bg-white/10 text-white' : 'text-zinc-600'}`} title="Grid view">
            <LayoutGrid className="w-3 h-3" />
          </button>
        </div>
      }>
        {/* Mic-in recorder. Hidden by default; toggled from the LIBRARY
            header. Saving to library triggers a refresh so the recording
            shows up immediately as a fresh import entry. */}
        {micOpen && (
          <div className="mb-2">
            <MicRecorder
              embedded
              onClose={() => setMicOpen(false)}
            />
          </div>
        )}

        <div className="flex flex-col gap-2 mb-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600" />
            <input
              id="library-search"
              name="library-search"
              type="search"
              className="compact-input w-full pl-7"
              placeholder="SEARCH titles / prompts / tags / model / bpm / key / genre…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search the library"
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
              const title = entries.find((e) => e.id === id)?.title ?? id;
              setContextMenu(null);
              // Open the modal so the user picks stem count / device /
              // quality. Holding Shift skips the modal and uses the
              // settings.json defaults for power users.
              setStemsModal({ entryId: id, entryTitle: title });
            }}
          >
            <span className="flex items-center gap-1.5">
              {runningKind?.id === contextMenu.entryId && runningKind?.kind === 'stems'
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Scissors className="w-3 h-3" />}
              Separate stems…
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

      {/* Stats moved to the compact chip strip at the top of the
          panel. This section is now just maintenance actions. */}
      <Section title="LIBRARY MAINTENANCE" icon={Activity} defaultOpen={false}>
        <div className="flex flex-col gap-2">
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

type SubTabContextMenu =
  | { kind: 'midi'; x: number; y: number; midiId: string; label: string }
  | { kind: 'stem'; x: number; y: number; row: Record<string, unknown> };


const SubTabList: React.FC<SubTabListProps> = ({ byParent, parentTitles, kind, placeholder }) => {
  const parentIds = Object.keys(byParent);
  const [menu, setMenu] = useState<SubTabContextMenu | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, { capture: true });
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close, { capture: true } as EventListenerOptions);
    };
  }, [menu]);

  if (parentIds.length === 0) {
    return <p className="text-[10px] text-zinc-500 italic py-4 text-center">{placeholder}</p>;
  }
  return (
    <div className="flex flex-col gap-2 relative">
      {parentIds.map((pid) => (
        <div key={pid} className="border border-white/5 rounded p-2 bg-white/3">
          <div className="text-[9px] font-black uppercase tracking-widest text-purple-300 mb-1 truncate">
            {parentTitles[pid] ?? pid}
          </div>
          <div className="flex flex-col gap-0.5">
            {byParent[pid].map((row, idx) => {
              const isMidi = kind === 'midi';
              const midiId = String(row.id ?? '');
              const label = String((isMidi ? row.source : row.stem_name) ?? 'item');
              return (
                <div
                  key={String(row.id ?? idx)}
                  className="flex items-center justify-between text-[10px] font-mono text-zinc-300 px-1 py-0.5 hover:bg-white/5 rounded cursor-context-menu"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (isMidi) {
                      if (!midiId) return;
                      setMenu({ kind: 'midi', x: e.clientX, y: e.clientY, midiId, label });
                    } else {
                      setMenu({ kind: 'stem', x: e.clientX, y: e.clientY, row });
                    }
                  }}
                  title="Right-click to send this anywhere"
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
              );
            })}
          </div>
        </div>
      ))}

      {menu && menu.kind === 'midi' && (
        <ContextMenu x={menu.x} y={menu.y} title={`MIDI · ${menu.label}`}>
          <ContextItem
            icon={<Piano className="w-3 h-3" />}
            label="Send to piano roll"
            onClick={() => { void sendMidiIdToTarget(menu.midiId, 'piano-roll'); setMenu(null); }}
          />
          <ContextItem
            icon={<ListOrdered className="w-3 h-3" />}
            label="Send to step sequencer"
            onClick={() => { void sendMidiIdToTarget(menu.midiId, 'step-seq'); setMenu(null); }}
          />
          <ContextItem
            icon={<Download className="w-3 h-3" />}
            label="Download .mid"
            onClick={() => {
              const a = document.createElement('a');
              a.href = `/api/midi/file/${menu.midiId}`;
              a.download = '';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              setMenu(null);
            }}
          />
        </ContextMenu>
      )}

      {menu && menu.kind === 'stem' && (
        <StemContextMenu
          x={menu.x}
          y={menu.y}
          row={menu.row}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
};


/**
 * Right-click menu for one separated stem (e.g. bass.wav, drums.wav).
 * Same set of audio destinations the parent-track menu has — editor,
 * init, inpaint, chimera, download.
 */
const StemContextMenu: React.FC<{
  x: number;
  y: number;
  row: Record<string, unknown>;
  onClose: () => void;
}> = ({ x, y, row, onClose }) => {
  const stemId = String(row.id ?? '');
  const stemName = String(row.stem_name ?? 'stem');
  const sendable = useMemo(() => stemRowToSendable(row), [row]);
  const audioUrl = `/api/library/stems/${stemId}/audio`;
  return (
    <ContextMenu x={x} y={y} title={`Stem · ${stemName}`}>
      <ContextItem
        icon={<Scissors className="w-3 h-3" />}
        label="Append to editor"
        onClick={() => { void sendAudioToEditor(sendable, 'editor-first-track'); onClose(); }}
      />
      <ContextItem
        icon={<Layers className="w-3 h-3" />}
        label="Send to editor (new track)"
        onClick={() => { void sendAudioToEditor(sendable, 'editor-new-track'); onClose(); }}
      />
      <ContextItem
        icon={<Wand2 className="w-3 h-3" />}
        label="Send to Init audio"
        onClick={() => { void sendAudioToInit(sendable); onClose(); }}
      />
      <ContextItem
        icon={<PenLine className="w-3 h-3" />}
        label="Send to Inpaint"
        onClick={() => { void sendAudioToInpaint(sendable); onClose(); }}
      />
      <ContextItem
        icon={<Music className="w-3 h-3" />}
        label="Add to Chimera"
        onClick={() => { void sendAudioToChimera([sendable]); onClose(); }}
      />
      <ContextItem
        icon={<Download className="w-3 h-3" />}
        label="Download .wav"
        onClick={() => {
          const a = document.createElement('a');
          a.href = audioUrl;
          a.download = `${stemName}.wav`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          onClose();
        }}
      />
    </ContextMenu>
  );
};


const ContextMenu: React.FC<{
  x: number;
  y: number;
  title: string;
  children: React.ReactNode;
}> = ({ x, y, title, children }) => (
  <div
    className="fixed z-200 min-w-48 bg-[#0a080f] border border-purple-500/40 rounded shadow-[0_8px_24px_rgba(0,0,0,0.6)] py-1 text-[10px] font-mono"
    style={{ left: x, top: y }}
    onClick={(e) => e.stopPropagation()}
    onContextMenu={(e) => e.preventDefault()}
  >
    <div className="px-3 py-1.5 text-[8px] uppercase tracking-widest text-zinc-600 border-b border-white/5 mb-0.5 truncate">
      {title}
    </div>
    {children}
  </div>
);


const ContextItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}> = ({ icon, label, onClick }) => (
  <button
    className="w-full text-left px-3 py-1.5 hover:bg-purple-500/15 text-purple-200 flex items-center gap-1.5"
    onClick={onClick}
  >
    {icon}
    {label}
  </button>
);

