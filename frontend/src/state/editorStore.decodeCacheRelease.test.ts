/**
 * T66B: `decodeCache.releaseDecoded` frees a clip's decoded PCM, but nothing
 * called it — a deleted clip's ~80 MB/4-min buffer stayed resident until an
 * (unconfigured, unbounded by default) eviction budget happened to reclaim it,
 * which in practice never happened. This pins the three places editorStore now
 * calls it: single-clip removal, a track removal that takes its clips with it,
 * and a project load/close (`loadProject`, which "New Project" also calls with
 * empty tracks/clips — see its own header).
 *
 * Run: npx tsx src/state/editorStore.decodeCacheRelease.test.ts
 */
import assert from 'node:assert/strict';
import { beginUndoStep, useEditorStore, type AudioClip } from './editorStore.ts';
import { decodeClipBlob, decodeCacheStats, clearDecodeCache } from '../lib/decodeCache.ts';

/** A fake context whose decode resolves immediately to a distinguishable,
 *  correctly-accounted buffer (decodeCache's byte accounting reads
 *  `numberOfChannels`/`length`/`sampleRate` off it). */
class FakeContext {
  readonly sampleRate = 44100;
  decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
    return Promise.resolve({
      numberOfChannels: 1,
      length: 128,
      sampleRate: this.sampleRate,
      duration: 128 / this.sampleRate,
    } as unknown as AudioBuffer);
  }
  get ctx(): BaseAudioContext {
    return this as unknown as BaseAudioContext;
  }
}

const es = () => useEditorStore.getState();
const clipBlob = (tag: string) => new Blob([tag], { type: 'audio/wav' });

const baseClip = (over: Partial<AudioClip> = {}): Omit<AudioClip, 'id'> => ({
  trackId: 't1',
  label: 'clip',
  audioBlob: clipBlob('base'),
  mimeType: 'audio/wav',
  sourceDuration: 4,
  offsetIntoSource: 0,
  durationSec: 4,
  startSec: 0,
  color: '#fff',
  fadeInSec: 0,
  fadeOutSec: 0,
  ...over,
} as Omit<AudioClip, 'id'>);

const resetStore = () => {
  clearDecodeCache();
  useEditorStore.setState({
    tracks: [{ id: 't1', name: 'T1', color: '#fff' } as never],
    clips: [],
    selectedClipId: null,
    selectedClipIds: [],
  });
};

// ── removeClip releases the clip's decoded buffer ────────────────────────────
{
  resetStore();
  const ctx = new FakeContext();
  const blob = clipBlob('a');
  const id = es().addClipToTrack(baseClip({ audioBlob: blob }));
  await decodeClipBlob(ctx.ctx, blob);
  assert.equal(decodeCacheStats().entries, 1, 'the decode populated the cache');

  es().removeClip(id);

  assert.equal(decodeCacheStats().entries, 0, 'removeClip released the decoded buffer');
}

// ── removeClip releases every TAKE's decoded buffer too, not just the clip's
//    own (active) media ──────────────────────────────────────────────────────
{
  resetStore();
  const ctx = new FakeContext();
  const activeBlob = clipBlob('active');
  const takeBlob = clipBlob('take');
  const id = es().addClipToTrack(baseClip({ audioBlob: activeBlob }));
  es().addTakeToClip(id, {
    id: 'tk1', label: 'Take 2', audioBlob: takeBlob, mimeType: 'audio/wav',
    sourceDuration: 4, offsetIntoSource: 0,
  });
  await decodeClipBlob(ctx.ctx, activeBlob);
  await decodeClipBlob(ctx.ctx, takeBlob);
  assert.equal(decodeCacheStats().entries, 2, 'both the clip and its take decoded');

  es().removeClip(id);

  assert.equal(decodeCacheStats().entries, 0, 'removeClip released the clip AND every take');
}

// ── removeTrack releases every clip it takes with it ─────────────────────────
{
  resetStore();
  const ctx = new FakeContext();
  const blobA = clipBlob('trackA-1');
  const blobB = clipBlob('trackA-2');
  es().addClipToTrack(baseClip({ trackId: 't1', audioBlob: blobA, startSec: 0 }));
  es().addClipToTrack(baseClip({ trackId: 't1', audioBlob: blobB, startSec: 5 }));
  await decodeClipBlob(ctx.ctx, blobA);
  await decodeClipBlob(ctx.ctx, blobB);
  assert.equal(decodeCacheStats().entries, 2);

  es().removeTrack('t1');

  assert.equal(decodeCacheStats().entries, 0, 'removeTrack released every clip it removed');
}

