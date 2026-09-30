/**
 * wizardModel — the pure model behind the Suno import wizard: which step is
 * showing, what the Stage/Promote request bodies look like, and how counts,
 * rates, durations and byte sizes print. The wizard's React UI, its zustand
 * store, and its `fetch` calls are built elsewhere against this module; none
 * of that lives here, so every decision the wizard makes is provable without
 * a DOM, a server, or a real Suno cache.
 *
 * This is also the single source of truth for the wire-contract types
 * (`JobKind`, `JobStatus`, `JobProgress`, `JobSnapshot`, `SunoImportSnapshot`)
 * that model the backend's `/api/library/suno-import/*` endpoints — every
 * other Suno-import file imports them from here rather than redeclaring them.
 *
 * Pure and DOM-free: no react, no zustand, nothing that touches `fetch` or
 * `window`.
 */

// --------------------------------------------------------------------------
// Wire-contract types
// --------------------------------------------------------------------------

/** Which backend job this is: staging cache files, or promoting staged rows. */
export type JobKind = 'stage' | 'promote';

/** Lifecycle of a backend job, as reported by `GET .../jobs/{job_id}`. */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** A job's progress counters. `total`/`etaSec` are null until known. */
export interface JobProgress {
  readonly done: number;
  readonly total: number | null;
  readonly ratePerSec: number;
  readonly etaSec: number | null;
}

/**
 * A snapshot of one backend job. `report` is the job's own free-form result
 * payload (its shape depends on `kind`; see `stageReportRows` for the stage
 * one) and stays `null` until the job finishes; `error` is set only on
 * `'failed'`.
 */
export interface JobSnapshot {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly status: JobStatus;
  readonly progress: JobProgress;
  readonly report: Record<string, unknown> | null;
  readonly error: string | null;
}

/** `GET .../suno-import/state`'s `stage` block. */
export interface SunoImportStageSnapshot {
  readonly exists: boolean;
  readonly songs: number;
  readonly quarantined: number;
  readonly mediaLocal: number;
  readonly mediaRemoteOnly: number;
  readonly mediaMissing: number;
  readonly lastRunAt: string | null;
}

/** `GET .../suno-import/state`'s `promote` block. */
export interface SunoImportPromoteSnapshot {
  readonly promoted: number;
  readonly remaining: number;
  readonly lastRunAt: string | null;
}

/** The full `GET .../suno-import/state` response, camelCased. */
export interface SunoImportSnapshot {
  readonly stage: SunoImportStageSnapshot;
  readonly promote: SunoImportPromoteSnapshot;
  readonly libraryRoot: string;
  readonly stageRoot: string;
  readonly freeBytes: number;
  readonly activeJobId: string | null;
}

// --------------------------------------------------------------------------
// Wizard steps
// --------------------------------------------------------------------------

export type WizardStep = 'source' | 'stage' | 'dryRun' | 'import' | 'done';

/** The wizard's steps in walk order; also what `nextStep` iterates over. */
export const WIZARD_STEPS: readonly WizardStep[] = ['source', 'stage', 'dryRun', 'import', 'done'];

/** Heading shown for each step. */
export const STEP_TITLES: Record<WizardStep, string> = {
  source: 'SOURCE',
  stage: 'STAGE',
  dryRun: 'DRY RUN',
  import: 'IMPORT',
  done: 'DONE',
};

/** The step after `step`, or `null` once `'done'` is reached. */
export const nextStep = (step: WizardStep): WizardStep | null => {
  const index = WIZARD_STEPS.indexOf(step);
  if (index === -1 || index === WIZARD_STEPS.length - 1) return null;
  return WIZARD_STEPS[index + 1] ?? null;
};

// --------------------------------------------------------------------------
// Form state
// --------------------------------------------------------------------------

/** The wizard's SOURCE-step form fields. */
export interface WizardForm {
  readonly cachePathsText: string;
  readonly mediaRoot: string;
  readonly namespace: string;
  readonly resume: boolean;
}

