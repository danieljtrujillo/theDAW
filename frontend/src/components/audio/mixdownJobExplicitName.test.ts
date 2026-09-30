// Run with: npx tsx src/components/audio/mixdownJobExplicitName.test.ts
/**
 * D18 audit MAJOR #2 — `mixdownJobExplicitName` (WaveformEditor.tsx) is a
 * plain `Map<jobId, boolean>` set by `commitEdit`/the range-render dialog and
 * read once by `runMixdownJob`. A job that is CANCELLED WHILE QUEUED, or
 * that the render-jobs runner drops for an import failure before
 * `runMixdownJob`'s own read-and-delete ever runs, never gets its entry
 * removed — a slow leak, one entry per such job, for the life of the tab.
 *
 * `pruneMixdownJobExplicitNames` is the fix: called before every `.set()`,
 * it drops every entry whose job is no longer QUEUED or RUNNING in
 * `useRenderJobs.getState().jobs` — a job that is done/failed/cancelled, or
 * has aged out of the jobs list entirely, no longer needs one.
 */
import assert from 'node:assert/strict';
import { pruneMixdownJobExplicitNames } from './mixdownJobExplicitName';

const jobs = (statuses: Record<string, string>) =>
  Object.entries(statuses).map(([id, status]) => ({ id, status }));

// --- Live jobs (queued/running) are kept, everything else is dropped -------
{
  const entries = new Map<string, boolean>([
    ['queued-job', true],
    ['running-job', false],
    ['done-job', true],
    ['failed-job', false],
    ['cancelled-job', true],
    ['gone-job', true], // not in `jobs` at all — aged out of history
  ]);
  const live = jobs({
    'queued-job': 'queued',
    'running-job': 'running',
    'done-job': 'done',
    'failed-job': 'failed',
    'cancelled-job': 'cancelled',
  });

  const pruned = pruneMixdownJobExplicitNames(entries, live);
  assert.deepEqual([...pruned.entries()].sort(), [
    ['queued-job', true],
    ['running-job', false],
  ]);
  // The input Map is untouched — this is a pure function, not a mutation.
  assert.equal(entries.size, 6, 'the original map is not mutated');
}

// --- Empty input ------------------------------------------------------------
{
  assert.deepEqual(pruneMixdownJobExplicitNames(new Map(), []), new Map());
  assert.deepEqual(
    pruneMixdownJobExplicitNames(new Map([['a', true]]), []),
    new Map(),
    'no live jobs at all: every entry is dropped',
  );
}

console.log('mixdownJobExplicitName: ok');