// ── loadProject (also "New Project") releases every clip of the OUTGOING
//    document ──────────────────────────────────────────────────────────────
{
  resetStore();
  const ctx = new FakeContext();
  const blob = clipBlob('outgoing');
  es().addClipToTrack(baseClip({ audioBlob: blob }));
  await decodeClipBlob(ctx.ctx, blob);
  assert.equal(decodeCacheStats().entries, 1);

  es().loadProject({ tracks: [], clips: [], routing: undefined, buses: undefined, bpm: undefined, timeSignature: undefined } as never);

  assert.equal(decodeCacheStats().entries, 0, 'loadProject released the outgoing document\'s clips');
}

// ── SHARING (audit MAJOR #1): a Blob object is not owned by one clip. A split,
//    a duplicate/paste, and projectImport's active-take mirroring all leave
//    two+ clips (or a clip and a surviving take) pointing at the SAME Blob
//    reference — releasing it because ONE of them was removed would make the
//    survivor's very next play/bounce silently re-decode from scratch. ─────────

// removeClip on one half of a split does not release the shared Blob; removing
// BOTH halves does.
{
  resetStore();
  const ctx = new FakeContext();
  const blob = clipBlob('split-source');
  const id = es().addClipToTrack(baseClip({ audioBlob: blob, startSec: 0, durationSec: 4 }));
  await decodeClipBlob(ctx.ctx, blob);
  assert.equal(decodeCacheStats().entries, 1);

  const rightId = es().splitClipAt(id, 2)!;
  assert.ok(rightId, 'the split produced a second clip');
  assert.equal(es().clips.find((c) => c.id === id)!.audioBlob, blob, 'left half shares the Blob');
  assert.equal(es().clips.find((c) => c.id === rightId)!.audioBlob, blob, 'right half shares the Blob');

  es().removeClip(id); // left half gone
  assert.equal(decodeCacheStats().entries, 1, 'the right half still reads this Blob — not released');

  es().removeClip(rightId); // right half gone too — nothing left reads it
  assert.equal(decodeCacheStats().entries, 0, 'released once no surviving clip shares it');
}

// removeClip on the original of a duplicate/paste does not release the Blob
// the duplicate still shares (duplicate/paste hands `addClipToTrack` a spread
// of the source clip, per its own header comment — same Blob reference).
{
  resetStore();
  const ctx = new FakeContext();
  const blob = clipBlob('dup-source');
  const originalId = es().addClipToTrack(baseClip({ audioBlob: blob }));
  await decodeClipBlob(ctx.ctx, blob);
  assert.equal(decodeCacheStats().entries, 1);

  const { id: _origId, ...originalRest } = es().clips.find((c) => c.id === originalId)!;
  const dupId = es().addClipToTrack({ ...originalRest, startSec: 10 });
  assert.notEqual(dupId, originalId);
  assert.equal(es().clips.find((c) => c.id === dupId)!.audioBlob, blob);

  es().removeClip(originalId);
  assert.equal(decodeCacheStats().entries, 1, 'the duplicate still reads this Blob — not released');

  es().removeClip(dupId);
  assert.equal(decodeCacheStats().entries, 0, 'released once the duplicate is gone too');
}

// removeTrack: a clip on the removed track sharing a Blob with a clip on a
// SURVIVING track keeps that Blob resident.
{
  resetStore();
  useEditorStore.setState({
    tracks: [{ id: 't1', name: 'T1', color: '#fff' } as never, { id: 't2', name: 'T2', color: '#fff' } as never],
  });
  const ctx = new FakeContext();
  const blob = clipBlob('cross-track');
  es().addClipToTrack(baseClip({ trackId: 't1', audioBlob: blob }));
  es().addClipToTrack(baseClip({ trackId: 't2', audioBlob: blob, startSec: 8 }));
  await decodeClipBlob(ctx.ctx, blob);
  assert.equal(decodeCacheStats().entries, 1);

  es().removeTrack('t1');
  assert.equal(decodeCacheStats().entries, 1, 't2\'s clip still reads this Blob — not released');

  es().removeTrack('t2');
  assert.equal(decodeCacheStats().entries, 0);
}