/** A fresh form: no paths yet, default namespace `'suno'`, resume-on. */
export const initialForm = (): WizardForm => ({
  cachePathsText: '',
  mediaRoot: '',
  namespace: 'suno',
  resume: true,
});

/**
 * Turn the SOURCE step's textarea contents into a cache-path list: one path
 * per line, trimmed, blank lines dropped, repeats dropped (first occurrence
 * wins), original order otherwise preserved.
 */
export const parseCachePaths = (text: string): string[] => {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    paths.push(trimmed);
  }
  return paths;
};

/** The result of validating a `WizardForm` before it can be staged. */
export type FormValidation = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * The only rule the pure model enforces: at least one cache path. Whether
 * each path actually exists is the backend's call (it answers 400 for a path
 * that does not exist), not this module's.
 */
export const validateForm = (form: WizardForm): FormValidation => {
  if (parseCachePaths(form.cachePathsText).length === 0) {
    return { ok: false, message: 'Add at least one cache file path.' };
  }
  return { ok: true };
};

// --------------------------------------------------------------------------
// Request builders
// --------------------------------------------------------------------------

/** Body for `POST /api/library/suno-import/stage`. */
export interface StageRequestBody {
  readonly cache_paths: string[];
  readonly media_root?: string;
  readonly namespace?: string;
  readonly resume?: boolean;
}

/**
 * Build the Stage request body. `media_root`/`namespace` are sent only when
 * non-blank after trimming — an all-whitespace field means "not set", not
 * "set to whitespace" — while `resume` is always sent since the backend has
 * no default-omitted meaning for it.
 */
export const buildStageRequest = (form: WizardForm): StageRequestBody => {
  const mediaRoot = form.mediaRoot.trim();
  const namespace = form.namespace.trim();
  return {
    cache_paths: parseCachePaths(form.cachePathsText),
    ...(mediaRoot !== '' ? { media_root: mediaRoot } : {}),
    ...(namespace !== '' ? { namespace } : {}),
    resume: form.resume,
  };
};

/** Body for `POST /api/library/suno-import/promote`. */
export interface PromoteRequestBody {
  readonly dry_run: boolean;
  readonly limit?: number;
}

/** `limit` is only ever a positive count of rows to promote. */
const isPositiveSafeInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

/**
 * Build the Promote request body. `limit` is omitted whenever it would not
 * mean "promote at most this many rows" — undefined, zero, negative, or
 * fractional all fall out here rather than being sent to the backend.
 */
export const buildPromoteRequest = (dryRun: boolean, limit?: number): PromoteRequestBody => ({
  dry_run: dryRun,
  ...(limit !== undefined && isPositiveSafeInteger(limit) ? { limit } : {}),
});

// --------------------------------------------------------------------------
// Step-advance rules
// --------------------------------------------------------------------------

/**
 * Can the wizard move past `step`? `job` is whatever job snapshot the
 * caller is currently tracking for that step (stage's stage job, dryRun's
 * and import's promote jobs).
 *
 * `dryRun` and `import` both land on a succeeded `'promote'` job, so telling
 * them apart needs one more signal than kind+status. `JobSnapshot` has no
 * dedicated dry-run flag (the wire contract in item 1 fixes its shape), so
 * this reads it off the promote job's own `report` — the backend echoes the
 * request's `dry_run` there, the same way `stageReportRows` reads other
 * snake_case fields off a job's report.
 */
export const canAdvance = (step: WizardStep, form: WizardForm, job: JobSnapshot | null): boolean => {
  if (step === 'source') return validateForm(form).ok;
  if (step === 'stage') return job !== null && job.kind === 'stage' && job.status === 'succeeded';
  if (step === 'dryRun') {
    return (
      job !== null &&
      job.kind === 'promote' &&
      job.status === 'succeeded' &&
      job.report !== null &&
      job.report.dry_run === true
    );
  }
  if (step === 'import') return job !== null && job.kind === 'promote' && job.status === 'succeeded';
  return false; // 'done' never advances
};

