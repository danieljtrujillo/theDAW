import React, { useEffect, useRef, useState } from 'react';
import {
  Mic, Square, Play, Pause, Trash2, Wand2, PenLine, Layers, Save, X,
} from 'lucide-react';
import { logError, logInfo } from '../../state/logStore';
import { useLibraryStore } from '../../state/libraryStore';
import {
  sendAudioToEditor, sendAudioToInit, sendAudioToInpaint,
  type SendableAudio,
} from '../../lib/sendToTargets';

/**
 * Microphone-input recorder.
 *
 * Uses navigator.mediaDevices.getUserMedia + MediaRecorder to capture a
 * browser-side audio Blob (typically audio/webm; the import endpoint
 * decodes it). The result can be:
 *
 *   - Played back inline
 *   - Sent to the editor (new track or first track tail)
 *   - Sent to Init / Inpaint slots
 *   - Imported into the library (writes a real /api/library/import entry
 *     so it appears alongside generated tracks and can have stems / midi
 *     run against it later)
 */

type Phase = 'idle' | 'recording' | 'paused' | 'review';

const fmtSec = (s: number): string => {
  const total = Math.max(0, Math.floor(s));
  const m = Math.floor(total / 60);
  const r = total % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
};

const pickMime = (): string => {
  // Try a few common formats — Chrome/Edge prefer webm/opus, Firefox
  // can do ogg/opus, Safari needs mp4/aac. The library import endpoint
  // hands the bytes to the backend which stores them verbatim, so any
  // of these is fine for downstream processing.
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* keep trying */
    }
  }
  return '';
};

interface Props {
  /** Optional close handler so a host modal can dismiss after import. */
  onClose?: () => void;
  /** If true, render without the outer card chrome (for embedding in modals). */
  embedded?: boolean;
}

