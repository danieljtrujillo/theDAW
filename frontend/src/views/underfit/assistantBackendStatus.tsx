/**
 * Whether the UNDERFIT assistant backend (underfit/assistant-backend, :5473)
 * is answering, and a way to start it from the orb.
 *
 * The orb lives inside the Underfit dashboard page (:8791) and posts every
 * request to that backend. theDAW's backend starts it with the dashboard
 * (backend/modules/underfit/assistant_sidecar.py); when it is not running the
 * orb says so with a dot and one word, the reason theDAW's backend gives, and
 * a Start key that calls POST /api/underfit/assistant/start.
 *
 * The orb counts the backend as running when its own /api/health answers or
 * when theDAW's status route says it answers. theDAW checks from the server
 * side, so a health response the browser refuses (a server built before its
 * /api/health sent CORS headers) never strands the orb on Offline.
 *
 * theDAW's API base comes from the `thedaw_api` query parameter the Underfit
 * tab puts on the dashboard's URL (UnderfitView), else
 * window.__THEDAW_API_BASE__, else http://localhost:8600, the fixed backend
 * port every launcher uses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type AssistantBackendState = 'checking' | 'running' | 'starting' | 'offline';

/** GET /api/underfit/assistant/status (assistant_sidecar.probe()). */
export interface AssistantSidecarStatus {
  running: boolean;
  starting: boolean;
  /** True while the first start runs npm install (absent from older backends). */
  installing?: boolean;
  installed: boolean;
  issues: string[];
  error: string | null;
  log_path?: string;
}

/** The one word beside the status dot. */
export const STATE_WORD: Record<AssistantBackendState, string> = {
  checking: 'Checking',
  running: 'Online',
  starting: 'Starting',
  offline: 'Offline',
};

/** The sentence under the word: what is wrong and what Start will do. */
export function assistantStatusDetail(
  state: AssistantBackendState,
  sidecar: AssistantSidecarStatus | null,
  startError: string | null,
  thedawReachable: boolean,
): string {
  if (state === 'running') return 'The assistant backend is running.';
  if (state === 'checking') return 'Looking for the assistant backend.';
  if (state === 'starting') {
    return sidecar && (sidecar.installing ?? !sidecar.installed)
      ? 'Installing the assistant’s packages, then starting it. The first start takes a minute.'
      : 'Starting the assistant backend.';
  }
  if (startError) return startError;
  if (!thedawReachable) {
    return 'The assistant backend is not running, and theDAW did not answer, so it cannot be started from here. Start theDAW, then press Start.';
  }
  if (sidecar?.issues.length) return sidecar.issues.join(' ');
  if (sidecar?.error) return sidecar.error;
  return 'The assistant backend is not running. Press Start to run it.';
}

/** theDAW's API base, as described in the file comment. */
export function thedawApiBase(
  search: string = typeof window !== 'undefined' ? window.location.search : '',
  injected: string | undefined = typeof window !== 'undefined'
    ? (window as unknown as { __THEDAW_API_BASE__?: string }).__THEDAW_API_BASE__
    : undefined,
): string {
  const fromQuery = new URLSearchParams(search).get('thedaw_api');
  const base = fromQuery || injected || 'http://localhost:8600';
  return base.replace(/\/+$/, '');
}

type Fetch = typeof fetch;

/** How often the orb re-checks while the backend is not answering. */
export const OFFLINE_POLL_MS = 5000;

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * The backend's state, polled while it is not answering, and `start()`.
 * `onOnline` runs each time the state becomes `running` after it was not, so
 * the orb can reload its provider catalog.
 */
export function useAssistantBackendStatus(
  assistantBase: string,
  onOnline: () => void,
  fetcher: Fetch = fetch,
  apiBase: string = thedawApiBase(),
) {
  const [state, setState] = useState<AssistantBackendState>('checking');
  const [sidecar, setSidecar] = useState<AssistantSidecarStatus | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [thedawReachable, setThedawReachable] = useState(true);
  const wasRunning = useRef(false);
  const startingRef = useRef(false);
  const onOnlineRef = useRef(onOnline);
  onOnlineRef.current = onOnline;

  const check = useCallback(async () => {
    const markRunning = () => {
      setState('running');
      setStartError(null);
      if (!wasRunning.current) {
        wasRunning.current = true;
        onOnlineRef.current();
      }
    };
    let running = false;
    try {
      const res = await fetcher(`${assistantBase}/api/health`, { cache: 'no-store' });
      running = res.ok;
    } catch {
      running = false;
    }
    if (running) {
      markRunning();
      return;
    }
    try {
      const res = await fetcher(`${apiBase}/api/underfit/assistant/status`, { cache: 'no-store' });
      const body = res.ok ? await readJson<AssistantSidecarStatus>(res) : null;
      setThedawReachable(res.ok);
      setSidecar(body);
      if (body?.running) {
        markRunning();
        return;
      }
      wasRunning.current = false;
      if (!startingRef.current) setState(body?.starting ? 'starting' : 'offline');
    } catch {
      wasRunning.current = false;
      setThedawReachable(false);
      setSidecar(null);
      if (!startingRef.current) setState('offline');
    }
  }, [assistantBase, apiBase, fetcher]);

  const start = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setState('starting');
    setStartError(null);
    try {
      const res = await fetcher(`${apiBase}/api/underfit/assistant/start`, { method: 'POST' });
      setThedawReachable(true);
      if (!res.ok) {
        const body = await readJson<{ detail?: unknown }>(res);
        const detail = typeof body?.detail === 'string' ? body.detail : '';
        setStartError(detail || `Start failed with HTTP ${res.status}.`);
      }
    } catch (e) {
      setThedawReachable(false);
      setStartError(
        `Could not reach theDAW to start the assistant: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      startingRef.current = false;
      await check();
    }
  }, [apiBase, fetcher, check]);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    if (state === 'running') return;
    const id = window.setInterval(() => void check(), OFFLINE_POLL_MS);
    return () => window.clearInterval(id);
  }, [state, check]);

  return { state, sidecar, startError, thedawReachable, check, start };
}

const DOT_CLASS: Record<AssistantBackendState, string> = {
  checking: 'bg-zinc-400',
  running: 'bg-emerald-400',
  starting: 'bg-amber-400 animate-pulse',
  offline: 'bg-rose-500',
};

/** The status strip under the orb panel's header. Hidden while running. */
export function AssistantBackendStatusBar(props: {
  state: AssistantBackendState;
  detail: string;
  onStart: () => void;
}) {
  const { state, detail, onStart } = props;
  if (state === 'running') return null;
  const wordId = 'underfit-assistant-status-word';
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-3 border-b border-white/10 bg-black/40 px-4 py-3"
    >
      <span aria-hidden="true" className={`mt-1 size-2.5 shrink-0 rounded-full ${DOT_CLASS[state]}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span id={wordId} className="font-display text-xs font-bold uppercase tracking-wider text-zinc-100">
          {STATE_WORD[state]}
        </span>
        <span className="text-xs font-semibold text-zinc-300">{detail}</span>
      </div>
      {state !== 'checking' && (
        <button
          type="button"
          onClick={onStart}
          disabled={state === 'starting'}
          aria-label="Start the UNDERFIT assistant backend"
          className="shrink-0 rounded border border-violet-500/40 bg-violet-600/20 px-3 py-1.5 font-display text-xs font-bold uppercase tracking-wider text-violet-100 hover:bg-violet-600/40 disabled:cursor-wait disabled:opacity-50"
        >
          {state === 'starting' ? 'Starting' : 'Start'}
        </button>
      )}
    </div>
  );
}
