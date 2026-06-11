import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileMusic, Guitar, LayoutGrid, Loader2, Music2, RefreshCw } from 'lucide-react';
import { useLibraryStore } from '../../state/libraryStore';
import { logError, logInfo } from '../../state/logStore';
import {
  convertMidiToMusicXml,
  exportArtifact,
  getNotationCapabilities,
  listNotationArtifacts,
  makeArrangement,
  makeTabs,
  notationArtifactUrl,
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

  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const musicXmlArtifacts = artifacts.filter((artifact) => artifact.kind === 'musicxml');
  const midiArtifacts = artifacts.filter((artifact) => artifact.kind === 'midi');
  const tabTunings = caps?.tab_tunings ?? DEFAULT_TUNINGS;
  const arrangementStyles = caps?.arrangement_styles ?? DEFAULT_STYLES;
  const exportFormats = selectedArtifact?.kind === 'musicxml'
    ? (caps?.musescore ? ['abc', 'pdf', 'svg'] : ['abc'])
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
              className="bg-black/40 border border-white/10 rounded text-[8px] text-zinc-200 px-1 py-1"
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
              className="bg-black/40 border border-white/10 rounded text-[8px] text-zinc-200 px-1 py-1"
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
              className="bg-black/40 border border-white/10 rounded text-[8px] text-zinc-200 px-1 py-1"
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
                className="w-full bg-black/40 border border-white/10 rounded text-[8px] text-zinc-200 px-1 py-1"
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
            className="w-full bg-black/40 border border-white/10 rounded text-[8px] text-zinc-200 px-1 py-1"
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
                <div className="text-[9px] font-black uppercase tracking-widest">{artifact.kind}</div>
                <div className="text-[8px] font-mono truncate opacity-70">{artifact.engine || 'artifact'}</div>
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
            {selectedArtifact ? `${selectedArtifact.kind} · ${selectedArtifact.id}` : 'No artifact selected'}
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
              href={notationArtifactUrl(selectedArtifact.id)}
              download
            >
              <Download className="w-3 h-3" /> DOWNLOAD
            </a>
          )}
        </div>
        <div className="flex-1 min-h-0 bg-[#0b0810]">
          {selectedArtifact?.kind === 'musicxml' ? (
            <MusicXmlPreview artifact={selectedArtifact} />
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

const MusicXmlPreview: React.FC<{ artifact: NotationArtifact }> = ({ artifact }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState('Loading MusicXML renderer…');

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const container = containerRef.current;
      if (!container) return;
      container.innerHTML = '';
      try {
        const [{ OpenSheetMusicDisplay }, res] = await Promise.all([
          import('opensheetmusicdisplay'),
          fetch(notationArtifactUrl(artifact.id)),
        ]);
        if (!res.ok) throw new Error(`MusicXML HTTP ${res.status}`);
        const xml = await res.text();
        if (cancelled) return;
        const osmd = new OpenSheetMusicDisplay(container, {
          backend: 'svg',
          autoResize: true,
          drawTitle: true,
          drawingParameters: 'compacttight',
        });
        await osmd.load(xml);
        if (cancelled) return;
        osmd.render();
        setStatus('');
      } catch (e) {
        if (cancelled) return;
        setStatus(`Preview unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [artifact.id]);

  return (
    <div className="h-full overflow-auto bg-white text-black">
      {status && <div className="p-4 text-xs font-mono text-zinc-600">{status}</div>}
      <div ref={containerRef} className="min-h-full p-4" />
    </div>
  );
};

const TabPreview: React.FC<{ artifact: NotationArtifact }> = ({ artifact }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState('Loading tab renderer…');

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
        });
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
      try {
        api?.destroy();
      } catch {
        // ignore teardown errors
      }
    };
  }, [artifact.id]);

  return (
    <div className="h-full overflow-auto bg-white text-black">
      {status && <div className="p-4 text-xs font-mono text-zinc-600">{status}</div>}
      <div ref={containerRef} className="min-h-full" />
    </div>
  );
};