export const MicRecorder: React.FC<Props> = ({ onClose, embedded = false }) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  // Cleanup on unmount: stop tracks, revoke object URL, clear timers.
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startRecording = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('getUserMedia is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const mime = pickMime();
      const opts = mime ? { mimeType: mime } : undefined;
      const rec = new MediaRecorder(stream, opts);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        const combined = new Blob(chunksRef.current, { type: rec.mimeType || mime || 'audio/webm' });
        setBlob(combined);
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        setBlobUrl(URL.createObjectURL(combined));
        setPhase('review');
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        if (tickRef.current) {
          clearInterval(tickRef.current);
          tickRef.current = null;
        }
      };
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      setElapsedSec(0);
      rec.start(250); // collect 250ms chunks so the size grows visibly
      setPhase('recording');
      tickRef.current = setInterval(() => {
        setElapsedSec((Date.now() - startedAtRef.current) / 1000);
      }, 250);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      logError('mic', `getUserMedia failed: ${msg}`);
    }
  };

  const togglePause = () => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (phase === 'recording') {
      try {
        rec.pause();
        setPhase('paused');
      } catch (e) {
        logError('mic', `pause failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (phase === 'paused') {
      try {
        rec.resume();
        // Reset start anchor so elapsed continues correctly.
        startedAtRef.current = Date.now() - elapsedSec * 1000;
        setPhase('recording');
      } catch (e) {
        logError('mic', `resume failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const stopRecording = () => {
    const rec = recorderRef.current;
    if (!rec) return;
    try {
      rec.stop();
    } catch (e) {
      logError('mic', `stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const resetAll = () => {
    setBlob(null);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    setBlobUrl(null);
    setElapsedSec(0);
    setPhase('idle');
    setPlaying(false);
  };

  const recordingLabel = (): string => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `mic-recording-${stamp}`;
  };

  const buildSendable = (): SendableAudio | null => {
    if (!blob) return null;
    const ext = blob.type.includes('webm') ? '.webm' : blob.type.includes('ogg') ? '.ogg' : blob.type.includes('mp4') ? '.m4a' : '.wav';
    return {
      label: `${recordingLabel()}${ext}`,
      mimeType: blob.type || 'audio/webm',
      fetcher: async () => blob,
    };
  };

  const handleSendEditor = async (target: 'editor-first-track' | 'editor-new-track') => {
    const item = buildSendable();
    if (!item) return;
    setBusy(true);
    try {
      const clipId = await sendAudioToEditor(item, target);
      if (clipId) logInfo('mic', `Sent recording → editor (${target})`);
    } finally {
      setBusy(false);
    }
  };
  const handleSendInit = async () => {
    const item = buildSendable();
    if (!item) return;
    setBusy(true);
    try {
      await sendAudioToInit(item);
    } finally {
      setBusy(false);
    }
  };
  const handleSendInpaint = async () => {
    const item = buildSendable();
    if (!item) return;
    setBusy(true);
    try {
      await sendAudioToInpaint(item);
    } finally {
      setBusy(false);
    }
  };

  const handleSaveToLibrary = async () => {
    if (!blob) return;
    setBusy(true);
    try {
      const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'wav';
      const filename = `${recordingLabel()}.${ext}`;
      const entry = await useLibraryStore.getState().importEntry({
        blob,
        filename,
        mimeType: blob.type || 'audio/webm',
        metadata: {
          title: recordingLabel(),
          model: 'mic-recording',
          duration: elapsedSec,
          source: 'import',
          tags: ['mic'],
        },
      });
      logInfo('mic', `Imported ${entry.title} into library (${Math.round(blob.size / 1024)}KB)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('mic', `Library import failed: ${msg}`);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const audioEl = (
    <audio
      ref={audioElRef}
      src={blobUrl ?? undefined}
      onEnded={() => setPlaying(false)}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      className="hidden"
    />
  );

  const innerBody = (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className={`text-[9px] font-mono uppercase tracking-widest ${
          phase === 'recording'
            ? 'text-red-300'
            : phase === 'paused'
              ? 'text-amber-300'
              : phase === 'review'
                ? 'text-purple-200'
                : 'text-zinc-500'
        }`}>
          {phase === 'recording' ? '● Recording' : phase === 'paused' ? '⏸ Paused' : phase === 'review' ? 'Review' : 'Idle'}
        </span>
        <span className="text-[9px] font-mono text-zinc-400 ml-auto tabular-nums">
          {fmtSec(elapsedSec)}
        </span>
      </div>

      {/* Transport */}
      <div className="flex items-center gap-1.5">
        {phase === 'idle' && (
          <button
            onClick={() => void startRecording()}
            className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded border border-red-500/40 bg-red-500/15 text-red-200 hover:bg-red-500/25"
            title="Start recording from default mic"
          >
            <Mic className="w-3 h-3" /> Record
          </button>
        )}
        {(phase === 'recording' || phase === 'paused') && (
          <>
            <button
              onClick={togglePause}
              className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded border border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
              title={phase === 'paused' ? 'Resume' : 'Pause'}
            >
              {phase === 'paused' ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
              {phase === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button
              onClick={stopRecording}
              className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded border border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10"
              title="Stop recording"
            >
              <Square className="w-3 h-3" /> Stop
            </button>
          </>
        )}
        {phase === 'review' && (
          <>
            <button
              onClick={() => {
                const el = audioElRef.current;
                if (!el) return;
                if (playing) el.pause();
                else void el.play();
              }}
              className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded border border-white/15 bg-white/5 text-zinc-200 hover:bg-white/10"
              title={playing ? 'Pause preview' : 'Play preview'}
            >
              {playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
              {playing ? 'Pause' : 'Preview'}
            </button>
            <button
              onClick={resetAll}
              className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded border border-white/15 bg-white/5 text-zinc-400 hover:text-red-200 hover:border-red-500/40 hover:bg-red-500/10"
              title="Discard and start over"
            >
              <Trash2 className="w-3 h-3" /> Discard
            </button>
          </>
        )}
      </div>

      {audioEl}

      {error && (
        <div className="text-[9px] font-mono text-red-300 break-words bg-red-500/10 border border-red-500/20 rounded px-2 py-1">
          {error}
        </div>
      )}

      {phase === 'review' && blob && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-white/5">
          <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Send recording to</span>
          <div className="grid grid-cols-2 gap-1">
            <SendBtn icon={Layers}   label="Editor (new track)" onClick={() => handleSendEditor('editor-new-track')} disabled={busy} />
            <SendBtn icon={Wand2}    label="Init audio" onClick={handleSendInit} disabled={busy} />
            <SendBtn icon={PenLine}  label="Inpaint" onClick={handleSendInpaint} disabled={busy} />
            <SendBtn icon={Save}     label="Save to Library" onClick={handleSaveToLibrary} disabled={busy} colSpan={2} primary />
          </div>
          <span className="text-[8px] font-mono text-zinc-700 leading-relaxed">
            {Math.round(blob.size / 1024)} KB · {blob.type || 'audio/webm'}
          </span>
        </div>
      )}
    </div>
  );

  if (embedded) return innerBody;

  return (
    <div className="bg-[#0c0a14] border border-purple-500/30 rounded p-3 flex flex-col gap-2 w-full max-w-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mic className="w-3.5 h-3.5 text-purple-400" />
          <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">Mic In</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1 text-zinc-500 hover:text-white rounded hover:bg-white/5" title="Close">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {innerBody}
    </div>
  );
};

const SendBtn: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  colSpan?: 1 | 2;
  primary?: boolean;
}> = ({ icon: Icon, label, onClick, disabled, colSpan = 1, primary }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`flex items-center justify-center gap-1.5 text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded border ${
      primary
        ? 'border-purple-400/60 bg-purple-500/25 text-purple-100 hover:bg-purple-500/40'
        : 'border-white/10 bg-white/5 text-zinc-300 hover:text-purple-100 hover:bg-purple-500/15 hover:border-purple-400/40'
    } disabled:opacity-40 disabled:cursor-not-allowed ${colSpan === 2 ? 'col-span-2' : ''}`}
  >
    <Icon className="w-3 h-3" />
    {label}
  </button>
);

