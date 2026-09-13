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
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Download, Loader2, Waves } from 'lucide-react';
import { logError, logInfo } from '../../state/logStore';

interface MeterSegment {
  start_sec: number;
  end_sec: number;
  time_signature: string;
  bpm: number;
  bars: number;
  confidence: number;
  uncertain?: boolean;
}

interface TempoSegment {
  start_sec: number;
  bpm: number;
}

export interface RhythmResult {
  version?: number;
  duration_sec?: number;
  summary?: string;
  tempo?: {
    bpm: number | null;
    global_bpm: number | null;
    range_bpm: [number, number] | null;
    stable?: boolean;
    level?: string;
    segments?: TempoSegment[];
  };
  meter_map?: MeterSegment[];
  syncopation?: {
    mean_lhl?: number;
    max_lhl?: number;
    mean_offbeat_ratio?: number;
    peak_bars?: number[];
    swing_ratio?: number | null;
    swing_confidence?: number;
  };
  polymeter?: Array<{ layer: string; label?: string; relation: string; beats_per_bar: number; confidence: number }>;
  cross_rhythms?: Array<{ ratio: string; strength: number }>;
  analyzed_at?: number;
  elapsed_sec?: number;
}

/** What the ANALYSIS block above already shows, passed in so one export can
 *  carry both -- the map is far less useful without key and tempo beside it. */
export interface AnalysisSummary {
  bpm?: number | null;
  key?: string | null;
  scale?: string | null;
  key_confidence?: number | null;
  bars_estimated?: number | null;
  loudness_lufs?: number | null;
  genre?: string | null;
}

const fmtTime = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const download = (name: string, text: string, mime: string): void => {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const safeName = (s: string): string =>
  s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'track';

/** The map as a paragraph and a table someone can paste into notes. */
export const rhythmMarkdown = (
  title: string,
  r: RhythmResult,
  a?: AnalysisSummary | null,
): string => {
  const lines: string[] = [`# ${title}`, ''];
  if (a) {
    lines.push('## Analysis', '');
    if (a.key) lines.push(`- Key: ${a.key} ${a.scale ?? ''}`.trimEnd() + (a.key_confidence != null ? ` (confidence ${a.key_confidence.toFixed(2)})` : ''));
    if (a.bpm != null) lines.push(`- BPM: ${a.bpm.toFixed(1)}`);
    if (a.bars_estimated != null) lines.push(`- Bars: ${a.bars_estimated.toFixed(1)}`);
    if (a.loudness_lufs != null) lines.push(`- Loudness: ${a.loudness_lufs.toFixed(1)} LUFS`);
    if (a.genre) lines.push(`- Genre: ${a.genre}`);
    lines.push('');
  }
  lines.push('## Meter map', '');
  if (r.summary) lines.push(r.summary, '');
  const segs = r.meter_map ?? [];
  if (segs.length) {
    lines.push('| From | To | Time signature | BPM | Bars | Confidence |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const s of segs) {
      lines.push(
        `| ${fmtTime(s.start_sec)} | ${fmtTime(s.end_sec)} | ${s.time_signature}${s.uncertain ? ' (?)' : ''} | ${s.bpm.toFixed(1)} | ${s.bars} | ${s.confidence.toFixed(2)} |`,
      );
    }
    lines.push('');
  }
  const sy = r.syncopation;
  if (sy) {
    lines.push('## Syncopation', '');
    if (sy.mean_lhl != null) lines.push(`- LHL mean ${sy.mean_lhl.toFixed(3)}, max ${(sy.max_lhl ?? 0).toFixed(3)}`);
    if (sy.mean_offbeat_ratio != null) lines.push(`- Offbeat ratio ${sy.mean_offbeat_ratio.toFixed(3)}`);
    if (sy.swing_ratio) lines.push(`- Swing ratio ${sy.swing_ratio.toFixed(2)} (confidence ${(sy.swing_confidence ?? 0).toFixed(2)})`);
    if (sy.peak_bars?.length) lines.push(`- Peak bars: ${sy.peak_bars.join(', ')}`);
    lines.push('');
  }
  if (r.polymeter?.length) {
    lines.push('## Polymeter', '');
    for (const p of r.polymeter) {
      lines.push(`- ${p.layer}: ${p.label ?? `${p.beats_per_bar} (${p.relation})`} - confidence ${p.confidence.toFixed(2)}`);
    }
    lines.push('');
  }
  if (r.cross_rhythms?.length) {
    lines.push('## Cross-rhythms', '');
    for (const c of r.cross_rhythms) lines.push(`- ${c.ratio} - strength ${c.strength.toFixed(2)}`);
    lines.push('');
  }
  return lines.join('\n');
};

export const RhythmBlock: React.FC<{
  entryId: string | null;
  title: string;
  analysis?: AnalysisSummary | null;
}> = ({ entryId, title, analysis }) => {
  const [result, setResult] = useState<RhythmResult | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);

  // Read the cache when the selection changes. A track nobody has mapped comes
  // back "pending", which is a state, not an error.
  useEffect(() => {
    let cancelled = false;
    setResult(null);
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

  const run = useCallback(async () => {
    if (!entryId || running) return;
    setRunning(true);
    try {
      const r = await fetch(`/api/rhythm/${encodeURIComponent(entryId)}/run`, { method: 'POST' });
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as RhythmResult;
      setResult(j);
      logInfo('rhythm', `Mapped ${title}${j.elapsed_sec ? ` in ${j.elapsed_sec}s` : ''}`);
    } catch (e) {
      logError('rhythm', `Meter mapping failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  }, [entryId, running, title]);

  const segs = result?.meter_map ?? [];
  const tempo = result?.tempo;

  return (
    <div className="mt-3 p-2 rounded border border-fuchsia-500/25 bg-fuchsia-500/4">
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
            <>
              <button
                onClick={() => download(`${safeName(title)} - meter map.json`, JSON.stringify(result, null, 2), 'application/json')}
                className="btn-ghost text-[8px] py-0.5 flex items-center gap-1"
                title="Download the full map, tempo curve, beats and downbeats as JSON"
              >
                <Download className="w-3 h-3 text-fuchsia-300" /> JSON
              </button>
              <button
                onClick={() => download(`${safeName(title)} - meter map.md`, rhythmMarkdown(title, result, analysis), 'text/markdown')}
                className="btn-ghost text-[8px] py-0.5 flex items-center gap-1"
                title="Download the map, key and tempo as a readable report"
              >
                <Download className="w-3 h-3 text-fuchsia-300" /> REPORT
              </button>
            </>
          )}
          <button
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
                <tr key={`${s.start_sec}-${i}`} className="border-t border-white/4 text-zinc-300">
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
