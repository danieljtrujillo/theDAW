import React, { useEffect, useId, useMemo, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useLyricStudioStore } from '../../../state/lyricStudioStore';
import { rhymeInk } from '../../../state/lyricAnalysisStore';
import type { LyricAnalysisDoc } from '../../../lib/lyricAnalysisClient';
import { estimateLineSyllables, splitLyricLines, type LyricLineRow } from './lyricLines';

/**
 * The hue for a rhyme class, from `rhymeInk` — the SAME function the analysis
 * sheet, the shape strip and the karaoke overlay paint with, so a class is one
 * colour everywhere it appears.
 *
 * It must not be re-derived here. A hand-copied palette drifted from the real
 * one on its eighth entry (class H, P, X …), and reading only the first letter
 * put every class past Z on the wrong hue — scheme letters run A..Z then AA,
 * AB … and `rhymeInk` is what knows that.
 */
const letterChannels = (letter: string): string => rhymeInk(letter)?.rgb ?? '';

/** The rose the analysis pane heads a section in, for the gutter's `§`. */
const MARKER_RGB = '251 113 133';

/** Row height in px. The gutter is a parallel column of rows, so it and the
 *  textarea must agree exactly — hence a fixed leading rather than a relative
 *  one, and `wrap="off"` so one typed line is always one visual row. */
const ROW_PX = 20;

interface GutterRow {
  row: number;
  line: LyricLineRow | null;
  letter: string;
  syllables: number;
  /** The syllable count is the local estimate, not the analyser's. */
  estimated: boolean;
}

const buildRows = (draft: string, analysis: LyricAnalysisDoc | null, current: boolean): GutterRow[] => {
  const logical = splitLyricLines(draft);
  const byRow = new Map<number, LyricLineRow>();
  for (const line of logical) byRow.set(line.row, line);
  const metrics = new Map<number, LyricAnalysisDoc['lines'][number]>();
  // The metrics only describe the text they were computed from; once the words
  // have moved past them, the letters would point at the wrong lines.
  if (analysis && current) for (const m of analysis.lines) metrics.set(m.line, m);
  const rowCount = draft.split('\n').length;
  const rows: GutterRow[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const line = byRow.get(row) ?? null;
    const m = line ? metrics.get(line.index) : undefined;
    const isLyric = !!line && line.kind === 'lyric';
    rows.push({
      row,
      line,
      letter: m?.letter ?? '',
      syllables: m ? m.syllables : isLyric ? estimateLineSyllables(line.text) : 0,
      estimated: !m,
    });
  }
  return rows;
};

/**
 * The writing surface: a plain textarea with a gutter that says what the
 * analysis makes of each line — its rhyme class, its syllable count — and a
 * marker glyph where a `[Chorus]` starts a section.
 *
 * The gutter is a separate scrolling column translated by the textarea's own
 * scrollTop rather than an overlay inside it, because a textarea cannot carry
 * per-line decoration and a contenteditable would cost the writer their
 * browser's own undo stack, spellcheck and IME behaviour.
 */
