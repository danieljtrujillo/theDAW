import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, FileMusic, Guitar, LayoutGrid, Loader2, Maximize2, Minus, Music2, Pause, Play, Plus, RefreshCw } from 'lucide-react';
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
  makeTabs,
  notationArtifactUrl,
  notationPackUrl,
  type NotationArtifact,
  type NotationCapabilities,
} from '../../lib/notationClient';
import type { AlphaTabApi } from '@coderline/alphatab';

const DEFAULT_TUNINGS = [
  'guitar-standard',
  'guitar-drop-d',
  'guitar-7-string',
  'bass-standard',
  'bass-5-string',
];

const DEFAULT_STYLES = ['lead-sheet', 'piano-reduction', 'simplified', 'band-score'];

/** Tuning ids the backend stores, as a player would say them out loud. */
const TUNING_LABELS: Record<string, string> = {
  'guitar-standard': 'Standard',
  'guitar-drop-d': 'Drop D',
  'guitar-7-string': '7-String',
  'bass-standard': 'Standard',
  'bass-5-string': '5-String',
};

/** Artifact kinds that are not arrangements, as a short display name. */
const KIND_LABELS: Record<string, string> = {
  midi: 'MIDI',
  musicxml: 'Sheet',
  alphatex: 'Tab',
  abc: 'ABC',
  pdf: 'PDF',
  svg: 'SVG',
  notechart: 'Note Chart',
};

const titleCase = (value: string): string =>
  value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * What this artifact actually IS, in words: the arrangement style for a score
 * ("Band Score", "Piano Reduction"), or the instrument, tuning, capo and
 * difficulty for a tab ("Bass Tab, 5-String"). The backend has recorded all of
 * this in metadata_json since tabs and arrangements were built (style for
 * arrangements; instrument / tuning_name / capo / difficulty for tabs) and
 * nothing ever displayed it, so a band score and a piano reduction were
 * indistinguishable in the list, as were a drop-D guitar tab and a 5-string
 * bass tab. Falls back to the bare kind when an artifact carries no metadata,
 * which is the case for anything recovered off disk.
 */
