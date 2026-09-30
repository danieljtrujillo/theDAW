/**
 * Lineage "used in" / "sources" API client (F23U-1).
 *
 * Transport only, for the asset inspector's lineage tab: `fetchUsedIn` asks
 * where a library entry was used (which projects/renders reference it),
 * `fetchSources` asks what a render was made from. Both are read-only GETs;
 * neither retries, polls, nor caches — callers own that.
 *
 * Pins: `res.status === 404` means "this backend has no lineage module," not
 * a failure — it resolves the SAME empty payload an entry with no lineage
 * history would get, with `ok: true`. A blank/empty entry id resolves that
 * same empty payload without making a request at all. Any other non-ok
 * status or a thrown network/parse error resolves `{ ok: false, error }`.
 * `createStaleGuard` lets a caller (the inspector) drop a response that
 * lands after the user has already switched to a different asset.
 *
 * Run: `npx tsx src/lib/lineage/usedInApi.test.ts`
 */
import type { LineageUsedIn, LineageSources } from './lineageTypes';

export type LineageFetchResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const USED_IN_ERROR = 'Could not read where this asset was used.';
export const SOURCES_ERROR = 'Could not read what this render was made from.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const emptyUsedIn = (entryId: string): LineageUsedIn => ({ entry_id: entryId, projects: [], renders: [] });

const emptySources = (entryId: string): LineageSources => ({ entry_id: entryId, render: null });

const normalizeUsedIn = (entryId: string, body: Record<string, unknown>): LineageUsedIn => ({
  entry_id: entryId,
  projects: Array.isArray(body.projects) ? (body.projects as LineageUsedIn['projects']) : [],
  renders: Array.isArray(body.renders) ? (body.renders as LineageUsedIn['renders']) : [],
});

const normalizeSources = (entryId: string, body: unknown): LineageSources => {
  const rec = isRecord(body) ? body : {};
  const render: LineageSources['render'] = isRecord(rec.render)
    ? (rec.render as NonNullable<LineageSources['render']>)
    : null;
  return { entry_id: entryId, render };
};

/** GET /api/lineage/used-in/{entryId} — where a library entry has been used. */
export async function fetchUsedIn(entryId: string, signal?: AbortSignal): Promise<LineageFetchResult<LineageUsedIn>> {
  if (!entryId.trim()) return { ok: true, data: emptyUsedIn(entryId) };
  try {
    const res = await fetch(`/api/lineage/used-in/${encodeURIComponent(entryId)}`, signal ? { signal } : undefined);
    if (res.status === 404) return { ok: true, data: emptyUsedIn(entryId) };
    if (!res.ok) return { ok: false, error: USED_IN_ERROR };
    const body: unknown = await res.json();
    if (!isRecord(body)) return { ok: false, error: USED_IN_ERROR };
    return { ok: true, data: normalizeUsedIn(entryId, body) };
  } catch {
    return { ok: false, error: USED_IN_ERROR };
  }
}

/** GET /api/lineage/sources/{entryId} — what a render was made from. */
export async function fetchSources(
  entryId: string,
  signal?: AbortSignal,
): Promise<LineageFetchResult<LineageSources>> {
  if (!entryId.trim()) return { ok: true, data: emptySources(entryId) };
  try {
    const res = await fetch(`/api/lineage/sources/${encodeURIComponent(entryId)}`, signal ? { signal } : undefined);
    if (res.status === 404) return { ok: true, data: emptySources(entryId) };
    if (!res.ok) return { ok: false, error: SOURCES_ERROR };
    const body: unknown = await res.json();
    return { ok: true, data: normalizeSources(entryId, body) };
  } catch {
    return { ok: false, error: SOURCES_ERROR };
  }
}

/**
 * Monotonic token guard: `begin()` marks the start of a new request and
 * invalidates every token handed out before it; `isCurrent` tells a caller
 * whether a response that just landed is still the one the UI cares about.
 */
export function createStaleGuard(): { begin(): number; isCurrent(token: number): boolean } {
  let latest = 0;
  return {
    begin(): number {
      latest += 1;
      return latest;
    },
    isCurrent(token: number): boolean {
      return token === latest;
    },
  };
}
