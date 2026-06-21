import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Scissors, Play, Pause, Square, ZoomIn, ZoomOut,
  Magnet, Trash2, Move, Plus, Volume2, Upload, Save, Piano, Paintbrush, X, Wand2, Layers,
  SlidersHorizontal,
} from 'lucide-react';
import { addBlobsToChimera } from '../../lib/chimeraClient';
import { SlideTrack } from './SlideTrack';
import { FxRack } from './FxRack';
import { MetamorphPanel } from './MetamorphPanel';
import { RACK_EFFECTS, buildEffectChain, ensureChopModule, teleportXYZ, SPATIAL_TELEPORT, type ChainHandle } from '../../lib/rackEffects';
import { sliceChunks } from '../../lib/audioAnalysis';
import { encodeWav } from '../../lib/wavEncode';
import type { AudioDragItem } from '../../lib/audioDnD';
import { useExternalDragStore } from '../../state/externalDragStore';
import { useEditorStore, computePeaks, type AudioClip, type EditorTrack, type SnapDivision } from '../../state/editorStore';
import { useLibraryStore } from '../../state/libraryStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx, getMasterGain, usePlayerStore } from '../../state/playerStore';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { GM_NAMES, gmShortName } from '../../lib/gmInstruments';
import { useSoundfontStore, ensureSoundfontReady, isSoundfontActive, getActiveProgram } from '../../lib/soundfontEngine';
import { renderStepNotesToBlob } from '../../lib/midiSynth';
import { parseMidi } from '../../utils/midi';
import type { PianoNote } from '../../state/pianoRollStore';
import { LibraryMidiPicker } from './LibraryMidiPicker';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import { useGenerateParamsStore } from '../../state/generateParamsStore';
import { logError, logInfo } from '../../state/logStore';
import { registerEditorPlayback, unregisterEditorPlayback } from '../../state/editorPlaybackBridge';
import * as liveMixer from '../../state/liveMixer';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../ui/ContextMenu';

const TRACK_HEADER_PX = 180;
const TRACK_HEIGHT = 104;
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

/**
 * Tiny silent WAV placeholder used when creating large MIDI clips. The real
 * bounced audio is rendered asynchronously after the editable MIDI clip appears,
 * so users are not stuck waiting on an OfflineAudioContext + peak extraction.
 */
const silentWavBlob = (): Blob => {
  const sampleRate = 44100;
  const channels = 1;
  const samples = Math.ceil(sampleRate * 0.1);
  const bytesPerSample = 2;
  const dataBytes = samples * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
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

/**
 * Draw a MIDI clip's notes inside the clip body (FL-style playlist preview).
 * X maps note time (relative to the clip's source offset) to pixels via `zoom`;
 * Y stacks pitches lowest-to-highest across the body. Velocity sets brightness.
 * Read-only — editing happens in the Piano Roll (double-click / context menu).
 */
const MidiClipNotes: React.FC<{ clip: AudioClip; zoom: number; selected: boolean }> = ({ clip, zoom, selected }) => {
  const notes = clip.sourcePianoRoll;
  if (!notes || notes.length === 0) return null;
  const bpm = clip.sourceBpm ?? 120;
  const stepSec = 60 / Math.max(40, bpm) / 4;
  const offset = clip.offsetIntoSource ?? 0;
  const clipDur = clip.durationSec;

  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    if (n.note < lo) lo = n.note;
    if (n.note > hi) hi = n.note;
  }
  if (!Number.isFinite(lo)) return null;
  // One row per semitone in the used range, with a little headroom top/bottom.
  lo -= 1;
  hi += 1;
  const rows = Math.max(1, hi - lo);
  const rowPct = 100 / (rows + 1);

  return (
    <div className="absolute inset-x-0 bottom-0 top-3.5 overflow-hidden pointer-events-none">
      {notes.map((n) => {
        const relStart = n.step * stepSec - offset;
        const relEnd = relStart + Math.max(1, n.length) * stepSec;
        if (relEnd <= 0 || relStart >= clipDur) return null; // outside the visible window
        const vStart = Math.max(0, relStart);
        const vEnd = Math.min(clipDur, relEnd);
        const x = vStart * zoom;
        const w = Math.max(1.5, (vEnd - vStart) * zoom);
        const topPct = (hi - n.note) * rowPct;
        const hPct = Math.max(rowPct - 0.5, 2);
        const vel = Math.max(1, Math.min(127, n.velocity));
        return (
          <div
            key={n.id}
            className="absolute rounded-[1px]"
            style={{
              left: x,
              width: w,
              top: `${topPct}%`,
              height: `${hPct}%`,
              backgroundColor: clip.color,
              opacity: (selected ? 0.6 : 0.42) + (vel / 127) * 0.4,
            }}
          />
        );
      })}
    </div>
  );
};

/**
 * Compact per-track instrument selector (channel-rack style). "Default" leaves
 * the track on the global Piano Roll instrument; picking a GM program assigns it
 * to the track, which makes its MIDI clips play that voice live on the timeline.
 */
const TrackInstrumentSelect: React.FC<{ track: EditorTrack }> = ({ track }) => {
  const updateTrack = useEditorStore((s) => s.updateTrack);
  const globalProgram = useSoundfontStore((s) => s.activeProgram);
  const globalSoundfont = useSoundfontStore((s) => s.useSoundfont);
  const value = track.instrumentProgram === undefined ? 'default' : String(track.instrumentProgram);
  const defaultLabel = globalSoundfont ? `Default (${gmShortName(globalProgram)})` : 'Default (Basic)';

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === 'default') {
      updateTrack(track.id, { instrumentProgram: undefined });
      return;
    }
    updateTrack(track.id, { instrumentProgram: Number(v) });
    void ensureSoundfontReady(); // warm worklet + soundfont while the user looks
  };

  return (
    <div className="flex items-center gap-1.5">
      <Piano className="w-2.5 h-2.5 text-emerald-400/70 shrink-0" />
      <label htmlFor={`editor-track-instrument-${track.id}`} className="sr-only">{`Track ${track.name} instrument`}</label>
      <select
        id={`editor-track-instrument-${track.id}`}
        name={`editor-track-instrument-${track.id}`}
        aria-label={`Track ${track.name} instrument`}
        value={value}
        onChange={onChange}
        className="flex-1 min-w-0 bg-zinc-900 border border-white/20 rounded px-1 py-0.5 text-[9px] text-zinc-100 outline-none focus:border-purple-500/60"
        style={{ colorScheme: 'dark' }}
      >
        <option value="default">{defaultLabel}</option>
        {GM_NAMES.map((nm, i) => (
          <option key={nm} value={i}>{`${i + 1}. ${nm}`}</option>
        ))}
      </select>
    </div>
  );
};

/**
 * Per-clip instrument override. "Track default" leaves the clip on its track's
 * instrument (or the global one); picking a GM program assigns it to this clip
 * only, so its MIDI notes play that voice live regardless of the track default.
 */
