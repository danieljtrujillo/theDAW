/**
 * Feature-tour spotlight overlay.
 *
 * Renders nothing until the onboarding store is `active`. While active it masks
 * the screen, cuts a spotlight hole over the current step's target element and
 * floats an explanation card next to it. Steps that name a `tab` switch the
 * center workspace first; steps with a `prepare` hook open the panel their
 * target lives in (and undo that when the step is left).
 *
 * The steps are grouped into chapters and this component owns the boundaries:
 * it knows which step ends which chapter, so it draws progress inside the
 * chapter you are in rather than one hairline per step, labels the primary
 * button "Next chapter" at a boundary, and tells the store a chapter is behind
 * you. The first step is the chapter picker — a walkthrough of everything is
 * forty-one steps, which is not a sitting, and the heavy workspaces only mount
 * when the chapter that visits them is opened.
 *
 * No dead ends: a target is polled for a few seconds (lazy tabs mount late),
 * then tracked while the step is showing so the spotlight follows layout
 * transitions; a target that never appears degrades to a centred card, never a
 * blank spotlight. The card is a proper dialog: focus lands on the primary
 * button on every step, Tab cycles inside the card, ← / → move, Esc leaves.
 *
 * Target coordinates come from getBoundingClientRect() and the overlay is
 * portaled to <body> and fixed-positioned, so it shares the target's viewport
 * coordinate space (the shell's CSS zoom does not apply to it). A measured
 * leader runs from the card to the spotlight ring, because the card side-steps
 * a target it would otherwise cover and can end up a long way from it.
 *
 * The same engine serves a SOLO spotlight: one feature from the registry, lit
 * up on request ("show me where that is"). It reuses every hard-won detail here
 * — the lazy-mount poll, the never-cover-your-own-target flip, the zoom-safe
 * portal — and drops everything that makes this a tour: no steps, no progress,
 * no modality (you can still click the thing being pointed at), and no exit
 * through skip()/finish(), both of which would mark the real tour as seen.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, List, X } from 'lucide-react';
import { type CenterTab } from '../state/appUiStore';
import { useOnboardingStore } from './onboardingStore';
import { spotlightStepFor } from './soloSpotlight';
import { SpotlightPointer } from './SpotlightPointer';
import { type Box } from './spotlightGeometry';
import { chapterRange, TOUR_CHAPTERS, TOUR_STEPS, type ChapterId, type TourStep } from './tourSteps';
import './onboarding.css';

/** Same shape the spotlight geometry speaks; named for what it is here. */
type Rect = Box;

const SPOTLIGHT_PAD = 8;
const CARD_GAP = SPOTLIGHT_PAD + 12;
const CARD_WIDTH = 340;
const CARD_WIDTH_CENTERED = 420;
/** A solo spotlight names one control; it needs less room than a tour step. */
const CARD_WIDTH_SOLO = 280;
const MASK = 'rgba(5,5,7,0.86)';
/** Lighter for a solo spotlight: it points, it does not teach, and the control
 *  under it stays clickable, so it must stay readable too. */
const SOLO_MASK = 'rgba(5,5,7,0.55)';
/**
 * Keep looking for a lazily mounted target this long before settling on a
 * centred card. Generous because the chaptered tour visits the code-split tabs
 * (DJ, VJ, LOOM, NODEFI, TOUR), which fetch their chunk on first visit — a
 * short window expires on a cold cache and silently downgrades a real target to
 * a centred card, which reads as "the tour is broken" rather than "still
 * loading".
 */
const FIND_TIMEOUT_MS = 8000;
const FIND_INTERVAL_MS = 100;
/** Once found (or given up), re-measure at this pace so the spotlight follows layout changes. */
const TRACK_INTERVAL_MS = 350;
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5);

/** Viewport rect of a step's target (union of all matches when asked), or null when it is not on screen. */
function findRect(step: TourStep): Rect | null {
  if (!step.targetSelector) return null;
  let els: HTMLElement[];
  try {
    els = Array.from(document.querySelectorAll<HTMLElement>(step.targetSelector));
  } catch {
    return null;
  }
  if (!els.length) return null;
  const rects = (step.targetMode === 'union' ? els : [els[0]])
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (right <= 0 || bottom <= 0 || left >= vw || top >= vh) return null; // off-screen
  return { top, left, width: right - left, height: bottom - top };
}

