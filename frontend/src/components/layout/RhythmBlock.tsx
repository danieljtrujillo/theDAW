/**
 * METER MAP block for the DETAILS panel.
 *
 * The rhythm engine (backend/modules/rhythm) reads metamorphic meter -- a
 * track that moves between 7/8, 4/4 and 6/8 comes back as a map of segments
 * rather than one wrong global guess -- plus tempo segments, syncopation,
 * swing, polymeter and cross-rhythms. It has had a full HTTP API and a cache
 * since it shipped and nothing in the UI called either, so the only way to map
 * a song was to run the module by hand.
 *
 * Analysis is on demand, never automatic: a full read is seconds of CPU per
 * track, and the cached result is returned as-is until MAP is pressed again.
 *
 * The map is drawn (MeterMapChart): blocks on a time lane, coloured by bar
 * length family, hatched when guessed, with tempo flags above and syncopation
 * per bar below. Hovering or focusing a block puts its numbers on the line
 * under the drawing. SAVE offers the same drawing as HTML, SVG, PNG and PDF,
 * beside the JSON and the Markdown report.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Activity, ChevronDown, Download, Loader2, Waves } from 'lucide-react';
import { logError, logInfo } from '../../state/logStore';
import { invalidateRhythm } from '../../state/djRhythmStore';
import { saveFile } from '../../lib/saveFile';
import { dataFromResult, describeSegment, type MapSegment } from '../../lib/meterMapLayout';
import {
  fmtTime,
  rhythmMarkdown,
  safeName,
  saveText,
  type AnalysisSummary,
  type MeterSegment,
  type RhythmResult,
} from './rhythmReport';
import { svgToPdf, svgToPng } from '../../lib/exportPicture';
import { MeterMapChart, MeterMapLegend } from './MeterMapChart';
import { meterMapHtml, meterMapSvgText } from './meterMapDraw';

type SaveFormat = 'json' | 'md' | 'html' | 'svg' | 'png' | 'pdf';

const SAVE_ITEMS: Array<{ format: SaveFormat; label: string; words: string }> = [
  { format: 'html', label: 'HTML', words: 'The drawing and the numbers as a page that opens in any browser' },
  { format: 'svg', label: 'SVG', words: 'The drawing as vectors; scales to any size' },
  { format: 'png', label: 'PNG', words: 'The drawing as a 2x image' },
  { format: 'pdf', label: 'PDF', words: 'The drawing as a one-page PDF, text kept as text' },
  { format: 'md', label: 'REPORT', words: 'The map, key and tempo as a readable Markdown report' },
  { format: 'json', label: 'JSON', words: 'The full map, tempo curve, beats and downbeats' },
];

export const RhythmBlock: React.FC<{
  entryId: string | null;
  title: string;
  analysis?: AnalysisSummary | null;
}> = ({ entryId, title, analysis }) => {
  const [result, setResult] = useState<RhythmResult | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<MapSegment | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState<SaveFormat | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  // Read the cache when the selection changes. A track nobody has mapped comes
  // back "pending", which is a state, not an error.
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setDetail(null);
    setPicked(null);
    if (!entryId) return;
    setLoading(true);
    void fetch(`/api/rhythm/${encodeURIComponent(entryId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j || j.status !== 'ready') return;
        setResult(j as RhythmResult);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  // Outside-click only: Escape is handled by a React onKeyDown on the menu
  // wrapper below (MarkComposer's pattern, LyricAnalysisPane.tsx), not a
  // native document listener. RhythmBlock is itself embedded in a popover
  // (ScoreView's METER MAP button, LyricAnalysisPane's STUDY bar) that has
  // its own document-level Escape handler; a same-target native listener
  // here fired alongside that one on every press, closing both at once. A
  // React onKeyDown's stopPropagation() reaches the real DOM event too, so
  // it actually shields the ancestor popover — a native document listener
  // registered independently cannot (stopPropagation only stops an event
  // moving to OTHER elements, not sibling listeners already on `document`).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
    };
  }, [menuOpen]);

  const run = useCallback(async () => {
    if (!entryId || running) return;
    setRunning(true);
    try {
      const r = await fetch(`/api/rhythm/${encodeURIComponent(entryId)}/run`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as RhythmResult;
      // The backend cache changed: a DJ deck holding this track re-reads its
      // bar lines now instead of trusting the miss it remembered.
      invalidateRhythm(entryId);
      setResult(j);
      setPicked(null);
      logInfo('rhythm', `Mapped ${title}${j.elapsed_sec ? ` in ${j.elapsed_sec}s` : ''}`);
    } catch (e) {
      logError('rhythm', `Meter mapping failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  }, [entryId, running, title]);

  const save = useCallback(
    async (format: SaveFormat) => {
      if (!result || saving) return;
      setMenuOpen(false);
      const stem = `${safeName(title)} - meter map`;
      if (format === 'json') {
        saveText(`${stem}.json`, JSON.stringify(result, null, 2), 'application/json', 'meter-map');
        return;
      }
      if (format === 'md') {
        saveText(`${stem}.md`, rhythmMarkdown(title, result, analysis), 'text/markdown', 'meter-report');
        return;
      }
      setSaving(format);
      try {
        const data = dataFromResult(result);
        const framed = {
          title,
          tempoBpm: result.tempo?.global_bpm ?? result.tempo?.bpm ?? analysis?.bpm ?? null,
          keyWords: analysis?.key ? `${analysis.key} ${analysis.scale ?? ''}`.trim() : null,
          analyzedAt: result.analyzed_at,
        };
        if (format === 'html') {
          saveText(`${stem}.html`, meterMapHtml(data, framed), 'text/html;charset=utf-8', 'meter-map');
          return;
        }
        const { svg, width, height } = meterMapSvgText(data, framed);
        if (format === 'svg') {
          void saveFile({ blob: new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), suggestedName: `${stem}.svg`, kind: 'image' });
          return;
        }
        if (format === 'png') {
          const blob = await svgToPng(svg, width, height, { background: '#0c0b12' });
          void saveFile({ blob, suggestedName: `${stem}.png`, kind: 'image' });
          return;
        }
        const blob = await svgToPdf(svg, width, height, { title: `${title} — meter map`, background: '#0c0b12' });
        void saveFile({ blob, suggestedName: `${stem}.pdf`, kind: 'meter-map' });
      } catch (e) {
        logError('rhythm', `Could not save the meter map as ${format.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSaving(null);
      }
    },
    [analysis, result, saving, title],
  );

  const segs = result?.meter_map ?? [];
  const tempo = result?.tempo;
  const data = result ? dataFromResult(result) : null;
  const shown = detail ?? (picked != null ? segs[picked] ?? null : null);
  const menuId = `meter-save-${uid}`;

  return (
    <div data-tour="meter-map" className="mt-3 p-2 rounded border border-fuchsia-500/25 bg-fuchsia-500/4">
      <div className="flex items-center justify-between mb-1 gap-2">
        <p className="text-[8px] font-mono text-fuchsia-300/80 uppercase tracking-widest flex items-center gap-1.5">
          <Waves className="w-3 h-3" /> METER MAP
        </p>
        <div className="flex items-center gap-1.5">
          {loading && <span className="text-[8px] font-mono text-zinc-600">loading…</span>}
          {!loading && !result && !running && (
            <span className="text-[8px] font-mono text-zinc-600">not mapped</span>
          )}
          {result && (
            <div
              ref={menuRef}
              className="relative"
              onKeyDown={(e) => {
                // Only while the menu is actually open: closed, Escape here
                // must fall through to whatever popover RhythmBlock itself
                // is embedded in (ScoreView's METER MAP button, STUDY's bar).
                if (e.key !== 'Escape' || !menuOpen) return;
                e.stopPropagation();
                setMenuOpen(false);
                saveButtonRef.current?.focus();
              }}
            >
              <button
                ref={saveButtonRef}
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                disabled={!!saving}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? menuId : undefined}
                className="btn-ghost text-[8px] py-0.5 flex items-center gap-1 disabled:opacity-40"
                title="Save the map: the drawing as HTML, SVG, PNG or PDF, the report as Markdown, the data as JSON"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3 text-fuchsia-300" />}
                SAVE
                <ChevronDown className="w-3 h-3" aria-hidden="true" />
              </button>
              {menuOpen && (
                <div
                  id={menuId}
                  role="menu"
                  aria-label="Save the meter map as"
                  className="et-opaque absolute right-0 top-full z-30 mt-1 flex w-64 flex-col rounded-md border border-white/10 bg-[#0a080f] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.6)]"
                >
                  {SAVE_ITEMS.map((it) => (
                    <button
                      key={it.format}
                      type="button"
                      role="menuitem"
                      onClick={() => void save(it.format)}
                      className="flex items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-white/10"
                      title={it.words}
                    >
                      <span className="w-14 shrink-0 font-display text-xs font-bold text-zinc-100">{it.label}</span>
                      <span className="text-xs font-bold text-zinc-400">{it.words}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => void run()}
            disabled={!entryId || running}
            className="btn-ghost text-[8px] py-0.5 flex items-center gap-1 disabled:opacity-40"
            title="Read this track's metamorphic meter: time signature per section, tempo segments, syncopation, swing, polymeter. Around 40s for a 3-minute track."
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3 text-fuchsia-300" />}
            {result ? 'REMAP' : 'MAP'}
          </button>
        </div>
      </div>

      {running && (
        <p className="text-[9px] font-mono text-zinc-500 mb-1">
          Reading the whole track — around 40 seconds for three minutes of audio.
        </p>
      )}

      {data && segs.length > 0 && (
        <div className="mb-1.5">
          <MeterMapChart
            data={data}
            uid={`mm-${uid}`}
            onDetail={setDetail}
            onPick={(m) => setPicked(segs.indexOf(m as MeterSegment))}
            activeIndex={picked}
          />
          <p className="mt-1 min-h-4 text-xs font-bold text-zinc-400" aria-live="polite">
            {shown ? (
              describeSegment(shown)
            ) : (
              <span className="text-zinc-600">Hover or focus a block for its numbers; click to keep them.</span>
            )}
          </p>
          <MeterMapLegend />
        </div>
      )}

      {result?.summary && (
        <p className="text-[9px] font-mono text-zinc-300 leading-relaxed mb-1">{result.summary}</p>
      )}

      {segs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[9px] font-mono">
            <thead>
              <tr className="text-zinc-500 uppercase tracking-widest text-[8px]">
                <th scope="col" className="text-left font-normal py-0.5 pr-2">From</th>
                <th scope="col" className="text-left font-normal py-0.5 pr-2">To</th>
                <th scope="col" className="text-left font-normal py-0.5 pr-2">Sig</th>
                <th scope="col" className="text-right font-normal py-0.5 pr-2">BPM</th>
                <th scope="col" className="text-right font-normal py-0.5 pr-2">Bars</th>
                <th scope="col" className="text-right font-normal py-0.5">Conf</th>
              </tr>
            </thead>
            <tbody>
              {segs.map((s, i) => (
                <tr
                  key={`${s.start_sec}-${i}`}
                  className={`border-t border-white/4 text-zinc-300 ${picked === i ? 'bg-white/5' : ''}`}
                  onMouseEnter={() => setDetail(s)}
                  onMouseLeave={() => setDetail(null)}
                >
                  <td className="py-0.5 pr-2">{fmtTime(s.start_sec)}</td>
                  <td className="py-0.5 pr-2">{fmtTime(s.end_sec)}</td>
                  <td className={`py-0.5 pr-2 ${s.uncertain ? 'text-amber-300' : 'text-fuchsia-200'}`}>
                    {s.time_signature}
                    {s.uncertain && <span title="A guess: the accents here fit no bar length well"> ?</span>}
                  </td>
                  <td className="py-0.5 pr-2 text-right">{s.bpm.toFixed(1)}</td>
                  <td className="py-0.5 pr-2 text-right">{s.bars}</td>
                  <td className="py-0.5 text-right">{s.confidence.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {tempo?.global_bpm != null && (
            <span className="px-1.5 py-0.5 rounded border border-white/10 text-[8px] font-mono text-zinc-300">
              {tempo.global_bpm.toFixed(1)} BPM{tempo.stable ? ' · steady' : ' · drifting'}
            </span>
          )}
          {tempo?.range_bpm && (
            <span className="px-1.5 py-0.5 rounded border border-white/10 text-[8px] font-mono text-zinc-400">
              range {tempo.range_bpm[0].toFixed(0)}–{tempo.range_bpm[1].toFixed(0)}
            </span>
          )}
          {result.syncopation?.mean_lhl != null && (
            <span className="px-1.5 py-0.5 rounded border border-white/10 text-[8px] font-mono text-zinc-400" title="Longuet-Higgins & Lee syncopation, mean per bar">
              sync {result.syncopation.mean_lhl.toFixed(2)}
            </span>
          )}
          {result.syncopation?.swing_ratio ? (
            <span className="px-1.5 py-0.5 rounded border border-white/10 text-[8px] font-mono text-zinc-400" title="Long eighth over short eighth: 1 is straight, 2 is triplet">
              swing {result.syncopation.swing_ratio.toFixed(2)}
            </span>
          ) : null}
          {(result.polymeter ?? []).slice(0, 3).map((p) => (
            <span key={p.layer} className="px-1.5 py-0.5 rounded border border-fuchsia-500/30 text-[8px] font-mono text-fuchsia-200" title={`Confidence ${p.confidence.toFixed(2)}`}>
              {p.layer} {p.label ?? `${p.beats_per_bar} (${p.relation})`}
            </span>
          ))}
          {(result.cross_rhythms ?? []).slice(0, 3).map((c) => (
            <span key={c.ratio} className="px-1.5 py-0.5 rounded border border-amber-500/30 text-[8px] font-mono text-amber-200" title={`Strength ${c.strength.toFixed(2)}`}>
              {c.ratio}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};
