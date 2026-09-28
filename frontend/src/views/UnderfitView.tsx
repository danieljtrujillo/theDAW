import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, ExternalLink, FlaskConical, Loader2, Play, RefreshCw, Download } from 'lucide-react';
import { DadabotsCredit } from '../components/ui/Credit';
import { useAppUiStore } from '../state/appUiStore';

/**
 * Underfit LoRA-trainer tab. Embeds the Underfit dashboard — a standalone
 * process at http://localhost:8791 — in an iframe.
 *
 * Resilient mount: we POLL the dashboard for reachability (no-cors ping) and
 * only render the iframe once the server actually answers. This avoids the
 * failure mode where the iframe navigates to a dead :8791, lands on Chromium's
 * chrome-error page, and then stays frozen there forever (a fixed-src React
 * iframe never retries on its own). When the server is down we show a
 * "connecting…" overlay and keep retrying; the instant it's up, the iframe
 * mounts (with a cache-bust) and loads the app — no manual refresh needed.
 *
 * Start the server with:
 *   underfit\.venv\Scripts\python.exe dashboard\server.py
 */
/** Fallback only, until /api/underfit/status reports the real port. The
 *  backend honours theDAW_UNDERFIT_PORT; hardcoding 8791 here meant that
 *  override moved the sidecar but not the tab, which then pinged a dead port. */
const DEFAULT_UNDERFIT_PORT = 8791;
const urlForPort = (port: number) => `http://localhost:${port}`;
const PING_INTERVAL_MS = 3000;

/**
 * The dashboard URL the iframe loads. `assistant_api` tells the assistant orb
 * inside the dashboard where its backend listens, from the port theDAW's
 * backend reports (GET /api/underfit/assistant/status), so a moved port
 * (theDAW_UNDERFIT_ASSISTANT_PORT) reaches the orb too.
 */
export function underfitFrameSrc(underfitUrl: string, reloadKey: number, assistantUrl: string | null): string {
  const params = new URLSearchParams({ _t: String(reloadKey) });
  if (assistantUrl) params.set('assistant_api', assistantUrl);
  return `${underfitUrl}/?${params.toString()}`;
}

/** Sidecar probe payload from GET /api/underfit/status (backend/modules/underfit). */
interface UnderfitStatus {
  ok: boolean;
  listening: boolean;
  process_alive: boolean;
  project_path: string;
  port: number;
  issues: string[];
}

/** GET /api/underfit/update-status payload (backend/modules/underfit/updater.py `check()`). */
export interface UnderfitUpdateStatus {
  remote: string;
  branch: string;
  synced: string;
  upstream: string;
  update_available: boolean;
  checked_at: string;
  error: string | null;
}

/** POST /api/underfit/update payload (backend/modules/underfit/updater.py `apply()`). */
interface UnderfitUpdateResult {
  ok: boolean;
  message?: string;
  output?: string;
  reason?: string;
}

/**
 * Whether the reachability/setup poll should be running right now — active
 * only while the Underfit tab is the visible center tab AND the document
 * itself isn't backgrounded. A hidden, warm-mounted Underfit tab used to
 * ping every 3s forever (FE-016).
 */
export function isUnderfitPollActive(tabVisible: boolean, docVisible: boolean): boolean {
  return tabVisible && docVisible;
}

/** A single human-readable line describing the upstream update status. */
export function describeUnderfitUpdateStatus(status: UnderfitUpdateStatus | null): string {
  if (!status) return 'Not checked yet.';
  if (status.error) return `Could not check: ${status.error}`;
  const short = (sha: string) => sha.slice(0, 12) || sha;
  if (status.update_available) {
    return `Update available (${short(status.synced)} -> ${short(status.upstream)}).`;
  }
  return `Up to date (${short(status.upstream || status.synced)}).`;
}

/** An error-shaped `UnderfitUpdateStatus` — the same shape the network-failure `catch` uses. */
export function underfitStatusError(error: string): UnderfitUpdateStatus {
  return { remote: '', branch: '', synced: '', upstream: '', update_available: false, checked_at: '', error };
}

/**
 * Reconciles a `GET /api/underfit/update-status` response. On success (2xx)
 * the body IS the status. On a non-2xx response (e.g. the Vite dev proxy's
 * own error page when the backend is down) the old code only handled the
 * `res.ok` branch and left whatever status was already showing — including
 * the very first "Up to date" default — which is exactly wrong when the
 * check itself failed. Non-2xx now becomes an explicit error status naming
 * the HTTP code.
 */
