import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { AudioWorkletUnavailableError } from '../../lib/audioWorkletSupport';

interface TabErrorBoundaryProps {
  tabName: string;
  children: React.ReactNode;
}

interface TabErrorBoundaryState {
  error: Error | null;
  // Set once handleRetry has already tried an in-place recovery (cleared
  // `error` without reloading) and the SAME boundary threw again. The regex
  // list in CHUNK_LOAD_ERROR_PATTERNS is a first-click optimisation, not the
  // only gate: an unrecognised failure (a fetch phrased as a bare
  // `TypeError: Failed to fetch`, a chunk that evaluates and throws, a
  // missing named export) still needs to reach a reload eventually, or the
  // "Retry" button never recovers anything for it. getDerivedStateFromError
  // must NOT reset this back to false — that is what lets the second
  // occurrence escalate.
  retried: boolean;
}

/**
 * A rejected `import()` for a React.lazy chunk (a stale build after a
 * deploy, a flaky network on the first chunk fetch) throws an error that
 * every browser's module loader phrases slightly differently. React.lazy
 * also CACHES the rejected promise, so simply clearing this boundary's
 * `error` state and re-rendering re-throws the exact same rejection forever
 * — "Retry" can never actually recover a chunk-load failure. A full reload
 * re-fetches the chunk (or its updated URL after a redeploy) from scratch,
 * which is the only thing that can.
 */
const CHUNK_LOAD_ERROR_PATTERNS: RegExp[] = [
  // Webpack
  /ChunkLoadError/i,
  /Loading chunk [\w.-]+ failed/i,
  // Vite / native ESM dynamic import, across browsers
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
];

export function isChunkLoadError(error: Error | null | undefined): boolean {
  if (!error) return false;
  const haystack = `${error.name ?? ''} ${error.message ?? ''}`;
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(haystack));
}

export class TabErrorBoundary extends React.Component<TabErrorBoundaryProps, TabErrorBoundaryState> {
  state: TabErrorBoundaryState = { error: null, retried: false };

  static getDerivedStateFromError(error: Error): Pick<TabErrorBoundaryState, 'error'> {
    // Intentionally only returns `error` — React merges this into existing
    // state, so `retried` from a prior render is preserved rather than reset.
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[${this.props.tabName}] tab crashed`, error, info.componentStack);
  }

  componentDidUpdate(prevProps: TabErrorBoundaryProps) {
    if (prevProps.tabName !== this.props.tabName && this.state.error) {
      // A different tab gets a fresh attempt: `retried` tracks whether THIS
      // boundary already tried an in-place recovery for the CURRENT crash,
      // not a lifetime counter across unrelated tabs.
      this.setState({ error: null, retried: false });
    }
  }

  handleRetry = () => {
    // A chunk-load failure can't be retried in place — React.lazy's cached
    // rejection means the exact same error would just throw again. Reload
    // instead, which re-fetches the chunk (picking up a redeploy's new URL
    // too). The regex list is only a first-click optimisation though: any
    // failure this boundary has already tried an in-place retry for (and
    // that retry didn't stick — the same boundary threw again) also
    // escalates to a reload, whether or not its phrasing matched the regex.
    if (isChunkLoadError(this.state.error) || this.state.retried) {
      window.location.reload();
      return;
    }
    this.setState({ error: null, retried: true });
  };

  render() {
    if (!this.state.error) return this.props.children;

    const chunkFailure = isChunkLoadError(this.state.error);
    // A page with no AudioWorklet cannot grow one by re-rendering or by
    // reloading, so the error's own (actionable) message is the whole answer
    // and there is no button that could honestly be labelled Retry.
    const worklet = this.state.error instanceof AudioWorkletUnavailableError;

    return (
      <div className="absolute inset-0 grid place-items-center bg-[#09070d]">
        <div className="w-[min(520px,90%)] rounded border border-red-400/20 bg-red-500/10 p-4 shadow-xl">
          <div className="flex items-center gap-2 text-red-100">
            <AlertTriangle className="w-4 h-4 text-red-300 shrink-0" />
            <span className="text-[11px] font-black uppercase tracking-widest">
              {this.props.tabName} stopped
            </span>
          </div>
          <div className="mt-2 rounded bg-black/25 px-2 py-1.5 text-[9px] font-mono text-red-100/80 wrap-break-word">
            {this.state.error.message || 'Unknown error'}
          </div>
          {worklet ? null : (
            <button
              type="button"
              onClick={this.handleRetry}
              className="mt-3 h-8 px-3 inline-flex items-center gap-1.5 rounded border border-white/10 bg-black/20 text-[9px] font-bold uppercase tracking-wider text-zinc-200 hover:bg-white/10"
            >
              <RotateCcw className="w-3 h-3" />
              {chunkFailure ? 'Reload' : 'Retry'}
            </button>
          )}
        </div>
      </div>
    );
  }
}
