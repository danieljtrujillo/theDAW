import { logError, logInfo } from '../state/logStore';
import { useDjAnalysisStore } from '../state/djAnalysisStore';

/* DJ live stems (D4) — list / separate / resolve URLs for the stems backend
 * (`backend/modules/stems`). Cached stems are served at
 * `/api/library/stems/{stem_id}/audio`; separation runs foreground via
 * `POST /api/stems/{entry}/run` (resolves when done). The djEngine then decodes
 * the returned URLs into per-stem live faders. */

export interface StemRef {
  name: string;
  url: string;
  /**
   * What the backend says this row IS: a `'part'` of the mix, or an
   * `'aggregate'` — a SUM of other rows in the same run (`drums` over the
   * LARSNET kit parts, `no_vocals` over everything but the vocal). Undefined
   * for a run separated before roles existed, which callers must read as
   * "unknown", never as "part".
   *
   * Left a plain string so a role a later backend introduces reaches the
   * caller intact instead of being narrowed away here. `components/audio/
   * clipDoubleClick.planStemInsert` is the one place that decides what to do
   * with it.
   */
  role?: string;
  /** True when the separator re-gained this stem to a fixed peak, so its level
   *  is not the level it had inside the mix. */
  gainNormalized?: boolean;
}

interface StemRow {
  id?: string;
  stem_name?: string;
  name?: string;
  role?: string;
  gain_normalized?: boolean;
}

/** List an entry's already-separated stems (empty if none cached yet). */
export async function listStems(entryId: string): Promise<StemRef[]> {
  try {
    const r = await fetch(`/api/stems/${encodeURIComponent(entryId)}`);
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    const rows: StemRow[] = Array.isArray(j?.stems) ? j.stems : [];
    return rows
      .filter((s) => !!s.id)
      .map((s) => ({
        name: s.stem_name || s.name || 'stem',
        url: `/api/library/stems/${s.id}/audio`,
        // Carried through verbatim: a row the backend did not describe has no
        // role, and inventing one here would make an old run look classified.
        ...(typeof s.role === 'string' ? { role: s.role } : {}),
        ...(typeof s.gain_normalized === 'boolean' ? { gainNormalized: s.gain_normalized } : {}),
      }));
  } catch {
    return [];
  }
}

export interface SeparateOpts {
  stems?: 2 | 4 | 6 | 12;
  device?: string;
  quality?: string;
  /** Aborting it cancels the run: the backend's abort route is called and
   *  the promise rejects with a {@link StemsAborted}, never with stems. */
  signal?: AbortSignal;
}

/** What {@link ensureStems} rejects with when its `signal` aborted the run. */
export class StemsAborted extends Error {
  constructor(entryId: string) {
    super(`stem separation aborted for ${entryId}`);
    this.name = 'StemsAborted';
  }
}

export const isStemsAborted = (e: unknown): e is StemsAborted => e instanceof StemsAborted;

/** Progress phases after which a run is over, or already told to stop. */
const SETTLED_PHASES = new Set(['idle', 'aborting', 'aborted', 'completed', 'failed']);

/** Ask the backend to stop an in-flight separation
 *  (`POST /api/stems/{entry}/abort`; the run ends at its next poll tick).
 *  Resolves true when the backend had a run to mark. */
export async function abortStems(entryId: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/stems/${encodeURIComponent(entryId)}/abort`, { method: 'POST' });
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    return j?.ok === true;
  } catch {
    return false;
  }
}

/** Return cached stems, else run separation (foreground; resolves when done),
 *  polling progress for a % while the run is in flight, then list the result.
 *  `opts.signal` aborts the run: the backend is told to stop, and the promise
 *  rejects with {@link StemsAborted} even when the run finished anyway. */
export async function ensureStems(
  entryId: string,
  opts: SeparateOpts = {},
  onProgress?: (pct: number, phase: string) => void,
): Promise<StemRef[]> {
  const stems = opts.stems ?? 4;
  const device = opts.device ?? 'auto';
  const quality = opts.quality ?? 'fast';
  const signal = opts.signal;
  if (signal?.aborted) throw new StemsAborted(entryId);
  const existing = await listStems(entryId);
  if (existing.length >= stems) {
    onProgress?.(100, 'cached');
    return existing;
  }
  if (existing.length) {
    logInfo('dj-stems', `Upgrading ${entryId} from ${existing.length} cached stem(s) to ${stems} stem(s)…`);
  }
  logInfo('dj-stems', `Separating ${entryId} (${stems} stems, ${quality})…`);

  // The abort goes to the backend the moment it is asked for. A run still
  // queued behind the GPU lane has no progress snapshot yet, so the backend
  // has nothing to mark; the poll below re-sends it once the run is alive.
  const onAbort = () => { void abortStems(entryId); };
  signal?.addEventListener('abort', onAbort, { once: true });

  let polling = true;
  void (async () => {
    while (polling) {
      try {
        const pr = await fetch(`/api/stems/${encodeURIComponent(entryId)}/progress`);
        if (pr.ok) {
          const p = await pr.json();
          if (p && p.phase && p.phase !== 'idle') {
            const raw = typeof p.progress === 'number' ? p.progress : 0;
            onProgress?.(Math.round((raw <= 1 ? raw * 100 : raw)), String(p.phase));
            if (signal?.aborted && !SETTLED_PHASES.has(String(p.phase))) void abortStems(entryId);
          }
        }
      } catch { /* ignore poll error */ }
      await new Promise((res) => setTimeout(res, 1500));
    }
  })();

  try {
    const res = await fetch(
      `/api/stems/${encodeURIComponent(entryId)}/run?stems=${stems}&device=${device}&quality=${quality}`,
      { method: 'POST' },
    );
    if (!res.ok) {
      if (signal?.aborted) throw new StemsAborted(entryId);
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || `separation failed (${res.status})`);
    }
  } catch (e) {
    if (isStemsAborted(e)) {
      logInfo('dj-stems', `Separation of ${entryId} aborted`);
      throw e;
    }
    logError('dj-stems', `Separation failed for ${entryId}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    polling = false;
    signal?.removeEventListener('abort', onAbort);
  }
  // The abort landed after the run's last poll tick and the run finished: the
  // stems are cached for next time, but the caller asked for none now.
  if (signal?.aborted) throw new StemsAborted(entryId);
  return listStems(entryId);
}

export async function prepareStems(
  entryId: string,
  opts: SeparateOpts = {},
  onProgress?: (pct: number, phase: string) => void,
): Promise<StemRef[]> {
  onProgress?.(0, 'analyzing');
  await useDjAnalysisStore.getState().ensureAnalyzed(entryId);

  const analysis = useDjAnalysisStore.getState().byId[entryId];
  if (analysis?.status === 'error') {
    throw new Error('analysis failed');
  }

  if (opts.signal?.aborted) throw new StemsAborted(entryId);
  onProgress?.(0, 'checking_stems');
  return ensureStems(entryId, opts, onProgress);
}
