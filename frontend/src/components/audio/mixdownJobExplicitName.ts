/**
 * D18 — pruning `WaveformEditor`'s `mixdownJobExplicitName` map.
 *
 * That map is `Map<jobId, boolean>`: whether a mixdown job's label is text
 * the user typed (vs. the auto-generated fallback), set by `commitEdit`/the
 * range-render dialog right after `enqueueBounce` hands back a job id, read
 * once by `runMixdownJob`. A job that actually RUNS gets its entry read and
 * deleted there — but a job CANCELLED WHILE QUEUED, or one the render-jobs
 * runner drops before `runMixdownJob` ever starts (an import failure
 * upstream, or any other reason a queued job never runs), never reaches that
 * read, so its entry would sit in the map forever: a slow leak, one entry
 * per such job, for the life of the tab.
 *
 * Pure and DOM-free, like `clipDoubleClick.ts`: `WaveformEditor` calls this
 * before every `.set()`, passing `useRenderJobs.getState().jobs`, so the map
 * never grows past "jobs that could still reach `runMixdownJob`".
 */

/** The part of a render job this module reads. */
export interface MixdownJobLike {
  readonly id: string;
  readonly status: string;
}

/**
 * `entries` filtered to only the ids whose job in `jobs` is still `queued`
 * or `running` — the only statuses under which `runMixdownJob` (the one
 * place that reads and deletes an entry) can still run for that job. A job
 * that is `done`/`failed`/`cancelled`, or absent from `jobs` entirely (aged
 * out of render-job history), no longer needs its entry. Returns a NEW Map;
 * `entries` is not mutated.
 */
export function pruneMixdownJobExplicitNames<V>(
  entries: ReadonlyMap<string, V>,
  jobs: readonly MixdownJobLike[],
): Map<string, V> {
  const live = new Set(jobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.id));
  const out = new Map<string, V>();
  for (const [id, value] of entries) {
    if (live.has(id)) out.set(id, value);
  }
  return out;
}
