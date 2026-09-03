/**
 * Model download store — drives the floating DownloadDock.
 *
 * The dock is the single owner of download progress/error state. Settings
 * model chips are thin triggers: they call `startDownload(name)` and read job
 * status for display, but never poll or hold their own busy/error state.
 *
 * Two sources feed one job list:
 *   - Stable Audio checkpoints from /api/models (Hugging Face, this PC);
 *   - Magenta RT2 checkpoints from /api/magenta/engine/checkpoints — fetched
 *     by the sidecar's own CLI inside WSL. Their progress is parsed from the
 *     CLI log (best-effort), so bytes can lag; speed is derived here from
 *     consecutive polls.
 *
 * Lifecycle:
 *   - `startDownload` POSTs the job, then ensures the poll loop is running.
 *   - The poll loop (~1s) calls `refresh()` while ANY job is queued/downloading.
 *   - When no job is active it STOPS the interval but KEEPS the jobs in state,
 *     so finished/errored rows persist for the user to read and clear.
 *   - A page reload drops this store, but NOT the backend's job registry, so
 *     `rehydrate()` re-attaches on startup (App.tsx). Without it a failed
 *     download — and the Retry / token controls on its row — becomes
 *     unreachable the moment the page refreshes.
 */
import { create } from 'zustand';
import {
  clearDownloads,
  fetchDownloads,
  startModelDownload,
  type DownloadJob,
  type DownloadJobKind,
} from '../lib/modelDownloadClient';
import {
  clearMagentaCheckpointJobs,
  fetchMagentaCheckpointJobs,
  startMagentaCheckpointDownload,
  type MagentaCheckpointJob,
} from '../lib/magentaEngineClient';

const POLL_INTERVAL_MS = 1000;

/** True while the job still has work the poll loop should follow. */
const isActive = (job: DownloadJob): boolean =>
  job.status === 'queued' || job.status === 'downloading';

// Last seen byte count per magenta job, for a speed figure the CLI log lacks.
const lastBytes = new Map<string, { bytes: number; t: number; speed: number }>();

/** Shape a sidecar checkpoint job like a registry job so one dock renders both. */
function magentaJobToDownloadJob(job: MagentaCheckpointJob): DownloadJob {
  const now = Date.now();
  const prev = lastBytes.get(job.id);
  let speed = prev?.speed ?? 0;
  if (job.status === 'downloading') {
    if (prev && job.bytes_done > prev.bytes && now > prev.t) {
      speed = ((job.bytes_done - prev.bytes) * 1000) / (now - prev.t);
      lastBytes.set(job.id, { bytes: job.bytes_done, t: now, speed });
    } else if (!prev) {
      lastBytes.set(job.id, { bytes: job.bytes_done, t: now, speed: 0 });
    }
  } else {
    lastBytes.delete(job.id);
    speed = 0;
  }
  const checkpoint = job.label.match(/\(([^)]+)\)/)?.[1] ?? job.model;
  return {
    id: job.id,
    name: job.model,
    repo_id: job.repo_id,
    label: job.label,
    status: job.status,
    files: [
      {
        filename: checkpoint,
        bytes_done: job.bytes_done,
        bytes_total: job.bytes_total,
        speed,
        done: job.status === 'done',
      },
    ],
    current_file: 0,
    dest_dir: job.dest_dir,
    error_detail: job.error,
    error_repo_id: null,
    kind: 'magenta',
    percent: job.percent,
    log: job.log,
  };
}

interface DownloadStore {
  jobs: DownloadJob[];
  expanded: boolean;
  /** Internal: whether the poll interval is currently running. */
  _polling: boolean;
  /** Internal: handle for the active poll interval (guards double-intervals). */
  _timer: ReturnType<typeof setInterval> | null;

  /** Trigger a download for `name` (a Stable Audio model, or a Magenta
   *  checkpoint when `kind` is 'magenta'), then ensure the poll loop is running. */
  startDownload: (name: string, kind?: DownloadJobKind) => Promise<void>;
  /** Pull the latest jobs from the backend into state. */
  refresh: () => Promise<void>;
  /** Re-attach to the backend's jobs after a page load, resuming any live one. */
  rehydrate: () => Promise<void>;
  /** Clear finished/errored jobs on the backend, then refresh. */
  clear: () => Promise<void>;
  setExpanded: (expanded: boolean) => void;
  /** Internal: start the poll loop if not already running. */
  _ensurePolling: () => void;
  /** Internal: stop the poll loop (jobs are kept in state). */
  _stopPolling: () => void;
}

export const useDownloadStore = create<DownloadStore>((set, get) => ({
  jobs: [],
  expanded: false,
  _polling: false,
  _timer: null,

  startDownload: async (name, kind = 'model') => {
    // Open the dock so the user immediately sees the job arrive on next poll.
    set({ expanded: true });
    if (kind === 'magenta') await startMagentaCheckpointDownload(name);
    else await startModelDownload(name);
    get()._ensurePolling();
    // Surface the queued job right away rather than waiting a full tick.
    void get().refresh();
  },

  refresh: async () => {
    // The two sources fail independently: a Magenta module that is switched
    // off (404) must not hide Stable Audio downloads, and vice versa.
    const [models, magenta] = await Promise.all([
      fetchDownloads().catch(() => null),
      fetchMagentaCheckpointJobs().catch(() => null),
    ]);
    if (models === null && magenta === null) {
      // Transient fetch failure (e.g. backend restarting) — keep the last
      // known jobs and let the next tick retry. Don't tear down the dock.
      return;
    }
    const previous = get().jobs;
    const modelJobs = models ?? previous.filter((j) => (j.kind ?? 'model') === 'model');
    const magentaJobs = magenta
      ? magenta.map(magentaJobToDownloadJob)
      : previous.filter((j) => j.kind === 'magenta');
    const jobs = [...modelJobs.map((j) => ({ ...j, kind: j.kind ?? ('model' as const) })), ...magentaJobs];
    set({ jobs });
    // Once nothing is active, stop polling but keep the rows on screen.
    if (!jobs.some(isActive)) get()._stopPolling();
  },

  rehydrate: async () => {
    await get().refresh();
    // A download can outlive the page that started it, so pick the poll loop
    // back up rather than leaving a live job frozen at its last known bytes.
    if (get().jobs.some(isActive)) get()._ensurePolling();
  },

  clear: async () => {
    try {
      await Promise.all([clearDownloads(), clearMagentaCheckpointJobs()]);
      await get().refresh();
    } catch {
      // Fall back to dropping finished/errored rows locally so the UI still
      // reflects the user's intent even if the backend call failed.
      set((state) => ({ jobs: state.jobs.filter(isActive) }));
    }
    // Nothing left to follow once cleared.
    if (!get().jobs.some(isActive)) get()._stopPolling();
  },

  setExpanded: (expanded) => set({ expanded }),

  _ensurePolling: () => {
    if (get()._polling || get()._timer) return; // guard against double-intervals
    const timer = setInterval(() => {
      void get().refresh();
    }, POLL_INTERVAL_MS);
    set({ _polling: true, _timer: timer });
  },

  _stopPolling: () => {
    const { _timer } = get();
    if (_timer) clearInterval(_timer);
    set({ _polling: false, _timer: null });
  },
}));
