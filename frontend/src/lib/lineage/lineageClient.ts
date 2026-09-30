/**
 * Transport for render lineage (F23T-2): POSTs the record a finished render
 * produced to the backend, with a few retries riding over a flaky
 * single-worker backend (the same problem `fetchRetry.ts` rides over for
 * library media — this copies that shape, but posts JSON instead of
 * fetching bytes).
 *
 * A lineage write must never fail the render it describes (F23), so this
 * NEVER throws: every outcome — success, a rejected body, or exhausted
 * retries — is a returned `LineagePostResult` the caller inspects. A render
 * that cannot record its lineage still finishes; it just logs and moves on.
 */
import type { LineageRenderRecord } from './lineageTypes';
import { logWarn } from '../../state/logStore';

export const LINEAGE_RENDERS_URL = '/api/lineage/renders';

export interface LineagePostDeps {
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  retries?: number;
  backoffMs?: number;
}

export type LineagePostResult =
  | { ok: true; attempts: number }
  | { ok: false; attempts: number; reason: string };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 4xx codes that ARE retried: the request was throttled or timed out, not
 *  malformed — retrying the same body can succeed. Every other 4xx is a bad
 *  body that retrying cannot fix. */
const RETRYABLE_4XX = new Set([408, 429]);

/** POST a render's lineage record to `LINEAGE_RENDERS_URL`. Idempotent on
 *  `render_id`, so a retried or duplicate POST of the same record is a
 *  success, not an error — the backend just overwrites the same row. */
export async function postRenderLineage(
  record: LineageRenderRecord,
  deps: LineagePostDeps = {},
): Promise<LineagePostResult> {
  if (!record.render_id) {
    return { ok: false, attempts: 0, reason: 'render_id is required' };
  }

  const {
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    retries = 3,
    backoffMs = 400,
  } = deps;

  let lastReason = 'unknown error';

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attempts = attempt + 1;
    try {
      const res = await fetchImpl(LINEAGE_RENDERS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(record),
      });

      if (res.ok) {
        return { ok: true, attempts };
      }

      lastReason = `HTTP ${res.status}`;
      if (res.status >= 400 && res.status < 500 && !RETRYABLE_4XX.has(res.status)) {
        // The body was rejected outright; retrying it cannot help.
        return { ok: false, attempts, reason: lastReason };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      lastReason = msg || String(e);
    }

    if (attempt < retries) {
      logWarn('library', `postRenderLineage: attempt ${attempts} failed (${lastReason}); retrying…`);
      await sleepImpl(backoffMs * (attempt + 1));
    }
  }

  return { ok: false, attempts: retries + 1, reason: lastReason };
}
