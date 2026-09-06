import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
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
const READING_POS = 0.42;
/** A scroll we did not write parks the auto-scroll for this long. */
const MANUAL_HOLD_MS = 2500;
/** How long a programmatic scroll claims the scroll events it causes. */
const AUTO_SCROLL_CLAIM_MS = 120;
const NUDGE_MS = 50;
/** The glide toward the next line starts this far into the current line (as
 *  a fraction of its duration) and lands exactly when the next line starts,
 *  so the text is always moving forward instead of stepping line by line. */
const GLIDE_FROM = 0.6;
/** Time constant of the scroll glide, seconds: how fast the scroll position
 *  eases toward its target each frame. */
const GLIDE_TAU_SEC = 0.22;
/** A target further than this many viewport heights away is a seek: jump. */
const GLIDE_SNAP_VIEWPORTS = 1.5;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The karaoke text: large, centred, the active line brightest and biggest,
 * past lines dimmed, the next one half-lit. Rendered ONCE per doc; every
 * frame afterwards touches the DOM directly: a data-state flip on the line
 * that changed, a data-on flip on the word that changed, one CSS variable
 * write for the word fill, and one scrollTop write for the glide.
 *
 * The scroll is continuous, not stepped: the reading position glides from the
 * active line toward the next timed line over the last part of the active
 * line, and a per-frame ease smooths every target change (line change, seek
 * within the glide range). Nothing here flashes: a word fills left to right,
 * a line brightens once and dims once.
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
    // Glide state: where the scroll wants to be, and the rAF that eases it there.
    const targetTopRef = useRef<number | null>(null);
    const glideRafRef = useRef(0);
    const glideLastRef = useRef(0);

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

    useEffect(() => () => cancelAnimationFrame(glideRafRef.current), []);

    /** The scrollTop that puts the middle of line `lineIdx` at the reading position. */
    const topForLine = (lineIdx: number): number | null => {
      const el = scrollRef.current;
      const li = lineElsRef.current[lineIdx];
      if (!el || !li) return null;
      return Math.max(0, li.offsetTop - el.clientHeight * READING_POS + li.offsetHeight / 2);
    };

    /** One eased step toward the target; keeps itself scheduled until it lands. */
    const glideStep = () => {
      glideRafRef.current = 0;
      const el = scrollRef.current;
      const target = targetTopRef.current;
      if (!el || target === null) return;
      const now = performance.now();
      const dt = glideLastRef.current ? Math.min(0.05, (now - glideLastRef.current) / 1000) : 1 / 60;
      glideLastRef.current = now;
      const cur = el.scrollTop;
      const delta = target - cur;
      if (Math.abs(delta) < 0.5) {
        glideLastRef.current = 0;
        return;
      }
      let next: number;
      if (Math.abs(delta) > el.clientHeight * GLIDE_SNAP_VIEWPORTS) next = target;
      else next = cur + delta * (1 - Math.exp(-dt / GLIDE_TAU_SEC));
      autoScrollUntilRef.current = now + AUTO_SCROLL_CLAIM_MS;
      el.scrollTop = next;
      glideRafRef.current = requestAnimationFrame(glideStep);
    };

    const setTarget = (top: number, force: boolean) => {
      const now = performance.now();
      if (!force && now < manualUntilRef.current) return;
      if (force) manualUntilRef.current = 0;
      targetTopRef.current = top;
      if (!glideRafRef.current) glideRafRef.current = requestAnimationFrame(glideStep);
    };

    const scrollLineIntoReadingPos = (lineIdx: number, force = false) => {
      const top = topForLine(lineIdx);
      if (top !== null) setTarget(top, force);
    };

    /** Where the reading position should be at `posMs` inside `lineIdx`: on
     *  the line, then gliding to the next timed line over its last part. */
    const glideTargetAt = (lineIdx: number, posMs: number): number | null => {
      const top = topForLine(lineIdx);
      if (top === null) return null;
      const line = doc.lines[lineIdx];
      const next = nextTimedLine(indexRef.current, lineIdx);
      if (next < 0 || line.start_ms === null) return top;
      const nextStart = doc.lines[next].start_ms;
      if (nextStart === null || nextStart <= line.start_ms) return top;
      const nextTop = topForLine(next);
      if (nextTop === null) return top;
      const dur = nextStart - line.start_ms;
      const p = clamp01((posMs - line.start_ms - dur * GLIDE_FROM) / (dur * (1 - GLIDE_FROM)));
      return top + (nextTop - top) * p;
    };

    const setLineState = (lineIdx: number, state: string) => {
      const li = lineElsRef.current[lineIdx];
      if (li) li.dataset.state = state;
    };

    const dropWord = () => {
      if (activeWordRef.current) {
        delete activeWordRef.current.dataset.on;
        activeWordRef.current.style.removeProperty('--p');
        activeWordRef.current = null;
      }
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
          } else {
            for (const el of lineElsRef.current) el.dataset.state = '';
          }
          dropWord();
          activeSlotRef.current = -1;
          activeLineRef.current = lineIdx;
          onActiveLineRef.current?.(lineIdx);
        }
        if (lineIdx < 0) return;
        const target = glideTargetAt(lineIdx, posMs);
        if (target !== null) setTarget(target, false);
        const slot = findActiveWord(idx, lineIdx, posMs);
        if (slot !== activeSlotRef.current) {
          dropWord();
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
        dropWord();
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
      <div ref={scrollRef} className="sing-scroller h-full overflow-y-auto" role="region" aria-label="Lyrics">
        <ol ref={listRef} className="sing-lines" {...(tapMode ? { 'data-tap': '' } : {})}>
          {doc.lines.map((line, i) => {
            const timed = line.start_ms !== null;
            const low = line.confidence !== null && line.confidence < 0.6 && line.kind === 'lyric';
            const seekable = timed && line.kind === 'lyric';
            const label = line.kind === 'marker' ? line.text : line.text || ' ';
            const heardHere = line.words.filter((w) => w.heard !== undefined && w.heard !== null).length;
            return (
              <li key={i} data-line={i} data-state="" data-kind={line.kind} {...(line.text ? {} : { 'data-blank': '' })}>
                <span
                  className="sing-chip"
                  {...(timed ? {} : { 'data-untimed': '' })}
                  {...(low ? { 'data-low': '' } : {})}
                  {...(heardHere ? { 'data-heard': '' } : {})}
                  title={[
                    low ? `Low confidence: ${Math.round((line.confidence ?? 0) * 100)}% of the words matched` : '',
                    heardHere ? `${heardHere} ${heardHere === 1 ? 'word differs' : 'words differ'} from what whisper heard` : '',
                  ].filter(Boolean).join('. ') || undefined}
                >
                  {timed ? formatChip(line.start_ms as number) : line.kind === 'marker' || !line.text ? '' : '· ·'}
                </span>
                {line.kind === 'lyric' && line.text ? (
                  <button
                    type="button"
                    className={`sing-text ${seekable || tapMode ? 'cursor-pointer' : 'cursor-default'}`}
                    onClick={() => onLineClick(i)}
                    title={tapMode ? 'Tap target: the next stamp lands here' : seekable ? 'Seek to this line' : undefined}
                  >
                    {line.words.length
                      ? line.words.map((w, j) => {
                          const heard = w.heard !== undefined && w.heard !== null;
                          return (
                            <React.Fragment key={j}>
                              {j > 0 ? ' ' : null}
                              <span
                                data-word={j}
                                {...(heard ? { 'data-heard': '' } : {})}
                                title={heard ? (w.heard ? `Whisper heard “${w.heard}”` : 'Whisper did not hear this word') : undefined}
                              >
                                {w.text}
                              </span>
                            </React.Fragment>
                          );
                        })
                      : line.text}
                  </button>
                ) : (
                  <span className="sing-text">{label}</span>
                )}
                {tapMode && timed && line.kind === 'lyric' && (
                  <span className="sing-nudge">
                    <button
                      type="button"
                      onClick={() => onNudge(i, -NUDGE_MS)}
                      aria-label={`Line ${i + 1} earlier ${NUDGE_MS} ms`}
                      title={`Earlier ${NUDGE_MS} ms`}
                    >
                      −
                    </button>
                    <button
                      type="button"
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
