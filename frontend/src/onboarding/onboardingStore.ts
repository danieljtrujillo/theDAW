/**
 * First-run feature-tour state.
 *
 * `seen` and `neverShow` persist to localStorage so the tour auto-starts only
 * on a genuine first run; `active` and `stepIndex` are per-session (the tour is
 * never mid-run on a fresh app open). The step count lives in tourSteps.tsx —
 * this store keeps `next()` unbounded and the <OnboardingTour> component calls
 * `finish()` when it detects the last step, so the store never imports the step
 * list (no module cycle).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface OnboardingState {
  /** The tour has been completed, skipped, or dismissed at least once. */
  seen: boolean;
  /** The user opted out permanently ("Never show again"). */
  neverShow: boolean;
  /** The tour overlay is currently showing. */
  active: boolean;
  stepIndex: number;
  /** Begin the tour from the first step (used by auto-start and the menu). */
  start: () => void;
  /** Advance one step (component clamps/finishes at the end). */
  next: () => void;
  /** Step back one (clamped at the first step). */
  back: () => void;
  /** Jump directly to a step. */
  goTo: (index: number) => void;
  /** Close the tour, remembering it was seen. */
  skip: () => void;
  /** Close the tour and never auto-start it again. */
  neverShowAgain: () => void;
  /** Mark complete (reached the end) — same persistence as skip. */
  finish: () => void;
  /** Clear the seen/neverShow flags so it can auto-start again. */
  reset: () => void;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      seen: false,
      neverShow: false,
      active: false,
      stepIndex: 0,
      start: () => set({ active: true, stepIndex: 0 }),
      next: () => set((s) => ({ stepIndex: s.stepIndex + 1 })),
      back: () => set((s) => ({ stepIndex: Math.max(0, s.stepIndex - 1) })),
      goTo: (index) => set({ stepIndex: Math.max(0, index) }),
      skip: () => set({ active: false, seen: true }),
      neverShowAgain: () => set({ active: false, seen: true, neverShow: true }),
      finish: () => set({ active: false, seen: true }),
      reset: () => set({ seen: false, neverShow: false, active: false, stepIndex: 0 }),
    }),
    {
      name: 'thedaw-onboarding',
      // Only the "should it ever auto-start" flags persist.
      partialize: (s) => ({ seen: s.seen, neverShow: s.neverShow }),
    },
  ),
);

/** Whether the tour should auto-start on this app open (genuine first run). */
export const shouldAutoStart = (): boolean => {
  const s = useOnboardingStore.getState();
  return !s.seen && !s.neverShow;
};
