/**
 * One place that turns a failed `Response` into a sentence a user can act on.
 *
 * Why this exists: every client here used to do
 * `await r.json().then(j => j?.detail).catch(() => null)` and fall back to
 * `HTTP ${r.status}`. That fallback fires exactly when the failure is NOT the
 * backend's — a gateway answers with a plain-text or empty body, `r.json()`
 * throws, whatever the body said is dropped on the floor, and the user reads
 * "Model status failed: HTTP 502" (gantasmo/theDAW#144). The one string that
 * carried the reason was the one string thrown away.
 *
 * So: read the body ONCE as text; use its `detail` when it is FastAPI JSON,
 * use the raw text when it is not, and when it says nothing at all, give the
 * gateway statuses a sentence that names WHICH HOP failed — theDAW's own
 * backend, or the service behind it. Those are different problems with
 * different fixes, and telling them apart is the whole point.
 *
 * A FastAPI `detail` outranks any sentence composed here, whatever the status:
 * its presence proves a route of ours answered, so its own words are the truth
 * about the failure. That also keeps this safe for a router that raises its own
 * 502 for an upstream call (backend/modules/tour, /api/generate) — such a
 * response always carries a `detail`, so it is never relabelled "our backend
 * did not answer".
 *
 * A `Response` body can be read only once; every export that takes one
 * consumes it.
 */

/**
 * Set by the packaged app's own proxy (electron-ui/main/index.ts) when it
 * could not reach the backend at all. Its body is plain text, never JSON.
 */
export const PROXY_ERROR_HEADER = 'x-thedaw-proxy-error';
export const PROXY_BACKEND_UNREACHABLE = 'backend-unreachable';

/**
 * Set by the BACKEND on a failure it reports for a hop it does not own, so
 * "our backend is down" and "the service our backend called is down" can never
 * collapse into one status again. See backend/modules/hfauth/router.py.
 */
export const HOP_HEADER = 'x-thedaw-hop';
export const HOP_HUGGINGFACE = 'huggingface';

/** The request never reached theDAW's backend. Nothing upstream was contacted. */
export const BACKEND_UNREACHABLE =
  "theDAW's own backend did not answer, so the request never left this machine. " +
  'It may still be starting — wait a moment and retry; if it keeps failing, restart theDAW.';

/** The backend answered, but something it had to call did not. */
export const UPSTREAM_UNAVAILABLE =
  "theDAW's backend answered, but the service it had to call did not. Try again in a moment.";

/** Somebody between here and the answer gave up waiting. */
export const GATEWAY_TIMEOUT =
  'The request timed out before an answer came back. Try again — the first check after a cold start can be slow.';

/** Longest body text we will paste into a user-facing message. */
const MAX_DETAIL = 300;

function tidy(text: string): string {
  const s = text.trim().replace(/\s+/g, ' ');
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL - 1)}…` : s;
}

export interface BodyMessage {
  /** What the body said, or null when it said nothing usable. */
  text: string | null;
  /** True when it came from a FastAPI `detail` — i.e. a route of ours answered. */
  fromDetail: boolean;
}

/**
 * What an error body carries.
 *
 * The three shapes that actually arrive: FastAPI's `{"detail": "…"}`, FastAPI's
 * validation list `{"detail": [{"msg": …}]}`, and a plain-text body from a
 * proxy. An HTML error page is markup, not a message, so it is dropped rather
 * than pasted into the UI.
 */
export function parseErrorBody(body: string): BodyMessage {
  const text = body.trim();
  if (!text) return { text: null, fromDetail: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (/^<(!doctype|html|\?xml)/i.test(text)) return { text: null, fromDetail: false };
    return { text: tidy(text), fromDetail: false };
  }
  const detail = (parsed as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail.trim()) return { text: tidy(detail), fromDetail: true };
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((e) => (e && typeof (e as { msg?: unknown }).msg === 'string' ? (e as { msg: string }).msg : null))
      .filter((m): m is string => Boolean(m));
    if (msgs.length) return { text: tidy(msgs.join('; ')), fromDetail: true };
  }
  return { text: null, fromDetail: false };
}

/** `parseErrorBody` over a Response. Consumes the body; never throws. */
export async function readErrorBody(res: Response): Promise<BodyMessage> {
  try {
    return parseErrorBody(await res.text());
  } catch {
    return { text: null, fromDetail: false };
  }
}

/** Just the message a response body carried, if any. Consumes the body. */
export async function detailFromResponse(res: Response): Promise<string | null> {
  return (await readErrorBody(res)).text;
}

/**
 * A user-facing sentence for a non-ok `Response`. Consumes the body.
 *
 * Order: the proxy's own header is direct evidence about the failing hop, so it
 * wins; then a FastAPI `detail`, which is a real answer from a real route; then
 * a sentence for the gateway statuses, keeping whatever plain text the body did
 * carry in parentheses so a bug report can quote the technical half.
 */
export async function describeHttpError(res: Response): Promise<string> {
  const proxied = res.headers.get(PROXY_ERROR_HEADER) === PROXY_BACKEND_UNREACHABLE;
  const { text, fromDetail } = await readErrorBody(res);
  if (proxied) return text ? `${BACKEND_UNREACHABLE} (${text})` : BACKEND_UNREACHABLE;
  if (fromDetail && text) return text;
  const lead =
    res.status === 502
      ? // The only bare 502s in this app come from a gateway in front of the
        // backend (the packaged app:// proxy, the Vite dev proxy). The backend
        // reports failures it does not own as 503 + HOP_HEADER, on purpose.
        BACKEND_UNREACHABLE
      : res.status === 503
        ? UPSTREAM_UNAVAILABLE
        : res.status === 504
          ? GATEWAY_TIMEOUT
          : null;
  if (lead) return text ? `${lead} (${text})` : lead;
  return text ?? `HTTP ${res.status}`;
}
