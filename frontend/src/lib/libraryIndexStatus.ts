/**
 * Where the backend has got with opening the library, and how to say it.
 *
 * `GET /api/library/index-status` answers from memory at once, whatever holds
 * the database:
 *
 *   {phase, label, done, total, items, eta_sec, opened, error}
 *
 * `phase` is one of
 *   `upgrade`  the schema upgrade; `done`/`total` count migration statements,
 *   `read`     a first start's read of every metadata.json; `done`/`total`
 *              count top-level library folders, `items` the entries found,
 *   `index`    the search index build; `done`/`total` count entries,
 *   `opening`  nothing measured yet,
 *   `ready`    done,
 *   `failed`   the open or a build stopped; `error` says why.
 *
 * While the library is still opening, the list, facet, stats and summary
 * routes answer 503 with the same snapshot as `library_status`. While the
 * search index builds, a searched page carries `search_index`:
 * `{complete: false, indexed, total, eta_sec}` — the page covers the indexed
 * entries only.
 */

export type LibraryIndexPhase = 'opening' | 'upgrade' | 'read' | 'index' | 'ready' | 'failed';

export interface LibraryIndexStatus {
  phase: LibraryIndexPhase;
  label: string;
  done: number;
  total: number;
  items: number;
  etaSec: number | null;
  opened: boolean;
  error: string | null;
}

/** A searched page's `search_index`: complete, or how much it covers. */
export interface LibrarySearchCoverage {
  complete: boolean;
  indexed: number;
  total: number;
  etaSec: number | null;
}

const PHASES: readonly LibraryIndexPhase[] = ['opening', 'upgrade', 'read', 'index', 'ready', 'failed'];

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

const seconds = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** The snapshot, or null when `raw` is not one. */
export function asIndexStatus(raw: unknown): LibraryIndexStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const phase = body.phase;
  if (typeof phase !== 'string' || !PHASES.includes(phase as LibraryIndexPhase)) return null;
  return {
    phase: phase as LibraryIndexPhase,
    label: typeof body.label === 'string' ? body.label : '',
    done: count(body.done),
    total: count(body.total),
    items: count(body.items),
    etaSec: seconds(body.eta_sec),
    opened: body.opened === true,
    error: typeof body.error === 'string' ? body.error : null,
  };
}

/** A page's `search_index`, or null when the page carries none. */
export function asSearchCoverage(raw: unknown): LibrarySearchCoverage | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.complete !== 'boolean') return null;
  return {
    complete: body.complete,
    indexed: count(body.indexed),
    total: count(body.total),
    etaSec: seconds(body.eta_sec),
  };
}

/**
 * Thrown by a list-shaped request that the backend answered 503 because the
 * library is still opening. Carries the snapshot so the caller can show the
 * progress instead of an error.
 */
export class LibraryOpeningError extends Error {
  readonly status: LibraryIndexStatus;
  constructor(status: LibraryIndexStatus) {
    super(`library.opening: ${status.label || 'the library is opening'}`);
    this.name = 'LibraryOpeningError';
    this.status = status;
  }
}

/**
 * The `LibraryOpeningError` a 503 response describes, or null for any other
 * response. Reads the body of a clone, so the caller can still read the
 * original.
 */
export async function openingErrorFrom(r: Response): Promise<LibraryOpeningError | null> {
  if (r.status !== 503) return null;
  try {
    const body = (await r.clone().json()) as { library_status?: unknown };
    const status = asIndexStatus(body?.library_status);
    return status ? new LibraryOpeningError(status) : null;
  } catch {
    return null;
  }
}

/** The snapshot, or null when the backend has no such route (an older one). */
export async function fetchLibraryIndexStatus(
  signal?: AbortSignal,
  base: string = '/api/library',
): Promise<LibraryIndexStatus | null> {
  const r = await fetch(`${base}/index-status`, { signal });
  if (r.status === 404 || r.status === 405) return null;
  if (!r.ok) throw new Error(`library.index-status: HTTP ${r.status}`);
  return asIndexStatus(await r.json());
}

/** Whether the phase is one a progress bar shows. */
export function isWorkingPhase(phase: LibraryIndexPhase): boolean {
  return phase === 'opening' || phase === 'upgrade' || phase === 'read' || phase === 'index';
}

/** "About 2 min left", "About 40 s left", or the not-yet-known wording. */
export function formatEta(etaSec: number | null): string {
  if (etaSec === null) return 'Estimating time left';
  if (etaSec < 5) return 'Almost done';
  if (etaSec < 60) return `About ${Math.round(etaSec / 5) * 5} s left`;
  if (etaSec < 3600) return `About ${Math.round(etaSec / 60)} min left`;
  const hours = Math.floor(etaSec / 3600);
  const minutes = Math.round((etaSec % 3600) / 60);
  return minutes > 0 ? `About ${hours} h ${minutes} min left` : `About ${hours} h left`;
}

/** What the progress bar shows for a snapshot. */
export interface IndexProgressView {
  label: string;
  /** e.g. "40,000 of 200,000 entries". */
  countText: string;
  etaText: string;
  valueNow: number;
  valueMax: number;
  /** 0..100, for the bar's width. */
  percent: number;
  /** What a screen reader reads for the bar. */
  valueText: string;
}

const units = (phase: LibraryIndexPhase): string => {
  if (phase === 'upgrade') return 'steps';
  if (phase === 'read') return 'folders';
  return 'entries';
};

export function indexProgressView(status: LibraryIndexStatus): IndexProgressView {
  const total = Math.max(status.total, status.done);
  const percent = total > 0 ? Math.min(100, Math.round((status.done / total) * 100)) : 0;
  let countText =
    total > 0
      ? `${status.done.toLocaleString()} of ${total.toLocaleString()} ${units(status.phase)}`
      : 'Starting';
  if (status.phase === 'read' && status.items > 0) {
    countText += ` · ${status.items.toLocaleString()} entries found`;
  }
  const etaText = total > 0 ? formatEta(status.etaSec) : 'Estimating time left';
  const label = status.label || 'Opening the library';
  return {
    label,
    countText,
    etaText,
    valueNow: status.done,
    valueMax: total,
    percent,
    valueText: `${countText}. ${etaText}.`,
  };
}

/** The line a search shows while the index covers part of the library. */
export function searchCoverageText(coverage: LibrarySearchCoverage): string {
  if (coverage.total <= 0) return 'Search covers the entries indexed so far; the index is still building.';
  return (
    `Search covers ${coverage.indexed.toLocaleString()} of ${coverage.total.toLocaleString()} entries ` +
    'until the search index finishes building.'
  );
}

/**
 * What an empty list says while the backend refuses it (`libraryOpening`):
 * it appears once the library has opened, or, after a failed open, where
 * the reason and the Retry button are.
 */
export function libraryOpeningText(status: LibraryIndexStatus | null): string {
  if (status?.phase === 'failed' && !status.opened) {
    return 'The library could not be opened. The reason and a Retry button are above the list.';
  }
  return 'The list appears when the library has finished opening.';
}
