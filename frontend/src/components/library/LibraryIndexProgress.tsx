/**
 * The LIBRARY tab's progress bar for the backend opening the library: the
 * schema upgrade, a first start's read of every metadata.json, and the search
 * index build. Each can run for minutes on a 200,000-entry library, and the
 * backend answers everything else meanwhile, so this is where the user sees
 * how far it has got and how long is left.
 *
 * `LibraryIndexProgressView` is the markup for one snapshot (pure, so it
 * renders in a node test); `LibraryIndexProgress` wires it to the polling
 * store and the library store.
 */
import React, { useEffect, useId } from 'react';
import {
  indexProgressView,
  isWorkingPhase,
  searchCoverageText,
  type LibraryIndexStatus,
  type LibrarySearchCoverage,
} from '../../lib/libraryIndexStatus';
import { useLibraryIndexStatus } from '../../state/libraryIndexStatusStore';
import { useLibraryStore } from '../../state/libraryStore';

export interface LibraryIndexProgressViewProps {
  /** The backend's snapshot, or null before the first answer. */
  status: LibraryIndexStatus | null;
  /** Whether the list was refused because the library is still opening. */
  libraryOpening: boolean;
  /** The last searched page's coverage, when the list is searched. */
  searchCoverage: LibrarySearchCoverage | null;
  /** The failure alert's Retry button; no button without it. */
  onRetry?: () => void;
  /** True while a Retry request is out (the button is disabled). */
  retrying?: boolean;
  /** The last Retry request's failure, shown under the button. */
  retryError?: string | null;
}

export const LibraryIndexProgressView: React.FC<LibraryIndexProgressViewProps> = ({
  status,
  libraryOpening,
  searchCoverage,
  onRetry,
  retrying = false,
  retryError = null,
}) => {
  const labelId = useId();
  const partialSearch = searchCoverage !== null && !searchCoverage.complete;

  if (status?.phase === 'failed') {
    return (
      <div
        role="alert"
        data-testid="library-index-failed"
        className="shrink-0 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-xs font-bold text-rose-100"
      >
        <p>{status.label || 'The library could not be opened'}</p>
        {status.error && <p className="mt-0.5 wrap-break-word text-rose-200">{status.error}</p>}
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            aria-label={retrying ? 'Retrying' : 'Retry opening the library'}
            className="mt-1.5 rounded border border-rose-400/60 bg-rose-500/20 px-2 py-0.5 text-xs font-bold text-rose-50 hover:bg-rose-500/35 disabled:opacity-50"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
        {retryError && <p className="mt-0.5 wrap-break-word text-rose-200">Retry failed: {retryError}</p>}
      </div>
    );
  }

  // "opening" before anything is measured lasts a moment on a small library;
  // it is shown only once the list has actually been refused for it.
  const working =
    status !== null && isWorkingPhase(status.phase) && (status.phase !== 'opening' || libraryOpening);
  const showOpeningOnly = status === null && libraryOpening;

  if (!working && !showOpeningOnly && !partialSearch) return null;

  const view = working && status ? indexProgressView(status) : null;
  const determinate = view !== null && view.valueMax > 0;

  return (
    <section
      aria-labelledby={labelId}
      data-testid="library-index-progress"
      className="shrink-0 rounded border border-purple-500/40 bg-purple-500/10 px-2 py-1.5 font-sans"
    >
      {(view || showOpeningOnly) && (
        <>
          <div className="flex items-center justify-between gap-2 text-xs font-bold">
            <span id={labelId} className="min-w-0 truncate text-purple-100">
              {view ? view.label : 'Opening the library'}
            </span>
            {determinate && <span className="shrink-0 tabular-nums text-purple-200">{view.percent}%</span>}
          </div>
          {determinate ? (
            <div
              role="progressbar"
              aria-labelledby={labelId}
              aria-valuemin={0}
              aria-valuemax={view.valueMax}
              aria-valuenow={view.valueNow}
              aria-valuetext={view.valueText}
              className="mt-1 h-2 w-full overflow-hidden rounded bg-white/10"
            >
              <div className="h-full rounded bg-purple-400" style={{ width: `${view.percent}%` }} />
            </div>
          ) : (
            // Indeterminate: nothing counted yet, so no value to announce.
            <div
              role="progressbar"
              aria-labelledby={labelId}
              aria-valuetext="Starting"
              className="mt-1 h-2 w-full overflow-hidden rounded bg-white/10"
            >
              <div className="h-full w-1/3 animate-pulse rounded bg-purple-400/70" />
            </div>
          )}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 text-xs font-bold text-zinc-200">
            <span className="tabular-nums">{view ? view.countText : 'Starting'}</span>
            <span>{view ? view.etaText : 'Estimating time left'}</span>
          </div>
        </>
      )}
      {partialSearch && searchCoverage && (
        <p
          role="status"
          data-testid="library-search-coverage"
          className={`${view || showOpeningOnly ? 'mt-1 ' : ''}text-xs font-bold text-amber-200`}
          id={view || showOpeningOnly ? undefined : labelId}
        >
          {searchCoverageText(searchCoverage)}
        </p>
      )}
    </section>
  );
};

/** The bar, wired to the backend's status and the library list. */
export const LibraryIndexProgress: React.FC = () => {
  const status = useLibraryIndexStatus((s) => s.status);
  const libraryOpening = useLibraryStore((s) => s.libraryOpening);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const searchIndex = useLibraryStore((s) => s.searchIndex);
  const retry = useLibraryIndexStatus((s) => s.retry);
  const retrying = useLibraryIndexStatus((s) => s.retrying);
  const retryError = useLibraryIndexStatus((s) => s.retryError);

  useEffect(() => {
    // Once per mount: a library opened before the tab was shown answers
    // `ready` on the first poll and polling stops there.
    useLibraryIndexStatus.getState().watch();
  }, []);

  return (
    <LibraryIndexProgressView
      status={status}
      libraryOpening={libraryOpening}
      searchCoverage={searchQuery.trim() ? searchIndex : null}
      onRetry={() => {
        void retry();
      }}
      retrying={retrying}
      retryError={retryError}
    />
  );
};
