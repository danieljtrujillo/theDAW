// Small JSON fetch helpers shared by the vst / dawimport / project clients.
// Every backend route lives behind the Vite /api proxy (-> :8600), so URLs
// are relative. Errors surface the FastAPI {detail} (or {error}) field.

import { describeHttpError } from './httpError';

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
    throw new Error(await describeApiError(r));
  }
  return (await r.json()) as T;
}

/** `describeHttpError`, plus this app's non-standard `{error: "..."}` bodies. */
async function describeApiError(r: Response): Promise<string> {
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

export async function getJson<T>(url: string): Promise<T> {
  return handle<T>(await fetch(url));
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  return handle<T>(
    await fetch(url, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** POST a multipart/form-data body (file uploads). The browser sets the
 *  Content-Type + boundary, so none is passed here. */
export async function postForm<T>(url: string, form: FormData): Promise<T> {
  return handle<T>(await fetch(url, { method: 'POST', body: form }));
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  return handle<T>(
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function delJson<T>(url: string): Promise<T> {
  return handle<T>(await fetch(url, { method: 'DELETE' }));
}
