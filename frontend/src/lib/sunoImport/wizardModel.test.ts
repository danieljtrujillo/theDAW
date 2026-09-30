/**
 * node:assert cover for wizardModel — the pure state machine, request
 * builders, and formatters behind the Suno import wizard. Run from
 * `frontend/`:
 *   npx tsx src/lib/sunoImport/wizardModel.test.ts
 *
 * The wizard's UI, its zustand store, and its fetch calls are built
 * elsewhere against this module; none of that exists here. Every assertion
 * below drives a pure function with plain data, so the whole wizard's
 * decision logic — which step is showing, what a Stage/Promote request body
 * looks like, how a report reconciles, how a byte count prints — is provable
 * without a DOM, a server, or the user's real Suno cache/library paths (the
 * paths below are fixtures, never real ones).
 */
import assert from 'node:assert/strict';

import {
  buildPromoteRequest,
  buildStageRequest,
  canAdvance,
  formatBytes,
  formatCount,
  formatDuration,
  formatRate,
  initialForm,
  nextStep,
  parseCachePaths,
  spaceVerdict,
  STEP_TITLES,
  stageReportRows,
  totalsReconcile,
  validateForm,
  WIZARD_STEPS,
  type JobSnapshot,
  type WizardForm,
} from './wizardModel.ts';

/** A succeeded stage job by default; override per assertion. */
const baseJob = (overrides: Partial<JobSnapshot> = {}): JobSnapshot => ({
  jobId: 'job-1',
  kind: 'stage',
  status: 'succeeded',
  progress: { done: 1, total: 1, ratePerSec: 1, etaSec: 0 },
  report: null,
  error: null,
  ...overrides,
});

/* ------------------------------ parseCachePaths ---------------------------- */
{
  const text = '  /cache/song-a.json  \n\n/cache/song-b.json\n  \n/cache/song-a.json\n/cache/song-c.json';
  assert.deepEqual(
    parseCachePaths(text),
    ['/cache/song-a.json', '/cache/song-b.json', '/cache/song-c.json'],
    'parseCachePaths trims each line, drops blanks, and drops repeats while keeping first-seen order',
  );
  assert.deepEqual(parseCachePaths(''), [], 'an empty string yields no paths');
  assert.deepEqual(parseCachePaths('   \n  \n'), [], 'whitespace-only lines yield no paths');
}

/* -------------------------------- validateForm ------------------------------ */
{
  const empty = validateForm(initialForm());
  assert.deepEqual(
    empty,
    { ok: false, message: 'Add at least one cache file path.' },
    'validateForm rejects an empty path list with the exact message',
  );
  const filled: WizardForm = { ...initialForm(), cachePathsText: '/cache/song-a.json' };
  assert.deepEqual(validateForm(filled), { ok: true }, 'validateForm accepts at least one path');
}

/* ------------------------------ buildStageRequest --------------------------- */
{
  const blank: WizardForm = {
    cachePathsText: '/cache/song-a.json',
    mediaRoot: '   ',
    namespace: '  ',
    resume: false,
  };
  assert.deepEqual(
    buildStageRequest(blank),
    { cache_paths: ['/cache/song-a.json'], resume: false },
    'buildStageRequest omits blank media_root and namespace (after trim) but always keeps resume',
  );
  const filled: WizardForm = {
    cachePathsText: '/cache/song-a.json',
    mediaRoot: ' /fixtures/media-root ',
    namespace: ' myns ',
    resume: true,
  };
  assert.deepEqual(
    buildStageRequest(filled),
    { cache_paths: ['/cache/song-a.json'], media_root: '/fixtures/media-root', namespace: 'myns', resume: true },
    'buildStageRequest trims and includes a non-blank media_root/namespace',
  );
}

/* ----------------------------- buildPromoteRequest --------------------------- */
{
  assert.deepEqual(buildPromoteRequest(true), { dry_run: true }, 'no limit at all => omitted');
  assert.deepEqual(buildPromoteRequest(true, 0), { dry_run: true }, 'a zero limit is omitted');
  assert.deepEqual(buildPromoteRequest(true, -5), { dry_run: true }, 'a negative limit is omitted');
  assert.deepEqual(buildPromoteRequest(true, 1.5), { dry_run: true }, 'a non-integer limit is omitted');
  assert.deepEqual(
    buildPromoteRequest(false, 10),
    { dry_run: false, limit: 10 },
    'a positive safe integer limit is kept',
  );
}

