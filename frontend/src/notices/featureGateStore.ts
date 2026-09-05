/**
 * Feature-gate notice store.
 *
 * Central queue for "this capability is missing" notices: a disabled backend
 * module, a model that is not downloaded, or a missing Hugging Face sign-in.
 * Call sites raise a notice via `requireFeature(...)` at the moment a gated
 * capability is hit; the shell renders the queue with <FeatureGateNotices />
 * (bottom-right stack). Notices are deduped by id so repeated hits refresh
 * the existing card instead of stacking duplicates.
 *
 * Two further kinds ride the same stack so a long-running fix and a failed
 * save land where the user is already looking:
 *   - 'progress' — something is being brought up on the user's behalf (the
 *     Magenta engine start, ~2-3 min); the message is updated in place.
 *   - 'error'    — a save or action failed and was rolled back; carries a
 *     Retry action. 'success' is its quiet counterpart, auto-dismissed.
 */
import { create } from 'zustand';
import { logWarn } from '../state/logStore';

export type FeatureGateKind = 'module' | 'model' | 'hf' | 'progress' | 'error' | 'success';

export interface FeatureGateAction {
  /** Button label, e.g. "Enable in Settings". */
  label: string;
  /** Runs on click; the card dismisses itself when this resolves. */
  run: () => Promise<void> | void;
}

export interface FeatureGateNotice {
  /** Stable dedupe key, e.g. "module:vst" or "hf:gated-model". */
  id: string;
  title: string;
  /** One-line explanation shown under the title. */
  message: string;
  kind: FeatureGateKind;
  /** Optional primary action rendered as a button on the card. */
  action?: FeatureGateAction;
  /** Optional micro-hint pointing at docs, shown under the message. */
  docsHint?: string;
  /** Dismiss on its own after this many ms (success toasts). */
  autoDismissMs?: number;
}

interface FeatureGateState {
  notices: FeatureGateNotice[];
  /** Raise a notice; if one with the same id exists its content is refreshed in place. */
  notifyFeatureGate: (notice: FeatureGateNotice) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

const autoTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useFeatureGateStore = create<FeatureGateState>()((set, get) => ({
  notices: [],

  notifyFeatureGate: (notice) => {
    // Mirror first-time gates into the LOG dock so a dismissed card stays
    // traceable; refreshes of an already-visible notice stay quiet. Progress
    // and success notices are not warnings.
    const isNew = !get().notices.some((n) => n.id === notice.id);
    if (isNew && notice.kind !== 'progress' && notice.kind !== 'success') {
      logWarn('gate', `${notice.title}: ${notice.message}`);
    }
    set((s) => {
      const idx = s.notices.findIndex((n) => n.id === notice.id);
      if (idx >= 0) {
        const next = s.notices.slice();
        next[idx] = notice;
        return { notices: next };
      }
      return { notices: [...s.notices, notice] };
    });
    const pending = autoTimers.get(notice.id);
    if (pending) {
      clearTimeout(pending);
      autoTimers.delete(notice.id);
    }
    if (notice.autoDismissMs && notice.autoDismissMs > 0) {
      autoTimers.set(
        notice.id,
        setTimeout(() => {
          autoTimers.delete(notice.id);
          get().dismiss(notice.id);
        }, notice.autoDismissMs),
      );
    }
  },

  dismiss: (id) => {
    const pending = autoTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      autoTimers.delete(id);
    }
    set((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
  },

  clear: () => {
    autoTimers.forEach((t) => clearTimeout(t));
    autoTimers.clear();
    set({ notices: [] });
  },
}));

/**
 * Convenience gate for call sites. Raises (or refreshes) the notice and
 * returns `false` so a missing capability can be handled in one line:
 *
 *   if (!vstModule?.enabled) {
 *     return requireFeature({
 *       id: 'module:vst',
 *       kind: 'module',
 *       title: 'VST module disabled',
 *       message: 'Enable the VST module to process plugins.',
 *       action: { label: 'Enable in Settings', run: () => openSettings() },
 *     });
 *   }
 */
export const requireFeature = (opts: FeatureGateNotice): false => {
  useFeatureGateStore.getState().notifyFeatureGate(opts);
  return false;
};

/** Dismiss a notice by id from anywhere (no hook needed). */
export const dismissFeatureGate = (id: string): void => {
  useFeatureGateStore.getState().dismiss(id);
};
