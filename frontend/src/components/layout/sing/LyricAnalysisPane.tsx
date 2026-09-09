import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useLibraryStore } from '../../../state/libraryStore';
import { useLyricsStore } from '../../../state/lyricsStore';
import {
  DEVICE_FAMILIES,
  FAMILY_LABELS,
  asFamily,
  useLyricAnalysisStore,
  visibleDevices,
} from '../../../state/lyricAnalysisStore';
import type { Device, DeviceFamily, LyricAnalysisDoc, SectionSummary } from '../../../lib/lyricAnalysisClient';
import './sing.css';

/** One hue per rhyme class, cycled, as bare channels so every tint of it can
 *  be mixed inline. The colour is only ever the second cue — the scheme letter
 *  beside it carries the class — so a repeat past H reads fine and nothing
 *  depends on telling two hues apart. */
const LETTER_CHANNELS = [
  '251 113 133', // rose
  '56 189 248', // sky
  '52 211 153', // emerald
  '232 121 249', // fuchsia
  '251 191 36', // amber
  '167 139 250', // violet
  '45 212 191', // teal
  '248 113 113', // red
];

/** Matches the underline shapes sing.css paints on the karaoke words, so the
 *  legend and the lyrics say the same thing without relying on hue. */
const FAMILY_SHAPES: Record<DeviceFamily, string> = {
  rhyme: 'solid underline',
  sound: 'dotted underline',
  repetition: 'double underline',
  structure: 'dashed underline',
  meaning: 'dotted overline',
};

const letterChannels = (letter: string): string => {
  const idx = letter.charCodeAt(0) - 65;
  return LETTER_CHANNELS[((idx % LETTER_CHANNELS.length) + LETTER_CHANNELS.length) % LETTER_CHANNELS.length];
};

/** The sections to draw the map from: a lyric with no markers still gets one. */
const mapSections = (doc: LyricAnalysisDoc): SectionSummary[] => {
  if (doc.sections.length) return doc.sections;
  const lines = doc.lines.map((l) => l.line);
  return [
    {
      name: '',
      start_line: lines.length ? Math.min(...lines) : 0,
      end_line: lines.length ? Math.max(...lines) : 0,
      scheme: doc.scheme,
      lines: doc.stats.lines,
      syllables: doc.stats.syllables,
    },
  ];
};

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/** A repeated hook in a long lyric is one finding with ten thousand spans, and
 *  the backend's label names every one of them. Nothing in this list may grow
 *  with the song: the label is clipped, the line list is clipped, and each kind
 *  shows a bounded number of rows. */
const MAX_LABEL_CHARS = 90;
const MAX_LINE_REFS = 6;
const MAX_ROWS_PER_KIND = 50;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** "L4 · L7": the lines a finding touches, in the reading order of the lyric. */
const deviceLines = (device: Device): string => {
  const seen = Array.from(new Set(device.spans.map((s) => s.line))).sort((a, b) => a - b);
  const head = seen.slice(0, MAX_LINE_REFS).map((l) => `L${l + 1}`).join(' · ');
  return seen.length > MAX_LINE_REFS ? `${head} +${seen.length - MAX_LINE_REFS}` : head;
};

const SectionHead: React.FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-white/5 bg-[#07050a] px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-500">
    <span className="text-zinc-300">{title}</span>
    {hint && <span className="normal-case tracking-normal text-zinc-600">{hint}</span>}
  </div>
);

/**
 * The lyrical analysis panel for the SING tab: the rhyme scheme drawn as a
 * chart, the sound / repetition / structure findings under it, and the numbers
 * that say how much to trust them. The family filters and confidence floor
 * drive this list AND the karaoke overlay, so what you read here is what the
 * words are wearing on stage.
 */