// loadProject: the INCOMING document sharing a Blob with the OUTGOING one
// (projectImport's active-take mirroring can do exactly this) keeps it
// resident; an incoming document with none of the outgoing Blobs releases it.
{
  resetStore();
  const ctx = new FakeContext();
  const blob = clipBlob('carried-forward');
  es().addClipToTrack(baseClip({ audioBlob: blob }));
  await decodeClipBlob(ctx.ctx, blob);
  assert.equal(decodeCacheStats().entries, 1);

  const incomingSharedClip = { ...baseClip({ audioBlob: blob }), id: 'incoming-1' } as AudioClip;
  es().loadProject({
    tracks: [{ id: 't1', name: 'T1', color: '#fff' } as never],
    clips: [incomingSharedClip],
    routing: undefined, buses: undefined, bpm: undefined, timeSignature: undefined,
  } as never);
  assert.equal(decodeCacheStats().entries, 1, 'the incoming document still reads this Blob — not released');

  // A second load whose incoming document does NOT carry the Blob forward
  // finally releases it.
  es().loadProject({ tracks: [], clips: [], routing: undefined, buses: undefined, bpm: undefined, timeSignature: undefined } as never);
  assert.equal(decodeCacheStats().entries, 0);
}

// A Blob only UNDO HISTORY holds (the live clip array no longer has it) IS
// released — undo does not re-decode on release; it restores the clip object,
// whose own `audioBlob` field is untouched, and the next play decodes it fresh
// exactly like any clip that was never played. Confirms the fix does not go
// further than "skip Blobs `get().clips` still references".
{
  resetStore();
  const ctx = new FakeContext();
  const blob = clipBlob('undo-only');
  beginUndoStep();
  const id = es().addClipToTrack(baseClip({ audioBlob: blob }));
  await decodeClipBlob(ctx.ctx, blob);
  assert.equal(decodeCacheStats().entries, 1);

  es().removeClip(id); // the clip is gone from `clips`; the undo stack still holds it
  assert.equal(decodeCacheStats().entries, 0, 'undo history alone does not keep the Blob resident');
  assert.ok(es()._undo.length > 0, 'sanity: there is in fact an undo step to restore from');
}

// ── FREEZE/UNFREEZE: the same leak class T66B closes elsewhere (audit
//    follow-up #1). `unfreezeTrack` discards the printed stem clip it swaps
//    back out for the originals; `removeTrack` on a still-frozen track drops
//    BOTH the current stem clip AND the parked `frozenOriginal.clips` — none
//    of which were ever released before this fix. ───────────────────────────

// unfreezeTrack releases the discarded stem's Blob (when nothing else shares
// it) once the originals are back.
{
  resetStore();
  const ctx = new FakeContext();
  const origBlob = clipBlob('freeze-orig');
  const stemBlob = clipBlob('freeze-stem');
  es().addClipToTrack(baseClip({ trackId: 't1', audioBlob: origBlob }));
  await decodeClipBlob(ctx.ctx, origBlob);
  assert.equal(decodeCacheStats().entries, 1);

  es().freezeTrack('t1', { audioBlob: stemBlob, durationSec: 4 });
  assert.equal(es().clips.length, 1, 'the clip is now the one printed stem');
  assert.equal(es().clips[0].audioBlob, stemBlob);
  await decodeClipBlob(ctx.ctx, stemBlob);
  assert.equal(decodeCacheStats().entries, 2, 'orig stays cached (parked for unfreeze) alongside the new stem');

  es().unfreezeTrack('t1');
  assert.equal(es().clips.length, 1, 'the original is back');
  assert.equal(es().clips[0].audioBlob, origBlob);
  assert.equal(decodeCacheStats().entries, 1, 'the discarded stem was released; the restored original stays cached');
}

// removeTrack on a track that is STILL FROZEN releases both the current stem
// clip and every parked frozenOriginal clip — the track and everything it
// was holding onto, live or parked, is gone.
{
  resetStore();
  const ctx = new FakeContext();
  const origBlob = clipBlob('freeze-orig-2');
  const stemBlob = clipBlob('freeze-stem-2');
  es().addClipToTrack(baseClip({ trackId: 't1', audioBlob: origBlob }));
  await decodeClipBlob(ctx.ctx, origBlob);
  es().freezeTrack('t1', { audioBlob: stemBlob, durationSec: 4 });
  await decodeClipBlob(ctx.ctx, stemBlob);
  assert.equal(decodeCacheStats().entries, 2);

  es().removeTrack('t1');
  assert.equal(decodeCacheStats().entries, 0, 'both the stem and the parked original are released');
}

