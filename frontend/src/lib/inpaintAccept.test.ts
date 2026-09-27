/**
 * The EDIT inpaint accept (lib/inpaintAccept): the geometry Accept writes, the
 * edits made while the job ran that make it refuse, and the library entry the
 * clip points at afterwards.
 */
import assert from 'node:assert/strict';
import {
  inpaintResultEntryId,
  renderedWindowGeometry,
  resolveInpaintAccept,
  snapshotInpaintClip,
  type InpaintClipLike,
} from './inpaintAccept';
import { entryKeyForClip, stemsEntryIdOf, timePitchSource } from './clipAudioSource';

const source = { name: 'take 1' };
const replaced = { name: 'stretched take 1' };

// A 20 s take split at 12 s: the right half starts 12 s into the source and
// plays 8 s. Its crop is those 8 s, so the result is 8 s long and starts at 0.
const rightHalf: InpaintClipLike & { startSec: number; trackId: string } = {
  id: 'clip-b',
  offsetIntoSource: 12,
  durationSec: 8,
  audioBlob: source,
  startSec: 12,
  trackId: 'track-1',
};

// Split, then inpaint: the offset resets and both lengths are the result's.
{
  const snap = snapshotInpaintClip(rightHalf);
  const decoded = 8 - 1 / 44100; // the model truncates to whole samples
  const res = resolveInpaintAccept(rightHalf, snap, decoded, inpaintResultEntryId('job-7'));
  assert.ok(res.ok === true, 'an untouched clip accepts');
  assert.equal(res.patch.offsetIntoSource, 0);
  assert.equal(res.patch.sourceDuration, decoded);
  assert.equal(res.patch.durationSec, decoded);
  // The clip points at the entry the backend saved the result as, which holds
  // exactly this audio: Split to stems separates it and the readout is its own.
  const accepted = {
    ...rightHalf,
    libraryEntryId: 'take-1',
    ...timePitchSource({ libraryEntryId: 'take-1' }, 1.1, 2),
    stemsEntryId: 'stale',
    ...res.patch,
  };
  assert.equal(accepted.libraryEntryId, 'job-7_00');
  assert.equal(stemsEntryIdOf(accepted), 'job-7_00');
  assert.equal(entryKeyForClip(accepted, 'A', 'minor'), 'Am', 'the saved entry is analysed as it sounds');
}

// The backend has no entry for the result: the clip keeps its own entry as
// provenance, marked as playing audio that entry does not hold, so Split to
// stems separates the result and not the audio from before the inpaint.
{
  const snap = snapshotInpaintClip(rightHalf);
  const res = resolveInpaintAccept(rightHalf, snap, 8, null);
  assert.ok(res.ok === true);
  assert.equal('libraryEntryId' in res.patch, false);
  assert.equal(res.patch.audioRendered, true);
  const accepted = { ...rightHalf, libraryEntryId: 'take-1', stemsEntryId: 'stale', ...res.patch };
  assert.equal(accepted.libraryEntryId, 'take-1');
  assert.equal(stemsEntryIdOf(accepted), null);
}

// The entry id is the one MAKE reads for a single take: `<job id>_00`.
{
  assert.equal(inpaintResultEntryId('3f2a'), '3f2a_00');
}

// Trimmed from the right while the job ran: refused, and the reason says why.
{
  const snap = snapshotInpaintClip(rightHalf);
  const res = resolveInpaintAccept({ ...rightHalf, durationSec: 5.5 }, snap, 8, null);
  assert.ok(res.ok === false);
  assert.match(res.reason, /trimmed or split/);
}

// Trimmed from the left (the window moves into the source): refused.
{
  const snap = snapshotInpaintClip(rightHalf);
  const leftTrimmed = { ...rightHalf, offsetIntoSource: 12.5, durationSec: 7.5, startSec: 12.5 };
  assert.equal(resolveInpaintAccept(leftTrimmed, snap, 8, null).ok, false);
}

// Split again while the job ran: the left part keeps the clip's id and loses length.
{
  const snap = snapshotInpaintClip(rightHalf);
  assert.equal(resolveInpaintAccept({ ...rightHalf, durationSec: 3 }, snap, 8, null).ok, false);
}

// Deleted: refused with its own reason.
{
  const snap = snapshotInpaintClip(rightHalf);
  const res = resolveInpaintAccept(undefined, snap, 8, null);
  assert.ok(res.ok === false);
  assert.match(res.reason, /gone/);
}

// A different clip under the same lookup is not this clip.
{
  const snap = snapshotInpaintClip(rightHalf);
  assert.equal(resolveInpaintAccept({ ...rightHalf, id: 'clip-c' }, snap, 8, null).ok, false);
}

// Audio replaced while the job ran (Time/Pitch, another accept): refused even
// when the new audio happens to have the same window.
{
  const snap = snapshotInpaintClip(rightHalf);
  const res = resolveInpaintAccept({ ...rightHalf, audioBlob: replaced }, snap, 8, null);
  assert.ok(res.ok === false);
  assert.match(res.reason, /audio was replaced/);
}

// Undo brings the same Blob back, so the accept goes through again.
{
  const snap = snapshotInpaintClip(rightHalf);
  const undone = { ...rightHalf, audioBlob: source };
  assert.equal(resolveInpaintAccept(undone, snap, 8, null).ok, true);
}

// Moved along the timeline or to another lane: the window and the audio are
// the same, so the result still fits.
{
  const snap = snapshotInpaintClip(rightHalf);
  const moved = { ...rightHalf, startSec: 30 };
  const otherLane = { ...rightHalf, trackId: 'track-2' };
  assert.equal(resolveInpaintAccept(moved, snap, 8, null).ok, true);
  assert.equal(resolveInpaintAccept(otherLane, snap, 8, null).ok, true);
}

// Sub-millisecond float drift from a drag that ended where it began is not an edit.
{
  const snap = snapshotInpaintClip(rightHalf);
  const drifted = { ...rightHalf, offsetIntoSource: 12 + 1e-6, durationSec: 8 - 1e-6 };
  assert.equal(resolveInpaintAccept(drifted, snap, 8, null).ok, true);
}

// A result that decodes to nothing is refused.
{
  const snap = snapshotInpaintClip(rightHalf);
  assert.equal(resolveInpaintAccept(rightHalf, snap, 0, null).ok, false);
  assert.equal(resolveInpaintAccept(rightHalf, snap, Number.NaN, null).ok, false);
}

// Time/Pitch writes the same geometry: a stretched 8 s window of a 20 s take
// becomes a 6.4 s clip that plays its own render from 0.
{
  const patch = renderedWindowGeometry(6.4);
  assert.deepEqual(patch, { offsetIntoSource: 0, sourceDuration: 6.4, durationSec: 6.4 });
}

console.log('inpaintAccept: all tests passed');