export const LyricAnalysisPane: React.FC<{ entryId?: string | null; title?: string }> = ({
  entryId: entryIdProp,
  title: titleProp,
}) => {
  const entry = useLibraryStore((s) =>
    s.selectedEntryId ? s.entries.find((e) => e.id === s.selectedEntryId) ?? null : null,
  );
  const entryId = entryIdProp ?? entry?.id ?? null;
  const title = titleProp ?? (entry && entry.id === entryId ? entry.title : entryId ?? '');

  // The words themselves live in the lyrics document the analysis was anchored
  // to; only take them when that document is for the same entry.
  const lyrics = useLyricsStore((s) => (s.entryId === entryId ? s.doc : null));

  const doc = useLyricAnalysisStore((s) => s.doc);
  const loading = useLyricAnalysisStore((s) => s.loading);
  const stale = useLyricAnalysisStore((s) => s.stale);
  const persisted = useLyricAnalysisStore((s) => s.persisted);
  const error = useLyricAnalysisStore((s) => s.error);
  const job = useLyricAnalysisStore((s) => s.job);
  const families = useLyricAnalysisStore((s) => s.families);
  const minConfidence = useLyricAnalysisStore((s) => s.minConfidence);
  const overlay = useLyricAnalysisStore((s) => s.overlay);
  const selectedGroup = useLyricAnalysisStore((s) => s.selectedGroup);
  const llm = useLyricAnalysisStore((s) => s.llm);
  const llmAvailable = useLyricAnalysisStore((s) => s.llmAvailable);
  const providers = useLyricAnalysisStore((s) => s.providers);
  const provider = useLyricAnalysisStore((s) => s.provider);
  const model = useLyricAnalysisStore((s) => s.model);

  /** The rhyme class the map is isolating; the letter badges toggle it. */
  const [activeLetter, setActiveLetter] = useState('');

  const store = useLyricAnalysisStore.getState;

  useEffect(() => {
    void useLyricAnalysisStore.getState().probe();
  }, []);

  useEffect(() => {
    setActiveLetter('');
    if (entryId) void useLyricAnalysisStore.getState().load(entryId);
    else useLyricAnalysisStore.getState().clear();
  }, [entryId]);

  const metricsByLine = useMemo(() => {
    const map = new Map<number, LyricAnalysisDoc['lines'][number]>();
    for (const m of doc?.lines ?? []) map.set(m.line, m);
    return map;
  }, [doc]);

  const shown = useMemo(() => visibleDevices(doc, families, minConfidence), [doc, families, minConfidence]);

  /** family -> kind -> findings, in the taxonomy's own family order. */
  const byFamily = useMemo(() => {
    const out = new Map<DeviceFamily, Map<string, Device[]>>();
    for (const d of shown) {
      const family = asFamily(d.family);
      if (!family) continue;
      const kinds = out.get(family) ?? new Map<string, Device[]>();
      kinds.set(d.kind, [...(kinds.get(d.kind) ?? []), d]);
      out.set(family, kinds);
    }
    return out;
  }, [shown]);

  const familyCounts = useMemo(() => {
    const counts = Object.fromEntries(DEVICE_FAMILIES.map((f) => [f, 0])) as Record<DeviceFamily, number>;
    for (const d of doc?.devices ?? []) {
      const family = asFamily(d.family);
      if (family && d.confidence >= minConfidence) counts[family] += 1;
    }
    return counts;
  }, [doc, minConfidence]);

  const busy = !!job;

  if (!entryId) {
    return (
      <div className="h-full flex items-center justify-center text-[10px] font-mono text-zinc-500">
        Select a song in the library to analyse its lyrics.
      </div>
    );
  }

  const stats = doc?.stats ?? null;
  const tiles: Array<[string, string, string]> = stats
    ? [
        ['LINES', String(stats.lines), 'Lyric lines, markers excluded'],
        ['WORDS', String(stats.words), 'Sung words'],
        ['SYLLABLES', String(stats.syllables), 'Total syllables'],
        ['UNIQUE', String(stats.unique_words), 'Distinct words'],
        ['TTR', stats.ttr.toFixed(2), 'Type/token ratio: distinct words over total words'],
        ['RHYME DENSITY', pct(stats.rhyme_density), 'Share of lines whose ending rhymes with another line'],
        ['MULTISYLLABIC', String(stats.multisyllabic_rhymes), 'Rhymes spanning two or more syllables'],
        ['SYL / LINE', stats.avg_syllables_per_line.toFixed(1), 'Average syllables per line'],
        ['GUESSED', String(stats.guessed_pronunciations), 'Words with no dictionary pronunciation'],
      ]
    : [];

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#07050a] text-zinc-200">
      {/* Header */}
      <div className="h-8 shrink-0 border-b border-white/5 bg-black/30 flex items-center gap-1.5 px-2 text-[9px] font-mono">
        <BookOpen className="w-3.5 h-3.5 text-rose-300 shrink-0" />
        <span className="truncate text-zinc-300" title={title}>{title}</span>
        {doc && (
          <span
            className="shrink-0 rounded border border-rose-500/30 bg-rose-500/10 px-1 text-rose-200"
            title="Where the pronunciations came from: a dictionary, letter rules, or both"
          >
            {doc.pronunciation_source}
          </span>
        )}
        {stale && persisted && (
          <span
            className="shrink-0 flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-amber-200"
            title="The lyrics changed after this analysis ran, so the findings no longer line up with the words. Re-analyse."
          >
            <AlertTriangle className="w-3 h-3" /> STALE
          </span>
        )}
        <span className="flex-1" />
        <input
          id="la-llm"
          name="la-llm"
          type="checkbox"
          className="accent-rose-400"
          checked={llm}
          onChange={(e) => store().setLlm(e.target.checked)}
          disabled={!llmAvailable}
        />
        <label
          htmlFor="la-llm"
          className={`cursor-pointer select-none ${llmAvailable ? 'text-zinc-400' : 'text-zinc-600'}`}
          title={
            llmAvailable
              ? 'Optional: also ask a model to read the lyric for meaning (metaphor, irony, imagery). Everything else is computed locally.'
              : 'No LLM provider is configured, so the meaning pass cannot run. The rest of the analysis is local and always available.'
          }
        >
          READ THE MEANING TOO
        </label>
        <button
          type="button"
          className="btn-ghost text-[8px] py-1 px-1.5 flex items-center gap-1 disabled:opacity-40"
          onClick={() => void store().run({ force: true })}
          disabled={busy || loading}
          title="Read the lyric: rhyme scheme, sound, repetition and structure, computed from the timed words"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : doc ? <RefreshCw className="w-3 h-3" /> : <Sparkles className="w-3 h-3" />}
          {doc ? 'RE-ANALYSE' : 'ANALYSE'}
        </button>
      </div>

      {/* The interpretive pass is opt-in, so its settings only appear once it is. */}
      {llm && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-white/5 bg-black/20 px-2 py-1 text-[9px] font-mono">
          <label htmlFor="la-provider" className="text-zinc-500">PROVIDER</label>
          <select
            id="la-provider"
            name="la-provider"
            className="form-select text-[8px] px-1 py-0.5 min-w-24"
            value={provider}
            onChange={(e) => store().setProvider(e.target.value)}
          >
            <option value="">default</option>
            {providers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <label htmlFor="la-model" className="text-zinc-500">MODEL</label>
          <input
            id="la-model"
            name="la-model"
            type="text"
            className="form-select text-[9px] px-1 py-0.5 min-w-40"
            value={model}
            placeholder="the provider's default"
            onChange={(e) => store().setModel(e.target.value)}
            spellCheck={false}
          />
          <span className="text-zinc-600">
            Meaning findings are a reading, not a measurement — they carry the model's confidence, not a rule's.
          </span>
        </div>
      )}

      {(job || error || (doc?.llm?.error ?? '')) && (
        <div className="shrink-0 flex items-center gap-2 border-b border-white/5 bg-black/20 px-2 py-1 text-[9px] font-mono">
          {job && (
            <>
              <Loader2 className="w-3 h-3 animate-spin text-rose-300" />
              <span className="text-zinc-300">{job.message || job.status}</span>
              <div
                className="h-1 w-32 overflow-hidden rounded bg-white/10"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(job.progress * 100)}
                aria-label="Analysis progress"
              >
                <div className="h-full bg-rose-400" style={{ width: pct(job.progress) }} />
              </div>
            </>
          )}
          {!job && doc?.llm?.error && <span className="text-amber-300">meaning pass: {doc.llm.error}</span>}
          {error && (
            <>
              <span className="text-rose-300">{error}</span>
              <button
                type="button"
                className="btn-ghost text-[8px] py-0.5 px-1"
                onClick={() => store().clearError()}
                aria-label="Dismiss the error"
              >
                ×
              </button>
            </>
          )}
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : !doc ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-[10px] font-mono text-zinc-400">
          <div className="text-zinc-500">
            {/* A null lyrics doc means SING has not loaded one yet, which is not
                the same as the song having no words: only the second one blocks. */}
            {lyrics && !lyrics.text.trim()
              ? 'No lyrics on this song yet — paste or transcribe them in SING first.'
              : 'These lyrics have not been read yet.'}
          </div>
          <button
            type="button"
            className="btn-ghost text-[10px] py-2 px-3 border border-rose-500/40 text-rose-200 flex items-center gap-1 disabled:opacity-40"
            onClick={() => void store().run({ force: true })}
            disabled={busy || !!(lyrics && !lyrics.text.trim())}
          >
            <Sparkles className="w-3.5 h-3.5" /> ANALYSE
          </button>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* RHYME MAP */}
          <SectionHead title="Rhyme map" hint={doc.scheme || undefined} />
          <div className="px-2 pb-2">
            {mapSections(doc).map((section, si) => (
              <div key={`${section.name}-${section.start_line}-${si}`} className="pt-2">
                <div className="flex items-baseline gap-2 pb-1">
                  <span className="text-[9px] font-mono uppercase tracking-widest text-rose-300/80">
                    {section.name || 'lyric'}
                  </span>
                  <span className="text-[9px] font-mono tracking-widest text-zinc-500">{section.scheme}</span>
                  <span className="ml-auto text-[9px] font-mono tabular-nums text-zinc-600">
                    {section.lines} lines · {section.syllables} syl
                  </span>
                </div>
                <ol className="flex flex-col gap-0.5">
                  {(lyrics?.lines ?? []).map((line, i) => {
                    if (i < section.start_line || i > section.end_line) return null;
                    if (line.kind === 'marker' || !line.text.trim()) return null;
                    const m = metricsByLine.get(i);
                    const letter = m?.letter ?? '';
                    const rgb = letter ? letterChannels(letter) : '';
                    const dim = activeLetter !== '' && letter !== activeLetter;
                    return (
                      <li
                        key={i}
                        className={`flex items-start gap-2 border-l-2 pl-1.5 ${dim ? 'opacity-30' : 'opacity-100'}`}
                        style={{ borderLeftColor: rgb ? `rgb(${rgb} / 0.45)` : 'transparent' }}
                      >
                        <button
                          type="button"
                          className="mt-px w-4 shrink-0 rounded border text-center text-[9px] font-mono leading-4"
                          style={{
                            color: rgb ? `rgb(${rgb})` : 'rgb(113 113 122)',
                            borderColor: rgb ? `rgb(${rgb} / 0.55)` : 'rgb(255 255 255 / 0.08)',
                            backgroundColor: rgb ? `rgb(${rgb} / 0.12)` : 'transparent',
                          }}
                          onClick={() => setActiveLetter((v) => (v === letter ? '' : letter))}
                          disabled={!letter}
                          aria-pressed={!!letter && activeLetter === letter}
                          aria-label={letter ? `Rhyme class ${letter}: isolate it` : 'This line ends on no rhyme'}
                          title={letter ? `Rhyme class ${letter}${m?.end_key ? ` — ends on /${m.end_key}/` : ''}` : 'This line ends on no rhyme'}
                        >
                          {letter || '·'}
                        </button>
                        <span className="flex-1 text-[11px] leading-snug text-zinc-300">{line.text}</span>
                        <span
                          className="w-5 shrink-0 text-right text-[9px] font-mono tabular-nums text-zinc-600"
                          title={m?.stress ? `${m.syllables} syllables · stress ${m.stress}` : 'syllables'}
                        >
                          {m?.syllables ?? ''}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
            {!lyrics && (
              <div className="pt-2 text-[9px] font-mono text-zinc-600">
                The words are loaded by SING — open the tab to see them beside the scheme.
              </div>
            )}
          </div>

          {/* SOUND: the filters, which drive this pane AND the karaoke overlay */}
          <SectionHead title="Sound" hint="what is painted, here and on the words" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2 py-2 text-[9px] font-mono">
            {DEVICE_FAMILIES.map((f) => (
              <span key={f} className="flex items-center gap-1">
                <input
                  id={`la-family-${f}`}
                  name={`la-family-${f}`}
                  type="checkbox"
                  className="accent-rose-400"
                  checked={families[f]}
                  onChange={(e) => store().setFamily(f, e.target.checked)}
                />
                <label htmlFor={`la-family-${f}`} className="cursor-pointer select-none text-zinc-300" title={FAMILY_SHAPES[f]}>
                  {FAMILY_LABELS[f]}
                </label>
                {/* The same underline shape the karaoke paints, so the filter
                    row doubles as the overlay's legend. */}
                <span className="la-legend" aria-hidden="true">
                  <span data-device={f} />
                </span>
                <span className="tabular-nums text-zinc-600">{familyCounts[f]}</span>
              </span>
            ))}
            <span className="flex items-center gap-1">
              <label htmlFor="la-confidence" className="text-zinc-500 select-none">FLOOR</label>
              <input
                id="la-confidence"
                name="la-confidence"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={minConfidence}
                onChange={(e) => store().setMinConfidence(Number(e.target.value))}
                className="w-24 accent-rose-400"
                title="Hide findings the detector is less sure of than this"
              />
              <span className="w-8 tabular-nums text-zinc-400">{pct(minConfidence)}</span>
            </span>
            <span className="flex items-center gap-1">
              <input
                id="la-overlay"
                name="la-overlay"
                type="checkbox"
                className="accent-rose-400"
                checked={overlay}
                onChange={(e) => store().setOverlay(e.target.checked)}
              />
              <label htmlFor="la-overlay" className="cursor-pointer select-none text-zinc-300" title="Underline the devices on the karaoke words while the song plays">
                KARAOKE OVERLAY
              </label>
            </span>
            <span className="text-zinc-600">
              {shown.length} of {doc.devices.length} findings shown
            </span>
          </div>

          {/* DEVICES */}
          <SectionHead title="Devices" hint="click a finding to light it up on the words" />
          <div className="px-2 pb-2">
            {shown.length === 0 ? (
              <div className="py-2 text-[9px] font-mono text-zinc-600">
                Nothing above the floor. Lower it, or switch a family back on.
              </div>
            ) : (
              DEVICE_FAMILIES.filter((f) => byFamily.has(f)).map((family) => (
                <div key={family} className="pt-2">
                  <div className="flex items-baseline gap-2 pb-1 text-[9px] font-mono uppercase tracking-widest">
                    <span className="text-zinc-300">{FAMILY_LABELS[family]}</span>
                    <span className="normal-case tracking-normal text-zinc-600">{FAMILY_SHAPES[family]}</span>
                  </div>
                  {Array.from(byFamily.get(family) ?? []).map(([kind, devices]) => (
                    <div key={kind} className="pb-1">
                      <div className="text-[9px] font-mono text-zinc-500">
                        {kind.replace(/-/g, ' ')} <span className="text-zinc-700">{devices.length}</span>
                      </div>
                      <div className="flex flex-col">
                        {devices.slice(0, MAX_ROWS_PER_KIND).map((d) => {
                          const group = d.group || d.id;
                          const on = selectedGroup === group;
                          return (
                            <button
                              key={d.id}
                              type="button"
                              className={`flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-white/5 ${on ? 'bg-white/10' : ''}`}
                              onClick={() => store().setSelectedGroup(on ? null : group)}
                              aria-pressed={on}
                              title={[d.label, d.phones.length ? `phones: ${d.phones.join(' ')}` : ''].filter(Boolean).join(' — ')}
                            >
                              <span className="min-w-0 text-[10px] text-zinc-200">{clip(d.label, MAX_LABEL_CHARS)}</span>
                              {d.detail && (
                                <span className="text-[9px] font-mono text-zinc-500">{clip(d.detail, MAX_LABEL_CHARS)}</span>
                              )}
                              {d.source === 'llm' && (
                                <span className="shrink-0 rounded border border-fuchsia-500/30 px-1 text-[8px] font-mono text-fuchsia-300">
                                  llm
                                </span>
                              )}
                              <span className="ml-auto shrink-0 text-[9px] font-mono text-zinc-600">{deviceLines(d)}</span>
                              <span className="w-8 shrink-0 text-right text-[9px] font-mono tabular-nums text-zinc-500">
                                {pct(d.confidence)}
                              </span>
                            </button>
                          );
                        })}
                        {devices.length > MAX_ROWS_PER_KIND && (
                          <div className="px-1 py-0.5 text-[9px] font-mono text-zinc-600">
                            +{devices.length - MAX_ROWS_PER_KIND} more, not listed — they are still painted on the words
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* METRICS */}
          <SectionHead title="Metrics" />
          <div className="px-2 pb-3">
            <div className="grid grid-cols-3 gap-1.5 pt-2">
              {tiles.map(([label, value, hint]) => (
                <div key={label} className="rounded border border-white/5 bg-black/30 px-1.5 py-1" title={hint}>
                  <div className="text-[13px] font-mono tabular-nums text-zinc-100">{value}</div>
                  <div className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">{label}</div>
                </div>
              ))}
            </div>
            {stats && stats.guessed_pronunciations > 0 && (
              <div className="pt-1.5 text-[9px] font-mono text-amber-300/80">
                {stats.guessed_pronunciations} {stats.guessed_pronunciations === 1 ? 'word had' : 'words had'} no
                dictionary pronunciation and was sounded out by rule — the more of these, the softer every rhyme
                finding above.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default LyricAnalysisPane;
