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

/**
 * 'model'   — a Stable Audio checkpoint via /api/models (Hugging Face, this PC).
 * 'magenta' — a Magenta RT2 checkpoint fetched by the sidecar's own CLI inside
 *             WSL (/api/magenta/engine/checkpoints); progress is best-effort,
 *             parsed from the CLI's log, so bytes may lag or be unknown.
 */
export type DownloadJobKind = 'model' | 'magenta';

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
  /** Defaults to 'model' when absent (the /api/models registry). */
  kind?: DownloadJobKind;
  /** Whole-job percent when the source reports one (magenta). */
  percent?: number | null;
  /** Path of the log holding the raw CLI output (magenta). */
  log?: string | null;
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

export interface DownloadErrorLink {
  label: string;
  url: string;
}

export interface ClassifiedDownloadError {
  kind: 'network' | 'disk' | 'rate_limit' | 'not_found' | 'gated' | 'no_access' | 'unknown';
  headline: string;
  fix: string;
  links?: DownloadErrorLink[];
}

/**
 * Best-effort repo id scraped out of a raw Hugging Face error, so the fix-it
 * links work on paths that never carried a repo id of their own (generation,
 * model load). Two path segments only — the URL in the error continues into
 * `/resolve/main/<file>`, which is not part of the repo id.
 */
export function repoUrlFromDetail(detail: string): string | undefined {
  const m = /https:\/\/huggingface\.co\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/.exec(detail ?? '');
  return m ? `https://huggingface.co/${m[1]}` : undefined;
}

/**
 * Map a raw backend error into a clean headline + a concrete solution.
 *
 * ORDER MATTERS. Transient causes (network/disk/rate-limit) are tested first so
 * a blip is never mislabeled as a permissions problem. Critically, Hugging Face
 * reports BOTH "this file isn't in the repo" (`Entry Not Found`) and "you can't
 * access this repo" (`Repository Not Found`) as HTTP 404 — so those two are
 * matched by exact phrase and kept distinct, because the fix differs.
 *
 * The same care separates `no_access` from `gated`, which are the SAME
 * GatedRepoError with different prose. 401 "you must be authenticated" means a
 * token fixes it; 403 "you are not in the authorized list" means the token is
 * already good and only the model page can fix it. Collapsing the two hands a
 * signed-in user a token box that can never work.
 */
export function classifyDownloadError(detail: string, repoId?: string): ClassifiedDownloadError {
  const text = detail ?? '';
  const repoUrl = repoId ? `https://huggingface.co/${repoId}` : repoUrlFromDetail(text);

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
      fix: 'Wait a minute, then retry. Signing in below raises the download limit.',
    };
  }

  // 4. File missing — the repo is reachable but this file is not in it.
  if (/entry not found|file not found|does not exist/i.test(text)) {
    return {
      kind: 'not_found',
      headline: "That file isn't in this repo",
      fix: 'The checkpoint may be published under a different name or not released yet — open the repo to check its files.',
      links: repoUrl ? [{ label: 'Open repo', url: repoUrl }] : undefined,
    };
  }

  // 5. Signed in, but THIS ACCOUNT cannot have the files — it is not on the
  //    repo's allow list, the licence was never accepted, or the request is
  //    still pending. Hugging Face answers 403 for all three, and no token
  //    fixes any of them, so this must be tested BEFORE the gated branch
  //    below: offering a token box here is what sends users in circles.
  if (
    /not in the authorized list|ask for access|awaiting (a )?review|agree to access|accept the (license|licence|conditions)/i.test(
      text,
    )
  ) {
    const pending = /awaiting (a )?review|pending/i.test(text);
    return {
      kind: 'no_access',
      headline: pending ? 'Access request pending' : 'Your account needs access',
      fix: pending
        ? 'Your token is fine — Hugging Face has not approved the request yet. Retry once it is granted.'
        : 'Your token is fine — this account just is not on the repo\'s allow list. Open the model page, click "Agree and access", then retry.',
      links: repoUrl ? [{ label: 'Request access', url: repoUrl }] : undefined,
    };
  }

  // 6. Gated and NOT authenticated — the case a pasted token actually fixes.
  if (
    /gated|\b401\b|\b403\b|unauthorized|not authorized|must be authenticated|authentication|repository not found|restricted|access to this/i.test(
      text,
    )
  ) {
    return {
      kind: 'gated',
      headline: 'Sign in to Hugging Face',
      fix: 'This model is gated. Paste a token below — the download restarts on its own.',
      links: repoUrl ? [{ label: 'Open model page', url: repoUrl }] : undefined,
    };
  }

  // 7. Unknown — surface a trimmed first line so there is something to act on.
  const firstLine = text.trim().split('\n')[0].slice(0, 160);
  return {
    kind: 'unknown',
    headline: 'Download failed',
    fix: firstLine || 'Unknown error — retry, or check the backend log for details.',
    links: repoUrl ? [{ label: 'Open repo', url: repoUrl }] : undefined,
  };
}

export interface ModelGate {
  /**
   * 'local-only' — the weights are absent and the no-download setting forbids
   *                fetching them. One toggle fixes it, in-app.
   * 'sign-in'    — no valid token; pasting one fixes it.
   * 'no-access'  — the token is fine, the account is not allowed the files.
   *                Only the model page fixes this; never ask for a token.
   */
  kind: 'local-only' | 'sign-in' | 'no-access';
  /** The model page to open, when the error named it. */
  repoUrl?: string;
}

/**
 * Whether a failure is a "can't get the weights" gate the user can actually
 * clear, and which one. Returns null for everything else, so callers only
 * interrupt with a fix they can really offer.
 *
 * Local-only is tested first: it is a deliberate setting rather than a failure,
 * and it can trip on a repo whose name would otherwise read as gated.
 *
 * The Hugging Face branches in `classifyDownloadError` are deliberately broad
 * because they only ever run on download errors, where the Hub is the sole
 * source. Generation and model loading can fail for any reason at all, so this
 * adds an explicit Hugging Face signal — otherwise a stray "authentication" in
 * an unrelated traceback raises a sign-in prompt that cannot possibly help.
 */
export function classifyModelGate(detail: string): ModelGate | null {
  const text = detail ?? '';
  if (/SA3_LOCAL_ONLY|local-only mode is ON|local-only blocks/i.test(text)) {
    return { kind: 'local-only' };
  }
  const kind = classifyDownloadError(text).kind;
  if (kind !== 'gated' && kind !== 'no_access') return null;
  if (!/hugging\s?face|huggingface|hf_hub|gated repo|gated model/i.test(text)) return null;
  return {
    kind: kind === 'gated' ? 'sign-in' : 'no-access',
    repoUrl: repoUrlFromDetail(text),
  };
}