export function parseUnderfitCheckResponse(resOk: boolean, status: number, raw: unknown): UnderfitUpdateStatus {
  if (resOk && raw && typeof raw === 'object') return raw as UnderfitUpdateStatus;
  return underfitStatusError(`HTTP ${status}`);
}

/**
 * The check button's label, as three distinct states — a check never run yet
 * and a check that FAILED both used to render "Up to date" (`update_available`
 * is falsy in both), which is dishonest: the button read the same either way
 * whether nothing was ever checked or the backend couldn't reach upstream.
 */
export function underfitCheckButtonLabel(
  status: UnderfitUpdateStatus | null,
): 'Check updates' | 'Check failed' | 'Update available' | 'Up to date' {
  if (!status) return 'Check updates';
  if (status.error) return 'Check failed';
  return status.update_available ? 'Update available' : 'Up to date';
}

/**
 * Reconciles a `POST /api/underfit/update` response into the actual
 * `UnderfitUpdateResult`. On success (2xx) the body IS the result. On failure
 * the backend raises `HTTPException(status_code, detail=result)`
 * (backend/modules/underfit/router.py ~212), and FastAPI wraps that as
 * `{"detail": <result>}` — reading top-level `ok`/`reason`/`message` on a
 * non-2xx response always misses, which is why the UI only ever showed a
 * generic "HTTP 409"/"HTTP 500" instead of the backend's real reason.
 */
export function parseUnderfitUpdateResponse(resOk: boolean, status: number, raw: unknown): UnderfitUpdateResult {
  const fallback: UnderfitUpdateResult = { ok: false, message: `HTTP ${status}` };
  if (raw === null || typeof raw !== 'object') return fallback;
  if (resOk) return raw as UnderfitUpdateResult;
  const detail = (raw as { detail?: unknown }).detail;
  if (detail !== null && typeof detail === 'object') return detail as UnderfitUpdateResult;
  return fallback;
}

