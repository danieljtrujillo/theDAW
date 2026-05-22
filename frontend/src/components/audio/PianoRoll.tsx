import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Square, Download, Upload, Trash2, ZoomIn, ZoomOut, Send, Save } from 'lucide-react';
import { usePianoRollStore, pianoNotesToMidiNotes, type PianoNote } from '../../state/pianoRollStore';
import { usePlaybackStore } from '../../state/playbackStore';
import { getEngineCtx, getMasterGain } from '../../state/playerStore';
import { useEditorStore, computePeaks } from '../../state/editorStore';
import { downloadMidi, parseMidi } from '../../utils/midi';
import { logError, logInfo } from '../../state/logStore';

const NOTE_HEIGHT = 12;
const HEADER_HEIGHT = 22;
const KEYBOARD_WIDTH = 64;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const isBlackKey = (midi: number) => [1, 3, 6, 8, 10].includes(midi % 12);
const noteLabel = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/**
 * Schedule a single sawtooth+lowpass+env voice on the given context. Used both
 * for live playback (engine ctx + master gain) and offline rendering
 * (OfflineAudioContext + its destination).
 */
const triggerPianoNoteOn = (
  ctx: BaseAudioContext,
  dest: AudioNode,
  midi: number,
  velocity: number,
  when: number,
  duration: number,
  master: number,
): void => {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, when);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(Math.min(8000, freq * 6), when);
  const env = ctx.createGain();
  const peak = (velocity / 127) * 0.7 * master;
  env.gain.setValueAtTime(0.001, when);
  env.gain.exponentialRampToValueAtTime(peak, when + 0.008);
  env.gain.setTargetAtTime(peak * 0.5, when + 0.05, 0.08);
  env.gain.setTargetAtTime(0.001, when + duration, 0.05);
  osc.connect(lp).connect(env).connect(dest);
  osc.start(when);
  osc.stop(when + duration + 0.2);
};

/** Live preview convenience: route through the shared engine master/analyser. */
const triggerPianoNote = (midi: number, velocity: number, when: number, duration: number, master: number) => {
  const ctx = getEngineCtx();
  if (ctx.state === 'suspended') void ctx.resume();
  triggerPianoNoteOn(ctx, getMasterGain(), midi, velocity, when, duration, master);
};

// --- WAV encoder (16-bit PCM, mirrors WaveformEditor.encodeWav) ---
const encodeWavBlob = (audioBuf: AudioBuffer): Blob => {
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
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * numCh * 2, true);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c += 1) channels.push(audioBuf.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < len; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
};

/** Render the current pattern offline to a WAV Blob. Used by SEND TO EDITOR. */
const renderPianoRollToBlob = async (
  notes: PianoNote[],
  bpm: number,
  totalSteps: number,
): Promise<{ blob: Blob; duration: number }> => {
  const sr = 44100;
  const stepSec = 60 / Math.max(40, bpm) / 4; // 16th note seconds
  // Total length = (last note end + 0.5s tail).
  let maxEnd = 0;
  for (const n of notes) {
    const end = (n.step + n.length) * stepSec;
    if (end > maxEnd) maxEnd = end;
  }
  const padTail = 0.6;
  const totalSec = Math.max(maxEnd, totalSteps * stepSec) + padTail;
  const offline = new OfflineAudioContext(2, Math.ceil(totalSec * sr), sr);
  for (const n of notes) {
    const when = n.step * stepSec;
    const dur = n.length * stepSec;
    triggerPianoNoteOn(offline, offline.destination, n.note, n.velocity, when, dur, 1);
  }
  const rendered = await offline.startRendering();
  return { blob: encodeWavBlob(rendered), duration: rendered.duration };
};

