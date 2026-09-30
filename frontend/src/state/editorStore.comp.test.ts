// editorStore: takes + comping (#46) — the DOCUMENT side of `lib/clipComp`.
//
// The arithmetic is pinned in `clipComp.test.ts`; what is pinned here is
// everything the store adds to it:
//
//   * THE INVARIANT. A clip with takes always mirrors `takes[activeTakeIndex]`
//     in its `audioBlob` / `mimeType` / `sourceDuration` / `offsetIntoSource` /
//     `peaks`. Every path that knows nothing about takes — decode, peaks,
//     schedule, every offline bounce, export — keeps working because of it, so
//     it is asserted after EVERY action below, over the whole document.
//   * UNDO. Each action is one step of its own, however close it lands to the
//     last one; a boundary DRAG is one step for the whole gesture; an edit that
//     changes nothing records no step at all.
//   * SPLIT. Both halves keep the takes (blobs shared by reference), the right
//     half's read heads advance in SOURCE seconds, and the comp is partitioned.
//   * DUPLICATE/PASTE. Both go through `addClipToTrack` with a spread: the take
//     array is shared by reference (no blob copies) and the comp is copied.
//   * FREEZE. A comp edit — and a take being swapped underneath an unchanged
//     comp — stales a frozen render; everything else leaves the signature alone.
import assert from 'node:assert/strict';
import {
  beginUndoStep, freezeSignature, trackFreezeSignature, useEditorStore,
  type AudioClip, type ClipTake, type CompRegion, type EditorTrack,
} from './editorStore.ts';
import type { ChainEntry } from './effectChainStore.ts';

const st = () => useEditorStore.getState();
const steps = (): number => st()._undo.length;

/** Distinct bytes per take, so "which blob is the clip mirroring" is visible. */
const blobOf = (text: string): Blob => new Blob([text]);

const take = (id: string, over: Partial<ClipTake> = {}): ClipTake => ({
  id,
  label: id.toUpperCase(),
  audioBlob: blobOf(id),
  mimeType: 'audio/wav',
  sourceDuration: 10,
  offsetIntoSource: 0,
  ...over,
});

const A = () => take('a', { sourceDuration: 10, offsetIntoSource: 0 });
const B = () => take('b', { sourceDuration: 12, offsetIntoSource: 1, mimeType: 'audio/webm' });
const C = () => take('c', { sourceDuration: 14, offsetIntoSource: 2 });

const clip = (over: Partial<AudioClip> = {}): AudioClip =>
  ({
    id: 'c1', trackId: 't1', label: 'take', audioBlob: blobOf('orig'), mimeType: 'audio/wav',
    sourceDuration: 10, offsetIntoSource: 0, durationSec: 10, startSec: 0, color: '#fff',
    fadeInSec: 0, fadeOutSec: 0, gain: 1, muted: false, ...over,
  }) as AudioClip;

/** A clip already carrying takes, with the invariant satisfied at `active`. */
const comped = (takes: ClipTake[], active: number, over: Partial<AudioClip> = {}): AudioClip => {
  const t = takes[active];
  return clip({
    takes,
    activeTakeIndex: active,
    audioBlob: t.audioBlob,
    mimeType: t.mimeType,
    sourceDuration: t.sourceDuration,
    offsetIntoSource: t.offsetIntoSource,
    peaks: t.peaks,
    ...over,
  });
};

/** Seat a document and report the undo depth. Deliberately does NOT cut the
 *  coalescing burst: every action under test begins its own step, so anything
 *  that needed help here would not be one step in the app either. */
const seat = (clips: AudioClip[]): number => {
  useEditorStore.setState({ clips, selectedClipId: null });
  return steps();
};

/** THE invariant, over the whole document. */
const assertMirrors = (where: string): void => {
  for (const c of st().clips) {
    if (!c.takes || c.takes.length === 0) continue;
    const t = c.takes[c.activeTakeIndex ?? 0];
    assert.ok(t, `${where}: activeTakeIndex names a take that exists`);
    assert.equal(c.audioBlob, t.audioBlob, `${where}: audioBlob mirrors the active take`);
    assert.equal(c.mimeType, t.mimeType, `${where}: mimeType mirrors`);
    assert.equal(c.sourceDuration, t.sourceDuration, `${where}: sourceDuration mirrors`);
    assert.equal(c.offsetIntoSource, t.offsetIntoSource, `${where}: offsetIntoSource mirrors`);
    assert.equal(c.peaks, t.peaks, `${where}: peaks mirror`);
  }
};

