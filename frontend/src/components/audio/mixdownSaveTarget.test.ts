// Run with: npx tsx src/components/audio/mixdownSaveTarget.test.ts
import assert from 'node:assert/strict';
import {
  mixdownSaveOptions,
  mixdownSaveTargetFromPath,
  shouldApplyMixdownSave,
} from './mixdownSaveTarget';

// --- mixdownSaveTargetFromPath ---------------------------------------------
{
  const dirnameOf = (p: string) => (p.lastIndexOf('\\') < 0 ? '' : p.slice(0, p.lastIndexOf('\\')));
  const basenameOf = (p: string) => p.slice(p.lastIndexOf('\\') + 1);

  assert.deepEqual(
    mixdownSaveTargetFromPath('C:\\Users\\me\\Music\\mix.wav', dirnameOf, basenameOf),
    { dir: 'C:\\Users\\me\\Music', name: 'mix.wav' },
  );
  // Nothing to remember: cancelled/downloaded saves pass path = null.
  assert.equal(mixdownSaveTargetFromPath(null, dirnameOf, basenameOf), null);
  // A bare file name with no folder half is not a usable target.
  assert.equal(mixdownSaveTargetFromPath('mix.wav', dirnameOf, basenameOf), null);
}

// --- mixdownSaveOptions ------------------------------------------------------
// `explicitName` is a caller-supplied FACT (did the title come from the
// mixdown-name field or the auto-generated fallback), never guessed from the
// text: a user who happens to type exactly "mixdown_123456.wav" must still be
// treated as explicit — the old regex-sniffing version got this wrong.
{
  // No known target yet: the title is passed straight through, no initialDir,
  // regardless of `explicitName`.
  assert.deepEqual(mixdownSaveOptions('mixdown_123456.wav', true, null), {
    suggestedName: 'mixdown_123456.wav',
  });
  assert.deepEqual(mixdownSaveOptions('mixdown_123456.wav', false, null), {
    suggestedName: 'mixdown_123456.wav',
  });

  const target = { dir: 'C:\\Users\\me\\Music', name: 'previous.wav' };

  // Not explicit (the auto-generated fallback) + known target: BOTH the
  // folder and the file name are reused, so the dialog reopens pointed at
  // the known file.
  assert.deepEqual(mixdownSaveOptions('mixdown_654321.wav', false, target), {
    suggestedName: 'previous.wav',
    initialDir: 'C:\\Users\\me\\Music',
  });

  // Explicit (user typed it) wins over the remembered file name even when
  // the typed text happens to LOOK like the auto-generated shape — the
  // decision is the caller's `explicitName` flag, never the text itself.
  assert.deepEqual(mixdownSaveOptions('mixdown_654321.wav', true, target), {
    suggestedName: 'mixdown_654321.wav',
    initialDir: 'C:\\Users\\me\\Music',
  });

  // An ordinary explicit name: same rule, remembered folder only.
  assert.deepEqual(mixdownSaveOptions('Fresh Take.wav', true, target), {
    suggestedName: 'Fresh Take.wav',
    initialDir: 'C:\\Users\\me\\Music',
  });
}

// --- shouldApplyMixdownSave: out-of-order completions don't clobber --------
// Two mixdowns queued back to back render+save independently (the Save As
// dialog is never awaited, so the queue moves on); either can finish first.
// An OLDER job's save completing AFTER a NEWER job's must not overwrite the
// newer job's target with a stale one.
{
  // First save ever: nothing to compare against.
  assert.equal(shouldApplyMixdownSave(0, -1), true);

  // In-order: job 0 then job 1, each newer than the last applied.
  assert.equal(shouldApplyMixdownSave(1, 0), true);

  // Out of order: job 1 (newer) already applied; job 0's save finally
  // completes afterward and must be rejected.
  assert.equal(shouldApplyMixdownSave(0, 1), false);

  // A job's own completion is never rejected against itself (idempotent
  // boundary — `>=`, not `>`).
  assert.equal(shouldApplyMixdownSave(2, 2), true);
}

console.log('mixdownSaveTarget: ok');
