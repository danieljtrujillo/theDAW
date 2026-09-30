// The phone-companion LAN pairing token (backend/lib/pairing.py).
//
// A phone reaching this backend over a plain http://<lan-ip> share link is
// not a secure context, so its browser sends no Sec-Fetch-* headers at all —
// indistinguishable, on headers alone, from a bare script on the LAN forging
// a local-looking Origin (SEC-001). The pairing token is the phone's real
// secret: the share link carries it in the URL FRAGMENT (`#pair=<token>`),
// which a browser never sends to any server and no proxy or server log ever
// sees. This module reads it once, moves it into localStorage so it survives
// navigation and reload, strips it from the visible URL, and hands it back
// as the `X-TheDAW-Pair` header for every API request after that.

const STORAGE_KEY = 'thedaw.pairingToken';
export const PAIRING_HEADER = 'X-TheDAW-Pair';

// Backs pairingToken() when localStorage is unavailable (private browsing,
// quota exceeded) -- module scope survives for the rest of this page load
// even though nothing was persisted.
let inMemoryToken: string | null = null;

// `g` so every occurrence is found, not just the first — a URL can carry
// `#pair=A&pair=B` (two params in one fragment) or even `#pair=A#pair=B` (a
// literal second '#': only the FIRST '#' in a URL starts the fragment, so a
// later one is just another character inside it, not a new delimiter). The
// value class excludes '#' as well as '&' so a match never swallows a
// trailing literal '#pair=...' into its own value.
const FRAGMENT_RE = /(^#|[&#])pair=([^&#]+)/g;

/** `window.location.hash`, safe on any host that defines `window` without a
 *  full `location` (test harnesses, SSR, workers, node scripts). */
function currentHash(): string {
  if (typeof window === 'undefined') return '';
  return window.location?.hash ?? '';
}

function readFragmentToken(): string | null {
  const matches = [...currentHash().matchAll(FRAGMENT_RE)];
  if (matches.length === 0) return null;
  try {
    return decodeURIComponent(matches[0][2]);
  } catch {
    return null;
  }
}

/** Removes every `pair=<token>` occurrence from the URL fragment, leaving
 *  any other fragment content (and the query string) untouched, without
 *  adding a history entry. */
function stripFragmentToken(): void {
  if (typeof window === 'undefined') return;
  let stripped = currentHash().replace(
    FRAGMENT_RE,
    (_match, lead: string, _token: string, offset: number) =>
      // Keep the fragment's own leading '#' only when THIS match sits right
      // at the front of it; every other occurrence — a '&pair=' further
      // along, or a stray literal second '#pair=' — is dropped outright.
      lead === '#' && offset === 0 ? '#' : '',
  );
  // The removal above can still leave a dangling separator right after that
  // leading '#': '#pair=a&x=1' becomes '#&x=1' (the '&' that used to sit
  // between "pair=a" and "x=1" now has nothing before it), and
  // '#pair=A#foo=1' becomes '##foo=1' (ditto for a literal second '#').
  // Every token is still fully gone either way, but tidy it up rather than
  // leave the address bar looking broken.
  stripped = stripped.replace(/^#[&#]+/, '#');
  const hash = stripped === '#' ? '' : stripped;
  const url = (window.location?.pathname ?? '') + (window.location?.search ?? '') + hash;
  window.history?.replaceState(null, '', url);
}

/** Reads a pairing token from the URL fragment, if present, stores it, and
 *  strips it from the visible URL. Safe to call more than once — a page
 *  without `#pair=` in its URL leaves whatever token is already stored
 *  untouched. Runs once automatically when this module is first imported. */
export function initPairing(): void {
  const token = readFragmentToken();
  if (!token) return;
  inMemoryToken = token;
  try {
    window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage blocked (private browsing, quota) — the token still works for
    // the rest of this page load via the module-scope `inMemoryToken` above,
    // just not after a reload.
  }
  stripFragmentToken();
}

/** The stored pairing token, or null if this device was never paired. */
export function pairingToken(): string | null {
  if (inMemoryToken) return inMemoryToken;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `{ 'X-TheDAW-Pair': <token> }` when paired, else `{}` — spread straight
 *  into a fetch/SDK `headers` object. */
export function pairingHeader(): Record<string, string> {
  const token = pairingToken();
  return token ? { [PAIRING_HEADER]: token } : {};
}

initPairing();