const only = (): AudioClip => st().clips[0];
const shape = (comp: CompRegion[] | undefined): unknown[] =>
  (comp ?? []).map((r) => [r.startSec, r.takeIndex, r.crossfadeSec ?? 0]);

// ── addTakeToClip ────────────────────────────────────────────────────────────
// The clip's CURRENT media becomes take 0 on the first append, so the invariant
// holds from the first alternate — and the clip goes on playing what it played.
{
  const before = seat([clip({ peaks: new Float32Array([0.5]) })]);
  const first = only();
  st().addTakeToClip('c1', B());
  const c = only();
  assert.equal(c.takes?.length, 2, 'the clip has its own media plus the new take');
  assert.equal(c.takes?.[0].audioBlob, first.audioBlob, 'take 0 IS what the clip was playing');
  assert.equal(c.takes?.[0].peaks, first.peaks, 'including its decoded peaks');
  assert.equal(c.takes?.[1].id, 'b');
  assert.equal(c.activeTakeIndex, 0, 'without `activate` the clip keeps playing take 0');
  assert.equal(c.audioBlob, first.audioBlob, 'so its media is untouched');
  assert.equal(c.peaks, first.peaks, 'and the peaks it had decoded survive the append');
  assert.equal(c.comp, undefined, 'takes alone are not a comp');
  assertMirrors('addTakeToClip');
  assert.equal(steps(), before + 1, 'one undo step');
  st().undo();
  assert.equal(only().takes, undefined, 'undo takes the whole append back');
  st().redo();
  assert.equal(only().takes?.length, 2, 'and redo puts it back');
  assert.equal(only().takes?.[1].id, 'b');
  assertMirrors('addTakeToClip redone');
}

// `activate` switches to the new take, which re-mirrors all five fields.
{
  seat([clip()]);
  st().addTakeToClip('c1', B(), { activate: true });
  const c = only();
  assert.equal(c.activeTakeIndex, 1);
  assert.equal(c.audioBlob, c.takes?.[1].audioBlob, 'the new take is what plays');
  assert.equal(c.mimeType, 'audio/webm', 'a take carries its own container');
  assert.equal(c.sourceDuration, 12);
  assert.equal(c.offsetIntoSource, 1);
  assertMirrors('addTakeToClip activate');
}

// A third take appends to the two that are there — the seeding happens once.
{
  seat([comped([A(), B()], 1)]);
  st().addTakeToClip('c1', C());
  assert.deepEqual(only().takes?.map((t) => t.id), ['a', 'b', 'c']);
  assert.equal(only().activeTakeIndex, 1, 'the active take does not move');
  assertMirrors('third take');
}

// Two appends inside the coalescing window are two undo steps: each action
// begins its own, like every other discrete edit (`setClipFadeCurve`).
{
  const before = seat([clip()]);
  st().addTakeToClip('c1', B());
  st().addTakeToClip('c1', C());
  assert.equal(steps(), before + 2, 'two appends inside 300 ms are two undo steps');
  assert.equal(only().takes?.length, 3);
}

// An unknown clip is a no-op, not a throw, and records nothing.
{
  const before = seat([clip()]);
  st().addTakeToClip('gone', B());
  assert.equal(steps(), before, 'a refused append records no undo step');
  assert.equal(only().takes, undefined);
}

// ── setActiveTake ────────────────────────────────────────────────────────────
{
  const before = seat([comped([A(), B(), C()], 0, { peaks: undefined })]);
  st().setActiveTake('c1', 2);
  const c = only();
  assert.equal(c.activeTakeIndex, 2);
  assert.equal(c.audioBlob, c.takes?.[2].audioBlob);
  assert.equal(c.sourceDuration, 14);
  assert.equal(c.offsetIntoSource, 2);
  assert.equal(c.comp, undefined, 'switching takes on an un-comped clip leaves it un-comped');
  assertMirrors('setActiveTake');
  assert.equal(steps(), before + 1, 'one undo step');
  st().undo();
  assert.equal(only().activeTakeIndex, 0, 'undo puts the take back');
  assert.equal(only().audioBlob, only().takes?.[0].audioBlob, 'and the media with it');
}

// Switching NEVER carries the previous take's peaks across: they describe the
// other recording, and drawing them would draw the wrong waveform.
{
  const decoded = take('a', { peaks: new Float32Array([1, 0.2]) });
  seat([comped([decoded, B()], 0)]);
  assert.equal(only().peaks, decoded.peaks, 'the clip is drawing take A');
  st().setActiveTake('c1', 1);
  assert.equal(only().peaks, undefined, 'take B has no peaks decoded yet, so neither has the clip');
  assertMirrors('peaks do not leak across takes');
}

