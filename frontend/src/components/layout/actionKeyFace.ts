/**
 * What the footer's workspace action key shows: its glyph, its one-word legend,
 * its accessible name, whether it is latched, busy or carrying progress, and
 * CREATE's stage caption. Pure, so every face can be replayed in a test without
 * React or the stores; LogActionButton (ProcessingLog.tsx) renders it and owns
 * the handlers.
 */

import type { TrainingLink } from '../../state/underfitRunsStore';

export type ActionKind = 'create' | 'edit' | 'train' | 'mix' | 'dj';
export type ActionGlyph = 'create' | 'process' | 'train' | 'stop' | 'chain' | 'send';

/** The Underfit dashboard run the UNDERFIT key can stop (underfitRunsStore). */
export interface TrainingRunFace {
  name: string;
  /** How many other runs are live besides this one; they keep training. */
  others: number;
  /** Its kill request is out. */
  stopping: boolean;
}

export interface ActionKeyInput {
  centerTab: string;
  model: string;
  isGenerating: boolean;
  progressPct: number;
  statusLabel: string;
  /**
   * A Suno submit is in flight (sunoStore.submitting). generateStore never
   * claims `isGenerating` for it (CREATE routes Suno to sunoStore.submit, not
   * a Stable Audio job it could poll or cancel), so this is the only signal
   * the key has for it — and unlike isGenerating, a press cannot cancel it,
   * so it renders busy, not STOP.
   */
  sunoSubmitting: boolean;
  isProcessing: boolean;
  isChainProcessing: boolean;
  /** The newest live Underfit dashboard run, or null when none is live. */
  trainingRun: TrainingRunFace | null;
  /** How the key reaches the dashboard's runs (underfitRunsStore.link). */
  trainingLink: TrainingLink;
  /**
   * The most recent run of any status, whose settings a press repeats, or null
   * when the dashboard has no runs and the first one has to come from its form.
   */
  lastRunName: string | null;
  /** A start request is out (underfitRunsStore.starting). */
  startingRun: boolean;
  /** A mounted VJ tab will take the set now (read on the DJ tab only). */
  vjTargetActive: boolean;
}

/** `pending`: a live run with no measured progress; `fill`: the run's percentage. */
export type ActionProgress = { kind: 'pending' } | { kind: 'fill'; pct: number };

/**
 * How a caption reads: `running` is a stage still under way (a pre-flight stage,
 * or CANCELLING... while a stopped job winds down), `failed` a run that did not
 * start or did not finish, `complete` a finished run, `stopped` a run the user
 * stopped (STOPPED and CANCELLED) or one that ended with no outcome of its own.
 */
export type CaptionTone = 'running' | 'failed' | 'stopped' | 'complete';

export interface ActionCaption {
  text: string;
  tone: CaptionTone;
}

export interface ActionKeyFace {
  kind: ActionKind;
  glyph: ActionGlyph;
  legend: string;
  /**
   * The key's aria-label and title. It starts with the legend's word
   * (label-in-name) and holds still while a run ticks: the percentage travels
   * in `progressText` and the stage in `caption`.
   */
  label: string;
  /** The measured progress for a screen reader, as the key's description ("42% done"). */
  progressText: string | null;
  /** CREATE's stage or last outcome, printed over the key in a polite live region. */
  caption: ActionCaption | null;
  /** Latched: the key's own run is live. The ON ink and the accent bottom edge. */
  on: boolean;
  /**
   * Busy: presses do nothing (the key is aria-disabled and keeps focus). Either
   * its own run is rendering or stopping and cannot be pressed again (latched),
   * or the key has nothing to start from the footer (not latched: the ink dims,
   * and the label says why: the studio is running the other workspace's
   * process, or UNDERFIT's runs start in the dashboard).
   */
  disabled: boolean;
  progress: ActionProgress | null;
}

