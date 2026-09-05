import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Music2, RefreshCw } from 'lucide-react';
import type { LibraryEntry } from '../../../../state/libraryEntry';
import { logError, logInfo } from '../../../../state/logStore';
import { usePlayAlongStore, type ChordInstrument } from '../../../../state/playAlongStore';
import {
  makeArrangement,
  makeChordTrack,
  type NotationArtifact,
  type NotationCapabilities,
} from '../../../../lib/notationClient';
import { bestShapes, type ChordShape } from '../../../../lib/chordShapes';
import { loadChordTrack, toChordSpec, type ChordSpan, type ChordTrack } from '../../../../lib/chordTrack';
import { fetchVocalArtifact } from '../../../../lib/vocalExport';
import { clampZoom, TUNING_LABELS, useWheelZoom, ZOOM_STEP, ZoomControls } from '../scoreShared';
import { PlayAlongTransport } from '../playAlong/PlayAlongTransport';
import { usePlayAlong } from '../playAlong/usePlayAlongClock';
import { ChordDiagram } from './ChordDiagram';
import { ChordStripCanvas, type ChordStripCanvasHandle, type LyricWord } from './ChordStripCanvas';

export interface ChordPlayAlongProps {
  entry: LibraryEntry | null;
  artifacts: NotationArtifact[];
  /** The artifact selected in the SCORE list (any kind). */
  artifact: NotationArtifact | null;
  caps: NotationCapabilities | null;
  /** Called after a chord track / lead sheet was built so the list reloads. */
  onArtifactsChanged: () => void;
}

/** Mirror of the backend TUNINGS table, used only until the capabilities
 *  payload (tab_tuning_pitches) has been fetched from a backend that has it. */
const FALLBACK_TUNING_PITCHES: Record<string, number[]> = {
  'guitar-standard': [40, 45, 50, 55, 59, 64],
  'guitar-drop-d': [38, 45, 50, 55, 59, 64],
  'guitar-7-string': [35, 40, 45, 50, 55, 59, 64],
  'bass-standard': [28, 33, 38, 43],
  'bass-5-string': [23, 28, 33, 38, 43],
  'ukulele-standard': [67, 60, 64, 69],
};

const INSTRUMENTS: ChordInstrument[] = ['guitar', 'bass', 'ukulele'];
const BASE_PX_PER_SEC = 60;
const CAPO_MAX = 7;

