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
  kind: 'network' | 'disk' | 'rate_limit' | 'not_found' | 'gated' | 'unknown';
  headline: string;
  fix: string;
  repoUrl?: string;
}

/**
 * Map a raw backend error into a clean headline + a concrete solution.
 *
 * ORDER MATTERS. Transient causes (network/disk/rate-limit) are tested first so
 * a blip is never mislabeled as a permissions problem. Critically, Hugging Face
 * reports BOTH "this file isn't in the repo" (`Entry Not Found`) and "you can't
 * access this repo" (`Repository Not Found`) as HTTP 404 — so those two are
 * matched by exact phrase and kept distinct, because the fix differs.
 */
export function classifyDownloadError(detail: string, repoId?: string): ClassifiedDownloadError {
  const text = detail ?? '';
  const repoUrl = repoId ? `https://huggingface.co/${repoId}` : undefined;

  // 1. Network — transient connectivity / DNS / retry exhaustion.
  if (
    /timeout|timed out|connection|temporarily|unreachable|getaddrinfo|max retries|connreset|name (or service )?not known|failed to (establish|resolve)/i.test(
      text,
    )
  ) {
    return {
      kind: 'network',
      headline: "Can't reach Hugging Face",
      fix: 'Check your internet connection (or VPN/proxy), then click the chip to retry.',
    };
  }

  // 2. Disk — out of space on the cache drive.
  if (/no space|enospc|errno 28|disk (is )?full|not enough space/i.test(text)) {
    return {
      kind: 'disk',
      headline: 'Not enough disk space',
      fix: 'Free up room on the Hugging Face cache drive (defaults to your user profile), then retry.',
    };
  }

  // 3. Rate limited by the Hub.
  if (/\b429\b|too many requests|rate limit/i.test(text)) {
    return {
      kind: 'rate_limit',
      headline: 'Hugging Face is rate-limiting',
      fix: 'Wait a minute, then retry. Setting an HF_TOKEN raises the download limit.',
    };
  }

  // 4. File missing — the repo is reachable but this file is not in it.
  if (/entry not found|file not found|does not exist/i.test(text)) {
    return {
      kind: 'not_found',
      headline: "That file isn't in this repo",
      fix: 'The checkpoint may be published under a different name or not released yet — open the repo to check its files.',
      repoUrl,
    };
  }

  // 5. Gated / no access — license not accepted, or no token for a gated repo.
  if (
    /gated|\b401\b|\b403\b|unauthorized|not authorized|must be authenticated|authentication|repository not found|restricted|awaiting (a )?review|agree to access|accept the (license|conditions)|access to this/i.test(
      text,
    )
  ) {
    return {
      kind: 'gated',
      headline: 'Access not granted (gated model)',
      fix: 'Sign in to Hugging Face, open the model page and click “Agree and access”, then set an HF_TOKEN for that account and retry. If you already have access, double-check the repo name.',
      repoUrl,
    };
  }

  // 6. Unknown — surface a trimmed first line so there is something to act on.
  const firstLine = text.trim().split('\n')[0].slice(0, 160);
  return {
    kind: 'unknown',
    headline: 'Download failed',
    fix: firstLine || 'Unknown error — retry, or check the backend log for details.',
    repoUrl,
  };
}
