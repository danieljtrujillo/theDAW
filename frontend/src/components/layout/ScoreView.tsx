import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileMusic, Gamepad2, Guitar, LayoutGrid, Loader2, Minus, Music2, Music4, Pause, Play, Plus, RefreshCw } from 'lucide-react';
import { useLibraryStore, type LibraryEntry } from '../../state/libraryStore';
import { usePlayerStore } from '../../state/playerStore';
import { logError, logInfo } from '../../state/logStore';
import {
  buildTimeMap,
  createCursorDriver,
  createScoreClock,
  findStepIndexBySeconds,
  type CursorDriver,
  type ScoreClock,
  type ScoreTimeMap,
} from './scoreTimeMap';
import {
  convertMidiToMusicXml,
  exportArtifact,
  getNotationCapabilities,
  listNotationArtifacts,
  makeArrangement,
  makeChordTrack,
  makeTabs,
  notationArtifactUrl,
  notationPackUrl,
  type NotationArtifact,
  type NotationCapabilities,
} from '../../lib/notationClient';
import type { AlphaTabApi } from '@coderline/alphatab';
import { effectiveZoom } from '../../lib/canvasScale';
import {
  A4_RATIO,
  applySheetEngraving,
  clampZoom,
  describeArtifact,
  NOTE_HIGHLIGHT_COLOR,
  PAGE_GAP,
  prepareMusicXml,
  useWheelZoom,
  ZOOM_DEFAULT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  ZoomControls,
  type ExternalMediaOutput,
} from './score/scoreShared';
import { fitZoomToPage, type FitReport } from './score/scoreFit';
import {
  allowedModes,
  modeForInstrument,
  PLAY_ALONG_INSTRUMENTS,
  usePlayAlongStore,
  type PlayAlongInstrument,
  type PlayAlongMode,
} from '../../state/playAlongStore';
import { ModeSwitch } from './score/playAlong/ModeSwitch';
import { applyInstrumentPreset, discoverParts, knownParts, useKnownParts } from './score/playAlong/partRegistry';

// The play-along views load on demand: OSMD and alphaTab are already dynamic
// imports in the PAGE view, three.js has its own chunk, and none of them is
// needed to show a page of sheet music.
const SheetStrip = React.lazy(() => import('./score/strip/SheetStrip'));
const TabStrip = React.lazy(() => import('./score/strip/TabStrip'));
const ChordPlayAlong = React.lazy(() => import('./score/chords/ChordPlayAlong'));
const Highway = React.lazy(() => import('./score/highway/Highway'));
const BeatSaberPackView = React.lazy(() => import('./score/beatsaber/BeatSaberPackView'));
const BeatSaberExportPopover = React.lazy(() => import('./score/beatsaber/BeatSaberExportPopover'));

const INSTRUMENT_LABELS: Record<PlayAlongInstrument, string> = {
  all: 'All parts',
  guitar: 'Guitar',
  bass: 'Bass',
  keys: 'Keys',
  drums: 'Drums',
  vocals: 'Vocals',
  strings: 'Strings',
};

/** Artifact kinds whose views work without a library track (a strip or a
 *  page can be read unplayed); everything else needs audio to derive chords. */
const KINDS_WITHOUT_ENTRY = ['musicxml', 'alphatex', 'notechart', 'chordtrack'];

const LazyFallback: React.FC = () => (
  <div className="h-full grid place-items-center text-[10px] font-mono text-zinc-500">Loading…</div>
);

const DEFAULT_TUNINGS = [
  'guitar-standard',
  'guitar-drop-d',
  'guitar-7-string',
  'bass-standard',
  'bass-5-string',
  'ukulele-standard',
];

const DEFAULT_STYLES = ['lead-sheet', 'piano-reduction', 'simplified', 'band-score'];

