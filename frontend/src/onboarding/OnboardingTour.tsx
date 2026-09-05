/**
 * Feature-tour spotlight overlay.
 *
 * Renders nothing until the onboarding store is `active`. While active it masks
 * the screen, cuts a spotlight hole over the current step's target element and
 * floats an explanation card next to it. Steps that name a `tab` switch the
 * center workspace first; steps with a `prepare` hook open the panel their
 * target lives in (and undo that when the step is left).
 *
 * No dead ends: a target is polled for a few seconds (lazy tabs mount late),
 * then tracked while the step is showing so the spotlight follows layout
 * transitions; a target that never appears degrades to a centred card, never a
 * blank spotlight. The card is a proper dialog: focus lands on the primary
 * button on every step, Tab cycles inside the card, ← / → move, Esc leaves.
 *
 * Target coordinates come from getBoundingClientRect() and the overlay is
 * portaled to <body> and fixed-positioned, so it shares the target's viewport
 * coordinate space (the shell's CSS zoom does not apply to it).
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { type CenterTab } from '../state/appUiStore';
import { useOnboardingStore } from './onboardingStore';
import { TOUR_STEPS, type TourStep } from './tourSteps';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PAD = 8;
const CARD_GAP = SPOTLIGHT_PAD + 12;
const CARD_WIDTH = 340;
const CARD_WIDTH_CENTERED = 420;
const MASK = 'rgba(5,5,7,0.86)';
/** Keep looking for a lazily mounted target this long before settling on a centred card. */
const FIND_TIMEOUT_MS = 4000;
const FIND_INTERVAL_MS = 100;
/** Once found (or given up), re-measure at this pace so the spotlight follows layout changes. */
const TRACK_INTERVAL_MS = 350;
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const PULSE_CSS = `
@keyframes tour-ring-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(168,85,247,0.55); }
  70%  { box-shadow: 0 0 0 10px rgba(168,85,247,0); }
  100% { box-shadow: 0 0 0 0 rgba(168,85,247,0); }
}
.tour-ring { animation: tour-ring-pulse 1.8s ease-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .tour-ring { animation: none !important; }
}`;

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

  const [rect, setRect] = useState<Rect | null>(null);
  const [cardH, setCardH] = useState(280);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  const total = TOUR_STEPS.length;
  const clampedIndex = clamp(stepIndex, 0, total - 1);
  const step = TOUR_STEPS[clampedIndex];
  const isFirst = clampedIndex === 0;
  const isLast = clampedIndex >= total - 1;

  // Guard: if the index ran past the end, close cleanly.
  useEffect(() => {
    if (active && stepIndex >= total) finish();
  }, [active, stepIndex, total, finish]);

  const complete = useCallback(() => {
    if (step?.finishTab) onSwitchTab(step.finishTab);
    finish();
  }, [step, onSwitchTab, finish]);

  const advance = useCallback(() => {
    if (isLast) complete();
    else next();
  }, [isLast, complete, next]);

  // On step change: switch tab + prepare, then look for the target (fast) until
  // it appears or we time out, then keep tracking it (slow) so the spotlight
  // follows panel transitions. Leaving the step undoes what prepare() opened.
  useEffect(() => {
    if (!active || !step) return;
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
  }, [active, step, onSwitchTab]);

  // Keep the spotlight aligned when the window resizes or the page scrolls.
  useEffect(() => {
    if (!active || !step) return;
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
  }, [active, step]);

  // Measure the card so placement can flip/side-step without covering the target.
  useLayoutEffect(() => {
    if (!active) return;
    const h = cardRef.current?.offsetHeight ?? 0;
    if (h > 0 && Math.abs(h - cardH) > 2) setCardH(h);
  });

  // Focus: land on the primary button on every step; give focus back on close.
  useEffect(() => {
    if (!active) return;
    returnFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    return () => {
      const el = returnFocusRef.current;
      if (el && typeof el.focus === 'function' && document.contains(el)) el.focus({ preventScroll: true });
    };
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const id = window.requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(id);
  }, [active, clampedIndex]);

  // Keyboard: Esc leaves, ← / → move, Tab cycles inside the card.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        skip();
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
  }, [active, isFirst, advance, back, skip]);

  if (!active || !step) return null;

  // Card placement: centred when there is no target; otherwise below/above the
  // target, clamped into the viewport, and moved beside the target when it
  // would otherwise cover it (tall targets such as the library rail).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(rect ? CARD_WIDTH : CARD_WIDTH_CENTERED, vw - 24);
  let cardStyle: React.CSSProperties;
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
    cardStyle = { position: 'fixed', top, left, width };
  } else {
    cardStyle = {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width,
    };
  }

  const primaryLabel = step.primaryLabel ?? (isLast ? 'Finish' : 'Next');
  const btnBase =
    'inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60';

  return createPortal(
    <div
      className="fixed inset-0 z-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      <style>{PULSE_CSS}</style>

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
            boxShadow: `0 0 0 9999px ${MASK}`,
          }}
        >
          <div className="tour-ring absolute inset-0 rounded-lg border border-purple-400/70" />
        </div>
      ) : (
        <div aria-hidden="true" className="fixed inset-0" style={{ background: MASK }} />
      )}

      {/* Explanation card */}
      <div
        ref={cardRef}
        style={cardStyle}
        className="max-w-[94vw] bg-[#0c0a14] border border-purple-500/30 rounded-xl shadow-2xl p-4 flex flex-col gap-3"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500" aria-live="polite">
            Step {clampedIndex + 1} of {total}
          </span>
          <button
            type="button"
            onClick={skip}
            aria-label="Close tour"
            title="Close tour (Esc)"
            className="ml-auto p-1 rounded border border-transparent text-zinc-500 hover:text-white hover:bg-white/5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* Progress: one segment per step, each a jump target. */}
        <div className="flex items-center gap-1" aria-label="Tour progress">
          {TOUR_STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Step ${i + 1}: ${s.title}`}
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
          ))}
        </div>

        <h2 id={titleId} className="text-[13px] font-black uppercase tracking-widest text-purple-100">
          {step.title}
        </h2>

        {step.media && <div>{step.media}</div>}

        <div id={bodyId} className="flex flex-col gap-1.5">
          <p className="text-[11px] leading-relaxed text-zinc-300">{step.body}</p>
          {step.tip && <p className="text-[10px] leading-relaxed text-zinc-500">{step.tip}</p>}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 pt-0.5">
          {!isFirst && (
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
            onClick={advance}
            className={`${btnBase} border border-purple-400/50 bg-purple-500/25 text-purple-50 hover:bg-purple-500/40`}
          >
            {primaryLabel}
            {!isLast && <ChevronRight className="w-3 h-3" aria-hidden="true" />}
          </button>
          {!isLast && (
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
      </div>
    </div>,
    document.body,
  );
};
