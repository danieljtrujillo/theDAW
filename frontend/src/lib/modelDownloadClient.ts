// Model download client — thin fetch wrappers over /api/models for the
// download manager. Backs the floating DownloadDock and the Settings model
// chips that trigger a checkpoint download.
//
// API contract (backend, snake_case JSON):
//   POST /api/models/{name}/download   -> { job_id, name, status }
//   GET  /api/models/downloads         -> { jobs: DownloadJob[] }
//   POST /api/models/downloads/clear   -> { cleared: number }

export type DownloadJobStatus = 'queued' | 'downloading' | 'done' | 'error';

export interface DownloadFile {
  filename: string;
  bytes_done: number;
  bytes_total: number;
  speed: number;
  done: boolean;
}

export interface DownloadJob {
  id: string;
  name: string;
  repo_id: string;
  label: string;
  status: DownloadJobStatus;
  files: DownloadFile[];
  current_file: number;
  dest_dir: string;
  error_detail: string | null;
  error_repo_id: string | null;
}

interface DownloadsResponse {
  jobs?: DownloadJob[];
}

/** Read the backend's `detail` field (FastAPI error shape) if present. */
async function readDetail(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { detail?: unknown } | null;
    const detail = body?.detail;
    return typeof detail === 'string' ? detail : null;
  } catch {
    return null;
  }
}

/**
 * Kick off a model download. The dock owns all progress/error state — this
 * resolves once the backend has accepted (queued) the job; the poll loop
 * surfaces it on the next tick.
 */
export async function startModelDownload(name: string): Promise<void> {
  const res = await fetch(`/api/models/${encodeURIComponent(name)}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const detail = await readDetail(res);
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
}

/** Fetch the current download jobs (queued / downloading / done / error). */
export async function fetchDownloads(): Promise<DownloadJob[]> {
  const res = await fetch('/api/models/downloads');
  if (!res.ok) {
    const detail = await readDetail(res);
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
  const data = (await res.json()) as DownloadsResponse;
  return data.jobs ?? [];
}

/** Clear finished/errored jobs from the backend registry. */
export async function clearDownloads(): Promise<void> {
  const res = await fetch('/api/models/downloads/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const detail = await readDetail(res);
    throw new Error(detail ?? `HTTP ${res.status}`);
  }
}

export interface ClassifiedDownloadError {
  kind: 'network' | 'disk' | 'gated' | 'unknown';
  headline: string;
  fix: string;
  repoUrl?: string;
}

/**
 * Map a raw backend error detail to an actionable, human-readable cause + fix.
 *
 * ORDER MATTERS: a network failure can contain words that also appear in a
 * gated-access error (e.g. a "connection" reset while hitting a 403-style
 * path), so network is tested FIRST and gated LAST so a transient network
 * error is never misreported as a permissions problem.
 */
export function classifyDownloadError(detail: string, repoId?: string): ClassifiedDownloadError {
  const text = detail ?? '';

  // 1. Network — transient connectivity / DNS / retry exhaustion.
  if (/timeout|timed out|connection|temporarily|network|getaddrinfo|max retries|connreset/i.test(text)) {
    return {
      kind: 'network',
      headline: 'network error',
      fix: 'Check your internet connection, then retry.',
    };
  }

  // 2. Disk — out of space on the cache drive.
  if (/no space|enospc|errno 28|disk full/i.test(text)) {
    return {
      kind: 'disk',
      headline: 'not enough disk space',
      fix: 'Free up space on the Hugging Face cache drive, then retry.',
    };
  }

  // 3. Gated — auth / access not granted to the repo.
  if (/gated|401|403|unauthorized|authenticated|repository not found|restricted|awaiting a review|accept the/i.test(text)) {
    return {
      kind: 'gated',
      headline: 'access not granted (gated model)',
      fix: 'Open the model page, sign in, click “Agree and access”, then set HF_TOKEN. Retry after access is granted.',
      repoUrl: repoId ? `https://huggingface.co/${repoId}` : undefined,
    };
  }

  // 4. Unknown — surface the raw detail so the user has something to act on.
  return {
    kind: 'unknown',
    headline: 'download failed',
    fix: text || 'Unknown error — retry, or check the backend log.',
  };
}
