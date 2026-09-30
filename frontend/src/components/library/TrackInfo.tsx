/**
 * The library's INFO tab: everything known about the selected track in one
 * column, for reading without leaving the library.
 *
 * It carries what DETAILS shows (the entry's own fields, the prompt, lyrics,
 * analysis, embedded tags, ffprobe, the notation identity, the cached meter
 * reading, chimera sources) and what the lineage inspector shows (what the
 * track came from, what came from it, how far the family reaches, and the
 * words and tags that recur across it), plus the stems, MIDI and scores the
 * track has. Nothing here runs a job; the keys at the top open DETAILS and the
 * LINEAGE window, where the track can be worked on.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Info, Loader2, Network, Sparkles } from 'lucide-react';
import { useLibraryStore } from '../../state/libraryStore';
import {
  fetchAnalysis,
  fetchIdentity,
  firstLyricLine,
  fmtDate,
  fmtDuration,
  fmtSize,
  safeFfprobeSummary,
  safeJsonPretty,
  type AnalysisRow,
  type NotationIdentity,
} from '../../lib/trackFacts';
import {
  LINEAGE_FETCH_CAP,
  edgeColor,
  relationWords,
  relativesOf,
  themesOf,
  type LineageEdge,
  type LineageNode,
  type Themes,
} from '../../lib/lineageInsights';
import { deriveLyrics } from '../../catalog/catalogSearch';
import { LineageFamilyNotice, RelativeList, useLineageFamily } from './LineageFamilyNotice';

type Row = Record<string, unknown>;

/** The fields of `/api/rhythm/{id}` this tab reads. */
interface RhythmRead {
  status?: string;
  summary?: string;
  tempo?: { bpm?: number | null; range_bpm?: [number, number] | null };
  meter_map?: Array<{ start_sec: number; end_sec: number; time_signature: string; bars: number; uncertain?: boolean }>;
}