const artifactMeta = (artifact: NotationArtifact): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(artifact.metadata_json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const newest = <T extends { created_at: number }>(items: T[]): T | null =>
  items.reduce<T | null>((best, item) => (!best || item.created_at > best.created_at ? item : best), null);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The CHORDS play-along view: the entry's gantasmo.chordtrack drawn as a
 * scrolling strip under the shared now-line, with a diagram rail showing how
 * to play the sounding chord (and the next two) on the chosen instrument and
 * tuning. Builds the chord track on demand through POST /{entry}/chords.
 */
export const ChordPlayAlong: React.FC<ChordPlayAlongProps> = ({ entry, artifacts, artifact, caps, onArtifactsChanged }) => {
  const canvasRef = useRef<ChordStripCanvasHandle | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const chordInstrument = usePlayAlongStore((s) => s.chordInstrument);
  const chordTuning = usePlayAlongStore((s) => s.chordTuning);
  const capo = usePlayAlongStore((s) => s.capo);
  const setChordInstrument = usePlayAlongStore((s) => s.setChordInstrument);
  const setChordTuning = usePlayAlongStore((s) => s.setChordTuning);
  const setCapo = usePlayAlongStore((s) => s.setCapo);

  // Which chord track to show: the selected artifact when it IS one, else the
  // newest chord track the entry has.
  const chordArtifact = useMemo<NotationArtifact | null>(() => {
    if (artifact && artifact.kind === 'chordtrack') return artifact;
    return newest(artifacts.filter((a) => a.kind === 'chordtrack'));
  }, [artifact, artifacts]);
  const hasLeadSheet = useMemo(
    () => artifacts.some((a) => a.kind === 'musicxml' && artifactMeta(a).style === 'lead-sheet'),
    [artifacts],
  );
  const newestMidi = useMemo(() => newest(artifacts.filter((a) => a.kind === 'midi')), [artifacts]);
  const hasVocal = useMemo(() => artifacts.some((a) => a.kind === 'vocal'), [artifacts]);

  const [track, setTrack] = useState<ChordTrack | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'chords' | 'chroma' | 'lead-sheet' | null>(null);
  const [lyrics, setLyrics] = useState<LyricWord[] | undefined>(undefined);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [voicingPick, setVoicingPick] = useState<Record<string, number>>({});
  const [zoom, setZoom] = useState(1);

  // Load (and reload after a rebuild: same id, new created_at) the chord track.
  const artifactKey = chordArtifact ? `${chordArtifact.id}|${chordArtifact.created_at}` : '';
  useEffect(() => {
    if (!chordArtifact) {
      setTrack(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void loadChordTrack(chordArtifact.id)
      .then((t) => {
        if (cancelled) return;
        setTrack(t);
        setCurrentIndex(-1);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTrack(null);
        setLoadError(errorText(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactKey]);

  // Lyrics row: best effort from the entry's vocal artifact (timed words).
  useEffect(() => {
    setLyrics(undefined);
    if (!entry || !hasVocal) return;
    let cancelled = false;
    (async () => {
      try {
        const doc = await fetchVocalArtifact(entry.id);
        if (cancelled || !doc) return;
        const words = (doc.lyrics as { words?: Array<{ text?: unknown; start_ms?: unknown; end_ms?: unknown }> } | undefined)?.words;
        if (!Array.isArray(words)) return;
        const mapped: LyricWord[] = [];
        for (const w of words) {
          if (typeof w?.text !== 'string' || typeof w.start_ms !== 'number' || typeof w.end_ms !== 'number') continue;
          const text = w.text.trim();
          if (!text) continue;
          mapped.push({ text, startSec: w.start_ms / 1000, endSec: Math.max(w.start_ms, w.end_ms) / 1000 });
        }
        mapped.sort((a, b) => a.startSec - b.startSec);
        if (mapped.length > 0) setLyrics(mapped);
      } catch {
        /* no lyrics row, the strip still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry, hasVocal]);

  // Tunings for the instrument, from the backend's table when it has arrived.
  const tuningPitches = caps?.tab_tuning_pitches && Object.keys(caps.tab_tuning_pitches).length > 0
    ? caps.tab_tuning_pitches
    : FALLBACK_TUNING_PITCHES;
  const tuningOptions = useMemo(
    () => Object.keys(tuningPitches).filter((id) => id.startsWith(`${chordInstrument}-`)).sort(),
    [tuningPitches, chordInstrument],
  );
  const tuningId = tuningOptions.includes(chordTuning) ? chordTuning : (tuningOptions[0] ?? chordTuning);
  useEffect(() => {
    if (tuningId !== chordTuning) setChordTuning(tuningId);
  }, [tuningId, chordTuning, setChordTuning]);
  const tuningMidi = useMemo(() => tuningPitches[tuningId] ?? [], [tuningPitches, tuningId]);

  const shapesFor = useCallback(
    (span: ChordSpan | undefined): ChordShape[] => {
      if (!span || tuningMidi.length === 0 || span.rootPc < 0 || span.pitchClasses.length === 0) return [];
      try {
        return bestShapes(tuningId, tuningMidi, toChordSpec(span), capo);
      } catch {
        return [];
      }
    },
    [tuningId, tuningMidi, capo],
  );

  const chords = track?.chords ?? [];
  // Before the first chord the rail previews the opening chords.
  const railIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentSpan = chords[railIndex];
  const currentShapes = useMemo(() => shapesFor(currentSpan), [shapesFor, currentSpan]);
  const voicingKey = currentSpan ? `${currentSpan.symbol}|${tuningId}|${capo}` : '';
  const voicingIndex = currentShapes.length > 0
    ? (((voicingPick[voicingKey] ?? 0) % currentShapes.length) + currentShapes.length) % currentShapes.length
    : 0;
  const currentShape = currentShapes[voicingIndex];
  const cycleVoicing = (dir: 1 | -1) => {
    if (!voicingKey || currentShapes.length < 2) return;
    setVoicingPick((prev) => ({ ...prev, [voicingKey]: (prev[voicingKey] ?? 0) + dir }));
  };
  const upcoming = useMemo(
    () => [chords[railIndex + 1], chords[railIndex + 2]].filter((s): s is ChordSpan => !!s),
    [chords, railIndex],
  );

  // Frame source: the shared play-along clock while our track is in the
  // engine; a parked view sits at the start of the song.
  const handle = usePlayAlong(entry, (sec) => canvasRef.current?.draw(sec));
  const { isSameTrack, clock } = handle;
  const getTime = useCallback(() => (isSameTrack ? clock.read() : 0), [isSameTrack, clock]);
  // Parked (the engine holds another track): show the start of the song rather
  // than freezing on whatever frame was drawn last. usePlayAlong only frames
  // while OUR track is loaded, so this is the one redraw it will not issue.
  useEffect(() => {
    if (!isSameTrack) canvasRef.current?.draw(0);
  }, [isSameTrack, track]);

  useWheelZoom(bodyRef, (factor) => setZoom((z) => clampZoom(z * factor)));
  const pxPerSec = BASE_PX_PER_SEC * zoom;

  const onSeek = useCallback(
    (sec: number) => {
      if (!isSameTrack) return; // the transport's Play loads this track first
      handle.seek(sec);
    },
    [isSameTrack, handle],
  );

  const buildChords = async (source: 'auto' | 'chroma') => {
    if (!entry) return;
    setBusy(source === 'chroma' ? 'chroma' : 'chords');
    try {
      const built = await makeChordTrack(entry.id, { source });
      logInfo('score', `Chord track built for "${entry.title}"${built ? ` (${built.engine})` : ''}`);
      onArtifactsChanged();
    } catch (e) {
      logError('score', `Chord track failed: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const buildLeadSheet = async () => {
    if (!entry || !newestMidi) return;
    setBusy('lead-sheet');
    try {
      await makeArrangement(entry.id, { style: 'lead-sheet', source_artifact_id: newestMidi.id });
      logInfo('score', `Lead sheet arranged for "${entry.title}"`);
      onArtifactsChanged();
    } catch (e) {
      logError('score', `Lead sheet failed: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const sourceBadge = track
    ? track.source.method === 'harmony'
      ? { text: 'from lead sheet', className: 'text-emerald-200 border-emerald-500/40 bg-emerald-500/10' }
      : { text: 'estimated from audio', className: 'text-amber-200 border-amber-500/40 bg-amber-500/10' }
    : null;

  const keyText = track && track.key.tonic ? `${track.key.tonic} ${track.key.mode}`.trim() : '';

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-[#0a080f] text-zinc-300">
      {/* Header: source badge, instrument / tuning / capo, rebuild. */}
      <div className="h-8 shrink-0 border-b border-white/5 bg-black/30 flex items-center gap-2 px-2 text-[9px] font-mono">
        <Music2 className="w-3 h-3 text-emerald-300 shrink-0" aria-hidden="true" />
        <span className="text-[8px] font-black uppercase tracking-widest text-emerald-200">Chords</span>
        {sourceBadge && (
          <span className={`px-1.5 py-0.5 rounded border text-[8px] ${sourceBadge.className}`} title="How this chord track was derived">
            {sourceBadge.text}
          </span>
        )}
        <span className="mx-1 w-px h-4 bg-white/10" />
        <label htmlFor="score-chord-instrument" className="text-zinc-500 select-none">INSTRUMENT</label>
        <select
          id="score-chord-instrument"
          name="score-chord-instrument"
          className="form-select text-[8px] px-1 py-0.5"
          value={chordInstrument}
          onChange={(e) => setChordInstrument(e.target.value as ChordInstrument)}
        >
          {INSTRUMENTS.map((inst) => (
            <option key={inst} value={inst}>{inst}</option>
          ))}
        </select>
        <label htmlFor="score-chord-tuning" className="text-zinc-500 select-none">TUNING</label>
        <select
          id="score-chord-tuning"
          name="score-chord-tuning"
          className="form-select text-[8px] px-1 py-0.5"
          value={tuningId}
          onChange={(e) => setChordTuning(e.target.value)}
          disabled={tuningOptions.length === 0}
        >
          {tuningOptions.map((id) => (
            <option key={id} value={id}>{TUNING_LABELS[id] ?? id}</option>
          ))}
        </select>
        <label htmlFor="score-chord-capo" className="text-zinc-500 select-none">CAPO</label>
        <input
          id="score-chord-capo"
          name="score-chord-capo"
          type="number"
          min={0}
          max={CAPO_MAX}
          step={1}
          value={capo}
          onChange={(e) => setCapo(Math.min(CAPO_MAX, Math.max(0, Number(e.target.value) || 0)))}
          className="w-10 form-select text-[8px] px-1 py-0.5 tabular-nums"
        />
        <span className="flex-1" />
        {entry && chordArtifact && (
          <button
            type="button"
            className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40"
            onClick={() => void buildChords('chroma')}
            disabled={busy !== null}
            title="Estimate the chords again from the audio (chroma + Viterbi), replacing this chord track"
          >
            {busy === 'chroma' ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3 h-3" aria-hidden="true" />}
            REBUILD FROM AUDIO
          </button>
        )}
      </div>

      {/* Body. */}
      {!entry ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-[9px] font-mono text-zinc-600 p-3">
          Select a track in the library to read its chords.
        </div>
      ) : !chordArtifact ? (
        <div className="flex-1 min-h-0 flex items-center justify-center p-3">
          <div className="max-w-sm text-[9px] font-mono text-zinc-500 leading-relaxed p-3 border border-dashed border-white/10 rounded space-y-2">
            <div className="text-zinc-300">No chord track yet.</div>
            <div>
              MAKE CHORDS reads the lead sheet&apos;s harmony when one exists, otherwise it estimates chords from the audio.
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                className="btn-ghost text-[8px] py-1 px-2 flex items-center gap-1 disabled:opacity-40"
                onClick={() => void buildChords('auto')}
                disabled={busy !== null}
                title="Build the chord track for this entry"
              >
                {busy === 'chords' ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Music2 className="w-3 h-3" aria-hidden="true" />}
                MAKE CHORDS
              </button>
              {!hasLeadSheet && (
                <button
                  type="button"
                  className="btn-ghost text-[8px] py-1 px-2 flex items-center gap-1 disabled:opacity-40"
                  onClick={() => void buildLeadSheet()}
                  disabled={busy !== null || !newestMidi}
                  title={newestMidi ? 'Arrange a lead sheet from the newest MIDI so the chords come from written harmony' : 'Needs a MIDI artifact (Convert to MIDI first)'}
                >
                  {busy === 'lead-sheet' ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : null}
                  MAKE LEAD SHEET
                </button>
              )}
            </div>
          </div>
        </div>
      ) : loading || (!track && !loadError) ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-[9px] font-mono text-zinc-500 gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          Loading chord track…
        </div>
      ) : loadError || !track ? (
        <div className="flex-1 min-h-0 flex items-center justify-center p-3">
          <div className="max-w-sm text-[9px] font-mono text-rose-200/90 leading-relaxed p-3 border border-dashed border-rose-500/30 rounded space-y-2">
            <div>Could not load the chord track: {loadError ?? 'unknown error'}</div>
            <button
              type="button"
              className="btn-ghost text-[8px] py-1 px-2 disabled:opacity-40"
              onClick={() => void buildChords('auto')}
              disabled={busy !== null}
            >
              REBUILD
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 min-w-0 flex">
          {/* Diagram rail. */}
          <div className="w-44 shrink-0 border-r border-white/5 bg-black/20 flex flex-col items-center gap-2 p-2 overflow-y-auto">
            <div className="text-[8px] font-black uppercase tracking-widest text-zinc-500 self-start">Now</div>
            {currentSpan ? (
              <>
                <div className="text-base font-black tracking-wide text-emerald-100 leading-none" aria-live="off">
                  {currentSpan.symbol}
                </div>
                {currentShape ? (
                  <ChordDiagram shape={currentShape} strings={tuningMidi.length} label={currentSpan.symbol} size="lg" />
                ) : (
                  <div className="h-40 flex items-center text-[8px] font-mono text-zinc-600 text-center px-2">
                    {currentSpan.pitchClasses.length === 0 ? 'no chord' : 'no playable shape'}
                  </div>
                )}
                <div className="flex items-center gap-1 text-[8px] font-mono text-zinc-400">
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
                    onClick={() => cycleVoicing(-1)}
                    disabled={currentShapes.length < 2}
                    aria-label="Previous voicing"
                    title="Previous voicing"
                  >
                    <ChevronLeft className="w-3 h-3" aria-hidden="true" />
                  </button>
                  <span className="tabular-nums select-none" aria-live="polite">
                    {currentShapes.length > 0 ? `voicing ${voicingIndex + 1}/${currentShapes.length}` : '—'}
                    {currentShape?.curated ? ' ·' : ''}
                  </span>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
                    onClick={() => cycleVoicing(1)}
                    disabled={currentShapes.length < 2}
                    aria-label="Next voicing"
                    title="Next voicing"
                  >
                    <ChevronRight className="w-3 h-3" aria-hidden="true" />
                  </button>
                </div>
              </>
            ) : (
              <div className="text-[8px] font-mono text-zinc-600">No chords in this track.</div>
            )}
            {upcoming.length > 0 && (
              <>
                <div className="text-[8px] font-black uppercase tracking-widest text-zinc-500 self-start pt-1">Next</div>
                <div className="flex items-start gap-2">
                  {upcoming.map((span, i) => {
                    const shape = shapesFor(span)[0];
                    return (
                      <div key={`${span.id}-${i}`} className="flex flex-col items-center gap-0.5">
                        <div className="text-[10px] font-bold text-zinc-200 leading-none">{span.symbol}</div>
                        {shape ? (
                          <ChordDiagram shape={shape} strings={tuningMidi.length} label={span.symbol} size="sm" />
                        ) : (
                          <div className="w-16 h-20 flex items-center justify-center text-[8px] font-mono text-zinc-600">—</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          {/* Strip. */}
          <div ref={bodyRef} className="relative flex-1 min-w-0 min-h-0 flex flex-col">
            <ChordStripCanvas
              ref={canvasRef}
              track={track}
              lyrics={lyrics}
              pxPerSec={pxPerSec}
              getTime={getTime}
              onSeek={onSeek}
              onChordChange={setCurrentIndex}
              ariaLabel={`Chord strip for ${entry.title}: ${track.stats.chordCount} chords${keyText ? `, key ${keyText}` : ''}`}
            />
            <ZoomControls
              zoom={zoom}
              onIn={() => setZoom((z) => clampZoom(z * ZOOM_STEP))}
              onOut={() => setZoom((z) => clampZoom(z / ZOOM_STEP))}
              onReset={() => setZoom(1)}
            />
          </div>
        </div>
      )}

      {/* Footer: shared transport. */}
      <PlayAlongTransport
        entry={entry}
        isSameTrack={handle.isSameTrack}
        isPlaying={handle.isPlaying}
        otherTrackLoaded={handle.otherTrackLoaded}
        onTransport={handle.onTransport}
      >
        {track && (
          <span className="text-zinc-500 truncate" title="Key, tempo and chord count of this chord track">
            {keyText ? `${keyText} · ` : ''}
            {Math.round(track.timing.bpm)} BPM · {track.stats.chordCount} chords
          </span>
        )}
      </PlayAlongTransport>
    </div>
  );
};

export default ChordPlayAlong;
