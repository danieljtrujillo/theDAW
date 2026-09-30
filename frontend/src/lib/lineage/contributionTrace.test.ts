// contributionTrace — deriving what a render would make audible from the
// document's own tracks/clips, not by filtering a list after the fact.
//
// One fixture per rule: solo/mute (track and clip), the missing-library-id
// skip, comps (active take only, and takes-without-a-comp staying plain),
// range clipping (including that a discarded preroll never widens the kept
// window, while a kept tail does), and the piano-roll role override.
import assert from 'node:assert/strict';
import {
  contributionsAreEmpty,
  traceContributions,
  type TraceClip,
  type TraceInput,
  type TraceTrack,
} from './contributionTrace.ts';
import { secToFrame, type RenderRange } from '../render/renderRange.ts';

const track = (over: Partial<TraceTrack> & { id: string }): TraceTrack => ({
  mute: false,
  solo: false,
  ...over,
});

const clip = (over: Partial<TraceClip> & { id: string; trackId: string }): TraceClip => ({
  startSec: 0,
  durationSec: 4,
  offsetIntoSource: 0,
  libraryEntryId: `lib-${over.id}`,
  ...over,
});

const trace = (over: Partial<TraceInput> & { clips: TraceClip[] }): ReturnType<typeof traceContributions> =>
  traceContributions({ tracks: [track({ id: 't1' })], ...over });

/* ── plain clips ──────────────────────────────────────────────────────────── */

function plainClipsContributeOncePerClip(): void {
  const tracks = [track({ id: 't1' })];
  const clips = [
    clip({ id: 'c1', trackId: 't1', startSec: 0, durationSec: 4, offsetIntoSource: 0 }),
    clip({ id: 'c2', trackId: 't1', startSec: 5, durationSec: 2, offsetIntoSource: 1.5 }),
  ];
  const result = traceContributions({ tracks, clips });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    library_entry_id: 'lib-c1', clip_id: 'c1', track_id: 't1',
    start_sec: 0, end_sec: 4, source_offset_sec: 0, role: 'audio',
  });
  assert.deepEqual(result[1], {
    library_entry_id: 'lib-c2', clip_id: 'c2', track_id: 't1',
    start_sec: 5, end_sec: 7, source_offset_sec: 1.5, role: 'audio',
  });
  assert.equal(contributionsAreEmpty(result), false);
}

/* ── mute / solo ──────────────────────────────────────────────────────────── */

function aMutedTrackContributesNothing(): void {
  const tracks = [track({ id: 't1', mute: true }), track({ id: 't2' })];
  const clips = [
    clip({ id: 'c1', trackId: 't1' }),
    clip({ id: 'c2', trackId: 't2' }),
  ];
  const result = traceContributions({ tracks, clips });
  assert.equal(result.length, 1);
  assert.equal(result[0].track_id, 't2');
}

function soloRestrictsToSoloedTracks(): void {
  const tracks = [
    track({ id: 't1', solo: true }),
    track({ id: 't2' }),
    // Soloed AND muted: mute still wins (renderCore's "mute AND solo apply").
    track({ id: 't3', solo: true, mute: true }),
  ];
  const clips = [
    clip({ id: 'c1', trackId: 't1' }),
    clip({ id: 'c2', trackId: 't2' }),
    clip({ id: 'c3', trackId: 't3' }),
  ];
  const result = traceContributions({ tracks, clips });
  assert.deepEqual(result.map((r) => r.clip_id), ['c1']);
}

function aMutedClipContributesNothing(): void {
  const clips = [
    clip({ id: 'c1', trackId: 't1', muted: true }),
    clip({ id: 'c2', trackId: 't1' }),
  ];
  const result = trace({ clips });
  assert.deepEqual(result.map((r) => r.clip_id), ['c2']);
}

/* ── library id ───────────────────────────────────────────────────────────── */

function aClipWithoutALibraryEntryIdIsSkipped(): void {
  const clips = [
    clip({ id: 'c1', trackId: 't1', libraryEntryId: undefined }),
    clip({ id: 'c2', trackId: 't1', libraryEntryId: '' }),
    clip({ id: 'c3', trackId: 't1' }),
  ];
  const result = trace({ clips });
  assert.deepEqual(result.map((r) => r.clip_id), ['c3']);
  assert.ok(result.every((r) => r.library_entry_id.length > 0));
}

/* ── range clipping ───────────────────────────────────────────────────────── */

function aClipOutsideTheRangeContributesNothing(): void {
  const range: RenderRange = {
    startFrame: secToFrame(10), endFrame: secToFrame(20), prerollFrames: 0, tailFrames: 0,
  };
  const clips = [
    clip({ id: 'before', trackId: 't1', startSec: 0, durationSec: 5 }), // ends at 5, range starts at 10
    clip({ id: 'after', trackId: 't1', startSec: 25, durationSec: 5 }), // starts at 25, range ends at 20
  ];
  const result = trace({ clips, range });
  assert.deepEqual(result, []);
  assert.ok(contributionsAreEmpty(result));
}