const ClipInstrumentSelect: React.FC<{ clip: AudioClip }> = ({ clip }) => {
  const updateClip = useEditorStore((s) => s.updateClip);
  const track = useEditorStore((s) => s.tracks.find((t) => t.id === clip.trackId));
  const globalProgram = useSoundfontStore((s) => s.activeProgram);
  const globalSoundfont = useSoundfontStore((s) => s.useSoundfont);
  const value = clip.instrumentProgram === undefined ? 'default' : String(clip.instrumentProgram);
  const effective = track?.instrumentProgram ?? (globalSoundfont ? globalProgram : undefined);
  const defaultLabel = effective === undefined ? 'Track default (Basic)' : `Track default (${gmShortName(effective)})`;

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === 'default') {
      updateClip(clip.id, { instrumentProgram: undefined });
      return;
    }
    updateClip(clip.id, { instrumentProgram: Number(v) });
    void ensureSoundfontReady(); // warm worklet + soundfont while the user looks
  };

  return (
    <div className="flex items-center gap-1.5">
      <Piano className="w-3 h-3 text-emerald-400/70 shrink-0" />
      <label htmlFor={`editor-clip-instrument-${clip.id}`} className="sr-only">{`Clip ${clip.label} instrument`}</label>
      <select
        id={`editor-clip-instrument-${clip.id}`}
        name={`editor-clip-instrument-${clip.id}`}
        aria-label={`Clip ${clip.label} instrument`}
        value={value}
        onChange={onChange}
        className="flex-1 min-w-0 bg-zinc-900 border border-white/20 rounded px-1.5 py-1 text-[10px] text-zinc-100 outline-none focus:border-purple-500/60"
        style={{ colorScheme: 'dark' }}
      >
        <option value="default">{defaultLabel}</option>
        {GM_NAMES.map((nm, i) => (
          <option key={nm} value={i}>{`${i + 1}. ${nm}`}</option>
        ))}
      </select>
    </div>
  );
};

interface PointerOp {
  kind: 'move' | 'resize-left' | 'resize-right' | 'ctrl-drag-pending';
  clipId: string;
  startPxX: number;
  startPxY: number;
  initialStartSec: number;
  initialDurationSec: number;
  initialOffsetIntoSource: number;
  initialTrackIndex: number;
  initialClips?: Array<{ id: string; startSec: number; trackIndex: number }>;
  dragItems?: AudioDragItem[];
}

const CTRL_DRAG_MOVE_THRESHOLD_PX = 4;

