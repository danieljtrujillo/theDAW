/**
 * Feature-tour spotlight overlay.
 *
 * Renders nothing until the onboarding store is `active`. While active it masks
 * the screen, cuts a spotlight hole over the current step's target element
 * (`[data-tour=...]`), and floats an explanation card next to it. Steps that
 * name a `tab` switch the center workspace first, then the target is measured.
 * A missing target degrades gracefully to a centered card with no spotlight.
 *
 * Target coordinates come from getBoundingClientRect() and the overlay is
 * portaled to <body> and fixed-positioned, so it shares the target's viewport
 * coordinate space (the app runs in Chromium, whose zoom is rect-aware).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { type CenterTab } from '../state/appUiStore';
import { useOnboardingStore } from './onboardingStore';
import { TOUR_STEPS } from './tourSteps';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const SPOTLIGHT_PAD = 8;
const CARD_WIDTH = 320;
const MASK = 'rgba(5,5,7,0.86)';

const PULSE_CSS = `
@keyframes tour-ring-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(168,85,247,0.55); }
  70%  { box-shadow: 0 0 0 10px rgba(168,85,247,0); }
  100% { box-shadow: 0 0 0 0 rgba(168,85,247,0); }
}
@media (prefers-reduced-motion: reduce) {
  .tour-ring { animation: none !important; }
}`;

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
  const rafRef = useRef<number | null>(null);
  const retryRef = useRef<number | null>(null);

  const total = TOUR_STEPS.length;
  const clampedIndex = Math.min(stepIndex, total - 1);
  const step = TOUR_STEPS[clampedIndex];
  const isLast = clampedIndex >= total - 1;

  // Guard: if the index ran past the end, close cleanly.
  useEffect(() => {
    if (active && stepIndex >= total) finish();
  }, [active, stepIndex, total, finish]);

  const measure = useCallback(() => {
    if (!step?.targetSelector) {
      setRect(null);
      return true;
    }
    const el = document.querySelector(step.targetSelector);
    if (!el) {
      setRect(null);
      return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      setRect(null);
      return false;
    }
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    return true;
  }, [step]);

  // On step change: switch tab if requested, then measure (with a few retries
  // to allow the tab's DOM to mount before we give up and center the card).
  useEffect(() => {
    if (!active || !step) return;
    if (step.tab) onSwitchTab(step.tab);

    let attempts = 0;
    const tick = () => {
      const ok = measure();
      attempts += 1;
      if (!ok && attempts < 8) {
        retryRef.current = window.setTimeout(() => {
          rafRef.current = window.requestAnimationFrame(tick);
        }, 70);
      }
    };
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
    };
  }, [active, step, clampedIndex, onSwitchTab, measure]);

  // Keep the spotlight aligned when the window resizes.
  useEffect(() => {
    if (!active) return;
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [active, measure]);

  // Escape closes (counts as skip); arrows navigate.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        skip();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (isLast) finish();
        else next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, isLast, next, back, skip, finish]);

  if (!active || !step) return null;

  const advance = () => {
    if (isLast) finish();
    else next();
  };

  // Card placement: centered when there is no target; otherwise flip above/
  // below the target and clamp horizontally into the viewport.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  let cardStyle: React.CSSProperties;
  if (rect) {
    const placeBelow = rect.top + rect.height / 2 < vh * 0.6;
    const left = Math.max(12, Math.min(rect.left + rect.width / 2 - CARD_WIDTH / 2, vw - CARD_WIDTH - 12));
    cardStyle = placeBelow
      ? { position: 'fixed', top: rect.top + rect.height + SPOTLIGHT_PAD + 12, left, width: CARD_WIDTH }
      : { position: 'fixed', bottom: vh - rect.top + SPOTLIGHT_PAD + 12, left, width: CARD_WIDTH };
  } else {
    cardStyle = {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: CARD_WIDTH,
    };
  }

  return createPortal(
    <div className="fixed inset-0 z-150" role="dialog" aria-modal="true" aria-label="Feature tour">
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
        style={cardStyle}
        className="max-w-[92vw] bg-[#0c0a14] border border-purple-500/30 rounded-lg shadow-2xl p-3 flex flex-col gap-2.5"
      >
        <div className="flex items-center gap-2">
          <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">
            Step {clampedIndex + 1} / {total}
          </span>
          <button
            type="button"
            onClick={skip}
            aria-label="Close tour"
            className="ml-auto p-1 rounded border border-transparent text-zinc-500 hover:text-white hover:bg-white/5 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <h2 className="text-[11px] font-black uppercase tracking-widest text-purple-200">
          {step.title}
        </h2>

        {step.media && <div>{step.media}</div>}

        <p className="text-[10px] leading-relaxed text-zinc-400">{step.body}</p>

        {/* Step dots */}
        <div className="flex items-center gap-1">
          {TOUR_STEPS.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Go to step ${i + 1}`}
              aria-current={i === clampedIndex}
              className={`h-1.5 rounded-full transition-all outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60 ${
                i === clampedIndex ? 'w-4 bg-purple-400' : 'w-1.5 bg-white/20 hover:bg-white/40'
              }`}
            />
          ))}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            onClick={back}
            disabled={clampedIndex === 0}
            className="flex items-center gap-1 px-2 py-1 rounded border border-white/10 bg-white/3 text-zinc-300 hover:bg-white/8 text-[9px] font-black uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60"
          >
            <ChevronLeft className="w-3 h-3" />
            Back
          </button>
          <button
            type="button"
            onClick={advance}
            className="flex items-center gap-1 px-2 py-1 rounded border border-purple-500/30 bg-purple-500/10 text-purple-200 hover:bg-purple-500/20 text-[9px] font-black uppercase tracking-widest transition-colors outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60"
          >
            {isLast ? 'Finish' : 'Next'}
            {!isLast && <ChevronRight className="w-3 h-3" />}
          </button>
          <button
            type="button"
            onClick={skip}
            className="ml-auto text-[9px] font-mono uppercase tracking-widest text-zinc-500 hover:text-zinc-300 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60 rounded px-1"
          >
            Skip tour
          </button>
        </div>

        {/* Never show again */}
        <label
          htmlFor="tour-never-show"
          className="flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-widest text-zinc-600 cursor-pointer select-none"
        >
          <input
            type="checkbox"
            id="tour-never-show"
            name="tour-never-show"
            onChange={(e) => {
              if (e.target.checked) neverShowAgain();
            }}
            className="w-3 h-3 accent-purple-500"
          />
          Never show again
        </label>
      </div>
    </div>,
    document.body,
  );
};