function aClipPartlyInsideIsClippedAndTheSourceOffsetMovesWithIt(): void {
  const range: RenderRange = {
    startFrame: secToFrame(10), endFrame: secToFrame(20), prerollFrames: 0, tailFrames: 0,
  };
  // Runs 8..14: two seconds hang off the front of the range.
  const clips = [clip({ id: 'c1', trackId: 't1', startSec: 8, durationSec: 6, offsetIntoSource: 3 })];
  const result = trace({ clips, range });
  assert.equal(result.length, 1);
  assert.equal(result[0].start_sec, 10, 'clipped to the range start');
  assert.equal(result[0].end_sec, 14, 'the clip\'s own end, already inside the range');
  assert.equal(result[0].source_offset_sec, 5, 'advanced by exactly the 2s trimmed off the front (3 + 2)');
}

function theTailIsInsideTheWindowAndThePrerollIsNot(): void {
  const range: RenderRange = {
    startFrame: secToFrame(10), endFrame: secToFrame(20),
    prerollFrames: secToFrame(2), // 8..10, rendered then discarded
    tailFrames: secToFrame(3), // 20..23, rendered and KEPT
  };
  const clips = [
    // Sits entirely in the discarded preroll span: must not contribute.
    clip({ id: 'preroll', trackId: 't1', startSec: 8.5, durationSec: 1 }),
    // Sits entirely in the kept tail span: must contribute.
    clip({ id: 'tail', trackId: 't1', startSec: 21, durationSec: 1 }),
  ];
  const result = trace({ clips, range });
  assert.deepEqual(result.map((r) => r.clip_id), ['tail']);
  assert.deepEqual([result[0].start_sec, result[0].end_sec], [21, 22]);
}

/* ── takes / comp ─────────────────────────────────────────────────────────── */

function aCompContributesOnlyItsActiveTakeSegments(): void {
  const clips: TraceClip[] = [clip({
    id: 'c1', trackId: 't1', startSec: 10, durationSec: 6, offsetIntoSource: 0,
    takes: [{ offsetIntoSource: 0 }, { offsetIntoSource: 0 }],
    comp: [
      { startSec: 0, takeIndex: 1 },
      { startSec: 2, takeIndex: 0 },
      { startSec: 4, takeIndex: 1 },
    ],
    activeTakeIndex: 1,
  })];
  const result = trace({ clips });
  // Active take is 1: regions [0,2) and [4,6) are take 1; [2,4) is take 0 and drops out.
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => [r.start_sec, r.end_sec]), [[10, 12], [14, 16]]);
  assert.ok(result.every((r) => r.library_entry_id === 'lib-c1'));
  // clip.offsetIntoSource already mirrors the active take (the AudioClip.takes
  // invariant), so the source offset only ever advances by the SEGMENT's own
  // clip-relative start — never by anything read off `takes[i]` individually.
  assert.equal(result[0].source_offset_sec, 0);
  assert.equal(result[1].source_offset_sec, 4);
}

function takesWithoutACompStillContributeOneWholeSegment(): void {
  const clips: TraceClip[] = [
    // Two takes, no comp at all: take SWITCHING, not comping.
    clip({
      id: 'c1', trackId: 't1', startSec: 3, durationSec: 5, offsetIntoSource: 2,
      takes: [{ offsetIntoSource: 2 }, { offsetIntoSource: 0 }],
    }),
    // Two takes, an explicitly EMPTY comp: the same as no comp.
    clip({
      id: 'c2', trackId: 't1', startSec: 9, durationSec: 2, offsetIntoSource: 0,
      takes: [{ offsetIntoSource: 0 }, { offsetIntoSource: 1 }], comp: [],
    }),
  ];
  const result = trace({ clips });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    library_entry_id: 'lib-c1', clip_id: 'c1', track_id: 't1',
    start_sec: 3, end_sec: 8, source_offset_sec: 2, role: 'audio',
  });
  assert.deepEqual(result[1], {
    library_entry_id: 'lib-c2', clip_id: 'c2', track_id: 't1',
    start_sec: 9, end_sec: 11, source_offset_sec: 0, role: 'audio',
  });
}

/* ── role ─────────────────────────────────────────────────────────────────── */

function aPianoRollClipIsRoleMidi(): void {
  const clips: TraceClip[] = [
    clip({ id: 'c1', trackId: 't1', sourceKind: 'piano-roll' }),
    clip({ id: 'c2', trackId: 't1' }),
  ];
  const result = trace({ clips });
  assert.equal(result.find((r) => r.clip_id === 'c1')?.role, 'midi');
  assert.equal(result.find((r) => r.clip_id === 'c2')?.role, 'audio');

  // A piano-roll clip is 'midi' even when an explicit input role says otherwise.
  const stemResult = trace({ clips: [clips[0]], role: 'stem' });
  assert.equal(stemResult[0]?.role, 'midi');
}

/* ── run ──────────────────────────────────────────────────────────────────── */

function main(): void {
  plainClipsContributeOncePerClip();
  aMutedTrackContributesNothing();
  soloRestrictsToSoloedTracks();
  aMutedClipContributesNothing();
  aClipWithoutALibraryEntryIdIsSkipped();
  aClipOutsideTheRangeContributesNothing();
  aClipPartlyInsideIsClippedAndTheSourceOffsetMovesWithIt();
  theTailIsInsideTheWindowAndThePrerollIsNot();
  aCompContributesOnlyItsActiveTakeSegments();
  takesWithoutACompStillContributeOneWholeSegment();
  aPianoRollClipIsRoleMidi();
  console.log('contributionTrace: ok');
}

main();
