import React, { useState } from 'react';
import { X, Sparkles, Play, ListPlus, RefreshCw, Music } from 'lucide-react';
import { startQueue } from '../../state/playlistQueue';
import { sendToDjAutomix } from '../../state/djAutomixStore';
import { logInfo } from '../../state/logStore';

interface SuggestTrack {
  id: string;
  title: string;
  duration_sec: number;
  bpm: number | null;
  key: string | null;
  scale: string | null;
  camelot: string | null;
  genre: string | null;
  play_count: number;
  reason: string;
}

interface SuggestResult {
  tracks: SuggestTrack[];
  total_duration_sec: number;
  track_count: number;
  flow: string;
  base_bpm: number;
  reason?: string;
}

const FLOWS = [
  { value: 'steady', label: 'Steady' },
  { value: 'build', label: 'Build up' },
  { value: 'wind_down', label: 'Wind down' },
  { value: 'wave', label: 'Wave' },
];

const fmtDur = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export const SuggestPlaylistModal: React.FC<Props> = ({ open, onClose }) => {
  const [durationMin, setDurationMin] = useState(30);
  const [bpmMin, setBpmMin] = useState('');
  const [bpmMax, setBpmMax] = useState('');
  const [flow, setFlow] = useState('steady');
  const [harmonic, setHarmonic] = useState(true);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const body = {
        target_duration_sec: Math.max(60, durationMin * 60),
        bpm_min: bpmMin ? Number(bpmMin) : null,
        bpm_max: bpmMax ? Number(bpmMax) : null,
        harmonic,
        flow,
        query: query.trim() || null,
      };
      const r = await fetch('/api/library/suggest-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setResult((await r.json()) as SuggestResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const playAll = () => {
    if (!result?.tracks.length) return;
    void startQueue(result.tracks.map((t) => t.id));
    onClose();
  };

  const sendToDj = () => {
    if (!result?.tracks.length) return;
    const n = sendToDjAutomix(result.tracks.map((t) => ({ entryId: t.id, label: t.title })));
    logInfo('library', `Sent ${n} tracks to the DJ — automixing the set`);
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-[min(640px,95vw)] h-[min(760px,92vh)] bg-[#0a080f] border border-purple-500/30 rounded-lg shadow-[0_0_40px_rgba(139,92,246,0.2)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5 bg-linear-to-r from-purple-900/30 to-indigo-900/20 shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-300" />
            <span className="font-black text-[13px] tracking-widest text-white">SUGGEST A PLAYLIST</span>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-white/10 text-zinc-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="shrink-0 px-4 py-3 border-b border-white/10 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <label htmlFor="sp-dur" className="text-[11px] text-zinc-300 w-20 shrink-0">Length (min)</label>
            <input id="sp-dur" name="sp-dur" type="number" min={1} max={600} value={durationMin} onChange={(e) => setDurationMin(Math.max(1, Number(e.target.value) || 1))} className="compact-input w-20" />
            <span className="text-[10px] text-zinc-500 ml-1">flow</span>
            <select id="sp-flow" name="sp-flow" value={flow} onChange={(e) => setFlow(e.target.value)} className="compact-input flex-1" style={{ colorScheme: 'dark' }}>
              {FLOWS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="sp-bpmmin" className="text-[11px] text-zinc-300 w-20 shrink-0">BPM range</label>
            <input id="sp-bpmmin" name="sp-bpmmin" type="number" placeholder="min" value={bpmMin} onChange={(e) => setBpmMin(e.target.value)} className="compact-input w-20" />
            <input id="sp-bpmmax" name="sp-bpmmax" type="number" placeholder="max" value={bpmMax} onChange={(e) => setBpmMax(e.target.value)} className="compact-input w-20" />
            <label htmlFor="sp-harm" className="flex items-center gap-1.5 text-[11px] text-zinc-300 ml-auto cursor-pointer">
              <input id="sp-harm" name="sp-harm" type="checkbox" checked={harmonic} onChange={(e) => setHarmonic(e.target.checked)} /> harmonic
            </label>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="sp-query" className="text-[11px] text-zinc-300 w-20 shrink-0">Filter</label>
            <input id="sp-query" name="sp-query" type="text" placeholder="genre / artist / text (optional)" value={query} onChange={(e) => setQuery(e.target.value)} className="compact-input flex-1" />
            <button type="button" onClick={run} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-purple-500/40 bg-purple-500/15 hover:bg-purple-500/25 text-purple-200 text-[11px] font-black uppercase tracking-widest disabled:opacity-50">
              {loading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} Suggest
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
          {error && <p className="text-rose-300 text-[11px]">Failed: {error}</p>}
          {!error && result && result.tracks.length === 0 && (
            <p className="text-zinc-500 text-[11px] italic">{result.reason || 'No tracks matched. Try a wider BPM range, or analyze more of your library.'}</p>
          )}
          {!error && !result && (
            <p className="text-zinc-600 text-[11px] italic">Set the criteria and hit Suggest. The playlist sequences on harmonic key and a BPM flow, and fills your time budget.</p>
          )}
          {result && result.tracks.length > 0 && (
            <>
              <div className="text-[10px] font-mono text-zinc-500 mb-2">{result.track_count} tracks · {fmtDur(result.total_duration_sec)} · base {Math.round(result.base_bpm)} bpm · {result.flow}</div>
              <ol className="flex flex-col gap-1">
                {result.tracks.map((t, i) => (
                  <li key={t.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-white/3 hover:bg-white/5">
                    <span className="text-[10px] font-mono text-zinc-600 w-5 text-right shrink-0">{i + 1}</span>
                    <Music className="w-3 h-3 text-purple-400/70 shrink-0" />
                    <span className="text-[11px] text-zinc-200 truncate flex-1">{t.title}</span>
                    <span className="text-[9px] font-mono text-zinc-500 shrink-0">{t.bpm ? `${Math.round(t.bpm)}bpm` : ''} {t.camelot ?? ''}</span>
                    <span className="text-[8px] font-mono text-purple-300/50 shrink-0 w-28 truncate text-right" title={t.reason}>{t.reason}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>

        {result && result.tracks.length > 0 && (
          <div className="shrink-0 border-t border-white/10 px-4 py-2.5 flex items-center gap-2">
            <button type="button" onClick={playAll} className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-emerald-500/40 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 text-[11px] font-black uppercase tracking-widest">
              <Play className="w-3 h-3 fill-current" /> Play All
            </button>
            <button type="button" onClick={sendToDj} title="Load these as the active automix set and start beatmatch-crossfading in the DJ tab" className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-cyan-500/40 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200 text-[11px] font-black uppercase tracking-widest">
              <ListPlus className="w-3 h-3" /> Send to DJ
            </button>
            <button type="button" onClick={run} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/10 hover:bg-white/10 text-zinc-300 text-[11px] font-bold uppercase tracking-widest ml-auto disabled:opacity-50">
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Regenerate
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
