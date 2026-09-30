// Small JSON fetch helpers shared by the vst / dawimport / project clients.
// Every backend route lives behind the Vite /api proxy (-> :8600), so URLs
// are relative. Errors surface the FastAPI {detail} (or {error}) field.

import { describeHttpError } from './httpError';
import { pairingHeader } from './pairing';

/** The failure these helpers throw. The message is exactly what it always was
 *  (`describeApiError`: the route's own `detail`/`error`, or a described
 *  status), so every `e.message` reader is untouched — but the STATUS is
 *  carried alongside it now. A caller that must tell "the server refused this
 *  request on purpose" from "the request failed" cannot get that out of the
 *  message: `describeApiError` returns the detail verbatim when there is one,
 *  and the status never appears in it. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function handle<T>(r: Response): Promise<T> {
  if (!r.ok) {
    // describeHttpError reads the body once, prefers a FastAPI `detail`, and
    // for 502/503/504 says WHICH hop failed -- theDAW's own backend, or the
    // service behind it. Those are different problems with different fixes,
    // and the previous version collapsed them: a non-JSON body (which is what
    // a proxy sends when the backend is unreachable) produced
    // `HTTP 502 - is the backend running on port 8600?` for a Hub timeout just
    // as readily as for a dead backend.
    //
    // `error` is read here as well as `detail` because a few of this app's own
    // routes answer with that key.
    throw new ApiError(await describeApiError(r), r.status);
  }
  return (await r.json()) as T;
}

/** `describeHttpError`, plus this app's non-standard `{error: "..."}` bodies.
 *  Exported because a caller that needs the STATUS (the lineage-scale summary
 *  probe) cannot go through `getJson`, and must still describe a failure the
 *  same way rather than keep its own reader that misses the `error` key. */
export async function describeApiError(r: Response): Promise<string> {
  const body = await r.clone().text();
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown };
    const hasDetail =
      (typeof parsed.detail === 'string' && Boolean(parsed.detail.trim())) || Array.isArray(parsed.detail);
    if (!hasDetail && typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  } catch {
    /* not JSON, or no `error` key: fall through to the shared description */
  }
  return describeHttpError(r);
}

/** The pairing token is a LAN/phone secret (backend/lib/pairing.py). Every
 *  current call site uses a relative `/api/...` URL, so it never leaves
 *  this origin -- but attach it only when the resolved URL's origin matches
 *  the page's own origin, so a future absolute-URL (or protocol-relative,
 *  or slash-backslash) call site can't ship it cross-origin by accident. */
export function pairingHeaderFor(url: string): Record<string, string> {
  try {
    return new URL(url, window.location.href).origin === window.location.origin ? pairingHeader() : {};
  } catch {
    return {};
  }
}

export async function getJson<T>(url: string): Promise<T> {
  return handle<T>(await fetch(url, { headers: pairingHeaderFor(url) }));
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  return handle<T>(
    await fetch(url, {
      method: 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...pairingHeaderFor(url),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** POST a multipart/form-data body (file uploads). The browser sets the
 *  Content-Type + boundary, so none is passed here -- only the pairing
 *  header (backend/lib/pairing.py), which the project routes' LAN/phone
 *  gate looks for. */
export async function postForm<T>(url: string, form: FormData): Promise<T> {
  return handle<T>(
    await fetch(url, { method: 'POST', body: form, headers: pairingHeaderFor(url) }),
  );
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  return handle<T>(
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...pairingHeaderFor(url) },
      body: JSON.stringify(body),
    }),
  );
}

export async function delJson<T>(url: string): Promise<T> {
  return handle<T>(await fetch(url, { method: 'DELETE', headers: pairingHeaderFor(url) }));
}
