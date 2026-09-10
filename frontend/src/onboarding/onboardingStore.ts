/**
 * First-run feature-tour state.
 *
 * `seen`, `neverShow` and `completedChapters` persist to localStorage — the
 * first two so the tour auto-starts only on a genuine first run, the third so a
 * tour taken a chapter at a time can show you what you already walked. `active`
 * and `stepIndex` are per-session: the cursor is never mid-run on a fresh app
 * open, and a chapter is short enough to retake.
 *
 * The step list lives in tourSteps.tsx and this store never imports it (no
 * module cycle). So `next()` is unbounded and the <OnboardingTour> component
 * calls `finish()` when it detects the last step; for the same reason a chapter
 * is just a string here — the component knows which step ends which chapter and
 * says so by calling `markChapterDone`.
 *
 * The solo spotlight rides alongside rather than inside the tour, because every
 * tour exit sets `seen` — putting one control under the light must not be able
 * to suppress somebody's genuine first run. It holds an id, not a step, for the
 * same no-cycle reason: the overlay resolves it through the feature registry.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface OnboardingState {
  /** The tour has been completed, skipped, or dismissed at least once. */
  seen: boolean;
  /** The user opted out permanently ("Never show again"). */
  neverShow: boolean;
  /** Chapter ids walked all the way to their last step. Ticked in the picker. */
  completedChapters: string[];
  /** The tour overlay is currently showing. */
  active: boolean;
  stepIndex: number;
  /**
   * Feature-registry id under a one-off spotlight, or null. Session-only, like
   * `active` — a spotlight is never mid-run on a fresh app open.
   */
  soloFeatureId: string | null;
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
  /** Remember a chapter was finished. Ids come from the component, not from here. */
  markChapterDone: (chapterId: string) => void;
  /** Put the spotlight on one feature by registry id. Never touches `seen`. */
  spotlightOne: (featureId: string) => void;
  /** Take it away again. Never touches `seen`. */
  endSpotlight: () => void;
  /** Clear the seen/neverShow flags so it can auto-start again. */
  reset: () => void;
}

export const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      seen: false,
      neverShow: false,
      completedChapters: [],
      active: false,
      stepIndex: 0,
      soloFeatureId: null,
      // A tour always wins over a stray spotlight, so starting one drops it.
      start: () => set({ active: true, stepIndex: 0, soloFeatureId: null }),
      next: () => set((s) => ({ stepIndex: s.stepIndex + 1 })),
      back: () => set((s) => ({ stepIndex: Math.max(0, s.stepIndex - 1) })),
      goTo: (index) => set({ stepIndex: Math.max(0, index) }),
      skip: () => set({ active: false, seen: true }),
      neverShowAgain: () => set({ active: false, seen: true, neverShow: true }),
      finish: () => set({ active: false, seen: true }),
      markChapterDone: (chapterId) =>
        set((s) =>
          s.completedChapters.includes(chapterId)
            ? s
            : { completedChapters: [...s.completedChapters, chapterId] },
        ),
      spotlightOne: (featureId) => set({ soloFeatureId: featureId }),
      endSpotlight: () => set({ soloFeatureId: null }),
      reset: () =>
        set({
          seen: false,
          neverShow: false,
          completedChapters: [],
          active: false,
          stepIndex: 0,
          soloFeatureId: null,
        }),
    }),
    {
      name: 'thedaw-onboarding',
      // The "should it ever auto-start" flags, plus which chapters are behind
      // you. The cursor deliberately does not persist — see the docstring.
      partialize: (s) => ({
        seen: s.seen,
        neverShow: s.neverShow,
        completedChapters: s.completedChapters,
      }),
    },
  ),
);

/** Whether the tour should auto-start on this app open (genuine first run). */
export const shouldAutoStart = (): boolean => {
  const s = useOnboardingStore.getState();
  return !s.seen && !s.neverShow;
};