export const PianoRoll: React.FC = () => {
  const notes = usePianoRollStore((s) => s.notes);
  const bpm = usePianoRollStore((s) => s.bpm);
  const totalSteps = usePianoRollStore((s) => s.totalSteps);
  const lowestNote = usePianoRollStore((s) => s.lowestNote);
  const highestNote = usePianoRollStore((s) => s.highestNote);
  const selectedNoteId = usePianoRollStore((s) => s.selectedNoteId);
  const isPlaying = usePianoRollStore((s) => s.isPlaying);
  const currentStep = usePianoRollStore((s) => s.currentStep);

  const setBpm = usePianoRollStore((s) => s.setBpm);
  const setTotalSteps = usePianoRollStore((s) => s.setTotalSteps);
  const addNote = usePianoRollStore((s) => s.addNote);
  const removeNote = usePianoRollStore((s) => s.removeNote);
  const updateNote = usePianoRollStore((s) => s.updateNote);
  const setSelectedNote = usePianoRollStore((s) => s.setSelectedNote);
  const setPlaying = usePianoRollStore((s) => s.setPlaying);
  const setCurrentStep = usePianoRollStore((s) => s.setCurrentStep);
  const replaceAll = usePianoRollStore((s) => s.replaceAll);
  const clear = usePianoRollStore((s) => s.clear);
  const editingClipId = usePianoRollStore((s) => s.editingClipId);
  const setEditingClip = usePianoRollStore((s) => s.setEditingClip);

  const [isBouncing, setIsBouncing] = useState(false);

  const masterGain = usePlaybackStore((s) => (s.muted ? 0 : s.volume / 100));
  const masterRef = useRef(masterGain);
  useEffect(() => { masterRef.current = masterGain; }, [masterGain]);

  const [stepPx, setStepPx] = useState(16);

  const noteCount = highestNote - lowestNote + 1;
  const gridHeight = noteCount * NOTE_HEIGHT;
  const gridWidth = totalSteps * stepPx;
  const gridRef = useRef<HTMLDivElement | null>(null);

  // Map y-pixel inside the grid to a MIDI note. Top row = highestNote.
  const yToNote = useCallback(
    (y: number): number => highestNote - Math.floor(y / NOTE_HEIGHT),
    [highestNote],
  );
  const xToStep = useCallback((x: number): number => Math.floor(x / stepPx), [stepPx]);

  const handleGridClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0) return;
    const targetNote = yToNote(y);
    const targetStep = xToStep(x);
    if (targetStep < 0 || targetStep >= totalSteps) return;
    // If clicked on an existing note → remove or select.
    const hit = notes.find(
      (n) => n.note === targetNote && targetStep >= n.step && targetStep < n.step + n.length,
    );
    if (hit) {
      if (selectedNoteId === hit.id) {
        removeNote(hit.id);
      } else {
        setSelectedNote(hit.id);
      }
      return;
    }
    // Otherwise add a 1-step note.
    addNote({ note: targetNote, step: targetStep, length: 2, velocity: 96 });
    triggerPianoNote(targetNote, 96, getEngineCtx().currentTime + 0.02, 0.2, masterRef.current);
  };

  // Right-drag a note to extend its length.
  const resizeRef = useRef<{ id: string; startX: number; initialLength: number } | null>(null);
  const onNotePointerDown = (e: React.PointerEvent, note: PianoNote, edge: 'right' | 'body') => {
    e.stopPropagation();
    setSelectedNote(note.id);
    if (edge === 'right') {
      resizeRef.current = { id: note.id, startX: e.clientX, initialLength: note.length };
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const op = resizeRef.current;
    if (!op) return;
    const dx = e.clientX - op.startX;
    const deltaSteps = Math.round(dx / stepPx);
    const newLen = Math.max(1, op.initialLength + deltaSteps);
    updateNote(op.id, { length: newLen });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (resizeRef.current) {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      resizeRef.current = null;
    }
  };

  // Delete / Backspace removes selected note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (selectedNoteId) {
        e.preventDefault();
        removeNote(selectedNoteId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedNoteId, removeNote]);

  // Playback loop.
  const playTimerRef = useRef<number | null>(null);
  const stepRef = useRef(currentStep);
  useEffect(() => { stepRef.current = currentStep; }, [currentStep]);
  const stopPlayback = useCallback(() => {
    if (playTimerRef.current != null) {
      window.clearInterval(playTimerRef.current);
      playTimerRef.current = null;
    }
    setPlaying(false);
  }, [setPlaying]);
  useEffect(() => {
    if (!isPlaying) return;
    const stepMs = (60_000 / Math.max(40, bpm)) / 4;
    const start = () => {
      const next = (stepRef.current + 1) % totalSteps;
      stepRef.current = next;
      setCurrentStep(next);
      const ctx = getEngineCtx();
      const when = ctx.currentTime + 0.02;
      for (const n of usePianoRollStore.getState().notes) {
        if (n.step === next) {
          const noteDur = (n.length * stepMs) / 1000;
          triggerPianoNote(n.note, n.velocity, when, noteDur, masterRef.current);
        }
      }
    };
    playTimerRef.current = window.setInterval(start, stepMs);
    return () => {
      if (playTimerRef.current != null) {
        window.clearInterval(playTimerRef.current);
        playTimerRef.current = null;
      }
    };
  }, [isPlaying, bpm, totalSteps, setCurrentStep]);

  const handlePlayToggle = () => {
    if (isPlaying) {
      stopPlayback();
      return;
    }
    // Fire step 0 immediately.
    const ctx = getEngineCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    const when = ctx.currentTime + 0.02;
    const stepMs = (60_000 / Math.max(40, bpm)) / 4;
    for (const n of notes) {
      if (n.step === 0) {
        triggerPianoNote(n.note, n.velocity, when, (n.length * stepMs) / 1000, masterRef.current);
      }
    }
    setCurrentStep(0);
    stepRef.current = 0;
    setPlaying(true);
    logInfo('piano-roll', `Playing ${notes.length} notes at ${bpm} BPM`);
  };

  const handleSendToEditor = async () => {
    if (notes.length === 0) {
      logError('piano-roll', 'No notes to bounce');
      return;
    }
    setIsBouncing(true);
    const start = performance.now();
    try {
      const { blob, duration } = await renderPianoRollToBlob(notes, bpm, totalSteps);
      const { peaks } = await computePeaks(blob, 240);
      const editor = useEditorStore.getState();
      // Snapshot the notes so re-editing later sees the exact same state.
      const noteSnapshot: PianoNote[] = notes.map((n) => ({ ...n }));

      if (editingClipId) {
        const existing = editor.clips.find((c) => c.id === editingClipId);
        if (existing) {
          editor.updateClip(editingClipId, {
            audioBlob: blob,
            mimeType: 'audio/wav',
            sourceDuration: duration,
            durationSec: duration,
            offsetIntoSource: 0,
            peaks,
            sourcePianoRoll: noteSnapshot,
            sourceBpm: bpm,
            sourceTotalSteps: totalSteps,
            sourceKind: 'piano-roll',
            label: existing.label.startsWith('roll_')
              ? `roll_${bpm}bpm_${notes.length}n`
              : existing.label,
          });
          logInfo('piano-roll', `Updated editor clip ${editingClipId.slice(0, 8)} (${duration.toFixed(2)}s, ${notes.length} notes)`);
          const ms = (performance.now() - start).toFixed(0);
          logInfo('piano-roll', `Re-bounce took ${ms}ms`);
          return;
        }
        // The clip the roll was bound to is gone — fall through to create a new one.
        setEditingClip(null);
      }

      const trackId = editor.addTrack({ name: `Piano ${bpm} BPM` });
      const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
      const newClipId = editor.addClipToTrack({
        trackId,
        label: `roll_${bpm}bpm_${notes.length}n`,
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: duration,
        offsetIntoSource: 0,
        durationSec: duration,
        startSec: 0,
        color: trackColor,
        sourceKind: 'piano-roll',
        sourcePianoRoll: noteSnapshot,
        sourceBpm: bpm,
        sourceTotalSteps: totalSteps,
      });
      editor.cachePeaks(newClipId, peaks);
      // Bind the roll to the new clip so subsequent Send-to-Editor edits in place.
      setEditingClip(newClipId);
      const ms = (performance.now() - start).toFixed(0);
      logInfo('piano-roll', `Bounced ${notes.length} notes → editor (${duration.toFixed(2)}s in ${ms}ms)`);
    } catch (e) {
      logError('piano-roll', `Bounce failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setIsBouncing(false);
    }
  };

  const handleExportMidi = () => {
    if (notes.length === 0) {
      logError('piano-roll', 'No notes to export');
      return;
    }
    const ppq = 480;
    const midiNotes = pianoNotesToMidiNotes(notes, ppq);
    downloadMidi(
      {
        ppq,
        bpm,
        tracks: [
          { name: 'Piano Roll', notes: midiNotes },
        ],
      },
      'piano-roll',
    );
    logInfo('piano-roll', `Exported ${notes.length} notes as MIDI`);
  };

  const handleImportMidi = (file: File) => {
    file.arrayBuffer().then((buf) => {
      try {
        const data = parseMidi(new Uint8Array(buf));
        setBpm(Math.round(data.bpm));
        // Flatten all tracks' notes into a single piano-roll layer.
        const stepTicks = data.ppq / 4;
        const flat: PianoNote[] = [];
        for (const track of data.tracks) {
          for (const n of track.notes) {
            flat.push({
              id: `imp-${Math.random().toString(36).slice(2)}-${flat.length}`,
              note: n.note,
              step: Math.round(n.tick / stepTicks),
              length: Math.max(1, Math.round(n.durationTicks / stepTicks)),
              velocity: n.velocity,
            });
          }
        }
        flat.sort((a, b) => a.step - b.step);
        // Expand grid if necessary.
        const maxEnd = flat.reduce((acc, n) => Math.max(acc, n.step + n.length), 0);
        if (maxEnd > totalSteps) setTotalSteps(Math.max(totalSteps, maxEnd + 4));
        replaceAll(flat);
        logInfo('piano-roll', `Imported ${flat.length} notes from "${file.name}" at ${Math.round(data.bpm)} BPM`);
      } catch (e) {
        logError('piano-roll', `MIDI import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }).catch((e) => logError('piano-roll', `Could not read file: ${e instanceof Error ? e.message : String(e)}`));
  };

  // Build keyboard rows + grid rows for rendering.
  const rows: number[] = [];
  for (let n = highestNote; n >= lowestNote; n -= 1) rows.push(n);

  return (
    <div className="h-full flex flex-col bg-[#07050a] overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-white/5 bg-black/40 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={handlePlayToggle}
            className={`p-1 rounded transition-colors ${isPlaying ? 'bg-red-500/20 text-red-300 border border-red-500/40' : 'bg-purple-500/20 text-purple-300 border border-purple-500/40 hover:bg-purple-500/30'}`}
            title={isPlaying ? 'Stop' : 'Play'}
          >
            {isPlaying ? <Square className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
          </button>
          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-black/40 border border-white/5 rounded">
            <span className="text-[7px] font-mono text-zinc-600 uppercase">BPM</span>
            <input
              type="number"
              min={40}
              max={240}
              value={bpm}
              onChange={(e) => setBpm(parseInt(e.target.value) || 120)}
              className="bg-transparent border-none outline-none text-[10px] font-mono text-cyan-400 w-10 font-black"
            />
          </div>
          <div className="flex items-center gap-1 px-1.5 py-0.5 bg-black/40 border border-white/5 rounded">
            <span className="text-[7px] font-mono text-zinc-600 uppercase">Steps</span>
            <input
              type="number"
              min={16}
              max={256}
              step={16}
              value={totalSteps}
              onChange={(e) => setTotalSteps(parseInt(e.target.value) || 32)}
              className="bg-transparent border-none outline-none text-[10px] font-mono text-zinc-300 w-12"
            />
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setStepPx(Math.max(6, stepPx - 2))} className="p-1 hover:bg-white/5 rounded text-zinc-500" title="Zoom out">
              <ZoomOut className="w-3 h-3" />
            </button>
            <span className="text-[8px] font-mono text-zinc-400 w-8 text-center">{stepPx}px</span>
            <button onClick={() => setStepPx(Math.min(48, stepPx + 2))} className="p-1 hover:bg-white/5 rounded text-zinc-500" title="Zoom in">
              <ZoomIn className="w-3 h-3" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-zinc-500">{notes.length} note{notes.length === 1 ? '' : 's'}</span>
          <label className="relative">
            <input
              type="file"
              accept=".mid,.midi,audio/midi"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImportMidi(f);
                e.target.value = '';
              }}
              title="Import MIDI file"
            />
            <span className="btn-ghost text-[9px] py-1 flex items-center gap-1.5 pointer-events-none">
              <Upload className="w-3 h-3 text-purple-300" /> IMPORT MIDI
            </span>
          </label>
          <button
            onClick={handleExportMidi}
            className="btn-ghost text-[9px] py-1 flex items-center gap-1.5"
            title="Download as a Standard MIDI File"
          >
            <Download className="w-3 h-3 text-purple-300" /> EXPORT MIDI
          </button>
          <button
            onClick={() => void handleSendToEditor()}
            disabled={isBouncing || notes.length === 0}
            className={`btn-ghost text-[9px] py-1 flex items-center gap-1.5 disabled:opacity-40 ${editingClipId ? 'border-emerald-500/40! text-emerald-200!' : ''}`}
            title={editingClipId
              ? 'Re-render and update the linked editor clip in place'
              : 'Render these notes to audio and add to the waveform editor as a new track'}
          >
            {editingClipId ? <Save className={`w-3 h-3 ${isBouncing ? 'animate-pulse' : 'text-emerald-300'}`} /> : <Send className={`w-3 h-3 text-purple-300 ${isBouncing ? 'animate-pulse' : ''}`} />}
            {isBouncing ? 'BOUNCING…' : editingClipId ? 'SAVE TO CLIP' : 'SEND TO EDITOR'}
          </button>
          {editingClipId && (
            <button
              onClick={() => setEditingClip(null)}
              className="btn-ghost text-[9px] py-1 flex items-center gap-1.5"
              title="Detach: future renders will create a new editor clip instead of updating the linked one"
            >
              UNLINK
            </button>
          )}
          <button
            onClick={() => clear()}
            className="btn-ghost text-[9px] py-1 flex items-center gap-1.5"
            title="Remove every note"
          >
            <Trash2 className="w-3 h-3" /> CLEAR
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Keyboard column */}
        <div className="shrink-0 overflow-hidden bg-[#0c0a12] border-r border-white/5" style={{ width: KEYBOARD_WIDTH }}>
          <div className="bg-black/40" style={{ height: HEADER_HEIGHT }} />
          <div className="overflow-hidden" style={{ height: gridHeight }}>
            {rows.map((midi) => {
              const black = isBlackKey(midi);
              const isC = midi % 12 === 0;
              return (
                <div
                  key={midi}
                  onClick={() => triggerPianoNote(midi, 100, getEngineCtx().currentTime + 0.02, 0.25, masterRef.current)}
                  className={`flex items-center justify-end pr-1 text-[8px] font-mono cursor-pointer transition-colors border-b border-black/40 ${black ? 'bg-zinc-900 text-zinc-600 hover:bg-purple-900/30' : isC ? 'bg-zinc-200 text-zinc-700 hover:bg-purple-300' : 'bg-zinc-300 text-zinc-700 hover:bg-purple-200'}`}
                  style={{ height: NOTE_HEIGHT }}
                  title={`Preview ${noteLabel(midi)}`}
                >
                  {isC ? noteLabel(midi) : ''}
                </div>
              );
            })}
          </div>
        </div>

        {/* Grid column */}
        <div className="flex-1 overflow-auto" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          {/* Ruler */}
          <div className="sticky top-0 z-20 bg-black/60 border-b border-white/5 flex" style={{ height: HEADER_HEIGHT, width: gridWidth, minWidth: '100%' }}>
            {Array.from({ length: Math.ceil(totalSteps / 4) }).map((_, beat) => (
              <div key={beat} className="border-r border-white/5 flex items-center px-1 text-[8px] font-mono text-zinc-500" style={{ width: stepPx * 4 }}>
                {beat + 1}
              </div>
            ))}
          </div>

          <div
            ref={gridRef}
            onClick={handleGridClick}
            className="relative cursor-crosshair"
            style={{ width: gridWidth, height: gridHeight }}
          >
            {/* Row backgrounds (alternating black/white key tint + 1-beat lines) */}
            {rows.map((midi, idx) => (
              <div
                key={midi}
                className={`absolute left-0 right-0 border-b border-black/30 ${isBlackKey(midi) ? 'bg-white/2' : 'bg-white/4'} ${midi % 12 === 0 ? 'border-purple-500/20!' : ''}`}
                style={{ top: idx * NOTE_HEIGHT, height: NOTE_HEIGHT }}
              />
            ))}
            {/* Vertical beat/step lines */}
            {Array.from({ length: totalSteps + 1 }).map((_, i) => (
              <div
                key={i}
                className={`absolute top-0 bottom-0 ${i % 4 === 0 ? 'border-l border-white/10' : 'border-l border-white/3'}`}
                style={{ left: i * stepPx }}
              />
            ))}
            {/* Playhead */}
            {isPlaying && (
              <div
                className="absolute top-0 bottom-0 w-px bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] z-30 pointer-events-none"
                style={{ left: currentStep * stepPx + stepPx / 2 }}
              />
            )}
            {/* Notes */}
            {notes.map((n) => {
              if (n.note < lowestNote || n.note > highestNote) return null;
              const row = highestNote - n.note;
              const left = n.step * stepPx;
              const width = Math.max(4, n.length * stepPx - 1);
              const top = row * NOTE_HEIGHT;
              const selected = n.id === selectedNoteId;
              return (
                <div
                  key={n.id}
                  data-piano-note="1"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (selectedNoteId === n.id) removeNote(n.id);
                    else setSelectedNote(n.id);
                  }}
                  onPointerDown={(e) => onNotePointerDown(e, n, 'body')}
                  className={`absolute rounded-sm border z-10 transition-colors ${selected ? 'bg-purple-400 border-white' : 'bg-purple-500 border-purple-700 hover:bg-purple-400'}`}
                  style={{ left, width, top: top + 1, height: NOTE_HEIGHT - 2 }}
                  title={`${noteLabel(n.note)} · step ${n.step + 1} · ${n.length} step${n.length === 1 ? '' : 's'}`}
                >
                  <div
                    onPointerDown={(e) => onNotePointerDown(e, n, 'right')}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/50"
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="h-5 border-t border-white/5 bg-black/60 flex items-center justify-between px-3 shrink-0">
        <span className="text-[8px] font-mono text-zinc-500">
          {isPlaying ? `PLAYING · step ${currentStep + 1}/${totalSteps}` : 'STOPPED'} · {bpm} BPM
          {editingClipId && (
            <span className="ml-2 px-1 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[7px] uppercase tracking-widest">
              Linked to clip {editingClipId.slice(0, 8)}
            </span>
          )}
        </span>
        <span className="text-[8px] font-mono text-zinc-600">
          Click empty cell = add · Click note = select / second click = delete · Drag right edge = resize · Delete key removes selection
        </span>
      </div>
    </div>
  );
};
