import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Scissors, Play, Pause, Square, ZoomIn, ZoomOut,
  Magnet, Trash2, Move, Plus, Volume2, Upload, Save, Piano, Paintbrush, X,
} from 'lucide-react';
import { useEditorStore, computePeaks, type AudioClip, type SnapDivision } from '../../state/editorStore';
import { useLibraryStore } from '../../state/libraryStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx, getMasterGain, usePlayerStore } from '../../state/playerStore';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import { logError, logInfo } from '../../state/logStore';
import { registerEditorPlayback, unregisterEditorPlayback } from '../../state/editorPlaybackBridge';

const TRACK_HEADER_PX = 180;
const TRACK_HEIGHT = 88;
const DECODE_TIMEOUT_MS = 15000;

const formatTimecode = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.floor(sec * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${Math.floor(ms / 10).toString().padStart(2, '0')}`;
};

const isEditorTimelinePlaying = (): boolean => {
  const player = usePlayerStore.getState();
  return player.isPlaying && player.currentEntryId === 'editor-timeline';
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

/**
 * Decode an audio Blob, extract the portion [offsetSec, offsetSec+durationSec],
 * and return it as a fresh WAV Blob. Used so inpaint submissions always receive
 * exactly the visible clip region, with mask coords relative to its start.
 */
const cropAudioBlob = async (
  blob: Blob,
  offsetSec: number,
  durationSec: number,
): Promise<Blob> => {
  const arrayBuf = await blob.arrayBuffer();
  const tmpCtx = new AudioContext({ sampleRate: 44100 });
  try {
    const audioBuf = await tmpCtx.decodeAudioData(arrayBuf.slice(0));
    const safeOffset = Math.max(0, Math.min(offsetSec, audioBuf.duration - 0.001));
    const safeDur = Math.max(0.001, Math.min(durationSec, audioBuf.duration - safeOffset));
    const sr = 44100;
    const offline = new OfflineAudioContext(
      audioBuf.numberOfChannels,
      Math.ceil(safeDur * sr),
      sr,
    );
    const src = offline.createBufferSource();
    src.buffer = audioBuf;
    src.connect(offline.destination);
    src.start(0, safeOffset, safeDur);
    const rendered = await offline.startRendering();
    return encodeWav(rendered);
  } finally {
    tmpCtx.close().catch(() => {});
  }
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

export const WaveformEditor: React.FC<{ onSwitchTab?: (tab: string) => void }> = () => {
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
  const inpaintSelection = useEditorStore((s) => s.inpaintSelection);
  const setInpaintSelection = useEditorStore((s) => s.setInpaintSelection);
  const clearInpaintSelection = useEditorStore((s) => s.clearInpaintSelection);
  // Footer player — editor audio is loaded here so all footer controls work natively.
  const playerCurrentTime = usePlayerStore((s) => s.currentTime);
  const playerEntryId = usePlayerStore((s) => s.currentEntryId);
  const playerIsPlaying = usePlayerStore((s) => s.isPlaying);
  // Derived: are we currently playing the editor's rendered timeline?
  const isEditorPlaying = playerIsPlaying && playerEntryId === 'editor-timeline';

  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const opRef = useRef<PointerOp | null>(null);
  const inpaintDragRef = useRef<{ clipId: string; anchorSec: number } | null>(null);
  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Playhead drag
  const playheadDragRef = useRef<{ startX: number; startSec: number; wasPlaying: boolean } | null>(null);
  // Fade handle drag
  const fadeDragRef = useRef<{ clipId: string; edge: 'in' | 'out'; startX: number; initialFade: number } | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [mixdownName, setMixdownName] = useState('');

  // --- Inpaint panel state ---
  type InpaintPhase =
    | { kind: 'params' }
    | { kind: 'generating'; jobId: string }
    | { kind: 'review'; blob: Blob; blobUrl: string };
  const [inpaintPanel, setInpaintPanel] = useState<InpaintPhase | null>(null);
  const [inpaintPrompt, setInpaintPrompt] = useState('');
  const [inpaintSteps, setInpaintSteps] = useState(8);
  const [inpaintSeed, setInpaintSeed] = useState(-1);

  // Revoke the object URL when the review phase ends or the panel closes.
  useEffect(() => {
    return () => {
      if (inpaintPanel?.kind === 'review') URL.revokeObjectURL(inpaintPanel.blobUrl);
    };
  }, [inpaintPanel]);

  // Drive polling reactively: starts when phase is 'generating', stops on cleanup.
  useEffect(() => {
    if (inpaintPanel?.kind !== 'generating') return;
    const { jobId } = inpaintPanel;
    const intervalId = setInterval(() => {
      void (async () => {
        try {
          const r = await fetch(`/api/jobs/${jobId}`);
          const job = await r.json() as { status: string; result?: { item?: { audio_base64: string; mime_type: string } }; error?: string };
          if (job.status === 'completed' && job.result?.item) {
            const { audio_base64, mime_type } = job.result.item;
            const bytes = atob(audio_base64);
            const arr = new Uint8Array(bytes.length);
            for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
            const blob = new Blob([arr], { type: mime_type });
            setInpaintPanel({ kind: 'review', blob, blobUrl: URL.createObjectURL(blob) });
          } else if (job.status === 'failed') {
            logError('editor', `Inpaint job failed: ${job.error ?? 'unknown'}`);
            setInpaintPanel({ kind: 'params' });
          }
        } catch (e) {
          logError('editor', `Inpaint poll error: ${e instanceof Error ? e.message : e}`);
        }
      })();
    }, 1500);
    return () => clearInterval(intervalId);
  }, [inpaintPanel]);

  const openInpaintPanel = useCallback(() => {
    const sel = useEditorStore.getState().inpaintSelection;
    if (!sel) return;
    setInpaintPanel({ kind: 'params' });
  }, []);

  const submitInpaint = async () => {
    const sel = useEditorStore.getState().inpaintSelection;
    if (!sel) return;
    const clip = useEditorStore.getState().clips.find((c) => c.id === sel.clipId);
    if (!clip) return;

    // Always crop the audio to exactly the visible clip region before sending.
    // This guarantees mask coordinates are relative to the start of the audio
    // the model receives, regardless of offsetIntoSource (split/trim clips).
    let croppedAudio: Blob;
    try {
      croppedAudio = await cropAudioBlob(clip.audioBlob, clip.offsetIntoSource, clip.durationSec);
    } catch (e) {
      logError('editor', `Inpaint: failed to crop audio: ${e instanceof Error ? e.message : e}`);
      return;
    }

    // Mask coords are now relative to the start of the cropped (visible) audio.
    const maskStart = sel.startSec - clip.startSec;
    const maskEnd   = sel.endSec   - clip.startSec;

    const fd = new FormData();
    fd.append('prompt', inpaintPrompt);
    fd.append('steps', String(inpaintSteps));
    fd.append('seed', String(inpaintSeed));
    fd.append('cfg_scale', '1.0');
    fd.append('duration', String(clip.durationSec));
    fd.append('mask_start', String(Math.max(0, maskStart)));
    fd.append('mask_end', String(Math.min(clip.durationSec, maskEnd)));
    fd.append('inpaint_audio', new File([croppedAudio], 'inpaint.wav', { type: 'audio/wav' }));
    try {
      const res = await fetch('/api/generate-jobs', { method: 'POST', body: fd });
      if (!res.ok) {
        logError('editor', `Inpaint submit HTTP ${res.status}`);
        return;
      }
      const data = await res.json() as { job?: { id: string } };
      const jobId = data.job?.id;
      if (!jobId) {
        logError('editor', 'Inpaint submit: no job id in response');
        return;
      }
      setInpaintPanel({ kind: 'generating', jobId });
    } catch (e) {
      logError('editor', `Inpaint submit failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const acceptInpaint = (blob: Blob) => {
    const sel = useEditorStore.getState().inpaintSelection;
    if (!sel) return;
    updateClip(sel.clipId, { audioBlob: blob, mimeType: 'audio/wav', peaks: undefined });
    clearInpaintSelection();
    setInpaintPanel(null);
  };

  const rejectInpaint = () => setInpaintPanel(null);

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

  // --- Multi-track timeline playback (routes through the footer's playerStore) ---

  const stopEditorPlayback = useCallback(() => {
    usePlayerStore.getState().stop();
    setPlayhead(0);
    stopPreview();
  }, [setPlayhead, stopPreview]);

  const playEditorTimeline = useCallback(async () => {
    if (clips.length === 0) return;
    stopPreview();
    setIsRendering(true);
    try {
      const edState = useEditorStore.getState();
      const totalDur = edState.getTotalDurationSec();
      const startHead = edState.playheadSec >= totalDur - 0.05 ? 0 : edState.playheadSec;
      if (startHead !== edState.playheadSec) edState.setPlayhead(0);

      const sr = 44100;
      const offline = new OfflineAudioContext(2, Math.ceil(totalDur * sr), sr);
      const anySolo = tracks.some((t) => t.solo);
      const blobCache = new Map<Blob, AudioBuffer>();

      // Decode with a regular AudioContext — more reliable than OfflineAudioContext.decodeAudioData.
      const decodeCtx = new AudioContext({ sampleRate: 44100 });
      try {
        for (const clip of clips) {
          const track = tracks.find((t) => t.id === clip.trackId);
          if (!track || track.mute || (anySolo && !track.solo)) continue;
          if (!blobCache.has(clip.audioBlob)) {
            const ab = await clip.audioBlob.arrayBuffer();
            const decoded = await Promise.race([
              decodeCtx.decodeAudioData(ab.slice(0)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('decodeAudioData timeout')), DECODE_TIMEOUT_MS),
              ),
            ]);
            blobCache.set(clip.audioBlob, decoded);
          }
        }
      } finally {
        decodeCtx.close().catch(() => {});
      }

      for (const clip of clips) {
        const track = tracks.find((t) => t.id === clip.trackId);
        if (!track || track.mute || (anySolo && !track.solo)) continue;
        const buf = blobCache.get(clip.audioBlob);
        if (!buf) continue;
        const src = offline.createBufferSource();
        src.buffer = buf;
        const gainNode = offline.createGain();
        const panner = offline.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, track.pan));
        src.connect(gainNode).connect(panner).connect(offline.destination);
        const vol = track.volume;
        const fadeIn = clip.fadeInSec ?? 0;
        const fadeOut = clip.fadeOutSec ?? 0;
        const safeOffset = Math.min(clip.offsetIntoSource, Math.max(0, buf.duration - 0.01));
        const safeDur = Math.min(clip.durationSec, buf.duration - safeOffset);
        if (safeDur <= 0) continue;
        gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : vol, clip.startSec);
        if (fadeIn > 0) gainNode.gain.linearRampToValueAtTime(vol, clip.startSec + Math.min(fadeIn, safeDur));
        if (fadeOut > 0) {
          const foStart = clip.startSec + safeDur - Math.min(fadeOut, safeDur);
          gainNode.gain.setValueAtTime(vol, foStart);
          gainNode.gain.linearRampToValueAtTime(0, clip.startSec + safeDur);
        }
        src.start(clip.startSec, safeOffset, safeDur);
      }

      const rendered = await offline.startRendering();
      const wavBlob = encodeWav(rendered);

      const ps = usePlayerStore.getState();
      await ps.load(wavBlob, { label: 'Editor Timeline', entryId: 'editor-timeline' });
      ps.seek(startHead);
      ps.play();
    } catch (e) {
      logError('editor', `Timeline render failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsRendering(false);
    }
  }, [clips, tracks, stopPreview]);

  // Register with bridge so PlayerFooter can trigger a fresh render+play.
  useEffect(() => {
    registerEditorPlayback(
      () => void playEditorTimeline(),
      stopEditorPlayback,
    );
    return () => unregisterEditorPlayback();
  }, [playEditorTimeline, stopEditorPlayback]);

  // Keep the editor playhead in sync with the footer player when our audio is loaded.
  useEffect(() => {
    if (playerEntryId === 'editor-timeline') {
      setPlayhead(playerCurrentTime);
    }
  }, [playerCurrentTime, playerEntryId, setPlayhead]);

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
          e.preventDefault();
          if (isEditorTimelinePlaying()) stopEditorPlayback();
          else void playEditorTimeline();
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selectedClipId) {
            e.preventDefault();
            removeClip(selectedClipId);
          }
          return;
        }
        if (e.key === 'Escape') {
          clearInpaintSelection();
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
      // Ctrl/Cmd + P = inpaint selected region.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        openInpaintPanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClipId, clips, setTool, stopEditorPlayback, playEditorTimeline, removeClip, addClipToTrack, openInpaintPanel, clearInpaintSelection]);

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
      // Decode with a regular AudioContext — more reliable than OfflineAudioContext.decodeAudioData.
      const blobCache = new Map<Blob, AudioBuffer>();
      const decodeCtx = new AudioContext({ sampleRate: 44100 });
      try {
        for (const c of clips) {
          if (!blobCache.has(c.audioBlob)) {
            const ab = await c.audioBlob.arrayBuffer();
            const decoded = await Promise.race([
              decodeCtx.decodeAudioData(ab.slice(0)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('decodeAudioData timeout')), DECODE_TIMEOUT_MS),
              ),
            ]);
            blobCache.set(c.audioBlob, decoded);
          }
        }
      } finally {
        decodeCtx.close().catch(() => {});
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
        const panner = offline.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, track.pan));
        src.connect(gain).connect(panner).connect(offline.destination);

        const vol = track.volume;
        const fadeIn = c.fadeInSec ?? 0;
        const fadeOut = c.fadeOutSec ?? 0;
        const safeOffset = Math.min(c.offsetIntoSource, Math.max(0, buf.duration - 0.01));
        const safeDur = Math.min(c.durationSec, buf.duration - safeOffset);
        if (safeDur <= 0) continue;

        gain.gain.setValueAtTime(fadeIn > 0 ? 0 : vol, c.startSec);
        if (fadeIn > 0) {
          gain.gain.linearRampToValueAtTime(vol, c.startSec + Math.min(fadeIn, safeDur));
        }
        if (fadeOut > 0) {
          const foStart = c.startSec + safeDur - Math.min(fadeOut, safeDur);
          gain.gain.setValueAtTime(vol, foStart);
          gain.gain.linearRampToValueAtTime(0, c.startSec + safeDur);
        }

        src.start(c.startSec, safeOffset, safeDur);
      }
      const rendered = await offline.startRendering();
      const wavBlob = encodeWav(rendered);
      const stamp = new Date().toISOString();
      const id = `mix-${Date.now()}`;
      const trimmedName = mixdownName.trim();
      const title = trimmedName
        ? (trimmedName.endsWith('.wav') ? trimmedName : `${trimmedName}.wav`)
        : `mixdown_${id.slice(-6)}.wav`;
      await useLibraryStore.getState().addEntry({
        id,
        title,
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
      // Also trigger an immediate browser download so the file lands on disk.
      const dlUrl = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = dlUrl;
      a.download = title;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(dlUrl), 10000);

      const ms = (performance.now() - start).toFixed(0);
      logInfo('editor', `Mixdown complete: ${rendered.duration.toFixed(2)}s rendered in ${ms}ms → library + download`);
    } catch (e) {
      logError('editor', `Mixdown failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsCommitting(false);
    }
  }, [clips, tracks, getTotalDurationSec, mixdownName]);

  // --- Pointer math helpers. ---
  const pxToSec = useCallback((px: number) => px / zoom, [zoom]);
  const timelineClientXToSec = useCallback((clientX: number): number => {
    const scroller = timelineScrollRef.current;
    const timeline = timelineRef.current;
    const rect = (scroller ?? timeline)?.getBoundingClientRect();
    if (!rect) return 0;
    return pxToSec(clientX - rect.left + (scroller?.scrollLeft ?? 0));
  }, [pxToSec]);

  // --- Inpaint drag handlers ---
  const handleInpaintDragStart = (e: React.PointerEvent, clip: AudioClip) => {
    if (tool === 'cut') return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const anchorSec = timelineClientXToSec(e.clientX);
    inpaintDragRef.current = { clipId: clip.id, anchorSec };
  };

  const handleInpaintDragMove = (e: React.PointerEvent) => {
    if (!inpaintDragRef.current) return;
    const { clipId, anchorSec } = inpaintDragRef.current;
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    const curSec = timelineClientXToSec(e.clientX);
    const clampedStart = Math.max(clip.startSec, Math.min(anchorSec, curSec));
    const clampedEnd   = Math.min(clip.startSec + clip.durationSec, Math.max(anchorSec, curSec));
    if (clampedEnd - clampedStart >= 0.1) {
      setInpaintSelection({ clipId, startSec: clampedStart, endSec: clampedEnd });
    }
  };

  const handleInpaintDragEnd = () => {
    const sel = useEditorStore.getState().inpaintSelection;
    if (sel && sel.endSec - sel.startSec < 0.1) {
      clearInpaintSelection();
    }
    inpaintDragRef.current = null;
  };

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

  // --- Fade handle drag ---
  const onFadePointerDown = (e: React.PointerEvent, clipId: string, edge: 'in' | 'out') => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const clip = clips.find((c) => c.id === clipId);
    if (!clip) return;
    fadeDragRef.current = {
      clipId,
      edge,
      startX: e.clientX,
      initialFade: edge === 'in' ? (clip.fadeInSec ?? 0) : (clip.fadeOutSec ?? 0),
    };
  };

  const onFadePointerMove = (e: React.PointerEvent) => {
    const fd = fadeDragRef.current;
    if (!fd) return;
    const clip = clips.find((c) => c.id === fd.clipId);
    if (!clip) return;
    const dxPx = e.clientX - fd.startX;
    const dxSec = fd.edge === 'in' ? pxToSec(dxPx) : pxToSec(-dxPx);
    const maxFade = clip.durationSec / 2;
    const newFade = Math.max(0, Math.min(maxFade, fd.initialFade + dxSec));
    updateClip(fd.clipId, fd.edge === 'in' ? { fadeInSec: newFade } : { fadeOutSec: newFade });
  };

  const onFadePointerUp = (e: React.PointerEvent) => {
    if (!fadeDragRef.current) return;
    fadeDragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  };

  // --- Playhead drag (initiated from the ruler OR the drag handle on the line) ---
  const secFromClientX = useCallback((clientX: number): number => {
    return Math.max(0, timelineClientXToSec(clientX));
  }, [timelineClientXToSec]);

  const onPlayheadPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const wasPlaying = isEditorTimelinePlaying();
    if (wasPlaying) stopEditorPlayback();
    const sec = secFromClientX(e.clientX);
    setPlayhead(sec);
    playheadDragRef.current = { startX: e.clientX, startSec: sec, wasPlaying };
  };

  const seekEditorTo = useCallback((sec: number) => {
    setPlayhead(sec);
    if (usePlayerStore.getState().currentEntryId === 'editor-timeline') {
      usePlayerStore.getState().seek(sec);
    }
  }, [setPlayhead]);

  const onPlayheadPointerMove = (e: React.PointerEvent) => {
    if (!playheadDragRef.current) return;
    seekEditorTo(secFromClientX(e.clientX));
  };

  const onPlayheadPointerUp = (e: React.PointerEvent) => {
    if (!playheadDragRef.current) return;
    const { wasPlaying } = playheadDragRef.current;
    playheadDragRef.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    // Resume footer player if it was playing; it already has the audio loaded.
    if (wasPlaying && usePlayerStore.getState().currentEntryId === 'editor-timeline') {
      usePlayerStore.getState().play();
    }
  };

  // Ruler click sets playhead immediately (same coord math as track lanes).
  const onRulerMouseDown = (e: React.MouseEvent) => {
    seekEditorTo(secFromClientX(e.clientX));
  };

  const onTimelineClick = (e: React.MouseEvent) => {
    if (!timelineRef.current) return;
    if (opRef.current) return;
    // Only react to direct clicks on the timeline gutter (not on a clip).
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip="1"]')) return;
    if (target.closest('[data-playhead-handle="1"]')) return;
    clearInpaintSelection();
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
      <div className="flex items-center justify-between p-2 border-b border-white/5 bg-black/20 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => addTrack()}
            className="btn-primary flex items-center gap-1.5 bg-purple-600/20! border-purple-500/30! text-purple-300! px-2! py-0.5! text-[9px]"
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

          <button
            onClick={openInpaintPanel}
            disabled={!inpaintSelection}
            className={`p-1 px-2 rounded border transition-colors disabled:opacity-30 disabled:pointer-events-none
              ${inpaintSelection ? 'bg-purple-600/20 border-purple-500/40 text-purple-300 hover:bg-purple-600/30' : 'border-white/5 text-zinc-500'}`}
            title="Inpaint selected region (Ctrl+P)"
          >
            <Paintbrush className="w-3 h-3" />
          </button>

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
            onClick={() => isEditorPlaying ? stopEditorPlayback() : void playEditorTimeline()}
            disabled={clips.length === 0 || isRendering}
            className={`p-1.5 rounded transition-colors disabled:opacity-30 ${isEditorPlaying ? 'bg-purple-500/30 text-purple-200 hover:bg-purple-500/20' : 'hover:bg-purple-500/20 text-purple-300'}`}
            title={isRendering ? 'Rendering…' : isEditorPlaying ? 'Stop (Space)' : 'Play from playhead (Space)'}
          >
            {isRendering
              ? <div className="w-3.5 h-3.5 border-2 border-purple-400/40 border-t-purple-300 rounded-full animate-spin" />
              : isEditorPlaying
                ? <Pause className="w-3.5 h-3.5 fill-current" />
                : <Play className="w-3.5 h-3.5 fill-current" />}
          </button>
          <button
            onClick={stopEditorPlayback}
            disabled={!isEditorPlaying}
            className="p-1.5 hover:bg-white/10 rounded text-zinc-400 disabled:opacity-30"
            title="Stop and return to start"
          >
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
          <input
            type="text"
            value={mixdownName}
            onChange={(e) => setMixdownName(e.target.value)}
            placeholder="mixdown name…"
            className="bg-black/40 border border-white/10 rounded px-2 py-0.5 text-[9px] font-mono text-zinc-300 placeholder:text-zinc-600 outline-none focus:border-purple-500/50 transition-colors w-28"
            title="Optional filename for the committed mixdown"
          />
          <button
            onClick={() => void commitEdit()}
            disabled={isCommitting || clips.length === 0}
            className="btn-primary py-1! px-2! text-[9px] flex items-center gap-1.5 disabled:opacity-40"
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
        <div className="shrink-0 bg-[#0c0a12] border-r border-[#1a1528] overflow-hidden flex flex-col" style={{ width: TRACK_HEADER_PX }}>
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
                  <div className="flex gap-1 shrink-0">
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
                  <Volume2 className="w-2.5 h-2.5 text-zinc-600 shrink-0" />
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
          {/* Ruler — click or drag to set playhead */}
          <div
            className="h-6 border-b border-white/5 bg-black/30 relative select-none cursor-col-resize"
            style={{ width: timelineWidthPx }}
            onMouseDown={onRulerMouseDown}
          >
            {renderRuler.map((tick) => (
              <div
                key={tick.sec}
                className="absolute top-0 bottom-0 flex items-center px-1 border-l border-white/5 pointer-events-none"
                style={{ left: tick.sec * zoom }}
              >
                <span className={`text-[8px] font-mono ${tick.major ? 'text-zinc-500' : 'text-zinc-700'}`}>
                  {formatTimecode(tick.sec).replace(/\.00$/, '')}
                </span>
              </div>
            ))}
            {/* Playhead in ruler: line + draggable triangle handle */}
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500/60 pointer-events-none z-20"
              style={{ left: playheadSec * zoom }}
            />
            <div
              data-playhead-handle="1"
              className="absolute bottom-0 z-30 cursor-ew-resize"
              style={{ left: playheadSec * zoom - 6, width: 13 }}
              onPointerDown={onPlayheadPointerDown}
              onPointerMove={onPlayheadPointerMove}
              onPointerUp={onPlayheadPointerUp}
            >
              {/* Downward-pointing triangle */}
              <div
                className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-0"
                style={{
                  borderLeft: '5px solid transparent',
                  borderRight: '5px solid transparent',
                  borderTop: '7px solid #ef4444',
                }}
              />
            </div>
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
                  <div className="absolute top-0 left-0 right-0 px-1 h-3.5 bg-black/50 backdrop-blur-sm border-b border-white/10 flex justify-between items-center text-[8px] font-mono uppercase tracking-tighter">
                    <span className="flex items-center gap-1 min-w-0 max-w-[60%]">
                      {clip.sourceKind === 'piano-roll' && (
                        <Piano className="w-2.5 h-2.5 text-emerald-300 shrink-0" />
                      )}
                      <span className="text-white truncate">{clip.label}</span>
                    </span>
                    <span className="text-zinc-300">{clip.durationSec.toFixed(2)}s</span>
                  </div>
                  {/* Waveform peaks */}
                  <div className="absolute inset-x-0 bottom-0 top-3.5 flex items-center gap-[0.5px] px-1">
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
                  {/* Inpaint drag target — covers waveform body below header */}
                  <div
                    className="absolute inset-x-0 bottom-0 z-10 cursor-crosshair"
                    style={{ top: 14 }}
                    onPointerDown={(e) => handleInpaintDragStart(e, clip)}
                    onPointerMove={handleInpaintDragMove}
                    onPointerUp={handleInpaintDragEnd}
                  />
                  {/* Inpaint selection overlay */}
                  {inpaintSelection?.clipId === clip.id && (
                    <div
                      className="absolute top-0 bottom-0 pointer-events-none z-20 border-x border-purple-400"
                      style={{
                        left:  (inpaintSelection.startSec - clip.startSec) * zoom,
                        width: (inpaintSelection.endSec - inpaintSelection.startSec) * zoom,
                        background: 'rgba(168, 85, 247, 0.18)',
                      }}
                    >
                      <span className="absolute top-0.5 left-1 text-[8px] font-mono text-purple-300 pointer-events-none leading-none">
                        {(inpaintSelection.endSec - inpaintSelection.startSec).toFixed(2)}s
                      </span>
                    </div>
                  )}
                  {/* Resize handles — z-20 to stay above inpaint drag target */}
                  <div
                    className="absolute inset-y-0 left-0 w-1.5 hover:bg-white/40 cursor-ew-resize z-20"
                    onPointerDown={(e) => onClipPointerDown(e, clip.id, 'left')}
                  />
                  <div
                    className="absolute inset-y-0 right-0 w-1.5 hover:bg-white/40 cursor-ew-resize z-20"
                    onPointerDown={(e) => onClipPointerDown(e, clip.id, 'right')}
                  />
                  {/* Fade-in overlay */}
                  {(clip.fadeInSec ?? 0) > 0 && (
                    <div
                      className="absolute top-3.5 bottom-0 left-0 pointer-events-none z-15"
                      style={{
                        width: (clip.fadeInSec ?? 0) * zoom,
                        background: `linear-gradient(to right, rgba(0,0,0,0.65) 0%, transparent 100%)`,
                      }}
                    />
                  )}
                  {/* Fade-out overlay */}
                  {(clip.fadeOutSec ?? 0) > 0 && (
                    <div
                      className="absolute top-3.5 bottom-0 right-0 pointer-events-none z-15"
                      style={{
                        width: (clip.fadeOutSec ?? 0) * zoom,
                        background: `linear-gradient(to left, rgba(0,0,0,0.65) 0%, transparent 100%)`,
                      }}
                    />
                  )}
                  {/* Fade-in handle — draggable fence post */}
                  <div
                    className="absolute bottom-0 top-3.5 w-2 cursor-ew-resize z-25 group/fh flex items-center justify-center"
                    style={{ left: Math.max(2, (clip.fadeInSec ?? 0) * zoom - 4) }}
                    title="Fade in — drag right"
                    onPointerDown={(e) => onFadePointerDown(e, clip.id, 'in')}
                    onPointerMove={onFadePointerMove}
                    onPointerUp={onFadePointerUp}
                  >
                    <div className="w-px h-full bg-white/20 group-hover/fh:bg-white/60 transition-colors" />
                    <div className="absolute bottom-2 w-2 h-2 rounded-full bg-white/30 group-hover/fh:bg-white/70 transition-colors border border-white/40" />
                  </div>
                  {/* Fade-out handle — draggable fence post */}
                  <div
                    className="absolute bottom-0 top-3.5 w-2 cursor-ew-resize z-25 group/fh flex items-center justify-center"
                    style={{ right: Math.max(4, (clip.fadeOutSec ?? 0) * zoom - 4) }}
                    title="Fade out — drag left"
                    onPointerDown={(e) => onFadePointerDown(e, clip.id, 'out')}
                    onPointerMove={onFadePointerMove}
                    onPointerUp={onFadePointerUp}
                  >
                    <div className="w-px h-full bg-white/20 group-hover/fh:bg-white/60 transition-colors" />
                    <div className="absolute bottom-2 w-2 h-2 rounded-full bg-white/30 group-hover/fh:bg-white/70 transition-colors border border-white/40" />
                  </div>
                </div>
              );
            })}

            {/* Playhead line in track lanes */}
            <div
              className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)] z-30 pointer-events-none"
              style={{ left: playheadSec * zoom }}
            />

            {/* Drop-here-for-new-track strip — directly below the last lane */}
            <div
              className="absolute left-0 right-0 border-t border-dashed border-purple-500/30 bg-purple-500/4 flex items-center justify-center text-[9px] font-mono uppercase tracking-widest text-purple-400/60 pointer-events-none"
              style={{ top: tracks.length * TRACK_HEIGHT, height: 34 }}
            >
              Drop here to create a new track
            </div>
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="h-6 border-t border-white/5 bg-black/60 flex items-center justify-between px-3 shrink-0">
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
          className="fixed z-200 min-w-40 bg-[#0a080f] border border-purple-500/40 rounded shadow-[0_8px_24px_rgba(0,0,0,0.6)] py-1 text-[10px] font-mono"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {inpaintSelection?.clipId === ctxMenu.clipId && (
            <>
              <button
                className="w-full text-left px-3 py-1 hover:bg-purple-500/15 text-purple-300 flex items-center justify-between"
                onClick={() => { setCtxMenu(null); openInpaintPanel(); }}
              >
                <span className="flex items-center gap-1.5"><Paintbrush className="w-3 h-3" /> Inpaint Region</span>
                <span className="text-zinc-600 text-[8px]">Ctrl+P</span>
              </button>
              <div className="my-0.5 border-t border-white/5" />
            </>
          )}
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

      {/* Floating inpaint panel */}
      {inpaintPanel && (
        <div
          className="fixed right-4 z-150 w-72 bg-[#0a080f] border border-purple-500/40 rounded-lg shadow-[0_8px_32px_rgba(0,0,0,0.75)] p-3 flex flex-col gap-2.5"
          style={{ top: (containerRef.current?.getBoundingClientRect().top ?? 140) + 52 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 flex items-center gap-1.5">
              <Paintbrush className="w-3 h-3" /> Inpaint Region
            </span>
            <button onClick={rejectInpaint} className="p-1 hover:bg-white/10 rounded text-zinc-500 hover:text-white transition-colors">
              <X className="w-3 h-3" />
            </button>
          </div>

          {/* Phase: params */}
          {inpaintPanel.kind === 'params' && (
            <>
              <textarea
                placeholder="Describe what to generate in this region…"
                value={inpaintPrompt}
                onChange={(e) => setInpaintPrompt(e.target.value)}
                className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 placeholder:text-zinc-600 resize-none outline-none focus:border-purple-500/50 transition-colors"
                rows={3}
                autoFocus
              />
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-mono text-zinc-500">Steps</span>
                  <span className="text-[9px] font-mono text-zinc-400">{inpaintSteps}</span>
                </div>
                <input
                  type="range" min={4} max={20} step={1} value={inpaintSteps}
                  onChange={(e) => setInpaintSteps(parseInt(e.target.value))}
                  className="pro-slider"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-zinc-500 shrink-0">Seed</span>
                <input
                  type="number" value={inpaintSeed}
                  onChange={(e) => setInpaintSeed(parseInt(e.target.value) || -1)}
                  className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-0.5 text-[9px] font-mono text-zinc-200 outline-none focus:border-purple-500/50 transition-colors"
                  placeholder="-1 (random)"
                />
              </div>
              <button
                onClick={() => void submitInpaint()}
                disabled={!inpaintPrompt.trim()}
                className="w-full py-1.5 rounded bg-purple-600/30 border border-purple-500/40 text-purple-200 text-[9px] font-black uppercase tracking-widest hover:bg-purple-600/50 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              >
                Generate
              </button>
            </>
          )}

          {/* Phase: generating */}
          {inpaintPanel.kind === 'generating' && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="w-5 h-5 border-2 border-purple-500/40 border-t-purple-400 rounded-full animate-spin" />
              <span className="text-[9px] font-mono text-zinc-500 uppercase tracking-widest">Generating…</span>
              <button onClick={rejectInpaint} className="text-[9px] font-mono text-zinc-600 hover:text-zinc-400 transition-colors">
                cancel
              </button>
            </div>
          )}

          {/* Phase: review */}
          {inpaintPanel.kind === 'review' && (
            <>
              <audio controls src={inpaintPanel.blobUrl} className="w-full h-8 mt-1" />
              <div className="flex gap-2">
                <button
                  onClick={() => acceptInpaint(inpaintPanel.blob)}
                  className="flex-1 py-1.5 rounded bg-emerald-600/30 border border-emerald-500/40 text-emerald-200 text-[9px] font-black uppercase tracking-widest hover:bg-emerald-600/50 transition-colors"
                >
                  Accept
                </button>
                <button
                  onClick={rejectInpaint}
                  className="flex-1 py-1.5 rounded bg-red-600/20 border border-red-500/30 text-red-300 text-[9px] font-black uppercase tracking-widest hover:bg-red-600/40 transition-colors"
                >
                  Reject
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
