// Hugging Face auth client — thin fetch wrappers over /api/hfauth, shared by
// every surface that can warn the user a token is needed (Settings → Models,
// the DownloadDock error block, the feature-gate notice stack).
//
// API contract (backend, snake_case JSON — backend/modules/hfauth/router.py):
//   GET  /api/hfauth/status      -> { logged_in, username, token_source, checking? }
//   POST /api/hfauth/login       -> { logged_in, username }   (401 = bad token)
//   POST /api/hfauth/logout      -> { logged_in: false }
//   GET  /api/hfauth/login-url   -> { url }
//
// `logged_in: null` is a real third state: nobody could get an answer about
// this token — either the backend could not reach the Hub, or we could not
// reach the backend. It is NOT "signed out"; reporting it as signed out is how
// a dead backend came to look like a missing token.
//
// Which hop failed, and how we know (see ./httpError):
//   503 + x-thedaw-hop: huggingface  the backend answered; the HUB hop failed
//   502 / 504, no hop header         a gateway answered; the BACKEND never did
// The backend used to raise 502 for a bad answer from the Hub, which meant the
// same status carried both meanings and neither could be trusted (issue #144).

import {
  HOP_HEADER,
  HOP_HUGGINGFACE,
  BACKEND_UNREACHABLE,
  describeHttpError,
  detailFromResponse,
} from './httpError';

/** Where the detected token came from. 'env' wins over 'stored' on the backend. */
export type HfTokenSource = 'env' | 'stored' | 'none';

/** Which hop failed. 'rejected' = the Hub said no about the token itself. */
export type HfFailureKind = 'rejected' | 'unreachable' | 'backend-down' | 'disabled' | 'unknown';

export interface HfAuthStatus {
  logged_in: boolean | null;
  username: string | null;
  token_source: HfTokenSource;
  /** True while a background whoami check is still in flight. */
  checking?: boolean;
  /**
   * False when the hfauth module is switched off (every route 404s), so a
   * caller can say "turn the module on" instead of showing a field that can
   * never succeed. Routers mount at import, so a toggle needs a restart.
   */
  available: boolean;
  /**
   * Set when the STATUS CALL ITSELF failed, so a caller can say "we could not
   * ask" instead of showing a signed-out state it did not measure. Null on a
   * successful call. `logged_in` is null whenever this is set.
   */
  error?: HfStatusError | null;
}

/** Why the status call could not produce an answer. */
export interface HfStatusError {
  kind: HfFailureKind;
  /** A sentence to show the user as-is. */
  message: string;
}

/** Thrown by `hfLogin` so callers can tell a bad token from a dead network. */
export class HfAuthError extends Error {
  constructor(
    message: string,
    /** 'rejected' = the Hub said no. 'unreachable' = we never got an answer. */
    readonly kind: HfFailureKind,
  ) {
    super(message);
    this.name = 'HfAuthError';
  }
}

export const HF_TOKENS_URL = 'https://huggingface.co/settings/tokens';

/** Said when we could not even ask the backend. */
const STATUS_UNKNOWN_SUFFIX = ' Until it answers, theDAW cannot tell whether you are signed in.';

/**
 * Which hop a failed hfauth response blames.
 *
 * The backend marks the one hop it does not own with `x-thedaw-hop:
 * huggingface` and reports it as 503. A 502/504 without that marker came from
 * a gateway in front of the backend, so huggingface.co was never contacted —
 * the status alone is enough even if a deployment strips custom headers.
 */
function hopOf(res: Response): HfFailureKind {
  if (res.headers.get(HOP_HEADER) === HOP_HUGGINGFACE) return 'unreachable';
  if (res.status === 503) return 'unreachable';
  if (res.status === 502 || res.status === 504) return 'backend-down';
  return 'unknown';
}

/**
 * Current login state. Never throws, and never invents one: a call that could
 * not be answered comes back as `logged_in: null` with `error` set, so a
 * backend outage is distinguishable from a missing token. Callers that only
 * check `logged_in === true` keep working unchanged.
 */
export async function fetchHfStatus(): Promise<HfAuthStatus> {
  let res: Response;
  try {
    res = await fetch('/api/hfauth/status');
  } catch {
    // No response at all — the backend is still booting, or it is gone.
    return {
      logged_in: null,
      username: null,
      token_source: 'none',
      available: true,
      error: { kind: 'backend-down', message: BACKEND_UNREACHABLE + STATUS_UNKNOWN_SUFFIX },
    };
  }
  if (res.status === 404) {
    return { logged_in: false, username: null, token_source: 'none', available: false, error: null };
  }
  if (!res.ok) {
    const kind = hopOf(res);
    const message = await describeHttpError(res);
    return {
      logged_in: null,
      username: null,
      token_source: 'none',
      available: true,
      error: { kind, message: message + (kind === 'backend-down' ? STATUS_UNKNOWN_SUFFIX : '') },
    };
  }
  const data = (await res.json().catch(() => null)) as Partial<HfAuthStatus> | null;
  return {
    logged_in: data?.logged_in ?? null,
    username: data?.username ?? null,
    token_source: data?.token_source ?? 'none',
    checking: data?.checking ?? false,
    available: true,
    error: null,
  };
}

/**
 * Validate `token` via whoami and persist it to huggingface_hub's standard
 * token store, so every later download picks it up with no env var and no
 * restart. Resolves to the username; throws `HfAuthError` otherwise.
 */
export async function hfLogin(token: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/hfauth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.trim() }),
    });
  } catch {
    throw new HfAuthError('Could not reach theDAW backend.', 'unreachable');
  }
  if (res.ok) {
    const data = (await res.json().catch(() => null)) as { username?: unknown } | null;
    return typeof data?.username === 'string' && data.username ? data.username : 'your account';
  }
  if (res.status === 401) throw new HfAuthError('Token rejected — check it and paste again.', 'rejected');
  if (res.status === 404) {
    throw new HfAuthError('The Hugging Face Auth module is turned off in Settings → Modules.', 'disabled');
  }
  // "We could not reach huggingface.co" and "we could not reach our own
  // backend" are different problems with different fixes, and the message has
  // to name the right one. A user who is told the Hub is down when the Hub is
  // fine tests their internet, proves it works, and files a bug against the
  // wrong half of the app — which is exactly what happened in issue #144.
  const kind = hopOf(res);
  if (kind === 'unreachable') {
    // The backend answered: it reached out to the Hub and that hop failed. Its
    // own detail already names what the Hub did, so prefer it verbatim.
    const detail = await detailFromResponse(res);
    throw new HfAuthError(detail ?? "Couldn't reach huggingface.co to check the token.", 'unreachable');
  }
  if (kind === 'backend-down') {
    // A gateway answered, not the backend, so nothing was asked of the Hub.
    throw new HfAuthError(await describeHttpError(res), 'backend-down');
  }
  const detail = await detailFromResponse(res);
  throw new HfAuthError(detail ?? `Sign-in failed (HTTP ${res.status}).`, 'unknown');
}

/** Forget the stored token. Resolves even if there was nothing to remove. */
export async function hfLogout(): Promise<void> {
  await fetch('/api/hfauth/logout', { method: 'POST' }).catch(() => undefined);
}

/** Where to send the browser to mint a token, with a hard-coded fallback. */
export async function hfLoginUrl(): Promise<string> {
  try {
    const res = await fetch('/api/hfauth/login-url');
    if (!res.ok) return HF_TOKENS_URL;
    const data = (await res.json()) as { url?: unknown } | null;
    return typeof data?.url === 'string' && data.url ? data.url : HF_TOKENS_URL;
  } catch {
    return HF_TOKENS_URL;
  }
}
