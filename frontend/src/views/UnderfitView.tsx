import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AlertTriangle, ExternalLink, FlaskConical, Loader2, Play, RefreshCw } from 'lucide-react';
import { DadabotsCredit } from '../components/ui/Credit';

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
const UNDERFIT_URL = 'http://localhost:8791';
const PING_INTERVAL_MS = 3000;

/** Sidecar probe payload from GET /api/underfit/status (backend/modules/underfit). */
interface UnderfitStatus {
  ok: boolean;
  listening: boolean;
  process_alive: boolean;
  project_path: string;
  port: number;
  issues: string[];
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
  // Tracks the last known reachability so we only remount the iframe on a
  // down→up transition (not on every successful poll).
  const wasReachable = useRef(false);
  const diagInFlight = useRef(false);

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
      // connection error — so this works even though :8791 sends no CORS headers.
      await fetch(`${UNDERFIT_URL}/?_ping=${Date.now()}`, { mode: 'no-cors', cache: 'no-store' });
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
  }, [reachable, fetchDiag]);

  useEffect(() => {
    void ping();
    const id = window.setInterval(() => void ping(), PING_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [ping]);

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
      let j: { state?: string; message?: string };
      try {
        const res = await fetch('/api/underfit/setup-status', { cache: 'no-store' });
        j = (await res.json()) as { state?: string; message?: string };
      } catch {
        setSetupState('error');
        setSetupMsg('Lost contact with the backend during setup.');
        return;
      }
      const state = (j.state as typeof setupState) ?? 'idle';
      setSetupState(state);
      setSetupMsg(j.message ?? '');
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
      <div className="h-10 shrink-0 flex items-center justify-between gap-3 px-3 border-b border-white/5 bg-[#0a080f]">
        <div className="flex items-center gap-2 min-w-0">
          <FlaskConical className="w-4 h-4 text-sky-300" />
          <div className="min-w-0">
            <div className="text-[10px] font-black uppercase tracking-widest text-sky-100">Underfit</div>
            <div className="text-[8px] font-mono uppercase tracking-wider text-zinc-600 truncate">
              LoRA trainer · localhost:8791 · {reachable ? 'connected' : 'waiting for server'}
            </div>
          </div>
          <span className="w-px h-5 bg-white/10 shrink-0" />
          <DadabotsCredit className="shrink-0" />
        </div>
        <div className="flex items-center gap-1.5">
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
            href={UNDERFIT_URL}
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
                <li key={issue} className="text-[11px] font-mono text-zinc-400 leading-relaxed">
                  • {issue}
                </li>
              ))}
            </ul>
            <div className="max-w-xl text-center text-[11px] text-zinc-500 leading-relaxed">
              {needsRepair
                ? 'A previous setup did not finish, so the environment has an interpreter but no packages. Rerunning it installs only what is missing.'
                : 'theDAW can build the trainer environment here. This runs a one-time dependency sync. The model packs download later, on demand.'}
              {' '}It downloads roughly 2.5 GB (torch + torchaudio), so expect 10–30 minutes on a
              first run. Leave theDAW open while it works — quitting midway is what leaves the
              environment half-built.
            </div>
            {setupMsg && (
              <div
                className={`max-w-xl text-center text-[11px] font-mono leading-relaxed ${
                  setupState === 'error' ? 'text-red-300' : 'text-zinc-400'
                }`}
              >
                {setupMsg}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void createEnv()}
                disabled={setupState === 'running'}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-sky-500/30 hover:bg-sky-500/15 text-[11px] text-sky-200 disabled:opacity-50"
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
                className="px-3 py-1.5 rounded border border-white/10 hover:bg-white/5 text-[11px] text-zinc-300"
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
            <span className="text-[10px] font-mono text-zinc-600">{diag.project_path} · port {diag.port}</span>
            <button
              type="button"
              onClick={() => void startServer()}
              disabled={starting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-sky-500/30 hover:bg-sky-500/15 text-[11px] text-sky-200 disabled:opacity-50"
            >
              {starting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {starting ? 'Starting…' : 'Start Underfit'}
            </button>
            {startError && (
              <p
                role="alert"
                className="max-w-lg rounded border border-rose-500/40 bg-rose-500/10 px-2.5 py-2 text-[10px] font-mono leading-relaxed text-rose-200 whitespace-pre-wrap wrap-break-word text-left"
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
            <span className="text-[10px] font-mono text-zinc-600">
              Waiting for the dashboard server on :8791 (auto-retrying every 3s)
            </span>
          </div>
        )}
        {reachable && (
          <iframe
            key={reloadKey}
            src={`${UNDERFIT_URL}/?_t=${reloadKey}`}
            allow="clipboard-write; fullscreen; autoplay"
            className="w-full h-full border-0 bg-black"
            title="Underfit"
          />
        )}
      </div>
    </div>
  );
};
