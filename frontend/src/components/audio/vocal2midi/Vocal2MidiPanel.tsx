/**
 * Vocal2MidiPanel — the full vocal2midi-architect suite, natively integrated into
 * theDAW's MIDI tab as a compact, collapsible control column. The ported recorder
 * runs YIN pitch detection (exact sensitivity/threshold math from the source); the
 * resulting notes are written into theDAW's EXISTING piano roll (pianoRollStore).
 * Every control from the suite is here: capture (mic + level visualizer +
 * sensitivity + cleanup), musical settings (key/scale/genre/profile/quantize),
 * editor tools (quantize/transpose/snap/change-key/related-keys), AI (analyze on
 * record, smart cleanup, assistant orb) on theDAW's Gemini, export (MIDI/WAV),
 * tap tempo, and recording history. Instrument selection uses theDAW's full GM
 * soundfont picker. AI calls convert audio to WAV first (gemini-3.5-flash audio).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mic, Square, ChevronRight, Download, Wand2, Loader2, Trash2,
  Activity, Music4,
} from 'lucide-react';

import {
  type NoteEvent,
  type ProcessingConfig,
  type AudioAnalysisResult,
  type RecordingEntry,
  QuantizeValue,
  ScaleType,
  Genre,
} from './types';
import { NOTE_NAMES, SOUND_PROFILES, GENRE_PROFILES } from './constants';
import {
  detectPitch, frequencyToMidi, cleanupNotes, snapToScale, processNotesWithProfile, generateMidiFile,
} from './audioProcessing';
import { applyVocalNotesToRoll } from './rollBridge';
import { quantizeNotes, transposeNotes, snapNotesToScale, changeKey, getKeyName } from './midiEditor';
import { detectKeyAndScale, getRelatedKeys } from './musicTheory';
import { getMidiSynth } from './midiSynth';
import { GM_NAMES } from '../../../lib/gmInstruments';
import { analyzeAudioWithGemini, smartCleanupMidi, type AnalysisContext } from './geminiService';
import { Visualizer } from './Visualizer';
import { BpmTapper } from './BpmTapper';
import { RecordingHistory } from './RecordingHistory';
import { AssistantOrb } from './AssistantOrb';
import { saveFile, type SaveFileResult } from '../../../lib/saveFile';

import { usePianoRollStore } from '../../../state/pianoRollStore';
import { encodeWav } from '../../../lib/wavEncode';
import { logInfo, logWarn } from '../../../state/logStore';
import { describeMicFailure } from '../../../lib/micErrors';
import { getEngineCtx } from '../../../state/playerStore';
import { surfaceDeviceId, useIoDevicesStore } from '../../../state/ioDevicesStore';
import { InstrumentPicker } from '../InstrumentPicker';
import { KEY_ON, KEY_REST, MINI_ICON_KEY, STRIP_ICON_KEY, keyTone, useDockTip } from '../midiDockKit';

const HISTORY_KEY = 'vocal2midi_recordings';

const DEFAULT_CONFIG: ProcessingConfig = {
  rootNote: 60,
  scale: ScaleType.CHROMATIC,
  genre: Genre.NONE,
  quantizeMode: 'AUTO',
  manualQuantizeValue: QuantizeValue.OFF,
  useGeminiForBpm: true,
  manualBpm: 120,
  prompt: '',
  autoKeyDetection: true,
  activeProfileId: 'DEFAULT',
  sensitivity: 35,
  experimentalPitchBend: false,
  enableCleanup: true,
};

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** gemini-3.5-flash accepts wav/mp3/ogg/flac (not webm) — convert before AI. */
async function toWavBlob(blob: Blob): Promise<Blob> {
  const ab = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(ab.slice(0));
    return encodeWav(buf);
  } finally {
    void ctx.close().catch(() => {});
  }
}

const QUANT_BUTTONS: { label: string; value: QuantizeValue }[] = [
  { label: '1/4', value: QuantizeValue.Q_1_4 },
  { label: '1/8', value: QuantizeValue.Q_1_8 },
  { label: '1/16', value: QuantizeValue.Q_1_16 },
  { label: '1/32', value: QuantizeValue.Q_1_32 },
];

const Section: React.FC<{ title: string; defaultOpen?: boolean; children: React.ReactNode }> = ({
  title, defaultOpen = true, children,
}) => (
  <details open={defaultOpen} className="rounded border border-white/10 bg-black/30">
    <summary className="cursor-pointer select-none px-2 py-1 text-[12px] font-display font-extrabold uppercase et-ink-2 hover:et-ink">
      {title}
    </summary>
    <div className="px-2 pb-2 pt-1 space-y-1.5">{children}</div>
  </details>
);