/**
 * The jump list: one row per chapter, ticked when you have walked it end to
 * end. Plain buttons in a <nav> rather than a listbox — these navigate, they do
 * not pick a value, and a listbox's roving tabindex would fight the card's own
 * Tab cycle for no gain.
 */
const ChapterList: React.FC<{
  id: string;
  index: number;
  completed: string[];
  onPick: (stepIndex: number) => void;
}> = ({ id, index, completed, onPick }) => (
  <nav id={id} aria-label="Tour chapters" className="flex flex-col gap-1">
    {TOUR_CHAPTERS.map((c, i) => {
      const range = chapterRange(c.id);
      const here = index >= range.start && index <= range.end;
      const done = completed.includes(c.id);
      return (
        <button
          key={c.id}
          type="button"
          onClick={() => onPick(range.start)}
          aria-current={here ? 'step' : undefined}
          className={`flex items-start gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 ${
            here
              ? 'border-purple-400/50 bg-purple-500/15'
              : 'border-white/8 bg-white/3 hover:border-purple-400/30 hover:bg-purple-500/10'
          }`}
        >
          <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-[10px] text-purple-300/80">
            {done ? <Check className="mx-auto h-3 w-3" aria-hidden="true" /> : i + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-black uppercase tracking-widest text-purple-100">
              {c.title}
            </span>
            <span className="block text-[10px] leading-snug text-zinc-500">{c.blurb}</span>
          </span>
          <span className="mt-0.5 shrink-0 font-mono text-[9px] uppercase tracking-widest text-zinc-600">
            {done ? 'done' : `${range.end - range.start + 1}`}
          </span>
        </button>
      );
    })}
  </nav>
);

export const OnboardingTour: React.FC<{ onSwitchTab: (tab: CenterTab) => void }> = ({
  onSwitchTab,
}) => {
  const active = useOnboardingStore((s) => s.active);
  const stepIndex = useOnboardingStore((s) => s.stepIndex);
  const next = useOnboardingStore((s) => s.next);
  const back = useOnboardingStore((s) => s.back);
  const goTo = useOnboardingStore((s) => s.goTo);
  const skip = useOnboardingStore((s) => s.skip);
  const finish = useOnboardingStore((s) => s.finish);
  const neverShowAgain = useOnboardingStore((s) => s.neverShowAgain);
  const completedChapters = useOnboardingStore((s) => s.completedChapters);
  const markChapterDone = useOnboardingStore((s) => s.markChapterDone);
  const soloFeatureId = useOnboardingStore((s) => s.soloFeatureId);
  const endSpotlight = useOnboardingStore((s) => s.endSpotlight);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardH, setCardH] = useState(280);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const chapterListId = useId();

  const total = TOUR_STEPS.length;
  const clampedIndex = clamp(stepIndex, 0, total - 1);
  // Memoised on the id, not rebuilt per render: the step effect below keys off
  // `step` by identity, so a fresh object every render would tear down and
  // re-run prepare() and the poll loop forever.
  const soloStep = useMemo(
    () => (soloFeatureId ? spotlightStepFor(soloFeatureId) : null),
    [soloFeatureId],
  );
  /** A running tour always wins; a solo spotlight only shows in its absence. */
  const solo = !active && !!soloStep;
  const showing = active || solo;
  const step = solo ? (soloStep as TourStep) : TOUR_STEPS[clampedIndex];
  const isFirst = clampedIndex === 0;
  const isLast = clampedIndex >= total - 1;
  const dismiss = solo ? endSpotlight : skip;

  // Chapter position. A solo spotlight belongs to no chapter, so everything
  // here is read off the real step list rather than off `step`.
  const chapterId: ChapterId = TOUR_STEPS[clampedIndex].chapter;
  const chapter = TOUR_CHAPTERS.find((c) => c.id === chapterId) ?? TOUR_CHAPTERS[0];
  const range = chapterRange(chapterId);
  const chapterLength = range.end - range.start + 1;
  const isLastInChapter = clampedIndex >= range.end;
  /** The welcome step IS the picker; every other step reaches it from the header. */
  const isPickerStep = !solo && !!step?.chapterPicker;
  const showPicker = isPickerStep || (!solo && pickerOpen);
  /** The list opened over a step that has its own thing to say — so say the list's. */
  const detour = showPicker && !isPickerStep;

  // The jump list is a detour, not a mode: any move closes it again.
  useEffect(() => setPickerOpen(false), [clampedIndex, showing]);

  // Guard: if the index ran past the end, close cleanly.
  useEffect(() => {
    if (active && stepIndex >= total) finish();
  }, [active, stepIndex, total, finish]);

  const complete = useCallback(() => {
    if (step?.finishTab) onSwitchTab(step.finishTab);
    finish();
  }, [step, onSwitchTab, finish]);

  const advance = useCallback(() => {
    if (isLastInChapter) markChapterDone(chapterId);
    if (isLast) complete();
    else next();
  }, [isLast, isLastInChapter, chapterId, markChapterDone, complete, next]);

  // On step change: switch tab + prepare, then look for the target (fast) until
  // it appears or we time out, then keep tracking it (slow) so the spotlight
  // follows panel transitions. Leaving the step undoes what prepare() opened.
  useEffect(() => {
    if (!showing || !step) return;
    if (step.tab) onSwitchTab(step.tab);
    let undo: (() => void) | void;
    try {
      undo = step.prepare?.();
    } catch {
      undo = undefined;
    }

    let cancelled = false;
    let timer: number | null = null;
    let raf: number | null = null;
    const started = performance.now();
    const tick = () => {
      raf = null;
      if (cancelled) return;
      const r = findRect(step);
      setRect((prev) => (sameRect(prev, r) ? prev : r));
      const searching = !r && !!step.targetSelector && performance.now() - started < FIND_TIMEOUT_MS;
      timer = window.setTimeout(() => {
        raf = window.requestAnimationFrame(tick);
      }, searching ? FIND_INTERVAL_MS : TRACK_INTERVAL_MS);
    };
    raf = window.requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (raf !== null) window.cancelAnimationFrame(raf);
      if (typeof undo === 'function') undo();
    };
  }, [showing, step, onSwitchTab]);

  // Keep the spotlight aligned when the window resizes or the page scrolls.
  useEffect(() => {
    if (!showing || !step) return;
    const onChange = () => setRect((prev) => {
      const r = findRect(step);
      return sameRect(prev, r) ? prev : r;
    });
    window.addEventListener('resize', onChange);
    window.addEventListener('scroll', onChange, true);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('scroll', onChange, true);
    };
  }, [showing, step]);

  // Measure the card so placement can flip/side-step without covering the target.
  useLayoutEffect(() => {
    if (!showing) return;
    const h = cardRef.current?.offsetHeight ?? 0;
    if (h > 0 && Math.abs(h - cardH) > 2) setCardH(h);
  });

  // Focus: land on the primary button on every step; give focus back on close.
  useEffect(() => {
    if (!showing) return;
    returnFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const el = returnFocusRef.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus({ preventScroll: true });
    };
  }, [showing]);
  useEffect(() => {
    if (!showing) return;
    const id = window.requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(id);
  }, [showing, clampedIndex]);

  // Keyboard: Esc leaves, ← / → move, Tab cycles inside the card. A solo
  // spotlight has nowhere to move to and is not modal, so it takes Esc only and
  // leaves Tab to the page underneath.
  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      } else if (solo) {
        return;
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        advance();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (!isFirst) back();
      } else if (e.key === 'Tab') {
        const card = cardRef.current;
        if (!card) return;
        const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null,
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const current = document.activeElement as HTMLElement | null;
        const inside = !!current && card.contains(current);
        if (!inside) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        } else if (!e.shiftKey && current === last) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && current === first) {
          e.preventDefault();
          last.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showing, solo, isFirst, advance, back, dismiss]);

  if (!showing || !step) return null;

  // Card placement: centred when there is no target; otherwise below/above the
  // target, clamped into the viewport, and moved beside the target when it
  // would otherwise cover it (tall targets such as the library rail).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(rect ? (solo ? CARD_WIDTH_SOLO : CARD_WIDTH) : CARD_WIDTH_CENTERED, vw - 24);
  let cardStyle: React.CSSProperties;
  // The placed card, kept rather than collapsed straight into a style: a leader
  // can only be aimed from where the card ACTUALLY ended up. Stays null for the
  // centred branch, which has no target to reach for.
  let cardBox: Rect | null = null;
  if (rect) {
    const below = rect.top + rect.height + CARD_GAP;
    const canBelow = below + cardH <= vh - 8;
    const aboveTop = rect.top - CARD_GAP - cardH;
    const canAbove = aboveTop >= 8;
    let top: number;
    if (canBelow || (!canAbove && rect.top < vh / 2)) top = Math.min(below, vh - cardH - 8);
    else top = Math.max(8, aboveTop);
    let left = clamp(rect.left + rect.width / 2 - width / 2, 12, vw - width - 12);
    const covers =
      top < rect.top + rect.height &&
      top + cardH > rect.top &&
      left < rect.left + rect.width &&
      left + width > rect.left;
    if (covers) {
      const rightSide = rect.left + rect.width + CARD_GAP;
      const leftSide = rect.left - CARD_GAP - width;
      if (rightSide + width <= vw - 12) {
        left = rightSide;
        top = clamp(rect.top, 8, Math.max(8, vh - cardH - 8));
      } else if (leftSide >= 12) {
        left = leftSide;
        top = clamp(rect.top, 8, Math.max(8, vh - cardH - 8));
      }
    }
    cardBox = { top, left, width, height: cardH };
    cardStyle = { position: 'fixed', ...cardBox };
  } else {
    cardStyle = {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width,
    };
  }

  const primaryLabel = solo
    ? 'Got it'
    : (step.primaryLabel ??
      (isLast ? 'Finish' : isLastInChapter ? 'Next chapter' : 'Next'));
  const mask = solo ? SOLO_MASK : MASK;
  const btnBase =
    'inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60';

  return createPortal(
    <div
      // A tour is modal — it owns the screen until you leave it. A solo
      // spotlight is the opposite: it points at a control you asked about, so
      // the whole layer lets clicks through and only the card takes them back.
      className={`fixed inset-0 z-150 ${solo ? 'pointer-events-none' : ''}`}
      role="dialog"
      aria-modal={solo ? undefined : true}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      {/* Mask: a spotlight hole via a huge box-shadow spread, or a flat scrim. */}
      {rect ? (
        <div
          aria-hidden="true"
          className="fixed rounded-lg pointer-events-none"
          style={{
            top: rect.top - SPOTLIGHT_PAD,
            left: rect.left - SPOTLIGHT_PAD,
            width: rect.width + SPOTLIGHT_PAD * 2,
            height: rect.height + SPOTLIGHT_PAD * 2,
            boxShadow: `0 0 0 9999px ${mask}`,
          }}
        >
          <div className="tour-ring absolute inset-0 rounded-lg border border-purple-400/70" />
        </div>
      ) : (
        <div aria-hidden="true" className="fixed inset-0" style={{ background: mask }} />
      )}

      {/* Leader from the card to the ring. The target is the PADDED hole, not
          the element's own box, because the edge the eye follows is the ring.
          After the mask so it paints over the scrim, before the card so the
          card covers the seam where the stem leaves its border. */}
      {rect && cardBox && (
        <SpotlightPointer
          card={cardBox}
          target={{
            top: rect.top - SPOTLIGHT_PAD,
            left: rect.left - SPOTLIGHT_PAD,
            width: rect.width + SPOTLIGHT_PAD * 2,
            height: rect.height + SPOTLIGHT_PAD * 2,
          }}
        />
      )}

      {/* Explanation card */}
      <div
        ref={cardRef}
        style={cardStyle}
        className="max-w-[94vw] pointer-events-auto bg-[#0c0a14] border border-purple-500/30 rounded-xl shadow-2xl p-4 flex flex-col gap-3"
      >
        <div className="flex items-center gap-2">
          {!solo && (
            <span className="min-w-0 truncate text-[10px] font-mono uppercase tracking-widest text-zinc-500" aria-live="polite">
              {isPickerStep
                ? `${TOUR_CHAPTERS.length} chapters`
                : `${chapter.title} · ${clampedIndex - range.start + 1}/${chapterLength}`}
            </span>
          )}
          {!solo && !isPickerStep && (
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              aria-expanded={pickerOpen}
              aria-controls={chapterListId}
              aria-label="Tour chapters"
              title="Jump to another chapter"
              className={`ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-widest transition-colors outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 ${
                pickerOpen
                  ? 'border-purple-400/50 bg-purple-500/20 text-purple-100'
                  : 'border-white/10 bg-white/3 text-zinc-400 hover:text-zinc-100'
              }`}
            >
              <List className="h-3 w-3" aria-hidden="true" />
              Chapters
            </button>
          )}
          {solo && (
            <span className="text-[9px] font-mono uppercase tracking-wider text-zinc-500">
              Where it is
            </span>
          )}
          <button
            type="button"
            onClick={dismiss}
            aria-label={solo ? 'Close' : 'Close tour'}
            title={solo ? 'Close (Esc)' : 'Close tour (Esc)'}
            className={`${solo || isPickerStep ? 'ml-auto' : ''} p-1 rounded border border-transparent text-zinc-500 hover:text-white hover:bg-white/5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60`}
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* Progress inside the current chapter. One segment per step of the
            whole tour would be a pixel wide and unclickable; the chapter you
            are in is short enough to draw honestly, and the jump list above
            covers moving between chapters. */}
        {!solo && !isPickerStep && (
          <div className="flex items-center gap-1" role="group" aria-label={`${chapter.title}: progress`}>
            {TOUR_STEPS.slice(range.start, range.end + 1).map((s, k) => {
              const i = range.start + k;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Step ${k + 1} of ${chapterLength}: ${s.title}`}
                  aria-current={i === clampedIndex ? 'step' : undefined}
                  title={s.title}
                  className={`h-1.5 flex-1 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 ${
                    i < clampedIndex
                      ? 'bg-purple-400/60 hover:bg-purple-300/80'
                      : i === clampedIndex
                        ? 'bg-purple-400'
                        : 'bg-white/15 hover:bg-white/30'
                  }`}
                />
              );
            })}
          </div>
        )}

        <h2 id={titleId} className="text-[13px] font-black uppercase tracking-widest text-purple-100">
          {detour ? 'Chapters' : step.title}
        </h2>

        {!detour && step.media && <div>{step.media}</div>}

        <div id={bodyId} className="flex flex-col gap-1.5">
          {detour ? (
            <p className="text-[11px] leading-relaxed text-zinc-300">
              Leave this chapter for another one. What you have already walked stays ticked.
            </p>
          ) : (
            <>
              <p className="text-[11px] leading-relaxed text-zinc-300">{step.body}</p>
              {step.tip && <p className="text-[10px] leading-relaxed text-zinc-500">{step.tip}</p>}
            </>
          )}
        </div>

        {showPicker && (
          <div className="max-h-64 overflow-y-auto">
            <ChapterList
              id={chapterListId}
              index={clampedIndex}
              completed={completedChapters}
              onPick={(i) => {
                setPickerOpen(false);
                goTo(i);
              }}
            />
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-2 pt-0.5">
          {!solo && !isFirst && (
            <button
              type="button"
              onClick={back}
              className={`${btnBase} border border-white/10 bg-white/3 text-zinc-300 hover:bg-white/8`}
            >
              <ChevronLeft className="w-3 h-3" aria-hidden="true" />
              Back
            </button>
          )}
          <button
            ref={primaryRef}
            type="button"
            onClick={solo ? endSpotlight : advance}
            className={`${btnBase} border border-purple-400/50 bg-purple-500/25 text-purple-50 hover:bg-purple-500/40`}
          >
            {primaryLabel}
            {!solo && !isLast && <ChevronRight className="w-3 h-3" aria-hidden="true" />}
          </button>
          {!solo && !isLast && (
            <button
              type="button"
              onClick={skip}
              className="ml-auto rounded px-1.5 py-1 text-[10px] font-mono uppercase tracking-widest text-zinc-500 hover:text-zinc-200 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
            >
              Skip tour
            </button>
          )}
        </div>

        {/* Never show again — only relevant to the auto-start on first run. */}
        {!solo && (
        <div className="flex items-center gap-1.5">
          <input
            type="checkbox"
            id="tour-never-show"
            name="tour-never-show"
            onChange={(e) => {
              if (e.target.checked) neverShowAgain();
            }}
            className="w-3 h-3 accent-purple-500"
          />
          <label
            htmlFor="tour-never-show"
            className="text-[9px] font-mono uppercase tracking-widest text-zinc-600 cursor-pointer select-none"
          >
            Don’t show this again
          </label>
        </div>
        )}
      </div>
    </div>,
    document.body,
  );
};
