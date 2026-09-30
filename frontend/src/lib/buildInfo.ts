/**
 * Build identity: which frontend bundle is loaded, which backend is serving it,
 * and whether the two disagree.
 *
 * The backend serves whatever frontend/dist already exists, so a fix can be in
 * source (and in the running backend) while the page is still the old bundle.
 * The Update dialog shows both SHAs and warns when they differ.
 *
 * The frontend SHA/time are compiled in by Vite `define`
 * (frontend/buildInfo.config.ts). Outside a Vite build (tsx tests) they do not
 * exist, so every read is behind a `typeof` guard.
 */

export interface BuildStamp {
  /** Short git SHA, or null when the build could not determine it. */
  sha: string | null;
  /** ISO-8601 timestamp (bundle build time / backend process start), or null. */
  time: string | null;
}

/** A usable SHA, or null for missing / empty / the build's "unknown" fallback. */
export function normalizeSha(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.toLowerCase() === 'unknown') return null;
  return s;
}

/** A parseable ISO timestamp, or null. */
export function normalizeTime(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

/** The SHA and build time compiled into this bundle. */
export function frontendBuild(): BuildStamp {
  return {
    sha: typeof __APP_BUILD_SHA__ !== 'undefined' ? normalizeSha(__APP_BUILD_SHA__) : null,
    time: typeof __APP_BUILD_TIME__ !== 'undefined' ? normalizeTime(__APP_BUILD_TIME__) : null,
  };
}

/** GET /api/updates/build → BuildStamp, tolerant of any malformed body. */
export function parseBackendBuild(raw: unknown): BuildStamp {
  const j = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { sha: normalizeSha(j.git_sha), time: normalizeTime(j.started_at) };
}

/** "2026-09-18 12:34 UTC", or "" when there is no usable time. */
export function formatBuildTime(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = new Date(t).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}

/** The SHA for display: the SHA itself, or "unknown". */
export function formatSha(sha: string | null): string {
  return sha ?? 'unknown';
}

/**
 * True only when both SHAs are known and name different commits.
 *
 * Short SHAs can come out at different lengths (git lengthens them as a repo
 * grows; THEDAW_BUILD_SHA may be a full SHA), so one being a prefix of the
 * other counts as the same commit.
 */
export function staleBundle(frontSha: string | null, backSha: string | null): boolean {
  const a = normalizeSha(frontSha)?.toLowerCase();
  const b = normalizeSha(backSha)?.toLowerCase();
  if (!a || !b) return false;
  return !(a.startsWith(b) || b.startsWith(a));
}