export const ScoreView: React.FC = () => {
  const selectedEntryId = useLibraryStore((s) => s.selectedEntryId);
  const entries = useLibraryStore((s) => s.entries);
  const entry = useMemo(
    () => entries.find((candidate) => candidate.id === selectedEntryId) ?? null,
    [entries, selectedEntryId],
  );
  const [artifacts, setArtifacts] = useState<NotationArtifact[]>([]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [caps, setCaps] = useState<NotationCapabilities | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [makingTabs, setMakingTabs] = useState(false);
  const [tabInstrument, setTabInstrument] = useState('guitar');
  const [tabTuning, setTabTuning] = useState('guitar-standard');
  const [tabCapo, setTabCapo] = useState(0);
  const [tabDifficulty, setTabDifficulty] = useState('medium');
  const [arrangeStyle, setArrangeStyle] = useState('piano-reduction');
  const [arranging, setArranging] = useState(false);
  const [makingChords, setMakingChords] = useState(false);
  // Beat Saber export popover: open flag, and the part names it offers (learnt
  // from a loaded view or fetched from the sheet's part-list; null = all).
  const [bsOpen, setBsOpen] = useState(false);
  const [bsParts, setBsParts] = useState<string[] | null>(null);
  const bsForRef = useRef<string | null>(null);
  const mode = usePlayAlongStore((s) => s.mode);
  const setMode = usePlayAlongStore((s) => s.setMode);
  const setSkin = usePlayAlongStore((s) => s.setSkin);
  const instrument = usePlayAlongStore((s) => s.instrument);
  const setInstrument = usePlayAlongStore((s) => s.setInstrument);
  // The global artist/composer name now lives in Settings (notation.artist); the
  // sheet preview reads it directly when rendering.

  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const musicXmlArtifacts = artifacts.filter((artifact) => artifact.kind === 'musicxml');
  const midiArtifacts = artifacts.filter((artifact) => artifact.kind === 'midi');
  const tabTunings = caps?.tab_tunings ?? DEFAULT_TUNINGS;
  const arrangementStyles = caps?.arrangement_styles ?? DEFAULT_STYLES;
  // Ask the backend what it can actually export rather than deciding here. The
  // old form hardcoded `caps.musescore ? ['abc','pdf','svg'] : ['abc']`, which
  // meant that on a machine without MuseScore the only button offered was ABC,
  // hiding the headless-OSMD PDF and the Unity note chart even though both work.
  // capabilities().formats already accounts for the OSMD renderer and MuseScore
  // separately, so intersecting it with what the export ROUTE accepts is the
  // honest answer. musicxml and midi are inputs here, never export targets.
  const EXPORTABLE_FROM_SHEET = ['pdf', 'abc', 'svg', 'notechart', 'beatsaber'];
  const exportFormats = selectedArtifact?.kind === 'musicxml'
    ? EXPORTABLE_FROM_SHEET.filter((fmt) => (caps?.formats ?? []).includes(fmt))
    : [];
  // Which play-along views the selected artifact supports. A Beat Saber pack
  // has its own card; anything that is not a sheet, tab, chart or chord track
  // (a MIDI, a vocal transcript) only offers chords, and only with a track to
  // derive them from.
  const selectedKind = selectedArtifact?.kind ?? null;
  const hasEntry = !!entry;
  const allowed = useMemo<PlayAlongMode[]>(() => {
    if (!selectedKind || selectedKind === 'beatsaber') return [];
    if (KINDS_WITHOUT_ENTRY.includes(selectedKind) || hasEntry) return allowedModes(selectedKind);
    return [];
  }, [selectedKind, hasEntry]);
  // The persisted mode when this artifact supports it; else PAGE when the
  // artifact has a plain view; else the one view its kind has.
  const effectiveMode: PlayAlongMode = allowed.includes(mode)
    ? mode
    : allowed.includes('page')
      ? 'page'
      : (allowed[0] ?? 'page');
  const selectedParts = useKnownParts(selectedArtifact?.id ?? null);
  const modeHint = selectedParts && selectedParts.length >= 5 && effectiveMode === 'page' && allowed.includes('strip')
    ? `${selectedParts.length} staves — try STRIP`
    : undefined;
  const analysisBpmRaw = entry?.analysis?.bpm;
  const analysisBpm = typeof analysisBpmRaw === 'number' && Number.isFinite(analysisBpmRaw) ? analysisBpmRaw : null;

  const loadArtifacts = async () => {
    if (!selectedEntryId) return;
    setLoading(true);
    try {
      const next = await listNotationArtifacts(selectedEntryId);
      setArtifacts(next);
      setSelectedArtifactId((prev) => (
        prev && next.some((artifact) => artifact.id === prev)
          ? prev
          : (next.find((artifact) => artifact.kind === 'musicxml') ?? next[0] ?? null)?.id ?? null
      ));
    } catch (e) {
      logError('score', `Could not load notation artifacts: ${e instanceof Error ? e.message : String(e)}`);
      setArtifacts([]);
      setSelectedArtifactId(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadArtifacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntryId]);

  useEffect(() => {
    let cancelled = false;
    void getNotationCapabilities()
      .then((next) => { if (!cancelled) setCaps(next); })
      .catch(() => { if (!cancelled) setCaps(null); });
    return () => { cancelled = true; };
  }, []);

  const makeSheetFromFirstMidi = async () => {
    if (!selectedEntryId) return;
    const firstMidi = midiArtifacts[0];
    if (!firstMidi) {
      logError('score', 'No MIDI artifact found yet. Run Convert to MIDI first.');
      return;
    }
    const legacyMidiId = (() => {
      try {
        const meta = JSON.parse(firstMidi.metadata_json || '{}') as { legacy_midi_id?: string };
        return meta.legacy_midi_id || firstMidi.source_ref || firstMidi.id.replace(/__artifact_midi$/, '');
      } catch {
        return firstMidi.source_ref || firstMidi.id.replace(/__artifact_midi$/, '');
      }
    })();
    setConverting(true);
    try {
      const artifact = await convertMidiToMusicXml(selectedEntryId, legacyMidiId);
      logInfo('score', `Created MusicXML score from ${legacyMidiId}`);
      await loadArtifacts();
      if (artifact?.id) setSelectedArtifactId(artifact.id);
    } catch (e) {
      logError('score', `Sheet conversion failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setConverting(false);
    }
  };

  const exportSelectedAs = async (format: string) => {
    if (!selectedEntryId || !selectedArtifact || selectedArtifact.kind !== 'musicxml') return;
    setExporting(format);
    try {
      const artifact = await exportArtifact(selectedEntryId, selectedArtifact.id, format);
      logInfo('score', `Exported ${format.toUpperCase()} from ${selectedArtifact.id}`);
      await loadArtifacts();
      if (artifact?.id) setSelectedArtifactId(artifact.id);
    } catch (e) {
      logError('score', `${format.toUpperCase()} export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
    }
  };

  const makeTabsFromFirstMidi = async () => {
    if (!selectedEntryId) return;
    const firstMidi = midiArtifacts[0];
    if (!firstMidi) {
      logError('score', 'No MIDI artifact found yet. Run Convert to MIDI first.');
      return;
    }
    setMakingTabs(true);
    try {
      const artifact = await makeTabs(selectedEntryId, {
        source_artifact_id: firstMidi.id,
        instrument: tabInstrument,
        tuning_name: tabTuning,
        capo: tabCapo,
        difficulty: tabDifficulty,
      });
      logInfo('score', `Arranged ${tabInstrument} tab (${tabTuning}) from ${firstMidi.id}`);
      await loadArtifacts();
      if (artifact?.id) setSelectedArtifactId(artifact.id);
    } catch (e) {
      logError('score', `Tab generation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMakingTabs(false);
    }
  };

  const onInstrumentChange = (value: string) => {
    setTabInstrument(value);
    setTabTuning(value === 'bass' ? 'bass-standard' : value === 'ukulele' ? 'ukulele-standard' : 'guitar-standard');
  };

  const makeArrangementFromMidis = async () => {
    if (!selectedEntryId) return;
    if (midiArtifacts.length === 0) {
      logError('score', 'No MIDI artifact found yet. Run Convert to MIDI first.');
      return;
    }
    setArranging(true);
    try {
      const req = arrangeStyle === 'band-score'
        ? { style: arrangeStyle, source_artifact_ids: midiArtifacts.map((m) => m.id) }
        : { style: arrangeStyle, source_artifact_id: midiArtifacts[0].id };
      const artifact = await makeArrangement(selectedEntryId, req);
      logInfo('score', `Arranged ${arrangeStyle} from ${midiArtifacts.length} MIDI artifact(s)`);
      await loadArtifacts();
      if (artifact?.id) setSelectedArtifactId(artifact.id);
    } catch (e) {
      logError('score', `Arrangement failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setArranging(false);
    }
  };

  // ---- Play-along integration ---------------------------------------------

  const makeChordsFromEntry = async () => {
    if (!selectedEntryId) return;
    setMakingChords(true);
    try {
      const artifact = await makeChordTrack(selectedEntryId, { source: 'auto' });
      logInfo('score', 'Built the chord track (from the lead sheet when one exists, else estimated from the audio)');
      await loadArtifacts();
      if (artifact?.id) {
        setSelectedArtifactId(artifact.id);
        setMode('chords');
      }
    } catch (e) {
      logError('score', `Chord track failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMakingChords(false);
    }
  };

  /** Write the INSTRUMENT preset into an artifact's part visibility, learning
   *  the parts of a sheet no view has rendered yet from its part-list. A note
   *  chart's parts are learnt by the highway when it loads. */
  const applyPreset = useCallback(async (target: NotationArtifact, inst: PlayAlongInstrument, force: boolean) => {
    if (applyInstrumentPreset(target.id, inst, { force })) return;
    if (target.kind !== 'musicxml') return;
    try {
      await discoverParts(target.id);
      applyInstrumentPreset(target.id, inst, { force });
    } catch (e) {
      logError('score', `Could not read the parts of ${target.id} for the ${inst} preset: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const onPlayAlongInstrument = (value: string) => {
    const inst: PlayAlongInstrument = (PLAY_ALONG_INSTRUMENTS as readonly string[]).includes(value)
      ? (value as PlayAlongInstrument)
      : 'all';
    setInstrument(inst);
    if (!selectedArtifact) return;
    // 'All parts' only resets the part filter; it does not pull the reader out
    // of the view they chose.
    if (inst !== 'all') {
      const pick = modeForInstrument(inst, selectedArtifact.kind);
      if (allowed.includes(pick.mode)) setMode(pick.mode);
      if (pick.skin) setSkin(pick.skin);
    }
    void applyPreset(selectedArtifact, inst, true);
  };

  // A preset chosen earlier follows the reader to the next artifact they open
  // (first sight only: manual PART toggles on an artifact are kept).
  useEffect(() => {
    if (!selectedArtifact || instrument === 'all') return;
    void applyPreset(selectedArtifact, instrument, false);
    // selectedArtifact is looked up from selectedArtifactId; the id is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArtifactId, instrument, applyPreset]);

  // The export popover belongs to one sheet; selecting another closes it.
  useEffect(() => {
    setBsOpen(false);
  }, [selectedArtifactId]);

  const openBeatSaber = () => {
    if (!selectedArtifact || selectedArtifact.kind !== 'musicxml') return;
    const id = selectedArtifact.id;
    bsForRef.current = id;
    const known = knownParts(id);
    setBsParts(known ? known.map((p) => p.name) : null);
    setBsOpen(true);
    if (!known) {
      discoverParts(id)
        .then((parts) => {
          if (bsForRef.current === id) setBsParts(parts.map((p) => p.name));
        })
        .catch(() => {
          /* the backend maps every pitched part when no selection is sent */
        });
    }
  };

  const onBeatSaberDone = async (artifact: NotationArtifact | null) => {
    setBsOpen(false);
    await loadArtifacts();
    if (artifact?.id) setSelectedArtifactId(artifact.id);
  };

  const renderPreview = (): React.ReactNode => {
    if (!selectedArtifact) {
      return (
        <div className="h-full grid place-items-center text-[10px] font-mono text-zinc-600">
          Select a score artifact to preview.
        </div>
      );
    }
    const lazy = (node: React.ReactNode) => <React.Suspense fallback={<LazyFallback />}>{node}</React.Suspense>;
    const chords = () => lazy(
      <ChordPlayAlong
        entry={entry}
        artifacts={artifacts}
        artifact={selectedArtifact}
        caps={caps}
        onArtifactsChanged={() => void loadArtifacts()}
      />,
    );
    const highway = () => lazy(
      <Highway
        entry={entry}
        artifact={selectedArtifact}
        artifacts={artifacts}
        onArtifactsChanged={() => void loadArtifacts()}
      />,
    );
    switch (selectedArtifact.kind) {
      case 'musicxml':
        if (effectiveMode === 'strip') return lazy(<SheetStrip artifact={selectedArtifact} entry={entry} artifacts={artifacts} />);
        if (effectiveMode === 'chords') return chords();
        if (effectiveMode === 'highway') return highway();
        return <MusicXmlPreview artifact={selectedArtifact} entry={entry} />;
      case 'alphatex':
        if (effectiveMode === 'strip') return lazy(<TabStrip artifact={selectedArtifact} entry={entry} />);
        if (effectiveMode === 'chords') return chords();
        return <TabPreview artifact={selectedArtifact} entry={entry} />;
      case 'notechart':
        return highway();
      case 'chordtrack':
        return chords();
      case 'beatsaber':
        return lazy(
          <BeatSaberPackView
            artifact={selectedArtifact}
            artifacts={artifacts}
            onOpenHighway={(source) => setSelectedArtifactId(source.id)}
          />,
        );
      default:
        if (effectiveMode === 'chords' && entry) return chords();
        return (
          <div className="h-full grid place-items-center text-[10px] font-mono text-zinc-500">
            {selectedArtifact.kind.toUpperCase()} artifact selected. Download or send it to MIDI/Score tools.
          </div>
        );
    }
  };

  return (
    <div className="h-full min-h-0 flex bg-[#07050a] text-zinc-200">
      <div className="w-64 shrink-0 border-r border-white/5 flex flex-col min-h-0 bg-black/30">
        <div className="p-2 border-b border-white/5 flex items-center gap-2">
          <FileMusic className="w-4 h-4 text-emerald-300" />
          <div className="min-w-0">
            <div className="text-[10px] font-black uppercase tracking-widest text-emerald-200">Score</div>
            <div className="text-[8px] font-mono text-zinc-500 truncate">{entry?.title ?? 'Select a library track'}</div>
          </div>
          <button
            className="ml-auto p-1 rounded border border-white/10 text-zinc-400 hover:text-zinc-100"
            onClick={() => void loadArtifacts()}
            disabled={!selectedEntryId || loading}
            title="Refresh notation artifacts"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          </button>
        </div>

        <div className="p-2 border-b border-white/5 flex gap-1">
          <button
            className="btn-ghost text-[8px] py-1 flex-1 flex items-center justify-center gap-1 disabled:opacity-40"
            onClick={() => void makeSheetFromFirstMidi()}
            disabled={!selectedEntryId || converting || midiArtifacts.length === 0}
            title={midiArtifacts.length === 0 ? 'Run Convert to MIDI first' : 'Convert the first MIDI artifact to MusicXML'}
          >
            {converting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Music2 className="w-3 h-3 text-emerald-300" />}
            MAKE SHEET
          </button>
        </div>

        <div className="p-2 border-b border-white/5 space-y-1.5">
          <div className="flex items-center gap-1">
            <Guitar className="w-3 h-3 text-pink-300" />
            <span className="text-[8px] font-black uppercase tracking-widest text-pink-200">Tabs</span>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <select
              id="score-tab-instrument"
              name="score-tab-instrument"
              aria-label="Tab instrument"
              className="form-select text-[8px] px-1 py-1"
              value={tabInstrument}
              onChange={(e) => onInstrumentChange(e.target.value)}
            >
              <option value="guitar">Guitar</option>
              <option value="bass">Bass</option>
              <option value="ukulele">Ukulele</option>
            </select>
            <select
              id="score-tab-difficulty"
              name="score-tab-difficulty"
              aria-label="Tab difficulty"
              className="form-select text-[8px] px-1 py-1"
              value={tabDifficulty}
              onChange={(e) => setTabDifficulty(e.target.value)}
            >
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <select
              id="score-tab-tuning"
              name="score-tab-tuning"
              aria-label="Tab tuning"
              className="form-select text-[8px] px-1 py-1"
              value={tabTuning}
              onChange={(e) => setTabTuning(e.target.value)}
            >
              {tabTunings.map((tuning) => (
                <option key={tuning} value={tuning}>{tuning}</option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              <label htmlFor="score-tab-capo" className="text-[8px] font-mono text-zinc-500 shrink-0">Capo</label>
              <input
                id="score-tab-capo"
                name="score-tab-capo"
                type="number"
                min={0}
                max={12}
                aria-label="Capo fret"
                className="w-full form-select text-[8px] px-1 py-1"
                value={tabCapo}
                onChange={(e) => setTabCapo(Math.max(0, Math.min(12, Number(e.target.value) || 0)))}
              />
            </div>
          </div>
          <button
            className="btn-ghost text-[8px] py-1 w-full flex items-center justify-center gap-1 disabled:opacity-40"
            onClick={() => void makeTabsFromFirstMidi()}
            disabled={!selectedEntryId || makingTabs || midiArtifacts.length === 0}
            title={midiArtifacts.length === 0 ? 'Run Convert to MIDI first' : 'Arrange the first MIDI artifact into tablature'}
          >
            {makingTabs ? <Loader2 className="w-3 h-3 animate-spin" /> : <Guitar className="w-3 h-3 text-pink-300" />}
            MAKE TABS
          </button>
        </div>

        <div className="p-2 border-b border-white/5 space-y-1.5">
          <div className="flex items-center gap-1">
            <LayoutGrid className="w-3 h-3 text-sky-300" />
            <span className="text-[8px] font-black uppercase tracking-widest text-sky-200">Arrange</span>
          </div>
          <select
            id="score-arrange-style"
            name="score-arrange-style"
            aria-label="Arrangement style"
            className="w-full form-select text-[8px] px-1 py-1"
            value={arrangeStyle}
            onChange={(e) => setArrangeStyle(e.target.value)}
          >
            {arrangementStyles.map((style) => (
              <option key={style} value={style}>{style}</option>
            ))}
          </select>
          <button
            className="btn-ghost text-[8px] py-1 w-full flex items-center justify-center gap-1 disabled:opacity-40"
            onClick={() => void makeArrangementFromMidis()}
            disabled={!selectedEntryId || arranging || midiArtifacts.length === 0}
            title={midiArtifacts.length === 0
              ? 'Run Convert to MIDI first'
              : (arrangeStyle === 'band-score'
                ? 'Arrange the MIDI stems into a band score (a full-mix stem and pitched drum transcriptions are left out; a drum-kit MIDI becomes a percussion staff)'
                : 'Arrange the first MIDI artifact')}
          >
            {arranging ? <Loader2 className="w-3 h-3 animate-spin" /> : <LayoutGrid className="w-3 h-3 text-sky-300" />}
            ARRANGE
          </button>
        </div>

        <div className="p-2 border-b border-white/5 space-y-1.5">
          <div className="flex items-center gap-1">
            <Music4 className="w-3 h-3 text-amber-300" />
            <span className="text-[8px] font-black uppercase tracking-widest text-amber-200">Play along</span>
          </div>
          <button
            className="btn-ghost text-[8px] py-1 w-full flex items-center justify-center gap-1 disabled:opacity-40"
            onClick={() => void makeChordsFromEntry()}
            disabled={!selectedEntryId || makingChords}
            title="Derive a chord track for the CHORDS view: from the lead sheet when one exists, else estimated from the audio"
          >
            {makingChords ? <Loader2 className="w-3 h-3 animate-spin" /> : <Music4 className="w-3 h-3 text-amber-300" />}
            MAKE CHORDS
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
          {artifacts.map((artifact) => {
            const active = artifact.id === selectedArtifactId;
            return (
              <button
                key={artifact.id}
                onClick={() => setSelectedArtifactId(artifact.id)}
                className={`w-full text-left rounded border px-2 py-1.5 transition-colors ${
                  active
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                    : 'border-white/5 bg-black/20 text-zinc-400 hover:text-zinc-100 hover:border-white/15'
                }`}
              >
                <div className="text-[9px] font-black uppercase tracking-widest">
                  {describeArtifact(artifact)}
                </div>
                <div className="text-[8px] font-mono truncate opacity-70">
                  {artifact.kind}
                  {artifact.engine ? ` · ${artifact.engine}` : ''}
                </div>
              </button>
            );
          })}
          {!loading && artifacts.length === 0 && (
            <div className="text-[9px] font-mono text-zinc-600 leading-relaxed p-3 border border-dashed border-white/10 rounded">
              No notation artifacts yet. Right-click a track → Convert to MIDI, then use MAKE SHEET.
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <div className="h-8 shrink-0 border-b border-white/5 bg-black/30 flex items-center gap-2 px-2">
          <span className="text-[9px] font-mono text-zinc-500 truncate flex-1">
            {selectedArtifact
              ? `${describeArtifact(selectedArtifact)} · ${selectedArtifact.kind} · ${selectedArtifact.id}`
              : 'No artifact selected'}
          </span>
          {selectedArtifact && allowed.length > 0 && (
            <ModeSwitch allowed={allowed} value={effectiveMode} onChange={setMode} hint={modeHint} />
          )}
          <label htmlFor="score-instrument" className="sr-only">Instrument preset</label>
          <select
            id="score-instrument"
            name="score-instrument"
            className="form-select text-[8px] px-1 py-0.5 shrink-0"
            value={instrument}
            disabled={!selectedArtifact}
            onChange={(e) => onPlayAlongInstrument(e.target.value)}
            title="Instrument preset: shows the parts and the view your instrument reads (drums: drum highway; guitar/bass: chords; keys/strings/vocals: strip)"
          >
            {PLAY_ALONG_INSTRUMENTS.map((inst) => (
              <option key={inst} value={inst}>{INSTRUMENT_LABELS[inst]}</option>
            ))}
          </select>
          {exportFormats.map((fmt) => (
            fmt === 'beatsaber' ? (
              <span key={fmt} className="relative">
                <button
                  className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40"
                  onClick={() => (bsOpen ? setBsOpen(false) : openBeatSaber())}
                  disabled={exporting !== null || !selectedEntryId}
                  title="Export a Beat Saber level pack (Info.dat + one .dat per difficulty + song.ogg) from this score"
                  aria-haspopup="dialog"
                  aria-expanded={bsOpen}
                  aria-controls="score-bs-popover"
                >
                  <Gamepad2 className="w-3 h-3 text-rose-300" />
                  BEAT SABER
                </button>
                {bsOpen && selectedEntryId && selectedArtifact && (
                  <React.Suspense fallback={null}>
                    <BeatSaberExportPopover
                      entryId={selectedEntryId}
                      artifact={selectedArtifact}
                      parts={bsParts}
                      caps={caps}
                      analysisBpm={analysisBpm}
                      onDone={(artifact) => void onBeatSaberDone(artifact)}
                      onClose={() => setBsOpen(false)}
                    />
                  </React.Suspense>
                )}
              </span>
            ) : (
              <button
                key={fmt}
                className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40"
                onClick={() => void exportSelectedAs(fmt)}
                disabled={exporting !== null}
                title={`Export ${fmt.toUpperCase()} from this score`}
              >
                {exporting === fmt ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {fmt.toUpperCase()}
              </button>
            )
          ))}
          {selectedArtifact && (
            <a
              className="btn-ghost text-[8px] py-1 flex items-center gap-1"
              href={
                selectedArtifact.kind === 'musicxml'
                  ? notationPackUrl(selectedArtifact.id)
                  : notationArtifactUrl(selectedArtifact.id)
              }
              download
              title={
                selectedArtifact.kind === 'musicxml'
                  ? 'Download MusicXML + PDF (PDF needs MuseScore)'
                  : 'Download this artifact'
              }
            >
              <Download className="w-3 h-3" /> DOWNLOAD
            </a>
          )}
        </div>
        <div className="flex-1 min-h-0 bg-[#0b0810]">
          {renderPreview()}
        </div>
      </div>
    </div>
  );
};

/** Sheet-music preview. Renders the score as real A4 pages laid out left-to-
 *  right (like an open book), engraved by OpenSheetMusicDisplay with proper
 *  margins so nothing runs off the edge. OSMD reads the host's offsetWidth to
 *  size a page, so we feed it a fixed one-page width, render, then flip the
 *  host into a horizontal strip of the resulting page <svg>s. Zooming re-renders
 *  (measures reflow + renumber); the footer ◀ ▶ and arrow keys turn pages by
 *  scrolling one page; the page width tracks the pane height (fit one sheet).
 *
 *  With FOLLOW on, the sheet also follows the track: a cursor walks the score
 *  against the global player's clock and the strip scrolls (and turns pages) to
 *  keep it in view. See scoreTimeMap.ts for the timing model. */
const MusicXmlPreview: React.FC<{ artifact: NotationArtifact; entry: LibraryEntry | null }> = ({ artifact, entry }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const osmdRef = useRef<any>(null);
  const zoomRef = useRef(ZOOM_DEFAULT);
  // True once the user zooms by hand (buttons, readout, Ctrl+wheel) on this
  // score. Until then every render auto-fits: a system taller than the page
  // lowers the zoom so nothing is drawn off the sheet. Reset per artifact.
  const userZoomedRef = useRef(false);
  const pageWRef = useRef(520);
  const footerTitleRef = useRef('');
  const footerArtistRef = useRef('');
  // What arrangement this sheet is ("Band Score", "Piano Reduction"). Printed in
  // the running footer so a page that leaves the app, on paper or in a PDF, still
  // says which arrangement it is rather than looking like every other sheet.
  const footerLabelRef = useRef('');
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  // Last auto-fit measurement, for the zoom readout's tooltip ("fitted to the
  // page"); null while the user drives the zoom or nothing was measured.
  const [fitInfo, setFitInfo] = useState<{ zoom: number; report: FitReport } | null>(null);
  const [status, setStatus] = useState('Loading MusicXML renderer…');
  const [pageCount, setPageCount] = useState(1);
  const [page, setPage] = useState(1); // 1-based page currently in view
  const [exportingPdf, setExportingPdf] = useState(false);
  const [follow, setFollow] = useState(true);

  // Follow-along state. All refs: the drive loop runs every frame and must
  // never re-render the tree.
  const mapRef = useRef<ScoreTimeMap | null>(null);
  const driverRef = useRef<CursorDriver | null>(null);
  const clockRef = useRef<ScoreClock | null>(null);
  // Bumped per OSMD load. A driver from a discarded StrictMode mount holds an
  // older generation and is refused the cursor, so it can never reparent its
  // image into the live mount's pages (updateCurrentPage resolves page divs by
  // a document-global id).
  const osmdGenRef = useRef(0);
  const cursorVisibleRef = useRef(false);
  const lastPageRef = useRef(1);
  const lastStepRef = useRef(-1);
  // Timestamps that keep the auto-scroll and the user out of each other's way.
  const autoScrollUntilRef = useRef(0);
  const manualUntilRef = useRef(0);
  // SVG elements currently painted in the karaoke highlight colour, so the
  // previous note can be restored when the cursor advances.
  const highlightedRef = useRef<Array<SVGElement | HTMLElement>>([]);

  const clearNoteHighlight = useCallback(() => {
    for (const el of highlightedRef.current) {
      try {
        el.style.fill = '';
        el.style.stroke = '';
      } catch {
        /* detached during a re-render */
      }
    }
    highlightedRef.current = [];
  }, []);

  // Karaoke highlight: paint the notehead(s) under the cursor. OSMD hands the
  // graphical notes straight to us (GNotesUnderCursor), and VexFlow's notes
  // expose their rendered <g> (getSVGGElement) — an inline style on every
  // child out-specifies VexFlow's fill attributes, no OSMD fork needed.
  const applyNoteHighlight = useCallback(() => {
    clearNoteHighlight();
    const cursor = osmdRef.current?.cursor as
      | { GNotesUnderCursor?: () => Array<{ getSVGGElement?: () => SVGGElement | undefined }> }
      | undefined;
    if (!cursor?.GNotesUnderCursor) return;
    try {
      for (const gn of cursor.GNotesUnderCursor()) {
        const g = gn?.getSVGGElement?.();
        if (!g) continue;
        const targets: Array<SVGElement | HTMLElement> = [g, ...Array.from(g.querySelectorAll<SVGElement>('*'))];
        for (const t of targets) {
          if (!t.style) continue;
          t.style.fill = NOTE_HIGHLIGHT_COLOR;
          t.style.stroke = NOTE_HIGHLIGHT_COLOR;
          highlightedRef.current.push(t);
        }
      }
    } catch {
      /* renderer swapped mid-frame — the next step repaints */
    }
  }, [clearNoteHighlight]);

  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const entryId = entry?.id ?? null;
  // The EDIT timeline loads under the sentinel id 'editor-timeline', which can
  // never equal a library entry id, so its live transport is excluded here for
  // free and the score never chases audio it has nothing to do with.
  const isSameTrack = !!entryId && engineEntryId === entryId;

  const computePageW = (): number => {
    const availH = (scrollRef.current?.clientHeight ?? 600) - 32;
    return Math.round(Math.min(1000, Math.max(360, availH / A4_RATIO)));
  };

  // Add a book-style running footer to each rendered page: "Song - Artist" and
  // the page number, centered in the bottom margin. OSMD has no footer/page-
  // number support, so we inject it into each page wrapper after every render
  // (render() recreates the pages, so this must run each time).
  const decoratePages = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const t = footerTitleRef.current;
    const a = footerArtistRef.current;
    const label = footerLabelRef.current;
    const credited = a ? (t ? `${t} - ${a}` : a) : t;
    const running = label ? (credited ? `${credited} - ${label}` : label) : credited;
    const pages = Array.from(host.children).filter(
      (n): n is HTMLElement => n.nodeType === 1,
    );
    pages.forEach((node, idx) => {
      let pageEl = node;
      if (pageEl.tagName.toLowerCase() === 'svg') {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;flex:0 0 auto;background:#fff;';
        pageEl.replaceWith(wrap);
        wrap.appendChild(pageEl);
        pageEl = wrap;
      } else {
        pageEl.style.position = 'relative';
      }
      const w = pageEl.clientWidth || pageWRef.current;
      const fs = Math.max(8, Math.round(w * 0.019));
      let f = pageEl.querySelector(':scope > .score-page-footer') as HTMLElement | null;
      if (!f) {
        f = document.createElement('div');
        f.className = 'score-page-footer';
        pageEl.appendChild(f);
      }
      f.style.cssText =
        `position:absolute;left:0;right:0;bottom:${Math.round(w * 0.022)}px;` +
        `text-align:center;pointer-events:none;color:#555;line-height:1.35;` +
        `font-family:Georgia,'Times New Roman',serif;`;
      f.innerHTML = '';
      if (running) {
        const l1 = document.createElement('div');
        l1.textContent = running;
        l1.style.cssText = `font-size:${fs}px;font-style:italic;`;
        f.appendChild(l1);
      }
      const l2 = document.createElement('div');
      l2.textContent = String(idx + 1);
      l2.style.cssText = `font-size:${fs}px;`;
      f.appendChild(l2);
    });
  }, []);

  // render() does not move the cursor, it REPLACES it: enableOrDisableCursors()
  // builds a brand-new Cursor on the fresh page divs and, because
  // RestoreCursorAfterRerender defaults true, copies the old iterator onto it.
  // So the cursor object is re-read (never cached), re-shown, show() is what
  // lifts the image above the opaque white page fill, update() alone leaves it
  // buried, and the driver re-derives its index from whatever iterator the new
  // cursor actually got rather than trusting the restore ran.
  const syncCursorToRender = useCallback(() => {
    const cursor = osmdRef.current?.cursor;
    if (!cursor) return;
    try {
      if (cursorVisibleRef.current) cursor.show();
      else cursor.hide();
      lastPageRef.current = cursor.currentPageNumber || 1;
    } catch {
      /* the cursor's page div is not in the document yet */
    }
    const map = mapRef.current;
    if (map) driverRef.current?.resync(map);
    lastStepRef.current = -1; // pages moved; re-check the scroll on the next step
    // render() rebuilt every SVG — the highlighted elements are gone with it.
    highlightedRef.current = [];
  }, []);

  // OSMD reads host.offsetWidth at render() to size one page, then we widen the
  // host into a horizontal strip so the page svgs sit side by side.
  //
  // Measure-and-fit: OSMD never splits a music system across pages, so a
  // system taller than the printable height (7-staff band scores at the default
  // zoom) is drawn through the bottom margin and clipped by the page SVG. After
  // the first render the tallest system is compared with PageHeight -
  // PageBottomMargin and, when it overflows and the user has not zoomed by
  // hand, the zoom is lowered by that ratio and the sheet re-rendered (at most
  // two extra passes, floor 0.3). The fit restarts from ZOOM_DEFAULT on every
  // automatic render (load, pane resize) so a pane that grows back gets its
  // zoom back too. renderScorePdf.mjs runs the same loop so the bundle PDF
  // paginates identically.
  const doRender = useCallback(() => {
    const osmd = osmdRef.current;
    const host = hostRef.current;
    if (!osmd || !host) return;
    try {
      host.style.display = 'block';
      host.style.width = `${pageWRef.current}px`;
      if (!userZoomedRef.current) zoomRef.current = ZOOM_DEFAULT;
      osmd.Zoom = zoomRef.current;
      osmd.render();
      if (!userZoomedRef.current) {
        const fit = fitZoomToPage(osmd, zoomRef.current, (z) => {
          osmd.Zoom = z;
          osmd.render();
        });
        zoomRef.current = fit.zoom;
        setZoom(fit.zoom);
        setFitInfo(fit.passes > 0 ? { zoom: fit.zoom, report: fit.report } : null);
      }
      host.style.display = 'flex';
      host.style.width = 'max-content';
      const count =
        osmd.GraphicSheet?.MusicPages?.length ||
        host.querySelectorAll('svg').length ||
        1;
      setPageCount(count);
      decoratePages();
      syncCursorToRender();
    } catch {
      /* render races with reload — ignore */
    }
  }, [decoratePages, syncCursorToRender]);

  const applyZoom = useCallback((next: number) => {
    userZoomedRef.current = true;
    setFitInfo(null);
    zoomRef.current = clampZoom(next);
    setZoom(zoomRef.current);
    doRender();
  }, [doRender]);

  const goToPage = useCallback((target: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const stride = pageWRef.current + PAGE_GAP;
    const total = Math.max(1, Math.round(el.scrollWidth / stride));
    const clamped = Math.min(total, Math.max(1, target));
    el.scrollTo({ left: (clamped - 1) * stride, behavior: 'smooth' });
    setPage(clamped);
  }, []);

  // Keep the cursor on screen KARAOKE-style: the strip glides continuously with
  // the note cursor instead of snapping page by page. The page number is now
  // only a readout + a keyboard/footer navigation unit. Measurements go through
  // getBoundingClientRect (viewport px) and are converted to LOCAL px with
  // effectiveZoom before touching scrollLeft — the shell's CSS zoom makes the
  // two spaces differ and mixing them drifts the glide.
  const keepCursorVisible = useCallback(() => {
    const scroller = scrollRef.current;
    const cursor = osmdRef.current?.cursor;
    const el = cursor?.cursorElement as HTMLElement | undefined;
    if (!scroller || !cursor || !el) return;
    const now = performance.now();
    if (now < manualUntilRef.current) return;

    // Track the page readout without snapping the view.
    const pageNumber = cursor.currentPageNumber || 1;
    if (pageNumber !== lastPageRef.current) {
      lastPageRef.current = pageNumber;
      setPage(pageNumber);
    }

    const c = el.getBoundingClientRect();
    if (c.width === 0 && c.height === 0) return; // hidden
    const v = scroller.getBoundingClientRect();
    // While the cursor sits inside the middle band, do nothing; once it leaves,
    // glide so it lands at the reading position (38% across, vertically centred).
    const padX = v.width * 0.28;
    const padY = v.height * 0.2;
    const inBandX = c.left >= v.left + padX && c.right <= v.right - padX;
    const inBandY = c.top >= v.top + padY && c.bottom <= v.bottom - padY;
    if (inBandX && inBandY) return;
    const ez = effectiveZoom(scroller);
    const targetLeft = scroller.scrollLeft + (c.left + c.width / 2 - v.left - v.width * 0.38) / ez;
    const targetTop = scroller.scrollTop + (c.top + c.height / 2 - v.top - v.height / 2) / ez;
    autoScrollUntilRef.current = now + 600;
    scroller.scrollTo({ left: Math.max(0, targetLeft), top: Math.max(0, targetTop), behavior: 'smooth' });
  }, []);

  // One frame of follow-along: read the audible position, find the step it
  // falls in, ask the driver for it. The common case is a binary search over a
  // few thousand entries and no DOM work at all, because the step index only
  // changes on note boundaries.
  const syncNow = useCallback(() => {
    const map = mapRef.current;
    const driver = driverRef.current;
    const clock = clockRef.current;
    if (!map || !driver || !clock || map.steps.length === 0) return;
    // Re-checked every frame, not just per render: the engine can change track
    // underneath a mounted score.
    if (!entryId || usePlayerStore.getState().currentEntryId !== entryId) return;
    const target = findStepIndexBySeconds(map.steps, clock.read());
    if (target < 0) return;
    driver.goTo(target);
    // The cursor only moves when the step changes, so the scroll check (two
    // forced layouts) is paid then rather than on every frame.
    const at = driver.index();
    if (at !== lastStepRef.current) {
      lastStepRef.current = at;
      applyNoteHighlight();
      keepCursorVisible();
    }
  }, [entryId, keepCursorVisible, applyNoteHighlight]);

  // Held in a ref so the artifact load effect can put the fresh cursor under
  // the playhead without taking a dependency that would re-fetch the score.
  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;

  // Play/pause the score's own track. When the engine holds something else the
  // same button loads this entry first, through the established library path,
  // so the footer and the cursor are never following different audio.
  const onTransport = useCallback(async () => {
    if (!entry) return;
    if (usePlayerStore.getState().currentEntryId === entry.id) {
      usePlayerStore.getState().toggle();
      return;
    }
    try {
      const blob = await useLibraryStore.getState().fetchAudioBlob(entry);
      await usePlayerStore.getState().load(blob, { label: entry.title, entryId: entry.id });
      usePlayerStore.getState().play();
    } catch (e) {
      logError('score', `Could not load "${entry.title}" for follow-along: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [entry]);

  useWheelZoom(scrollRef, (factor) => applyZoom(zoomRef.current * factor));

  useEffect(() => {
    let cancelled = false;
    const generation = osmdGenRef.current + 1;
    osmdGenRef.current = generation;
    const run = async () => {
      const host = hostRef.current;
      if (!host) return;
      host.innerHTML = '';
      try {
        const [{ OpenSheetMusicDisplay, CursorType }, res, settingsRes] = await Promise.all([
          import('opensheetmusicdisplay'),
          fetch(notationArtifactUrl(artifact.id)),
          fetch('/api/settings').catch(() => null),
        ]);
        if (!res.ok) throw new Error(`MusicXML HTTP ${res.status}`);
        const xml = await res.text();
        let artist = 'GANTASMO';
        try {
          if (settingsRes && settingsRes.ok) {
            const s = await settingsRes.json();
            artist = String(s?.notation?.artist ?? '').trim() || 'GANTASMO';
          }
        } catch {
          /* settings unavailable — fall back to the GANTASMO floor */
        }
        if (cancelled) return;
        const osmd = new OpenSheetMusicDisplay(host, {
          backend: 'svg',
          autoResize: false, // we drive width + re-render ourselves
          drawTitle: true,
          drawSubtitle: true, // the artist, centered under the title
          drawComposer: false, // artist is the subtitle; no top-right credit
          pageFormat: 'A4_P',
          pageBackgroundColor: '#FFFFFF',
        });
        // ThinLeft is a hairline at the note head, which is what a follow-along
        // cursor should look like; the default type is a wide translucent band.
        // follow:false plus FollowCursor=false takes OSMD out of the scrolling
        // business, its own handling calls scrollIntoView({block:'center'}) on
        // the nearest scrollable ancestor, which fights the page strip.
        // cursorsOptions is consumed inside render(), so it must be set now.
        osmd.cursorsOptions = [{ type: CursorType.ThinLeft, color: '#34d399', alpha: 0.95, follow: false }];
        osmd.FollowCursor = false;
        applySheetEngraving(osmd.EngravingRules);
        // Song as the centered title (wrapped if long), artist as the subtitle
        // under it; capture the song name for the running page footer.
        const prepared = prepareMusicXml(xml, computePageW(), artist);
        footerTitleRef.current = prepared.title;
        footerArtistRef.current = artist;
        // A plain sheet describes as "Sheet", which adds nothing next to the
        // title; only a real arrangement or tab label is worth printing.
        const label = describeArtifact(artifact);
        footerLabelRef.current = label === 'Sheet' ? '' : label;
        await osmd.load(prepared.xml);
        if (cancelled) return;
        osmdRef.current = osmd;
        // The map needs only Sheet.MusicPartManager, which exists as soon as
        // load() resolves, whereas osmd.cursor does not exist until the first
        // render(). Build it here and never again: it describes notated time,
        // which zoom and page width cannot change.
        mapRef.current = buildTimeMap(osmd);
        driverRef.current?.cancel();
        driverRef.current = createCursorDriver(() =>
          (osmdGenRef.current === generation ? osmdRef.current?.cursor ?? null : null),
        );
        pageWRef.current = computePageW();
        // A new score starts at the default zoom and may auto-fit; a manual
        // zoom on the previous score does not carry over.
        userZoomedRef.current = false;
        doRender();
        setStatus('');
        setPage(1);
        // Ours, not the user's: do not let it read as a manual scroll and
        // suppress the follow-along for the first seconds of the score.
        autoScrollUntilRef.current = performance.now() + 250;
        if (scrollRef.current) scrollRef.current.scrollLeft = 0;
        // After the reset, so a score opened mid-playback lands on the cursor
        // rather than on page 1.
        syncNowRef.current();
      } catch (e) {
        if (cancelled) return;
        setStatus(`Preview unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void run();
    return () => {
      cancelled = true;
      driverRef.current?.cancel();
      driverRef.current = null;
      mapRef.current = null;
      // The clock deliberately survives: it holds no per-score state, and the
      // drive loop is not re-created when only the artifact changes, so tearing
      // it down here would leave a playing score with no clock to follow.
      clockRef.current?.reset();
      const osmd = osmdRef.current;
      osmdRef.current = null;
      try {
        // Dispose() removes the cursor img from its page div, which throws when
        // a render already emptied that container.
        osmd?.cursor?.Dispose();
      } catch {
        /* page div already gone */
      }
    };
  }, [artifact.id, doRender]);

  // Track the page in view on horizontal scroll; re-fit page width to the pane
  // when it resizes (so one sheet keeps filling the height).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const stride = pageWRef.current + PAGE_GAP;
      setPage(Math.max(1, Math.round(el.scrollLeft / stride) + 1));
      // A scroll outside the window the follow-along just claimed is the user
      // taking over; hold the auto-scroll off so it does not yank the sheet
      // back while they are reading somewhere else.
      const now = performance.now();
      if (now > autoScrollUntilRef.current) manualUntilRef.current = now + 2500;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = computePageW();
        if (Math.abs(w - pageWRef.current) > 4) {
          pageWRef.current = w;
          doRender();
        }
      });
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [doRender]);

  // Keyboard paging (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        goToPage(page + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goToPage(page - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [page, goToPage]);

  // The cursor is shown only while it means something: following, and following
  // THIS score's track. A stale highlight against unrelated audio would claim a
  // sync that does not exist.
  useEffect(() => {
    cursorVisibleRef.current = follow && isSameTrack;
    syncCursorToRender();
  }, [follow, isSameTrack, syncCursorToRender]);

  // While playing, one rAF per frame. playerStore only refreshes currentTime on
  // the element's 'timeupdate', which fires about every 250 ms, two sixteenth
  // notes at 120 BPM, so the cursor would arrive late and in visible jerks.
  useEffect(() => {
    if (!follow || !isSameTrack || !isPlaying) return;
    if (!clockRef.current) clockRef.current = createScoreClock();
    let raf = 0;
    const tick = () => {
      syncNow();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [follow, isSameTrack, isPlaying, syncNow]);

  // While paused, seek() and seekByFraction() set currentTime synchronously, so
  // a store subscription puts the cursor under the scrub head without burning a
  // frame loop on an idle tab.
  useEffect(() => {
    if (!follow || !isSameTrack) return;
    if (!clockRef.current) clockRef.current = createScoreClock();
    clockRef.current.reset();
    syncNow();
    return usePlayerStore.subscribe((s, prev) => {
      if (s.isPlaying) return;
      if (s.currentTime === prev.currentTime && s.currentEntryId === prev.currentEntryId) return;
      clockRef.current?.reset();
      syncNow();
    });
  }, [follow, isSameTrack, syncNow]);

  /** Export every rendered page as one multi-page A4 PDF, client-side.
   *
   *  OSMD already lays the score out as real A4 portrait page <svg>s, so the
   *  pages are drawn straight into the PDF as VECTORS via svg2pdf.js: staff
   *  lines stay lines and text stays selectable text, rather than a screenshot.
   *  This deliberately does not go through the backend /export route, because
   *  that path engraves with the MuseScore CLI and returns ok=false with an
   *  install hint when the binary is absent (it is absent here), which left the
   *  SCORE tab with no working PDF at all. Rendering from the pages already on
   *  screen needs no external binary, so PDF works on every machine.
   *
   *  Both libraries are imported dynamically to keep them out of the initial
   *  bundle, matching how OSMD and alphaTab are already loaded in this file. */
  const exportPdf = useCallback(async () => {
    const host = hostRef.current;
    if (!host || exportingPdf) return;
    const pages = Array.from(host.querySelectorAll('svg'));
    if (pages.length === 0) {
      logError('score', 'Nothing to export: the sheet has not rendered yet.');
      return;
    }
    setExportingPdf(true);
    try {
      const [{ jsPDF }, { svg2pdf }] = await Promise.all([
        import('jspdf'),
        import('svg2pdf.js'),
      ]);
      // A4 portrait in millimetres, matching OSMD's pageFormat: 'A4_P'.
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      for (let i = 0; i < pages.length; i += 1) {
        if (i > 0) doc.addPage('a4', 'portrait');
        await svg2pdf(pages[i], doc, { x: 0, y: 0, width: 210, height: 297 });
      }
      const base = (footerTitleRef.current || 'score').replace(/[\\/:*?"<>|]/g, '_');
      doc.save(`${base}.pdf`);
      logInfo('score', `Exported ${pages.length}-page PDF from the rendered sheet`);
    } catch (e) {
      logError('score', `PDF export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExportingPdf(false);
    }
  }, [exportingPdf]);

  const pageLabel = pageCount <= 1 ? '1 page' : `Page ${page} / ${pageCount}`;
  // The readout doubles as the reset button; when auto-fit lowered the zoom the
  // tooltip says so, since 36% next to a 64% default otherwise looks like a
  // stray setting.
  const fitTitle = fitInfo
    ? `Fitted to the page: a system was taller than the sheet at ${Math.round(ZOOM_DEFAULT * 100)}%, ` +
      `so zoom was lowered to ${Math.round(fitInfo.zoom * 100)}% (tallest system now ` +
      `${Math.round(fitInfo.report.tallestBottom)} of ${Math.round(fitInfo.report.usable)} units). ` +
      'Click to reset zoom.'
    : 'Reset zoom';
  const otherTrackLoaded = !!entryId && !!engineEntryId && !isSameTrack;
  const transportLabel = !entry
    ? 'No track selected'
    : isSameTrack
      ? (isPlaying ? 'Pause' : 'Play')
      : `Play ${entry.title} and follow the score`;

  return (
    <div className="relative h-full flex flex-col bg-[#23222a]">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto p-4">
        {status && <div className="p-4 text-xs font-mono text-zinc-300">{status}</div>}
        {/* display/width are driven imperatively in doRender (block+fixed during
            OSMD's offsetWidth read, then flex+max-content for the page strip). */}
        <div
          ref={hostRef}
          className="gap-6 items-start [&>div]:shrink-0 [&>div]:bg-white [&>div]:shadow-2xl [&>div]:rounded-sm [&>svg]:shrink-0 [&>svg]:bg-white [&>svg]:shadow-2xl [&>svg]:rounded-sm"
        />
      </div>
      {/* Footer: follow-along transport + page navigation + zoom. */}
      <div className="shrink-0 h-8 border-t border-white/10 bg-[#0a080f] flex items-center justify-center gap-1.5 px-2 text-[10px] font-mono text-zinc-300">
        <button
          type="button"
          onClick={() => void onTransport()}
          disabled={!entry}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
          title={transportLabel}
          aria-label={transportLabel}
        >
          {isSameTrack && isPlaying
            ? <Pause className="w-3.5 h-3.5" />
            : <Play className="w-3.5 h-3.5 text-emerald-300" />}
        </button>
        <input
          id="score-follow"
          name="score-follow"
          type="checkbox"
          className="accent-emerald-400"
          checked={follow}
          onChange={(e) => setFollow(e.target.checked)}
        />
        <label htmlFor="score-follow" className="cursor-pointer select-none">FOLLOW</label>
        {otherTrackLoaded && (
          <span className="text-amber-300/90" title="The player is holding a different track, so the cursor is parked. Press play here to load this score's track.">
            OTHER TRACK
          </span>
        )}
        <span className="mx-1 w-px h-4 bg-white/10" />
        <button
          onClick={() => goToPage(page - 1)}
          disabled={page <= 1}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
          title="Previous page (←)"
          aria-label="Previous page"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="min-w-24 text-center tabular-nums">{pageLabel}</span>
        <button
          onClick={() => goToPage(page + 1)}
          disabled={page >= pageCount}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
          title="Next page (→)"
          aria-label="Next page"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <span className="mx-1 w-px h-4 bg-white/10" />
        <button
          onClick={() => applyZoom(zoomRef.current / ZOOM_STEP)}
          disabled={zoom <= ZOOM_MIN + 0.001}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
          title="Zoom out (Ctrl + scroll)"
          aria-label="Zoom out"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => applyZoom(ZOOM_DEFAULT)}
          className="min-w-10 text-center hover:text-white"
          title={fitTitle}
          aria-label={fitTitle}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={() => applyZoom(zoomRef.current * ZOOM_STEP)}
          disabled={zoom >= ZOOM_MAX - 0.001}
          className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
          title="Zoom in (Ctrl + scroll)"
          aria-label="Zoom in"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <span className="mx-1 w-px h-4 bg-white/10" />
        <button
          onClick={() => void exportPdf()}
          disabled={exportingPdf}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 disabled:opacity-40"
          title="Export every page as one A4 PDF"
          aria-label="Export the sheet as PDF"
        >
          {exportingPdf
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Download className="w-3.5 h-3.5" />}
          PDF
        </button>
      </div>
    </div>
  );
};

const TabPreview: React.FC<{ artifact: NotationArtifact; entry: LibraryEntry | null }> = ({ artifact, entry }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<AlphaTabApi | null>(null);
  const zoomRef = useRef(ZOOM_DEFAULT);
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [status, setStatus] = useState('Loading tab renderer…');
  const [follow, setFollow] = useState(true);
  const followRef = useRef(follow);
  followRef.current = follow;

  const engineEntryId = usePlayerStore((s) => s.currentEntryId);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const entryId = entry?.id ?? null;
  const isSameTrack = !!entryId && engineEntryId === entryId;

  const applyZoom = useCallback((next: number) => {
    const z = clampZoom(next);
    zoomRef.current = z;
    setZoom(z);
    const api = apiRef.current;
    if (api) {
      try {
        api.settings.display.scale = z;
        api.updateSettings();
        api.render();
      } catch {
        /* render races with reload — ignore */
      }
    }
  }, []);

  useWheelZoom(scrollRef, (factor) => applyZoom(zoomRef.current * factor));

  useEffect(() => {
    let cancelled = false;
    let api: AlphaTabApi | null = null;
    const run = async () => {
      const container = containerRef.current;
      if (!container) return;
      try {
        const [alphaTab, res] = await Promise.all([
          import('@coderline/alphatab'),
          fetch(notationArtifactUrl(artifact.id)),
        ]);
        if (!res.ok) throw new Error(`alphaTex HTTP ${res.status}`);
        const tex = await res.text();
        if (cancelled) return;
        // Karaoke follow: alphaTab's own beat cursor + element highlighting,
        // driven by theDAW's audio engine as the time axis (external media
        // mode). No soundfont, no alphaTab-side audio — position is pushed in
        // from the same latency-compensated clock the sheet cursor uses.
        const at = alphaTab as unknown as {
          PlayerMode?: { EnabledExternalMedia?: number };
          ScrollMode?: { Continuous?: number };
        };
        const externalMode = at.PlayerMode?.EnabledExternalMedia;
        api = new alphaTab.AlphaTabApi(container, {
          player: {
            ...(externalMode !== undefined
              ? {
                  playerMode: externalMode,
                  enableCursor: true,
                  enableAnimatedBeatCursor: true,
                  enableElementHighlighting: true,
                  ...(at.ScrollMode?.Continuous !== undefined ? { scrollMode: at.ScrollMode.Continuous } : {}),
                  scrollElement: scrollRef.current ?? undefined,
                }
              : { enablePlayer: false }),
          } as never,
          display: { scale: zoomRef.current },
        });
        apiRef.current = api;
        api.error.on((err) => {
          if (!cancelled) setStatus(`Tab render error: ${err instanceof Error ? err.message : String(err)}`);
        });
        api.renderFinished.on(() => {
          if (!cancelled) setStatus('');
        });
        api.tex(tex);
      } catch (e) {
        if (cancelled) return;
        setStatus(`Tab preview unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void run();
    return () => {
      cancelled = true;
      apiRef.current = null;
      try {
        api?.destroy();
      } catch {
        // ignore teardown errors
      }
    };
  }, [artifact.id]);

  // Follow-along: while OUR engine plays THIS entry, push its clock into
  // alphaTab every frame so the beat cursor + highlighted notes track the
  // audio like the sheet cursor does. Feature-detected — a build without the
  // external-media output just renders a static tab.
  useEffect(() => {
    if (!follow || !isSameTrack || !isPlaying) {
      try {
        apiRef.current?.pause?.();
      } catch {
        /* player not initialised */
      }
      return;
    }
    const clock = createScoreClock();
    let raf = 0;
    let alive = true;
    const out = (): ExternalMediaOutput | null => {
      const p = (apiRef.current as unknown as { player?: { output?: ExternalMediaOutput } } | null)?.player;
      return p?.output ?? null;
    };
    try {
      apiRef.current?.play?.();
    } catch {
      /* cursor still follows via position pushes */
    }
    const tick = () => {
      if (!alive) return;
      const ms = clock.read() * 1000;
      const o = out();
      try {
        if (o?.updatePosition) o.updatePosition(ms);
        else if (apiRef.current) (apiRef.current as unknown as { timePosition?: number }).timePosition = ms;
      } catch {
        /* mid-reload */
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clock.reset();
    };
  }, [follow, isSameTrack, isPlaying]);

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="h-full overflow-auto bg-white text-black">
        {status && <div className="p-4 text-xs font-mono text-zinc-600">{status}</div>}
        <div ref={containerRef} className="min-h-full" />
      </div>
      {/* Follow toggle — mirrors the sheet's checkbox. */}
      <div className="absolute left-2 top-2 flex items-center gap-2 rounded border border-black/10 bg-white/90 px-2 py-1 shadow">
        <input
          id="tab-follow"
          name="tab-follow"
          type="checkbox"
          checked={follow}
          onChange={(e) => setFollow(e.target.checked)}
          className="h-3 w-3 accent-emerald-500"
        />
        <label htmlFor="tab-follow" className="text-[9px] font-mono uppercase tracking-wider text-zinc-700">
          Follow
        </label>
        {follow && entryId && !isSameTrack && (
          <span className="text-[8px] font-mono uppercase tracking-wider text-amber-600">other track</span>
        )}
      </div>
      <ZoomControls
        zoom={zoom}
        onIn={() => applyZoom(zoomRef.current * ZOOM_STEP)}
        onOut={() => applyZoom(zoomRef.current / ZOOM_STEP)}
        onReset={() => applyZoom(ZOOM_DEFAULT)}
      />
    </div>
  );
};