/**
 * The workspace decides the action: DJ sends the set, MIX runs the effect chain,
 * EDIT processes, UNDERFIT trains, every other tab creates. Keyed on centerTab,
 * the state the tab bar writes, never the legacy activeView.
 */
export function actionKind(centerTab: string): ActionKind {
  if (centerTab === 'dj') return 'dj';
  if (centerTab === 'mix') return 'mix';
  if (centerTab === 'edit') return 'edit';
  if (centerTab === 'underfit') return 'train';
  return 'create';
}

/** The outcomes that mean a CREATE did not start or did not finish (generateStore). */
const FAILED_OUTCOMES = new Set(['PROMPT REQUIRED', 'NO USABLE MODEL', 'FAILED', 'SERVER RESET', 'CHIMERA FAILED']);

/**
 * The caption over the CREATE key, from generateStore's statusLabel. While a run
 * is live it names the pre-flight (SUBMITTING JOB / RENDERING CHIMERA / CHECKING
 * MODELS / QUEUED / HEALING SEAMS); idle it holds the last outcome until the next
 * press (PROMPT REQUIRED / NO USABLE MODEL / FAILED / SERVER RESET / CHIMERA
 * FAILED / STOPPED / CANCELLING / CANCELLED / COMPLETE). READY and IDLE print
 * nothing, and neither does the sampler's SAMPLING n/m, whose progress the key
 * already prints.
 */
export function generationCaption(statusLabel: string, isGenerating: boolean): ActionCaption | null {
  if (statusLabel === 'READY' || statusLabel === 'IDLE' || statusLabel.startsWith('SAMPLING')) return null;
  // CANCELLING... is the stopped job still winding down on the backend.
  if (isGenerating || statusLabel === 'CANCELLING...') return { text: statusLabel, tone: 'running' };
  if (FAILED_OUTCOMES.has(statusLabel)) return { text: statusLabel, tone: 'failed' };
  if (statusLabel === 'COMPLETE') return { text: statusLabel, tone: 'complete' };
  return { text: statusLabel, tone: 'stopped' };
}

/** UNDERFIT's key with nothing to repeat: where the first run comes from, and why. */
export const TRAIN_REST: Record<TrainingLink, string> = {
  ok: 'Train: set up the first run in the Underfit dashboard above; this key then repeats it and stops it while it trains',
  'dashboard-down': 'Train: the Underfit dashboard is not answering; start it from the tab above',
  'backend-old': 'Train: restart the backend so this key can start and stop runs',
};

const clampPct = (pct: number): number => (Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0);

const PENDING: ActionProgress = { kind: 'pending' };

