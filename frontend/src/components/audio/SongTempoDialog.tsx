/**
 * SongTempoDialog — "Use song tempo": EDIT's tempo map and meter map from a
 * library song's rhythm analysis, lined up with the song's clip on the
 * timeline (lib/songTempo planSongTempo, lib/songTimeLink clipSongPlacement).
 *
 * Opened from an audio clip's context menu and from a library entry's menu
 * (editorStore requestSongTempo). It reads the song's analysis (GET only; a
 * song with none offers to analyse it), shows what would change (the tempo,
 * where the first downbeat lands, how many tempo changes, the meters) and
 * applies both maps as one undo step on a press.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useEditorStore, type SongTempoRequest } from '../../state/editorStore';
import { useLibraryStore } from '../../state/libraryStore';
import { logError, logInfo } from '../../state/logStore';
import { editBpmText, editMeterLabel, editTempoRange } from '../../lib/editTimeMap';
import { fetchRhythm, type RhythmAnalysis } from '../../lib/rhythmSeed';
import { describeSongTempoPlan, type SongTempoResult } from '../../lib/songTempo';
import { songTempoClip, songTempoPlanFor } from '../../lib/songTimeLink';

type Load =
  | { status: 'loading' }
  | { status: 'pending' }
  | { status: 'analysing' }
  | { status: 'ready'; analysis: RhythmAnalysis }
  | { status: 'error'; error: string };

/** The status word and its dot colour. */
const STATUS: Record<Load['status'], { word: string; dot: string }> = {
  loading: { word: 'Reading', dot: 'bg-sky-400 animate-pulse' },
  pending: { word: 'Unanalysed', dot: 'bg-amber-400' },
  analysing: { word: 'Analysing', dot: 'bg-sky-400 animate-pulse' },
  ready: { word: 'Ready', dot: 'bg-emerald-400' },
  error: { word: 'Failed', dot: 'bg-red-500' },
};

