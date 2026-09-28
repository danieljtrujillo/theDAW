// The Mobile Access share link for the full desktop UI, carrying the LAN
// pairing token (backend/lib/pairing.py).
//
// A device that opens the plain share URL is a caller on another machine with
// no token, so every project route, the known-places routes, the VST routes
// and the Gemini proxy refuse it. The token rides the URL FRAGMENT
// (`#pair=<token>`), which a browser never sends to any server; lib/pairing.ts
// on the opened page reads it, stores it for that origin, strips it from the
// address bar, and sends it as `X-TheDAW-Pair` on every request after that.
// The companion link to /mobile.html has always carried it; this is the same
// fragment on the link to the desktop UI.

/** `url` with `pair=<token>` in its fragment, replacing any `pair=` already
 *  there and keeping every other fragment part. No token: `url` unchanged. */
export function pairedShareLink(url: string, token: string | null): string {
  const base = (url || '').trim();
  if (!base || !token) return base;
  const hashAt = base.indexOf('#');
  const head = hashAt === -1 ? base : base.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : base.slice(hashAt + 1);
  const kept = fragment.split(/[&#]/).filter((part) => part && !part.startsWith('pair='));
  kept.push(`pair=${encodeURIComponent(token)}`);
  return `${head}#${kept.join('&')}`;
}
