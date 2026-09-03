// Magenta RT2 engine client — lifecycle, model pick, checkpoint downloads.
//
// The backend (/api/magenta/engine/*) owns the actual lifecycle: it parks SA3
// in CPU RAM (frees the GPU), starts the WSL2 engine, and probes it to READY.
// This client drives those endpoints, mirrors the state into the params store
// for the MAKE dropdown pill, and turns the backend's machine-readable engine
// state into the right card for the user:
//
//   not_installed  -> "Install now" card (launches the consented installer)
//   probe_failed   -> "Retry" card (WSL did not answer; NOT "not installed")
//   not_running    -> start the engine on demand with a live progress card
//                     ("Starting Magenta engine (about 2-3 min)…"), then let
//                     the caller retry its action
//   starting       -> attach to the same progress card
//   error          -> "Restart engine" card carrying the engine's own error
//   running        -> nothing to do
//
// Every 412 from /api/magenta/* carries `detail.state` with one of those
// values (plus the legacy `setup_required` / `installable` / `message`), so
// no surface has to guess from prose. `magentaFetch` is the drop-in for a
// plain fetch of a Magenta endpoint: it handles the 412, brings the engine
// up when that is all that is missing, and re-sends the request once.
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { dismissFeatureGate, requireFeature, useFeatureGateStore } from '../notices/featureGateStore';
import { logError, logInfo } from '../state/logStore';

const READY_DEADLINE_MS = 10 * 60_000; // model load + one-time JAX compile
const POLL_INTERVAL_MS = 3000;
const INSTALL_WATCH_INTERVAL_MS = 20_000;
const INSTALL_WATCH_DEADLINE_MS = 45 * 60_000;

/** Notice ids: the install/setup card and the live engine-start card. */
export const MAGENTA_GATE_ID = 'magenta:setup';
export const MAGENTA_ENGINE_NOTICE_ID = 'magenta:engine';

export type MagentaEngineState =
  | 'running'
  | 'starting'
  | 'error'
  | 'not_running'
  | 'not_installed'
  | 'probe_failed';

const ENGINE_STATES = new Set<string>([
  'running',
  'starting',
  'error',
  'not_running',
  'not_installed',
  'probe_failed',
]);

export interface MagentaSetupState {
  wsl: boolean;
  venv: boolean;
  deps: boolean;
  checkpoint: boolean;
  /** Checkpoint files present in the sidecar's assets dir. */
  checkpoints?: string[];
  ready: boolean;
  probe_failed?: boolean;
  probe_error?: string | null;
}

export interface MagentaEngineStatus {
  available: boolean;
  reachable: boolean;
  protocol_ok: boolean;
  url?: string;
  state: MagentaEngineState;
  /** The engine's own status line while loading ("loading mrt2_small + compiling"). */
  status?: string;
  error?: string | null;
  /** Model the running engine loaded (from its /health). */
  model?: string;
  device?: string;
  /** Model the NEXT start loads (the persisted pick). */
  active_model?: string;
  process_alive?: boolean;
  setup_required?: boolean;
  setup?: MagentaSetupState;
  installable?: boolean;
}

/** The 412 detail shape (backend `_gate_detail`). */
export interface MagentaGateDetail {
  state?: MagentaEngineState | string;
  setup_required?: boolean;
  installable?: boolean;
  message?: string;
  probe_error?: string | null;
  ready?: boolean;
}

export interface MagentaCheckpointJob {
  id: string;
  kind: 'magenta';
  model: string;
  name: string;
  label: string;
  repo_id: string;
  status: 'downloading' | 'done' | 'error';
  percent: number;
  bytes_done: number;
  bytes_total: number;
  dest_dir: string;
  started_at: number;
  finished_at: number | null;
  error: string | null;
  log: string;
  log_tail?: string;
}

export type MagentaRunnable = 'yes' | 'tight' | 'no' | 'unknown';

export interface MagentaModelInfo {
  id: string;
  label: string;
  params: string;
  checkpoint: string;
  repo_id: string;
  download_bytes: number | null;
  installed: boolean;
  active: boolean;
  runnable: MagentaRunnable;
  reason: string;
  download: MagentaCheckpointJob | null;
}

export interface MagentaGpuInfo {
  gpus: Array<{ name: string; vram_gb: number }>;
  best_vram_gb: number | null;
}

