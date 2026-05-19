import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Scissors, Play, Square, ZoomIn, ZoomOut,
  Magnet, Trash2, Move, Plus, Volume2, Upload, Save, Piano,
} from 'lucide-react';
import { useEditorStore, computePeaks, type SnapDivision } from '../../state/editorStore';
import { useLibraryStore } from '../../state/libraryStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx, getMasterGain } from '../../state/playerStore';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import { logError, logInfo } from '../../state/logStore';

const TRACK_HEADER_PX = 180;
const TRACK_HEIGHT = 88;

const formatTimecode = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.floor(sec * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${Math.floor(ms / 10).toString().padStart(2, '0')}`;
};

// Preview routes through the shared engine context so the visualizer sees it too.

// --- WAV encoder for the offline mixdown output. ---
const encodeWav = (audioBuf: AudioBuffer): Blob => {
  const numCh = audioBuf.numberOfChannels;
  const sr = audioBuf.sampleRate;
  const len = audioBuf.length;
  const buffer = new ArrayBuffer(44 + len * numCh * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * numCh * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * numCh * 2, true);
  // Interleave + 16-bit PCM.
  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c += 1) channels.push(audioBuf.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < len; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
};

interface PointerOp {
  kind: 'move' | 'resize-left' | 'resize-right';
  clipId: string;
  startPxX: number;
  startPxY: number;
  initialStartSec: number;
  initialDurationSec: number;
  initialOffsetIntoSource: number;
  initialTrackIndex: number;
}

export const WaveformEditor: React.FC = () => {
  const tracks = useEditorStore((s) => s.tracks);
  const clips = useEditorStore((s) => s.clips);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const tool = useEditorStore((s) => s.tool);
  const zoom = useEditorStore((s) => s.zoom);
  const playheadSec = useEditorStore((s) => s.playheadSec);
  const snap = useEditorStore((s) => s.snap);
  const setSelected = useEditorStore((s) => s.setSelected);
  const setTool = useEditorStore((s) => s.setTool);
  const setZoom = useEditorStore((s) => s.setZoom);
  const setSnap = useEditorStore((s) => s.setSnap);
  const setPlayhead = useEditorStore((s) => s.setPlayhead);
  const addTrack = useEditorStore((s) => s.addTrack);
  const removeTrack = useEditorStore((s) => s.removeTrack);
  const updateTrack = useEditorStore((s) => s.updateTrack);
  const toggleSolo = useEditorStore((s) => s.toggleSolo);
  const updateClip = useEditorStore((s) => s.updateClip);
  const removeClip = useEditorStore((s) => s.removeClip);
  const splitClipAt = useEditorStore((s) => s.splitClipAt);
  const cachePeaks = useEditorStore((s) => s.cachePeaks);
  const addClipToTrack = useEditorStore((s) => s.addClipToTrack);
  const snapSec = useEditorStore((s) => s.snapSec);
  const getTotalDurationSec = useEditorStore((s) => s.getTotalDurationSec);
  const masterGain = usePlaybackStore((s) => (s.muted ? 0 : s.volume / 100));

  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const opRef = useRef<PointerOp | null>(null);
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);

  const totalDuration = getTotalDurationSec();
  const timelineWidthPx = Math.max(totalDuration * zoom, 1000);

  // Decode + cache peaks for any clip that doesn't have them yet.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const c of clips) {
        if (c.peaks || cancelled) continue;
        try {
          const { peaks } = await computePeaks(c.audioBlob, 240);
          if (!cancelled) cachePeaks(c.id, peaks);
        } catch (e) {
          if (!cancelled) {
            logError('editor', `Peak decode failed for ${c.label}: ${e instanceof Error ? e.message : e}`);
          }
        }
      }
    })();
    return () => { cancelled = true; };
  }, [clips, cachePeaks]);


  const stopPreview = useCallback(() => {
    if (previewSourceRef.current) {
      try { previewSourceRef.current.stop(); } catch { /* ignore */ }
      previewSourceRef.current = null;
    }
  }, []);

  // Preview playback of the selected clip.
  const playSelectedPreview = useCallback(async () => {
    const clip = clips.find((c) => c.id === selectedClipId);
    if (!clip) {
      logError('editor', 'Nothing selected to preview');
      return;
    }
    stopPreview();
    try {
      const ctx = getEngineCtx();
      if (ctx.state === 'suspended') void ctx.resume();
      const buf = await clip.audioBlob.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(buf.slice(0));
      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      const gain = ctx.createGain();
      gain.gain.value = masterGain;
      // Route through the shared master → analyser → destination chain.
      src.connect(gain).connect(getMasterGain());
      src.onended = () => {
        if (previewSourceRef.current === src) previewSourceRef.current = null;
      };
      previewSourceRef.current = src;
      src.start(0, clip.offsetIntoSource, clip.durationSec);
      logInfo('editor', `Previewing: ${clip.label} (${clip.durationSec.toFixed(2)}s)`);
    } catch (e) {
      logError('editor', `Preview failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [clips, selectedClipId, masterGain, stopPreview]);

  // --- Keyboard hotkeys ---
  // v        = move tool
  // c        = cut tool
  // Space    = play preview / stop preview
  // Delete   = remove selected clip
  // Ctrl/Cmd+D = duplicate selected clip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // No modifier hotkeys.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'v' || e.key === 'V') {
          e.preventDefault();
          setTool('move');
          return;
        }
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          setTool('cut');
          return;
        }
        if (e.key === ' ') {
          if (selectedClipId) {
            e.preventDefault();
            if (previewSourceRef.current) stopPreview();
            else void playSelectedPreview();
          }
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selectedClipId) {
            e.preventDefault();
            removeClip(selectedClipId);
          }
          return;
        }
      }
      // Ctrl/Cmd + D = duplicate selected clip.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        if (!selectedClipId) return;
        const clip = clips.find((c) => c.id === selectedClipId);
        if (!clip) return;
        const newId = addClipToTrack({
          ...clip,
          startSec: clip.startSec + clip.durationSec,
        });
        logInfo('editor', `Duplicated clip → ${newId.slice(0, 8)}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClipId, clips, setTool, stopPreview, playSelectedPreview, removeClip, addClipToTrack]);

  // --- Wheel: Ctrl/Cmd + wheel = zoom; plain wheel = horizontal pan ---
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Zoom centered on cursor X.
        const rect = el.getBoundingClientRect();
        const cursorX = e.clientX - rect.left + el.scrollLeft;
        const oldZoom = useEditorStore.getState().zoom;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const newZoom = Math.max(5, Math.min(400, oldZoom * factor));
        useEditorStore.getState().setZoom(newZoom);
        // Keep the cursor on the same time after zoom.
        const ratio = newZoom / oldZoom;
        el.scrollLeft = cursorX * ratio - (e.clientX - rect.left);
        return;
      }
      // Plain wheel — convert vertical delta to horizontal scroll.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- Right-click context menu ---
  type CtxMenu = { x: number; y: number; clipId: string; atSec: number };
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('contextmenu', close, { capture: true });
    window.addEventListener('blur', close);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close, { capture: true } as EventListenerOptions);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const openContextMenu = (e: React.MouseEvent, clipId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(clipId);
    let atSec = 0;
    if (timelineRef.current) {
      const rect = timelineRef.current.getBoundingClientRect();
      atSec = pxToSec(e.clientX - rect.left);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, clipId, atSec });
  };

  // OfflineAudioContext mixdown.
  const commitEdit = useCallback(async () => {
    if (clips.length === 0) {
      logError('editor', 'No clips to commit');
      return;
    }
    setIsCommitting(true);
    const start = performance.now();
    logInfo('editor', `Mixing ${clips.length} clips on ${tracks.length} tracks…`);
    try {
      const dur = getTotalDurationSec();
      const sr = 44100;
      const offline = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
      const anySolo = tracks.some((t) => t.solo);
      // Decode every unique blob once.
      const blobCache = new Map<Blob, AudioBuffer>();
      for (const c of clips) {
        if (!blobCache.has(c.audioBlob)) {
          const ab = await c.audioBlob.arrayBuffer();
          const decoded = await offline.decodeAudioData(ab.slice(0));
          blobCache.set(c.audioBlob, decoded);
        }
      }
      for (const c of clips) {
        const track = tracks.find((t) => t.id === c.trackId);
        if (!track) continue;
        if (track.mute) continue;
        if (anySolo && !track.solo) continue;
        const buf = blobCache.get(c.audioBlob);
        if (!buf) continue;
        const src = offline.createBufferSource();
        src.buffer = buf;
        const gain = offline.createGain();
        gain.gain.value = track.volume;
        const panner = offline.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, track.pan));
        src.connect(gain).connect(panner).connect(offline.destination);
        src.start(c.startSec, c.offsetIntoSource, c.durationSec);
      }
      const rendered = await offline.startRendering();
      const wavBlob = encodeWav(rendered);
      const stamp = new Date().toISOString();
      const id = `mix-${Date.now()}`;
      await useLibraryStore.getState().addEntry({
        id,
        title: `mixdown_${id.slice(-6)}.wav`,
        prompt: `Editor mixdown of ${clips.length} clips`,
        negativePrompt: '',
        model: 'editor-mixdown',
        duration: rendered.duration,
        steps: 0,
        cfg: 0,
        seed: -1,
        audioBlob: wavBlob,
        mimeType: 'audio/wav',
        timestamp: stamp,
        favorite: false,
        rating: null,
        tags: ['mixdown'],
        notes: '',
        source: 'studio',
      });
      const ms = (performance.now() - start).toFixed(0);
      logInfo('editor', `Mixdown complete: ${rendered.duration.toFixed(2)}s rendered in ${ms}ms → library`);
    } catch (e) {
      logError('editor', `Mixdown failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsCommitting(false);
    }
  }, [clips, tracks, getTotalDurationSec]);

  // --- Pointer math helpers. ---
  const pxToSec = useCallback((px: number) => px / zoom, [zoom]);

  const onClipPointerDown = (e: React.PointerEvent, clipId: string, edge: 'move' | 'left' | 'right') => {
    e.stopPropagation();
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    setSelected(clipId);
    const trackIndex = tracks.findIndex((t) => t.id === clip.trackId);
    opRef.current = {
      kind: edge === 'move' ? 'move' : edge === 'left' ? 'resize-left' : 'resize-right',
      clipId,
      startPxX: e.clientX,
      startPxY: e.clientY,
      initialStartSec: clip.startSec,
      initialDurationSec: clip.durationSec,
      initialOffsetIntoSource: clip.offsetIntoSource,
      initialTrackIndex: trackIndex,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const op = opRef.current;
    if (!op) return;
    const dxPx = e.clientX - op.startPxX;
    const dySec = e.clientY - op.startPxY;
    const dxSec = pxToSec(dxPx);
    const clip = clips.find((c) => c.id === op.clipId);
    if (!clip) return;
    if (op.kind === 'move') {
      const newStart = snapSec(op.initialStartSec + dxSec);
      // Vertical track shift.
      const trackDelta = Math.round(dySec / TRACK_HEIGHT);
      const targetIdx = Math.max(0, Math.min(tracks.length - 1, op.initialTrackIndex + trackDelta));
      const newTrackId = tracks[targetIdx].id;
      updateClip(op.clipId, { startSec: newStart, trackId: newTrackId });
    } else if (op.kind === 'resize-right') {
      const newDur = Math.max(0.05, op.initialDurationSec + dxSec);
      // Don't exceed source.
      const maxDur = Math.max(0.05, clip.sourceDuration - clip.offsetIntoSource);
      updateClip(op.clipId, { durationSec: Math.min(newDur, maxDur) });
    } else if (op.kind === 'resize-left') {
      const delta = dxSec;
      const newStart = op.initialStartSec + delta;
      const newOffset = op.initialOffsetIntoSource + delta;
      const newDur = op.initialDurationSec - delta;
      if (newDur <= 0.05 || newOffset < 0) return;
      updateClip(op.clipId, {
        startSec: Math.max(0, newStart),
        offsetIntoSource: newOffset,
        durationSec: newDur,
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (opRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      opRef.current = null;
    }
  };

  // --- Drag-and-drop from Library ---
  const onTimelineDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-stabledaw-library-id')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onTimelineDrop = async (e: React.DragEvent) => {
    const entryId = e.dataTransfer.getData('application/x-stabledaw-library-id');
    if (!entryId) return;
    e.preventDefault();
    if (!timelineRef.current) return;
    const entry = useLibraryStore.getState().entries.find((x) => x.id === entryId);
    if (!entry) {
      logError('editor', `Drop: library entry ${entryId.slice(0, 8)} not found`);
      return;
    }
    const rect = timelineRef.current.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    const droppedBelowAllTracks = yPx >= tracks.length * TRACK_HEIGHT;
    let targetTrack: typeof tracks[number] | undefined;
    if (droppedBelowAllTracks) {
      const newTrackId = addTrack({ name: entry.title });
      // Re-read tracks from the store after the mutation.
      targetTrack = useEditorStore.getState().tracks.find((t) => t.id === newTrackId);
    } else {
      const targetTrackIdx = Math.max(0, Math.min(tracks.length - 1, Math.floor(yPx / TRACK_HEIGHT)));
      targetTrack = tracks[targetTrackIdx];
    }
    if (!targetTrack) return;
    const startSec = droppedBelowAllTracks ? 0 : snapSec(pxToSec(xPx));
    try {
      const { peaks, duration } = await computePeaks(entry.audioBlob, 240);
      const clipId = addClipToTrack({
        trackId: targetTrack.id,
        label: entry.title ?? `clip_${entryId.slice(0, 6)}`,
        audioBlob: entry.audioBlob,
        mimeType: entry.mimeType,
        sourceDuration: duration || entry.duration,
        offsetIntoSource: 0,
        durationSec: duration || entry.duration,
        startSec,
        color: targetTrack.color,
        libraryEntryId: entry.id,
      });
      cachePeaks(clipId, peaks);
      logInfo('editor', `Dropped ${entry.title} on ${targetTrack.name} at ${startSec.toFixed(2)}s`);
    } catch (err) {
      logError('editor', `Drop decode failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const onTimelineClick = (e: React.MouseEvent) => {
    if (!timelineRef.current) return;
    if (opRef.current) return;
    // Only react to direct clicks on the timeline gutter (not on a clip).
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip="1"]')) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const sec = pxToSec(x);
    setPlayhead(Math.max(0, sec));
    setSelected(null);
  };

  const onClipClick = (e: React.MouseEvent, clipId: string) => {
    if (tool !== 'cut') return;
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const sec = pxToSec(x);
    splitClipAt(clipId, sec);
  };

  // --- Renderers ---
  const renderRuler = useMemo(() => {
    const ticks: { sec: number; major: boolean }[] = [];
    const stepSec = zoom >= 60 ? 1 : zoom >= 25 ? 2 : zoom >= 12 ? 5 : 10;
    for (let s = 0; s <= totalDuration + stepSec; s += stepSec) {
      ticks.push({ sec: s, major: s % (stepSec * 5) === 0 });
    }
    return ticks;
  }, [zoom, totalDuration]);

  const selectedClip = clips.find((c) => c.id === selectedClipId) ?? null;

  return (
    <div className="hardware-card h-full flex flex-col bg-black/40 overflow-hidden" ref={containerRef}>
      {/* Editor Toolbar */}
      <div className="flex items-center justify-between p-2 border-b border-white/5 bg-black/20 flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => addTrack()}
            className="btn-primary flex items-center gap-1.5 !bg-purple-600/20 !border-purple-500/30 !text-purple-300 !px-2 !py-0.5 text-[9px]"
            title="Add a new empty track"
          >
            <Plus className="w-3 h-3" /> ADD TRACK
          </button>

          <div className="h-4 w-px bg-white/10" />

          <div className="flex bg-black/40 p-0.5 rounded border border-white/5 gap-0.5">
            <button
              onClick={() => setTool('move')}
              className={`p-1 px-2 rounded transition-colors ${tool === 'move' ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
              title="Move tool: drag clips"
            >
              <Move className="w-3 h-3" />
            </button>
            <button
              onClick={() => setTool('cut')}
              className={`p-1 px-2 rounded transition-colors ${tool === 'cut' ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40' : 'text-zinc-500 hover:text-white hover:bg-white/5'}`}
              title="Cut tool: click a clip to split it at that point"
            >
              <Scissors className="w-3 h-3" />
            </button>
          </div>

          <div className="flex items-center gap-1.5 px-2 py-0.5 bg-black/40 border border-white/5 rounded">
            <Magnet className={`w-3 h-3 ${snap === 'off' ? 'text-zinc-700' : 'text-purple-300'}`} />
            <select
              value={snap}
              onChange={(e) => setSnap(e.target.value as SnapDivision)}
              className="bg-transparent border-none outline-none text-[9px] font-mono uppercase text-zinc-300 cursor-pointer"
              title="Snap divisions are relative to the editor BPM"
            >
              <option value="off">Snap off</option>
              <option value="1/4">1/4</option>
              <option value="1/8">1/8</option>
              <option value="1/16">1/16</option>
            </select>
          </div>

          <div className="flex items-center gap-1">
            <button onClick={() => setZoom(zoom - 5)} className="p-1 hover:bg-white/5 rounded text-zinc-500" title="Zoom out">
              <ZoomOut className="w-3 h-3" />
            </button>
            <span className="text-[9px] font-mono text-zinc-400 w-12 text-center">{zoom}px/s</span>
            <button onClick={() => setZoom(zoom + 5)} className="p-1 hover:bg-white/5 rounded text-zinc-500" title="Zoom in">
              <ZoomIn className="w-3 h-3" />
            </button>
          </div>

          <div className="h-4 w-px bg-white/10" />

          <button
            disabled={!selectedClipId}
            onClick={() => selectedClipId && removeClip(selectedClipId)}
            className="p-1.5 hover:bg-red-500/20 rounded text-zinc-400 hover:text-red-400 disabled:opacity-30 disabled:pointer-events-none"
            title="Delete selected clip (Del)"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[9px] font-mono text-zinc-500 tabular-nums">
            {formatTimecode(playheadSec)} / {formatTimecode(totalDuration)}
          </span>
          <button
            onClick={playSelectedPreview}
            disabled={!selectedClipId}
            className="p-1.5 hover:bg-purple-500/20 rounded text-purple-300 disabled:opacity-30"
            title="Preview selected clip"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
          </button>
          <button
            onClick={stopPreview}
            className="p-1.5 hover:bg-white/10 rounded text-zinc-400"
            title="Stop preview"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
          <button
            onClick={() => void commitEdit()}
            disabled={isCommitting || clips.length === 0}
            className="btn-primary !py-1 !px-2 text-[9px] flex items-center gap-1.5 disabled:opacity-40"
            title="Render all clips to a single audio file and save it to the library"
          >
            {isCommitting ? <Upload className="w-3 h-3 animate-pulse" /> : <Save className="w-3 h-3" />}
            {isCommitting ? 'COMMITTING…' : 'COMMIT EDIT'}
          </button>
        </div>
      </div>

      {/* Body: track headers + scrollable timeline */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Track headers (sticky, not scrolled) */}
        <div className="flex-shrink-0 bg-[#0c0a12] border-r border-[#1a1528] overflow-hidden flex flex-col" style={{ width: TRACK_HEADER_PX }}>
          {/* Ruler row spacer */}
          <div className="h-6 border-b border-white/5 bg-black/30 flex items-center justify-center text-[8px] font-mono text-zinc-700 uppercase">tracks</div>
          <div className="flex-1 overflow-y-auto">
            {tracks.map((t) => (
              <div key={t.id} className="border-b border-[#1a1528] p-2 flex flex-col gap-1.5" style={{ height: TRACK_HEIGHT }}>
                <div className="flex justify-between items-center gap-1">
                  <input
                    type="text"
                    value={t.name}
                    onChange={(e) => updateTrack(t.id, { name: e.target.value, nameAutoGenerated: false })}
                    className="bg-transparent border-none outline-none text-[10px] font-bold w-full hover:bg-white/5 px-1 -mx-1 rounded transition-colors min-w-0"
                    style={{ color: t.color }}
                  />
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => updateTrack(t.id, { mute: !t.mute })}
                      className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center ${t.mute ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                    >M</button>
                    <button
                      onClick={() => toggleSolo(t.id)}
                      className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center ${t.solo ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                    >S</button>
                    <button
                      onClick={() => removeTrack(t.id)}
                      className="w-4 h-4 rounded text-[8px] flex items-center justify-center bg-black/40 text-zinc-600 border border-white/5 hover:text-red-400"
                      title="Remove track"
                    >×</button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Volume2 className="w-2.5 h-2.5 text-zinc-600 flex-shrink-0" />
                  <input
                    type="range"
                    min={0} max={1} step={0.01}
                    value={t.volume}
                    onChange={(e) => updateTrack(t.id, { volume: parseFloat(e.target.value) })}
                    className="pro-slider flex-1"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[7px] font-mono text-zinc-600 uppercase w-3">P</span>
                  <input
                    type="range"
                    min={-1} max={1} step={0.01}
                    value={t.pan}
                    onChange={(e) => updateTrack(t.id, { pan: parseFloat(e.target.value) })}
                    className="pro-slider flex-1 accent-blue-500"
                  />
                  <span className="text-[7px] font-mono text-zinc-600 text-right w-5">
                    {t.pan > 0 ? `R${Math.round(t.pan * 100)}` : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : 'C'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Scrollable timeline area */}
        <div
          ref={timelineScrollRef}
          className="flex-1 min-w-0 overflow-x-auto overflow-y-auto bg-[#07050a]"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          {/* Ruler */}
          <div className="h-6 border-b border-white/5 bg-black/30 relative" style={{ width: timelineWidthPx }}>
            {renderRuler.map((tick) => (
              <div
                key={tick.sec}
                className="absolute top-0 bottom-0 flex items-center px-1 border-l border-white/5"
                style={{ left: tick.sec * zoom }}
              >
                <span className={`text-[8px] font-mono ${tick.major ? 'text-zinc-500' : 'text-zinc-700'}`}>
                  {formatTimecode(tick.sec).replace(/\.00$/, '')}
                </span>
              </div>
            ))}
          </div>

          {/* Track lanes + 'drop here for new track' slot at the bottom */}
          <div
            ref={timelineRef}
            className={`relative ${tool === 'cut' ? 'cursor-crosshair' : 'cursor-default'}`}
            style={{ width: timelineWidthPx, height: tracks.length * TRACK_HEIGHT + 34 }}
            onMouseDown={onTimelineClick}
            onDragOver={onTimelineDragOver}
            onDrop={onTimelineDrop}
          >
            {tracks.map((track, ti) => (
              <div
                key={track.id}
                className="absolute left-0 right-0 border-b border-white/5"
                style={{ top: ti * TRACK_HEIGHT, height: TRACK_HEIGHT, backgroundImage: 'linear-gradient(to right, rgba(255,255,255,0.02) 1px, transparent 1px)', backgroundSize: `${zoom * 5}px 100%` }}
              />
            ))}

            {/* Clips */}
            {clips.map((clip) => {
              const trackIdx = tracks.findIndex((t) => t.id === clip.trackId);
              if (trackIdx < 0) return null;
              const left = clip.startSec * zoom;
              const width = clip.durationSec * zoom;
              const top = trackIdx * TRACK_HEIGHT + 6;
              const height = TRACK_HEIGHT - 12;
              const selected = clip.id === selectedClipId;
              const peaks = clip.peaks;
              return (
                <div
                  key={clip.id}
                  data-clip="1"
                  onPointerDown={(e) => onClipPointerDown(e, clip.id, 'move')}
                  onClick={(e) => onClipClick(e, clip.id)}
                  onContextMenu={(e) => openContextMenu(e, clip.id)}
                  className={`absolute rounded border overflow-hidden transition-shadow ${selected ? 'border-white shadow-[0_0_18px_rgba(255,255,255,0.18)] z-10' : 'border-white/15 hover:border-white/40'}`}
                  style={{
                    left, width, top, height,
                    backgroundColor: `${clip.color}22`,
                    cursor: tool === 'cut' ? 'crosshair' : 'grab',
                  }}
                >
                  {/* Header bar */}
                  <div className="absolute top-0 left-0 right-0 px-1 h-[14px] bg-black/50 backdrop-blur-sm border-b border-white/10 flex justify-between items-center text-[8px] font-mono uppercase tracking-tighter">
                    <span className="flex items-center gap-1 min-w-0 max-w-[60%]">
                      {clip.sourceKind === 'piano-roll' && (
                        <Piano className="w-2.5 h-2.5 text-emerald-300 flex-shrink-0" />
                      )}
                      <span className="text-white truncate">{clip.label}</span>
                    </span>
                    <span className="text-zinc-300">{clip.durationSec.toFixed(2)}s</span>
                  </div>
                  {/* Waveform peaks */}
                  <div className="absolute inset-x-0 bottom-0 top-[14px] flex items-center gap-[0.5px] px-1">
                    {peaks ? (
                      Array.from(peaks).map((v, i) => (
                        <div
                          key={i}
                          className="flex-1 rounded-sm"
                          style={{ height: `${Math.max(2, v * 90)}%`, backgroundColor: clip.color, opacity: selected ? 0.95 : 0.7 }}
                        />
                      ))
                    ) : (
                      <span className="text-[8px] font-mono text-zinc-600 italic">decoding…</span>
                    )}
                  </div>
                  {/* Resize handles */}
                  <div
                    className="absolute inset-y-0 left-0 w-1.5 hover:bg-white/40 cursor-ew-resize"
                    onPointerDown={(e) => onClipPointerDown(e, clip.id, 'left')}
                  />
                  <div
                    className="absolute inset-y-0 right-0 w-1.5 hover:bg-white/40 cursor-ew-resize"
                    onPointerDown={(e) => onClipPointerDown(e, clip.id, 'right')}
                  />
                </div>
              );
            })}

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)] z-20 pointer-events-none"
              style={{ left: playheadSec * zoom }}
            >
              <div className="absolute top-0 -left-1 w-2 h-2 rotate-45 bg-red-500" />
            </div>

            {/* Drop-here-for-new-track strip — directly below the last lane */}
            <div
              className="absolute left-0 right-0 border-t border-dashed border-purple-500/30 bg-purple-500/[0.04] flex items-center justify-center text-[9px] font-mono uppercase tracking-widest text-purple-400/60 pointer-events-none"
              style={{ top: tracks.length * TRACK_HEIGHT, height: 34 }}
            >
              Drop here to create a new track
            </div>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="h-6 border-t border-white/5 bg-black/60 flex items-center justify-between px-3 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-[9px] font-mono text-zinc-500 tabular-nums">
            {formatTimecode(playheadSec)} / {formatTimecode(totalDuration)}
          </span>
          <span className="text-[8px] font-mono text-zinc-600">
            {clips.length} clips · {tracks.length} tracks
          </span>
        </div>
        <div className="flex items-center gap-3">
          {selectedClip ? (
            <span className="text-[8px] font-mono text-purple-300 uppercase tracking-wider">
              SEL: {selectedClip.label} · {selectedClip.startSec.toFixed(2)}s → {(selectedClip.startSec + selectedClip.durationSec).toFixed(2)}s
            </span>
          ) : (
            <span className="text-[8px] font-mono text-zinc-700 uppercase tracking-wider">
              {clips.length === 0 ? 'No clips yet — send something from LIBRARY' : 'No selection'}
            </span>
          )}
        </div>
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          className="fixed z-[200] min-w-[160px] bg-[#0a080f] border border-purple-500/40 rounded shadow-[0_8px_24px_rgba(0,0,0,0.6)] py-1 text-[10px] font-mono"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="w-full text-left px-3 py-1 hover:bg-purple-500/15 text-zinc-200 flex items-center justify-between"
            onClick={() => { void playSelectedPreview(); setCtxMenu(null); }}
          >
            <span>Preview</span>
            <span className="text-zinc-600 text-[8px]">Space</span>
          </button>
          <button
            className="w-full text-left px-3 py-1 hover:bg-purple-500/15 text-zinc-200 flex items-center justify-between"
            onClick={() => { splitClipAt(ctxMenu.clipId, ctxMenu.atSec); setCtxMenu(null); }}
          >
            <span>Split here</span>
            <span className="text-zinc-600 text-[8px]">{ctxMenu.atSec.toFixed(2)}s</span>
          </button>
          <button
            className="w-full text-left px-3 py-1 hover:bg-purple-500/15 text-zinc-200 flex items-center justify-between"
            onClick={() => {
              const clip = clips.find((c) => c.id === ctxMenu.clipId);
              if (clip) addClipToTrack({ ...clip, startSec: clip.startSec + clip.durationSec });
              setCtxMenu(null);
            }}
          >
            <span>Duplicate</span>
            <span className="text-zinc-600 text-[8px]">Ctrl+D</span>
          </button>
          {(() => {
            const clip = clips.find((c) => c.id === ctxMenu.clipId);
            if (!clip?.sourcePianoRoll) return null;
            return (
              <button
                className="w-full text-left px-3 py-1 hover:bg-emerald-500/15 text-emerald-200 flex items-center justify-between"
                onClick={() => {
                  usePianoRollStore.getState().loadFromClip(
                    clip.id,
                    clip.sourcePianoRoll ?? [],
                    clip.sourceBpm ?? 120,
                    clip.sourceTotalSteps ?? 32,
                  );
                  useBottomPanelStore.getState().showTab('piano-roll');
                  setCtxMenu(null);
                  logInfo('editor', `Editing clip ${clip.id.slice(0, 8)} in Piano Roll (${clip.sourcePianoRoll?.length ?? 0} notes)`);
                }}
              >
                <span className="flex items-center gap-1.5"><Piano className="w-3 h-3" /> Edit in Piano Roll</span>
                <span className="text-zinc-600 text-[8px]">{clip.sourcePianoRoll.length} notes</span>
              </button>
            );
          })()}
          <div className="my-0.5 border-t border-white/5" />
          <button
            className="w-full text-left px-3 py-1 hover:bg-red-500/20 text-red-300 flex items-center justify-between"
            onClick={() => { removeClip(ctxMenu.clipId); setCtxMenu(null); }}
          >
            <span>Delete</span>
            <span className="text-zinc-600 text-[8px]">Del</span>
          </button>
        </div>
      )}
    </div>
  );
};
