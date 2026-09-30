/**
 * node:assert cover for the clip-edit classifier. Run from `frontend/`:
 *   npx tsx src/lib/clipEditTarget.test.ts
 *
 * The classifier exists because the app asked "is this a MIDI clip?" in four
 * places with three different answers. These are the cases that differed.
 */
import assert from 'node:assert/strict';

import { clipEditKind, isMidiClip, type ClipEditTargetLike } from './clipEditTarget.ts';

const clip = (c: ClipEditTargetLike): ClipEditTargetLike => c;

/* ------------------------------- MIDI clips ------------------------------- */
{
  assert.equal(
    clipEditKind(clip({ sourceKind: 'piano-roll', sourcePianoRoll: [{ note: 60 }] })),
    'midi',
    'a roll with notes is MIDI',
  );
  // The case every existing `sourcePianoRoll.length > 0` check got wrong: an
  // empty roll is a valid editable document, not an audio clip.
  assert.equal(
    clipEditKind(clip({ sourceKind: 'piano-roll', sourcePianoRoll: [] })),
    'midi',
    'an EMPTY roll is still MIDI',
  );
  // Clips bounced before lanes existed carry no `sourceRollNotes`; a roll that
  // carries only those is the mirror case, and both are the roll's notes.
  assert.equal(
    clipEditKind(clip({ sourceKind: 'piano-roll', sourceRollNotes: [] })),
    'midi',
    'lane notes alone are still MIDI',
  );
}

/* ------------------------------ audio clips ------------------------------- */
{
  assert.equal(clipEditKind(clip({})), 'audio', 'a clip that names no source kind is audio');
  assert.equal(clipEditKind(clip({ sourceKind: 'audio' })), 'audio', 'a plain audio clip is audio');
  // The double-click bug: `clip.sourcePianoRoll` truthy was the whole test, so
  // an audio clip carrying leftover notes opened the piano roll.
  assert.equal(
    clipEditKind(clip({ sourceKind: 'audio', sourcePianoRoll: [{ note: 60 }] })),
    'audio',
    'notes on a clip whose kind is audio do not make it MIDI',
  );
  assert.equal(
    clipEditKind(clip({ sourcePianoRoll: [{ note: 60 }] })),
    'audio',
    'notes with no source kind at all do not make it MIDI',
  );
  // A clip that claims to be a roll but carries no note list is not an editable
  // roll — there is no document to open. Its rendered audio still is one.
  assert.equal(
    clipEditKind(clip({ sourceKind: 'piano-roll' })),
    'audio',
    'a roll with no note list is audio',
  );
  // A project file hand-edited to an unknown kind falls to audio rather than
  // throwing: every clip carries bytes, so audio is always a safe answer.
  assert.equal(
    clipEditKind(clip({ sourceKind: 'stem', sourcePianoRoll: [] })),
    'audio',
    'an unknown source kind is audio',
  );
}

/* --------------------------- the boolean wrapper -------------------------- */
{
  assert.equal(isMidiClip(clip({ sourceKind: 'piano-roll', sourcePianoRoll: [] })), true);
  assert.equal(isMidiClip(clip({ sourceKind: 'audio', sourcePianoRoll: [{ note: 60 }] })), false);
  // Every input agrees with the kind it classifies as — one rule, two readings.
  for (const c of [
    clip({}),
    clip({ sourceKind: 'piano-roll' }),
    clip({ sourceKind: 'piano-roll', sourcePianoRoll: [] }),
    clip({ sourceKind: 'audio', sourceRollNotes: [{ note: 60 }] }),
  ]) {
    assert.equal(isMidiClip(c), clipEditKind(c) === 'midi', 'the wrapper is the classifier');
  }
}

/* ---------------------- non-arrays are not note lists --------------------- */
{
  // Persisted JSON that lost its shape must not be mistaken for a document.
  const bad = { sourceKind: 'piano-roll', sourcePianoRoll: 'notes' } as unknown as ClipEditTargetLike;
  assert.equal(clipEditKind(bad), 'audio', 'a non-array note list is not a note list');
}

console.log('clipEditTarget: ok');