// removeTrack on a FROZEN track still respects sharing: a parked original
// whose Blob is also live on a surviving track is not released.
{
  resetStore();
  useEditorStore.setState({
    tracks: [{ id: 't1', name: 'T1', color: '#fff' } as never, { id: 't2', name: 'T2', color: '#fff' } as never],
  });
  const ctx = new FakeContext();
  const sharedBlob = clipBlob('freeze-shared');
  const stemBlob = clipBlob('freeze-stem-3');
  es().addClipToTrack(baseClip({ trackId: 't1', audioBlob: sharedBlob }));
  es().addClipToTrack(baseClip({ trackId: 't2', audioBlob: sharedBlob, startSec: 8 }));
  await decodeClipBlob(ctx.ctx, sharedBlob);
  es().freezeTrack('t1', { audioBlob: stemBlob, durationSec: 4 });
  await decodeClipBlob(ctx.ctx, stemBlob);
  assert.equal(decodeCacheStats().entries, 2);

  es().removeTrack('t1');
  assert.equal(decodeCacheStats().entries, 1, 't2\'s clip still reads the shared Blob — not released');

  es().removeTrack('t2');
  assert.equal(decodeCacheStats().entries, 0);
}

// ── TAKE-to-TAKE sharing: a removed clip's take sharing a Blob with a
//    SURVIVING clip's take must not release it (audit follow-up #4a). ────────
{
  resetStore();
  const ctx = new FakeContext();
  const sharedTakeBlob = clipBlob('shared-take');
  const clipAId = es().addClipToTrack(baseClip({ audioBlob: clipBlob('a-active') }));
  es().addTakeToClip(clipAId, {
    id: 'tk-a', label: 'Take 2', audioBlob: sharedTakeBlob, mimeType: 'audio/wav',
    sourceDuration: 4, offsetIntoSource: 0,
  });
  const clipBId = es().addClipToTrack(baseClip({ audioBlob: clipBlob('b-active'), startSec: 10 }));
  es().addTakeToClip(clipBId, {
    id: 'tk-b', label: 'Take 2', audioBlob: sharedTakeBlob, mimeType: 'audio/wav',
    sourceDuration: 4, offsetIntoSource: 0,
  });
  await decodeClipBlob(ctx.ctx, sharedTakeBlob);
  assert.equal(decodeCacheStats().entries, 1, 'the shared take blob decoded once');

  es().removeClip(clipAId);
  assert.equal(decodeCacheStats().entries, 1, 'clip B\'s take still reads this Blob — not released');

  es().removeClip(clipBId);
  assert.equal(decodeCacheStats().entries, 0, 'released once nothing shares it any more');
}

// ── undo of a delete restores a clip whose audioBlob still decodes cleanly —
//    releasing it on delete never poisons the Blob, only evicts the cache
//    entry (audit follow-up #4b). ────────────────────────────────────────────
{
  resetStore();
  const ctx = new FakeContext();
  const blob = clipBlob('undo-then-redecode');
  beginUndoStep();
  const id = es().addClipToTrack(baseClip({ audioBlob: blob }));
  await decodeClipBlob(ctx.ctx, blob);
  assert.equal(decodeCacheStats().entries, 1);

  beginUndoStep(); // the delete must be its own step, or undo would pop the ADD too
  es().removeClip(id);
  assert.equal(decodeCacheStats().entries, 0, 'the delete released the cache entry');

  es().undo();
  const restored = es().clips.find((c) => c.id === id);
  assert.ok(restored, 'undo restored the clip');
  assert.equal(restored!.audioBlob, blob, 'with its ORIGINAL Blob object, untouched by the release');

  // The Blob itself is unharmed by the earlier release — it decodes exactly
  // as it did the first time.
  const { buffer } = await decodeClipBlob(ctx.ctx, restored!.audioBlob).then((b) => ({ buffer: b }));
  assert.ok(buffer, 'the restored clip\'s Blob still decodes after being released once');
  assert.equal(decodeCacheStats().entries, 1, 'and the decode re-populated the cache');
}

console.log('editorStore.decodeCacheRelease: ok');