export interface MagentaModelCatalog {
  active: string;
  running_model: string | null;
  state: MagentaEngineState;
  gpu: MagentaGpuInfo;
  models: MagentaModelInfo[];
  setup?: MagentaSetupState;
}

// Rapid dropdown flips supersede each other; only the latest swap may write state.
let _swapToken = 0;

const setField = <K extends 'magentaEngine' | 'magentaAvailable'>(
  key: K,
  value: K extends 'magentaEngine' ? 'off' | 'starting' | 'ready' | 'error' | 'setup' : boolean,
): void => {
  useGenerateParamsStore.getState().setField(key, value as never);
};

/** Pull the `detail` object out of a FastAPI error body (or a bare detail). */
export function readMagentaGate(body: unknown): MagentaGateDetail {
  const outer = body as { detail?: unknown } | null;
  const detail = outer && typeof outer === 'object' && 'detail' in outer ? outer.detail : body;
  if (typeof detail === 'string') return { message: detail };
  if (detail && typeof detail === 'object') return detail as MagentaGateDetail;
  return {};
}

/** The engine state a 412 detail describes; older backends only sent `setup_required`. */
export function magentaGateState(detail: MagentaGateDetail | null | undefined): MagentaEngineState {
  const state = detail?.state;
  if (typeof state === 'string' && ENGINE_STATES.has(state)) return state as MagentaEngineState;
  return detail?.setup_required === false ? 'not_running' : 'not_installed';
}

async function readErrorMessage(r: Response, fallback: string): Promise<string> {
  const body = await r.json().catch(() => null);
  const detail = readMagentaGate(body);
  return detail.message || fallback;
}

/** Live engine status. `refresh` bypasses the backend's install-probe cache. */
export async function fetchMagentaEngineStatus(opts: { refresh?: boolean } = {}): Promise<MagentaEngineStatus | null> {
  try {
    const r = await fetch(`/api/magenta/engine/status${opts.refresh ? '?refresh=1' : ''}`);
    if (!r.ok) return null;
    const d = (await r.json()) as Partial<MagentaEngineStatus>;
    const state: MagentaEngineState =
      typeof d.state === 'string' && ENGINE_STATES.has(d.state)
        ? d.state
        : d.available
          ? 'running'
          : d.setup_required
            ? 'not_installed'
            : 'not_running';
    return { available: false, reachable: false, protocol_ok: false, ...d, state };
  } catch {
    return null;
  }
}

/**
 * Launch the one-time installer. The backend opens its console — where it
 * states what it needs and asks for consent — and returns immediately, so this
 * resolves as soon as that window is up, not when the install finishes.
 *
 * This exists so no surface ever has to tell a user to go find and run a
 * script: every "Magenta is not installed" state offers this as a button.
 * A watcher then polls the install so the "not installed" cards clear on
 * their own the moment the installer lands, instead of sticking around.
 */
export async function installMagentaEngine(): Promise<void> {
  const r = await fetch('/api/magenta/engine/install', { method: 'POST' });
  if (!r.ok) {
    throw new Error(await readErrorMessage(r, `install → HTTP ${r.status}`));
  }
  const d = (await r.json().catch(() => null)) as { already_installed?: boolean } | null;
  if (d?.already_installed) {
    logInfo('magenta', 'Already installed — nothing to do.');
    dismissFeatureGate(MAGENTA_GATE_ID);
    window.dispatchEvent(new CustomEvent('thedaw:magenta-installed'));
    return;
  }
  logInfo('magenta', 'Installer opened in its own window — follow the prompts there.');
  watchMagentaInstall();
}

let _installWatch: ReturnType<typeof setInterval> | null = null;

