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
// `logged_in: null` is a real third state: the backend could not reach the Hub,
// so it reports "unknown" rather than wrongly logging an offline user out.

/** Where the detected token came from. 'env' wins over 'stored' on the backend. */
export type HfTokenSource = 'env' | 'stored' | 'none';

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
}

/** Thrown by `hfLogin` so callers can tell a bad token from a dead network. */
export class HfAuthError extends Error {
  constructor(
    message: string,
    /** 'rejected' = the Hub said no. 'unreachable' = we never got an answer. */
    readonly kind: 'rejected' | 'unreachable' | 'disabled' | 'unknown',
  ) {
    super(message);
    this.name = 'HfAuthError';
  }
}

export const HF_TOKENS_URL = 'https://huggingface.co/settings/tokens';

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
 * Current login state. Never throws — an unreachable backend or a disabled
 * hfauth module reports the same "not signed in" shape, so callers can render
 * the token field instead of an error.
 */
export async function fetchHfStatus(): Promise<HfAuthStatus> {
  try {
    const res = await fetch('/api/hfauth/status');
    if (res.status === 404) {
      return { logged_in: false, username: null, token_source: 'none', available: false };
    }
    if (!res.ok) {
      return { logged_in: false, username: null, token_source: 'none', available: true };
    }
    const data = (await res.json()) as Partial<HfAuthStatus> | null;
    return {
      logged_in: data?.logged_in ?? null,
      username: data?.username ?? null,
      token_source: data?.token_source ?? 'none',
      checking: data?.checking ?? false,
      available: true,
    };
  } catch {
    // Backend still booting or momentarily down — assume the module is there
    // and let the sign-in attempt produce the real error.
    return { logged_in: false, username: null, token_source: 'none', available: true };
  }
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
  if (res.status === 503 || res.status === 502) {
    throw new HfAuthError("Couldn't reach huggingface.co to check the token.", 'unreachable');
  }
  const detail = await readDetail(res);
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
