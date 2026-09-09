import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useLibraryStore } from '../../../state/libraryStore';
import { useLyricsStore } from '../../../state/lyricsStore';
import {
  DEVICE_FAMILIES,
  FAMILY_LABELS,
  FAMILY_RGB,
  LONG_RANGE_BLURB,
  LONG_RANGE_CODE,
  LONG_RANGE_KINDS,
  MARK_GLYPH,
  MARK_RGB,
  MARK_WORDS,
  asFamily,
  buildMarkIndex,
  buildSheetModel,
  buildStructureMap,
  detectedDevices,
  groupInk,
  inkAt,
  rejectedGroups,
  rhymeLanes,
  useLyricAnalysisStore,
  visibleDevices,
  wordMarkKey,
  type MarkWordCell,
  type SheetLink,
  type SheetLinkEnd,
  type SheetModel,
  type SheetRow,
  type SheetSource,
  type StructureBand,
  type StructureMapModel,
} from '../../../state/lyricAnalysisStore';
import type {
  Device,
  DeviceFamily,
  LyricAnalysisDoc,
  LyricMark,
  MarkVerdict,
  SectionSummary,
  Span,
} from '../../../lib/lyricAnalysisClient';
import { splitText } from './singSync';
import './sing.css';

/** Matches the underline shapes sing.css paints, so the legend, the sheet and
 *  the karaoke words all say the same thing without relying on hue. */
const FAMILY_SHAPES: Record<DeviceFamily, string> = {
  rhyme: 'solid underline',
  sound: 'dotted underline',
  repetition: 'double underline',
  structure: 'dashed underline',
  meaning: 'dotted overline',
};

/** The sections to draw from: a lyric with no markers still gets one. */
const mapSections = (doc: LyricAnalysisDoc, rows: SheetRow[]): SectionSummary[] => {
  if (doc.sections.length) return doc.sections;
  return [
    {
      name: '',
      start_line: 0,
      end_line: rows.length ? rows[rows.length - 1].line : 0,
      scheme: doc.scheme,
      lines: doc.stats.lines,
      syllables: doc.stats.syllables,
    },
  ];
};

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Confidence as ink: the same ramp the karaoke overlay uses. */
const alphaFor = (confidence: number): string => (0.34 + 0.66 * clamp01(confidence)).toFixed(2);
const sureTier = (confidence: number): 'low' | 'mid' | 'high' =>
  confidence >= 0.9 ? 'high' : confidence >= 0.7 ? 'mid' : 'low';
const SURE_WORDS: Record<'low' | 'mid' | 'high', string> = {
  high: 'certain',
  mid: 'likely',
  low: 'loose',
};

/** A repeated hook in a long lyric is one finding with ten thousand spans, and
 *  the backend's label names every one of them. Nothing in the findings list
 *  may grow with the song: the label is clipped, the line list is clipped, and
 *  each kind shows a bounded number of rows. */
const MAX_LABEL_CHARS = 90;
const MAX_LINE_REFS = 6;
const MAX_ROWS_PER_KIND = 50;
/** Spans listed in the inspector before it starts counting instead. */
const MAX_INSPECT_SPANS = 24;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const kindWords = (kind: string): string => kind.replace(/-/g, ' ');

/** "L4 · L7": the lines a finding touches, in the reading order of the lyric. */
const deviceLines = (device: Device): string => {
  const seen = Array.from(new Set(device.spans.map((s) => s.line))).sort((a, b) => a - b);
  const head = seen.slice(0, MAX_LINE_REFS).map((l) => `L${l + 1}`).join(' · ');
  return seen.length > MAX_LINE_REFS ? `${head} +${seen.length - MAX_LINE_REFS}` : head;
};

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

// --- marking by hand -------------------------------------------------------

/** What the writer can call a thing they marked. The taxonomy's own names
 *  first, because a mark that shares a kind with the detectors can be compared
 *  with them; `''` is the free note, for what has no name yet. */
const MARK_KINDS: Array<[string, string]> = [
  ['end-rhyme', 'end rhyme'],
  ['internal-rhyme', 'internal rhyme'],
  ['multisyllabic-rhyme', 'multisyllabic rhyme'],
  ['slant-rhyme', 'slant rhyme'],
  ['identical-rhyme', 'identical rhyme'],
  ['rhyme-run', 'rhyme run'],
  ['rhyme-chain', 'rhyme chain'],
  ['callback', 'callback'],
  ['bookend', 'bookend'],
  ['alliteration', 'alliteration'],
  ['assonance', 'assonance'],
  ['refrain', 'refrain'],
  ['metaphor', 'metaphor'],
  ['pun', 'pun'],
  ['', 'a note'],
];

/** Every word between two picks, in reading order — what a shift-click means.
 *  It runs across lines on purpose: marking a whole couplet is one drag. */
const rangeKeys = (
  rows: SheetRow[],
  from: { line: number; word: number },
  to: { line: number; word: number },
): string[] => {
  const forward = to.line > from.line || (to.line === from.line && to.word >= from.word);
  const a = forward ? from : to;
  const b = forward ? to : from;
  const out: string[] = [];
  for (const row of rows) {
    if (row.line < a.line || row.line > b.line) continue;
    const first = row.line === a.line ? a.word : 0;
    const last = row.line === b.line ? b.word : row.wordRanges.length - 1;
    for (let w = first; w <= last && w < row.wordRanges.length; w += 1) {
      if (w >= 0) out.push(wordMarkKey(row.line, w));
    }
  }
  return out;
};

/** The picked words as `Span`s the backend understands. Whole words only — the
 *  writer picks words, so `char_end` is always "to the end of it". */
const spansFromSelection = (rows: SheetRow[], selection: ReadonlySet<string>): Span[] => {
  const out: Span[] = [];
  for (const row of rows) {
    for (let w = 0; w < row.wordRanges.length; w += 1) {
      if (!selection.has(wordMarkKey(row.line, w))) continue;
      const [start, end] = row.wordRanges[w];
      out.push({
        line: row.line,
        word: w,
        char_start: 0,
        char_end: null,
        text: row.text.slice(start, end),
      });
    }
  }
  return out;
};

/** A mark is never nameless: with no label typed, it is called after the words
 *  it covers, the way the detectors name theirs. */
const autoMarkLabel = (kind: string, spans: Span[]): string => {
  const words = spans.map((s) => s.text).filter(Boolean);
  const head = words.slice(0, 4).join(' / ');
  const tail = words.length > 4 ? ` +${words.length - 4}` : '';
  const name = kind ? kind.replace(/-/g, ' ') : 'note';
  return clip(`${name}: ${head}${tail}`, MAX_LABEL_CHARS);
};

/** "L4 · L7" for a mark, the same shorthand the findings list uses. */
const markLines = (mark: LyricMark): string => {
  const seen = Array.from(new Set(mark.spans.map((s) => s.line))).sort((a, b) => a - b);
  const head = seen.slice(0, MAX_LINE_REFS).map((l) => `L${l + 1}`).join(' · ');
  return seen.length > MAX_LINE_REFS ? `${head} +${seen.length - MAX_LINE_REFS}` : head;
};