// A comp is left exactly where it was: it names its own takes, and the active
// index only decides which take the CLIP mirrors.
{
  const comp: CompRegion[] = [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }];
  seat([comped([A(), B()], 0, { comp })]);
  st().setActiveTake('c1', 1);
  assert.equal(only().comp, comp, 'the comp is untouched, down to its identity');
  assertMirrors('setActiveTake with a comp');
}

// Out of range, not an integer, or no takes at all: refused, and no undo step.
{
  const before = seat([comped([A(), B()], 0)]);
  for (const bad of [-1, 2, 1.5, Number.NaN]) st().setActiveTake('c1', bad);
  st().setActiveTake('c1', 0); // already active: nothing to write
  assert.equal(only().activeTakeIndex, 0);
  assert.equal(steps(), before, 'nothing changed, so nothing was recorded');
  seat([clip()]);
  st().setActiveTake('c1', 0); // no takes
  assert.equal(only().takes, undefined);
}

// ── edits made THROUGH the clip reach the takes ──────────────────────────────
// A trim-left or a slip writes `offsetIntoSource` on the CLIP. A comped clip
// reads every take through its own head, so every take moves by the same delta
// — the rule `splitClipAt` uses for the right half of a cut. Written to the clip
// alone, the comp went on playing untrimmed takes and the next take switch
// re-mirrored the untrimmed offset and threw the trim away.
{
  seat([comped([A(), B()], 0, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  st().updateClip('c1', { offsetIntoSource: 2, startSec: 2, durationSec: 8 });
  assert.deepEqual(only().takes?.map((t) => t.offsetIntoSource), [2, 3], 'every read head moved by the 2 s trim');
  assert.equal(only().offsetIntoSource, 2);
  assertMirrors('trim a comped clip');
  st().setActiveTake('c1', 1);
  assert.equal(only().offsetIntoSource, 3, 'switching takes keeps the trim instead of reverting it');
  assertMirrors('the trim survives a switch');
  // And a comp collapsing back to a switch keeps it too.
  st().setCompRegionAt('c1', 0, 1);
  assert.equal(only().comp, undefined);
  assert.equal(only().offsetIntoSource, 3, 'still trimmed');
}

// A clip with no takes is written exactly as it always was — nothing conjured.
{
  seat([clip()]);
  st().updateClip('c1', { offsetIntoSource: 2 });
  assert.equal(only().offsetIntoSource, 2);
  assert.equal('takes' in only(), false, 'no take list appears on a plain clip');
}

// A bounce belongs to the take it was made FROM. Written to the clip alone, the
// comp's other regions played the dry audio while the active take's played wet,
// and the next switch threw the bounce away.
{
  const takes = [A(), B()];
  const before = seat([comped(takes, 1, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  const wet = blobOf('bounced');
  const peaks = new Float32Array([0.3]);
  st().applyClipRender('c1', { audioBlob: wet, mimeType: 'audio/wav', sourceDuration: 13 }, peaks);
  const c = only();
  assert.equal(c.takes?.[1].audioBlob, wet, 'the ACTIVE take holds the bounce');
  assert.equal(c.takes?.[1].sourceDuration, 13);
  assert.equal(c.takes?.[1].mimeType, 'audio/wav');
  assert.equal(c.takes?.[1].peaks, peaks);
  assert.equal(c.takes?.[0].audioBlob, takes[0].audioBlob, 'the alternate is not re-recorded');
  assertMirrors('applyClipRender');
  assert.equal(steps(), before, 'a render is derived data: no undo step');
}

// The case where the two rules meet: the offline Time/Pitch bake replaces the
// audio AND rebases the head to 0 in one update. Only the active take was
// re-baked, so only its head moves — shifting the alternates by that delta would
// point them at audio nobody stretched.
{
  const takes = [A(), B()];
  seat([comped(takes, 1, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  const baked = blobOf('stretched');
  st().updateClip('c1', { audioBlob: baked, mimeType: 'audio/wav', offsetIntoSource: 0, durationSec: 11, peaks: undefined });
  const c = only();
  assert.equal(c.takes?.[1].audioBlob, baked, 'the baked audio is the active take');
  assert.equal(c.takes?.[1].offsetIntoSource, 0, 'read from the head of its new bytes');
  assert.equal(c.takes?.[0].offsetIntoSource, takes[0].offsetIntoSource, 'the alternate keeps its own head');
  assert.equal(c.takes?.[0].audioBlob, takes[0].audioBlob, 'and its own audio');
  assertMirrors('an offline bake on a comped clip');
}

// `cachePeaks` is the peaks-only case, and the reason it matters: decoded onto
// the take as well as the clip, they survive a switch away and back.
{
  seat([comped([A(), B()], 0)]);
  const peaks = new Float32Array([0.4, 0.5]);
  st().cachePeaks('c1', peaks);
  assert.equal(only().takes?.[0].peaks, peaks, 'the peaks land on the take too');
  assert.equal(only().takes?.[1].peaks, undefined, 'and only on the one they were decoded from');
  st().setActiveTake('c1', 1);
  assert.equal(only().peaks, undefined, 'take B has none of her own yet');
  st().setActiveTake('c1', 0);
  assert.equal(only().peaks, peaks, 'take A still has hers when the clip comes back');
  assertMirrors('peaks survive a switch round trip');
}

// ── setCompRegionAt ──────────────────────────────────────────────────────────
// On an un-comped clip the head is seeded with the ACTIVE take, so a pick claims
// the stretch that was clicked and not the whole clip.
{
  const before = seat([comped([A(), B()], 0)]);
  st().setCompRegionAt('c1', 4, 1);
  assert.deepEqual(shape(only().comp), [[0, 0, 0], [4, 1, 0]], 'the head keeps take A, take B from 4 s');
  assert.equal(only().activeTakeIndex, 0, 'the clip still mirrors the head take');
  assertMirrors('setCompRegionAt seeds the head');
  assert.equal(steps(), before + 1, 'one undo step');
  st().undo();
  assert.equal(only().comp, undefined, 'undo un-comps the clip');
  st().redo();
  assert.deepEqual(shape(only().comp), [[0, 0, 0], [4, 1, 0]], 'and redo comps it again');
  assertMirrors('setCompRegionAt redone');
}

// A pick inside an existing region splits it; a pick on a boundary retargets it.
{
  seat([comped([A(), B(), C()], 0, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  st().setCompRegionAt('c1', 7, 2);
  assert.deepEqual(shape(only().comp), [[0, 0, 0], [4, 1, 0], [7, 2, 0]], 'the 4-10 region is split at 7');
  st().setCompRegionAt('c1', 4, 2);
  assert.deepEqual(shape(only().comp), [[0, 0, 0], [4, 2, 0]], 'retargeting 4 s merges it into the 7 s region');
  assertMirrors('pick inside / on a boundary');
}

// One take everywhere is NOT a comp, it is a take SWITCH — and it is stored as
// one, so the clip's own blob (what every non-comp-aware path plays) is the take
// the comp would have named.
{
  seat([comped([A(), B()], 0, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  st().setCompRegionAt('c1', 0, 1);
  const c = only();
  assert.equal(c.comp, undefined, 'the last boundary merged away, so the comp is gone');
  assert.equal(c.activeTakeIndex, 1, 'and the pick became a take switch');
  assert.equal(c.audioBlob, c.takes?.[1].audioBlob, 'the clip plays take B by itself');
  assertMirrors('a comp that collapses becomes a switch');
}

// A take that does not exist is refused outright — the comp is never written
// with an index nothing can resolve.
{
  const before = seat([comped([A(), B()], 0)]);
  st().setCompRegionAt('c1', 4, 5);
  st().setCompRegionAt('c1', 4, -1);
  st().setCompRegionAt('c1', 4, 1.5);
  assert.equal(only().comp, undefined);
  assert.equal(steps(), before, 'a refused pick records no undo step');
  seat([clip()]);
  st().setCompRegionAt('c1', 4, 0); // no takes to comp between
  assert.equal(only().comp, undefined);
}

// A pick at or past the clip end has no room for a region.
{
  seat([comped([A(), B()], 0)]);
  st().setCompRegionAt('c1', 10, 1);
  assert.equal(only().comp, undefined, 'nothing to pick at the clip end');
  assertMirrors('pick at the clip end');
}

// ── moveCompBoundary ─────────────────────────────────────────────────────────
{
  const before = seat([comped([A(), B()], 0, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  st().moveCompBoundary('c1', 1, 7);
  assert.deepEqual(shape(only().comp), [[0, 0, 0], [7, 1, 0]], 'the boundary moved');
  assert.equal(steps(), before + 1, 'one undo step');
  st().moveCompBoundary('c1', 1, 99);
  assert.equal(only().comp?.[1].startSec, 10 - 1e-6, 'past the clip end it clamps inside the box');
  st().moveCompBoundary('c1', 0, 3);
  assert.equal(only().comp?.[0].startSec, 0, 'region 0 is the clip head, not a draggable boundary');
  st().moveCompBoundary('c1', 9, 3);
  assert.deepEqual(shape(only().comp), [[0, 0, 0], [10 - 1e-6, 1, 0]], 'an index that names no boundary is a no-op');
  assert.equal(steps(), before + 2, 'the two refused moves recorded nothing');
  assertMirrors('moveCompBoundary');
}

// A DRAG is ONE undo step: it says `coalesce` and folds into the step its
// pointer-down opened, exactly like `stretchClipToFit`.
{
  const before = seat([comped([A(), B()], 0, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  beginUndoStep();
  for (const to of [4.5, 5, 5.5, 6]) st().moveCompBoundary('c1', 1, to, { coalesce: true });
  assert.equal(only().comp?.[1].startSec, 6, 'the last frame is what stuck');
  assert.equal(steps(), before + 1, 'the whole drag is one undo step');
  st().undo();
  assert.equal(only().comp?.[1].startSec, 4, 'one undo takes the whole drag back');
}

// Two separate drags are two steps — the key names the clip, so the next
// gesture cannot be swallowed by the one before it.
{
  const before = seat([comped([A(), B()], 0, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  st().moveCompBoundary('c1', 1, 5);
  st().moveCompBoundary('c1', 1, 6);
  assert.equal(steps(), before + 2, 'two discrete moves are two steps');
}

// ── setCompCrossfade ─────────────────────────────────────────────────────────
{
  const before = seat([comped([A(), B()], 0, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  st().setCompCrossfade('c1', 1, 0.5);
  assert.deepEqual(shape(only().comp), [[0, 0, 0], [4, 1, 0.5]], 'the boundary crossfades');
  assert.equal(steps(), before + 1, 'one undo step');
  st().setCompCrossfade('c1', 1, 0);
  assert.equal('crossfadeSec' in (only().comp?.[1] ?? {}), false, '0 is a butt cut, stored as no key at all');
  st().setCompCrossfade('c1', 0, 0.5);
  assert.equal('crossfadeSec' in (only().comp?.[0] ?? {}), false, 'the clip head is not a boundary between takes');
  st().setCompCrossfade('c1', 1, Number.NaN);
  assert.deepEqual(shape(only().comp), [[0, 0, 0], [4, 1, 0]], 'nonsense is refused, not stored');
  assert.equal(steps(), before + 2, 'only the two real edits recorded steps');
  assertMirrors('setCompCrossfade');
}

// ── clearComp / keepActiveTakeOnly ───────────────────────────────────────────
{
  const before = seat([comped([A(), B()], 1, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  st().clearComp('c1');
  assert.equal(only().comp, undefined, 'the comp is gone');
  assert.equal(only().takes?.length, 2, 'the takes are not');
  assert.equal(only().activeTakeIndex, 1, 'and the clip plays the one it was mirroring');
  assertMirrors('clearComp');
  assert.equal(steps(), before + 1, 'one undo step');
  st().undo();
  assert.equal(only().comp?.length, 2, 'undo brings the comp back');
  st().clearComp('c1'); // the comp is back after the undo, so this clears it again
  const depth = steps();
  st().clearComp('c1'); // nothing left to clear
  assert.equal(steps(), depth, 'clearing an un-comped clip records nothing');
}

{
  const before = seat([comped([A(), B()], 1, { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] })]);
  const active = only().audioBlob;
  st().keepActiveTakeOnly('c1');
  const c = only();
  assert.equal(c.takes, undefined, 'the alternates are thrown away');
  assert.equal(c.comp, undefined);
  assert.equal(c.activeTakeIndex, undefined);
  assert.equal(c.audioBlob, active, 'and the clip plays exactly what it was playing — no render');
  assert.equal(c.sourceDuration, 12);
  assert.equal(c.offsetIntoSource, 1);
  assert.equal(steps(), before + 1, 'one undo step');
  st().undo();
  assert.equal(only().takes?.length, 2, 'undo brings every take back');
  assertMirrors('keepActiveTakeOnly undone');
}

// ── flattenComp ──────────────────────────────────────────────────────────────
// The rendered blob is a SOURCE: it becomes the clip's media, read from 0, and
// the clip keeps everything that is a property of the CLIP rather than of the
// bytes — its place, its length, its gain, its fades, its stretch ratio.
{
  const drawn = take('b', { sourceDuration: 12, offsetIntoSource: 1, peaks: new Float32Array([0.9]) });
  const before = seat([comped([A(), drawn], 1, {
    comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }],
    startSec: 3, durationSec: 8, gain: 0.5, fadeInSec: 1, fadeOutSec: 2, timeStretchRate: 2,
  })]);
  const printed = blobOf('flattened');
  st().flattenComp('c1', { blob: printed, mimeType: 'audio/wav', durationSec: 16 });
  const c = only();
  assert.equal(c.audioBlob, printed, 'the render is the source the clip reads now');
  assert.equal(c.mimeType, 'audio/wav');
  assert.equal(c.sourceDuration, 16);
  assert.equal(c.offsetIntoSource, 0, 'a printed comp starts at the head of its own bytes');
  assert.equal(c.peaks, undefined, 'the old peaks described the old source');
  assert.equal(c.takes, undefined, 'the takes are folded in');
  assert.equal(c.comp, undefined);
  assert.equal(c.activeTakeIndex, undefined);
  assert.equal(c.startSec, 3, 'where the clip sits is not part of its bytes');
  assert.equal(c.durationSec, 8, 'nor how long it plays');
  assert.equal(c.gain, 0.5);
  assert.equal(c.fadeInSec, 1);
  assert.equal(c.fadeOutSec, 2);
  assert.equal(c.timeStretchRate, 2, 'nor the ratio it reads its source at');
  assert.equal(steps(), before + 1, 'one undo step');
  st().undo();
  assert.equal(only().takes?.length, 2, 'undo brings the takes back');
  assert.equal(only().comp?.length, 2, 'and the comp');
  assertMirrors('flattenComp undone');
  st().redo();
  assert.equal(only().audioBlob, printed, 'redo prints it again');
  assert.equal(only().takes, undefined);
  assert.equal(only().comp, undefined);
}

// Peaks come through when the caller has them.
{
  seat([comped([A(), B()], 0)]);
  const peaks = new Float32Array([0.1, 0.2]);
  st().flattenComp('c1', { blob: blobOf('x'), mimeType: 'audio/wav', durationSec: 10, peaks });
  assert.equal(only().peaks, peaks);
  assert.equal(only().sourceDuration, 10);
}

// THE CONTRACT, enforced: the print is a SOURCE at rate 1 covering every source
// second the clip reads. A print of the clip as it SOUNDS is half the audio a
// rate-2 clip needs, and accepting it would truncate the clip to its first half
// — so it is refused, with the takes and the comp left standing.
{
  const comp: CompRegion[] = [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }];
  const before = seat([comped([A(), B()], 0, { durationSec: 10, timeStretchRate: 2, comp })]);
  const printed = blobOf('too short');
  st().flattenComp('c1', { blob: printed, mimeType: 'audio/wav', durationSec: 10 }); // the clip reads 20 s
  assert.equal(only().takes?.length, 2, 'a short render is refused: the takes stay');
  assert.equal(only().comp, comp, 'and so does the comp, down to its identity');
  assert.notEqual(only().audioBlob, printed, 'nothing was written');
  assert.equal(steps(), before, 'a refused flatten records no undo step');

  // A length that is not a length is refused the same way, rather than writing
  // NaN into the document.
  st().flattenComp('c1', { blob: printed, mimeType: 'audio/wav', durationSec: Number.NaN });
  assert.equal(only().takes?.length, 2, 'a nonsense length is refused too');
  assert.equal(steps(), before);

  // The print the contract asks for — 20 s of source at rate 1 — is taken, and
  // the clip goes on reading it at its own ratio.
  st().flattenComp('c1', { blob: printed, mimeType: 'audio/wav', durationSec: 20 });
  assert.equal(only().audioBlob, printed, 'a render that covers the source span is printed');
  assert.equal(only().sourceDuration, 20);
  assert.equal(only().timeStretchRate, 2, 'read through the ratio the clip already had');
  assert.equal(only().takes, undefined);
  assert.equal(steps(), before + 1, 'one undo step for the flatten that landed');
}

// ── splitClipAt with takes + comp ────────────────────────────────────────────
// Both halves keep the takes. The left half keeps the ARRAY it had; the right
// half's read heads advance by the same conversion the clip's own offset uses,
// and every blob is still shared by reference — a split costs no audio.
{
  const src = comped([A(), B()], 0, {
    comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }],
  });
  seat([src]);
  const rightId = st().splitClipAt('c1', 6);
  assert.ok(rightId);
  const [left, right] = st().clips;
  assert.equal(left.takes, src.takes, 'the left half keeps the very array it had');
  assert.notEqual(right.takes, src.takes, 'the right half needs its own offsets');
  assert.deepEqual(right.takes?.map((t) => t.offsetIntoSource), [6, 7], 'each read head advances by the cut');
  assert.deepEqual(right.takes?.map((t) => t.audioBlob), src.takes?.map((t) => t.audioBlob), 'the blobs are the same objects');
  assert.deepEqual(shape(left.comp), [[0, 0, 0], [4, 1, 0]], 'the left half keeps both regions');
  assert.equal(right.comp, undefined, 'the right half plays one take, so it is a switch, not a comp');
  assert.equal(right.activeTakeIndex, 1, 'and that take is the one the comp ran into the cut with');
  assertMirrors('split inside a region');
}

// A cut exactly ON a boundary opens the right half with that region.
{
  seat([comped([A(), B(), C()], 0, {
    comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }, { startSec: 7, takeIndex: 2 }],
  })]);
  st().splitClipAt('c1', 4);
  const [left, right] = st().clips;
  assert.equal(left.comp, undefined, 'the left half is all take A: a switch');
  assert.equal(left.activeTakeIndex, 0);
  assert.deepEqual(shape(right.comp), [[0, 1, 0], [3, 2, 0]], 'the right half is re-based on its own head');
  assertMirrors('split on a boundary');
}

// A STRETCHED comped clip converts the seam through the rate for its takes too,
// or the right half's takes would replay the seam.
{
  seat([comped([A(), B()], 0, {
    durationSec: 10, timeStretchRate: 2,
    comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 8, takeIndex: 1 }],
  })]);
  st().splitClipAt('c1', 4);
  const [left, right] = st().clips;
  assert.deepEqual(right.takes?.map((t) => t.offsetIntoSource), [8, 9], '4 s of timeline at rate 2 is 8 s of source');
  assert.equal(right.offsetIntoSource, 8, 'the read head of the clip moved by the same amount');
  assert.equal(left.comp, undefined, 'the left half is all take A: a switch');
  assert.deepEqual(shape(right.comp), [[0, 0, 0], [4, 1, 0]], 'the comp is partitioned in TIMELINE seconds');
  assertMirrors('split a stretched comped clip');
}

// A clip with no takes splits exactly as it always did — no keys conjured.
{
  seat([clip({ durationSec: 10 })]);
  st().splitClipAt('c1', 4);
  const [left, right] = st().clips;
  for (const [name, c] of [['left', left], ['right', right]] as const) {
    assert.equal('takes' in c, false, `${name} half has no takes key`);
    assert.equal('comp' in c, false, `${name} half has no comp key`);
    assert.equal('activeTakeIndex' in c, false, `${name} half has no activeTakeIndex key`);
  }
}

// ── duplicate / copy-paste ───────────────────────────────────────────────────
// Both go through `addClipToTrack` with a spread of the source clip minus its
// id (WaveformEditor's `duplicateSelectedClips` / `pasteClips`).
{
  const src = comped([A(), B()], 1, {
    comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }],
  });
  seat([src]);
  const { id: _omit, ...rest } = src;
  const copyId = st().addClipToTrack({ ...rest, startSec: 20 });
  const copy = st().clips.find((c) => c.id === copyId) as AudioClip;
  assert.notEqual(copy.id, src.id, 'the copy is its own clip');
  assert.equal(copy.takes, src.takes, 'the take ARRAY is shared by reference — no blob copies');
  assert.equal(copy.audioBlob, src.audioBlob, 'and so is the audio it mirrors');
  assert.equal(copy.activeTakeIndex, 1);
  assert.notEqual(copy.comp, src.comp, 'the comp is copied: the two clips are comped separately');
  assert.deepEqual(shape(copy.comp), shape(src.comp), 'with the same boundaries to start from');
  assert.notEqual(copy.comp?.[0], src.comp?.[0], 'down to the region objects');
  assertMirrors('duplicate');
  // Editing the copy leaves the original alone — the point of the copy.
  st().moveCompBoundary(copyId, 1, 6);
  assert.equal(st().clips.find((c) => c.id === 'c1')?.comp?.[1].startSec, 4, 'the boundary on the original did not move');
}

// ── freezeSignature / trackFreezeSignature ───────────────────────────────────
{
  const track: EditorTrack = {
    id: 't1', name: 'T', nameAutoGenerated: false, volume: 1, pan: 0, mute: false, solo: false, color: '#fff',
  };
  const takes = [A(), B()];
  const doc = (over: Partial<AudioClip> = {}) => ({
    clips: [comped(takes, 0, over)],
    tracks: [track],
    masterFxChain: [] as ChainEntry[],
    masterVstChain: [] as ChainEntry[],
    bpm: 120,
  });
  const base = freezeSignature(doc());
  assert.equal(freezeSignature(doc()), base, 'the same document signs the same');

  const moved: Array<[string, Partial<AudioClip>]> = [
    ['a comp appearing', { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] }],
    ['a boundary moving', { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 5, takeIndex: 1 }] }],
    ['a region changing take', { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 0 }] }],
    ['a crossfade', { comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1, crossfadeSec: 0.5 }] }],
    ['a take being added', { takes: [...takes, C()] }],
    ['a take being reordered', { takes: [takes[1], takes[0]] }],
    ['an alternate take being trimmed', { takes: [takes[0], take('b', { sourceDuration: 12, offsetIntoSource: 5 })] }],
    ['an alternate take being re-bounced', { takes: [takes[0], take('b', { sourceDuration: 12, offsetIntoSource: 1, audioBlob: blobOf('re-bounced') })] }],
  ];
  for (const [name, over] of moved) {
    assert.notEqual(freezeSignature(doc(over)), base, `${name} stales the render`);
  }
  // The active take moves the signature even with no comp at all: it is what the
  // clip plays.
  assert.notEqual(freezeSignature(doc({ activeTakeIndex: 1 })), base, 'switching takes stales the render');

  // A take's AUDIO being replaced under an unchanged comp: same boundaries, and
  // the WORST case — the same id and the same duration, so only the bytes
  // themselves differ. `compDigest` cannot see any of it; the take list must.
  const comped2: CompRegion[] = [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }];
  const signedComped = freezeSignature(doc({ comp: comped2 }));
  const reTaken = [A(), take('b', { sourceDuration: 12, offsetIntoSource: 1, mimeType: 'audio/webm', audioBlob: blobOf('different bytes') })];
  assert.equal(reTaken[1].id, takes[1].id, 'same id');
  assert.equal(reTaken[1].sourceDuration, takes[1].sourceDuration, 'same duration');
  assert.notEqual(
    freezeSignature(doc({ takes: reTaken, comp: comped2 })),
    signedComped,
    'new bytes behind an unchanged boundary, id and length still stale the render',
  );

  // The separators the digest is joined with (`:` between fields, `|` between
  // clips, `,` between takes) are all legal in an id, so the id is encoded: an
  // id full of them is still ONE field and still tells two takes apart.
  assert.notEqual(
    freezeSignature(doc({ takes: [take('a|b:c,d'), takes[1]] })),
    freezeSignature(doc({ takes: [take('a|b:c,e'), takes[1]] })),
    'an id full of separators is still one field',
  );

  // Two clips, two tracks: a per-track signature sees only its own track, so an
  // edit on the other one does not stale this track's stem.
  const other: EditorTrack = { ...track, id: 't2', name: 'T2' };
  const clips = [comped(takes, 0, { id: 'c1', trackId: 't1' }), comped(takes, 0, { id: 'c2', trackId: 't2' })];
  const t1Base = trackFreezeSignature(track, clips);
  assert.equal(trackFreezeSignature(track, clips), t1Base, 'the same track signs the same');
  const otherEdited = [clips[0], { ...clips[1], startSec: 5 }];
  assert.equal(trackFreezeSignature(track, otherEdited), t1Base, 'a clip moving on another track does not stale this stem');
  assert.notEqual(trackFreezeSignature(other, otherEdited), trackFreezeSignature(other, clips), 'but it stales THAT one');
  const ownComped = [{ ...clips[0], comp: [{ startSec: 0, takeIndex: 0 }, { startSec: 4, takeIndex: 1 }] }, clips[1]];
  assert.notEqual(trackFreezeSignature(track, ownComped), t1Base, 'comping a clip on this track stales its stem');
  assert.notEqual(trackFreezeSignature({ ...track, volume: 0.5 }, clips), t1Base, 'so does its own fader');
  assert.notEqual(
    trackFreezeSignature({ ...track, fxChain: [{ id: 'e1', effect: 'eq', params: {}, enabled: true }] }, clips),
    t1Base,
    'and its own insert rack',
  );
}

console.log('editorStore.comp: ok');
