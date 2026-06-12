// Models & Storage client — thin fetch wrappers over /api/storage.
//
// Backs two surfaces: the LOCAL group in the MAKE Model dropdown (registered
// checkpoints generate via their `local:<id>` ids) and the Settings → Models
// & Storage panel (locations browser, HF cache table, local-only switch).

export interface RegisteredCheckpoint {
  id: string; // "local:<8-hex>" — what the Model dropdown submits
  name: string;
  path: string;
  added_at?: number;
  resolves: boolean;
  config_path?: string;
  ckpt_path?: string;
}

export interface CatalogModel {
  name: string;
  repo_id: string;
  source: 'local' | 'cached' | 'download';
}

export interface StorageLocation {
  key: string;
  label: string;
  path: string | null;
  kind: 'windows' | 'wsl';
  exists: boolean;
  bytes: number | null;
  files: number | null;
}

export interface HfRepo {
  repo_id: string;
  repo_type: string;
  bytes: number;
  files: number;
  path: string;
  last_accessed: number | null;
}

export interface PathPickerResult {
  path: string | null;
  cancelled: boolean;
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const detail = await r.json().then((j) => j?.detail).catch(() => null);
    throw new Error(typeof detail === 'string' ? detail : `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

export async function fetchCheckpoints(): Promise<{
  registered: RegisteredCheckpoint[];
  catalog: CatalogModel[];
  local_only: boolean;
}> {
  return json(await fetch('/api/storage/checkpoints'));
}

export async function addCheckpoint(path: string, name?: string): Promise<RegisteredCheckpoint> {
  return json(
    await fetch('/api/storage/checkpoints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, name: name || null }),
    }),
  );
}

export async function removeCheckpoint(id: string): Promise<void> {
  await json(await fetch(`/api/storage/checkpoints/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function fetchLocations(refresh = false): Promise<StorageLocation[]> {
  const data = await json<{ locations: StorageLocation[] }>(
    await fetch(`/api/storage/locations${refresh ? '?refresh=1' : ''}`),
  );
  return data.locations;
}

export async function fetchHfCache(): Promise<{ path: string; repos: HfRepo[]; total_bytes: number }> {
  return json(await fetch('/api/storage/hf-cache'));
}

export async function setLocalOnly(enabled: boolean): Promise<boolean> {
  const data = await json<{ enabled: boolean }>(
    await fetch('/api/storage/local-only', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),
  );
  return data.enabled;
}

export async function openLocation(path: string): Promise<void> {
  await json(await fetch('/api/storage/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }));
}

export async function pickFolder(): Promise<PathPickerResult> {
  return json(await fetch('/api/storage/pick-folder', { method: 'POST' }));
}

export async function pickFile(): Promise<PathPickerResult> {
  return json(await fetch('/api/storage/pick-file', { method: 'POST' }));
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = -1;
  do {
    v /= 1024;
    u += 1;
  } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}