const SectionHead: React.FC<{ title: string; hint?: string }> = ({ title, hint }) => (
  <div className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-white/5 bg-[#07050a] px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-500">
    <span className="text-zinc-300">{title}</span>
    {hint && <span className="normal-case tracking-normal text-zinc-600">{hint}</span>}
  </div>
);

// --- the shape strip -------------------------------------------------------

/**
 * The whole lyric in one bar: a column per line carrying its syllable count,
 * how many findings landed on it, and its rhyme class. Where the writing is
 * dense and where it is bare is one glance, and a click jumps the sheet there.
 */
const ShapeStrip: React.FC<{
  model: SheetModel;
  activeLine: number;
  onJump: (line: number) => void;
}> = ({ model, activeLine, onJump }) => {
  const { rows, maxDevices, maxSyllables } = model;
  const shown = rows.filter((r) => !r.blank);
  if (!shown.length) return null;
  return (
    <div className="overflow-x-auto px-2 pt-2 pb-1">
      <div className="la-shape h-8" role="group" aria-label="The lyric line by line: syllables, device density, rhyme class">
        {shown.map((row) => {
          if (row.kind === 'marker') {
            return (
              <span
                key={row.line}
                className="h-8 w-px shrink-0 bg-rose-400/50"
                title={row.text}
                aria-hidden="true"
              />
            );
          }
          const ink = inkAt(row.classIndex);
          const syl = maxSyllables ? row.syllables / maxSyllables : 0;
          const dev = maxDevices ? row.devices / maxDevices : 0;
          const family = row.families[0];
          return (
            <button
              key={row.line}
              type="button"
              className="la-shape-col h-8"
              {...(row.line === activeLine ? { 'data-on': '' } : {})}
              onClick={() => onJump(row.line)}
              aria-label={`Line ${row.line + 1}${row.letter ? `, rhyme class ${row.letter}` : ''}: ${row.syllables} syllables, ${row.devices} findings`}
              title={`L${row.line + 1}${row.letter ? ` · ${row.letter}` : ''} · ${row.syllables} syl · ${row.devices} ${row.devices === 1 ? 'finding' : 'findings'}\n${clip(row.text, 60)}`}
            >
              <span className="h-4">
                <i style={{ height: `${Math.max(6, syl * 100)}%`, background: 'rgb(113 113 122 / 0.85)' }} />
              </span>
              <span className="h-3">
                <i
                  style={{
                    height: `${Math.max(row.devices ? 12 : 0, dev * 100)}%`,
                    background: `rgb(${family ? FAMILY_RGB[family] : '113 113 122'} / 0.9)`,
                  }}
                />
              </span>
              <span
                className="h-1"
                style={{ background: ink ? `rgb(${ink.rgb} / 0.9)` : 'rgb(255 255 255 / 0.05)' }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
};

// --- the link layer --------------------------------------------------------

/** How far apart two ends can be before their arc is only drawn on demand. */
const LINK_REACH = 2;

interface LinkPath extends SheetLink {
  d: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

interface Anchor {
  x: number;
  top: number;
  bottom: number;
}

/** Where a span ended up on screen, as the union of the segments covering it.
 *  Measured from the DOM because the sheet's text wraps — there is no layout
 *  model here to compute it from. */
const anchorFor = (
  end: SheetLinkEnd,
  byLine: Map<number, Array<{ s: number; e: number; rect: DOMRect }>>,
  host: DOMRect,
): Anchor | null => {
  const list = byLine.get(end.line);
  if (!list) return null;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const seg of list) {
    if (seg.e <= end.start || seg.s >= end.end) continue;
    left = Math.min(left, seg.rect.left);
    right = Math.max(right, seg.rect.right);
    top = Math.min(top, seg.rect.top);
    bottom = Math.max(bottom, seg.rect.bottom);
  }
  if (right < left) return null;
  return { x: (left + right) / 2 - host.left, top: top - host.top, bottom: bottom - host.top };
};

// --- the sheet -------------------------------------------------------------

export interface LyricSheetProps {
  doc: LyricAnalysisDoc;
  model: SheetModel;
  /** The class being isolated (a `SheetRow.classKey`), '' for none. */
  activeClass: string;
  onClass: (classKey: string) => void;
  onPickDevice: (deviceId: string) => void;
  selectedGroup: string | null;
  selectedDeviceId: string | null;
  showLinks: boolean;
  showStress: boolean;
  /** False when the words have not been loaded: the rows fall back to the
   *  ending each line rhymed on. */
  hasWords: boolean;
  sheetRef?: React.RefObject<HTMLDivElement | null>;
  /** Marking mode: a click on a word puts it in the selection instead of
   *  opening the finding under it. */
  markMode?: boolean;
  /** Words picked for the mark being composed, keyed `line:word`. */
  selection?: ReadonlySet<string>;
  onWord?: (line: number, word: number, mode: 'toggle' | 'range' | 'drag') => void;
  /** Enter on the sheet names what has been picked; Escape drops it. Without
   *  these the whole marking flow needs the mouse to finish. */
  onCommitPick?: () => void;
  onCancelPick?: () => void;
  /** Word -> the writer's mark on it. */
  markIndex?: Map<string, MarkWordCell>;
  /** Opening a marked word out of marking mode reads the mark. */
  onOpenMark?: (markId: string) => void;
  /** The long-range finding being read, brought back onto the words as a
   *  spine down the margin from its first line to its last. */
  structSpan?: { rgb: string; from: number; to: number; lines: ReadonlySet<number> } | null;
}

/**
 * The lyric, readable, with the findings drawn ON it.
 *
 * Down the gutter, each rhyme class is a bracket joining its lines, with a
 * per-class shape at every member so two classes never differ by hue alone.
 * In the text, every finding is painted at its own character offsets — the
 * `-ation` of `celebration`, the stressed syllable of an assonance — with the
 * family in the line's shape and the detector's confidence in its weight.
 * Over the top, internal and cross-line rhymes are drawn as arcs, because in
 * a rap lyric those are the whole point and a list hides them completely.
 */
export const LyricSheet: React.FC<LyricSheetProps> = ({
  doc,
  model,
  activeClass,
  onClass,
  onPickDevice,
  selectedGroup,
  selectedDeviceId,
  showLinks,
  showStress,
  hasWords,
  sheetRef,
  markMode = false,
  selection,
  onWord,
  onCommitPick,
  onCancelPick,
  markIndex,
  onOpenMark,
  structSpan,
}) => {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const hostRef = sheetRef ?? ownRef;
  const [paths, setPaths] = useState<LinkPath[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** Roving tabindex: one word carries the tab stop and the arrows move it,
   *  because a lyric has hundreds of words and every one of them being a tab
   *  stop would make the sheet unusable from a keyboard. */
  const [focusKey, setFocusKey] = useState('');
  const draggingRef = useRef(false);

  // A drag that ends outside the sheet (or outside the window) still ends.
  useEffect(() => {
    if (!markMode) {
      draggingRef.current = false;
      return;
    }
    const stop = (): void => {
      draggingRef.current = false;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [markMode]);

  const firstWordKey = useMemo(() => {
    for (const row of model.rows) {
      if (row.wordRanges.length) return wordMarkKey(row.line, 0);
    }
    return '';
  }, [model.rows]);

  /** Where the tab stop actually sits. A remembered word that the lyric no
   *  longer has would leave the sheet with no tab stop at all, so it falls
   *  back to the first word rather than to nothing. */
  const tabKey = useMemo(() => {
    if (!focusKey) return firstWordKey;
    const [line, word] = focusKey.split(':').map(Number);
    const row = model.rows.find((r) => r.line === line);
    return row && word >= 0 && word < row.wordRanges.length ? focusKey : firstWordKey;
  }, [focusKey, firstWordKey, model.rows]);

  /** Arrow-key navigation over the words, in the sheet's own reading order —
   *  the DOM order of the word buttons, which is the order of the lyric. */
  const onSheetKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!markMode || !onWord) return;
      // Space picks the word (the button's own behaviour), Enter names what is
      // picked, Escape drops it — so the whole flow finishes without a mouse.
      // Enter has to be stopped here or the button turns it into a click and
      // un-picks the word instead.
      if (e.key === 'Enter') {
        e.preventDefault();
        onCommitPick?.();
        return;
      }
      if (e.key === 'Escape') {
        onCancelPick?.();
        return;
      }
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      const host = hostRef.current;
      const active = document.activeElement;
      if (!host || !(active instanceof HTMLElement) || !active.dataset.word) return;
      // A word is drawn in as many pieces as the devices on it cut it into,
      // and every piece is its own button. Navigation is by WORD: stepping
      // piece by piece lands the focus back inside the word it started in and
      // reads, correctly, as the arrow key having done nothing. The first
      // piece of each word is the one that carries the tab stop, so it is the
      // one moved between here too.
      const pieces = Array.from(host.querySelectorAll<HTMLElement>('button[data-word]'));
      const buttons: HTMLElement[] = [];
      let seen = '';
      for (const piece of pieces) {
        const key = piece.dataset.word ?? '';
        if (key !== seen) buttons.push(piece);
        seen = key;
      }
      const activeKey = active.dataset.word ?? '';
      const at = buttons.findIndex((el) => el.dataset.word === activeKey);
      if (at < 0) return;
      const lineOf = (el: HTMLElement): number => Number((el.dataset.word ?? '').split(':')[0]);
      const here = lineOf(active);
      let next = at;
      if (e.key === 'ArrowRight') next = Math.min(buttons.length - 1, at + 1);
      else if (e.key === 'ArrowLeft') next = Math.max(0, at - 1);
      else if (e.key === 'Home') {
        next = at;
        while (next > 0 && lineOf(buttons[next - 1]) === here) next -= 1;
      } else if (e.key === 'End') {
        next = at;
        while (next < buttons.length - 1 && lineOf(buttons[next + 1]) === here) next += 1;
      } else {
        // Up / down: the same position along the previous or next line that
        // has words, so a column of rhyming endings walks straight down.
        const step = e.key === 'ArrowDown' ? 1 : -1;
        let ordinal = 0;
        for (let i = at - 1; i >= 0 && lineOf(buttons[i]) === here; i -= 1) ordinal += 1;
        let i = at;
        while (i >= 0 && i < buttons.length && lineOf(buttons[i]) === here) i += step;
        if (i < 0 || i >= buttons.length) return;
        const target = lineOf(buttons[i]);
        // Walk to the start of that line, then along it.
        while (i > 0 && lineOf(buttons[i - 1]) === target) i -= 1;
        let j = i;
        while (j + 1 < buttons.length && lineOf(buttons[j + 1]) === target && j - i < ordinal) j += 1;
        next = j;
      }
      if (next === at) return;
      e.preventDefault();
      const el = buttons[next];
      const key = el.dataset.word ?? '';
      setFocusKey(key);
      el.focus();
      if (e.shiftKey) {
        const [line, word] = key.split(':').map(Number);
        onWord(line, word, 'drag');
      }
    },
    [markMode, onWord, onCommitPick, onCancelPick, hostRef],
  );

  const sections = useMemo(() => mapSections(doc, model.rows), [doc, model.rows]);

  // A rap lyric answers itself constantly, and every one of those answers as a
  // wire would bury the words. At rest only the near ones are drawn — the ones
  // a reader would otherwise miss entirely — and the long echoes appear when
  // their finding is the one being read.
  const drawn = useMemo(
    () =>
      model.links.filter(
        (l) =>
          Math.abs(l.b.line - l.a.line) <= LINK_REACH ||
          (!!selectedGroup && l.group === selectedGroup),
      ),
    [model.links, selectedGroup],
  );

  // The arcs are measured, not computed: the anchors move with every rewrap,
  // so this re-runs on a resize and whenever the model changes, and NEVER on
  // a scroll (the layer is inside the same scrolled box as the words).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!showLinks || !drawn.length) {
      setPaths([]);
      return;
    }
    let raf = 0;
    const measure = () => {
      raf = 0;
      const hostRect = host.getBoundingClientRect();
      const byLine = new Map<number, Array<{ s: number; e: number; rect: DOMRect }>>();
      host.querySelectorAll<HTMLElement>('[data-seg]').forEach((el) => {
        const parts = (el.dataset.seg ?? '').split(':');
        const line = Number(parts[0]);
        if (!Number.isFinite(line)) return;
        const list = byLine.get(line) ?? [];
        list.push({ s: Number(parts[1]), e: Number(parts[2]), rect: el.getBoundingClientRect() });
        byLine.set(line, list);
      });
      const out: LinkPath[] = [];
      for (const link of drawn) {
        // Always draw downward, whichever order the spans came in.
        const forward = link.b.line > link.a.line || (link.b.line === link.a.line && link.b.start >= link.a.start);
        const first = forward ? link.a : link.b;
        const second = forward ? link.b : link.a;
        const a = anchorFor(first, byLine, hostRect);
        const b = anchorFor(second, byLine, hostRect);
        if (!a || !b) continue;
        let d: string;
        if (first.line === second.line) {
          // Inside one line: a slur under the words, the way a phrase mark sits.
          const y = Math.max(a.bottom, b.bottom);
          const dip = Math.min(16, 5 + Math.abs(b.x - a.x) * 0.12);
          d = `M ${a.x} ${a.bottom} C ${a.x} ${y + dip}, ${b.x} ${y + dip}, ${b.x} ${b.bottom}`;
        } else {
          const bend = Math.max(12, Math.min(52, Math.abs(b.x - a.x) * 0.3 + (b.top - a.bottom) * 0.3));
          d = `M ${a.x} ${a.bottom} C ${a.x - bend} ${a.bottom + bend * 0.7}, ${b.x - bend} ${b.top - bend * 0.7}, ${b.x} ${b.top}`;
        }
        out.push({
          ...link,
          a: first,
          b: second,
          d,
          ax: a.x,
          ay: a.bottom,
          bx: b.x,
          by: first.line === second.line ? b.bottom : b.top,
        });
      }
      setPaths(out);
      const w = host.clientWidth;
      const h = host.clientHeight;
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    schedule();
    const ro = new ResizeObserver(schedule);
    ro.observe(host);
    // Web fonts land after the first paint and move every anchor with them.
    void document.fonts?.ready?.then(schedule).catch(() => {});
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [hostRef, drawn, model.rows, showLinks, showStress, hasWords]);

  // Isolating a class has to take the wiring with it, or the arcs keep
  // shouting over the lines that were just pushed back.
  const litLines = useMemo(() => {
    if (!activeClass) return null;
    return new Set(model.rows.filter((r) => r.classKey === activeClass).map((r) => r.line));
  }, [model.rows, activeClass]);

  const rowsByLine = useMemo(() => {
    const map = new Map<number, SheetRow>();
    for (const row of model.rows) map.set(row.line, row);
    return map;
  }, [model.rows]);

  return (
    <div
      className="la-sheet px-2 pb-2"
      ref={hostRef}
      onKeyDown={onSheetKeyDown}
      {...(markMode ? { 'data-marking': '' } : {})}
    >
      {paths.length > 0 && (
        <svg
          className="la-links"
          width={size.w}
          height={size.h}
          role="img"
          aria-label={`${paths.length} internal and cross-line ${paths.length === 1 ? 'rhyme' : 'rhymes'} drawn as arcs; each one is also in the findings list below`}
        >
          {paths.map((p) => {
            const on = !!selectedGroup && p.group === selectedGroup;
            const off = !!litLines && !litLines.has(p.a.line) && !litLines.has(p.b.line);
            return (
              <g key={p.id}>
                <path
                  d={p.d}
                  stroke={`rgb(${p.rgb})`}
                  strokeWidth={on ? 2.2 : 1 + p.confidence * 0.6}
                  strokeOpacity={
                    off ? 0.05 : selectedGroup ? (on ? 0.95 : 0.1) : 0.14 + p.confidence * 0.32
                  }
                  strokeDasharray={p.dash || undefined}
                  strokeLinecap="round"
                  onClick={() => onPickDevice(p.deviceId)}
                >
                  <title>{`${kindWords(p.kind)}: ${p.a.text} → ${p.b.text} · ${pct(p.confidence)}`}</title>
                </path>
                <circle cx={p.ax} cy={p.ay} r={on ? 2.4 : 1.6} fill={`rgb(${p.rgb})`} fillOpacity={off ? 0.08 : on ? 1 : 0.55} />
                <circle cx={p.bx} cy={p.by} r={on ? 2.4 : 1.6} fill={`rgb(${p.rgb})`} fillOpacity={off ? 0.08 : on ? 1 : 0.55} />
              </g>
            );
          })}
        </svg>
      )}

      {sections.map((section, si) => {
        const rows = model.rows.filter((r) => r.line >= section.start_line && r.line <= section.end_line);
        if (!rows.length) return null;
        // Lanes are per section: an "A" in the chorus is not the "A" of the
        // first verse, so the two must never be bracketed together.
        const lanes = rhymeLanes(rows);
        const gutter = Math.max(lanes.lanes, 1) * 7;
        return (
          <div key={`${section.name}-${section.start_line}-${si}`} className="pt-2">
            <div className="flex items-baseline gap-2 pb-1">
              <span className="text-[9px] font-mono uppercase tracking-widest text-rose-300/80">
                {section.name || 'lyric'}
              </span>
              <span className="truncate text-[9px] font-mono tracking-widest text-zinc-500" title={section.scheme}>
                {clip(section.scheme, 40)}
              </span>
              <span className="ml-auto shrink-0 text-[9px] font-mono tabular-nums text-zinc-600">
                {section.lines} lines · {section.syllables} syl
              </span>
            </div>
            {rows.map((row, idx) => {
              const cellsFor = (): React.ReactNode =>
                Array.from({ length: Math.max(lanes.lanes, 1) }, (_, lane) => {
                  const cell = (lanes.cells.get(idx) ?? [])[lane] ?? null;
                  const cellInk = cell ? inkAt(cell.classIndex) : null;
                  if (!cell || !cellInk) return <span key={lane} className="la-lane" />;
                  const faded = activeClass !== '' && cell.classKey !== activeClass;
                  return (
                    <span
                      key={lane}
                      className="la-lane"
                      data-state={cell.state}
                      style={
                        {
                          '--lane-rgb': cellInk.rgb,
                          '--lane-style': cellInk.pattern,
                          '--lane-w': cellInk.pattern === 'double' ? '3px' : '1.5px',
                          '--lane-a': faded ? 0.2 : 0.65,
                        } as React.CSSProperties
                      }
                    >
                      {cell.state !== 'through' && (
                        <span className="la-node" data-shape={cellInk.shape} style={{ opacity: faded ? 0.3 : 1 }} />
                      )}
                    </span>
                  );
                });
              // A blank line still carries the gutter, or every bracket that
              // crosses one is drawn with a hole in it.
              if (row.blank) {
                return (
                  <div key={row.line} className="la-row h-2" data-row={row.line}>
                    <div className="la-gutter" style={{ width: `${gutter}px` }} aria-hidden="true">
                      {cellsFor()}
                    </div>
                  </div>
                );
              }
              const ink = inkAt(row.classIndex);
              const dim = activeClass !== '' && row.classKey !== activeClass;
              // The selected long-range finding, drawn back onto the lyric:
              // solid where it lands, faint across everything it reaches over.
              const struct = structSpan
                ? structSpan.lines.has(row.line)
                  ? 'member'
                  : row.line > structSpan.from && row.line < structSpan.to
                    ? 'through'
                    : ''
                : '';
              // A word may be cut into several pieces by the findings on it;
              // only the first piece carries the tab stop, so one word is one
              // stop and "ele|VATION" is not two.
              const firstPieceOf = new Map<number, number>();
              row.segments.forEach((s, i) => {
                if (s.word >= 0 && !firstPieceOf.has(s.word)) firstPieceOf.set(s.word, i);
              });
              return (
                <div
                  key={row.line}
                  className="la-row"
                  data-row={row.line}
                  data-kind={row.kind}
                  {...(dim ? { 'data-dim': '' } : {})}
                  {...(!dim && activeClass !== '' && row.classKey === activeClass ? { 'data-hit': '' } : {})}
                  {...(struct ? { 'data-struct': struct } : {})}
                  style={
                    struct && structSpan
                      ? ({ '--struct-rgb': structSpan.rgb } as React.CSSProperties)
                      : undefined
                  }
                >
                  <div className="la-gutter" style={{ width: `${gutter}px` }} aria-hidden="true">
                    {cellsFor()}
                  </div>

                  <button
                    type="button"
                    className="my-0.5 h-4 w-4 shrink-0 self-start rounded border text-center text-[9px] font-mono leading-4"
                    style={{
                      color: ink ? `rgb(${ink.rgb})` : 'rgb(113 113 122)',
                      borderColor: ink ? `rgb(${ink.rgb} / 0.55)` : 'rgb(255 255 255 / 0.08)',
                      borderStyle: ink ? ink.pattern : 'solid',
                      backgroundColor: ink ? `rgb(${ink.rgb} / 0.12)` : 'transparent',
                    }}
                    onClick={() => onClass(row.classKey === activeClass ? '' : row.classKey)}
                    disabled={!row.classKey}
                    aria-pressed={!!row.classKey && activeClass === row.classKey}
                    aria-label={
                      row.letter
                        ? `Rhyme class ${row.letter} on line ${row.line + 1}: isolate it`
                        : `Line ${row.line + 1} ends on no rhyme`
                    }
                    title={
                      row.letter
                        ? `Rhyme class ${row.letter}${row.endKey ? ` — ends on /${row.endKey}/` : ''}`
                        : 'This line ends on no rhyme'
                    }
                  >
                    {row.letter || '·'}
                  </button>

                  <div className="la-text">
                    {row.segments.length ? (
                      row.segments.map((seg, si) => {
                        const key = seg.word >= 0 ? wordMarkKey(row.line, seg.word) : '';
                        const cell = key ? markIndex?.get(key) : undefined;
                        const picked = !!key && !!selection?.has(key);
                        const segInk = seg.classIndex >= 0 ? inkAt(seg.classIndex) : null;
                        const on = !!selectedGroup && seg.groups.includes(selectedGroup);
                        // Everything the piece is wearing, whichever element it
                        // turns out to be: the engine's underline, the writer's
                        // box, and the pick being composed right now.
                        const paint = {
                          'data-seg': `${row.line}:${seg.start}:${seg.end}`,
                          ...(seg.family
                            ? {
                                'data-device': seg.family,
                                'data-sure': sureTier(seg.confidence),
                                ...(seg.stack > 1 ? { 'data-stack': Math.min(3, seg.stack) } : {}),
                                ...(on ? { 'data-device-on': '' } : {}),
                              }
                            : {}),
                          ...(cell ? { 'data-mark': cell.verdict } : {}),
                          ...(picked ? { 'data-sel': '' } : {}),
                          style: {
                            ...(seg.family ? { '--dev-a': alphaFor(seg.confidence) } : {}),
                            ...(seg.family && segInk ? { '--dev-rgb': segInk.rgb } : {}),
                            ...(cell ? { '--mark-rgb': MARK_RGB[cell.verdict] } : {}),
                          } as React.CSSProperties,
                        };
                        const deviceSays = seg.family
                          ? `${seg.title} · ${pct(seg.confidence)} ${SURE_WORDS[sureTier(seg.confidence)]}`
                          : '';
                        const markSays = cell ? `${MARK_WORDS[cell.verdict]}: ${cell.title}` : '';

                        // Marking: every word is a target, and the tab stop
                        // rides on one of them (the arrows move it).
                        if (markMode && key && onWord) {
                          return (
                            <button
                              key={seg.start}
                              type="button"
                              {...paint}
                              data-word={key}
                              tabIndex={key === tabKey && firstPieceOf.get(seg.word) === si ? 0 : -1}
                              onPointerDown={(e) => {
                                draggingRef.current = true;
                                setFocusKey(key);
                                onWord(row.line, seg.word, e.shiftKey ? 'range' : 'toggle');
                              }}
                              onPointerEnter={() => {
                                if (draggingRef.current) onWord(row.line, seg.word, 'drag');
                              }}
                              onFocus={() => setFocusKey(key)}
                              // A keyboard activation only: the pointer path is
                              // handled above, and `detail` is 0 for space/enter.
                              onClick={(e) => {
                                if (e.detail === 0) onWord(row.line, seg.word, e.shiftKey ? 'range' : 'toggle');
                              }}
                              aria-pressed={picked}
                              aria-label={`${seg.text || 'space'}, line ${row.line + 1} word ${seg.word + 1}${
                                markSays ? ` — ${markSays}` : ''
                              }${deviceSays ? ` — ${deviceSays}` : ''}`}
                              title={`${picked ? 'picked' : 'pick this word'} — shift to take everything back to the last pick\narrows move · space picks · enter names them · escape drops them${
                                markSays ? `\n${markSays}` : ''
                              }${deviceSays ? `\n${deviceSays}` : ''}`}
                            >
                              {seg.text}
                            </button>
                          );
                        }

                        // Reading: a marked word opens ITS mark, a found one
                        // opens the finding, and plain text is plain text.
                        if (cell && onOpenMark) {
                          return (
                            <button
                              key={seg.start}
                              type="button"
                              {...paint}
                              onClick={() => onOpenMark(cell.ids[0])}
                              aria-label={`${seg.text}: ${markSays}${deviceSays ? ` — ${deviceSays}` : ''}`}
                              title={`${markSays}${deviceSays ? `\n${deviceSays}` : ''}`}
                            >
                              {seg.text}
                            </button>
                          );
                        }
                        if (!seg.family) {
                          return (
                            <span key={seg.start} {...paint}>
                              {seg.text}
                            </span>
                          );
                        }
                        return (
                          <button
                            key={seg.start}
                            type="button"
                            {...paint}
                            onClick={() => onPickDevice(seg.deviceId)}
                            aria-pressed={seg.deviceId === selectedDeviceId}
                            aria-label={`${seg.text}: ${seg.title}, ${pct(seg.confidence)} ${SURE_WORDS[sureTier(seg.confidence)]}`}
                            title={`${seg.title}\n${pct(seg.confidence)} ${SURE_WORDS[sureTier(seg.confidence)]}${seg.letter ? ` · class ${seg.letter}` : ''}`}
                          >
                            {seg.text}
                          </button>
                        );
                      })
                    ) : row.text ? (
                      <span data-seg={`${row.line}:0:${row.text.length}`}>{row.text}</span>
                    ) : (
                      <span className="text-zinc-600">
                        {row.endKey ? `line ${row.line + 1} — ends on /${row.endKey}/` : `line ${row.line + 1}`}
                      </span>
                    )}
                  </div>

                  <div className="flex shrink-0 items-start gap-1.5 self-start pt-1">
                    {showStress && row.stress && (
                      <span
                        className="la-stress"
                        title={`stress ${row.stress}`}
                        aria-label={`Stress pattern ${row.stress}`}
                        role="img"
                      >
                        {row.stress.split('').map((s, k) => (
                          <i key={k} data-s={s} />
                        ))}
                      </span>
                    )}
                    {/* How much this line is carrying, as a bar you can compare
                        down the page without reading a single number. */}
                    <span
                      className="mt-1 flex h-1 w-6 overflow-hidden rounded-xs bg-white/5"
                      aria-hidden="true"
                      title={`${row.devices} ${row.devices === 1 ? 'finding' : 'findings'} on this line`}
                    >
                      <i
                        className="block h-full"
                        style={{
                          width: `${model.maxDevices ? Math.round((row.devices / model.maxDevices) * 100) : 0}%`,
                          background: `rgb(${row.families[0] ? FAMILY_RGB[row.families[0]] : '113 113 122'} / 0.9)`,
                        }}
                      />
                    </span>
                    <span
                      className="w-4 text-right text-[9px] font-mono tabular-nums text-zinc-400"
                      title={`${row.syllables} syllables${row.stress ? ` · stress ${row.stress}` : ''}`}
                    >
                      {row.syllables || ''}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
      {model.linkOverflow > 0 && showLinks && (
        <div className="pt-1 text-[9px] font-mono text-zinc-600">
          +{model.linkOverflow} more links not drawn — the layer is capped so the words stay readable
        </div>
      )}
      {!hasWords && (
        <div className="pt-2 text-[9px] font-mono text-zinc-600">
          The words are loaded by SING — open the tab to read them under the scheme.
          {rowsByLine.size > 0 && ' The endings each line rhymed on are shown instead.'}
        </div>
      )}
    </div>
  );
};

// --- the shape over distance -----------------------------------------------

/**
 * The long-range rhyme findings, each on its own track spanning the whole
 * lyric: a run is a block, a chain is a thread with its members ticked, a
 * callback is a dashed reach with both ends capped, a bookend is a section
 * tied at its two edges. The kind is in the shape AND in the code letters at
 * the left, so nothing here needs a colour to be read; picking one lights its
 * lines on the sheet below and draws its ends as a wire.
 */
const StructureMap: React.FC<{
  map: StructureMapModel;
  rows: SheetRow[];
  selectedDeviceId: string | null;
  onPick: (deviceId: string) => void;
}> = ({ map, rows, selectedDeviceId, onPick }) => {
  const { bands, columns } = map;
  // Where the sections change, on the same axis the bands are drawn on: a
  // callback landing in a later section reads as one, not as a long arrow.
  const sectionCuts = useMemo(() => {
    const cuts: number[] = [];
    let col = 0;
    let last = '';
    for (const row of rows) {
      if (row.blank) continue;
      if (col > 0 && row.section !== last) cuts.push(col);
      last = row.section;
      col += 1;
    }
    return cuts;
  }, [rows]);

  const kindsHere = useMemo(
    () => Array.from(new Set(bands.map((b) => b.kind))),
    [bands],
  );

  if (!bands.length || !columns) return null;

  const capped = (band: StructureBand): boolean => band.kind === 'callback' || band.kind === 'bookend';

  return (
    <div className="px-2 pb-2 pt-1">
      <div className="flex flex-col gap-1">
        {bands.map((band) => {
          const on = band.deviceId === selectedDeviceId;
          const left = (band.start / columns) * 100;
          const width = ((band.end - band.start + 1) / columns) * 100;
          const first = band.lines[0] + 1;
          const last = band.lines[band.lines.length - 1] + 1;
          const where = band.sections.length ? ` across ${band.sections.join(', ')}` : '';
          const says = `${kindWords(band.kind)}: ${clip(band.label, MAX_LABEL_CHARS)} — lines ${first} to ${last}, ${band.lines.length} of them${where}`;
          return (
            <div key={band.id} className="flex items-center gap-1.5">
              <span
                className="w-10 shrink-0 text-[8px] font-mono uppercase tracking-widest"
                style={{ color: `rgb(${band.rgb})` }}
                aria-hidden="true"
              >
                {band.code}
              </span>
              <div className="la-track min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => onPick(band.deviceId)}
                  aria-pressed={on}
                  aria-label={`${says}. Show it on the lyric.`}
                  title={`${says}${band.detail ? `\n${band.detail}` : ''}\n${LONG_RANGE_BLURB[band.kind] ?? ''}`}
                >
                  {sectionCuts.map((cut) => (
                    <i key={cut} data-sect="" style={{ left: `${(cut / columns) * 100}%` }} />
                  ))}
                  <i
                    data-band={band.kind}
                    style={
                      {
                        left: `${left}%`,
                        width: `${width}%`,
                        '--band-rgb': band.rgb,
                      } as React.CSSProperties
                    }
                  />
                  {band.positions.map((p, i) => (
                    <i
                      key={p}
                      data-tick={
                        capped(band) && (i === 0 || i === band.positions.length - 1) ? 'cap' : ''
                      }
                      style={
                        {
                          left: `${((p + 0.5) / columns) * 100}%`,
                          '--band-rgb': band.rgb,
                        } as React.CSSProperties
                      }
                    />
                  ))}
                </button>
              </div>
              <span
                className="w-14 shrink-0 text-right text-[9px] font-mono tabular-nums text-zinc-500"
                aria-hidden="true"
              >
                L{first}–L{last}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-1.5 text-[8px] font-mono text-zinc-600">
        {kindsHere.map((kind) => (
          <span key={kind}>
            <span className="text-zinc-400">{LONG_RANGE_CODE[kind] ?? kind}</span>{' '}
            {LONG_RANGE_BLURB[kind] ?? kindWords(kind)}
          </span>
        ))}
      </div>
      {map.overflow > 0 && (
        <div className="pt-1 text-[9px] font-mono text-zinc-600">
          +{map.overflow} shorter {map.overflow === 1 ? 'shape' : 'shapes'} not drawn — the map keeps
          the long ones, and all of them are in the findings list
        </div>
      )}
    </div>
  );
};

// --- marking by hand -------------------------------------------------------

interface Composer {
  /** The mark being edited, or null while a new one is being named. */
  id: string | null;
  kind: string;
  /** Until the writer picks a kind themselves, it follows the shape of what
   *  they picked: words on one line are an internal rhyme, words down a page
   *  are an end rhyme. */
  kindTouched: boolean;
  label: string;
  note: string;
  verdict: MarkVerdict;
}

/**
 * Naming what has just been picked. It lives outside the scrolling body on
 * purpose: a writer picks a word at the top of a verse and another at the
 * bottom, and the bar they name them in must not have scrolled away by then.
 */
const MarkComposer: React.FC<{
  uid: string;
  composer: Composer;
  onChange: (patch: Partial<Composer>) => void;
  spans: Span[];
  onSave: () => void;
  onCancel: () => void;
  onDelete: (() => void) | null;
}> = ({ uid, composer, onChange, spans, onSave, onCancel, onDelete }) => {
  const words = spans.map((s) => s.text).filter(Boolean);
  const lines = new Set(spans.map((s) => s.line)).size;
  const empty = spans.length === 0;
  return (
    <div
      className="shrink-0 border-b border-white/5 bg-black/40 px-2 py-1.5 text-[9px] font-mono"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
        if (e.key === 'Enter' && !empty) {
          e.preventDefault();
          onSave();
        }
      }}
    >
      {/* What is picked gets its own line. Sharing one with the controls put
          it in a flex track that collapsed to "n." at split-pane width. */}
      <div className="flex items-baseline gap-2">
        <span
          className="la-mark-chip shrink-0"
          data-verdict={composer.verdict}
          style={{ '--mark-rgb': MARK_RGB[composer.verdict] } as React.CSSProperties}
          aria-hidden="true"
        />
        <span className="shrink-0 uppercase tracking-widest text-amber-200">
          {composer.id ? 'edit mark' : 'new mark'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-200" title={words.join(' / ')}>
          {empty ? (
            <span className="text-zinc-500">
              pick the words on the lyric — click one, then the next; shift takes everything between.
              From the keyboard: arrows move, space picks, enter names them.
            </span>
          ) : (
            `${clip(words.join(' / '), 60)} · ${spans.length} ${spans.length === 1 ? 'word' : 'words'} on ${lines} ${lines === 1 ? 'line' : 'lines'}`
          )}
        </span>
      </div>

      {/* Each label stays glued to its own control: they wrap as pairs, never
          leaving a label stranded at the end of a row. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1">
        <span className="flex shrink-0 items-center gap-1">
          <label htmlFor={`la-mark-kind-${uid}`} className="text-zinc-500">
            IT IS A
          </label>
          <select
            id={`la-mark-kind-${uid}`}
            name={`la-mark-kind-${uid}`}
            className="form-select min-w-28 px-1 py-0.5 text-[9px]"
            value={composer.kind}
            onChange={(e) => onChange({ kind: e.target.value })}
          >
            {MARK_KINDS.map(([value, label]) => (
              <option key={value || 'note'} value={value}>
                {label}
              </option>
            ))}
          </select>
        </span>

        <span className="flex min-w-40 grow items-center gap-1">
          <label htmlFor={`la-mark-label-${uid}`} className="shrink-0 text-zinc-500">
            CALL IT
          </label>
          <input
            id={`la-mark-label-${uid}`}
            name={`la-mark-label-${uid}`}
            type="text"
            className="form-select min-w-0 grow px-1 py-0.5 text-[9px]"
            value={composer.label}
            placeholder={empty ? 'named after the words by default' : autoMarkLabel(composer.kind, spans)}
            onChange={(e) => onChange({ label: e.target.value })}
            spellCheck={false}
          />
        </span>

        <span className="flex shrink-0 items-center gap-1">
          <input
            id={`la-mark-ground-${uid}`}
            name={`la-mark-ground-${uid}`}
            type="checkbox"
            className="accent-emerald-400"
            checked={composer.verdict === 'confirm'}
            onChange={(e) => onChange({ verdict: e.target.checked ? 'confirm' : 'mark' })}
          />
          <label
            htmlFor={`la-mark-ground-${uid}`}
            className="cursor-pointer select-none text-zinc-300"
            title="The engine missed this and it IS real. Kept as ground truth beside the analysis rather than as one of your notes."
          >
            THE ENGINE MISSED THIS
          </label>
        </span>

        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="btn-ghost border border-amber-400/40 px-1.5 py-0.5 text-amber-100 disabled:opacity-40"
            onClick={onSave}
            disabled={empty}
            title="Save these words as one mark (Enter)"
          >
            {composer.id ? 'SAVE' : 'MARK IT'}
          </button>
          <button
            type="button"
            className="btn-ghost px-1.5 py-0.5 text-zinc-400"
            onClick={onCancel}
            title="Drop the picked words (Escape)"
          >
            {composer.id ? 'CANCEL' : 'CLEAR'}
          </button>
          {onDelete && (
            <button
              type="button"
              className="btn-ghost px-1 py-0.5 text-rose-300"
              onClick={onDelete}
              aria-label="Delete this mark"
              title="Delete this mark"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </span>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <label htmlFor={`la-mark-note-${uid}`} className="shrink-0 text-zinc-500">
          NOTE
        </label>
        <input
          id={`la-mark-note-${uid}`}
          name={`la-mark-note-${uid}`}
          type="text"
          className="form-select min-w-0 flex-1 px-1 py-0.5 text-[9px]"
          value={composer.note}
          placeholder="why it matters, how it should land — anything the analysis cannot hear"
          onChange={(e) => onChange({ note: e.target.value })}
        />
      </div>
    </div>
  );
};

/** The writer's marks, listed: what they are, where they are, and the two
 *  buttons that matter — open it up again, or throw it away. */
const MarksList: React.FC<{
  marks: LyricMark[];
  editingId: string | null;
  /** Marks the lyric moved out from under: listed, never painted. */
  stale: ReadonlySet<string>;
  onEdit: (mark: LyricMark) => void;
  onDelete: (id: string) => void;
  onJump: (line: number) => void;
}> = ({ marks, editingId, stale, onEdit, onDelete, onJump }) => {
  if (!marks.length) {
    return (
      <div className="px-2 py-2 text-[9px] font-mono text-zinc-600">
        Nothing marked yet. Switch MARK on, click the words that rhyme — two, three, as many as you
        hear — and name them.
      </div>
    );
  }
  return (
    <div className="flex flex-col px-2 pb-2 pt-1">
      {marks.map((mark) => {
        const on = mark.id === editingId;
        const line = mark.spans[0]?.line ?? 0;
        const moved = stale.has(mark.id);
        return (
          <div
            key={mark.id}
            className={`flex items-baseline gap-2 rounded px-1 py-0.5 ${on ? 'bg-white/10' : ''}`}
          >
            <span
              className="la-mark-chip shrink-0"
              data-verdict={mark.verdict}
              style={{ '--mark-rgb': MARK_RGB[mark.verdict] } as React.CSSProperties}
              aria-hidden="true"
            />
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-[10px] text-zinc-200 hover:text-white"
              onClick={() => onJump(line)}
              title={`${MARK_WORDS[mark.verdict]}${mark.note ? ` — ${mark.note}` : ''} — jump to line ${line + 1}`}
            >
              <span className="text-zinc-500">{MARK_GLYPH[mark.verdict]} </span>
              {clip(mark.label || autoMarkLabel(mark.kind, mark.spans), MAX_LABEL_CHARS)}
              {mark.note && <span className="pl-2 text-[9px] font-mono text-zinc-500">{clip(mark.note, 60)}</span>}
            </button>
            {moved && (
              <span
                className="shrink-0 rounded border border-amber-400/40 px-1 text-[8px] font-mono uppercase tracking-widest text-amber-300"
                title="The words this was placed on have been rewritten, so it is no longer drawn on the lyric. Open it and pick the words again."
              >
                moved
              </span>
            )}
            <span className="shrink-0 text-[9px] font-mono text-zinc-600">{markLines(mark)}</span>
            {/* A rejection has nothing to edit: it is a yes/no about a finding
                the engine made, and the only move left is to take it back. */}
            {mark.verdict !== 'reject' && (
              <button
                type="button"
                className="btn-ghost shrink-0 px-1 py-0.5 text-zinc-400"
                onClick={() => onEdit(mark)}
                aria-label={`Edit the mark ${mark.label || mark.kind || 'note'}`}
                title="Edit this mark — its words, its name, its note"
              >
                <Pencil className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              className="btn-ghost shrink-0 px-1 py-0.5 text-rose-300"
              onClick={() => onDelete(mark.id)}
              aria-label={`Delete the mark ${mark.label || mark.kind || 'note'}`}
              title={mark.verdict === 'reject' ? 'Undo this rejection — the finding comes back' : 'Delete this mark'}
            >
              {mark.verdict === 'reject' ? <RotateCcw className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
            </button>
          </div>
        );
      })}
    </div>
  );
};

/** Yes / no on one finding, from the finding itself. Two clicks are the whole
 *  interaction: the engine got it wrong, or the engine got it right. */
const Verdicts: React.FC<{
  device: Device;
  verdict: MarkVerdict | null;
  /** How many findings share this one's group, and so go with it. A reject
   *  names a `Device.group` — the only handle that survives a re-run — and a
   *  group can hold a whole rhyme class: on a monorhyme verse one cross on a
   *  slant rhyme also takes both of the rhyme runs with it. The writer is told
   *  before they click, not after the long-shape map empties. */
  siblings: number;
  onConfirm: () => void;
  onReject: () => void;
  onUndo: () => void;
}> = ({ device, verdict, siblings, onConfirm, onReject, onUndo }) => {
  const name = clip(device.label, 40);
  const also =
    siblings > 1
      ? ` — and the ${siblings - 1} other ${siblings === 2 ? 'finding' : 'findings'} on this rhyme class`
      : '';
  if (verdict) {
    return (
      <button
        type="button"
        className="btn-ghost shrink-0 px-1 py-0.5"
        style={{ color: `rgb(${MARK_RGB[verdict]})` }}
        onClick={onUndo}
        aria-label={`${MARK_WORDS[verdict]} — undo that for ${name}`}
        title={`${MARK_WORDS[verdict]} — click to undo`}
      >
        {MARK_GLYPH[verdict]}
      </button>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn-ghost shrink-0 px-1 py-0.5 text-zinc-500 hover:text-emerald-300"
        onClick={onConfirm}
        aria-label={`Confirm ${name}: it is real`}
        title="It is real — keep it as ground truth"
      >
        <Check className="h-3 w-3" />
      </button>
      <button
        type="button"
        className="btn-ghost shrink-0 px-1 py-0.5 text-zinc-500 hover:text-rose-300"
        onClick={onReject}
        aria-label={`Reject ${name}: that is not one${also}`}
        title={`That is not one — hide it everywhere${also}`}
      >
        <X className="h-3 w-3" />
      </button>
    </>
  );
};

// --- the inspector ---------------------------------------------------------

/** One finding, opened up: what it covers, what it sounds like, and why the
 *  detector fired at all. */
const Inspector: React.FC<{
  device: Device;
  onClose: () => void;
  onJump: (line: number) => void;
  /** What the writer has already said about this finding, if anything. */
  verdict: MarkVerdict | null;
  /** Findings sharing this one's group — see `Verdicts`. */
  siblings: number;
  /** False where a verdict has nowhere to be saved: the tick and the cross are
   *  marks like any other, so in SING they would be buttons that do nothing. */
  canJudge: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onUndoVerdict: () => void;
}> = ({
  device,
  onClose,
  onJump,
  verdict,
  siblings,
  canJudge,
  onConfirm,
  onReject,
  onUndoVerdict,
}) => {
  const family = asFamily(device.family);
  const tier = sureTier(device.confidence);
  return (
    <div className="shrink-0 border-t border-white/10 bg-black/40 px-2 py-1.5 text-[9px] font-mono">
      <div className="flex items-baseline gap-2">
        <span className="la-legend shrink-0" aria-hidden="true">
          <span
            data-device={family ?? 'rhyme'}
            data-sure={tier}
            style={{ '--dev-a': alphaFor(device.confidence) } as React.CSSProperties}
          />
        </span>
        <span className="shrink-0 uppercase tracking-widest text-zinc-300">{kindWords(device.kind)}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-200" title={device.label}>
          {clip(device.label, MAX_LABEL_CHARS)}
        </span>
        {device.source === 'llm' && (
          <span className="shrink-0 rounded border border-fuchsia-500/30 px-1 text-[8px] text-fuchsia-300">llm</span>
        )}
        <span
          className="flex shrink-0 items-center gap-1"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={device.confidence}
          aria-valuetext={`${pct(device.confidence)} ${SURE_WORDS[tier]}`}
          aria-label="Detector confidence"
        >
          <span className="h-1 w-10 overflow-hidden rounded-xs bg-white/10">
            <i
              className="block h-full bg-rose-400"
              style={{ width: pct(device.confidence), opacity: alphaFor(device.confidence) }}
            />
          </span>
          <span className="w-14 tabular-nums text-zinc-400">
            {pct(device.confidence)} {SURE_WORDS[tier]}
          </span>
        </span>
        {canJudge && (
          <Verdicts
            device={device}
            verdict={verdict}
            siblings={siblings}
            onConfirm={onConfirm}
            onReject={onReject}
            onUndo={onUndoVerdict}
          />
        )}
        <button
          type="button"
          className="btn-ghost shrink-0 px-1 py-0.5"
          onClick={onClose}
          aria-label="Close the finding"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      {device.detail && (
        <div className="pt-0.5 text-zinc-400">
          <span className="text-zinc-600">why: </span>
          {device.detail}
        </div>
      )}
      {device.phones.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pt-1">
          <span className="text-zinc-600">phones</span>
          {device.phones.map((p, i) => (
            <span key={`${p}-${i}`} className="rounded border border-white/10 bg-white/5 px-1 text-zinc-300">
              {p}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1 pt-1">
        <span className="text-zinc-600">covers</span>
        {device.spans.slice(0, MAX_INSPECT_SPANS).map((s, i) => (
          <button
            key={`${s.line}-${s.word}-${s.char_start}-${i}`}
            type="button"
            className="rounded border border-rose-500/25 bg-rose-500/10 px-1 text-rose-100 hover:bg-rose-500/20"
            onClick={() => onJump(s.line)}
            title={`Line ${s.line + 1}, word ${s.word + 1}${s.char_end !== null ? `, characters ${s.char_start}-${s.char_end}` : ''} — jump to it`}
          >
            L{s.line + 1} {s.text || `w${s.word + 1}`}
          </button>
        ))}
        {device.spans.length > MAX_INSPECT_SPANS && (
          <span className="text-zinc-600">+{device.spans.length - MAX_INSPECT_SPANS} more</span>
        )}
      </div>
    </div>
  );
};

// --- the pane --------------------------------------------------------------

export interface LyricAnalysisPaneProps {
  entryId?: string | null;
  title?: string;
  /** The words the sheet draws, when the host has its own. Must be the words
   *  the analysis was computed from — every finding is anchored by word index.
   *  `LyricsDoc` fits, and so does `{ lines: splitText(text) }` (singSync) for
   *  a lyric that has never been saved. Defaults to the SING tab's document. */
  lyrics?: SheetSource | null;
  /** Raw lyric text, split into lines and words exactly the way the backend
   *  splits it (`singSync.splitText` is the twin of `schema.split_text`). The
   *  convenient form of `lyrics` for a writing surface that only has the text
   *  of a draft — pass one or the other, not both. */
  text?: string;
  /** An analysis to show instead of the store's — the standalone writing
   *  surface analyses unsaved text through /analyze and owns the result.
   *  Passing it (even as null) also stops the pane loading or running
   *  anything by itself, so the karaoke's own analysis is left alone. */
  analysis?: LyricAnalysisDoc | null;
  /** With `analysis`, what ANALYSE does and whether it is already running. */
  onAnalyze?: () => void;
  analyzing?: boolean;
  /** Off when the host draws its own title bar and run button. */
  showHeader?: boolean;
}

/**
 * The lyric analysis: a sheet of the lyric you can read with every device
 * drawn on it, the shape of the whole song above it, the findings under it,
 * and one finding opened up at the bottom.
 *
 * The family filters and the confidence floor drive this pane AND the karaoke
 * overlay, so what you read here is what the words are wearing on stage.
 */
export const LyricAnalysisPane: React.FC<LyricAnalysisPaneProps> = ({
  entryId: entryIdProp,
  title: titleProp,
  lyrics: lyricsProp,
  text,
  analysis,
  onAnalyze,
  analyzing,
  showHeader = true,
}) => {
  // A host that passes its own analysis owns the whole lifecycle: this pane
  // must not load, run, or clear the store's document underneath it.
  const hosted = analysis !== undefined;
  const uid = useId();

  const entry = useLibraryStore((s) =>
    s.selectedEntryId ? s.entries.find((e) => e.id === s.selectedEntryId) ?? null : null,
  );
  const entryId = entryIdProp ?? entry?.id ?? null;
  const title = titleProp ?? (entry && entry.id === entryId ? entry.title : entryId ?? '');

  // The words themselves live in the lyrics document the analysis was anchored
  // to; only take them when that document is for the same entry.
  const singLyrics = useLyricsStore((s) => (s.entryId === entryId ? s.doc : null));
  const fromText = useMemo(() => (text === undefined ? null : { lines: splitText(text) }), [text]);
  const lyrics: SheetSource | null = lyricsProp ?? fromText ?? singLyrics;

  const storeDoc = useLyricAnalysisStore((s) => s.doc);
  const doc = hosted ? analysis : storeDoc;
  const loading = useLyricAnalysisStore((s) => s.loading);
  const stale = useLyricAnalysisStore((s) => s.stale);
  const persisted = useLyricAnalysisStore((s) => s.persisted);
  const error = useLyricAnalysisStore((s) => s.error);
  const job = useLyricAnalysisStore((s) => s.job);
  const families = useLyricAnalysisStore((s) => s.families);
  const minConfidence = useLyricAnalysisStore((s) => s.minConfidence);
  const overlay = useLyricAnalysisStore((s) => s.overlay);
  const links = useLyricAnalysisStore((s) => s.links);
  const stress = useLyricAnalysisStore((s) => s.stress);
  const selectedGroup = useLyricAnalysisStore((s) => s.selectedGroup);
  const selectedDeviceId = useLyricAnalysisStore((s) => s.selectedDeviceId);
  const llm = useLyricAnalysisStore((s) => s.llm);
  const llmAvailable = useLyricAnalysisStore((s) => s.llmAvailable);
  const providers = useLyricAnalysisStore((s) => s.providers);
  const provider = useLyricAnalysisStore((s) => s.provider);
  const model = useLyricAnalysisStore((s) => s.model);
  const markMode = useLyricAnalysisStore((s) => s.markMode);
  const storedMarks = useLyricAnalysisStore((s) => s.marks);
  const storedStale = useLyricAnalysisStore((s) => s.marksStale);
  const marksDocId = useLyricAnalysisStore((s) => s.marksDocId);
  const marksSaving = useLyricAnalysisStore((s) => s.marksSaving);
  const marksError = useLyricAnalysisStore((s) => s.marksError);
  const marksDropped = useLyricAnalysisStore((s) => s.marksDropped);
  const marksSupported = useLyricAnalysisStore((s) => s.marksSupported);

  /** The rhyme class the sheet is isolating, as a `SheetRow.classKey`; the
   *  letter badges and the class chips toggle it. */
  const [activeClass, setActiveClass] = useState('');
  /** The line the shape strip last jumped to, so it can mark where you are. */
  const [activeLine, setActiveLine] = useState(-1);
  /** The words picked for the mark being composed, keyed `line:word`. */
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** Where the last pick landed, so a shift-click knows what "back to there"
   *  means. */
  const anchorRef = useRef<{ line: number; word: number } | null>(null);
  const [composer, setComposer] = useState<Composer>({
    id: null,
    kind: 'end-rhyme',
    kindTouched: false,
    label: '',
    note: '',
    verdict: 'mark',
  });

  const store = useLyricAnalysisStore.getState;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void useLyricAnalysisStore.getState().probe();
  }, []);

  useEffect(() => {
    if (hosted) return;
    setActiveClass('');
    if (entryId) void useLyricAnalysisStore.getState().load(entryId);
    else useLyricAnalysisStore.getState().clear();
  }, [entryId, hosted]);

  // The marks are the WRITER's, not the analysis's, so they are loaded in
  // hosted mode too — the notebook page has them as much as the song does.
  useEffect(() => {
    setSelection(new Set<string>());
    anchorRef.current = null;
    setComposer((c) => ({ ...c, id: null, label: '', note: '', verdict: 'mark' }));
    if (entryId) void useLyricAnalysisStore.getState().loadMarks(entryId);
  }, [entryId]);

  // Leaving the pane is a save point: the debounce may still be counting down
  // on a mark the writer just made.
  useEffect(
    () => () => {
      void useLyricAnalysisStore.getState().flushMarks();
    },
    [],
  );

  /** The marks only ever belong to the document on screen: a set still in the
   *  store from the last song must never be painted onto this one. */
  const marks = useMemo(
    () => (entryId && marksDocId === entryId ? storedMarks : []),
    [entryId, marksDocId, storedMarks],
  );

  /** The ids the lyric has moved out from under: still listed, never drawn. */
  const staleMarks = useMemo(
    () => new Set(entryId && marksDocId === entryId ? storedStale : []) as ReadonlySet<string>,
    [entryId, marksDocId, storedStale],
  );

  /** The writer's veto, applied everywhere the findings are read from. */
  const rejected = useMemo(() => rejectedGroups(marks), [marks]);

  /** group -> what the writer said about it, for the tick/cross on a finding. */
  const verdictOf = useMemo(() => {
    const out = new Map<string, MarkVerdict>();
    for (const m of marks) {
      if (m.target_group && m.verdict !== 'mark') out.set(m.target_group, m.verdict);
    }
    return out;
  }, [marks]);

  const markIndex = useMemo(() => buildMarkIndex(marks, staleMarks), [marks, staleMarks]);

  const shown = useMemo(
    () => visibleDevices(doc, families, minConfidence, rejected),
    [doc, families, minConfidence, rejected],
  );

  const sheet = useMemo(
    () => buildSheetModel(doc, lyrics, families, minConfidence, rejected),
    [doc, lyrics, families, minConfidence, rejected],
  );

  const structure = useMemo(() => buildStructureMap(shown, sheet.rows), [shown, sheet.rows]);

  /** Every finding the engine actually made, with the writer's own marks taken
   *  back out — a document's run answers with them merged in. This is the
   *  denominator "N of M findings" means. */
  const detected = useMemo(() => detectedDevices(doc), [doc]);

  /** group -> how many findings are in it, so a cross can say what it takes. */
  const groupSize = useMemo(() => {
    const out = new Map<string, number>();
    for (const d of detected) {
      const g = d.group || d.id;
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  }, [detected]);

  /** What the veto actually removed HERE. A reject names a whole group, so one
   *  cross can take four findings; and when the document arrived already merged
   *  the struck ones are gone from `doc.devices` altogether, and the number of
   *  vetoes is the only count left to show. */
  const struck = useMemo(() => {
    if (!rejected.size) return 0;
    const here = detected.filter((d) => rejected.has(d.group || d.id)).length;
    return here || rejected.size;
  }, [detected, rejected]);

  const devicesById = useMemo(() => {
    const map = new Map<string, Device>();
    for (const d of doc?.devices ?? []) map.set(d.id, d);
    return map;
  }, [doc]);

  const selectedDevice = selectedDeviceId ? devicesById.get(selectedDeviceId) ?? null : null;

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

  /** The classes actually used, with how many lines each holds: the legend.
   *  Keyed by the SOUND, so the chorus's "A" is its own chip rather than being
   *  counted into verse 1's. */
  const classes = useMemo(() => {
    const out = new Map<string, { letter: string; index: number; endKey: string; count: number; sections: Set<string> }>();
    for (const row of sheet.rows) {
      if (!row.classKey) continue;
      const seen = out.get(row.classKey);
      if (seen) {
        seen.count += 1;
        if (row.section) seen.sections.add(row.section);
      } else {
        out.set(row.classKey, {
          letter: row.letter,
          index: row.classIndex,
          endKey: row.endKey,
          count: 1,
          sections: new Set(row.section ? [row.section] : []),
        });
      }
    }
    return Array.from(out.entries()).sort((a, b) => a[1].index - b[1].index);
  }, [sheet.rows]);

  const jumpToLine = useCallback((line: number) => {
    setActiveLine(line);
    const target = sheetRef.current?.querySelector<HTMLElement>(`[data-row="${line}"]`);
    target?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  const pickDevice = useCallback(
    (deviceId: string) => {
      const device = devicesById.get(deviceId) ?? null;
      if (!device) return;
      const already = useLyricAnalysisStore.getState().selectedDeviceId === deviceId;
      useLyricAnalysisStore.getState().setSelectedDevice(already ? null : device);
      if (!already && device.spans.length) setActiveLine(device.spans[0].line);
    },
    [devicesById],
  );

  /** The long-range finding being read, put back onto the lyric as a spine. */
  const structSpan = useMemo(() => {
    if (!selectedDevice || !LONG_RANGE_KINDS.includes(selectedDevice.kind)) return null;
    const lines = selectedDevice.spans.map((s) => s.line).filter((l) => l >= 0);
    if (!lines.length) return null;
    return {
      rgb: groupInk(selectedDevice.group || selectedDevice.id).rgb,
      from: Math.min(...lines),
      to: Math.max(...lines),
      lines: new Set(lines) as ReadonlySet<number>,
    };
  }, [selectedDevice]);

  // --- marking ------------------------------------------------------------

  const selectedSpans = useMemo(
    () => spansFromSelection(sheet.rows, selection),
    [sheet.rows, selection],
  );

  const onWordPick = useCallback(
    (line: number, word: number, mode: 'toggle' | 'range' | 'drag') => {
      const key = wordMarkKey(line, word);
      setSelection((prev) => {
        const next = new Set(prev);
        if (mode === 'range' && anchorRef.current) {
          for (const k of rangeKeys(sheet.rows, anchorRef.current, { line, word })) next.add(k);
        } else if (mode === 'drag') {
          next.add(key);
        } else if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return next;
      });
      // A shift-click reaches BACK to the anchor, so the anchor stays put; a
      // plain pick is the new one.
      if (mode === 'toggle') anchorRef.current = { line, word };
    },
    [sheet.rows],
  );

  // While the writer has not chosen a kind, it follows what they picked.
  useEffect(() => {
    if (composer.id || composer.kindTouched || !selectedSpans.length) return;
    const oneLine = new Set(selectedSpans.map((s) => s.line)).size === 1;
    const kind = oneLine ? 'internal-rhyme' : 'end-rhyme';
    setComposer((c) => (c.kind === kind ? c : { ...c, kind }));
  }, [selectedSpans, composer.id, composer.kindTouched]);

  const cancelMark = useCallback(() => {
    setSelection(new Set<string>());
    anchorRef.current = null;
    setComposer((c) => ({ ...c, id: null, label: '', note: '', verdict: 'mark' }));
  }, []);

  const saveMark = useCallback(() => {
    if (!selectedSpans.length) return;
    const st = useLyricAnalysisStore.getState();
    const label = composer.label.trim() || autoMarkLabel(composer.kind, selectedSpans);
    const body = {
      kind: composer.kind,
      label,
      note: composer.note.trim(),
      verdict: composer.verdict,
      spans: selectedSpans,
    };
    if (composer.id) st.updateMark(composer.id, body);
    else st.addMark(body);
    cancelMark();
  }, [composer, selectedSpans, cancelMark]);

  const editMark = useCallback(
    (mark: LyricMark) => {
      useLyricAnalysisStore.getState().setMarkMode(true);
      const picked = mark.spans.filter((s) => s.line >= 0 && s.word >= 0);
      setSelection(new Set(picked.map((s) => wordMarkKey(s.line, s.word))));
      anchorRef.current = picked.length ? { line: picked[0].line, word: picked[0].word } : null;
      setComposer({
        id: mark.id,
        kind: mark.kind,
        kindTouched: true,
        label: mark.label,
        note: mark.note,
        verdict: mark.verdict === 'reject' ? 'mark' : mark.verdict,
      });
      if (picked.length) jumpToLine(picked[0].line);
    },
    [jumpToLine],
  );

  const deleteMark = useCallback(
    (id: string) => {
      useLyricAnalysisStore.getState().removeMark(id);
      if (composer.id === id) cancelMark();
    },
    [composer.id, cancelMark],
  );

  const openMark = useCallback(
    (id: string) => {
      const mark = marks.find((m) => m.id === id);
      if (mark) editMark(mark);
    },
    [marks, editMark],
  );

  const setMarkMode = useCallback(
    (on: boolean) => {
      useLyricAnalysisStore.getState().setMarkMode(on);
      // Leaving marking mode with words still picked would hide the bar they
      // are named in and leave them lit on the sheet with no way to use them.
      if (!on) cancelMark();
    },
    [cancelMark],
  );

  const busy = !!job || !!analyzing;
  const runAnalysis = useCallback(() => {
    if (onAnalyze) onAnalyze();
    else void useLyricAnalysisStore.getState().run({ force: true });
  }, [onAnalyze]);

  if (!entryId && !hosted) {
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

  const hasWords = !!lyrics?.lines?.length;

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#07050a] text-zinc-200">
      {showHeader && (
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
          {!hosted && stale && persisted && (
            <span
              className="shrink-0 flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-amber-200"
              title="The lyrics changed after this analysis ran, so the findings no longer line up with the words. Re-analyse."
            >
              <AlertTriangle className="w-3 h-3" /> STALE
            </span>
          )}
          <span className="flex-1" />
          <input
            id={`la-llm-${uid}`}
            name={`la-llm-${uid}`}
            type="checkbox"
            className="accent-rose-400"
            checked={llm}
            onChange={(e) => store().setLlm(e.target.checked)}
            disabled={!llmAvailable}
          />
          <label
            htmlFor={`la-llm-${uid}`}
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
            onClick={runAnalysis}
            disabled={busy || loading}
            title="Read the lyric: rhyme scheme, sound, repetition and structure, computed from the words"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : doc ? <RefreshCw className="w-3 h-3" /> : <Sparkles className="w-3 h-3" />}
            {doc ? 'RE-ANALYSE' : 'ANALYSE'}
          </button>
        </div>
      )}

      {/* The interpretive pass is opt-in, so its settings only appear once it is. */}
      {showHeader && llm && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-white/5 bg-black/20 px-2 py-1 text-[9px] font-mono">
          <label htmlFor={`la-provider-${uid}`} className="text-zinc-500">PROVIDER</label>
          <select
            id={`la-provider-${uid}`}
            name={`la-provider-${uid}`}
            className="form-select text-[8px] px-1 py-0.5 min-w-24"
            value={provider}
            onChange={(e) => store().setProvider(e.target.value)}
          >
            <option value="">default</option>
            {providers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <label htmlFor={`la-model-${uid}`} className="text-zinc-500">MODEL</label>
          <input
            id={`la-model-${uid}`}
            name={`la-model-${uid}`}
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

      {/* THE LEGEND, which is also the filter: the encoding is always on screen
          beside what it controls, and it drives the karaoke overlay too. */}
      {doc && (
        <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/5 bg-black/20 px-2 py-1.5 text-[9px] font-mono">
          {DEVICE_FAMILIES.map((f) => (
            <span key={f} className="flex items-center gap-1">
              <input
                id={`la-family-${f}-${uid}`}
                name={`la-family-${f}-${uid}`}
                type="checkbox"
                className="accent-rose-400"
                checked={families[f]}
                onChange={(e) => store().setFamily(f, e.target.checked)}
              />
              <label
                htmlFor={`la-family-${f}-${uid}`}
                className="cursor-pointer select-none text-zinc-300"
                title={`${FAMILY_LABELS[f]}: ${FAMILY_SHAPES[f]}`}
              >
                {FAMILY_LABELS[f]}
              </label>
              {/* The same shape the sheet and the karaoke paint, so the filter
                  row really is the legend for both. */}
              <span className="la-legend" aria-hidden="true">
                <span data-device={f} />
              </span>
              <span className="tabular-nums text-zinc-600">{familyCounts[f]}</span>
            </span>
          ))}

          <span className="flex items-center gap-1">
            <label htmlFor={`la-confidence-${uid}`} className="text-zinc-500 select-none">FLOOR</label>
            <input
              id={`la-confidence-${uid}`}
              name={`la-confidence-${uid}`}
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={minConfidence}
              onChange={(e) => store().setMinConfidence(Number(e.target.value))}
              className="w-20 accent-rose-400"
              title="Hide findings the detector is less sure of than this"
            />
            <span className="w-8 tabular-nums text-zinc-400">{pct(minConfidence)}</span>
          </span>

          {/* What confidence LOOKS like, so a faint mark is read as a guess
              rather than as a different device. */}
          <span className="flex items-center gap-1 text-zinc-600" title="A finding is drawn at the weight the detector is sure of">
            <span className="la-legend" aria-hidden="true">
              <span
                data-device="rhyme"
                data-sure={sureTier(1)}
                style={{ '--dev-a': alphaFor(1) } as React.CSSProperties}
              />
            </span>
            certain
            <span className="la-legend" aria-hidden="true">
              <span
                data-device="rhyme"
                data-sure={sureTier(0.6)}
                style={{ '--dev-a': alphaFor(0.6) } as React.CSSProperties}
              />
            </span>
            loose
          </span>

          <span className="flex items-center gap-1">
            <input
              id={`la-links-${uid}`}
              name={`la-links-${uid}`}
              type="checkbox"
              className="accent-rose-400"
              checked={links}
              onChange={(e) => store().setLinks(e.target.checked)}
            />
            <label
              htmlFor={`la-links-${uid}`}
              className="cursor-pointer select-none text-zinc-300"
              title="Draw internal, leonine and cross-line rhymes as arcs over the sheet"
            >
              LINKS
            </label>
          </span>

          <span className="flex items-center gap-1">
            <input
              id={`la-stress-${uid}`}
              name={`la-stress-${uid}`}
              type="checkbox"
              className="accent-rose-400"
              checked={stress}
              onChange={(e) => store().setStress(e.target.checked)}
            />
            <label
              htmlFor={`la-stress-${uid}`}
              className="cursor-pointer select-none text-zinc-300"
              title="One dot per syllable beside each line, filled where the stress falls (hidden when the pane is narrow)"
            >
              STRESS
            </label>
          </span>

          <span className="flex items-center gap-1">
            <input
              id={`la-overlay-${uid}`}
              name={`la-overlay-${uid}`}
              type="checkbox"
              className="accent-rose-400"
              checked={overlay}
              onChange={(e) => store().setOverlay(e.target.checked)}
            />
            <label
              htmlFor={`la-overlay-${uid}`}
              className="cursor-pointer select-none text-zinc-300"
              title="Underline the devices on the karaoke words while the song plays"
            >
              KARAOKE OVERLAY
            </label>
          </span>

          {/* Marking is offered only where a mark has somewhere to live. The
              routes store them against a lyric DOCUMENT, so a song opened from
              the library has no home for one, and a checkbox here would hand
              the writer a flow whose every save is a 404. */}
          {marksSupported ? (
            <span className="flex items-center gap-1">
              <input
                id={`la-mark-${uid}`}
                name={`la-mark-${uid}`}
                type="checkbox"
                className="accent-amber-400"
                checked={markMode}
                onChange={(e) => setMarkMode(e.target.checked)}
              />
              <label
                htmlFor={`la-mark-${uid}`}
                className="cursor-pointer select-none text-amber-200"
                title="Mark the lyric yourself: click the words that rhyme — two, three, as many as you hear — and name them as one. Your marks are drawn as boxes, never as another underline."
              >
                MARK
              </label>
              <span className="la-mark-chip" aria-hidden="true" />
              <span className="tabular-nums text-zinc-600">{marks.length}</span>
            </span>
          ) : (
            <span
              className="text-zinc-600"
              title="Marks are saved on a lyric in the LYRIC notebook, which is where a draft can be written and re-read. A song opened from the library has nowhere to keep them."
            >
              MARK IN THE LYRIC TAB
            </span>
          )}

          <span
            className="text-zinc-600"
            title={
              struck > 0
                ? 'A rejection strikes out the whole rhyme class the finding belongs to, so one cross can take several findings with it.'
                : undefined
            }
          >
            {shown.length} of {detected.length} findings shown
            {struck > 0 && ` · ${struck} struck out by you`}
          </span>
        </div>
      )}

      {/* The bar the picked words are named in. Outside the scrolling body, so
          picking a word at the top of a verse and one at the bottom still ends
          in the same place. */}
      {doc && markMode && marksSupported && (
        <MarkComposer
          uid={uid}
          composer={composer}
          onChange={(patch) =>
            setComposer((c) => ({
              ...c,
              ...patch,
              ...(patch.kind !== undefined ? { kindTouched: true } : {}),
            }))
          }
          spans={selectedSpans}
          onSave={saveMark}
          onCancel={cancelMark}
          onDelete={composer.id ? () => deleteMark(composer.id as string) : null}
        />
      )}

      {marksError && (
        <div className="shrink-0 flex items-center gap-2 border-b border-white/5 bg-black/20 px-2 py-1 text-[9px] font-mono">
          <span className="text-amber-300">your marks: {marksError}</span>
          <button
            type="button"
            className="btn-ghost px-1 py-0.5"
            onClick={() => store().clearMarksError()}
            aria-label="Dismiss the marks error"
          >
            ×
          </button>
        </div>
      )}

      {/* A mark whose anchors name no word in the lyric is not stored. Saying
          so is the difference between a shorter list and a lost annotation. */}
      {marksDropped > 0 && (
        <div className="shrink-0 flex items-center gap-2 border-b border-white/5 bg-black/20 px-2 py-1 text-[9px] font-mono">
          <span className="text-amber-300">
            {marksDropped} {marksDropped === 1 ? 'mark was' : 'marks were'} not saved — the words
            they were on are no longer in the lyric
          </span>
          <button
            type="button"
            className="btn-ghost px-1 py-0.5"
            onClick={() => store().clearMarksDropped()}
            aria-label="Dismiss the unsaved marks notice"
          >
            ×
          </button>
        </div>
      )}

      {/* Body */}
      {loading && !hosted ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : !doc ? (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-[10px] font-mono text-zinc-400">
          <div className="text-zinc-500">
            {/* A null lyrics doc means SING has not loaded one yet, which is not
                the same as the song having no words: only the second one blocks. */}
            {lyrics && !hasWords
              ? 'No lyrics here yet — paste or transcribe them first.'
              : 'These lyrics have not been read yet.'}
          </div>
          <button
            type="button"
            className="btn-ghost text-[10px] py-2 px-3 border border-rose-500/40 text-rose-200 flex items-center gap-1 disabled:opacity-40"
            onClick={runAnalysis}
            disabled={busy || !!(lyrics && !hasWords)}
          >
            <Sparkles className="w-3.5 h-3.5" /> ANALYSE
          </button>
        </div>
      ) : (
        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto">
          {/* SHAPE */}
          <SectionHead title="Shape" hint="syllables · findings · rhyme class, line by line" />
          <ShapeStrip model={sheet} activeLine={activeLine} onJump={jumpToLine} />

          {/* THE LONG SHAPE: runs, chains, callbacks and bookends, drawn over
              the same line axis as the strip above so the two read as one
              picture of the song rather than as a list of pairs. */}
          {structure.bands.length > 0 && (
            <>
              <SectionHead
                title="The long shape"
                hint="runs, chains, callbacks and bookends across the whole lyric"
              />
              <StructureMap
                map={structure}
                rows={sheet.rows}
                selectedDeviceId={selectedDeviceId}
                onPick={pickDevice}
              />
            </>
          )}

          {/* THE SHEET */}
          <SectionHead title="The lyric" hint={doc.scheme ? clip(doc.scheme, 48) : undefined} />
          {classes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 px-2 pt-1.5 text-[9px] font-mono">
              <span className="text-zinc-600">CLASSES</span>
              {classes.map(([classKey, cls]) => {
                const ink = inkAt(cls.index);
                const on = activeClass === classKey;
                const where = Array.from(cls.sections).join(', ');
                return (
                  <button
                    key={classKey}
                    type="button"
                    className="flex items-center gap-1 rounded border px-1 py-0.5"
                    style={{
                      color: ink ? `rgb(${ink.rgb})` : undefined,
                      borderColor: ink ? `rgb(${ink.rgb} / ${on ? 0.9 : 0.35})` : undefined,
                      borderStyle: ink ? ink.pattern : 'solid',
                      backgroundColor: ink ? `rgb(${ink.rgb} / ${on ? 0.22 : 0.08})` : undefined,
                    }}
                    onClick={() => setActiveClass(on ? '' : classKey)}
                    aria-pressed={on}
                    aria-label={`Rhyme class ${cls.letter}${where ? ` in ${where}` : ''}${
                      cls.endKey ? `, ending on ${cls.endKey}` : ''
                    }: ${cls.count} ${cls.count === 1 ? 'line' : 'lines'}. Isolate it on the sheet.`}
                    title={`Rhyme class ${cls.letter}${where ? ` · ${where}` : ''}${
                      cls.endKey ? ` — ends on /${cls.endKey}/` : ''
                    }: ${cls.count} ${cls.count === 1 ? 'line' : 'lines'} — isolate it on the sheet`}
                  >
                    {/* The class's shape, so two classes never differ by hue alone. */}
                    <span className="relative inline-block h-2 w-2" aria-hidden="true">
                      <span
                        className="la-node"
                        data-shape={ink?.shape ?? 0}
                        style={{ '--lane-rgb': ink?.rgb ?? '161 161 170', left: '50%' } as React.CSSProperties}
                      />
                    </span>
                    {cls.letter}
                    <span className="tabular-nums opacity-60">{cls.count}</span>
                  </button>
                );
              })}
              {activeClass && (
                <button
                  type="button"
                  className="btn-ghost px-1 py-0.5 text-zinc-400"
                  onClick={() => setActiveClass('')}
                >
                  show all
                </button>
              )}
            </div>
          )}
          <LyricSheet
            doc={doc}
            model={sheet}
            activeClass={activeClass}
            onClass={setActiveClass}
            onPickDevice={pickDevice}
            selectedGroup={selectedGroup}
            selectedDeviceId={selectedDeviceId}
            showLinks={links}
            showStress={stress}
            hasWords={hasWords}
            sheetRef={sheetRef}
            markMode={markMode && marksSupported}
            selection={selection}
            onWord={onWordPick}
            onCommitPick={saveMark}
            onCancelPick={cancelMark}
            markIndex={markIndex}
            onOpenMark={openMark}
            structSpan={structSpan}
          />

          {/* FINDINGS */}
          <SectionHead title="Findings" hint="click one to open it up and light it on the words" />
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
                        {kindWords(kind)} <span className="text-zinc-400">{devices.length}</span>
                      </div>
                      <div className="flex flex-col">
                        {devices.slice(0, MAX_ROWS_PER_KIND).map((d) => {
                          const on = selectedDeviceId === d.id;
                          const group = d.group || d.id;
                          const lit = !on && !!selectedGroup && selectedGroup === group;
                          return (
                            // Not one button: the row opens the finding and the
                            // two verdicts answer it, and a button inside a
                            // button is not a thing.
                            <div
                              key={d.id}
                              className={`flex w-full items-start gap-2 rounded px-1 py-0.5 hover:bg-white/5 ${on ? 'bg-white/10' : lit ? 'bg-white/5' : ''}`}
                            >
                              {/* Two lines, both clipped. Laid out in one row the
                                  label of a four-way rhyme broke into a column of
                                  single words as soon as the pane went narrow. */}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 flex-col items-stretch text-left"
                                onClick={() => pickDevice(d.id)}
                                aria-pressed={on}
                                title={[d.label, d.detail, d.phones.length ? `phones: ${d.phones.join(' ')}` : '']
                                  .filter(Boolean)
                                  .join(' — ')}
                              >
                                <span className="flex min-w-0 items-baseline gap-2">
                                  <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-200">
                                    {clip(d.label, MAX_LABEL_CHARS)}
                                  </span>
                                  {d.source === 'llm' && (
                                    <span className="shrink-0 rounded border border-fuchsia-500/30 px-1 text-[8px] font-mono text-fuchsia-300">
                                      llm
                                    </span>
                                  )}
                                </span>
                                {/* The reason and the lines share the second
                                    line, so the name gets the whole first one —
                                    at split-pane width that is the difference
                                    between "street / feet / beat" and "str…". */}
                                <span className="flex min-w-0 items-baseline gap-2 text-[9px] font-mono">
                                  <span className="min-w-0 flex-1 truncate text-zinc-500">
                                    {clip(d.detail, MAX_LABEL_CHARS)}
                                  </span>
                                  <span className="shrink-0 text-zinc-600">{deviceLines(d)}</span>
                                </span>
                              </button>
                              {/* Confidence as a bar as well as a number: a slant
                                  rhyme should read as softer at a glance. */}
                              <span
                                className="mt-1.5 h-1 w-6 shrink-0 overflow-hidden rounded-xs bg-white/10"
                                aria-hidden="true"
                              >
                                <i
                                  className="block h-full bg-rose-400"
                                  style={{ width: pct(d.confidence), opacity: alphaFor(d.confidence) }}
                                />
                              </span>
                              <span className="w-8 shrink-0 text-right text-[9px] font-mono tabular-nums text-zinc-500">
                                {pct(d.confidence)}
                              </span>
                              {marksSupported && (
                                <Verdicts
                                  device={d}
                                  verdict={verdictOf.get(group) ?? null}
                                  siblings={groupSize.get(group) ?? 1}
                                  onConfirm={() => store().confirmDevice(d)}
                                  onReject={() => store().rejectDevice(d)}
                                  onUndo={() => store().clearVerdict(group)}
                                />
                              )}
                            </div>
                          );
                        })}
                        {devices.length > MAX_ROWS_PER_KIND && (
                          <div className="px-1 py-0.5 text-[9px] font-mono text-zinc-600">
                            +{devices.length - MAX_ROWS_PER_KIND} more, not listed — they are still painted on the sheet
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* YOUR MARKS */}
          <SectionHead
            title="Your marks"
            hint={
              !marksSupported
                ? 'kept on a lyric in the LYRIC tab'
                : marksSaving
                  ? 'saving…'
                  : marks.length
                    ? `${marks.length} of yours, kept beside the analysis`
                    : 'what you heard that the engine did not'
            }
          />
          {!marksSupported && (
            <div className="px-2 py-2 text-[9px] font-mono text-zinc-600">
              Marks are saved on a lyric in the LYRIC tab, where a draft is written and re-read.
              Import this song's words there to mark them up.
            </div>
          )}
          {marksSupported && (
          <MarksList
            marks={marks}
            editingId={composer.id}
            stale={staleMarks}
            onEdit={editMark}
            onDelete={deleteMark}
            onJump={jumpToLine}
          />
          )}

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

      {selectedDevice && (
        <Inspector
          device={selectedDevice}
          onClose={() => store().setSelectedDevice(null)}
          onJump={jumpToLine}
          verdict={verdictOf.get(selectedDevice.group || selectedDevice.id) ?? null}
          siblings={groupSize.get(selectedDevice.group || selectedDevice.id) ?? 1}
          canJudge={marksSupported}
          onConfirm={() => store().confirmDevice(selectedDevice)}
          onReject={() => store().rejectDevice(selectedDevice)}
          onUndoVerdict={() => store().clearVerdict(selectedDevice.group || selectedDevice.id)}
        />
      )}
    </div>
  );
};

export default LyricAnalysisPane;
