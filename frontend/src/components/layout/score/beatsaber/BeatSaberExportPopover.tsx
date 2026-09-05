import React, { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { logError, logInfo } from '../../../../state/logStore';
import {
  exportArtifact,
  type BeatSaberExportOptions,
  type NotationArtifact,
  type NotationCapabilities,
} from '../../../../lib/notationClient';
import { DIFFICULTY_LABELS, DIFFICULTY_ORDER } from './beatsaberMeta';

export interface BeatSaberExportPopoverProps {
  entryId: string;
  /** The sheet (musicxml) to map. */
  artifact: NotationArtifact;
  /** Part names when known (from a loaded view or the part registry); null
   *  means "every pitched part" and hides the part checkboxes. */
  parts: string[] | null;
  caps: NotationCapabilities | null;
  /** The analysis BPM of the track, for the BPM selector's label. */
  analysisBpm?: number | null;
  onDone: (artifact: NotationArtifact | null) => void;
  onClose: () => void;
}

/** Element id the BEAT SABER button's aria-controls points at. */
export const BEATSABER_POPOVER_ID = 'score-bs-popover';

const DIFFICULTY_IDS: Record<string, string> = {
  Easy: 'score-bs-easy',
  Normal: 'score-bs-normal',
  Hard: 'score-bs-hard',
  Expert: 'score-bs-expert',
  ExpertPlus: 'score-bs-expertplus',
};

const DEFAULT_DIFFICULTIES: readonly string[] = ['Normal', 'Hard'];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Options for POST /{entry}/export format 'beatsaber': which difficulty
 * sets to write, the Info.dat BPM source, the map format version, whether to
 * encode song.ogg (needs ffmpeg on the backend), and which parts to map.
 * EXPORT registers a 'beatsaber' artifact; the pack card shows the result.
 */
export const BeatSaberExportPopover: React.FC<BeatSaberExportPopoverProps> = ({
  entryId,
  artifact,
  parts,
  caps,
  analysisBpm = null,
  onDone,
  onClose,
}) => {
  const ffmpegMissing = caps?.ffmpeg === false;
  const [chosen, setChosen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(DIFFICULTY_ORDER.map((d) => [d, DEFAULT_DIFFICULTIES.includes(d)])),
  );
  const [bpmSource, setBpmSource] = useState<'analysis' | 'chart'>('analysis');
  const [version, setVersion] = useState<2 | 3>(2);
  const [includeAudio, setIncludeAudio] = useState(!ffmpegMissing);
  const [partSel, setPartSel] = useState<boolean[]>(() => (parts ?? []).map(() => true));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstRef = useRef<HTMLInputElement | null>(null);

  // Parts may arrive after the popover opened (a fetch of the part-list).
  useEffect(() => {
    setPartSel((prev) => {
      const n = parts?.length ?? 0;
      if (prev.length === n) return prev;
      return Array.from({ length: n }, (_, i) => prev[i] ?? true);
    });
  }, [parts]);

  useEffect(() => {
    if (ffmpegMissing) setIncludeAudio(false);
  }, [ffmpegMissing]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => firstRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const difficulties = DIFFICULTY_ORDER.filter((d) => chosen[d]);
  const partIndices = partSel.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const partsFiltered = !!parts && parts.length > 0 && partSel.some((v) => !v);
  const canExport = !busy && difficulties.length > 0 && (!partsFiltered || partIndices.length > 0);

  const doExport = async () => {
    if (difficulties.length === 0) {
      setError('Pick at least one difficulty.');
      return;
    }
    if (partsFiltered && partIndices.length === 0) {
      setError('Pick at least one part.');
      return;
    }
    setBusy(true);
    setError('');
    const options: BeatSaberExportOptions = {
      difficulties,
      bpm_source: bpmSource,
      version,
      include_audio: includeAudio && !ffmpegMissing,
    };
    if (partsFiltered) options.parts = partIndices;
    try {
      const result = await exportArtifact(entryId, artifact.id, 'beatsaber', { ...options });
      logInfo('score', `Exported Beat Saber pack (${difficulties.join(', ')}, v${version}) from ${artifact.id}`);
      onDone(result);
    } catch (e) {
      const msg = errorText(e);
      setError(msg);
      logError('score', `Beat Saber export failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const bpmLabel = analysisBpm && Number.isFinite(analysisBpm)
    ? `Audio analysis (${Math.round(analysisBpm)} BPM)`
    : 'Audio analysis';

  return (
    <div
      id={BEATSABER_POPOVER_ID}
      role="dialog"
      aria-labelledby="score-bs-title"
      className="absolute right-0 top-full mt-1 z-50 w-72 rounded-lg border border-white/10 bg-[#0a080f] p-2.5 shadow-[0_8px_32px_rgba(0,0,0,0.75)] text-[10px] font-mono text-zinc-300 flex flex-col gap-2"
    >
      <h3 id="score-bs-title" className="text-[9px] font-black uppercase tracking-widest text-rose-200">
        Beat Saber export
      </h3>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Difficulties</legend>
        <div className="grid grid-cols-3 gap-x-2 gap-y-1">
          {DIFFICULTY_ORDER.map((d, i) => {
            const id = DIFFICULTY_IDS[d];
            return (
              <span key={d} className="flex items-center gap-1">
                <input
                  ref={i === 0 ? firstRef : undefined}
                  id={id}
                  name={id}
                  type="checkbox"
                  className="accent-rose-400"
                  checked={!!chosen[d]}
                  onChange={(e) => setChosen((prev) => ({ ...prev, [d]: e.target.checked }))}
                />
                <label htmlFor={id} className="cursor-pointer select-none">{DIFFICULTY_LABELS[d] ?? d}</label>
              </span>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="score-bs-bpm" className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">BPM</label>
          <select
            id="score-bs-bpm"
            name="score-bs-bpm"
            value={bpmSource}
            onChange={(e) => setBpmSource(e.target.value === 'chart' ? 'chart' : 'analysis')}
            className="form-select text-[9px] px-1 py-0.5"
            title="Which BPM Info.dat states: the audio analysis (the in-game grid matches the recording) or the chart's own tempo"
          >
            <option value="analysis">{bpmLabel}</option>
            <option value="chart">Chart tempo</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="score-bs-version" className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Format</label>
          <select
            id="score-bs-version"
            name="score-bs-version"
            value={version}
            onChange={(e) => setVersion(e.target.value === '3' ? 3 : 2)}
            className="form-select text-[9px] px-1 py-0.5"
            title="Map format version; v2 has the widest tool support"
          >
            <option value={2}>v2 (2.0.0)</option>
            <option value={3}>v3 (3.2.0)</option>
          </select>
        </div>
      </div>

      <div className="flex items-start gap-1.5">
        <input
          id="score-bs-audio"
          name="score-bs-audio"
          type="checkbox"
          className="mt-0.5 accent-rose-400"
          checked={includeAudio && !ffmpegMissing}
          disabled={ffmpegMissing}
          onChange={(e) => setIncludeAudio(e.target.checked)}
        />
        <label htmlFor="score-bs-audio" className={`select-none ${ffmpegMissing ? 'text-zinc-500' : 'cursor-pointer'}`}>
          Include song.ogg
          {ffmpegMissing && (
            <span className="block text-[9px] text-amber-300/90">
              No ffmpeg on the backend machine: the pack ships a README instead; encode the track to Vorbis and add song.ogg yourself.
            </span>
          )}
        </label>
      </div>

      {parts && parts.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Parts to map</legend>
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {parts.map((name, i) => {
              const id = `score-bs-part-${i}`;
              return (
                <span key={id} className="flex items-center gap-1">
                  <input
                    id={id}
                    name={id}
                    type="checkbox"
                    className="accent-rose-400"
                    checked={partSel[i] ?? true}
                    onChange={(e) => setPartSel((prev) => {
                      const next = prev.slice();
                      next[i] = e.target.checked;
                      return next;
                    })}
                  />
                  <label htmlFor={id} className="cursor-pointer select-none">{name || `Part ${i + 1}`}</label>
                </span>
              );
            })}
          </div>
          <span className="text-[9px] text-zinc-500">Percussion parts are never mapped to blocks.</span>
        </fieldset>
      )}

      {error && <div className="text-rose-300 break-words">{error}</div>}

      <div className="flex items-center justify-end gap-1.5 border-t border-white/10 pt-2">
        <button type="button" onClick={onClose} className="px-2 py-0.5 rounded hover:bg-white/10" disabled={busy}>
          CANCEL
        </button>
        <button
          type="button"
          onClick={() => void doExport()}
          disabled={!canExport}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-rose-500/40 bg-rose-500/15 text-rose-100 hover:bg-rose-500/25 disabled:opacity-40"
          title="Write Info.dat + one .dat per difficulty (+ song.ogg) and zip them"
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
          EXPORT
        </button>
      </div>
    </div>
  );
};

export default BeatSaberExportPopover;
