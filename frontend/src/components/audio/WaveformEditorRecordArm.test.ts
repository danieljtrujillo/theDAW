// Run with: npx tsx src/components/audio/WaveformEditorRecordArm.test.ts
/**
 * The track header's record controls subscribe NARROWLY — this pins the
 * selectors that make that true.
 *
 * `recordingStore` writes a fresh `levels` object roughly every 50 ms while a
 * pass runs (`{ ...levels, ...pendingLevels }`). If the editor subscribed to
 * `levels` itself, every one of those writes would re-render the whole
 * timeline twenty times a second. It does not: the meter is its own component
 * and reads `levels[trackId]` through `selectTrackLevel`, whose return value is
 * the FRAME OBJECT — and the store only replaces the frames it just measured,
 * so a track that did not move hands back the identical object and zustand's
 * `Object.is` skips that subscriber entirely.
 *
 * That property is the whole argument for the design, so it is asserted here
 * rather than eyeballed in DevTools: a level write for track A must leave
 * track B's selector result reference-identical, and must not disturb the
 * status selector the arm button reads.
 */
import assert from 'node:assert/strict';
import {
  armingLocked,
  selectRecordingStatus,
  selectTrackLevel,
} from './WaveformEditor.tsx';
import type { RecordingStoreState } from '../../state/recordingStore.ts';
import type { LevelFrame } from '../../lib/recordingEngine.ts';

/** The store's own shape, narrowed to what the header subscribes to, so a
 *  reshape of `recordingStore` fails HERE rather than silently in the UI. */
type Frame = LevelFrame;
type Slice = Pick<RecordingStoreState, 'status' | 'levels'>;

const a0: Frame = { peak: 0.4, rms: 0.2 };
const b0: Frame = { peak: 0.1, rms: 0.05 };
const before: Slice = { status: 'recording', levels: { a: a0, b: b0 } };

/* ── a write that touched only track A ──────────────────────────────────── */
{
  const a1: Frame = { peak: 0.9, rms: 0.6 };
  // Exactly the shape `recordingStore`'s level throttle writes.
  const after: Slice = { ...before, levels: { ...before.levels, a: a1 } };

  assert.notEqual(selectTrackLevel('a')(after), selectTrackLevel('a')(before));
  assert.equal(selectTrackLevel('a')(after), a1, "A's meter sees the new frame");
  assert.equal(
    selectTrackLevel('b')(after),
    selectTrackLevel('b')(before),
    "B's meter is not re-rendered by A's frame",
  );
  assert.equal(
    selectRecordingStatus(after),
    selectRecordingStatus(before),
    'a level write never re-renders the arm button',
  );
}

/* ── a track with no frame yet ──────────────────────────────────────────── */
{
  assert.equal(selectTrackLevel('nope')(before), undefined);
  // Stable across writes, so an armed track that has not been measured yet does
  // not re-render on every other track's frame either.
  const after: Slice = { ...before, levels: { ...before.levels, a: { peak: 1, rms: 1 } } };
  assert.equal(selectTrackLevel('nope')(after), selectTrackLevel('nope')(before));
}

/* ── arming is locked for every state but idle ──────────────────────────── */
{
  assert.equal(armingLocked('idle'), false);
  assert.equal(armingLocked('counting'), true);
  assert.equal(armingLocked('recording'), true);
  assert.equal(armingLocked('stopping'), true);
}

console.log('WaveformEditor record arm selectors: all assertions passed');
