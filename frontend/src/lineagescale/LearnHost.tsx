import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { fetchLineageSummaryProbe, type LineageSummary, type SummaryProbe } from './lineageScaleClient';
import { formatCount } from './lineageScaleModel';

/**
 * LearnHost — the LEARN tab, hosting BOTH lineage views.
 *
 * The classic graph (`LineageModal`'s `LineageView`) draws every song in the
 * library at once. On a small library that is the right picture and nothing
 * here changes it. On the library this host was written against it was
 * 194,833 nodes, 475,174 links and a 128 MB answer, and the page died. So past
 * the backend's limit the scale view opens by default and the classic view is
 * NOT MOUNTED until the user asks for it, because mounting it is what fires
 * the request.
 * The Classic tab stays on screen, disabled, with the warning and an "Open
 * anyway" key beside it: the 2,000 limit is a threshold, not a measurement of
 * where the drawing fails, and a view that works on this library stays
 * reachable.
 *
 * Which view opens by default is the backend's call: `/summary`'s
 * `full_view_ok` (with_lineage <= `full_view_limit`, 2,000). A backend that does not have this
 * module at all answers 404 — an older build — and that falls back to exactly
 * the old behaviour, the classic view, with nothing alarming shown.
 *
 * ONLY a 404 means that. Any other failure — a 500, a 503 while the library is
 * still opening, a dropped request — leaves the library's size unknown. The
 * scale view opens, the failure is said with a Retry, and the Classic tab is
 * enabled with a warning that the size is unknown: not knowing the size is a
 * reason to say so, not to take the view away. Only a pick made on this mount
 * opens the classic view then; a choice remembered from before a reload does
 * not, because a reload is how a user leaves a drawing that stopped
 * responding, and a 503 while the library opens must not put them back in it.
 *
 * The props are the ones `DAWCenterPanel` already passes to `LineageView`, so
 * mounting this instead is a one-line change at the import.
 */

export type LearnMode = 'scale' | 'classic';

/** The props both hosted views take — and the ones this host is given. */
export interface LearnViewProps {
  rootEntryId?: string | null;
  visible?: boolean;
}

const CHOICE_KEY = 'thedaw.learnMode';

/* ─────────────────────────────── the decision ────────────────────────────── */

/** The limit the warning quotes when `/summary` does not send
 *  `full_view_limit` (a backend older than that field). The backend's own
 *  number, when sent, is the one that decided, so it is the one quoted. */
export const FULL_VIEW_LIMIT = 2000;

export interface LearnDecision {
  mode: LearnMode;
  /** False while the Classic tab waits behind "Open anyway". */
  classicAllowed: boolean;
  /** The warning about the classic view, in the library's real numbers. ''
   *  when there is nothing to warn about. */
  reason: string;
  /** The Classic tab is disabled and "Open anyway" mounts it. */
  canOpenAnyway: boolean;
}

/**
 * Why `with_lineage`: the classic view draws the songs that HAVE relationships
 * — that is the drawing that grows with the library — and it is the number the
 * backend already counts for `full_view_ok`.
 */
export const classicUnavailableReason = (summary: LineageSummary): string =>
  `The classic graph draws every song at once. This library has ${formatCount(summary.with_lineage)} connected songs, past the ${formatCount(summary.full_view_limit ?? FULL_VIEW_LIMIT)} where LEARN opens the scale view instead, so the classic graph may be slow or stop responding.`;

/** The warning when the summary could not be read at all. */
export const classicUnknownSizeReason =
  'The lineage summary could not be read, so this library’s size is unknown. The classic graph draws every song at once and may be slow or stop responding on a large library.';

/**
 * Which view to open, once the summary has been asked for. The caller shows
 * its own loading state until then and mounts NEITHER view, because rendering
 * the classic one is what starts the whole-library request.
 *
 *  * `failed` — the route answered something other than 404. The size is
 *    unknown: the scale view opens unless the user picked the classic one on
 *    this mount (`picked`; `remembered` alone does not count), and the
 *    Classic tab is enabled with the unknown-size warning.
 *  * `summary === null` and not `failed` — a 404: a backend that predates this
 *    module. That is the classic view, exactly what this tab did before, with
 *    nothing alarming said.
 *  * `full_view_ok` → the classic view by default, so a small library sees no
 *    change at all. The user may switch, and that choice is remembered.
 *  * not `full_view_ok` → the scale view by default, and the Classic tab waits
 *    behind "Open anyway" with the warning. `openedAnyway` is that press: it
 *    lasts while the tab is mounted, so a reload opens the scale view again,
 *    and a remembered choice alone never mounts the classic view here.
 */
