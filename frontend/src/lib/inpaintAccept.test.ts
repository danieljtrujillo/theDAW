/**
 * The EDIT inpaint accept (lib/inpaintAccept): the geometry Accept writes, the
 * edits made while the job ran that make it refuse, and the library repoint
 * that follows the save.
 */
import assert from 'node:assert/strict';
import {
  keepsAcceptedAudio,
  renderedWindowPatch,
  resolveInpaintAccept,
  snapshotInpaintClip,
  type InpaintClipLike,
} from './inpaintAccept';

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
  const res = resolveInpaintAccept(rightHalf, snap, decoded);
  assert.ok(res.ok === true, 'an untouched clip accepts');
  assert.equal(res.patch.offsetIntoSource, 0);
  assert.equal(res.patch.sourceDuration, decoded);
  assert.equal(res.patch.durationSec, decoded);
  // The old entry holds the audio from before the inpaint; it is dropped until
  // the save of the result lands.
  assert.ok('libraryEntryId' in res.patch);
  assert.equal(res.patch.libraryEntryId, undefined);
}

// Trimmed from the right while the job ran: refused, and the reason says why.
{
  const snap = snapshotInpaintClip(rightHalf);
  const res = resolveInpaintAccept({ ...rightHalf, durationSec: 5.5 }, snap, 8);
  assert.ok(res.ok === false);
  assert.match(res.reason, /trimmed or split/);
}

// Trimmed from the left (the window moves into the source): refused.
{
  const snap = snapshotInpaintClip(rightHalf);
  const leftTrimmed = { ...rightHalf, offsetIntoSource: 12.5, durationSec: 7.5, startSec: 12.5 };
  assert.equal(resolveInpaintAccept(leftTrimmed, snap, 8).ok, false);
}

// Split again while the job ran: the left part keeps the clip's id and loses length.
{
  const snap = snapshotInpaintClip(rightHalf);
  assert.equal(resolveInpaintAccept({ ...rightHalf, durationSec: 3 }, snap, 8).ok, false);
}

// Deleted: refused with its own reason.
{
  const snap = snapshotInpaintClip(rightHalf);
  const res = resolveInpaintAccept(undefined, snap, 8);
  assert.ok(res.ok === false);
  assert.match(res.reason, /gone/);
}

// A different clip under the same lookup is not this clip.
{
  const snap = snapshotInpaintClip(rightHalf);
  assert.equal(resolveInpaintAccept({ ...rightHalf, id: 'clip-c' }, snap, 8).ok, false);
}

// Audio replaced while the job ran (Time/Pitch, another accept): refused even
// when the new audio happens to have the same window.
{
  const snap = snapshotInpaintClip(rightHalf);
  const res = resolveInpaintAccept({ ...rightHalf, audioBlob: replaced }, snap, 8);
  assert.ok(res.ok === false);
  assert.match(res.reason, /audio was replaced/);
}

// Undo brings the same Blob back, so the accept goes through again.
{
  const snap = snapshotInpaintClip(rightHalf);
  const undone = { ...rightHalf, audioBlob: source };
  assert.equal(resolveInpaintAccept(undone, snap, 8).ok, true);
}

// Moved along the timeline or to another lane: the window and the audio are
// the same, so the result still fits.
{
  const snap = snapshotInpaintClip(rightHalf);
  const moved = { ...rightHalf, startSec: 30 };
  const otherLane = { ...rightHalf, trackId: 'track-2' };
  assert.equal(resolveInpaintAccept(moved, snap, 8).ok, true);
  assert.equal(resolveInpaintAccept(otherLane, snap, 8).ok, true);
}

// Sub-millisecond float drift from a drag that ended where it began is not an edit.
{
  const snap = snapshotInpaintClip(rightHalf);
  const drifted = { ...rightHalf, offsetIntoSource: 12 + 1e-6, durationSec: 8 - 1e-6 };
  assert.equal(resolveInpaintAccept(drifted, snap, 8).ok, true);
}

// A result that decodes to nothing is refused.
{
  const snap = snapshotInpaintClip(rightHalf);
  assert.equal(resolveInpaintAccept(rightHalf, snap, 0).ok, false);
  assert.equal(resolveInpaintAccept(rightHalf, snap, Number.NaN).ok, false);
}

// The repoint after the save lands only while the clip still plays the result.
{
  const result = { name: 'inpaint result' };
  assert.equal(keepsAcceptedAudio({ audioBlob: result }, result), true);
  assert.equal(keepsAcceptedAudio({ audioBlob: source }, result), false, 'undone before the save landed');
  assert.equal(keepsAcceptedAudio(undefined, result), false, 'deleted before the save landed');
}

// Time/Pitch writes the same geometry: a stretched 8 s window of a 20 s take
// becomes a 6.4 s clip that plays its own render from 0.
{
  const patch = renderedWindowPatch(6.4);
  assert.deepEqual(patch, { offsetIntoSource: 0, sourceDuration: 6.4, durationSec: 6.4, libraryEntryId: undefined });
}

console.log('inpaintAccept: all tests passed');
