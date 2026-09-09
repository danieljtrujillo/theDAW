/**
 * Feature Notes: small persistent labels pinned to the UI affordances that are
 * genuinely hard to find.
 *
 * This exists because of a real bug report: someone spent a long time hunting
 * for the Library, read the docs, asked the assistant, and only found it by
 * eventually noticing the slim tab on the right edge. The feature tour did not
 * save them — a tour is a sequence you click through once and it is gone, so it
 * teaches nothing about the affordance you meet three sessions later. A note
 * stays pinned to the thing until you have actually used it.
 *
 * Two rules keep them from becoming clutter:
 *   1. A note is only for something with NO visible label of its own. If the
 *      control says what it is, it does not get a note.
 *   2. A note retires itself the moment the feature is used (`learned`), so the
 *      app stops pointing at something you have already found. Closing one by
 *      hand does the same thing permanently.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type NotePlacement = 'left' | 'right' | 'top' | 'bottom';

export interface FeatureNoteDef {
  id: string;
  /** The name of the thing being pointed at, as the user would say it. */
  label: string;
  /** One short line: what it is and how to open it. Not documentation. */
  body: string;
  /** The element the note points at. */
  target: string;
  /** Which side of the target the note sits on. */
  placement: NotePlacement;
  /**
   * True once the user has demonstrably found the feature, which retires the
   * note for good. Read from live app state, never from the DOM.
   */
  learned?: () => boolean;
}

/** Marks an element as a feature-note target: `data-feature-note="library"`. */
export const noteTarget = (id: string): Record<string, string> => ({ 'data-feature-note': id });

export const NOTE_TARGET_SELECTOR = (id: string): string => `[data-feature-note="${id}"]`;

interface FeatureNoteState {
  /** Ids retired by hand or by use. */
  dismissed: string[];
  /** Master switch, so the notes can be turned off (and back on) wholesale. */
  enabled: boolean;
  dismiss: (id: string) => void;
  isDismissed: (id: string) => boolean;
  setEnabled: (v: boolean) => void;
  /** Bring every note back — the "show me the hidden bits again" path. */
  resetAll: () => void;
}

export const useFeatureNoteStore = create<FeatureNoteState>()(
  persist(
    (set, get) => ({
      dismissed: [],
      enabled: true,
      dismiss: (id) =>
        set((s) => (s.dismissed.includes(id) ? s : { dismissed: [...s.dismissed, id] })),
      isDismissed: (id) => get().dismissed.includes(id),
      setEnabled: (v) => set({ enabled: v }),
      resetAll: () => set({ dismissed: [], enabled: true }),
    }),
    {
      name: 'thedaw-feature-notes',
      partialize: (s) => ({ dismissed: s.dismissed, enabled: s.enabled }),
    },
  ),
);