export function decideLearnMode(
  summary: LineageSummary | null,
  remembered: LearnMode | null,
  failed = false,
  openedAnyway = false,
  picked: LearnMode | null = null,
): LearnDecision {
  if (failed) {
    return { mode: picked ?? 'scale', classicAllowed: true, reason: classicUnknownSizeReason, canOpenAnyway: false };
  }
  if (!summary) return { mode: 'classic', classicAllowed: true, reason: '', canOpenAnyway: false };
  if (!summary.full_view_ok) {
    const reason = classicUnavailableReason(summary);
    return openedAnyway
      ? { mode: 'classic', classicAllowed: true, reason, canOpenAnyway: false }
      : { mode: 'scale', classicAllowed: false, reason, canOpenAnyway: true };
  }
  return { mode: remembered ?? 'classic', classicAllowed: true, reason: '', canOpenAnyway: false };
}

/* ────────────────────── what one summary probe settles ───────────────────── */

/**
 * Everything one attempt at `/summary` leaves behind, as a single value.
 *
 * Why it is a value and not three `useState` calls updated inline: the two
 * interesting transitions — a probe that REJECTED, and the re-arm behind the
 * Retry button — used to live inside an effect and a callback, where a render
 * test cannot reach them (`renderToStaticMarkup` runs no effects). As plain
 * functions they are checked directly, and the host below is only the wiring.
 */
export interface SummaryReadState {
  /** What the route said, or null when there was none (a 404, or a failure). */
  summary: LineageSummary | null;
  /** The message from a failure that was NOT a 404, or null. */
  failure: string | null;
  /** Has an attempt finished, either way? */
  read: boolean;
}

/** Nothing asked yet — and what a Retry goes back to. */
export const UNREAD_SUMMARY: SummaryReadState = {
  summary: null,
  failure: null,
  read: false,
};

/**
 * A probe that RESOLVED. `absent` is a 404: an older backend has no such
 * route, which is not an error the user needs to see, so no failure is carried
 * and `decideLearnMode` reads it as today's behaviour.
 */
export const summaryFromProbe = (probe: SummaryProbe): SummaryReadState => ({
  summary: probe.kind === 'ok' ? probe.summary : null,
  failure: null,
  read: true,
});

/**
 * A probe that REJECTED — anything but a 404. The library's size is unknown,
 * so the failure is carried and the classic view is never mounted on a guess.
 */
export const summaryFromFailure = (error: unknown): SummaryReadState => ({
  summary: null,
  failure: error instanceof Error ? error.message : String(error),
  read: true,
});

/**
 * Retry: drop the banner and set `read` back to false, which is the only gate
 * `shouldReadSummary` has, so the request goes out again. Whatever summary was
 * already read is kept — there is no second attempt counter to hold in step.
 */
export const summaryRearmed = (prev: SummaryReadState): SummaryReadState => ({
  ...prev,
  failure: null,
  read: false,
});

/* ───────────────────────────── remembered choice ─────────────────────────── */

const isMode = (v: unknown): v is LearnMode => v === 'scale' || v === 'classic';

/** The session's choice, or null. Storage can be absent or throw (private
 *  browsing, a non-browser host); a missing preference is not an error. */
export function rememberedMode(): LearnMode | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(CHOICE_KEY);
    return isMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function rememberMode(mode: LearnMode): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(CHOICE_KEY, mode);
  } catch {
    /* nothing to do: the choice simply does not outlive this mount */
  }
}

/* ──────────────────────────────── the chrome ─────────────────────────────── */

const REASON_ID = 'lineage-scale-classic-unavailable';

export interface LearnSwitchProps {
  mode: LearnMode;
  classicAllowed: boolean;
  reason: string;
  onSelect: (mode: LearnMode) => void;
  /** Present when the Classic tab is disabled behind "Open anyway". */
  onOpenAnyway?: () => void;
}

const TAB_BASE = 'px-2 py-1 rounded text-xs font-bold border';
const TAB_ON = 'bg-purple-500/20 text-purple-200 border-purple-400/50';
const TAB_OFF = 'bg-black/40 text-zinc-400 border-white/10 hover:text-zinc-200';
const TAB_DEAD = 'bg-black/40 text-zinc-600 border-white/5 cursor-not-allowed';
const ANYWAY =
  'shrink-0 rounded border border-amber-400/40 px-2 py-1 text-xs font-bold text-amber-100 hover:border-amber-300/70 hover:text-white';

