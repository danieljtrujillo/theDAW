// Known places client -- thin wrappers over /api/places.
//
// The backend remembers every file path the app itself touched: a download the
// desktop shell finished, a Save As, a native pick, an asset install, a project
// save. These helpers read that memory back so an import control can offer the
// file straight away and a picker can open in the folder it was last used in.
//
// Read helpers (folder, recent, record) answer with an empty value when the
// backend cannot, so a control that only offers a shortcut never breaks the
// control it sits beside. Actions the user asked for (reveal, projectsDir,
// setProjectsDir) throw with the backend's own message.

import { getJson, pairingHeaderFor, postJson, putJson } from './apiJson';
import { describeHttpError } from './httpError';

export interface PlaceItem {
  path: string;
  name: string;
  kind: string;
  source: string;
  /** Unix seconds when the path was recorded. */
  at: number;
  /** True when /api/places/file will serve this path's bytes. */
  servable: boolean;
}

/** Fired on `window` whenever this client learns a new path was recorded. */
export const PLACES_CHANGED_EVENT = 'thedaw:places-changed';

export function notifyPlacesChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(PLACES_CHANGED_EVENT));
  } catch {
    /* no event support (non-DOM runtime): nothing is listening */
  }
}

export const placesApi = {
  /** The folder a picker for `kind` should open in, or null when none is known. */
  async folder(kind: string): Promise<string | null> {
    try {
      const data = await getJson<{ kind: string; folder: string | null }>(
        `/api/places/folder?kind=${encodeURIComponent(kind)}`,
      );
      return data.folder ?? null;
    } catch {
      return null;
    }
  },

  /** Recently recorded paths that still exist, newest first. */
  async recent(opts?: { kind?: string; exts?: string[]; limit?: number }): Promise<PlaceItem[]> {
    const params = new URLSearchParams();
    if (opts?.kind) params.set('kind', opts.kind);
    const exts = normalizeExts(opts?.exts);
    if (exts.length) params.set('exts', exts.join(','));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    try {
      const data = await getJson<{ items?: PlaceItem[] }>(`/api/places/recent${qs ? `?${qs}` : ''}`);
      return Array.isArray(data.items) ? data.items : [];
    } catch {
      return [];
    }
  },

  /** Recent paths of any of `kinds` (every kind when empty), one request per
   *  kind, merged by path and newest first. Rows of other kinds are dropped. */
  async recentOfKinds(opts: { kinds?: string[]; exts?: string[]; limit?: number }): Promise<PlaceItem[]> {
    const kinds = [...new Set((opts.kinds ?? []).map((k) => k.trim()).filter(Boolean))];
    const lists = await Promise.all(
      (kinds.length ? kinds : [undefined]).map((kind) =>
        placesApi.recent({ kind, exts: opts.exts, limit: opts.limit }),
      ),
    );
    const merged = mergePlaceItems(lists);
    return kinds.length ? merged.filter((r) => kinds.includes(r.kind)) : merged;
  },

  /** Remember a path the client learned about. Resolves `{recorded: false}` on any failure. */
  async record(path: string, kind?: string): Promise<{ recorded: boolean; kind: string | null }> {
    try {
      const data = await postJson<{ recorded: boolean; kind: string | null }>('/api/places/record', {
        path,
        kind: kind || undefined,
      });
      if (data.recorded) notifyPlacesChanged();
      return data;
    } catch {
      return { recorded: false, kind: null };
    }
  },

  /** Show the path selected in the OS file manager. Throws when it is missing. */
  async reveal(path: string): Promise<void> {
    await postJson<{ status: string; path: string }>('/api/places/reveal', { path });
  },

  /** URL that serves a servable recorded file's bytes. */
  fileUrl(path: string): string {
    return `/api/places/file?path=${encodeURIComponent(path)}`;
  },

  /** The folder new projects and installed project assets go to. `configured`
   *  is true only when a client stored that folder; false means the backend's
   *  default. */
  async projectsDir(): Promise<{ path: string; configured: boolean }> {
    const data = await getJson<{ path?: string; configured?: boolean }>('/api/places/projects-dir');
    return { path: typeof data.path === 'string' ? data.path : '', configured: data.configured === true };
  },

  /** Store a new projects folder. The path must be absolute. */
  async setProjectsDir(path: string): Promise<string> {
    const data = await putJson<{ path: string }>('/api/places/projects-dir', { path });
    return data.path;
  },
};

/** Several recent lists as one: a path appears once, with its newest entry, and
 *  the rows run newest first. */
export function mergePlaceItems(lists: PlaceItem[][]): PlaceItem[] {
  const byPath = new Map<string, PlaceItem>();
  for (const list of lists) {
    for (const item of list) {
      if (!item || typeof item.path !== 'string') continue;
      const seen = byPath.get(item.path);
      if (!seen || (item.at ?? 0) > (seen.at ?? 0)) byPath.set(item.path, item);
    }
  }
  return [...byPath.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** Lowercase extensions with a leading dot; MIME types and wildcards are dropped. */
export function normalizeExts(exts: string[] | undefined): string[] {
  if (!exts) return [];
  const out: string[] = [];
  for (const raw of exts) {
    const e = raw.trim().toLowerCase();
    if (!e || e.includes('/') || e.includes('*')) continue;
    const dotted = e.startsWith('.') ? e : `.${e}`;
    if (!out.includes(dotted)) out.push(dotted);
  }
  return out;
}

/** Fetch a servable recorded file as a File named after it. /api/places/file
 *  answers a paired device only with its pairing header, which getJson would
 *  add and a bare fetch does not. */
export async function fileFromPlace(item: PlaceItem): Promise<File> {
  const url = placesApi.fileUrl(item.path);
  const res = await fetch(url, { headers: pairingHeaderFor(url) });
  if (!res.ok) throw new Error(await describeHttpError(res));
  const blob = await res.blob();
  return new File([blob], item.name || basenameOf(item.path), { type: blob.type });
}

/** The folder part of a Windows or POSIX path; '' for a bare file name. */
export function dirnameOf(p: string): string {
  if (!p) return '';
  const isSep = (c: string) => c === '/' || c === '\\';
  // Drop trailing separators, keeping a bare root ('/' or 'C:\').
  let end = p.length;
  while (end > 1 && isSep(p[end - 1]) && !(end === 3 && p[1] === ':')) end -= 1;
  const body = p.slice(0, end);
  const i = Math.max(body.lastIndexOf('/'), body.lastIndexOf('\\'));
  if (i < 0) return '';
  if (i === 0) return body[0];
  if (i === 2 && body[1] === ':') return body.slice(0, 3);
  return body.slice(0, i);
}

/** A key that is equal for two spellings of one path. A Windows path (a drive
 *  letter or any backslash) compares without case and with either separator; a
 *  POSIX path compares as written. */
export function pathKey(p: string): string {
  const s = p.trim();
  return /^[a-zA-Z]:|\\/.test(s) ? s.replace(/\//g, '\\').toLowerCase() : s;
}

/** The last segment of a Windows or POSIX path. */
export function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/** True when this page runs on the machine the backend runs on. */
export function isLocalClient(): boolean {
  if (typeof window === 'undefined') return false;
  const api = (window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI;
  if (api?.isElectron) return true;
  const host = window.location?.hostname ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}