export const LyricEditor: React.FC = () => {
  const uid = useId();
  const textId = `lyric-studio-text-${uid}`;
  const draft = useLyricStudioStore((s) => s.draft);
  const setDraft = useLyricStudioStore((s) => s.setDraft);
  const analysis = useLyricStudioStore((s) => s.analysis);
  const analyzedText = useLyricStudioStore((s) => s.analyzedText);
  const analyzing = useLyricStudioStore((s) => s.analyzing);
  const analysisError = useLyricStudioStore((s) => s.analysisError);
  const saving = useLyricStudioStore((s) => s.saving);
  const dirty = useLyricStudioStore((s) => s.dirty);
  const loading = useLyricStudioStore((s) => s.loading);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const current = analyzedText === draft;
  const rows = useMemo(() => buildRows(draft, analysis, current), [draft, analysis, current]);

  // The gutter follows the textarea's scroll; keeping it in a ref write rather
  // than in state avoids a React render per scrolled pixel.
  const syncScroll = (): void => {
    if (gutterRef.current && areaRef.current) {
      gutterRef.current.scrollTop = areaRef.current.scrollTop;
    }
  };
  useEffect(syncScroll, [draft]);

  const totals = useMemo(() => {
    const lyric = rows.filter((r) => r.line?.kind === 'lyric');
    return {
      lines: lyric.length,
      words: draft.split(/\s+/).filter(Boolean).length,
      syllables: lyric.reduce((sum, r) => sum + r.syllables, 0),
    };
  }, [rows, draft]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#07050a] text-zinc-200">
      <div className="flex-1 min-h-0 flex">
        {/* Gutter: line number, rhyme class, syllables */}
        <div
          ref={gutterRef}
          className="w-20 shrink-0 overflow-hidden border-r border-white/5 bg-black/30 py-2"
          aria-hidden="true"
        >
          {rows.map((r) => {
            const marker = r.line?.kind === 'marker';
            // A section marker is a thing that is there, not a blank waiting to
            // be filled: it gets the rose the analysis pane heads its sections
            // in, not the ~2:1 grey that means "no rhyme class yet".
            const rgb = marker ? MARKER_RGB : r.letter ? letterChannels(r.letter) : '';
            return (
              <div
                key={r.row}
                className="flex items-center gap-1 px-1.5 font-mono text-[10px] tabular-nums"
                style={{ height: `${ROW_PX}px` }}
              >
                <span className="w-5 text-right text-zinc-700">{r.row + 1}</span>
                <span
                  className="w-4 rounded text-center leading-4"
                  style={{
                    color: rgb ? `rgb(${rgb})` : 'rgb(63 63 70)',
                    backgroundColor: rgb ? `rgb(${rgb} / 0.12)` : 'transparent',
                  }}
                >
                  {marker ? '§' : r.letter || ''}
                </span>
                <span className={`w-5 text-right ${r.estimated ? 'text-zinc-700' : 'text-zinc-500'}`}>
                  {r.line?.kind === 'lyric' && r.syllables ? r.syllables : ''}
                </span>
              </div>
            );
          })}
        </div>

        <label htmlFor={textId} className="sr-only">Lyrics</label>
        <textarea
          ref={areaRef}
          id={textId}
          name={textId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onScroll={syncScroll}
          wrap="off"
          // While a draft is being fetched the textarea still shows the one
          // being LEFT. A keystroke here would be mirrored under the incoming
          // document's id and then saved into it, overwriting words that were
          // never opened.
          readOnly={loading}
          spellCheck
          className="flex-1 min-w-0 resize-none bg-transparent px-3 py-2 font-mono text-[12px] text-zinc-100 outline-none placeholder:text-zinc-700"
          style={{ lineHeight: `${ROW_PX}px` }}
          placeholder={'Write. One line per line.\n\n[Chorus] or (bridge) on their own line start a section.'}
        />
      </div>

      {/* What the analysis makes of it so far */}
      <div className="shrink-0 flex items-center gap-3 border-t border-white/5 bg-black/30 px-2 py-1 font-mono text-[9px] text-zinc-500">
        <span className="tabular-nums">
          {totals.lines} lines · {totals.words} words · {totals.syllables} syl
        </span>
        <span className="text-zinc-700" title="Rhyme class letters come from the analysis; the syllable count is a local estimate until it lands">
          {current ? 'gutter: analysed' : 'gutter: estimated'}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {analysisError && <span className="text-amber-300">analysis: {analysisError}</span>}
          {saving ? (
            <span className="flex items-center gap-1 text-zinc-400">
              <Loader2 className="w-3 h-3 animate-spin" /> saving
            </span>
          ) : dirty ? (
            <span className="text-amber-300/80">unsaved</span>
          ) : (
            <span className="text-zinc-600">saved</span>
          )}
          {analyzing && (
            <span className="flex items-center gap-1 text-rose-300">
              <Loader2 className="w-3 h-3 animate-spin" /> reading
            </span>
          )}
        </span>
      </div>
    </div>
  );
};

export default LyricEditor;