/**
 * The two-option switch. The warning is shown whenever there is one, and it
 * describes both the disabled Classic tab and the "Open anyway" key that
 * mounts it.
 */
export const LearnSwitch: React.FC<LearnSwitchProps> = ({
  mode, classicAllowed, reason, onSelect, onOpenAnyway,
}) => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-white/10 px-2 py-1">
    <div role="group" aria-label="Lineage view" className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onSelect('scale')}
        aria-pressed={mode === 'scale'}
        className={`${TAB_BASE} ${mode === 'scale' ? TAB_ON : TAB_OFF}`}
      >
        Lineage
      </button>
      <button
        type="button"
        onClick={() => onSelect('classic')}
        aria-pressed={mode === 'classic'}
        disabled={!classicAllowed}
        aria-describedby={reason ? REASON_ID : undefined}
        className={`${TAB_BASE} ${
          !classicAllowed ? TAB_DEAD : mode === 'classic' ? TAB_ON : TAB_OFF
        }`}
      >
        Classic graph
      </button>
    </div>
    {reason && (
      <p id={REASON_ID} className="min-w-0 flex-1 text-xs font-bold text-zinc-400">
        {reason}
      </p>
    )}
    {!classicAllowed && onOpenAnyway && (
      <button type="button" onClick={onOpenAnyway} aria-describedby={REASON_ID} className={ANYWAY}>
        Open anyway
      </button>
    )}
  </div>
);

/* ──────────────────────────────── the host ───────────────────────────────── */

/** The new view. Loaded on demand, like every other tab body. */
const DefaultScaleView = lazy(() => import('./LineageScaleView'));

/**
 * The EXISTING view, untouched and rendered with the props it gets today.
 * `lazy` is what keeps the promise in this file's header: the module — and the
 * whole-library request its mount makes — is not even fetched until the classic
 * pane is actually placed in the tree.
 */
const DefaultClassicView = lazy(() =>
  import('../components/library/LineageModal').then((m) => ({ default: m.LineageView })),
);

const Waiting: React.FC<{ what: string }> = ({ what }) => (
  <p className="absolute inset-0 flex items-center justify-center text-xs font-bold text-zinc-500">
    {what}
  </p>
);

/** The summary is read ONCE, and only for a tab the user is looking at. */
export const shouldReadSummary = (visible: boolean, alreadyRead: boolean): boolean =>
  visible && !alreadyRead;

export interface LearnHostSurfaceProps extends LearnViewProps {
  /** Has the summary request finished (either way)? */
  read: boolean;
  /** What it said, or null when there was none (a 404, or a failure). */
  summary: LineageSummary | null;
  /**
   * The message from a failure that was NOT a 404, or null. Set means the
   * library's size is unknown: the classic view is offered with a warning and
   * mounts only when the user picks it.
   */
  failure?: string | null;
  /** Ask for the summary again after a failure. */
  onRetry?: () => void;
  /** The session's remembered choice, if any. */
  chosen: LearnMode | null;
  /** The choice made since this host mounted, if any. */
  picked?: LearnMode | null;
  onSelect: (mode: LearnMode) => void;
  /** The user pressed "Open anyway" past the limit. */
  openedAnyway?: boolean;
  onOpenAnyway?: () => void;
  /** Swapped in tests, so a render test never pulls in either real view. */
  scaleView?: React.ComponentType<LearnViewProps>;
  classicView?: React.ComponentType<LearnViewProps>;
}

/**
 * Everything the host DOES, as a function of what it knows — so every state it
 * can be in is a render test and not a browser. `LearnHost` adds only the two
 * pieces of state and the one request that produce these props.
 *
 * The classic pane is not merely hidden when it is not the mode: the element is
 * never constructed, so neither the lazy import nor the mount that fires the
 * whole-library request can happen until the user picks it.
 */