export const WaveformEditor: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
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
  const masterFxChain = useEditorStore((s) => s.masterFxChain);
  const automationWrite = useEditorStore((s) => s.automationWrite);
  const setAutomationWrite = useEditorStore((s) => s.setAutomationWrite);
  const recordAutomationPoint = useEditorStore((s) => s.recordAutomationPoint);
  const automationLanes = useEditorStore((s) => s.automationLanes);

  // Move a track fader. While automation write is on and the transport is rolling,
  // the move records a breakpoint (timestamped off the audio clock) and is driven
  // onto the live param so it is heard as it is recorded.
  const writeFader = (kind: 'trackVolume' | 'trackPan', trackId: string, v: number) => {
    updateTrack(trackId, kind === 'trackVolume' ? { volume: v } : { pan: v });
    if (automationWrite && liveMixer.isPlaying()) {
      const target = { kind, trackId };
      recordAutomationPoint(target, liveMixer.currentTransportSec(), v);
      liveMixer.automationTouchNative(target, v);
    }
  };
  const addMasterEffect = useEditorStore((s) => s.addMasterEffect);
  const removeMasterEffect = useEditorStore((s) => s.removeMasterEffect);
  const reorderMasterEffect = useEditorStore((s) => s.reorderMasterEffect);
  const toggleMasterEffect = useEditorStore((s) => s.toggleMasterEffect);
  const updateMasterEffectParams = useEditorStore((s) => s.updateMasterEffectParams);
  const addTrackEffect = useEditorStore((s) => s.addTrackEffect);
  const removeTrackEffect = useEditorStore((s) => s.removeTrackEffect);
  const reorderTrackEffect = useEditorStore((s) => s.reorderTrackEffect);
  const toggleTrackEffect = useEditorStore((s) => s.toggleTrackEffect);
  const updateTrackEffectParams = useEditorStore((s) => s.updateTrackEffectParams);
  // Footer player — the live engine mirrors its own playhead; we just read
  // entry id + playing state to drive the editor's local transport button.
  const playerEntryId = usePlayerStore((s) => s.currentEntryId);
  const playerIsPlaying = usePlayerStore((s) => s.isPlaying);
  // Derived: are we currently playing the editor's rendered timeline?
  const isEditorPlaying = playerIsPlaying && playerEntryId === 'editor-timeline';

  const containerRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const trackHeaderScrollRef = useRef<HTMLDivElement>(null);
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
  const [showMasterFx, setShowMasterFx] = useState(false);
  const [showMetamorph, setShowMetamorph] = useState(false);
  const [fxPanelTrackId, setFxPanelTrackId] = useState<string | null>(null);
  const [instrPanel, setInstrPanel] = useState<{ clipId: string; x: number; y: number } | null>(null);
  const instrPanelRef = useRef<HTMLDivElement>(null);
  // Outside-click / Escape dismiss the clip-instrument popover. Deferred a
  // macrotask so the context-menu click that opens it does not immediately
  // bubble to window and close it (same race the ContextMenu primitive handles).
  useEffect(() => {
    if (!instrPanel) return;
    const onDown = (e: MouseEvent) => {
      if (instrPanelRef.current?.contains(e.target as Node)) return;
      setInstrPanel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInstrPanel(null);
    };
    let attached = false;
    const attach = () => {
      attached = true;
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onKey);
    };
    const timer = window.setTimeout(attach, 0);
    return () => {
      window.clearTimeout(timer);
      if (attached) {
        window.removeEventListener('mousedown', onDown);
        window.removeEventListener('keydown', onKey);
      }
    };
  }, [instrPanel]);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);

  // --- Inpaint panel state ---
  type InpaintPhase =
    | { kind: 'params' }
    | { kind: 'generating'; jobId: string }
    | { kind: 'review'; blob: Blob; blobUrl: string };
  const [inpaintPanel, setInpaintPanel] = useState<InpaintPhase | null>(null);
  // When set, the LibraryMidiPicker is open; `sec` is the drop time, x/y anchor the panel.
  const [midiDrop, setMidiDrop] = useState<{ sec: number; x: number; y: number } | null>(null);
  const [inpaintPrompt, setInpaintPrompt] = useState('');
  const [inpaintSteps, setInpaintSteps] = useState(8);
  const [inpaintSeed, setInpaintSeed] = useState(-1);

  // Preload the chop worklet on the live engine context so a Chop insert builds
  // its real worklet node the first time playback starts (instead of one silent
  // passthrough play while the module loads).
  useEffect(() => {
    void ensureChopModule(getEngineCtx()).catch(() => {});
  }, []);

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
    
    // Auto-save the accepted inpaint to the library (via the storage provider).
    void useLibraryStore.getState().importEntry({
      blob,
      filename: `inpaint_${inpaintPrompt.slice(0, 15) || 'result'}.wav`,
      mimeType: 'audio/wav',
      metadata: {
        title: `inpaint_${inpaintPrompt.slice(0, 15) || 'result'}.wav`,
        prompt: inpaintPrompt,
        model: 'inpaint',
        duration: sel.endSec - sel.startSec,
        steps: inpaintSteps,
        cfg: 1.0,
        seed: inpaintSeed,
        source: 'generate',
        tags: ['inpaint'],
      },
    }).catch((e) => logError('editor', `Inpaint library save failed: ${e}`));

    clearInpaintSelection();
    setInpaintPanel(null);
  };

  const rejectInpaint = () => setInpaintPanel(null);

  const totalDuration = getTotalDurationSec();
  const timelineWidthPx = Math.max(totalDuration * zoom, 1000);

  const trackById = useMemo(
    () => new Map(tracks.map((t) => [t.id, t] as const)),
    [tracks],
  );
  const selectedClipIdSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);

  const selectedClipCount = selectedClipIds.length || (selectedClipId ? 1 : 0);

  useEffect(() => {
    setSelectedClipIds((prev) => prev.filter((id) => clips.some((clip) => clip.id === id)));
    setSelectedTrackIds((prev) => prev.filter((id) => tracks.some((track) => track.id === id)));
  }, [clips, tracks]);

  const deleteSelectedClips = useCallback(() => {
    const ids = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
    if (ids.length === 0) return;
    ids.forEach((id) => removeClip(id));
    setSelectedClipIds([]);
    setSelectedTrackIds([]);
    setSelected(null);
  }, [removeClip, selectedClipId, selectedClipIds, setSelected]);

  const duplicateSelectedClips = useCallback(() => {
    const ids = selectedClipIds.length > 0 ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
    if (ids.length === 0) return;
    const selected = clips.filter((c) => ids.includes(c.id));
    const newIds = selected.map((clip) => addClipToTrack({
      ...clip,
      startSec: clip.startSec + clip.durationSec,
    }));
    setSelectedClipIds(newIds);
    setSelectedTrackIds([]);
    setSelected(newIds[0] ?? null);
    logInfo('editor', `Duplicated ${newIds.length} clip${newIds.length === 1 ? '' : 's'}`);
  }, [addClipToTrack, clips, selectedClipId, selectedClipIds, setSelected]);

  const selectClipSingle = useCallback((clipId: string | null) => {
    setSelectedClipIds(clipId ? [clipId] : []);
    setSelectedTrackIds([]);
    setSelected(clipId);
  }, [setSelected]);

  const selectTrackSingle = useCallback((trackId: string | null) => {
    setSelectedTrackIds(trackId ? [trackId] : []);
    setSelectedClipIds([]);
    setSelected(null);
  }, [setSelected]);

  const toggleTrackSelection = useCallback((trackId: string) => {
    setSelectedTrackIds((prev) => (
      prev.includes(trackId) ? prev.filter((id) => id !== trackId) : [...prev, trackId]
    ));
    setSelectedClipIds([]);
    setSelected(null);
  }, [setSelected]);

  const selectTrackWithModifiers = useCallback((trackId: string, e?: { metaKey?: boolean; ctrlKey?: boolean }) => {
    if (e?.metaKey || e?.ctrlKey) toggleTrackSelection(trackId);
    else selectTrackSingle(trackId);
  }, [selectTrackSingle, toggleTrackSelection]);

  const selectClipWithModifiers = useCallback((clipId: string, e?: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
    const additive = !!(e?.metaKey || e?.ctrlKey);
    const range = !!e?.shiftKey;

    if (range && selectedClipId) {
      const orderedIds = [...clips].sort((a, b) => a.startSec - b.startSec).map((c) => c.id);
      const a = orderedIds.indexOf(selectedClipId);
      const b = orderedIds.indexOf(clipId);
      if (a >= 0 && b >= 0) {
        const [start, end] = a < b ? [a, b] : [b, a];
        const rangeIds = orderedIds.slice(start, end + 1);
        setSelectedClipIds((prev) => (additive ? Array.from(new Set([...prev, ...rangeIds])) : rangeIds));
        setSelectedTrackIds([]);
        setSelected(clipId);
        return;
      }
    }

    if (additive) {
      setSelectedClipIds((prev) => (
        prev.includes(clipId) ? prev.filter((id) => id !== clipId) : [...prev, clipId]
      ));
      setSelectedTrackIds([]);
      setSelected(clipId);
      return;
    }

    selectClipSingle(clipId);
  }, [clips, selectedClipId, selectClipSingle, setSelected]);

  const getSelectionForInit = useCallback((): AudioClip[] => {
    if (selectedClipIds.length > 0) return clips.filter((c) => selectedClipIds.includes(c.id));
    if (selectedTrackIds.length > 0) return clips.filter((c) => selectedTrackIds.includes(c.trackId));
    if (selectedClipId) {
      const clip = clips.find((c) => c.id === selectedClipId);
      return clip ? [clip] : [];
    }
    return [];
  }, [clips, selectedClipIds, selectedTrackIds, selectedClipId]);

  const sendSelectionToInit = useCallback(async () => {
    const selection = getSelectionForInit();
    if (selection.length === 0) {
      logError('editor', 'Select at least one clip or track first.');
      return;
    }
    setIsRendering(true);
    try {
      const sr = 44100;
      const totalDur = Math.max(...selection.map((c) => c.startSec + c.durationSec), 1);
      const offline = new OfflineAudioContext(2, Math.ceil(totalDur * sr), sr);
      const blobCache = new Map<Blob, AudioBuffer>();
      const decodeCtx = new AudioContext({ sampleRate: 44100 });
      try {
        for (const clip of selection) {
          if (blobCache.has(clip.audioBlob)) continue;
          const ab = await clip.audioBlob.arrayBuffer();
          const decoded = await Promise.race([
            decodeCtx.decodeAudioData(ab.slice(0)),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('decodeAudioData timeout')), DECODE_TIMEOUT_MS)),
          ]);
          blobCache.set(clip.audioBlob, decoded);
        }
      } finally {
        decodeCtx.close().catch(() => {});
      }

      for (const clip of selection) {
        const track = trackById.get(clip.trackId);
        if (!track || track.mute) continue;
        const buf = blobCache.get(clip.audioBlob);
        if (!buf) continue;
        const src = offline.createBufferSource();
        src.buffer = buf;
        const gain = offline.createGain();
        const panner = offline.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, track.pan));
        src.connect(gain).connect(panner).connect(offline.destination);

        const vol = track.volume;
        const fadeIn = clip.fadeInSec ?? 0;
        const fadeOut = clip.fadeOutSec ?? 0;
        const safeOffset = Math.min(clip.offsetIntoSource, Math.max(0, buf.duration - 0.01));
        const safeDur = Math.min(clip.durationSec, buf.duration - safeOffset);
        if (safeDur <= 0) continue;
        gain.gain.setValueAtTime(fadeIn > 0 ? 0 : vol, clip.startSec);
        if (fadeIn > 0) gain.gain.linearRampToValueAtTime(vol, clip.startSec + Math.min(fadeIn, safeDur));
        if (fadeOut > 0) {
          const foStart = clip.startSec + safeDur - Math.min(fadeOut, safeDur);
          gain.gain.setValueAtTime(vol, foStart);
          gain.gain.linearRampToValueAtTime(0, clip.startSec + safeDur);
        }
        src.start(clip.startSec, safeOffset, safeDur);
      }

      const rendered = await offline.startRendering();
      const blob = encodeWav(rendered);
      const clipLabels = selection.map((c) => c.label);
      const mixDur = rendered.duration;
      const fileName = selection.length === 1
        ? `editor-clip-${Date.now()}.wav`
        : `editor-mashup-${selection.length}clips-${Date.now()}.wav`;
      const file = new File([blob], fileName, { type: 'audio/wav' });
      const summary = selection.length === 1
        ? `Editor clip · ${mixDur.toFixed(2)}s`
        : `Editor mashup · ${selection.length} clips · ${mixDur.toFixed(2)}s`;
      useGenerateParamsStore.getState().patch({
        initAudioFile: file,
        initAudioEnabled: true,
        initAudioSourceLabel: summary,
        initAudioSourceClipLabels: clipLabels,
      });
      logInfo('editor', `Selection mashup sent to Init (${selection.length} clip${selection.length === 1 ? '' : 's'}, ${mixDur.toFixed(2)}s).`);
      onSwitchTab?.('create');
    } catch (e) {
      logError('editor', `Send to Init failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsRendering(false);
    }
  }, [getSelectionForInit, onSwitchTab, trackById]);

  const handleTrackHeaderPointerDown = useCallback((e: React.PointerEvent, trackId: string) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, button, select, textarea')) return;
    selectTrackWithModifiers(trackId, e);
  }, [selectTrackWithModifiers]);

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
    liveMixer.stop();
    stopPreview();
  }, [stopPreview]);

  const playEditorTimeline = useCallback(async () => {
    if (clips.length === 0) return;
    stopPreview();
    setIsRendering(true);
    try {
      // Live multi-track playback — per-track volume / pan / mute / solo are
      // audible MID-playback (see state/liveMixer). The offline bounce is kept
      // for export (commitEdit / sendSelectionToInit), not for preview.
      await liveMixer.playAsync();
    } catch (e) {
      logError('editor', `Live playback failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsRendering(false);
    }
  }, [clips.length, stopPreview]);

  // Register with bridge so PlayerFooter can trigger a fresh render+play, AND
  // register liveMixer as the footer's transport so its normal play/pause/seek
  // buttons drive the live multi-track engine. liveMixer.attach() returns a
  // disposer that stops playback + detaches on unmount.
  useEffect(() => {
    registerEditorPlayback(
      () => void playEditorTimeline(),
      stopEditorPlayback,
    );
    const detach = liveMixer.attach();
    return () => {
      unregisterEditorPlayback();
      detach();
    };
  }, [playEditorTimeline, stopEditorPlayback]);

  // liveMixer already mirrors its playhead into editorStore.playheadSec, so no
  // footer→playhead bridging is needed for the live engine. (The offline path
  // for export doesn't drive the playhead.)

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
          if (selectedClipCount > 0) {
            e.preventDefault();
            deleteSelectedClips();
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
        duplicateSelectedClips();
      }
      // Ctrl/Cmd + P = inpaint selected region.
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        openInpaintPanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClipCount, setTool, stopEditorPlayback, playEditorTimeline, deleteSelectedClips, duplicateSelectedClips, openInpaintPanel, clearInpaintSelection]);

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
      // Shift + wheel — convert vertical delta to horizontal scroll. Plain wheel remains vertical.
      if (e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- Right-click context menu (uses shared ContextMenu primitive) ---
  const clipMenu = useContextMenu<{ clipId: string; atSec: number }>();
  const trackMenu = useContextMenu<{ trackId: string }>();

  const openContextMenu = (e: React.MouseEvent, clipId: string) => {
    e.stopPropagation();
    if (!selectedClipIds.includes(clipId)) {
      selectClipSingle(clipId);
    }
    const atSec = timelineClientXToSec(e.clientX);
    clipMenu.open(e, { clipId, atSec });
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
      // If any enabled insert chain uses the chop worklet, register it on the
      // offline context first so the bounce builds the real node (the factory
      // would otherwise fall back to passthrough and the chop would not bake in).
      const usesChop = [masterFxChain, ...tracks.map((t) => t.fxChain ?? [])]
        .some((ch) => ch.some((e) => e.effect === 'chop' && e.enabled));
      if (usesChop) {
        try { await ensureChopModule(offline); } catch { /* falls back to passthrough */ }
      }

      // Master bus + insert rack -> destination, mirroring liveMixer's routing so
      // the bounce carries the SAME psychoacoustic FX the user hears in preview.
      const masterBus = offline.createGain();
      buildEffectChain(offline, masterBus, offline.destination, masterFxChain);

      // One gain + insert chain + panner per audible track; panners feed the bus.
      const trackNodeById = new Map<string, { gain: GainNode; panner: StereoPannerNode; fx: ChainHandle }>();
      for (const track of tracks) {
        if (track.mute) continue;
        if (anySolo && !track.solo) continue;
        const tgain = offline.createGain();
        tgain.gain.value = track.volume;
        const panner = offline.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, track.pan));
        const fx = buildEffectChain(offline, tgain, panner, track.fxChain ?? []); // tgain -> [fx] -> panner
        panner.connect(masterBus);
        trackNodeById.set(track.id, { gain: tgain, panner, fx });
      }

      for (const c of clips) {
        const tn = trackNodeById.get(c.trackId);
        if (!tn) continue; // track muted or hidden by an active solo
        const buf = blobCache.get(c.audioBlob);
        if (!buf) continue;
        const safeOffset = Math.min(c.offsetIntoSource, Math.max(0, buf.duration - 0.01));
        const safeDur = Math.min(c.durationSec, buf.duration - safeOffset);
        if (safeDur <= 0) continue;

        // Per-clip gain carries ONLY the fade envelope (peak 1). Track volume lives
        // on the track gain so per-track FX process the post-fade signal exactly as
        // they do live.
        const src = offline.createBufferSource();
        src.buffer = buf;
        const clipGain = offline.createGain();
        const fadeIn = c.fadeInSec ?? 0;
        const fadeOut = c.fadeOutSec ?? 0;
        clipGain.gain.setValueAtTime(fadeIn > 0 ? 0 : 1, c.startSec);
        if (fadeIn > 0) {
          clipGain.gain.linearRampToValueAtTime(1, c.startSec + Math.min(fadeIn, safeDur));
        }
        if (fadeOut > 0) {
          const foStart = c.startSec + safeDur - Math.min(fadeOut, safeDur);
          clipGain.gain.setValueAtTime(1, foStart);
          clipGain.gain.linearRampToValueAtTime(0, c.startSec + safeDur);
        }
        src.connect(clipGain).connect(tn.gain);
        src.start(c.startSec, safeOffset, safeDur);
      }

      // Spatializer Teleport: schedule the same onset-driven panner jumps the live
      // preview makes, so the bounce matches. The offline ctx renders from t=0, so
      // each event's `when` is simply its timeline time.
      const chunkCache = new Map<Blob, ReturnType<typeof sliceChunks>>();
      for (const track of tracks) {
        const tn = trackNodeById.get(track.id);
        if (!tn) continue;
        const teleEntries = (track.fxChain ?? []).filter(
          (e) => e.enabled && e.effect === 'spatializer' && Math.round(e.params?.motion ?? 0) === SPATIAL_TELEPORT,
        );
        if (teleEntries.length === 0) continue;
        const insts = tn.fx.instances();
        const trackClips = clips.filter((c) => c.trackId === track.id);
        for (const entry of teleEntries) {
          const li = insts.find((x) => x.id === entry.id);
          if (!li?.inst.scheduleTeleport) continue;
          const spread = entry.params?.motionDepth ?? 5;
          const events: { when: number; x: number; y: number; z: number }[] = [];
          let idx = 0;
          for (const c of trackClips) {
            const buf = blobCache.get(c.audioBlob);
            if (!buf) continue;
            const offset = Math.min(c.offsetIntoSource, Math.max(0, buf.duration - 0.01));
            const cdur = Math.min(c.durationSec, buf.duration - offset);
            if (cdur <= 0) continue;
            let chunks = chunkCache.get(c.audioBlob);
            if (!chunks) { chunks = sliceChunks(buf); chunkCache.set(c.audioBlob, chunks); }
            for (const chunk of chunks) {
              if (chunk.tSec < offset || chunk.tSec >= offset + cdur) continue;
              const pos = teleportXYZ(idx, chunk.loudness, chunk.brightness, spread);
              events.push({ when: c.startSec + (chunk.tSec - offset), x: pos.x, y: pos.y, z: pos.z });
              idx += 1;
            }
          }
          if (events.length > 0) {
            events.sort((a, b) => a.when - b.when);
            li.inst.scheduleTeleport(events);
          }
        }
      }

      const rendered = await offline.startRendering();
      const wavBlob = encodeWav(rendered);
      const id = `mix-${Date.now()}`;
      const trimmedName = mixdownName.trim();
      const title = trimmedName
        ? (trimmedName.endsWith('.wav') ? trimmedName : `${trimmedName}.wav`)
        : `mixdown_${id.slice(-6)}.wav`;
      await useLibraryStore.getState().importEntry({
        blob: wavBlob,
        filename: title,
        mimeType: 'audio/wav',
        metadata: {
          title,
          prompt: `Editor mixdown of ${clips.length} clips`,
          model: 'editor-mixdown',
          duration: rendered.duration,
          source: 'studio',
          tags: ['mixdown'],
        },
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
  }, [clips, tracks, getTotalDurationSec, mixdownName, masterFxChain]);

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

    if (edge === 'move' && (e.ctrlKey || e.metaKey)) {
      const ids = selectedClipIds.includes(clipId) ? selectedClipIds : [clipId];
      const dragItems: AudioDragItem[] = ids
        .map((id) => clips.find((c) => c.id === id))
        .filter((c): c is AudioClip => !!c)
        .map((c) => ({
          blob: c.audioBlob,
          mimeType: c.mimeType,
          label: c.label,
        }));
      opRef.current = {
        kind: 'ctrl-drag-pending',
        clipId,
        startPxX: e.clientX,
        startPxY: e.clientY,
        initialStartSec: clip.startSec,
        initialDurationSec: clip.durationSec,
        initialOffsetIntoSource: clip.offsetIntoSource,
        initialTrackIndex: Math.max(0, tracks.findIndex((t) => t.id === clip.trackId)),
        dragItems,
      };
      return;
    }

    if (edge === 'move') {
      selectClipWithModifiers(clipId, e);
    } else if (!selectedClipIds.includes(clipId)) {
      selectClipSingle(clipId);
    }
    const trackIndex = tracks.findIndex((t) => t.id === clip.trackId);
    const moveIds = edge === 'move' && selectedClipIds.includes(clipId) && !(e.ctrlKey || e.metaKey || e.shiftKey)
      ? selectedClipIds
      : [clipId];
    const initialClips = moveIds
      .map((id) => {
        const c = clips.find((item) => item.id === id);
        if (!c) return null;
        return {
          id,
          startSec: c.startSec,
          trackIndex: Math.max(0, tracks.findIndex((t) => t.id === c.trackId)),
        };
      })
      .filter((item): item is { id: string; startSec: number; trackIndex: number } => item !== null);
    opRef.current = {
      kind: edge === 'move' ? 'move' : edge === 'left' ? 'resize-left' : 'resize-right',
      clipId,
      startPxX: e.clientX,
      startPxY: e.clientY,
      initialStartSec: clip.startSec,
      initialDurationSec: clip.durationSec,
      initialOffsetIntoSource: clip.offsetIntoSource,
      initialTrackIndex: trackIndex,
      initialClips,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const op = opRef.current;
    if (!op) return;
    const dxPx = e.clientX - op.startPxX;
    const dySec = e.clientY - op.startPxY;

    if (op.kind === 'ctrl-drag-pending') {
      const dist = Math.hypot(dxPx, dySec);
      if (dist >= CTRL_DRAG_MOVE_THRESHOLD_PX && op.dragItems && op.dragItems.length > 0) {
        useExternalDragStore.getState().begin(op.dragItems);
        opRef.current = null;
      }
      return;
    }

    const dxSec = pxToSec(dxPx);
    const clip = clips.find((c) => c.id === op.clipId);
    if (!clip) return;
    if (op.kind === 'move') {
      // Vertical track shift.
      const trackDelta = Math.round(dySec / TRACK_HEIGHT);
      const moveTargets = op.initialClips?.length ? op.initialClips : [{ id: op.clipId, startSec: op.initialStartSec, trackIndex: op.initialTrackIndex }];
      moveTargets.forEach((target) => {
        const newStart = Math.max(0, snapSec(target.startSec + dxSec));
        const targetIdx = Math.max(0, Math.min(tracks.length - 1, target.trackIndex + trackDelta));
        const newTrackId = tracks[targetIdx].id;
        updateClip(target.id, { startSec: newStart, trackId: newTrackId });
      });
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
    const op = opRef.current;
    if (op?.kind === 'ctrl-drag-pending') {
      selectClipWithModifiers(op.clipId, { ctrlKey: true });
      opRef.current = null;
      return;
    }
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
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      const { peaks, duration } = await computePeaks(blob, 240);
      const clipId = addClipToTrack({
        trackId: targetTrack.id,
        label: entry.title ?? `clip_${entryId.slice(0, 6)}`,
        audioBlob: blob,
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
    if (e.button === 2) return; // right-click is the add-MIDI menu, not a playhead move
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

  /** Bind a MIDI clip to the Piano Roll and reveal it (FL: double-click a clip). */
  const editClipInPianoRoll = useCallback((clip: AudioClip) => {
    if (!clip.sourcePianoRoll) return;
    usePianoRollStore.getState().loadFromClip(
      clip.id,
      clip.sourcePianoRoll,
      clip.sourceBpm ?? 120,
      clip.sourceTotalSteps ?? 32,
    );
    useBottomPanelStore.getState().showTab('piano-roll');
    logInfo('editor', `Editing clip ${clip.id.slice(0, 8)} in Piano Roll (${clip.sourcePianoRoll.length} notes)`);
  }, []);

  const onClipDoubleClick = (clip: AudioClip) => {
    if (clip.sourcePianoRoll) editClipInPianoRoll(clip);
  };

  /** Right-click an empty part of the timeline → open the MIDI picker there. */
  const onLanesContextMenu = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-clip="1"]')) return; // a clip's own menu handles it
    e.preventDefault();
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    setMidiDrop({ sec: Math.max(0, snapSec(pxToSec(e.clientX - rect.left))), x: e.clientX, y: e.clientY });
  };

  /** Turn picked MIDI bytes into a piano-roll clip on a new track at `startSec`,
   *  using the currently selected instrument (live-playable + editable). */
  const addMidiClipFromBytes = useCallback(async (bytes: ArrayBuffer, label: string, startSec: number) => {
    try {
      const data = parseMidi(new Uint8Array(bytes));
      const stepTicks = (data.ppq || 480) / 4;
      const notes: PianoNote[] = [];
      for (const tr of data.tracks) {
        for (const n of tr.notes) {
          notes.push({
            id: `imp-${Math.random().toString(36).slice(2)}-${notes.length}`,
            note: n.note,
            step: Math.round(n.tick / stepTicks),
            length: Math.max(1, Math.round(n.durationTicks / stepTicks)),
            velocity: n.velocity,
          });
        }
      }
      if (notes.length === 0) {
        logError('editor', `No notes in "${label}"`);
        return;
      }
      const bpm = Math.round(data.bpm) || 120;
      const lastStep = notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);
      const totalSteps = Math.max(16, Math.ceil(lastStep / 16) * 16);
      const program = isSoundfontActive() ? getActiveProgram() : undefined;
      const nominalDuration = totalSteps * (60 / Math.max(40, bpm) / 4);
      const blob = silentWavBlob();
      const trackId = addTrack({ name: label, instrumentProgram: program });
      const color = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
      const clipId = addClipToTrack({
        trackId,
        label,
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: nominalDuration,
        offsetIntoSource: 0,
        durationSec: nominalDuration,
        startSec: Math.max(0, startSec),
        color,
        sourceKind: 'piano-roll',
        sourcePianoRoll: notes,
        sourceBpm: bpm,
        sourceTotalSteps: totalSteps,
        instrumentProgram: program,
      });
      logInfo('editor', `Added MIDI "${label}" (${notes.length} notes) at ${startSec.toFixed(2)}s; rendering audio in background…`);
      void (async () => {
        const started = performance.now();
        try {
          const rendered = await renderStepNotesToBlob(notes, bpm, totalSteps);
          const { peaks } = await computePeaks(rendered.blob, 240);
          updateClip(clipId, {
            audioBlob: rendered.blob,
            mimeType: 'audio/wav',
            sourceDuration: rendered.duration,
            durationSec: rendered.duration,
          });
          cachePeaks(clipId, peaks);
          logInfo('editor', `MIDI audio ready for "${label}" in ${(performance.now() - started).toFixed(0)}ms`);
        } catch (renderErr) {
          logError('editor', `MIDI audio render failed for "${label}": ${renderErr instanceof Error ? renderErr.message : String(renderErr)}`);
        }
      })();
    } catch (err) {
      logError('editor', `Add MIDI failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [addTrack, addClipToTrack, cachePeaks, updateClip]);

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

  const handleTimelineScroll = useCallback(() => {
    if (trackHeaderScrollRef.current && timelineScrollRef.current) {
      trackHeaderScrollRef.current.scrollTop = timelineScrollRef.current.scrollTop;
    }
  }, []);

  return (
    <div className="hardware-card h-full flex flex-col bg-black/40 overflow-hidden" ref={containerRef}>
      {/* Editor Toolbar */}
      <div className="flex items-center justify-between p-2 border-b border-white/5 bg-black/20 shrink-0">
        <div className="flex items-center gap-3">
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
              id="editor-snap-division"
              name="editor-snap-division"
              value={snap}
              onChange={(e) => setSnap(e.target.value as SnapDivision)}
              className="bg-transparent border-none outline-none text-[9px] font-mono uppercase text-zinc-100 cursor-pointer"
              style={{ colorScheme: 'dark' }}
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
            disabled={selectedClipCount === 0}
            onClick={deleteSelectedClips}
            className="p-1.5 hover:bg-red-500/20 rounded text-zinc-400 hover:text-red-400 disabled:opacity-30 disabled:pointer-events-none"
            title="Delete selected clip(s) (Del)"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <div className="h-4 w-px bg-white/10" />

          <button
            onClick={() => setShowMasterFx((v) => !v)}
            aria-pressed={showMasterFx}
            aria-label="Master FX rack"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${showMasterFx || masterFxChain.length > 0 ? 'bg-purple-600/20 border-purple-500/40 text-purple-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
            title="Master psychoacoustic insert rack (applies to the whole editor mix)"
          >
            <SlidersHorizontal className="w-3 h-3" /> MASTER FX
          </button>

          <button
            onClick={() => setAutomationWrite(!automationWrite)}
            aria-pressed={automationWrite}
            aria-label="Automation write"
            title="Automation write: while playing, ride a track's volume or pan fader to record it; turn off to play it back"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${automationWrite ? 'bg-red-600/20 border-red-500/50 text-red-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
          >
            <span className={`w-2 h-2 rounded-full ${automationWrite ? 'bg-red-500 animate-pulse' : 'bg-zinc-600'}`} /> WRITE
          </button>

          <button
            onClick={() => setShowMetamorph((v) => !v)}
            aria-pressed={showMetamorph}
            aria-label="Metamorph granular identity-bleed panel"
            className={`flex items-center gap-1.5 p-1 px-2 rounded border transition-colors text-[9px] font-mono uppercase tracking-wider
              ${showMetamorph ? 'bg-purple-600/20 border-purple-500/40 text-purple-300' : 'border-white/5 text-zinc-500 hover:text-white hover:bg-white/5'}`}
            title="Granular identity bleed: rebuild one sound out of another's grains, live"
          >
            <Wand2 className="w-3 h-3" /> METAMORPH
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
          <label htmlFor="editor-mixdown-name" className="sr-only">Mixdown filename</label>
          <input
            id="editor-mixdown-name"
            name="editor-mixdown-name"
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

      {/* MASTER FX + METAMORPH float as popups (like the per-track FX rack) so they
          never shove the timeline down; close with the X. */}
      {(showMasterFx || showMetamorph) && (
        <div className="fixed top-28 left-4 z-50 flex items-start gap-3 max-w-[calc(100%-2rem)]">
          {showMasterFx && (
            <section aria-label="Master FX rack" className="w-90 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-purple-300">Master FX</span>
                <button
                  onClick={() => setShowMasterFx(false)}
                  aria-label="Close master FX rack"
                  className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <FxRack
                chain={masterFxChain}
                idPrefix="master-fx"
                onAdd={addMasterEffect}
                onRemove={removeMasterEffect}
                onReorder={reorderMasterEffect}
                onToggle={toggleMasterEffect}
                onUpdateParams={updateMasterEffectParams}
              />
            </section>
          )}
          {showMetamorph && (
            <section aria-label="Metamorph" className="w-90 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-purple-300">
                  Metamorph <span className="text-zinc-600 normal-case tracking-normal">granular identity bleed</span>
                </span>
                <button
                  onClick={() => setShowMetamorph(false)}
                  aria-label="Close Metamorph panel"
                  className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <MetamorphPanel />
            </section>
          )}
        </div>
      )}

      {/* Per-track FX rack (floating; fixed so it escapes the card's overflow clip) */}
      {fxPanelTrackId && (() => {
        const t = tracks.find((tr) => tr.id === fxPanelTrackId);
        if (!t) return null;
        return (
          <div className="fixed right-4 top-28 z-50 w-90 max-h-[70vh] overflow-y-auto hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 truncate">
                Track FX — <span style={{ color: t.color }}>{t.name}</span>
              </span>
              <button
                onClick={() => setFxPanelTrackId(null)}
                aria-label="Close track FX rack"
                title="Close"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <FxRack
              chain={t.fxChain ?? []}
              idPrefix={`track-fx-${t.id}`}
              onAdd={(eid) => addTrackEffect(t.id, eid)}
              onRemove={(id) => removeTrackEffect(t.id, id)}
              onReorder={(from, to) => reorderTrackEffect(t.id, from, to)}
              onToggle={(id) => toggleTrackEffect(t.id, id)}
              onUpdateParams={(id, p) => updateTrackEffectParams(t.id, id, p)}
            />
          </div>
        );
      })()}

      {/* Per-clip instrument override (floating; MIDI clips only) */}
      {instrPanel && (() => {
        const clip = clips.find((c) => c.id === instrPanel.clipId);
        if (!clip) return null;
        const left = Math.max(8, Math.min(instrPanel.x, window.innerWidth - 280));
        const top = Math.max(8, Math.min(instrPanel.y, window.innerHeight - 96));
        return (
          <div
            ref={instrPanelRef}
            className="fixed z-50 w-66 hardware-card bg-black/90 border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-3 flex flex-col gap-2"
            style={{ left, top }}
          >
            <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
              <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 truncate">
                Clip instrument — <span style={{ color: clip.color }}>{clip.label}</span>
              </span>
              <button
                onClick={() => setInstrPanel(null)}
                aria-label="Close clip instrument picker"
                title="Close"
                className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <ClipInstrumentSelect clip={clip} />
          </div>
        );
      })()}

      {/* Body: track headers + scrollable timeline */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Track headers (sticky, not scrolled) */}
        <div className="shrink-0 bg-[#0c0a12] border-r border-[#1a1528] overflow-hidden flex flex-col" style={{ width: TRACK_HEADER_PX }}>
          {/* Ruler row spacer */}
          <div className="h-6 border-b border-white/5 bg-black/30 flex items-center justify-center text-[8px] font-mono text-zinc-700 uppercase">tracks</div>
          <div ref={trackHeaderScrollRef} className="flex-1 overflow-hidden">
            {tracks.map((t) => (
              <div
                key={t.id}
                onPointerDown={(e) => handleTrackHeaderPointerDown(e, t.id)}
                onContextMenu={(e) => { selectTrackSingle(t.id); trackMenu.open(e, { trackId: t.id }); }}
                className={`border-b border-[#1a1528] p-2 flex flex-col gap-1.5 transition-colors ${selectedTrackIds.includes(t.id) ? 'bg-purple-500/10 ring-1 ring-inset ring-purple-500/35' : ''}`}
                style={{ height: TRACK_HEIGHT }}
                title="Click to select track. Ctrl/Cmd-click to multi-select tracks. Right-click for track FX."
              >
                <div className="flex justify-between items-center gap-1">
                  <input
                    id={`editor-track-name-${t.id}`}
                    name={`editor-track-name-${t.id}`}
                    aria-label={`Track ${t.name} name`}
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
                      onClick={() => setFxPanelTrackId((cur) => (cur === t.id ? null : t.id))}
                      aria-label={`Track ${t.name} insert FX`}
                      aria-pressed={fxPanelTrackId === t.id}
                      title="Track insert FX rack"
                      className={`w-4 h-4 rounded text-[8px] font-bold flex items-center justify-center ${(t.fxChain?.length ?? 0) > 0 || fxPanelTrackId === t.id ? 'bg-purple-500/20 text-purple-300 border border-purple-500/50' : 'bg-black/40 text-zinc-500 border border-white/5 hover:text-white'}`}
                    >F</button>
                    <button
                      onClick={() => removeTrack(t.id)}
                      className="w-4 h-4 rounded text-[8px] flex items-center justify-center bg-black/40 text-zinc-600 border border-white/5 hover:text-red-400"
                      title="Remove track"
                    >×</button>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Volume2 className="w-2.5 h-2.5 text-zinc-600 shrink-0" />
                  <SlideTrack min={0} max={1} step={0.01} value={t.volume}
                    onChange={(v) => writeFader('trackVolume', t.id, v)} className="flex-1" ariaLabel="Track volume" />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[7px] font-mono text-zinc-600 uppercase w-3">P</span>
                  <SlideTrack min={-1} max={1} step={0.01} value={t.pan}
                    onChange={(v) => writeFader('trackPan', t.id, v)} className="flex-1" ariaLabel="Track pan" />
                  <span className="text-[7px] font-mono text-zinc-600 text-right w-5">
                    {t.pan > 0 ? `R${Math.round(t.pan * 100)}` : t.pan < 0 ? `L${Math.round(-t.pan * 100)}` : 'C'}
                  </span>
                </div>
                {clips.some((c) => c.trackId === t.id && c.sourceKind === 'piano-roll' && !!c.sourcePianoRoll && c.sourcePianoRoll.length > 0) && (
                  <TrackInstrumentSelect track={t} />
                )}
              </div>
            ))}
            {/* Add-track affordance sits directly below the lowest (newest) track. */}
            <button
              onClick={() => addTrack()}
              aria-label="Add track"
              title="Add a new empty track"
              className="w-full h-7 flex items-center justify-center text-zinc-500 hover:text-purple-300 hover:bg-purple-500/10 border-b border-[#1a1528] transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Scrollable timeline area */}
        <div
          ref={timelineScrollRef}
          className="flex-1 min-w-0 overflow-x-auto overflow-y-auto bg-[#07050a]"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onScroll={handleTimelineScroll}
        >
          {/* Ruler — click or drag to set playhead. Sticky so vertical scroll keeps it pinned. */}
          <div
            className="h-6 border-b border-white/5 bg-black/80 backdrop-blur-sm sticky top-0 z-40 select-none cursor-col-resize"
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
            onContextMenu={onLanesContextMenu}
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
              const selected = selectedClipIdSet.has(clip.id) || clip.id === selectedClipId;
              const peaks = clip.peaks;
              const isMidi = clip.sourceKind === 'piano-roll' && !!clip.sourcePianoRoll && clip.sourcePianoRoll.length > 0;
              return (
                <div
                  key={clip.id}
                  data-clip="1"
                  onPointerDown={(e) => onClipPointerDown(e, clip.id, 'move')}
                  onClick={(e) => onClipClick(e, clip.id)}
                  onDoubleClick={() => onClipDoubleClick(clip)}
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
                    <span className="flex items-center gap-1 min-w-0 max-w-3/5">
                      {clip.sourceKind === 'piano-roll' && (
                        <Piano className="w-2.5 h-2.5 text-emerald-300 shrink-0" />
                      )}
                      <span className="text-white truncate">{clip.label}</span>
                    </span>
                    <span className="text-zinc-300">{clip.durationSec.toFixed(2)}s</span>
                  </div>
                  {/* Body: MIDI clips show their notes (FL-style); audio clips show peaks */}
                  {isMidi ? (
                    <MidiClipNotes clip={clip} zoom={zoom} selected={selected} />
                  ) : (
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
                  )}
                  {/* Inpaint drag target — covers waveform body below header.
                      MIDI clips skip it so double-click / right-click reach the
                      clip (inpaint generates audio into a region, meaningless for notes). */}
                  {!isMidi && (
                    <div
                      className="absolute inset-x-0 bottom-0 z-10 cursor-crosshair"
                      style={{ top: 14 }}
                      onPointerDown={(e) => handleInpaintDragStart(e, clip)}
                      onPointerMove={handleInpaintDragMove}
                      onPointerUp={handleInpaintDragEnd}
                    />
                  )}
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

            {/* Automation lanes (read-only curve over each track; volume green, pan blue) */}
            {automationLanes.map((lane) => {
              if (lane.points.length === 0) return null;
              if (lane.target.kind !== 'trackVolume' && lane.target.kind !== 'trackPan') return null;
              const trackIdx = tracks.findIndex((t) => t.id === lane.target.trackId);
              if (trackIdx < 0) return null;
              const isPan = lane.target.kind === 'trackPan';
              const color = isPan ? '#60a5fa' : '#34d399';
              const norm = (v: number) => (isPan ? (Math.max(-1, Math.min(1, v)) + 1) / 2 : Math.max(0, Math.min(1, v)));
              const yOf = (v: number) => (1 - norm(v)) * TRACK_HEIGHT;
              const pts = lane.points.map((p) => `${(p.t * zoom).toFixed(1)},${yOf(p.v).toFixed(1)}`).join(' ');
              return (
                <svg
                  key={lane.id}
                  className="absolute left-0 pointer-events-none"
                  style={{ top: trackIdx * TRACK_HEIGHT, width: timelineWidthPx, height: TRACK_HEIGHT }}
                  width={timelineWidthPx}
                  height={TRACK_HEIGHT}
                >
                  <polyline points={pts} fill="none" stroke={color} strokeOpacity={0.7} strokeWidth={1.5} />
                  {lane.points.map((p, i) => (
                    <circle key={`${lane.id}-${i}`} cx={p.t * zoom} cy={yOf(p.v)} r={2} fill={color} fillOpacity={0.85} />
                  ))}
                </svg>
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

      {/* Right-click context menu — shared ContextMenu primitive
          (plan step 3d). The conditional items (inpaint region / edit
          in piano roll) flow naturally through the items array since
          the menu is rebuilt each render from `clipMenu.payload`. */}
      {(() => {
        const payload = clipMenu.payload;
        if (!payload) return null;
        const clip = clips.find((c) => c.id === payload.clipId);
        const items: ContextMenuItem[] = [];
        if (inpaintSelection?.clipId === payload.clipId) {
          items.push({
            type: 'item',
            label: 'Inpaint Region',
            icon: <Paintbrush className="w-3 h-3" />,
            hint: 'Ctrl+P',
            onSelect: openInpaintPanel,
          });
          items.push({ type: 'separator' });
        }
        items.push({
          type: 'item',
          label: 'Preview',
          hint: 'Space',
          onSelect: () => { void playSelectedPreview(); },
        });
        items.push({
          type: 'item',
          label: 'Split here',
          hint: `${payload.atSec.toFixed(2)}s`,
          onSelect: () => splitClipAt(payload.clipId, payload.atSec),
        });
        items.push({
          type: 'item',
          label: 'Duplicate',
          hint: 'Ctrl+D',
          onSelect: duplicateSelectedClips,
        });
        items.push({
          type: 'item',
          label: 'Send Selection to Init',
          icon: <Wand2 className="w-3 h-3" />,
          hint: 'mix',
          disabled: isRendering,
          onSelect: () => { void sendSelectionToInit(); },
        });
        items.push({
          type: 'item',
          label: 'Send Selection to Init (stacked)',
          icon: <Layers className="w-3 h-3" />,
          hint: 'chimera',
          onSelect: () => {
            const selection = getSelectionForInit();
            if (selection.length === 0) return;
            addBlobsToChimera(
              selection.map((c) => ({
                blob: c.audioBlob,
                mimeType: c.mimeType,
                label: c.label,
              })),
            );
            onSwitchTab?.('create');
          },
        });
        if (clip?.sourcePianoRoll) {
          const noteCount = clip.sourcePianoRoll.length;
          items.push({
            type: 'item',
            label: 'Edit in Piano Roll',
            icon: <Piano className="w-3 h-3" />,
            hint: `${noteCount} notes`,
            onSelect: () => editClipInPianoRoll(clip),
          });
          items.push({
            type: 'item',
            label: 'Instrument',
            icon: <Piano className="w-3 h-3" />,
            hint: clip.instrumentProgram === undefined ? 'track default' : gmShortName(clip.instrumentProgram),
            onSelect: () => {
              const pos = clipMenu.position;
              setInstrPanel({ clipId: payload.clipId, x: pos?.x ?? 240, y: pos?.y ?? 200 });
            },
          });
        }
        items.push({ type: 'separator' });
        items.push({
          type: 'item',
          label: 'Delete',
          hint: 'Del',
          danger: true,
          onSelect: deleteSelectedClips,
        });
        return (
          <ContextMenu
            position={clipMenu.position}
            onClose={clipMenu.close}
            items={items}
            minWidth="10rem"
          />
        );
      })()}

      {/* Track context menu — insert FX, opened by right-clicking a track header. */}
      {trackMenu.position && (() => {
        const t = tracks.find((tr) => tr.id === trackMenu.payload?.trackId);
        if (!t) return null;
        const hasFx = (t.fxChain?.length ?? 0) > 0;
        const items: ContextMenuItem[] = [
          {
            type: 'item',
            icon: <SlidersHorizontal className="w-3 h-3" />,
            label: 'Open FX rack',
            onSelect: () => setFxPanelTrackId(t.id),
          },
          { type: 'separator' },
          { type: 'header', label: 'Add insert' },
          ...RACK_EFFECTS.map((def): ContextMenuItem => ({
            type: 'item',
            label: def.label,
            onSelect: () => addTrackEffect(t.id, def.id),
          })),
        ];
        if (hasFx) {
          items.push({ type: 'separator' });
          items.push({
            type: 'item',
            label: 'Clear track FX',
            danger: true,
            onSelect: () => updateTrack(t.id, { fxChain: [] }),
          });
        }
        return (
          <ContextMenu
            position={trackMenu.position}
            onClose={trackMenu.close}
            items={items}
            title={`Track · ${t.name}`}
            minWidth="11rem"
          />
        );
      })()}

      {/* MIDI picker — opened by right-clicking an empty part of the timeline. */}
      <LibraryMidiPicker
        open={midiDrop !== null}
        anchor={midiDrop ? { x: midiDrop.x, y: midiDrop.y } : null}
        title="Add MIDI to timeline"
        onClose={() => setMidiDrop(null)}
        onPick={(bytes, label) => {
          const at = midiDrop?.sec ?? 0;
          setMidiDrop(null);
          void addMidiClipFromBytes(bytes, label, at);
        }}
      />

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
                name="inpaint-prompt"
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
                <SlideTrack min={4} max={20} step={1} value={inpaintSteps}
                  onChange={(v) => setInpaintSteps(v)} className="w-full" ariaLabel="Inpaint steps" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-zinc-500 shrink-0">Seed</span>
                <input
                  type="number" name="inpaint-seed" value={inpaintSeed}
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