/* --------------------------------- canAdvance -------------------------------- */
{
  assert.equal(canAdvance('source', initialForm(), null), false, 'source blocks on an empty form');
  const withPath: WizardForm = { ...initialForm(), cachePathsText: '/cache/song-a.json' };
  assert.equal(canAdvance('source', withPath, null), true, 'source advances once the form validates');

  assert.equal(canAdvance('stage', withPath, null), false, 'stage blocks with no job at all');
  assert.equal(
    canAdvance('stage', withPath, baseJob({ kind: 'stage', status: 'running' })),
    false,
    'stage blocks while its job is still running',
  );
  assert.equal(
    canAdvance('stage', withPath, baseJob({ kind: 'promote', status: 'succeeded' })),
    false,
    'stage blocks on a succeeded job of the wrong kind',
  );
  assert.equal(
    canAdvance('stage', withPath, baseJob({ kind: 'stage', status: 'succeeded' })),
    true,
    'stage advances once a stage job succeeded',
  );

  assert.equal(
    canAdvance(
      'dryRun',
      withPath,
      baseJob({ kind: 'promote', status: 'succeeded', report: { dry_run: false } }),
    ),
    false,
    'dryRun blocks on a succeeded promote job that was not a dry run',
  );
  assert.equal(
    canAdvance(
      'dryRun',
      withPath,
      baseJob({ kind: 'promote', status: 'succeeded', report: { dry_run: true } }),
    ),
    true,
    'dryRun advances once a dry-run promote job succeeded',
  );

  assert.equal(
    canAdvance(
      'import',
      withPath,
      baseJob({ kind: 'promote', status: 'succeeded', report: { dry_run: true } }),
    ),
    true,
    'import advances on any succeeded promote job (matching kind)',
  );
  assert.equal(
    canAdvance('done', withPath, baseJob({ kind: 'promote', status: 'succeeded' })),
    false,
    'done never advances',
  );
}

/* ---------------------------------- nextStep --------------------------------- */
{
  assert.equal(nextStep('source'), 'stage');
  assert.equal(nextStep('stage'), 'dryRun');
  assert.equal(nextStep('dryRun'), 'import');
  assert.equal(nextStep('import'), 'done');
  assert.equal(nextStep('done'), null, 'nextStep walks source→stage→dryRun→import→done→null');
  assert.deepEqual(WIZARD_STEPS, ['source', 'stage', 'dryRun', 'import', 'done']);
  assert.equal(STEP_TITLES.dryRun, 'DRY RUN');
}

/* -------------------------------- formatCount -------------------------------- */
{
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1234567), '1,234,567', 'formatCount is thousands-separated');
  assert.equal(formatCount(NaN), '—', 'a non-finite count reads as an em dash');
}

/* --------------------------------- formatRate --------------------------------- */
{
  assert.equal(formatRate(12.44), '12.4 songs/s', 'formatRate rounds to one decimal');
  assert.equal(formatRate(NaN), '—', 'formatRate: NaN is non-finite');
  assert.equal(formatRate(Infinity), '—', 'formatRate: Infinity is non-finite');
  assert.equal(formatRate(-Infinity), '—', 'formatRate: -Infinity is non-finite');
  assert.equal(formatRate(-1), '—', 'formatRate: a negative rate is not shown');
}

/* ------------------------------- formatDuration ------------------------------- */
{
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(65), '1m 05s');
  assert.equal(formatDuration(7380), '2h 03m');
}

/* -------------------------------- formatBytes -------------------------------- */
{
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5e9), '4.7 GB', 'formatBytes uses 1024-based units, not decimal GB');
}

/* ------------------------------ stageReportRows ------------------------------- */
{
  const empty = stageReportRows(null);
  assert.equal(empty.length, 9, 'stageReportRows always emits nine rows');
  assert.deepEqual(
    empty.map((r) => r.label),
    [
      'Songs seen',
      'Accepted',
      'Duplicates',
      'Quarantined',
      'Same title, different song (kept)',
      'Media found locally',
      'Media remote only',
      'Media missing',
      'Unresolved lineage',
    ],
    'stageReportRows emits its nine labels in order',
  );
  assert.ok(
    empty.every((r) => r.value === 0),
    'a null report yields zero for every row',
  );

  const partial = stageReportRows({
    songs_seen: 100,
    accepted: 90,
    duplicates: 'oops',
    quarantined: 5,
  });
  assert.equal(partial[0]?.value, 100, 'songs_seen passes through');
  assert.equal(partial[1]?.value, 90, 'accepted passes through');
  assert.equal(partial[2]?.value, 0, 'a non-integer duplicates value reads as 0');
  assert.equal(partial[3]?.value, 5, 'quarantined passes through');
  assert.equal(partial[4]?.value, 0, 'a missing key reads as 0');
}

/* ------------------------------ totalsReconcile ------------------------------- */
{
  const ok = totalsReconcile({ songs_seen: 10, accepted: 6, duplicates: 2, quarantined: 2 });
  assert.deepEqual(ok, { ok: true, message: 'Totals reconcile' });

  const bad = totalsReconcile({ songs_seen: 10, accepted: 6, duplicates: 2, quarantined: 1 });
  assert.deepEqual(bad, {
    ok: false,
    message: 'Totals do not reconcile: 10 seen vs 9 accounted for',
  });
}

/* -------------------------------- spaceVerdict -------------------------------- */
{
  const fits = spaceVerdict(1024, 2048);
  assert.deepEqual(fits, { ok: true, message: 'Needs 1.0 KB of 2.0 KB free' });

  const short = spaceVerdict(5000, 2048);
  assert.deepEqual(short, { ok: false, message: 'Not enough space: needs 4.9 KB, 2.0 KB free' });
}

console.log('wizardModel: ok');