const mmss = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const num = (v: number | null | undefined, digits: number, unit = ''): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${unit}`;

const Section: React.FC<{ title: string; hint?: React.ReactNode; children: React.ReactNode }> = ({ title, hint, children }) => (
  <section className="flex flex-col gap-1.5 rounded border border-white/5 bg-white/3 p-2">
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="font-display text-xs font-bold uppercase text-purple-300">{title}</h3>
      {hint && <span className="text-xs font-bold text-zinc-500">{hint}</span>}
    </div>
    {children}
  </section>
);

/** Label and value pairs, two columns. */
const Facts: React.FC<{ rows: Array<[string, React.ReactNode]> }> = ({ rows }) => (
  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs font-bold">
    {rows.map(([k, v]) => (
      <React.Fragment key={k}>
        <dt className="text-zinc-500">{k}</dt>
        <dd className="min-w-0 wrap-break-word text-zinc-200">{v}</dd>
      </React.Fragment>
    ))}
  </dl>
);

const Pre: React.FC<{ summary: string; text: string }> = ({ summary, text }) => (
  <details>
    <summary className="cursor-pointer text-xs font-bold text-zinc-400 hover:text-purple-300">{summary}</summary>
    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs text-zinc-400">{text}</pre>
  </details>
);

const KEY =
  'flex items-center gap-1.5 rounded border border-white/10 px-2 py-1 text-xs font-bold text-zinc-300 transition-colors hover:border-purple-400/50 hover:text-zinc-100 disabled:opacity-40';

export const TrackInfo: React.FC<{
  entryId: string | null;
  /** This track's stems, MIDI and scores; null while the lists load. */
  stems: Row[] | null;
  midis: Row[] | null;
  scores: Row[] | null;
  onOpenDetails: (entryId: string) => void;
  onOpenLineage: (entryId: string) => void;
  /** Select another library track (a relative in the lineage). */
  onSelectEntry: (entryId: string) => void;
}> = ({ entryId, stems, midis, scores, onOpenDetails, onOpenLineage, onSelectEntry }) => {
  const entry = useLibraryStore((s) => (entryId ? s.entries.find((e) => e.id === entryId) : undefined));
  const libraryEntries = useLibraryStore((s) => s.entries);
  // One lookup for every relative row: a whole family can list thousands.
  const libraryTitles = useMemo(() => new Map(libraryEntries.map((e) => [e.id, e.title])), [libraryEntries]);

  const [analysis, setAnalysis] = useState<AnalysisRow | null>(null);
  const [identity, setIdentity] = useState<NotationIdentity | null>(null);
  const [rhythm, setRhythm] = useState<RhythmRead | null>(null);
  // The capped family, and the whole one when the user asks for it.
  const lineage = useLineageFamily(entryId, 4);
  const [loading, setLoading] = useState(false);
  const [themes, setThemes] = useState<(Themes & { count: number; truncated: boolean }) | null>(null);
  const [themesBusy, setThemesBusy] = useState(false);
  // The track on screen, so a themes read that finishes after the reader has
  // moved to another track is dropped.
  const shownIdRef = useRef(entryId);
  shownIdRef.current = entryId;

  useEffect(() => {
    setAnalysis(null);
    setIdentity(null);
    setRhythm(null);
    setThemes(null);
    if (!entryId) return;
    let cancelled = false;
    setLoading(true);
    const id = encodeURIComponent(entryId);
    void Promise.all([
      fetchAnalysis(entryId).then((a) => !cancelled && setAnalysis(a)),
      fetchIdentity(entryId).then((i) => !cancelled && setIdentity(i)),
      fetch(`/api/rhythm/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: RhythmRead | null) => !cancelled && setRhythm(j && j.status === 'ready' ? j : null))
        .catch(() => undefined),
    ]).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  const lineageRead = lineage.family;
  // Themes are read from one family. When the whole family replaces the
  // capped one they are dropped, and a read still running on the replaced
  // family is dropped when it lands, so "Read from N of the family" never
  // describes the family that was replaced.
  const shownFamilyRef = useRef(lineageRead);
  shownFamilyRef.current = lineageRead;
  useEffect(() => {
    setThemes(null);
  }, [lineageRead]);
  const family = useMemo(() => {
    if (!entryId || !lineageRead) return null;
    const byId: Record<string, LineageNode> = {};
    for (const n of lineageRead.nodes) byId[n.id] = n;
    return { read: lineageRead, byId, ...relativesOf(entryId, lineageRead.edges) };
  }, [entryId, lineageRead]);

  // Themes fetch every entry in the family, so they are read on request.
  const readThemes = async () => {
    if (!family || themesBusy) return;
    const ids = [...family.ancestors, ...family.descendants].filter((id) => family.byId[id]?.kind === 'entry');
    const use = ids.slice(0, LINEAGE_FETCH_CAP);
    const askedFor = entryId;
    const askedFamily = lineageRead;
    setThemesBusy(true);
    try {
      const rows = await Promise.all(
        use.map((id) =>
          fetch(`/api/library/entries/${encodeURIComponent(id)}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      );
      if (shownIdRef.current !== askedFor || shownFamilyRef.current !== askedFamily) return;
      setThemes({ ...themesOf(rows), count: use.length, truncated: ids.length > use.length });
    } finally {
      setThemesBusy(false);
    }
  };

  if (!entryId || !entry) {
    return (
      <p className="py-6 text-center text-xs font-bold text-zinc-500">
        Click a track in Tracks and its info shows here.
      </p>
    );
  }

  const lyrics = entry.lyrics || deriveLyrics(entry);
  const inLibrary = (id: string) => libraryTitles.has(id);
  const nodeTitle = (id: string) => family?.byId[id]?.title || libraryTitles.get(id) || `${id.slice(0, 12)}…`;

  const relativeRow = (edge: LineageEdge, otherId: string, i: number) => {
    const title = nodeTitle(otherId);
    const selectable = inLibrary(otherId);
    return (
      <li key={`${otherId}-${edge.kind}-${i}`} className="flex items-center gap-2 text-xs font-bold">
        <span className="size-2 shrink-0 rounded-full" style={{ background: edgeColor(edge.kind) }} aria-hidden="true" />
        <span className="shrink-0 text-zinc-500">{relationWords(edge.kind)}</span>
        {selectable ? (
          <button
            type="button"
            className="min-w-0 truncate text-left text-zinc-200 underline decoration-white/20 underline-offset-2 hover:text-purple-200"
            onClick={() => onSelectEntry(otherId)}
            title={`Show ${title}`}
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 truncate text-zinc-400" title={otherId}>
            {title}
          </span>
        )}
      </li>
    );
  };

  const fileList = (rows: Row[] | null, name: (r: Row) => string, empty: string) => {
    if (rows === null) return <span className="text-xs font-bold text-zinc-500">loading…</span>;
    if (rows.length === 0) return <span className="text-xs font-bold text-zinc-500">{empty}</span>;
    return (
      <ul className="flex flex-col gap-0.5">
        {rows.map((r, i) => (
          <li key={String(r.id ?? i)} className="truncate text-xs font-bold text-zinc-300">
            {name(r)}
          </li>
        ))}
      </ul>
    );
  };

  const segments = rhythm?.meter_map ?? [];

  return (
    <div className="flex flex-col gap-2 pb-2">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-sm font-bold wrap-break-word text-zinc-100">{entry.title}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={KEY} onClick={() => onOpenDetails(entry.id)} title="Open this track in the DETAILS tab">
            <Info className="size-3.5" aria-hidden="true" /> Details
          </button>
          <button type="button" className={KEY} onClick={() => onOpenLineage(entry.id)} title="Open this track's lineage graph">
            <Network className="size-3.5" aria-hidden="true" /> Lineage
          </button>
          {(loading || lineage.loading) && <Loader2 className="size-3.5 animate-spin text-purple-300" aria-label="Loading" />}
        </div>
      </div>

      <Section title="Track">
        <Facts
          rows={[
            ['Source', entry.source],
            ['Kind', entry.kind ?? 'audio'],
            ['Model', entry.model || '—'],
            ['Seed', entry.seed === -1 ? 'random' : String(entry.seed)],
            ['Steps', String(entry.steps)],
            ['CFG', Number.isFinite(entry.cfg) ? entry.cfg.toFixed(2) : '—'],
            ['Duration', fmtDuration(entry.duration)],
            ['Created', fmtDate(entry.timestamp)],
            ['File', entry.audioFilename || '—'],
            ['Type', entry.mimeType || '—'],
            ['Size', fmtSize(entry.fileSizeBytes)],
            ['Favorite', entry.favorite ? 'yes' : 'no'],
            ['Rating', entry.rating ?? '—'],
            ['Plays', String(entry.playCount ?? 0)],
            ['Last played', entry.lastPlayedAt ? new Date(entry.lastPlayedAt * 1000).toLocaleString() : '—'],
            ['Tags', entry.tags.length ? entry.tags.join(', ') : '—'],
            ['Notes', entry.notes || '—'],
            ['Entry ID', <span className="break-all text-zinc-400">{entry.id}</span>],
          ]}
        />
      </Section>

      <Section title="Prompt">
        <p className="text-xs font-bold leading-relaxed text-zinc-200">
          {entry.prompt || <span className="text-zinc-500">No prompt was used for this track.</span>}
        </p>
        {entry.negativePrompt && (
          <Facts rows={[['Negative', entry.negativePrompt]]} />
        )}
      </Section>

      <Section title="Lyrics">
        {lyrics ? (
          <>
            <p className="text-xs font-bold text-zinc-200">{firstLyricLine(lyrics) || '—'}</p>
            <Pre summary="Every line" text={lyrics} />
          </>
        ) : (
          <p className="text-xs font-bold text-zinc-500">No lyrics.</p>
        )}
      </Section>

      <Section title="Analysis" hint={analysis?.analyzed_at ? new Date(analysis.analyzed_at * 1000).toLocaleDateString() : undefined}>
        {analysis ? (
          <>
            <Facts
              rows={[
                ['BPM', num(analysis.bpm, 1)],
                ['Key', analysis.key ? `${analysis.key} ${analysis.scale ?? ''}`.trim() : '—'],
                ['Key confidence', num(analysis.key_confidence, 2)],
                ['Bars', num(analysis.bars_estimated, 1)],
                ['Loudness', num(analysis.loudness_lufs, 1, ' LUFS')],
                ['RMS', num(analysis.rms_db, 1, ' dB')],
                ['Pitch mean', num(analysis.pitch_mean_hz, 0, ' Hz')],
                ['Pitch spread', num(analysis.pitch_std_hz, 0, ' Hz')],
                ['Genre', analysis.genre ? `${analysis.genre} (${(analysis.genre_confidence ?? 0).toFixed(2)})` : '—'],
              ]}
            />
            {analysis.embedded_tags_json && analysis.embedded_tags_json !== '{}' && (
              <Pre summary="Embedded tags (ID3 / Vorbis / iTunes)" text={safeJsonPretty(analysis.embedded_tags_json)} />
            )}
            {analysis.ffprobe_json && analysis.ffprobe_json !== '{}' && (
              <Pre summary="ffprobe summary" text={safeFfprobeSummary(analysis.ffprobe_json)} />
            )}
          </>
        ) : (
          <p className="text-xs font-bold text-zinc-500">{loading ? 'loading…' : 'Not analysed yet. Right-click the track in Tracks and pick Run analysis.'}</p>
        )}
      </Section>

      <Section title="Meter" hint={segments.length ? `${segments.length} sections` : undefined}>
        {rhythm ? (
          <>
            {rhythm.summary && <p className="text-xs font-bold leading-relaxed text-zinc-200">{rhythm.summary}</p>}
            <ul className="flex flex-col gap-0.5">
              {segments.slice(0, 16).map((s, i) => (
                <li key={`${s.start_sec}-${i}`} className="flex gap-2 text-xs font-bold tabular-nums text-zinc-300">
                  <span className="w-20 shrink-0 text-zinc-500">
                    {mmss(s.start_sec)}–{mmss(s.end_sec)}
                  </span>
                  <span className={s.uncertain ? 'text-amber-300' : 'text-zinc-100'}>
                    {s.time_signature}
                    {s.uncertain ? ' (guess)' : ''}
                  </span>
                  <span className="text-zinc-500">{s.bars} bars</span>
                </li>
              ))}
              {segments.length > 16 && <li className="text-xs font-bold text-zinc-500">and {segments.length - 16} more in DETAILS</li>}
            </ul>
          </>
        ) : (
          <p className="text-xs font-bold text-zinc-500">{loading ? 'loading…' : 'Not mapped yet. MAP it in the METER MAP block in DETAILS.'}</p>
        )}
      </Section>

      <Section title="Notation identity">
        <Facts
          rows={[
            ['Artist', identity?.override_artist || identity?.auto_artist || '—'],
            ['Title', identity?.override_title || identity?.auto_title || entry.title],
            ['Set by', (identity?.override_artist || identity?.override_title) ? 'you' : 'the file name'],
          ]}
        />
      </Section>

      <Section title="Files" hint={[stems, midis, scores].some((x) => x === null) ? undefined : `${(stems?.length ?? 0) + (midis?.length ?? 0) + (scores?.length ?? 0)} in all`}>
        <span className="text-xs font-bold text-zinc-500">Stems</span>
        {fileList(stems, (r) => `${String(r.stem_name ?? 'stem')}${r.model ? ` · ${String(r.model)}` : ''}`, 'No stems.')}
        <span className="text-xs font-bold text-zinc-500">MIDI</span>
        {fileList(midis, (r) => `${String(r.source ?? 'midi')}${r.engine ? ` · ${String(r.engine)}` : ''}`, 'No MIDI.')}
        <span className="text-xs font-bold text-zinc-500">Scores</span>
        {fileList(scores, (r) => `${String(r.kind ?? 'score')}${r.engine ? ` · ${String(r.engine)}` : ''}`, 'No scores.')}
      </Section>

      {entry.chimeraSources && entry.chimeraSources.length > 0 && (
        <Section title="Chimera sources" hint={String(entry.chimeraSources.length)}>
          <ol className="flex flex-col gap-0.5">
            {entry.chimeraSources.map((label, i) => (
              <li key={`${label}-${i}`} className="truncate text-xs font-bold text-zinc-300" title={label}>
                <span className="text-purple-400/70 tabular-nums">{String(i + 1).padStart(2, '0')}</span> {label}
              </li>
            ))}
          </ol>
        </Section>
      )}

      <Section
        title="Lineage"
        hint={family ? `${family.ancestors.size} before · ${family.descendants.size} after` : undefined}
      >
        {lineageRead && (
          <LineageFamilyNotice
            family={lineageRead}
            busy={lineage.wholeBusy}
            error={lineage.wholeError}
            onLoadWhole={lineage.loadWhole}
          />
        )}
        {!family ? (
          <p className="text-xs font-bold text-zinc-500">
            {lineage.loading
              ? 'loading…'
              : lineage.error
                ? `Could not read the lineage: ${lineage.error}`
                : 'No lineage recorded.'}
          </p>
        ) : family.incoming.length === 0 && family.outgoing.length === 0 ? (
          <p className="text-xs font-bold text-zinc-500">No relatives: nothing made this track and nothing was made from it.</p>
        ) : (
          <>
            {family.incoming.length > 0 && (
              <>
                <span className="text-xs font-bold text-zinc-500">Came from ({family.incoming.length})</span>
                <RelativeList
                  items={family.incoming}
                  family={family.read}
                  className="flex flex-col gap-0.5"
                  render={(e, i) => relativeRow(e, e.from_id, i)}
                />
              </>
            )}
            {family.outgoing.length > 0 && (
              <>
                <span className="text-xs font-bold text-zinc-500">Led to ({family.outgoing.length})</span>
                <RelativeList
                  items={family.outgoing}
                  family={family.read}
                  className="flex flex-col gap-0.5"
                  render={(e, i) => relativeRow(e, e.to_id, i)}
                />
              </>
            )}
            {Object.keys(family.spawnedByKind).length > 0 && (
              <Facts
                rows={Object.entries(family.spawnedByKind).map(([kind, n]) => [relationWords(kind), `${n} made`])}
              />
            )}
          </>
        )}
        {family && family.ancestors.size + family.descendants.size > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-white/5 pt-1.5">
            {!themes ? (
              <button type="button" className={`${KEY} self-start`} onClick={() => void readThemes()} disabled={themesBusy}>
                {themesBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="size-3.5" aria-hidden="true" />}
                Read the family's themes
              </button>
            ) : themes.terms.length === 0 && themes.tags.length === 0 ? (
              <p className="text-xs font-bold text-zinc-500">No prompts or tags across the family yet.</p>
            ) : (
              <>
                {themes.terms.length > 0 && (
                  <Facts rows={[['Recurring words', themes.terms.map(([t, n]) => `${t} ${n}`).join(', ')]]} />
                )}
                {themes.tags.length > 0 && <Facts rows={[['Common tags', themes.tags.map(([t, n]) => `${t} ${n}`).join(', ')]]} />}
                {themes.truncated && (
                  <p className="text-xs font-bold text-amber-300/80">
                    Read from {themes.count} of the family (capped at {LINEAGE_FETCH_CAP}).
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Section>
    </div>
  );
};