/** Poll the install probe until it reports ready, then clear the setup cards. */
export function watchMagentaInstall(): void {
  if (_installWatch) return;
  const deadline = Date.now() + INSTALL_WATCH_DEADLINE_MS;
  _installWatch = setInterval(() => {
    void (async () => {
      const s = await fetchMagentaEngineStatus({ refresh: true });
      const ready = s?.setup?.ready || s?.state === 'running' || s?.state === 'not_running';
      if (ready) {
        if (_installWatch) clearInterval(_installWatch);
        _installWatch = null;
        dismissFeatureGate(MAGENTA_GATE_ID);
        setField('magentaEngine', 'off');
        requireFeature({
          id: 'magenta:installed',
          kind: 'success',
          title: 'Magenta RT2 installed',
          message: 'The engine starts on its own the first time you use a Magenta tool.',
          autoDismissMs: 8000,
        });
        logInfo('magenta', 'Install detected — Magenta RT2 is ready to start.');
        window.dispatchEvent(new CustomEvent('thedaw:magenta-installed'));
      } else if (Date.now() > deadline && _installWatch) {
        clearInterval(_installWatch);
        _installWatch = null;
      }
    })();
  }, INSTALL_WATCH_INTERVAL_MS);
}

/**
 * Raise the right card for a Magenta engine state. Existing callers pass a
 * 412's `message` + `installable`; pass `detail.state` as the third argument
 * so an installed-but-idle engine is STARTED instead of being reported as
 * "not installed" (the default, kept for older backends that only sent
 * `setup_required`).
 */
export function raiseMagentaSetupGate(
  message?: string,
  installable = true,
  state: MagentaEngineState | string = 'not_installed',
): void {
  const st: MagentaEngineState = ENGINE_STATES.has(state) ? (state as MagentaEngineState) : 'not_installed';
  switch (st) {
    case 'running':
      dismissFeatureGate(MAGENTA_GATE_ID);
      return;
    case 'not_running':
    case 'starting':
      void ensureMagentaEngine();
      return;
    case 'probe_failed':
      requireFeature({
        id: MAGENTA_GATE_ID,
        kind: 'module',
        title: 'Magenta RT2 check did not answer',
        message:
          message ||
          'Could not check whether the Magenta engine is installed (WSL did not answer). It is not necessarily missing — retry in a moment.',
        action: {
          label: 'Retry check',
          run: async () => {
            const s = await fetchMagentaEngineStatus({ refresh: true });
            if (!s || s.state === 'probe_failed') throw new Error('still no answer');
            raiseMagentaSetupGate(undefined, s.installable !== false, s.state);
          },
        },
      });
      return;
    case 'error':
      requireFeature({
        id: MAGENTA_GATE_ID,
        kind: 'error',
        title: 'Magenta engine failed to load',
        message: message || 'The engine is up but its model did not load. Restart it, or pick another model in Settings → Models.',
        action: { label: 'Restart engine', run: () => restartMagentaEngine().then(() => undefined) },
      });
      return;
    default:
      requireFeature({
        id: MAGENTA_GATE_ID,
        kind: 'module',
        title: 'Magenta RT2 not installed',
        message: message || 'The Magenta RT2 engine is not installed yet.',
        action: installable ? { label: 'Install now', run: () => installMagentaEngine() } : undefined,
      });
  }
}

let _ensureInFlight: Promise<boolean> | null = null;

const fmtMinutes = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/**
 * Bring the engine up on demand, showing progress where the user is looking.
 * Resolves true when the engine is running (so the caller can retry its
 * action), false when it cannot be started from here — in which case the
 * matching card (Install / Retry / Restart) is already up. Concurrent calls
 * share one start.
 */