const labelCls = 'text-[12px] font-display font-bold uppercase text-zinc-400';
const selectCls = 'w-full bg-zinc-800 border border-zinc-600 rounded text-[12px] font-semibold text-zinc-100 px-1 py-0.5';
// The MIDI dock's key grammar (midiDockKit): a chip's label is always an
// element, so a disabled chip dims its label and keeps its cap.
const chip = 'h-5 px-1.5 inline-flex items-center gap-1 rounded-xs border-b text-[12px] font-display font-bold uppercase transition-[color,box-shadow,border-color] cursor-pointer disabled:cursor-default disabled:*:opacity-40';
const chipOff = KEY_REST;
const chipOn = KEY_ON;

/* ── component ────────────────────────────────────────────────────────────── */

export const Vocal2MidiPanel: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const [config, setConfig] = useState<ProcessingConfig>({ ...DEFAULT_CONFIG });
  const previewProgram = usePianoRollStore((st) => st.voiceProgram);
  const setPreviewProgram = usePianoRollStore((st) => st.setVoiceProgram);
  const [capturedNotes, setCapturedNotes] = useState<NoteEvent[]>([]);
  const [processedNotes, setProcessedNotes] = useState<NoteEvent[]>([]);
  const [audioAnalysis, setAudioAnalysis] = useState<AudioAnalysisResult | null>(null);
  const [detectedKeyString, setDetectedKeyString] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSmartCleaning, setIsSmartCleaning] = useState(false);
  const [lastCleanupSummary, setLastCleanupSummary] = useState<string | null>(null);
  const [status, setStatus] = useState('ready');
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [recordings, setRecordings] = useState<RecordingEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch {
      return [];
    }
  });

  // recorder refs (ported from the source App)
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const currentNoteRef = useRef<{ note: number; startTime: number } | null>(null);
  const startTimeRef = useRef(0);
  const bufferRef = useRef<NoteEvent[]>([]);
  const sensitivityRef = useRef(config.sensitivity);
  const lastBlobRef = useRef<Blob | null>(null);

  useEffect(() => { sensitivityRef.current = config.sensitivity; }, [config.sensitivity]);
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(recordings));
    } catch {
      /* storage blocked or full: the history lasts for this session only */
    }
  }, [recordings]);

  // The column unmounts when VOICE turns off or the tab closes, possibly
  // mid-recording. stopRecording is the only other teardown, so release the
  // recorder, the graph on the SHARED engine context and the mic here.
  useEffect(() => () => {
    isRecordingRef.current = false;
    const rec = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    try {
      if (rec && rec.state !== 'inactive') rec.stop();
    } catch {
      /* already stopped */
    }
    if (processorRef.current) processorRef.current.onaudioprocess = null;
    for (const node of [sourceRef.current, processorRef.current, sinkRef.current]) {
      try {
        node?.disconnect();
      } catch {
        /* never connected */
      }
    }
    sourceRef.current = null;
    processorRef.current = null;
    sinkRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const bpm = audioAnalysis?.detectedBpm || config.manualBpm || 120;

  // With Pitch bend on, the slides the MIDI export writes go to the roll's lane
  // A too (rollBridge.applyVocalNotesToRoll).
  const pitchBendRef = useRef(config.experimentalPitchBend);
  useEffect(() => { pitchBendRef.current = config.experimentalPitchBend; }, [config.experimentalPitchBend]);

  /** Write notes into theDAW's existing piano roll, at the ticks they arrive on. */
  const applyToRoll = useCallback((notes: NoteEvent[], atBpm: number) => {
    applyVocalNotesToRoll(notes, atBpm, pitchBendRef.current);
  }, []);

  /* ── recorder (ported YIN capture) ─────────────────────────────────────── */
  const startRecording = useCallback(async () => {
    try {
      // This panel is rendered INSIDE the MIDI tab, a few pixels under a
      // microphone picker it used to ignore entirely. It follows the same
      // surface now (with its own override available in Settings).
      const deviceId = surfaceDeviceId('vocal2midi');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId } : true,
      });
      useIoDevicesStore.getState().notePermissionGranted();
      streamRef.current = stream;
      // The SHARED engine context, not a private one. A second AudioContext is
      // a second hardware output stream that ignores the chosen main output —
      // and this one was never closed, so every recording session leaked one.
      const ctx = getEngineCtx();
      if (ctx.state === 'suspended') await ctx.resume();
      audioCtxRef.current = ctx;

      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      analyserRef.current = an;
      setAnalyser(an);

      const src = ctx.createMediaStreamSource(stream);
      sourceRef.current = src;
      src.connect(an);

      const proc = ctx.createScriptProcessor(2048, 1, 1);
      processorRef.current = proc;
      src.connect(proc);
      // Pull the processor through a MUTED sink so onaudioprocess keeps being
      // called without routing the microphone at the speakers (the same shape
      // the YIN capture path uses).
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sinkRef.current = sink;
      proc.connect(sink);
      sink.connect(ctx.destination);

      startTimeRef.current = ctx.currentTime;
      bufferRef.current = [];
      currentNoteRef.current = null;
      isRecordingRef.current = true;
      setIsRecording(true);
      setAudioAnalysis(null);
      setProcessedNotes([]);
      setDetectedKeyString('');
      setStatus('listening...');

      proc.onaudioprocess = (e) => {
        if (!isRecordingRef.current) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const sampleRate = ctx.sampleRate;
        const currentTime = ctx.currentTime - startTimeRef.current;
        const s = sensitivityRef.current / 100;
        const gateThreshold = 0.05 - s * 0.049;
        const minConfidence = 0.9 - s * 0.5;
        const minDuration = 0.04 - s * 0.03;
        const frequency = detectPitch(inputData, sampleRate, minConfidence);
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        const rms = Math.sqrt(sum / inputData.length);
        if (rms > gateThreshold && frequency) {
          const midiNote = frequencyToMidi(frequency);
          if (midiNote < 21 || midiNote > 108) return;
          const pitchChangeThreshold = 2;
          if (currentNoteRef.current) {
            const pitchDiff = Math.abs(currentNoteRef.current.note - midiNote);
            if (pitchDiff > pitchChangeThreshold) {
              const duration = currentTime - currentNoteRef.current.startTime;
              if (duration > minDuration) {
                bufferRef.current.push({ midiNote: currentNoteRef.current.note, startTime: currentNoteRef.current.startTime, duration, velocity: 100 });
              }
              currentNoteRef.current = { note: midiNote, startTime: currentTime };
            }
          } else {
            currentNoteRef.current = { note: midiNote, startTime: currentTime };
          }
        } else if (currentNoteRef.current) {
          const duration = currentTime - currentNoteRef.current.startTime;
          if (duration > minDuration) {
            bufferRef.current.push({ midiNote: currentNoteRef.current.note, startTime: currentNoteRef.current.startTime, duration, velocity: 100 });
          }
          currentNoteRef.current = null;
        }
      };

      const rec = new MediaRecorder(stream);
      mediaRecorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data); };
      rec.start();
    } catch (err) {
      // "check permission" was wrong for three of the four real causes — a
      // machine with no microphone, a device another program holds, and an
      // unmeetable constraint all sent the user to the permission dialog.
      const failure = describeMicFailure(err, 'this recorder');
      logWarn('vocal2midi', failure.message);
      setStatus(failure.message);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const rec = mediaRecorderRef.current;
    const ctx = audioCtxRef.current;
    if (!rec || !ctx) return;
    isRecordingRef.current = false;
    setIsRecording(false);
    setIsProcessing(true);
    setStatus('analyzing...');

    const s = sensitivityRef.current / 100;
    const minDuration = 0.04 - s * 0.03;
    if (currentNoteRef.current) {
      const currentTime = ctx.currentTime - startTimeRef.current;
      const duration = currentTime - currentNoteRef.current.startTime;
      if (duration > minDuration) {
        bufferRef.current.push({ midiNote: currentNoteRef.current.note, startTime: currentNoteRef.current.startTime, duration, velocity: 100 });
      }
      currentNoteRef.current = null;
    }

    rec.stop();
    sourceRef.current?.disconnect();
    processorRef.current?.disconnect();
    // The muted sink lives on the SHARED context, so it has to be released
    // here — nothing closes that context.
    sinkRef.current?.disconnect();
    sinkRef.current = null;
    await new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
    streamRef.current?.getTracks().forEach((t) => t.stop());

    const webm = new Blob(chunksRef.current, { type: 'audio/webm' });
    lastBlobRef.current = webm;

    const rawUncleaned = [...bufferRef.current];
    let rawNotes: NoteEvent[];
    if (config.enableCleanup) {
      rawNotes = cleanupNotes(rawUncleaned, 0.05, 0.1);
    } else {
      rawNotes = rawUncleaned;
    }
    if (rawNotes.length === 0) {
      setStatus(`no notes detected (try raising sensitivity, now ${config.sensitivity}%)`);
      setIsProcessing(false);
      return;
    }

    // Gemini metadata (BPM/profile) — convert to WAV first (gemini-3.5-flash audio)
    let analysis: AudioAnalysisResult;
    if (config.useGeminiForBpm) {
      try {
        const wav = await toWavBlob(webm);
        const aCtx: AnalysisContext = {
          genre: config.genre, scale: config.scale, quantizeMode: config.quantizeMode,
          manualQuantizeValue: config.manualQuantizeValue, sensitivity: config.sensitivity,
          autoKeyDetection: config.autoKeyDetection,
        };
        analysis = await analyzeAudioWithGemini(wav, config.prompt, aCtx);
      } catch (e) {
        logWarn('vocal2midi', `Gemini analysis failed, using local defaults: ${String(e)}`);
        analysis = { detectedBpm: config.manualBpm || 120, timeSignature: '4/4', suggestedInstrument: 'Grand Piano', description: 'Local (AI unavailable)', detectedProfileId: 'DEFAULT' };
      }
    } else {
      analysis = { detectedBpm: config.manualBpm || 120, timeSignature: '4/4', suggestedInstrument: 'Unknown', description: 'Local processing', detectedProfileId: 'DEFAULT' };
    }
    setAudioAnalysis(analysis);

    let finalRoot = config.rootNote;
    let finalScale = config.scale;
    if (config.autoKeyDetection) {
      const k = detectKeyAndScale(rawNotes);
      finalRoot = k.root + 60;
      finalScale = k.scale;
      setDetectedKeyString(`${NOTE_NAMES[k.root]} ${k.scale} (${Math.round(k.confidence * 100)}%)`);
    }

    const profileId = analysis.detectedProfileId && SOUND_PROFILES[analysis.detectedProfileId] ? analysis.detectedProfileId : 'DEFAULT';
    const profile = SOUND_PROFILES[profileId];
    const finalQuant = config.quantizeMode === 'AUTO' ? profile.suggestedQuantization : config.manualQuantizeValue;

    setConfig((prev) => ({ ...prev, rootNote: finalRoot, scale: finalScale, activeProfileId: profileId }));

    const scaled = rawNotes.map((n) => ({ ...n, midiNote: snapToScale(n.midiNote, finalRoot, finalScale) }));
    const finalNotes = processNotesWithProfile(scaled, analysis.detectedBpm, finalQuant, profile);

    setCapturedNotes(rawNotes);
    setProcessedNotes(finalNotes);
    applyToRoll(finalNotes, analysis.detectedBpm);

    if (finalNotes.length > 0) {
      setRecordings((prev) => [{
        id: `rec_${Date.now()}`, timestamp: Date.now(), name: `Recording ${prev.length + 1}`,
        notes: [...finalNotes], bpm: analysis.detectedBpm, rootNote: finalRoot, scale: finalScale,
        genre: config.genre, profileId,
      }, ...prev]);
    }
    setStatus(`captured ${finalNotes.length} notes -> piano roll`);
    setIsProcessing(false);
    logInfo('vocal2midi', `captured ${finalNotes.length} notes @ ${analysis.detectedBpm} BPM -> piano roll`);
  }, [config, applyToRoll]);

  // Re-process on setting change (mirrors the source effect; AUTO forces OFF).
  useEffect(() => {
    if (capturedNotes.length === 0) return;
    const b = audioAnalysis?.detectedBpm || 120;
    const scaled = capturedNotes.map((n) => ({ ...n, midiNote: snapToScale(n.midiNote, config.rootNote, config.scale) }));
    const profile = SOUND_PROFILES[config.activeProfileId] || SOUND_PROFILES['DEFAULT'];
    const q = config.quantizeMode === 'AUTO' ? QuantizeValue.OFF : config.manualQuantizeValue;
    const finalNotes = processNotesWithProfile(scaled, b, q, profile);
    setProcessedNotes(finalNotes);
    applyToRoll(finalNotes, b);
  }, [config.rootNote, config.scale, config.quantizeMode, config.manualQuantizeValue, config.activeProfileId, capturedNotes, audioAnalysis, applyToRoll]);

  /* ── editor tools (operate on processedNotes -> roll) ──────────────────── */
  const pushNotes = useCallback((notes: NoteEvent[], atBpm = bpm) => {
    setProcessedNotes(notes);
    applyToRoll(notes, atBpm);
  }, [applyToRoll, bpm]);

  const doQuantize = (q: QuantizeValue) => pushNotes(quantizeNotes(processedNotes, bpm, q));
  const doTranspose = (semis: number) => pushNotes(transposeNotes(processedNotes, semis));
  const doSnap = () => pushNotes(snapNotesToScale(processedNotes, config.rootNote, config.scale));
  const doChangeKey = (toRoot: number, toScale: ScaleType) => {
    pushNotes(changeKey(processedNotes, config.rootNote, toRoot));
    setConfig((p) => ({ ...p, rootNote: toRoot, scale: toScale }));
  };

  const handleSmartCleanup = useCallback(async () => {
    if (!lastBlobRef.current || processedNotes.length === 0) return;
    setIsSmartCleaning(true);
    setStatus('AI cleaning...');
    try {
      const wav = await toWavBlob(lastBlobRef.current);
      const res = await smartCleanupMidi(wav, processedNotes, config.prompt, bpm);
      pushNotes(res.cleanedNotes);
      setCapturedNotes(res.cleanedNotes);
      setLastCleanupSummary(res.summary);
      setStatus(`AI cleanup: ${res.summary}`);
    } catch (e) {
      setStatus(`AI cleanup failed: ${String(e)}`);
    } finally {
      setIsSmartCleaning(false);
    }
  }, [processedNotes, config.prompt, bpm, pushNotes]);

  // What a save did, for the status line: the path when it was written.
  const savedStatus = (label: string, saved: SaveFileResult): string =>
    saved.path ? `${label} saved: ${saved.path}`
      : saved.downloaded ? `${label} exported`
        : saved.cancelled ? `${label} export cancelled`
          : `${label} export failed`;

  const handleExportMidi = async () => {
    if (processedNotes.length === 0) return;
    const profile = SOUND_PROFILES[config.activeProfileId] || SOUND_PROFILES['DEFAULT'];
    const blob = generateMidiFile(processedNotes, bpm, profile, { experimentalPitchBend: config.experimentalPitchBend });
    const saved = await saveFile({ blob, suggestedName: `vocal2midi_${Date.now()}.mid`, kind: 'midi' });
    setStatus(savedStatus('MIDI', saved));
  };

  const handleExportWav = async () => {
    if (processedNotes.length === 0) return;
    setStatus('rendering WAV...');
    try {
      const blob = await getMidiSynth().renderToWav(processedNotes);
      const saved = await saveFile({ blob, suggestedName: `vocal2midi_${Date.now()}.wav`, kind: 'audio' });
      setStatus(savedStatus('WAV', saved));
    } catch (e) {
      setStatus(`WAV export failed: ${String(e)}`);
    }
  };

  const playPreview = () => { void getMidiSynth().playNotes(processedNotes); };
  const stopPreview = () => getMidiSynth().stop();

  /* ── recording history ─────────────────────────────────────────────────── */
  const loadRecording = (r: RecordingEntry) => {
    setCapturedNotes(r.notes);
    setProcessedNotes(r.notes);
    setAudioAnalysis((prev) => ({ detectedBpm: r.bpm, timeSignature: prev?.timeSignature || '4/4', suggestedInstrument: prev?.suggestedInstrument || '', description: 'loaded from history', detectedProfileId: r.profileId }));
    setConfig((p) => ({ ...p, rootNote: r.rootNote, scale: r.scale, genre: r.genre, activeProfileId: r.profileId }));
    applyToRoll(r.notes, r.bpm);
    setStatus(`loaded "${r.name}" -> piano roll`);
  };

  const patch = (p: Partial<ProcessingConfig>) => setConfig((prev) => ({ ...prev, ...p }));
  const relatedKeys = config.scale !== ScaleType.CHROMATIC ? getRelatedKeys(config.rootNote, config.scale).slice(0, 4) : [];

  // Header keys name themselves in DockTips. Only one of the two layouts is
  // mounted, so the record tip serves whichever record key is showing.
  const recName = isRecording ? 'Stop recording' : 'Record';
  const recTip = useDockTip({
    word: isRecording ? 'Stop' : 'Record',
    description: isRecording ? 'Stop and write the take into the piano roll' : 'Record with live pitch detection into the piano roll',
    label: recName,
  });
  const expandTip = useDockTip({ word: 'Expand', description: 'Open the Voice column', label: 'Expand Vocal2MIDI' });
  const collapseTip = useDockTip({ word: 'Collapse', description: 'Fold the Voice column to a narrow strip', label: 'Collapse Vocal2MIDI' });

  /* ── render ────────────────────────────────────────────────────────────── */
  // data-dock-aside on both forms: a dock card opened from the strip above (MAP) keeps off this column.
  if (collapsed) {
    return (
      <div data-dock-aside="" className="h-full w-9 shrink-0 border-l border-white/8 bg-zinc-950 flex flex-col items-center gap-1.5 py-1">
        <button ref={expandTip.anchorRef} type="button" onClick={() => setCollapsed(false)} aria-label="Expand Vocal2MIDI"
          aria-describedby={expandTip.describedBy}
          className={`${MINI_ICON_KEY} ${KEY_REST}`}><ChevronRight aria-hidden="true" className="w-3 h-3 rotate-180" /></button>
        {expandTip.tip}
        <button ref={recTip.anchorRef} type="button" onClick={() => (isRecording ? void stopRecording() : void startRecording())}
          aria-label={recName} aria-describedby={recTip.describedBy}
          className={`${STRIP_ICON_KEY} ${keyTone({ rec: isRecording })}`}>
          {isRecording ? <Square aria-hidden="true" className="w-3 h-3" /> : <Mic aria-hidden="true" className="w-3 h-3" />}
        </button>
        {recTip.tip}
        <span className="text-[12px] font-display font-bold uppercase et-ink-3 [writing-mode:vertical-rl] rotate-180">Voice</span>
      </div>
    );
  }

  return (
    <div data-dock-aside="" className="h-full w-72 shrink-0 border-l border-white/8 bg-zinc-950 flex flex-col min-h-0">
      {/* header — 22px, level with the piano roll's ruler; data-dock-ceiling: the
          SHAPE row's above cards keep their tops below it */}
      <div data-dock-ceiling="" className="shrink-0 h-5.5 flex items-center gap-1 pl-2 pr-0.5 border-b border-white/5 bg-black/60">
        <span className="text-[12px] font-display font-bold uppercase et-ink-3" title="Vocal2MIDI">Voice</span>
        <div className="flex-1" />
        {/* AI assistant: a key here, its chat opens over the page — drives
            config + the piano-roll notes */}
        <AssistantOrb
          currentConfig={config}
          onConfigUpdate={(updates) => patch(updates)}
          pianoRollControls={{
            notes: processedNotes,
            bpm,
            rootNote: config.rootNote,
            scale: config.scale,
            isPlaying: false,
            onNotesChange: (notes) => pushNotes(notes),
            onBpmChange: (b) => { setAudioAnalysis((prev) => prev ? { ...prev, detectedBpm: b } : { detectedBpm: b, timeSignature: '4/4', suggestedInstrument: '', description: '', detectedProfileId: config.activeProfileId }); patch({ manualBpm: b }); },
            onKeyChange: (root, scale) => setConfig((p) => ({ ...p, rootNote: root, scale })),
            onPlay: playPreview,
            onStop: stopPreview,
            onInstrumentChange: (inst) => { void getMidiSynth().setInstrument(inst as Parameters<ReturnType<typeof getMidiSynth>['setInstrument']>[0]); },
          }}
        />
        {/* aria-disabled while a take converts, so the key keeps keyboard focus; a press waits for it. */}
        <button ref={recTip.anchorRef} type="button" onClick={() => { if (!isProcessing) { if (isRecording) void stopRecording(); else void startRecording(); } }}
          aria-disabled={isProcessing || undefined}
          aria-label={recName}
          aria-describedby={recTip.describedBy}
          className={`${MINI_ICON_KEY} ${keyTone({ rec: isRecording })}`}>
          {isProcessing ? <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" /> : isRecording ? <Square aria-hidden="true" className="w-2.5 h-2.5" /> : <Mic aria-hidden="true" className="w-3 h-3" />}
        </button>
        {recTip.tip}
        <button ref={collapseTip.anchorRef} type="button" onClick={() => setCollapsed(true)} aria-label="Collapse Vocal2MIDI"
          aria-describedby={collapseTip.describedBy}
          className={`${MINI_ICON_KEY} ${KEY_REST}`}><ChevronRight aria-hidden="true" className="w-3 h-3" /></button>
        {collapseTip.tip}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        <Section title="Capture">
          <Visualizer analyser={analyser} isRecording={isRecording} threshold={0.05 - (config.sensitivity / 100) * 0.049} />
          <div className="flex items-center gap-2">
            <label htmlFor="v2m-sens" className={labelCls}>Sensitivity</label>
            <input id="v2m-sens" name="v2m-sens" type="range" min={0} max={100} value={config.sensitivity}
              onChange={(e) => patch({ sensitivity: parseInt(e.target.value, 10) })} className="flex-1 accent-[rgb(var(--et-accent))]" />
            <span className="w-8 text-right text-[12px] font-bold et-ink tabular-nums">{config.sensitivity}%</span>
          </div>
          <label htmlFor="v2m-cleanup" className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-300">
            <input type="checkbox" id="v2m-cleanup" name="v2m-cleanup" checked={config.enableCleanup} onChange={(e) => patch({ enableCleanup: e.target.checked })} className="accent-[rgb(var(--et-accent))]" />
            Note cleanup
          </label>
          <label htmlFor="v2m-pitchbend" className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-300">
            <input type="checkbox" id="v2m-pitchbend" name="v2m-pitchbend" checked={config.experimentalPitchBend} onChange={(e) => patch({ experimentalPitchBend: e.target.checked })} className="accent-[rgb(var(--et-accent))]" />
            Pitch bend (experimental)
          </label>
          <span className="block text-[12px] font-semibold text-zinc-500 truncate" title={status}>{status}</span>
        </Section>

        <Section title="Musical">
          <div className="flex items-center gap-2">
            <label htmlFor="v2m-autokey" className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-300 flex-1">
              <input type="checkbox" id="v2m-autokey" name="v2m-autokey" checked={config.autoKeyDetection} onChange={(e) => patch({ autoKeyDetection: e.target.checked })} className="accent-[rgb(var(--et-accent))]" />
              Auto key
            </label>
            <label htmlFor="v2m-autobpm" className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-300 flex-1">
              <input type="checkbox" id="v2m-autobpm" name="v2m-autobpm" checked={config.useGeminiForBpm} onChange={(e) => patch({ useGeminiForBpm: e.target.checked })} className="accent-[rgb(var(--et-accent))]" />
              Auto BPM (AI)
            </label>
          </div>
          {detectedKeyString && <span className="block text-[12px] font-semibold text-[rgb(var(--et-accent))]">key: {detectedKeyString}</span>}
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label htmlFor="v2m-root" className={labelCls}>Root</label>
              <select id="v2m-root" name="v2m-root" className={selectCls} value={config.rootNote} onChange={(e) => patch({ rootNote: parseInt(e.target.value, 10) })} style={{ colorScheme: 'dark' }}>
                {NOTE_NAMES.map((n, i) => <option key={n} value={60 + i}>{n}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="v2m-scale" className={labelCls}>Scale</label>
              <select id="v2m-scale" name="v2m-scale" className={selectCls} value={config.scale} onChange={(e) => patch({ scale: e.target.value as ScaleType })} style={{ colorScheme: 'dark' }}>
                {Object.values(ScaleType).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="v2m-genre" className={labelCls}>Genre</label>
              <select id="v2m-genre" name="v2m-genre" className={selectCls} value={config.genre}
                onChange={(e) => { const g = e.target.value as Genre; patch({ genre: g, activeProfileId: GENRE_PROFILES[g].suggestedProfileId }); }} style={{ colorScheme: 'dark' }}>
                {Object.values(Genre).map((g) => <option key={g} value={g}>{GENRE_PROFILES[g].name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="v2m-profile" className={labelCls}>Profile</label>
              <select id="v2m-profile" name="v2m-profile" className={selectCls} value={config.activeProfileId} onChange={(e) => patch({ activeProfileId: e.target.value })} style={{ colorScheme: 'dark' }}>
                {Object.values(SOUND_PROFILES).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <span className={labelCls}>Quantize</span>
            <div className="flex flex-wrap gap-1 mt-0.5">
              <button type="button" onClick={() => patch({ quantizeMode: 'AUTO' })} className={`${chip} ${config.quantizeMode === 'AUTO' ? chipOn : chipOff}`}><span>Auto</span></button>
              <button type="button" onClick={() => patch({ quantizeMode: 'MANUAL' })} className={`${chip} ${config.quantizeMode === 'MANUAL' ? chipOn : chipOff}`}><span>Manual</span></button>
              {config.quantizeMode === 'MANUAL' && (
                <>
                  <button type="button" onClick={() => patch({ manualQuantizeValue: QuantizeValue.OFF })} className={`${chip} ${config.manualQuantizeValue === QuantizeValue.OFF ? chipOn : chipOff}`}><span>Off</span></button>
                  {QUANT_BUTTONS.map((q) => (
                    <button key={q.label} type="button" onClick={() => patch({ manualQuantizeValue: q.value })} className={`${chip} ${config.manualQuantizeValue === q.value ? chipOn : chipOff}`}><span>{q.label}</span></button>
                  ))}
                </>
              )}
            </div>
          </div>
          <div>
            <span className={labelCls}>Instrument (theDAW soundfonts)</span>
            {/* Own id prefix — this panel renders beside the Piano Roll, which
                owns `pr-instrument`. */}
            <div className="mt-0.5"><InstrumentPicker idPrefix="v2m-instrument" /></div>
          </div>
          <div>
            {/* The roll's own voice: PLAY, WAV export, and the roll these
                notes go to (while no EDIT clip is linked) all use it. The
                assistant's instrument choice lands here, never on the picker
                above, whose program every EDIT clip without its own follows. */}
            <label htmlFor="v2m-preview-voice" className={labelCls}>Roll voice</label>
            <select
              id="v2m-preview-voice"
              name="v2m-preview-voice"
              value={previewProgram === null ? 'picker' : String(previewProgram)}
              onChange={(e) => setPreviewProgram(e.target.value === 'picker' ? null : Number(e.target.value))}
              className="mt-0.5 block form-select px-2 py-1 text-xs font-semibold max-w-44"
              style={{ colorScheme: 'dark' }}
            >
              <option value="picker">Same as the instrument</option>
              {GM_NAMES.map((n, i) => (
                <option key={n} value={i}>{`${i + 1}. ${n}`}</option>
              ))}
            </select>
          </div>
        </Section>

        <Section title="Edit tools" defaultOpen={false}>
          <div className="flex flex-wrap gap-1">
            <span className={`${labelCls} w-full`}>Re-quantize</span>
            {QUANT_BUTTONS.map((q) => (
              <button key={q.label} type="button" onClick={() => doQuantize(q.value)} className={`${chip} ${chipOff}`} disabled={processedNotes.length === 0}><span>{q.label}</span></button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className={labelCls}>Transpose</span>
            <button type="button" onClick={() => doTranspose(-12)} className={`${chip} ${chipOff}`}><span>-12</span></button>
            <button type="button" onClick={() => doTranspose(-1)} className={`${chip} ${chipOff}`}><span>-1</span></button>
            <button type="button" onClick={() => doTranspose(1)} className={`${chip} ${chipOff}`}><span>+1</span></button>
            <button type="button" onClick={() => doTranspose(12)} className={`${chip} ${chipOff}`}><span>+12</span></button>
            <button type="button" onClick={doSnap} className={`${chip} ${chipOff}`} disabled={processedNotes.length === 0}><span>Snap to scale</span></button>
          </div>
          {relatedKeys.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className={labelCls}>Change key</span>
              {relatedKeys.map((rk) => (
                <button key={rk.relationship} type="button" title={rk.relationship} onClick={() => doChangeKey(rk.midiNote, rk.scale)} className={`${chip} ${chipOff}`}>
                  <span>{NOTE_NAMES[rk.root]} {rk.scale}</span>
                </button>
              ))}
            </div>
          )}
          <div className="text-[12px] font-semibold text-zinc-500">current: {getKeyName(config.rootNote, config.scale)} · {processedNotes.length} notes</div>
        </Section>

        <Section title="AI">
          <label htmlFor="v2m-prompt" className="sr-only">AI prompt</label>
          <input id="v2m-prompt" name="v2m-prompt" type="text" value={config.prompt} onChange={(e) => patch({ prompt: e.target.value })}
            placeholder="AI context / instruction (optional)"
            className="w-full bg-zinc-800 border border-zinc-600 rounded text-[12px] font-semibold text-zinc-100 px-1.5 py-1" />
          <button type="button" onClick={() => void handleSmartCleanup()} disabled={isSmartCleaning || !lastBlobRef.current || processedNotes.length === 0}
            className={`${chip} ${chipOff} w-full justify-center`}>
            {isSmartCleaning ? <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" /> : <Wand2 aria-hidden="true" className="w-3 h-3" />} <span>Smart cleanup (AI)</span>
          </button>
          {lastCleanupSummary && <span className="block text-[12px] font-semibold text-zinc-400 wrap-break-word">{lastCleanupSummary}</span>}
          <span className="block text-[12px] font-semibold text-zinc-600">AI uses theDAW's Gemini (gemini-3.5-flash). Needs GEMINI_API_KEY set on the server.</span>
        </Section>

        <Section title="Play & export" defaultOpen={false}>
          <div className="flex items-center gap-1">
            <button type="button" onClick={playPreview} disabled={processedNotes.length === 0} className={`${chip} ${chipOff} flex items-center gap-1`}><Activity aria-hidden="true" className="w-3 h-3" /> <span>Play</span></button>
            <button type="button" onClick={stopPreview} className={`${chip} ${chipOff} flex items-center gap-1`}><Square aria-hidden="true" className="w-3 h-3" /> <span>Stop</span></button>
            <BpmTapper currentBpm={bpm} onBpmSet={(b) => { setAudioAnalysis((prev) => prev ? { ...prev, detectedBpm: b } : { detectedBpm: b, timeSignature: '4/4', suggestedInstrument: '', description: 'tap tempo', detectedProfileId: config.activeProfileId }); patch({ manualBpm: b }); if (capturedNotes.length) applyToRoll(processedNotes, b); }} />
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => void handleExportMidi()} disabled={processedNotes.length === 0} className={`${chip} ${chipOff} flex items-center gap-1`}><Download aria-hidden="true" className="w-3 h-3" /> <span>MIDI</span></button>
            <button type="button" onClick={() => void handleExportWav()} disabled={processedNotes.length === 0} className={`${chip} ${chipOff} flex items-center gap-1`}><Music4 aria-hidden="true" className="w-3 h-3" /> <span>WAV</span></button>
            <button type="button" onClick={() => { setCapturedNotes([]); setProcessedNotes([]); usePianoRollStore.getState().clear(); setStatus('cleared'); }} className={`${chip} ${chipOff} flex items-center gap-1`}><Trash2 aria-hidden="true" className="w-3 h-3" /> <span>Clear</span></button>
          </div>
        </Section>

        <Section title="History" defaultOpen={false}>
          <RecordingHistory
            recordings={recordings}
            onLoad={loadRecording}
            onDelete={(id) => setRecordings((p) => p.filter((r) => r.id !== id))}
            onClearAll={() => setRecordings([])}
            onExportAll={() => {
              const blob = new Blob([JSON.stringify(recordings, null, 2)], { type: 'application/json' });
              void saveFile({ blob, suggestedName: 'vocal2midi_recordings.json', kind: 'v2m-recordings' });
            }}
            onImport={(recs) => setRecordings((p) => [...recs, ...p])}
          />
        </Section>
      </div>
    </div>
  );
};