export function actionKeyFace(s: ActionKeyInput): ActionKeyFace {
  const kind = actionKind(s.centerTab);
  const rest = { kind, on: false, disabled: false, progress: null, progressText: null, caption: null };
  switch (kind) {
    case 'dj':
      return {
        ...rest,
        glyph: 'send',
        legend: 'SEND',
        label: s.vjTargetActive
          ? 'Send the active setlist to the VJ performance'
          : 'Send the active setlist to the VJ: it is queued and delivers when the VJ tab opens',
      };
    case 'mix': {
      // studioStore runs one process at a time: CHAIN is busy while its chain
      // renders (no measured progress, so the foot pulses) and waits while
      // EDIT's process renders. During a chain run isProcessing flickers per
      // stage, so the chain's own flag decides first.
      const face = { ...rest, glyph: 'chain' as const, legend: 'CHAIN' };
      if (s.isChainProcessing) return { ...face, label: 'Chain: processing the effect chain…', on: true, disabled: true, progress: PENDING };
      if (s.isProcessing) return { ...face, label: 'Chain: waiting for the EDIT process to finish', disabled: true };
      return { ...face, label: 'Chain: process the effect chain over the source audio' };
    }
    case 'edit': {
      // The same one-run rule from EDIT's side: PROCESS is busy while its
      // process renders, and waits while MIX's chain renders.
      const face = { ...rest, glyph: 'process' as const, legend: 'PROCESS' };
      if (s.isChainProcessing) return { ...face, label: 'Process audio: waiting for the MIX chain to finish', disabled: true };
      if (s.isProcessing) return { ...face, label: 'Process audio: processing…', on: true, disabled: true, progress: PENDING };
      return { ...face, label: 'Process audio' };
    }
    case 'train': {
      // UNDERFIT's runs are the Underfit dashboard's (the tab embeds it). While
      // one is live the key is STOP and kills its process
      // (underfitRunsStore.stopRun). With none live it is TRAIN and repeats the
      // most recent run's settings under a fresh name
      // (underfitRunsStore.trainAgain) — the first run of all still comes from
      // the dashboard's form, which is where a dataset and a base model are
      // chosen, so with no run to repeat the key rests dimmed and says so.
      const run = s.trainingRun;
      if (run) {
        const others = run.others > 0 ? `; ${run.others} other ${run.others === 1 ? 'run keeps' : 'runs keep'} training` : '';
        return {
          ...rest,
          glyph: 'stop',
          legend: 'STOP',
          label: run.stopping
            ? `Stop the Underfit training run "${run.name}": stopping…`
            : `Stop the Underfit training run "${run.name}"${others}`,
          on: true,
          disabled: run.stopping,
          progress: PENDING,
        };
      }
      const face = { ...rest, glyph: 'train' as const, legend: 'TRAIN' };
      if (s.startingRun) {
        return { ...face, label: 'Train: starting a run…', on: true, disabled: true, progress: PENDING };
      }
      if (s.trainingLink !== 'ok' || !s.lastRunName) {
        return { ...face, label: TRAIN_REST[s.trainingLink], disabled: true };
      }
      return { ...face, label: `Train again with the settings of "${s.lastRunName}"` };
    }
    default: {
      const caption = generationCaption(s.statusLabel, s.isGenerating);
      // A Suno submit cannot be cancelled from here (sunoStore.submit is a
      // single fire-and-forget POST, not a pollable/cancellable job like the
      // local path's), so this renders busy — never STOP, which would imply
      // a press aborts it.
      if (s.model === 'suno' && s.sunoSubmitting) {
        return {
          ...rest,
          glyph: 'create',
          legend: 'CREATE',
          label: 'Create: submitting to Suno…',
          on: true,
          disabled: true,
          progress: PENDING,
          caption: { text: 'SUBMITTING...', tone: 'running' },
        };
      }
      if (s.isGenerating) {
        // A press is generateStore.cancelGeneration: the run's job, Stable
        // Audio or Magenta, is cancelled on the backend.
        const pct = clampPct(s.progressPct);
        return {
          ...rest,
          glyph: 'stop',
          legend: 'STOP',
          label: 'Stop and cancel the generation job',
          on: true,
          progress: pct > 0 ? { kind: 'fill', pct } : PENDING,
          progressText: pct > 0 ? `${pct}% done` : null,
          caption,
        };
      }
      return {
        ...rest,
        glyph: 'create',
        legend: 'CREATE',
        label: createLabel(s.model),
        caption,
      };
    }
  }
}

/**
 * P0: the label used to always claim /api/generate-jobs, which is only true
 * for local (Stable Audio / Magenta) models — Suno and Lyria are cloud
 * providers with their own generate paths (generateStore.submitGeneration
 * routes CREATE to sunoStore.submit for Suno; Lyria has none to route to at
 * all, since its transport lives entirely inside its embedded iframe).
 */
function createLabel(model: string): string {
  if (model === 'suno') return 'Create: submit to Suno (its own render queue)';
  if (model === 'lyria') return 'Create: use the controls inside the Lyria tab — this key has no route into it';
  return `Create: submit ${model.toUpperCase()} to /api/generate-jobs`;
}