export function ensureMagentaEngine(): Promise<boolean> {
  if (_ensureInFlight) return _ensureInFlight;
  _ensureInFlight = (async () => {
    const started = Date.now();
    const progress = (line: string) => {
      requireFeature({
        id: MAGENTA_ENGINE_NOTICE_ID,
        kind: 'progress',
        title: 'Starting Magenta engine',
        message: `About 2–3 minutes (first start compiles once). ${line} · ${fmtMinutes(Date.now() - started)}`,
      });
    };
    try {
      let s = await fetchMagentaEngineStatus();
      if (!s) {
        logError('magenta', 'Engine status unreachable (backend down?)');
        return false;
      }
      if (s.state === 'running') {
        setField('magentaAvailable', true);
        setField('magentaEngine', 'ready');
        return true;
      }
      if (s.state === 'not_installed' || s.state === 'probe_failed') {
        setField('magentaEngine', s.state === 'not_installed' ? 'setup' : 'error');
        raiseMagentaSetupGate(
          s.state === 'probe_failed' ? s.setup?.probe_error || undefined : undefined,
          s.installable !== false,
          s.state,
        );
        return false;
      }
      if (s.state === 'error') {
        setField('magentaEngine', 'error');
        raiseMagentaSetupGate(s.error || s.status || undefined, true, 'error');
        return false;
      }
      setField('magentaEngine', 'starting');
      dismissFeatureGate(MAGENTA_GATE_ID);
      progress('Parking Stable Audio and spawning the WSL2 engine…');
      if (s.state === 'not_running') {
        const r = await fetch('/api/magenta/engine/start', { method: 'POST' });
        if (!r.ok) {
          const detail = readMagentaGate(await r.json().catch(() => null));
          if (r.status === 412) {
            const st = magentaGateState(detail);
            dismissFeatureGate(MAGENTA_ENGINE_NOTICE_ID);
            setField('magentaEngine', st === 'not_installed' ? 'setup' : 'error');
            raiseMagentaSetupGate(detail.message, detail.installable !== false, st);
            return false;
          }
          throw new Error(detail.message || `engine start → HTTP ${r.status}`);
        }
        logInfo('magenta', 'Engine starting: SA3 parked, WSL2 sidecar spawning');
      }
      const deadline = Date.now() + READY_DEADLINE_MS;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
        s = await fetchMagentaEngineStatus();
        if (!s) continue;
        if (s.state === 'running') {
          dismissFeatureGate(MAGENTA_ENGINE_NOTICE_ID);
          setField('magentaAvailable', true);
          setField('magentaEngine', 'ready');
          logInfo('magenta', `Engine READY (${s.model ?? 'mrt2'} on ${s.device ?? 'GPU'})`);
          requireFeature({
            id: 'magenta:engine-ready',
            kind: 'success',
            title: 'Magenta engine ready',
            message: `${s.model ?? 'mrt2'} is loaded on ${s.device ?? 'the GPU'}. Run your Magenta action again.`,
            autoDismissMs: 6000,
          });
          return true;
        }
        if (s.state === 'error') {
          dismissFeatureGate(MAGENTA_ENGINE_NOTICE_ID);
          setField('magentaEngine', 'error');
          raiseMagentaSetupGate(s.error || s.status || undefined, true, 'error');
          logError('magenta', `Engine failed to load: ${s.error || s.status || 'unknown error'}`);
          return false;
        }
        if (s.state === 'not_running' && !s.process_alive) {
          // The process died before opening its port — the log has the why.
          throw new Error('the engine process exited before it was ready (see logs/magenta-sidecar.log)');
        }
        progress(s.status ? `Engine: ${s.status}` : 'Waiting for the engine to answer…');
      }
      throw new Error('engine did not become ready within 10 minutes');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dismissFeatureGate(MAGENTA_ENGINE_NOTICE_ID);
      setField('magentaEngine', 'error');
      logError('magenta', `Engine start failed: ${msg}`);
      requireFeature({
        id: MAGENTA_GATE_ID,
        kind: 'error',
        title: 'Magenta engine did not start',
        message: msg,
        action: { label: 'Try again', run: () => ensureMagentaEngine().then(() => undefined) },
      });
      return false;
    } finally {
      _ensureInFlight = null;
    }
  })();
  return _ensureInFlight;
}

/** Stop every Magenta engine and restore Stable Audio to the GPU. */
export async function stopMagentaEngine(): Promise<void> {
  const r = await fetch('/api/magenta/engine/stop', { method: 'POST' });
  if (!r.ok) throw new Error(await readErrorMessage(r, `engine stop → HTTP ${r.status}`));
  setField('magentaAvailable', false);
  setField('magentaEngine', 'off');
  logInfo('magenta', 'Engine stopped; SA3 restored to the GPU');
}

/** Stop + start with the currently picked model (applies a model change). */
export async function restartMagentaEngine(): Promise<boolean> {
  dismissFeatureGate(MAGENTA_GATE_ID);
  const r = await fetch('/api/magenta/engine/restart', { method: 'POST' });
  if (!r.ok) {
    const detail = readMagentaGate(await r.json().catch(() => null));
    if (r.status === 412) {
      raiseMagentaSetupGate(detail.message, detail.installable !== false, magentaGateState(detail));
      return false;
    }
    throw new Error(detail.message || `engine restart → HTTP ${r.status}`);
  }
  logInfo('magenta', 'Engine restarting with the picked model');
  return ensureMagentaEngine();
}