// --------------------------------------------------------------------------
// Formatters
// --------------------------------------------------------------------------

/** Thousands-separated integer count; `'—'` for anything non-finite. */
export const formatCount = (n: number): string => {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const [intPart, fracPart] = Math.abs(n).toString().split('.');
  const withCommas = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + withCommas + (fracPart ? `.${fracPart}` : '');
};

/** A processing rate, e.g. `'12.4 songs/s'`; `'—'` when not a usable rate. */
export const formatRate = (perSec: number): string => {
  if (!Number.isFinite(perSec) || perSec < 0) return '—';
  return `${perSec.toFixed(1)} songs/s`;
};

const pad2 = (n: number): string => n.toString().padStart(2, '0');

/**
 * A duration as `'1m 05s'` under an hour, `'2h 03m'` at or above one hour;
 * `'—'` for `null` or anything not a usable non-negative duration.
 */
export const formatDuration = (sec: number | null): string => {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '—';
  const totalSeconds = Math.round(sec);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${pad2(seconds)}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${pad2(minutes)}m`;
};

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A byte count as `'512 B'` under 1 KB, else with one decimal place at the
 * largest 1024-based unit that fits (`'1.5 KB'`, `'4.7 GB'`, ...).
 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
};

// --------------------------------------------------------------------------
// Stage report
// --------------------------------------------------------------------------

/** One printable row of a stage job's report. */
export interface ReportRow {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

/** The stage report's fields, in the order the DRY RUN/STAGE step prints them. */
const STAGE_REPORT_FIELDS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'songs_seen', label: 'Songs seen' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'duplicates', label: 'Duplicates' },
  { key: 'quarantined', label: 'Quarantined' },
  { key: 'same_title_different_song', label: 'Same title, different song (kept)' },
  { key: 'media_local', label: 'Media found locally' },
  { key: 'media_remote_only', label: 'Media remote only' },
  { key: 'media_missing', label: 'Media missing' },
  { key: 'unresolved_lineage', label: 'Unresolved lineage' },
];

/** Read `key` off `report` as a non-negative-shaped integer, defaulting to 0. */
const readIntField = (report: Record<string, unknown> | null, key: string): number => {
  const raw = report?.[key];
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : 0;
};

/**
 * The stage report as nine printable rows, always in the same order. A
 * `null` report (job not finished yet) or a field that is missing or not an
 * integer reads as `0` — the row is still emitted, never dropped, so the
 * report table's shape never shifts under the user.
 */
export const stageReportRows = (report: Record<string, unknown> | null): ReportRow[] =>
  STAGE_REPORT_FIELDS.map(({ key, label }) => ({ key, label, value: readIntField(report, key) }));

/** A yes/no with the sentence explaining it, shared by the report checks below. */
export interface Verdict {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Do the stage report's accepted/duplicate/quarantined counts add back up to
 * the songs it saw? A mismatch means some song was neither accepted,
 * flagged a duplicate, nor quarantined — a bug in the stage pass, not
 * something the wizard should silently hide.
 */
export const totalsReconcile = (report: Record<string, unknown> | null): Verdict => {
  const seen = readIntField(report, 'songs_seen');
  const accepted = readIntField(report, 'accepted');
  const duplicates = readIntField(report, 'duplicates');
  const quarantined = readIntField(report, 'quarantined');
  const accountedFor = accepted + duplicates + quarantined;
  if (accountedFor === seen) return { ok: true, message: 'Totals reconcile' };
  return { ok: false, message: `Totals do not reconcile: ${seen} seen vs ${accountedFor} accounted for` };
};

/** Does `freeBytes` cover `neededBytes`? Both sides are printed via `formatBytes`. */
export const spaceVerdict = (neededBytes: number, freeBytes: number): Verdict => {
  const needed = formatBytes(neededBytes);
  const free = formatBytes(freeBytes);
  if (neededBytes <= freeBytes) return { ok: true, message: `Needs ${needed} of ${free} free` };
  return { ok: false, message: `Not enough space: needs ${needed}, ${free} free` };
};