export const UnderfitView: React.FC = () => {
  const [reachable, setReachable] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Sidecar diagnosis, fetched while :8791 is down. null = not yet fetched
  // (backend may itself be starting). Drives the install-state fallback so a
  // missing checkout/venv shows a fix, never an endless "connecting…".
  const [diag, setDiag] = useState<UnderfitStatus | null>(null);
  const [starting, setStarting] = useState(false);
  /** Detail from a failed POST /start, rendered next to the button. */
  const [startError, setStartError] = useState<string | null>(null);
  // On-demand venv build state (POST /api/underfit/setup + poll /setup-status).
  const [setupState, setSetupState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [setupMsg, setSetupMsg] = useState('');
  /** Last lines of the `uv sync` output — the only sign of life during a
   *  10–30 minute torch download. The backend has always returned this; the
   *  panel never rendered it, so the build looked frozen and people quit it. */
  const [setupLog, setSetupLog] = useState('');
  // The sidecar's real port, once known. Everything that addresses the
  // dashboard (ping, iframe, external link, copy) derives from this.
  const underfitPort = diag?.port ?? DEFAULT_UNDERFIT_PORT;
  const underfitUrl = urlForPort(underfitPort);
  // Tracks the last known reachability so we only remount the iframe on a
  // down→up transition (not on every successful poll).
  const wasReachable = useRef(false);
  const diagInFlight = useRef(false);
  /** Where the UNDERFIT assistant backend listens, once the backend said. */
  const [assistantUrl, setAssistantUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/underfit/assistant/status', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { url?: unknown } | null) => {
        if (!cancelled && body && typeof body.url === 'string') setAssistantUrl(body.url);
      })
      .catch(() => {
        // Backend not up yet: the orb falls back to its default port.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Tab + OS/browser page visibility — pauses the reachability ping while the
  // Underfit tab is hidden (warm-mounted behind another center tab) or the
  // window itself is backgrounded (FE-016).
  const tabVisible = useAppUiStore((s) => s.centerTab === 'underfit');
  const [docVisible, setDocVisible] = useState<boolean>(() => (typeof document === 'undefined' ? true : !document.hidden));
  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Upstream-update check/apply — backed by GET /api/underfit/update-status
  // and POST /api/underfit/update (backend/modules/underfit/router.py:203,209),
  // previously unreachable from the UI.
  const [updateStatus, setUpdateStatus] = useState<UnderfitUpdateStatus | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [applyingUpdate, setApplyingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<UnderfitUpdateResult | null>(null);
  // Guards POST /api/underfit/update against a double-click firing it twice
  // (a real `git subrepo pull` + dashboard restart, not idempotent to repeat
  // mid-flight). Mirrors diagInFlight's ref-guard pattern above.
  const applyInFlight = useRef(false);

  const checkForUpdate = useCallback(async (force = false) => {
    setCheckingUpdate(true);
    try {
      const res = await fetch(`/api/underfit/update-status${force ? '?force=true' : ''}`, { cache: 'no-store' });
      const raw = await res.json().catch(() => null);
      setUpdateStatus(parseUnderfitCheckResponse(res.ok, res.status, raw));
    } catch {
      setUpdateStatus(underfitStatusError('Could not reach the backend.'));
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  const applyUpdate = async () => {
    if (applyInFlight.current) return;
    applyInFlight.current = true;
    setApplyingUpdate(true);
    setUpdateResult(null);
    try {
      const res = await fetch('/api/underfit/update', { method: 'POST' });
      const raw = await res.json().catch(() => null);
      const body = parseUnderfitUpdateResponse(res.ok, res.status, raw);
      setUpdateResult(body);
      if (body.ok) {
        void checkForUpdate(true);
        reload();
      }
    } catch (e) {
      setUpdateResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      applyInFlight.current = false;
      setApplyingUpdate(false);
    }
  };

  useEffect(() => {
    void checkForUpdate();
  }, [checkForUpdate]);

  // While the dashboard is down, ask the backend sidecar WHY (checkout
  // missing? venv missing? just not spawned yet?). The tab itself normally
  // never talks to the backend — this is diagnostics-only.
  const fetchDiag = useCallback(async () => {
    if (diagInFlight.current) return;
    diagInFlight.current = true;
    try {
      const res = await fetch('/api/underfit/status', { cache: 'no-store' });
      if (res.ok) setDiag((await res.json()) as UnderfitStatus);
    } catch {
      // Backend not up either — keep the plain "connecting" state.
    } finally {
      diagInFlight.current = false;
    }
  }, []);

  const ping = useCallback(async () => {
    try {
      // no-cors resolves (opaque) when the server is reachable, rejects on a
      // connection error — so this works even though the dashboard sends no CORS headers.
      await fetch(`${underfitUrl}/?_ping=${Date.now()}`, { mode: 'no-cors', cache: 'no-store' });
      if (!wasReachable.current) {
        wasReachable.current = true;
        setReachable(true);
        setReloadKey((k) => k + 1); // fresh mount now that it's up
      }
    } catch {
      if (wasReachable.current || reachable) {
        wasReachable.current = false;
        setReachable(false);
      }
      void fetchDiag();
    }
  }, [reachable, fetchDiag, underfitUrl]);

  // Paused while the Underfit tab is hidden or the document is backgrounded —
  // a hidden warm tab used to ping :8791 every 3s forever (FE-016). Re-pings
  // immediately on becoming active again.
  useEffect(() => {
    if (!isUnderfitPollActive(tabVisible, docVisible)) return;
    void ping();
    const id = window.setInterval(() => void ping(), PING_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [ping, tabVisible, docVisible]);

  const reload = () => {
    wasReachable.current = false;
    setReachable(false);
    setReloadKey((k) => k + 1);
    void ping();
  };

  // Explicit spawn via the sidecar (e.g. after the user fixed the install, or
  // when auto-spawn was disabled). POST /start blocks until :8791 answers.
  const startServer = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch('/api/underfit/start', { method: 'POST' });
      // A 503 RESOLVES — it does not throw — so the old bare `await` dropped the
      // one message that explains the failure ("Underfit dashboard exited before
      // becoming ready (rc=…). See …underfit-sidecar.log"). That silence is why
      // GH-131 arrived as "why do I need to install modules by hand?".
      if (!res.ok) {
        let detail = '';
        try {
          const body = await res.json() as { detail?: unknown };
          detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? '');
        } catch {
          try { detail = await res.text(); } catch { /* body already consumed */ }
        }
        setStartError(detail || `Start failed with HTTP ${res.status}.`);
      }
    } catch (e) {
      setStartError(
        `Could not reach the backend to start Underfit: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setStarting(false);
      void ping();
      void fetchDiag();
    }
  };

  // Poll the setup job until it finishes, then spawn the dashboard.
  const pollSetup = async () => {
    for (;;) {
      let j: { state?: string; message?: string; log_tail?: string };
      try {
        const res = await fetch('/api/underfit/setup-status', { cache: 'no-store' });
        j = (await res.json()) as { state?: string; message?: string; log_tail?: string };
      } catch {
        setSetupState('error');
        setSetupMsg('Lost contact with the backend during setup.');
        return;
      }
      const state = (j.state as typeof setupState) ?? 'idle';
      setSetupState(state);
      setSetupMsg(j.message ?? '');
      setSetupLog(j.log_tail ?? '');
      if (state === 'done') {
        void startServer();
        return;
      }
      if (state !== 'running') return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  // Build underfit/.venv from the app (no terminal). Kicks off the backend job
  // and polls it, then the dashboard auto-starts once the venv exists.
  const createEnv = async () => {
    setSetupState('running');
    setSetupMsg('Starting the Underfit environment build...');
    setSetupLog('');
    try {
      const res = await fetch('/api/underfit/setup', { method: 'POST' });
      const j = (await res.json()) as { state?: string; message?: string };
      const state = (j.state as typeof setupState) ?? 'error';
      setSetupState(state);
      setSetupMsg(j.message ?? '');
      if (state === 'done') {
        void startServer();
        return;
      }
      if (state === 'error') return;
      void pollSetup();
    } catch {
      setSetupState('error');
      setSetupMsg('Could not reach the backend to start setup.');
    }
  };

  // Install problems the sidecar can name (checkout missing, venv missing or
  // incomplete). Any of these routes the user to the build/repair button.
  const installIssues = !reachable && diag && Array.isArray(diag.issues) && diag.issues.length > 0 ? diag.issues : null;
  /** The venv exists but its packages don't — a rerun repairs rather than creates. */
  const needsRepair = !!installIssues?.some((i) => i.includes('venv is incomplete'));

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#050507] border border-white/5 rounded-lg overflow-hidden">
      <div data-tour="underfit-header" className="h-10 shrink-0 flex items-center justify-between gap-3 px-3 border-b border-white/5 bg-[#0a080f]">
        <div className="flex items-center gap-2 min-w-0">
          <FlaskConical className="w-4 h-4 text-sky-300" />
          <div className="min-w-0">
            <div className="text-xs font-black uppercase tracking-widest text-sky-100">Underfit</div>
            <div className="text-xs font-bold uppercase tracking-wider text-zinc-600 truncate">
              LoRA trainer · localhost:{underfitPort} · {reachable ? 'connected' : 'waiting for server'}
            </div>
          </div>
          <span className="w-px h-5 bg-white/10 shrink-0" />
          <DadabotsCredit className="shrink-0" />
        </div>
        <div className="flex items-center gap-1.5">
          {/* Upstream update check/apply — dada-bots/underfit vendored subrepo.
              Click checks (force-refreshes the cached status); when an update
              is available, a second button applies it via git subrepo pull. */}
          <button
            type="button"
            onClick={() => void checkForUpdate(true)}
            disabled={checkingUpdate}
            className={`px-1.5 py-0.5 rounded border text-xs font-bold uppercase tracking-widest flex items-center gap-1 transition-colors disabled:opacity-60 disabled:pointer-events-none ${
              updateStatus?.error
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                : updateStatus?.update_available
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
                : 'border-white/10 text-zinc-500 hover:text-zinc-200 hover:border-white/20 hover:bg-white/5'
            }`}
            title={`Check for updates to Underfit. ${describeUnderfitUpdateStatus(updateStatus)}`}
            aria-label="Check for Underfit updates"
          >
            {checkingUpdate ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />}
            {underfitCheckButtonLabel(updateStatus)}
          </button>
          {updateStatus?.update_available && (
            <button
              type="button"
              onClick={() => void applyUpdate()}
              disabled={applyingUpdate}
              className="px-1.5 py-0.5 rounded border border-amber-500/50 bg-amber-500/15 text-xs font-bold uppercase tracking-widest text-amber-200 hover:bg-amber-500/25 flex items-center gap-1 disabled:opacity-60 disabled:pointer-events-none"
              title="Pull the upstream update into the vendored subrepo and restart the dashboard"
              aria-label="Apply Underfit update"
            >
              {applyingUpdate ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
              Update
            </button>
          )}
          <button
            type="button"
            onClick={reload}
            className="p-1.5 rounded border border-white/5 hover:bg-white/5 text-zinc-400 hover:text-zinc-100"
            title="Reload Underfit"
            aria-label="Reload Underfit"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <a
            href={underfitUrl}
            target="_blank"
            rel="noreferrer"
            className="p-1.5 rounded border border-sky-500/30 hover:bg-sky-500/15 text-sky-300 hover:text-sky-100"
            title="Open Underfit in a separate browser tab"
            aria-label="Open Underfit externally"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {updateResult && !updateResult.ok && (
        <p
          role="alert"
          className="shrink-0 px-3 py-1.5 border-b border-rose-500/40 bg-rose-500/10 text-xs font-mono leading-relaxed text-rose-200 whitespace-pre-wrap wrap-break-word"
        >
          {updateResult.message ?? 'Underfit update failed.'}
        </p>
      )}

      <div className="flex-1 min-h-0 relative bg-black">
        {!reachable && installIssues && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-8 text-zinc-300">
            <AlertTriangle className="w-6 h-6 text-amber-400" />
            <span className="text-sm font-semibold text-amber-100">
              {needsRepair
                ? "Underfit's environment is incomplete"
                : "Underfit isn't installed on this machine yet"}
            </span>
            <ul className="max-w-xl space-y-1.5">
              {installIssues.map((issue) => (
                <li key={issue} className="text-xs font-semibold tabular-nums text-zinc-400 leading-relaxed">
                  • {issue}
                </li>
              ))}
            </ul>
            <div className="max-w-xl text-center text-xs font-semibold text-zinc-500 leading-relaxed">
              {needsRepair
                ? 'A previous setup did not finish, so the environment has an interpreter but no packages. Rerunning it installs only what is missing.'
                : 'theDAW can build the trainer environment here. This runs a one-time dependency sync. The model packs download later, on demand.'}
              {' '}It downloads roughly 2.5 GB (torch + torchaudio), so expect 10–30 minutes on a
              first run. Leave theDAW open while it works — quitting midway is what leaves the
              environment half-built.
            </div>
            {setupMsg && (
              <div
                className={`max-w-xl text-center text-xs font-semibold tabular-nums leading-relaxed ${
                  setupState === 'error' ? 'text-red-300' : 'text-zinc-400'
                }`}
              >
                {setupMsg}
              </div>
            )}
            {setupState === 'running' && setupLog && (
              <pre
                aria-live="polite"
                className="max-w-xl w-full max-h-32 overflow-y-auto rounded border border-white/10 bg-black/40 px-2.5 py-2 text-xs font-mono leading-relaxed text-zinc-400 whitespace-pre-wrap wrap-break-word text-left"
              >
                {setupLog}
              </pre>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void createEnv()}
                disabled={setupState === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-sky-500/30 hover:bg-sky-500/15 text-xs font-semibold text-sky-200 disabled:opacity-50"
              >
                {setupState === 'running' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5" />
                )}
                {setupState === 'running'
                  ? 'Building environment...'
                  : needsRepair
                    ? 'Repair environment'
                    : 'Create environment'}
              </button>
              <button
                type="button"
                onClick={() => void fetchDiag()}
                className="px-3 py-1.5 rounded border border-white/10 hover:bg-white/5 text-xs font-semibold text-zinc-300"
              >
                Re-check
              </button>
            </div>
          </div>
        )}
        {!reachable && !installIssues && diag && !diag.listening && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <FlaskConical className="w-5 h-5 text-sky-300" />
            <span className="text-sm">Underfit is installed but not running</span>
            <span className="text-xs font-semibold tabular-nums text-zinc-600">{diag.project_path} · port {diag.port}</span>
            <button
              type="button"
              onClick={() => void startServer()}
              disabled={starting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-sky-500/30 hover:bg-sky-500/15 text-xs font-semibold text-sky-200 disabled:opacity-50"
            >
              {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {starting ? 'Starting…' : 'Start Underfit'}
            </button>
            {startError && (
              <p
                role="alert"
                className="max-w-lg rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-xs font-mono leading-relaxed text-rose-200 whitespace-pre-wrap wrap-break-word text-left"
              >
                {startError}
              </p>
            )}
          </div>
        )}
        {!reachable && !installIssues && (!diag || diag.listening) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
            <span className="text-sm">Connecting to Underfit…</span>
            <span className="text-xs font-semibold tabular-nums text-zinc-600">
              Waiting for the dashboard server on :{underfitPort} (auto-retrying every 3s)
            </span>
          </div>
        )}
        {reachable && (
          <iframe
            key={reloadKey}
            src={underfitFrameSrc(underfitUrl, reloadKey, assistantUrl)}
            allow="clipboard-write; fullscreen; autoplay"
            className="w-full h-full border-0 bg-black"
            title="Underfit"
          />
        )}
      </div>
    </div>
  );
};