/**
 * fetch() for Magenta endpoints. A 412 whose state is "installed, not
 * running" starts the engine (with the progress card) and re-sends the same
 * request once it is up; the other 412 states raise their card and the 412
 * is returned to the caller unchanged. Bodies built from FormData re-send
 * fine; a consumed stream body would not, so pass the FormData itself.
 */
export async function magentaFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const first = await fetch(input, init);
  if (first.status !== 412) return first;
  const detail = readMagentaGate(await first.clone().json().catch(() => null));
  const state = magentaGateState(detail);
  if (state === 'not_running' || state === 'starting') {
    const up = await ensureMagentaEngine();
    if (up) return fetch(input, init);
    return first;
  }
  raiseMagentaSetupGate(detail.message, detail.installable !== false, state);
  return first;
}

export async function swapEngineForModel(prevModel: string, nextModel: string): Promise<void> {
  const wasMagenta = prevModel.startsWith('magenta-');
  const isMagenta = nextModel.startsWith('magenta-');
  if (wasMagenta === isMagenta) return;
  const token = ++_swapToken;

  if (isMagenta) {
    // ensureMagentaEngine owns the state pill, the progress card, and every
    // 412 state (install / retry / restart) — a newer swap simply supersedes
    // whatever this one reports.
    const ok = await ensureMagentaEngine();
    if (_swapToken !== token) return;
    if (!ok && useGenerateParamsStore.getState().magentaEngine === 'starting') {
      setField('magentaEngine', 'error');
    }
  } else {
    try {
      await stopMagentaEngine();
    } catch (e) {
      // The lazy wake path restores SA3 at the next CREATE regardless.
      logError('magenta', `Engine stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (_swapToken === token) setField('magentaEngine', 'off');
  }
}

// ── model catalog + checkpoint downloads ──────────────────────────────────

export async function fetchMagentaModels(opts: { refresh?: boolean } = {}): Promise<MagentaModelCatalog> {
  const r = await fetch(`/api/magenta/engine/models${opts.refresh ? '?refresh=1' : ''}`);
  if (!r.ok) throw new Error(await readErrorMessage(r, `models → HTTP ${r.status}`));
  return (await r.json()) as MagentaModelCatalog;
}

/** Persist the engine model pick. Rejects with the backend's reason (e.g. not downloaded yet). */
export async function setMagentaModel(
  modelId: string,
): Promise<{ active: string; running_model: string | null; restart_required: boolean }> {
  const r = await fetch('/api/magenta/engine/model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId }),
  });
  if (!r.ok) throw new Error(await readErrorMessage(r, `set model → HTTP ${r.status}`));
  const d = (await r.json()) as { active: string; running_model: string | null; restart_required: boolean };
  logInfo('magenta', `Engine model set to ${d.active}${d.restart_required ? ' (restart the engine to apply)' : ''}`);
  return d;
}

export async function startMagentaCheckpointDownload(modelId: string): Promise<MagentaCheckpointJob> {
  const r = await fetch(`/api/magenta/engine/checkpoints/${encodeURIComponent(modelId)}/download`, {
    method: 'POST',
  });
  if (!r.ok) {
    const detail = readMagentaGate(await r.clone().json().catch(() => null));
    if (r.status === 412) raiseMagentaSetupGate(detail.message, detail.installable !== false, magentaGateState(detail));
    throw new Error(detail.message || `download → HTTP ${r.status}`);
  }
  const d = (await r.json()) as { job: MagentaCheckpointJob };
  return d.job;
}

export async function fetchMagentaCheckpointJobs(): Promise<MagentaCheckpointJob[]> {
  const r = await fetch('/api/magenta/engine/checkpoints');
  if (!r.ok) throw new Error(`checkpoints → HTTP ${r.status}`);
  const d = (await r.json()) as { jobs?: MagentaCheckpointJob[] };
  return d.jobs ?? [];
}

export async function clearMagentaCheckpointJobs(): Promise<void> {
  await fetch('/api/magenta/engine/checkpoints/clear', { method: 'POST' }).catch(() => undefined);
}

/** True while the engine-start card is up (for surfaces that want to say so). */
export function magentaEngineStarting(): boolean {
  return useFeatureGateStore.getState().notices.some((n) => n.id === MAGENTA_ENGINE_NOTICE_ID);
}