export const LearnHostSurface: React.FC<LearnHostSurfaceProps> = ({
  read, summary, failure = null, onRetry, chosen, picked = null, onSelect, openedAnyway = false, onOpenAnyway,
  rootEntryId = null, visible = true, scaleView, classicView,
}) => {
  const decision = decideLearnMode(summary, chosen, failure !== null, openedAnyway, picked);
  const Scale = scaleView ?? DefaultScaleView;
  const Classic = classicView ?? DefaultClassicView;

  // Until the answer is in there is no choice to show and, above all, no
  // classic view to mount.
  if (!read) {
    return (
      <div className="relative h-full w-full bg-black/20">
        <Waiting what={visible ? 'Reading this library’s lineage…' : ''} />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-black/20">
      <LearnSwitch
        mode={decision.mode}
        classicAllowed={decision.classicAllowed}
        reason={decision.reason}
        onSelect={onSelect}
        onOpenAnyway={decision.canOpenAnyway ? onOpenAnyway : undefined}
      />
      {failure !== null && (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-amber-400/30 bg-amber-500/10 px-2 py-1"
        >
          <p className="min-w-0 grow truncate text-xs font-bold text-amber-200">
            {`Could not read this library’s lineage summary: ${failure}`}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded border border-amber-400/40 px-2 py-0.5 text-xs font-bold text-amber-100 hover:border-amber-300/70 hover:text-white"
          >
            Retry
          </button>
        </div>
      )}
      <div className="relative min-h-0 grow">
        <Suspense fallback={<Waiting what="Loading…" />}>
          {decision.mode === 'classic'
            ? <Classic rootEntryId={rootEntryId} visible={visible} />
            : <Scale rootEntryId={rootEntryId} visible={visible} />}
        </Suspense>
      </div>
    </div>
  );
};

export interface LearnHostProps extends LearnViewProps {
  /**
   * Swapped in tests. The default reads `/api/lineage-scale/summary` and
   * reports `{kind: 'absent'}` for a 404 ONLY; anything else it rejects with,
   * which is what keeps an unknown library on the scale view by default.
   */
  loadSummary?: () => Promise<SummaryProbe>;
  scaleView?: React.ComponentType<LearnViewProps>;
  classicView?: React.ComponentType<LearnViewProps>;
}

export const LearnHost: React.FC<LearnHostProps> = ({
  rootEntryId = null,
  visible = true,
  loadSummary,
  scaleView,
  classicView,
}) => {
  const [state, setState] = useState<SummaryReadState>(UNREAD_SUMMARY);
  const [chosen, setChosen] = useState<LearnMode | null>(() => rememberedMode());
  // The pick made on this mount, which is all a failed summary honours.
  const [picked, setPicked] = useState<LearnMode | null>(null);
  // "Open anyway" past the limit. Held here, not in storage: the tab stays
  // mounted while theDAW runs, so the press lasts across tab switches, and a
  // reload (the way out of a drawing that stopped responding) opens the scale
  // view again.
  const [openedAnyway, setOpenedAnyway] = useState(false);
  const { summary, failure, read } = state;

  useEffect(() => {
    if (!shouldReadSummary(visible, read)) return undefined;
    let live = true;
    (loadSummary ?? fetchLineageSummaryProbe)()
      .then((probe) => {
        if (!live) return;
        setState(summaryFromProbe(probe));
      })
      .catch((e: unknown) => {
        if (!live) return;
        setState(summaryFromFailure(e));
      });
    return () => {
      live = false;
    };
  }, [visible, read, loadSummary]);

  const onSelect = useCallback((mode: LearnMode) => {
    setChosen(mode);
    setPicked(mode);
    rememberMode(mode);
    // Going back to the scale view puts the Classic tab behind "Open anyway"
    // again; picking Classic keeps a press that is already in effect.
    if (mode === 'scale') setOpenedAnyway(false);
  }, []);

  const onOpenAnyway = useCallback(() => setOpenedAnyway(true), []);

  const onRetry = useCallback(() => setState(summaryRearmed), []);

  return (
    <LearnHostSurface
      read={read}
      summary={summary}
      failure={failure}
      onRetry={onRetry}
      chosen={chosen}
      picked={picked}
      onSelect={onSelect}
      openedAnyway={openedAnyway}
      onOpenAnyway={onOpenAnyway}
      rootEntryId={rootEntryId}
      visible={visible}
      scaleView={scaleView}
      classicView={classicView}
    />
  );
};

/**
 * The name `DAWCenterPanel` mounts the LEARN tab under. Exported so the tab's
 * lazy import can name it, and as the default so it can skip the `.then`.
 */
export const LineageView = LearnHost;

export default LearnHost;
