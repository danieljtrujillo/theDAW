import React, { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { LyricsDoc } from '../../../lib/lyricsClient';
import {
  buildIndex,
  findActiveLine,
  findActiveWord,
  formatChip,
  nextTimedLine,
  wordDocIndex,
  wordProgress,
  type LyricsIndex,
} from './singSync';
import './sing.css';

export interface LyricsScrollerHandle {
  /** Song position (offset already applied), ms. Called every frame. */
  setPosition: (posMs: number) => void;
  /** Drop every highlight (the player holds another track). */
  clear: () => void;
  scrollToLine: (lineIdx: number) => void;
}

export interface LyricsScrollerProps {
  doc: LyricsDoc;
  tapMode: boolean;
  onSeekLine: (lineIdx: number) => void;
  onSelectTapTarget: (lineIdx: number) => void;
  onNudge: (lineIdx: number, deltaMs: number) => void;
  /** Reported whenever the active line changes (the pitch lane scores by line). */
  onActiveLine?: (lineIdx: number) => void;
}

/** Where the active line sits in the viewport, as a fraction of its height. */
const READING_POS = 0.38;
/** A scroll we did not write parks the auto-scroll for this long. */
const MANUAL_HOLD_MS = 2500;
/** How long a programmatic scroll claims the scroll events it causes. */
const AUTO_SCROLL_CLAIM_MS = 700;
const NUDGE_MS = 50;

/**
 * The karaoke text. Rendered ONCE per doc; every frame afterwards touches the
 * DOM directly: a data-state flip on the line that changed, a data-on flip on
 * the word that changed, and one CSS variable write for the word fill.
 */
export const LyricsScroller = forwardRef<LyricsScrollerHandle, LyricsScrollerProps>(
  ({ doc, tapMode, onSeekLine, onSelectTapTarget, onNudge, onActiveLine }, ref) => {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const listRef = useRef<HTMLOListElement | null>(null);
    const indexRef = useRef<LyricsIndex>(buildIndex(doc));
    const lineElsRef = useRef<HTMLLIElement[]>([]);
    const wordElsRef = useRef<HTMLSpanElement[][]>([]);
    const activeLineRef = useRef(-1);
    const activeWordRef = useRef<HTMLSpanElement | null>(null);
    const activeSlotRef = useRef(-1);
    const manualUntilRef = useRef(0);
    const autoScrollUntilRef = useRef(0);
    const onActiveLineRef = useRef(onActiveLine);
    onActiveLineRef.current = onActiveLine;

    // Re-collect the element tables after every doc render.
    useLayoutEffect(() => {
      indexRef.current = buildIndex(doc);
      const list = listRef.current;
      const lines = list ? Array.from(list.querySelectorAll<HTMLLIElement>('li[data-line]')) : [];
      lineElsRef.current = lines;
      wordElsRef.current = lines.map((li) => Array.from(li.querySelectorAll<HTMLSpanElement>('span[data-word]')));
      activeLineRef.current = -1;
      activeWordRef.current = null;
      activeSlotRef.current = -1;
    }, [doc]);

    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const onScroll = () => {
        const now = performance.now();
        if (now <= autoScrollUntilRef.current) return;
        manualUntilRef.current = now + MANUAL_HOLD_MS;
      };
      el.addEventListener('scroll', onScroll, { passive: true });
      return () => el.removeEventListener('scroll', onScroll);
    }, []);

    const scrollLineIntoReadingPos = (lineIdx: number, force = false) => {
      const el = scrollRef.current;
      const li = lineElsRef.current[lineIdx];
      if (!el || !li) return;
      const now = performance.now();
      if (!force && now < manualUntilRef.current) return;
      const top = li.offsetTop - el.clientHeight * READING_POS + li.offsetHeight / 2;
      autoScrollUntilRef.current = now + AUTO_SCROLL_CLAIM_MS;
      el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    };

    const setLineState = (lineIdx: number, state: string) => {
      const li = lineElsRef.current[lineIdx];
      if (li) li.dataset.state = state;
    };

    useImperativeHandle(ref, () => ({
      setPosition: (posMs) => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        const idx = indexRef.current;
        const lineIdx = findActiveLine(idx, posMs);
        if (lineIdx !== activeLineRef.current) {
          const prev = activeLineRef.current;
          if (prev >= 0) setLineState(prev, 'past');
          // Everything before the new line is past, the timed line after it is next.
          const prevNext = prev >= 0 ? nextTimedLine(idx, prev) : -1;
          if (prevNext >= 0 && prevNext !== lineIdx) setLineState(prevNext, '');
          if (lineIdx >= 0) {
            setLineState(lineIdx, 'active');
            const next = nextTimedLine(idx, lineIdx);
            if (next >= 0) setLineState(next, 'next');
            // Lines skipped by a seek forward become past; a seek back clears.
            for (let i = 0; i < lineElsRef.current.length; i += 1) {
              if (i === lineIdx || i === next) continue;
              const el = lineElsRef.current[i];
              const timed = doc.lines[i]?.start_ms;
              const want = timed !== null && timed !== undefined && timed < (doc.lines[lineIdx].start_ms ?? 0) ? 'past' : '';
              if (el.dataset.state !== want) el.dataset.state = want;
            }
            scrollLineIntoReadingPos(lineIdx);
          } else {
            for (const el of lineElsRef.current) el.dataset.state = '';
          }
          if (activeWordRef.current) {
            delete activeWordRef.current.dataset.on;
            activeWordRef.current.style.removeProperty('--p');
            activeWordRef.current = null;
          }
          activeSlotRef.current = -1;
          activeLineRef.current = lineIdx;
          onActiveLineRef.current?.(lineIdx);
        }
        if (lineIdx < 0) return;
        const slot = findActiveWord(idx, lineIdx, posMs);
        if (slot !== activeSlotRef.current) {
          if (activeWordRef.current) {
            delete activeWordRef.current.dataset.on;
            activeWordRef.current.style.removeProperty('--p');
            activeWordRef.current = null;
          }
          activeSlotRef.current = slot;
          const wordIdx = wordDocIndex(idx, lineIdx, slot);
          const span = wordIdx >= 0 ? wordElsRef.current[lineIdx]?.[wordIdx] ?? null : null;
          if (span) {
            span.dataset.on = '';
            activeWordRef.current = span;
          }
        }
        if (activeWordRef.current && slot >= 0) {
          activeWordRef.current.style.setProperty('--p', wordProgress(idx, lineIdx, slot, posMs).toFixed(3));
        }
      },
      clear: () => {
        for (const el of lineElsRef.current) el.dataset.state = '';
        if (activeWordRef.current) {
          delete activeWordRef.current.dataset.on;
          activeWordRef.current.style.removeProperty('--p');
          activeWordRef.current = null;
        }
        activeLineRef.current = -1;
        activeSlotRef.current = -1;
      },
      scrollToLine: (lineIdx) => scrollLineIntoReadingPos(lineIdx, true),
    }), [doc]);

    const onLineClick = (lineIdx: number) => {
      if (tapMode) onSelectTapTarget(lineIdx);
      else onSeekLine(lineIdx);
    };

    return (
      <div ref={scrollRef} className="h-full overflow-y-auto px-4 py-[38vh]" role="region" aria-label="Lyrics">
        <ol ref={listRef} className="sing-lines space-y-1.5">
          {doc.lines.map((line, i) => {
            const timed = line.start_ms !== null;
            const low = line.confidence !== null && line.confidence < 0.6 && line.kind === 'lyric';
            const seekable = timed && line.kind === 'lyric';
            const label = line.kind === 'marker' ? line.text : line.text || ' ';
            return (
              <li
                key={i}
                data-line={i}
                data-state=""
                data-kind={line.kind}
                className="flex items-baseline gap-2 text-[15px] leading-snug text-zinc-400"
              >
                <span
                  className="sing-chip shrink-0"
                  {...(timed ? {} : { 'data-untimed': '' })}
                  {...(low ? { 'data-low': '' } : {})}
                  title={low ? `Low confidence: ${Math.round((line.confidence ?? 0) * 100)}% of the words matched` : undefined}
                >
                  {timed ? formatChip(line.start_ms as number) : line.kind === 'marker' || !line.text ? '' : '·  ·'}
                </span>
                {line.kind === 'lyric' && line.text ? (
                  <button
                    type="button"
                    className={`sing-text text-left ${seekable || tapMode ? 'cursor-pointer hover:text-zinc-100' : 'cursor-default'}`}
                    onClick={() => onLineClick(i)}
                    title={tapMode ? 'Tap target: the next stamp lands here' : seekable ? 'Seek to this line' : undefined}
                  >
                    {line.words.length
                      ? line.words.map((w, j) => (
                          <React.Fragment key={j}>
                            {j > 0 ? ' ' : null}
                            <span data-word={j}>{w.text}</span>
                          </React.Fragment>
                        ))
                      : line.text}
                  </button>
                ) : (
                  <span className="sing-text">{label}</span>
                )}
                {tapMode && timed && line.kind === 'lyric' && (
                  <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[9px] font-mono text-zinc-500">
                    <button
                      type="button"
                      className="px-1 rounded hover:bg-white/10"
                      onClick={() => onNudge(i, -NUDGE_MS)}
                      aria-label={`Line ${i + 1} earlier ${NUDGE_MS} ms`}
                      title={`Earlier ${NUDGE_MS} ms`}
                    >
                      −
                    </button>
                    <button
                      type="button"
                      className="px-1 rounded hover:bg-white/10"
                      onClick={() => onNudge(i, NUDGE_MS)}
                      aria-label={`Line ${i + 1} later ${NUDGE_MS} ms`}
                      title={`Later ${NUDGE_MS} ms`}
                    >
                      +
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    );
  },
);

LyricsScroller.displayName = 'LyricsScroller';

export default LyricsScroller;