/** m:ss.cc, as the timeline's readouts write a second. */
const clock = (sec: number): string => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(2)}`;
};

const tempoText = (range: readonly [number, number]): string =>
  range[0] === range[1] ? `${editBpmText(range[0])} BPM` : `${editBpmText(range[0])}-${editBpmText(range[1])} BPM`;

const btn = 'rounded border px-2.5 py-1 font-display text-xs font-bold uppercase tracking-wider disabled:opacity-40 disabled:pointer-events-none';

export function SongTempoDialog({ request, onClose }: { request: SongTempoRequest; onClose: () => void }) {
  const headingId = useId();
  const tempoMap = useEditorStore((s) => s.tempoMap);
  const meterMap = useEditorStore((s) => s.meterMap);
  const clips = useEditorStore((s) => s.clips);
  const title = useLibraryStore((s) => s.entries.find((e) => e.id === request.entryId)?.title);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog when it opens, so Escape and Tab reach it.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    setLoad({ status: 'loading' });
    fetchRhythm(request.entryId, { signal: ctl.signal })
      .then((a) => { if (!ctl.signal.aborted) setLoad(a.status === 'ready' ? { status: 'ready', analysis: a } : { status: 'pending' }); })
      .catch((e: unknown) => { if (!ctl.signal.aborted) setLoad({ status: 'error', error: e instanceof Error ? e.message : String(e) }); });
    return () => ctl.abort();
  }, [request.entryId]);

  const analyse = useCallback(async () => {
    setLoad({ status: 'analysing' });
    try {
      const a = await fetchRhythm(request.entryId, { run: true });
      setLoad(a.status === 'ready' ? { status: 'ready', analysis: a } : { status: 'error', error: 'The analysis finished without a result.' });
    } catch (e) {
      setLoad({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }, [request.entryId]);

  const clip = useMemo(() => songTempoClip(clips, request.entryId, request.clipId), [clips, request.entryId, request.clipId]);
  const plan: SongTempoResult | null = useMemo(
    () => (load.status === 'ready' ? songTempoPlanFor(request, clips, { tempoMap, meterMap }, load.analysis).plan : null),
    [load, request, clips, tempoMap, meterMap],
  );

  const apply = () => {
    if (!plan || !plan.ok) return;
    const changed = useEditorStore.getState().setTimeMaps(plan.tempoMap, plan.meterMap);
    if (changed) logInfo('editor', `The arrangement now follows "${title ?? clip?.label ?? 'the song'}": ${describeSongTempoPlan(plan)}`);
    else logInfo('editor', 'The arrangement already follows the song\'s tempo and meter.');
    onClose();
  };

  const state = STATUS[load.status];
  const song = title ?? clip?.label ?? 'this song';
  const nowRange = editTempoRange(tempoMap);
  const keptBars = plan && plan.ok ? (plan.partial ? plan.partial.bar : plan.firstBar) : 0;

  return (
    <div className="fixed inset-0 z-100 grid place-items-center bg-black/60 p-6" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        className="hardware-card bg-[#0c0a12] border border-purple-500/30 rounded-lg shadow-2xl shadow-purple-900/40 p-4 w-full max-w-lg max-h-full overflow-y-auto flex flex-col gap-3 outline-none"
      >
        <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
          <h2 id={headingId} className="font-display text-xs font-bold uppercase tracking-widest text-zinc-200 truncate">
            Use song tempo: {song}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close use song tempo"
            title="Close"
            className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs font-bold text-zinc-300">
          <span aria-hidden="true" className={`w-2 h-2 rounded-full ${state.dot}`} />
          <span>{state.word}</span>
        </div>

        {load.status === 'pending' && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-bold text-zinc-300">The song has no rhythm analysis yet. It finds the downbeats and meters the bars follow.</p>
            <button type="button" onClick={() => void analyse()} className={`${btn} self-start border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25`}>
              Analyse the song
            </button>
          </div>
        )}
        {load.status === 'analysing' && <p className="text-xs font-bold text-zinc-400">Reading the song's beats, downbeats and meters. A long song takes a minute.</p>}
        {load.status === 'error' && <p role="alert" className="text-xs font-bold text-amber-300">{load.error}</p>}
        {plan && !plan.ok && <p role="alert" className="text-xs font-bold text-amber-300">{plan.error}</p>}

        {plan && plan.ok && (
          <>
            <p className="text-xs font-bold text-zinc-400">
              {clip ? `Lined up with "${clip.label}" as it sits on the timeline.` : 'No clip of the song is on the timeline, so the song is lined up as if it starts at 0:00.00.'}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs font-bold">
              <dt className="text-zinc-500">Tempo</dt>
              <dd className="text-zinc-200 tabular-nums">
                {`${tempoText(nowRange)} now, ${tempoText(plan.range)} after, starting at ${editBpmText(plan.startBpm)} BPM`}
              </dd>
              <dt className="text-zinc-500">First downbeat</dt>
              <dd className="text-zinc-200 tabular-nums">{`${clock(plan.firstDownbeatSec)}, which becomes bar ${plan.firstBar + 1}`}</dd>
              <dt className="text-zinc-500">Tempo changes</dt>
              <dd className="text-zinc-200 tabular-nums">
                {plan.perBar ? `${plan.tempoChanges}, following the song's downbeats bar by bar` : `${plan.tempoChanges}: the song's one tempo`}
              </dd>
              <dt className="text-zinc-500">Meter</dt>
              <dd className="text-zinc-200">{plan.meterText}</dd>
              <dt className="text-zinc-500">Bar lines</dt>
              <dd className="text-zinc-200 tabular-nums">
                {plan.perBar
                  ? `${plan.downbeats.length} land on the song's downbeats, within ${(plan.maxErrorSec * 1000).toFixed(2)} ms`
                  : 'Bar 1 lands on the downbeat; later bars follow the one tempo'}
              </dd>
            </dl>
            <ul className="flex flex-col gap-1 text-xs font-bold text-zinc-400 list-disc pl-4">
              {plan.partial && (
                <li>{`Bar ${plan.partial.bar + 1} becomes a ${editMeterLabel(plan.partial.meter)} bar at ${editBpmText(plan.partial.bpm)} BPM so it ends on the first downbeat.`}</li>
              )}
              {keptBars > 0 && <li>{keptBars === 1 ? 'Bar 1 keeps the tempo and meter it has.' : `Bars 1-${keptBars} keep the tempo and meter they have.`}</li>}
              {plan.earlySec > 0 && (
                <li className="text-amber-300">{`The first downbeat is ${(plan.earlySec * 1000).toFixed(1)} ms into the timeline, too close to the start for a bar of its own, so bar 1 starts that much before it. Move the clip right to line it up exactly.`}</li>
              )}
              {plan.clampedBars > 0 && <li className="text-amber-300">{`${plan.clampedBars} bar${plan.clampedBars === 1 ? '' : 's'} fell outside 20-300 BPM and were held at the limit.`}</li>}
              {plan.uncertainBars > 0 && <li>{`The analysis is unsure of the meter of ${plan.uncertainBars} bar${plan.uncertainBars === 1 ? '' : 's'}.`}</li>}
              {!plan.changes && <li>The arrangement already follows this song.</li>}
              <li>One undo step takes the tempo and the meter back.</li>
            </ul>
          </>
        )}

        <div className="flex items-center justify-end gap-2 border-t border-white/10 pt-2">
          <button type="button" onClick={onClose} className={`${btn} border-white/15 text-zinc-300 hover:bg-white/10`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                apply();
              } catch (e) {
                logError('editor', `Use song tempo failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
            disabled={!plan || !plan.ok || !plan.changes}
            className={`${btn} border-purple-400/50 bg-purple-500/25 text-purple-100 hover:bg-purple-500/40`}
          >
            Use song tempo
          </button>
        </div>
      </div>
    </div>
  );
}