const describeArtifact = (artifact: NotationArtifact): string => {
  let meta: Record<string, unknown> = {};
  try {
    // JSON.parse('null') yields null, not an object, and a metadata_json column
    // holding the literal "null" is a real row shape. Indexing that throws and
    // would take down the whole artifact list, so check the parsed type rather
    // than trusting the parse to have produced a record.
    const parsed: unknown = JSON.parse(artifact.metadata_json || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    meta = {};
  }
  const str = (key: string): string =>
    typeof meta[key] === 'string' ? (meta[key] as string).trim() : '';

  const style = str('style');
  if (style) return titleCase(style);

  const instrument = str('instrument');
  if (instrument) {
    const parts = [`${titleCase(instrument)} Tab`];
    const tuningName = str('tuning_name');
    if (tuningName) parts.push(TUNING_LABELS[tuningName] ?? titleCase(tuningName));
    const capo = Number(meta.capo ?? 0);
    if (Number.isFinite(capo) && capo > 0) parts.push(`Capo ${capo}`);
    const difficulty = str('difficulty');
    if (difficulty) parts.push(titleCase(difficulty));
    return parts.join(', ');
  }

  return KIND_LABELS[artifact.kind] ?? titleCase(artifact.kind);
};

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
  const EXPORTABLE_FROM_SHEET = ['pdf', 'abc', 'svg', 'notechart'];
  const exportFormats = selectedArtifact?.kind === 'musicxml'
    ? EXPORTABLE_FROM_SHEET.filter((fmt) => (caps?.formats ?? []).includes(fmt))
    : [];

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
    setTabTuning(value === 'bass' ? 'bass-standard' : 'guitar-standard');
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
              : (arrangeStyle === 'band-score' ? 'Arrange all MIDI stems into a band score' : 'Arrange the first MIDI artifact')}
          >
            {arranging ? <Loader2 className="w-3 h-3 animate-spin" /> : <LayoutGrid className="w-3 h-3 text-sky-300" />}
            ARRANGE
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
          {exportFormats.map((fmt) => (
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
          {selectedArtifact?.kind === 'musicxml' ? (
            <MusicXmlPreview artifact={selectedArtifact} entry={entry} />
          ) : selectedArtifact?.kind === 'alphatex' ? (
            <TabPreview artifact={selectedArtifact} />
          ) : selectedArtifact ? (
            <div className="h-full grid place-items-center text-[10px] font-mono text-zinc-500">
              {selectedArtifact.kind.toUpperCase()} artifact selected. Download or send it to MIDI/Score tools.
            </div>
          ) : (
            <div className="h-full grid place-items-center text-[10px] font-mono text-zinc-600">
              Select a score artifact to preview.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
const ZOOM_STEP = 1.12;
// Scores open (and reset) at 64% rather than 1:1. At full scale the engraving
// runs oversized for the pane; 0.64 fits more music per page and matches the
// size the sheet is actually read at. Also the target of the reset button, so
// resetting never jumps back to the rejected 100% size.
const ZOOM_DEFAULT = 0.64;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Ctrl/Cmd + scrollwheel zoom on the sheet. A native non-passive listener
 *  is required so the gesture can preventDefault (React's onWheel is passive).
 *  Plain wheel keeps scrolling the page so long scores stay navigable. */
function useWheelZoom(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  onZoomDelta: (factor: number) => void,
) {
  const cb = useRef(onZoomDelta);
  cb.current = onZoomDelta;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      cb.current(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [scrollRef]);
}

const ZoomControls: React.FC<{
  zoom: number;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
}> = ({ zoom, onIn, onOut, onReset }) => (
  <div className="absolute bottom-2 right-2 z-10 flex items-center gap-0.5 rounded-md border border-purple-500/40 bg-[#0a080f]/95 px-1 py-0.5 shadow-lg backdrop-blur-sm">
    <button
      className="p-1 rounded text-purple-200 hover:bg-purple-500/20 disabled:opacity-40"
      onClick={onOut}
      disabled={zoom <= ZOOM_MIN + 0.001}
      title="Zoom out (Ctrl + scroll)"
      aria-label="Zoom out"
    >
      <Minus className="w-3 h-3" />
    </button>
    <button
      className="min-w-9 text-center text-[9px] font-mono text-purple-200 hover:text-white px-0.5"
      onClick={onReset}
      title="Reset zoom"
      aria-label="Reset zoom to the default scale"
    >
      {Math.round(zoom * 100)}%
    </button>
    <button
      className="p-1 rounded text-purple-200 hover:bg-purple-500/20 disabled:opacity-40"
      onClick={onIn}
      disabled={zoom >= ZOOM_MAX - 0.001}
      title="Zoom in (Ctrl + scroll)"
      aria-label="Zoom in"
    >
      <Plus className="w-3 h-3" />
    </button>
    <button
      className="p-1 rounded text-purple-200 hover:bg-purple-500/20"
      onClick={onReset}
      title="Fit / reset zoom"
      aria-label="Fit to width"
    >
      <Maximize2 className="w-3 h-3" />
    </button>
  </div>
);

const A4_RATIO = 297 / 210; // A4 portrait height / width
const PAGE_GAP = 24; // px between side-by-side pages (matches gap-6)

// Media + symbolic extensions that must never show up in a sheet title.
const TITLE_EXT_RE =
  /\.(wav|mp3|flac|ogg|oga|m4a|aac|aif|aiff|opus|wma|alac|mp4|mov|webm|mkv|m4v|avi|mid|midi|musicxml|xml)$/i;

// Leading track numbers carried in from ripped/downloaded filenames:
// "04 - Song", "04. Song", "04_Song", "1-04 - Song", "[04] Song", "A4. Song".
// A separator after the number is REQUIRED, which is what keeps a title that
// genuinely opens on a number intact: "99 Luftballons", "7 Nation Army",
// "24K Magic" and "1979" have no separator, so none of them match.
const TRACK_BRACKETED_RE = /^\s*[[(]\s*(?:\d{1,2}[-.])?\d{1,3}\s*[\])]\s*[-–—._]*\s*/;
const TRACK_NUMBERED_RE = /^\s*(?:(?:\d{1,2}[-.])?\d{1,3}|[A-Ha-h]\d{1,2})\s*[-–—._)]+\s*/;
const HAS_LETTER_RE = /\p{L}/u;

/** Drop a leading track number. Bails out when the remainder has no letters,
 *  so an all-numeric title survives whole ("1-800-273-8255", "24 - 7"). */
const stripTrackPrefix = (t: string): string => {
  const stripped = t.replace(TRACK_BRACKETED_RE, '').replace(TRACK_NUMBERED_RE, '');
  return stripped !== t && HAS_LETTER_RE.test(stripped) ? stripped.trim() : t;
};

/** Sanitize a title for engraving: drop a trailing media extension and a
 *  leading track number, and treat music21's "Music21 Fragment" / "Music21"
 *  placeholders as empty. */
const cleanTitleText = (raw: string): string => {
  const t = (raw || '').trim().replace(TITLE_EXT_RE, '').trim();
  if (/^music21( fragment)?$/i.test(t)) return '';
  return stripTrackPrefix(t);
};

/** Word-wrap a long title by inserting newlines (OSMD splits labels on \n and
 *  centers each line) so a long song name lays out across the page instead of
 *  running off the side. Never truncates; hard-breaks a single oversized word. */
const wrapTitle = (t: string, budget: number): string => {
  if (t.length <= budget) return t;
  const lines: string[] = [];
  let cur = '';
  for (const w of t.split(/\s+/)) {
    let word = w;
    if (cur && (cur + ' ' + word).length > budget) {
      lines.push(cur);
      cur = '';
    }
    cur = cur ? cur + ' ' + word : word;
    while (cur.length > budget) {
      lines.push(cur.slice(0, budget));
      cur = cur.slice(budget);
      word = cur;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n');
};

/** Pre-process MusicXML before OSMD renders it so the title block reads like a
 *  real sheet: the SONG name as the centered Title (cleaned of media extensions,
 *  word-wrapped if long), and the ARTIST centered directly beneath it. OSMD maps
 *  <work-title> -> Title and <movement-title> -> Subtitle (confirmed in its
 *  reader), so the song goes in work-title and the artist in movement-title; the
 *  composer credit is disabled in the options so the artist never floats off to
 *  the top-right. Returns the cleaned song title for the running page footer. */
const prepareMusicXml = (
  xml: string,
  pageWidthPx: number,
  artist: string,
): { xml: string; title: string } => {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror')) return { xml, title: '' };
    const root = doc.documentElement;
    const budget = Math.max(16, Math.floor(pageWidthPx / 13));

    const song = cleanTitleText(
      (doc.querySelector('work > work-title')?.textContent ||
        doc.querySelector('movement-title')?.textContent ||
        '').trim(),
    );

    // Title slot (work-title) = wrapped song name.
    let work = doc.querySelector('work');
    if (!work) {
      work = doc.createElement('work');
      root.insertBefore(work, root.firstChild);
    }
    let workTitle = work.querySelector('work-title');
    if (!workTitle) {
      workTitle = doc.createElement('work-title');
      work.appendChild(workTitle);
    }
    workTitle.textContent = song ? wrapTitle(song, budget) : '';

    // Subtitle slot (movement-title) = artist, centered under the title.
    let movement = doc.querySelector('movement-title');
    if (!movement) {
      movement = doc.createElement('movement-title');
      if (work.nextSibling) root.insertBefore(movement, work.nextSibling);
      else root.appendChild(movement);
    }
    movement.textContent = artist || '';

    // Drop music21's placeholder credit-words so they don't print.
    for (const cw of Array.from(doc.querySelectorAll('credit-words'))) {
      if (/^music21( fragment)?$/i.test((cw.textContent || '').trim())) cw.textContent = '';
    }

    return { xml: new XMLSerializer().serializeToString(doc), title: song };
  } catch {
    return { xml, title: '' };
  }
};

/** Engraving rules that make OSMD output look like sheet music from a book:
 *  smaller text (the default title/labels are oversized for a fitted A4 page),
 *  tidy page margins so music never runs off the side, and compact, even
 *  system spacing. Applied before render; unknown keys on older builds no-op. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const applySheetEngraving = (rules: any): void => {
  if (!rules) return;
  try {
    rules.SheetTitleHeight = 2.2;
    rules.SheetSubtitleHeight = 1.4;
    rules.SheetComposerHeight = 1.5;
    rules.SheetAuthorHeight = 1.4;
    rules.TitleTopDistance = 5.0;
    rules.TitleBottomDistance = 1.0;
    rules.SpacingBetweenTextLines = 1.0;
    rules.MeasureNumberLabelHeight = 1.0;
    rules.InstrumentLabelTextHeight = 1.4;
    rules.LyricsHeight = 1.5;
    rules.InstantaneousTempoTextHeight = 1.6;
    rules.ContinuousTempoTextHeight = 1.4;
    // Generous page margins, especially top + bottom (the bottom margin also
    // houses the injected running footer + page number).
    rules.PageLeftMargin = 4.0;
    rules.PageRightMargin = 4.0;
    rules.PageTopMargin = 5.5;
    // Tall bottom margin: the music must clear the injected running footer +
    // page number that live in the bottom margin (see decoratePages).
    rules.PageBottomMargin = 14.0;
    rules.MinimumDistanceBetweenSystems = 4.0;
    rules.MinSkyBottomDistBetweenSystems = 2.0;
    rules.StaffDistance = 4.0;
    rules.BetweenStaffDistance = 4.0;
    rules.RenderMeasureNumbersOnlyAtSystemStart = true;
  } catch {
    /* older OSMD builds: ignore unsupported rules */
  }
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
  const pageWRef = useRef(520);
  const footerTitleRef = useRef('');
  const footerArtistRef = useRef('');
  // What arrangement this sheet is ("Band Score", "Piano Reduction"). Printed in
  // the running footer so a page that leaves the app, on paper or in a PDF, still
  // says which arrangement it is rather than looking like every other sheet.
  const footerLabelRef = useRef('');
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
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
  }, []);

  // OSMD reads host.offsetWidth at render() to size one page, then we widen the
  // host into a horizontal strip so the page svgs sit side by side.
  const doRender = useCallback(() => {
    const osmd = osmdRef.current;
    const host = hostRef.current;
    if (!osmd || !host) return;
    try {
      host.style.display = 'block';
      host.style.width = `${pageWRef.current}px`;
      osmd.Zoom = zoomRef.current;
      osmd.render();
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

  // Scroll the strip so the cursor stays on screen. A page change snaps through
  // the same goToPage() the footer arrows use, so an automatic page turn and a
  // manual one look identical; within a page a nudge keeps the cursor off the
  // edges. Measurements go through getBoundingClientRect because the shell
  // applies a CSS transform zoom and offset arithmetic drifts under it.
  const keepCursorVisible = useCallback(() => {
    const scroller = scrollRef.current;
    const cursor = osmdRef.current?.cursor;
    const el = cursor?.cursorElement as HTMLElement | undefined;
    if (!scroller || !cursor || !el) return;
    const now = performance.now();
    if (now < manualUntilRef.current) return;

    const pageNumber = cursor.currentPageNumber || 1;
    if (pageNumber !== lastPageRef.current) {
      lastPageRef.current = pageNumber;
      autoScrollUntilRef.current = now + 900; // covers the smooth scroll
      goToPage(pageNumber);
      return;
    }

    const c = el.getBoundingClientRect();
    if (c.width === 0 && c.height === 0) return; // hidden
    const v = scroller.getBoundingClientRect();
    const padX = v.width * 0.15;
    const padY = v.height * 0.2;
    const dx = c.left < v.left + padX || c.right > v.right - padX ? c.left - v.left - padX : 0;
    const dy = c.top < v.top + padY || c.bottom > v.bottom - padY ? c.top - v.top - padY : 0;
    if (dx === 0 && dy === 0) return;
    autoScrollUntilRef.current = now + 250;
    scroller.scrollLeft += dx;
    scroller.scrollTop += dy;
  }, [goToPage]);

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
      keepCursorVisible();
    }
  }, [entryId, keepCursorVisible]);

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
          title="Reset zoom"
          aria-label="Reset zoom"
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

const TabPreview: React.FC<{ artifact: NotationArtifact }> = ({ artifact }) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<AlphaTabApi | null>(null);
  const zoomRef = useRef(ZOOM_DEFAULT);
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const [status, setStatus] = useState('Loading tab renderer…');

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
        api = new alphaTab.AlphaTabApi(container, {
          player: { enablePlayer: false },
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

  return (
    <div className="relative h-full">
      <div ref={scrollRef} className="h-full overflow-auto bg-white text-black">
        {status && <div className="p-4 text-xs font-mono text-zinc-600">{status}</div>}
        <div ref={containerRef} className="min-h-full" />
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