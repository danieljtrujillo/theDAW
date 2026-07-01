// Small JSON fetch helpers shared by the vst / dawimport / project clients.
// Every backend route lives behind the Vite /api proxy (-> :8600), so URLs
// are relative. Errors surface the FastAPI {detail} (or {error}) field.

async function handle<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { detail?: unknown; error?: unknown };
      if (typeof j.detail === 'string') detail = j.detail;
      else if (typeof j.error === 'string') detail = j.error;
    } catch {
      // Non-JSON body (e.g. the Vite HTML fallback when the backend is down).
      detail = `${detail} — is the backend running on port 8600?`;
    }
    throw new Error(detail);
  }
  return (await r.json()) as T;
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
