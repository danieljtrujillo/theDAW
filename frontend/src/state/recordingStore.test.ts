/**
 * recordingStore — the record press, driven entirely by fakes.
 *
 * The engine arrives through the store's factory seam, so this suite uses a
 * fake `RecordingEngine` whose `start` it resolves (or rejects) by hand and
 * whose takes it fabricates: no microphone, no `MediaRecorder`, no
 * `AudioContext`, no count-in scheduler. The TRANSPORT half is real — the
 * arm mirror reads `editorStore`'s own `armed` flags and the stop-follows-the-
 * transport rule rides `playerStore.isPlaying`, which is what `liveMixer`
 * writes — because those are the couplings the press exists to get right.
 *
 * The load-bearing assertions:
 *   - a press with nothing armed sets `lastError` and opens NOTHING;
 *   - `engine.start()` resolves BEFORE the transport is released, so the take's
 *     anchor is stamped against a clock that has not moved yet;
 *   - a pass leaves ONE undo step, and one undo takes every take of it back off
 *     the timeline without un-arming the track it was recorded on;
 *   - nothing the engine rejects with ever leaves the store as a throw.
 */
import assert from 'node:assert/strict';

import {
  RecordingError,
  type LevelFrame,
  type RecordingDeps,
  type RecordingEngine,
  type RecordingSource,
  type Take,
} from '../lib/recordingEngine.ts';
import { micConstraints } from '../lib/recordingEngine.ts';
import { useEditorStore } from './editorStore.ts';
import { useFeatureToggleStore } from './featureToggleStore.ts';
import { useIoDevicesStore } from './ioDevicesStore.ts';
import { usePlayerStore } from './playerStore.ts';
import {
  LEVEL_WRITE_MS,
  PUNCH_CHOICES,
  ROUND_TRIP_MAX_MS,
  currentPassPunchWindow,
  initRecording,
  latencyCompSec,
  musicalConstraints,
  punchWindow,
  punchWindowFrom,
  recordingDeviceKey,
  resetRecording,
  setRecordingDeps,
  mergeRecordingPrefs,
  setRecordingPrefsStorage,
  useRecordingPrefs,
  useRecordingStore,
} from './recordingStore.ts';

/** Let every queued microtask run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const rs = () => useRecordingStore.getState();
const rp = () => useRecordingPrefs.getState();
const es = () => useEditorStore.getState();

/* --------------------------- the preference storage ------------------------ */

// Installed FIRST, before any block picks a mode: node has no `localStorage`,
// so the real one would warn on every write. Counting `setItem` here is also
// what pins that the HOT store never reaches storage — see the block at the end.
const storageKeys: string[] = [];
const fakeStorage: Record<string, string> = {};
setRecordingPrefsStorage({
  getItem: (k) => fakeStorage[k] ?? null,
  setItem: (k, v) => { storageKeys.push(k); fakeStorage[k] = v; },
  removeItem: (k) => { delete fakeStorage[k]; },
});

/* ------------------------------- fake engine ------------------------------- */

interface FakeEngine extends RecordingEngine {
  /** Every call, in order, for the ordering assertions. */
  readonly calls: string[];
  /** The source a track was armed WITH — which device the take comes from. */
  armedSource(trackId: string): RecordingSource | undefined;
  /** Resolve / reject the `start()` currently in flight. */
  resolveStart(): void;
  rejectStart(err: unknown): void;
  /** What the next `stop()` hands back. */
  setTakes(takes: Take[]): void;
  emitLevel(trackId: string, frame: LevelFrame): void;
}

function fakeEngine(events: string[]): FakeEngine {
  const armedMap = new Map<string, RecordingSource>();
  const levelSubs = new Set<(trackId: string, frame: LevelFrame) => void>();
  const takeSubs = new Set<(take: Take) => void>();
  const calls: string[] = [];
  let takes: Take[] = [];
  let recording = false;
  let settleStart: (() => void) | null = null;
  let failStart: ((e: unknown) => void) | null = null;

  return {
    calls,
    arm(trackId, source) {
      calls.push(`arm:${trackId}`);
      armedMap.set(trackId, source);
    },
    disarm(trackId) {
      calls.push(`disarm:${trackId}`);
      armedMap.delete(trackId);
    },
    armed() {
      return [...armedMap.keys()];
    },
    armedSource(trackId) {
      return armedMap.get(trackId);
    },
    start() {
      calls.push('start');
      events.push('engine.start');
      return new Promise<void>((res, rej) => {
        settleStart = () => {
          recording = true;
          res();
        };
        failStart = (e) => {
          recording = false;
          rej(e);
        };
      });
    },
    async stop() {
      calls.push('stop');
      events.push('engine.stop');
      recording = false;
      const out = takes;
      takes = [];
      for (const t of out) for (const cb of takeSubs) cb(t);
      return out;
    },
    isRecording() {
      return recording;
    },
    onLevel(cb) {
      levelSubs.add(cb);
      return () => { levelSubs.delete(cb); };
    },
    onTake(cb) {
      takeSubs.add(cb);
      return () => { takeSubs.delete(cb); };
    },
    resolveStart() {
      settleStart?.();
      settleStart = null;
      failStart = null;
    },
    rejectStart(err) {
      failStart?.(err);
      settleStart = null;
      failStart = null;
    },
    setTakes(next) {
      takes = next;
    },
    emitLevel(trackId, frame) {
      for (const cb of levelSubs) cb(trackId, frame);
    },
  };
}

function fakeTake(
  trackId: string,
  startSec: number,
  endSec: number,
  error?: RecordingError,
): Take {
  return {
    meta: {
      id: `take-${trackId}-${startSec}`,
      trackId,
      startSec,
      endSec,
      sampleRate: 48000,
      mime: 'audio/webm',
      ...(error ? { error } : {}),
    },
    blob: new Blob(['audio'], { type: 'audio/webm' }),
  };
}

/* --------------------------------- harness --------------------------------- */

interface Harness {
  engine: FakeEngine;
  events: string[];
  /** Transport seconds the engine's `now` reads. */
  setTransportSec(sec: number): void;
  /** Wall clock the level throttle reads. */
  setWallMs(ms: number): void;
  /** `null` = this press does not count in. */
  setCountInBars(bars: number): void;
  /** Make `beginCountIn` call `onDone` SYNCHRONOUSLY and still return a cancel,
   *  the way `MetronomeScheduler.countIn` does with no engine context or with a
   *  count that works out to no clicks. */
  setCountInSynchronous(on: boolean): void;
  /** Make `startTransport` a no-op that never sets `isPlaying` — `liveMixer`
   *  bailing on an empty project. */
  setTransportRefuses(on: boolean): void;
  /** What the fake decode reports the take's blob to be. */
  setDecodedDuration(sec: number): void;
  /** Finish the count-in in flight (the scheduler's `onDone`). */
  finishCountIn(): void;
  countInCancels: number;
  engineDeps: RecordingDeps | null;
}

/** A fresh store, a fresh fake engine, and a timeline with `trackIds` on it. */
function harness(trackIds: readonly string[] = []): Harness {
  resetRecording();
  // A clean document: one unarmed track, no clips, no history.
  useEditorStore.setState({
    tracks: trackIds.map((id, i) => ({
      id,
      name: `Track ${i + 1}`,
      nameAutoGenerated: false,
      volume: 0.8,
      pan: 0,
      mute: false,
      solo: false,
      color: `#00000${i}`,
    })),
    clips: [],
    _undo: [],
    _redo: [],
    // No loop region, so the punch gate is inert unless a block sets one.
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,
  });
  usePlayerStore.setState({ isPlaying: false });
  // `punch` and `roundTrip` are PERSISTED preferences, so `resetRecording()`
  // deliberately leaves them alone — the harness is what returns them to the
  // defaults. An uncalibrated device is what every other block assumes.
  useRecordingPrefs.setState({ punch: 'off', roundTrip: {}, takeMode: 'takes' });

  const events: string[] = [];
  const engine = fakeEngine(events);
  const h: Harness = {
    engine,
    events,
    setTransportSec: (sec) => { transportSec = sec; },
    setWallMs: (ms) => { wallMs = ms; },
    setCountInBars: (bars) => { countInBars = bars; },
    setCountInSynchronous: (on) => { countInSync = on; },
    setTransportRefuses: (on) => { transportRefuses = on; },
    setDecodedDuration: (sec) => { decodedDuration = sec; },
    finishCountIn: () => { countInDone?.(); countInDone = null; },
    countInCancels: 0,
    engineDeps: null,
  };
  let transportSec = 0;
  let wallMs = 0;
  let countInBars = 0;
  let countInSync = false;
  let transportRefuses = false;
  let decodedDuration = 1;
  let countInDone: (() => void) | null = null;

  setRecordingDeps({
    createEngine: (d) => { h.engineDeps = d; return engine; },
    engineEnv: {},
    transportSec: () => transportSec,
    nowMs: () => wallMs,
    startTransport: () => {
      events.push('transport');
      // `liveMixer.start()` returns before it ever sets this when the project
      // has no clips (or a decode throws), so the fake can refuse too.
      if (!transportRefuses) usePlayerStore.setState({ isPlaying: true });
    },
    beginCountIn: (onDone) => {
      if (countInBars <= 0) return null;
      if (countInSync) {
        // The scheduler's own shape on its two synchronous paths: `onDone` now,
        // and a NON-null cancel back.
        onDone();
        return () => { /* the real scheduler hands back a live cancel here */ };
      }
      countInDone = onDone;
      return () => { countInDone = null; };
    },
    cancelCountIn: () => { h.countInCancels += 1; },
    computePeaks: async () => ({ peaks: new Float32Array([0.5, 0.25]), duration: decodedDuration }),
  });
  initRecording();
  return h;
}

/* ------------------------------ the mic profile ---------------------------- */

// The store, not the engine, picks the profile: a PERFORMANCE is recorded flat.
{
  const audioOf = (c: MediaStreamConstraints): Record<string, unknown> =>
    c.audio as unknown as Record<string, unknown>;

  const musical = audioOf(musicalConstraints(micConstraints()));
  assert.equal(musical.echoCancellation, false);
  assert.equal(musical.noiseSuppression, false);
  assert.equal(musical.autoGainControl, false, 'AGC rides a crescendo flat — it must be off');

  // The device the engine asked for survives the rewrite.
  const named = audioOf(musicalConstraints(micConstraints('mic-7')));
  assert.equal(named.deviceId, 'mic-7');
  assert.equal(named.noiseSuppression, false);

  // The engine's own default is still the voice-memo profile — MicRecorder's.
  assert.equal(audioOf(micConstraints('mic-7')).autoGainControl, true);
}

/* --------------------------- the engine it builds -------------------------- */

// Built with the TRANSPORT clock as `now` (the take anchor) and with an input
// opener of the store's own, so the engine never falls back to the memo profile.
{
  resetRecording();
  let captured: RecordingDeps | null = null;
  let sec = 12.5;
  setRecordingDeps({
    createEngine: (d) => { captured = d; return fakeEngine([]); },
    transportSec: () => sec,
  });
  initRecording();
  const deps = captured as RecordingDeps | null;
  assert.ok(deps, 'the store builds its engine through the factory seam');
  assert.equal(deps!.now(), 12.5);
  sec = 30;
  assert.equal(deps!.now(), 30, '`now` is the live transport clock, not a snapshot');
  assert.equal(
    typeof deps!.getUserMedia,
    'function',
    'the store supplies the input opener, so the engine cannot use its own memo-profile default',
  );
}

/* ------------------------------ nothing armed ------------------------------ */

{
  const h = harness(['trk-a']);
  assert.deepEqual(rs().armedTrackIds, []);

  rs().recordPress();
  await flush();

  assert.equal(rs().status, 'idle', 'a press with nothing armed changes no state');
  assert.equal(rs().lastError?.code, 'nothing-armed');
  assert.ok(rs().lastError instanceof RecordingError);
  assert.equal(h.engine.calls.includes('start'), false, 'no input is opened');
  assert.deepEqual(h.events, [], 'and the transport is not touched');
}

/* ------------------------------- the arm mirror ---------------------------- */

{
  const h = harness(['trk-a', 'trk-b']);

  es().updateTrack('trk-a', { armed: true });
  assert.deepEqual(rs().armedTrackIds, ['trk-a'], 'the store mirrors editorStore, in track order');
  assert.deepEqual(h.engine.armed(), ['trk-a'], 'and arms the engine for it');

  es().updateTrack('trk-b', { armed: true });
  assert.deepEqual(rs().armedTrackIds, ['trk-a', 'trk-b']);
  assert.deepEqual(h.engine.armed(), ['trk-a', 'trk-b']);

  es().updateTrack('trk-a', { armed: false });
  assert.deepEqual(rs().armedTrackIds, ['trk-b']);
  assert.deepEqual(h.engine.armed(), ['trk-b'], 'a disarmed track is disarmed on the engine');

  // An unrelated track edit must not churn the engine.
  const before = h.engine.calls.length;
  es().updateTrack('trk-b', { volume: 0.5 });
  assert.equal(h.engine.calls.length, before, 're-arming an already-armed track is not re-issued');
  assert.deepEqual(rs().armedTrackIds, ['trk-b']);
}

/* --------------------- the press: engine first, then transport ------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setTransportSec(8);

  rs().recordPress();
  assert.equal(rs().status, 'recording', 'the key latches on the press, not on the device');
  await flush();
  assert.deepEqual(h.events, ['engine.start'], 'the transport is still where it was');

  h.engine.resolveStart();
  await flush();
  assert.deepEqual(
    h.events,
    ['engine.start', 'transport'],
    'the recorders are live BEFORE the clock moves, so the anchor is the playhead',
  );
  assert.equal(rs().status, 'recording');

  // Tidy up: stop the pass so the next block starts clean.
  h.engine.setTakes([]);
  rs().stopRecording();
  await flush();
  assert.equal(rs().status, 'idle');
}

/* -------------------------------- count-in --------------------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setCountInBars(2);

  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'counting');
  assert.deepEqual(h.events, [], 'nothing is opened and nothing moves during the count');

  // A second press during the count cancels it. Nothing was moved, so there is
  // nothing to undo — only the clicks to silence.
  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'idle');
  assert.equal(h.countInCancels, 1, 'the count-in is cancelled through the metronome');
  assert.deepEqual(h.events, []);
  assert.equal(h.engine.calls.includes('start'), false);

  // And a count that runs to its end releases the pass.
  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'counting');
  h.finishCountIn();
  await flush();
  assert.equal(rs().status, 'recording');
  assert.deepEqual(h.events, ['engine.start']);
  h.engine.resolveStart();
  await flush();
  assert.deepEqual(h.events, ['engine.start', 'transport']);

  h.engine.setTakes([]);
  rs().stopRecording();
  await flush();
}

/* -------------------- a count-in that releases synchronously --------------- */

// `MetronomeScheduler.countIn` calls `onDone` inline — and still returns a
// non-null cancel — when there is no engine context, and when the count works
// out to no clicks. `shouldCountIn` cannot see either from outside, so the
// press must not latch `counting` over a pass that is already rolling.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setCountInBars(2);
  h.setCountInSynchronous(true);

  rs().recordPress();
  assert.equal(rs().status, 'recording', 'the release wins: the key says what the engine is doing');
  await flush();
  assert.deepEqual(h.events, ['engine.start'], 'and the pass really did start');
  h.engine.resolveStart();
  await flush();
  assert.deepEqual(h.events, ['engine.start', 'transport']);

  // The next press is therefore a STOP, not a cancel of a count that is not
  // running — which is what used to leave the engine rolling with the store
  // idle, and the press after that getting `busy`.
  h.engine.setTakes([fakeTake('trk-a', 0, 2)]);
  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'idle');
  assert.equal(h.countInCancels, 0, 'nothing was cancelled — there was no count');
  assert.equal(h.engine.calls.filter((c) => c === 'stop').length, 1, 'the pass was stopped');
  assert.equal(h.engine.isRecording(), false, 'and the engine is not left rolling');
  assert.equal(es().clips.length, 1);
}

/* ------------------------------ stop: placement ---------------------------- */

{
  const h = harness(['trk-a', 'trk-b']);
  es().updateTrack('trk-a', { armed: true });
  es().updateTrack('trk-b', { armed: true });
  const undoDepth = () => (useEditorStore.getState() as unknown as { _undo: unknown[] })._undo.length;
  const depthBeforePass = undoDepth();

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  h.engine.setTakes([fakeTake('trk-a', 4, 6.5), fakeTake('trk-b', 4, 6.5)]);
  rs().stopRecording();
  assert.equal(rs().status, 'stopping');
  await flush();
  assert.equal(rs().status, 'idle');
  assert.deepEqual(rs().levels, {}, 'the meters go dark with the pass');

  const clips = es().clips;
  assert.equal(clips.length, 2, 'one clip per take');
  const a = clips.find((c) => c.trackId === 'trk-a')!;
  assert.equal(a.startSec, 4, 'the clip lands on the take\'s own anchor');
  assert.equal(a.durationSec, 2.5);
  assert.equal(a.sourceDuration, 2.5, 'a take IS its source');
  assert.equal(a.offsetIntoSource, 0);
  assert.equal(a.mimeType, 'audio/webm');
  assert.equal(a.audioBlob.size > 0, true, 'the bytes are on the clip');
  assert.deepEqual(clips.map((c) => c.label), ['Take 1', 'Take 2'], 'each pass numbers its takes');
  assert.equal(a.color, es().tracks.find((t) => t.id === 'trk-a')!.color, 'the clip takes its track\'s colour');

  // Peaks are decoded afterwards and cached onto the clip.
  await flush();
  assert.equal(es().clips.find((c) => c.id === a.id)?.peaks?.length, 2);

  // ONE undo step for the whole pass: one undo takes BOTH takes off, and the
  // track it was recorded on is still armed (the pass did not fold into the
  // arm flip that happened moments before it).
  assert.equal(undoDepth(), depthBeforePass + 1, 'the pass is a single undo step');
  es().undo();
  assert.equal(es().clips.length, 0, 'one undo takes the whole pass back off the timeline');
  assert.equal(es().tracks.find((t) => t.id === 'trk-a')?.armed, true, 'and leaves the arm alone');
}

/* ------------------ a take whose clock never moved is repaired ------------- */

// The FIRST take of every new project: `liveMixer.start()` bails on an empty
// timeline, so `isPlaying` never sets, `currentTransportSec()` stays on the
// stationary playhead and the take reads `endSec === startSec`. The bytes know
// their own length, so the decode repairs the clip.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setTransportRefuses(true);
  h.setDecodedDuration(3.2);

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  h.engine.setTakes([fakeTake('trk-a', 5, 5)]); // the clock never moved
  rs().stopRecording();
  await flush();
  await flush();

  const clip = es().clips[0];
  assert.ok(clip, 'the take still lands');
  assert.equal(clip.startSec, 5, 'the ANCHOR was never in doubt — only the length');
  assert.equal(clip.durationSec, 3.2, 'the length comes from the decode');
  assert.equal(clip.sourceDuration, 3.2);
  assert.equal(clip.peaks?.length, 2, 'and the peaks land in the same write');
  // History-exempt: the pass is still one undo step, and one undo clears it.
  es().undo();
  assert.equal(es().clips.length, 0);
}

// The loop-region case is the same repair: `currentTransportSec()` rewinds at
// `loopEnd`, so a take that runs past it ends EARLIER than it began and
// `takeClipPlacement` floors the length at 0.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setDecodedDuration(7.5);

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  h.engine.setTakes([fakeTake('trk-a', 9, 1)]); // wrapped at loopEnd
  rs().stopRecording();
  await flush();
  await flush();

  const clip = es().clips[0];
  assert.equal(clip.startSec, 9);
  assert.equal(clip.durationSec, 7.5, 'a wrapped clock is repaired from the decode too');
  assert.equal(clip.sourceDuration, 7.5);
}

// A take the clock DID measure is never overwritten by the decode — the user
// may have trimmed the clip in the moments the decode took.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  h.setDecodedDuration(99);

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  h.engine.setTakes([fakeTake('trk-a', 2, 6)]);
  rs().stopRecording();
  await flush();
  await flush();

  const clip = es().clips[0];
  assert.equal(clip.durationSec, 4, 'the measured length stands');
  assert.equal(clip.sourceDuration, 4);
  assert.equal(clip.peaks?.length, 2, 'peaks still cached');
}

/* ------------------------- a faulted take still lands ---------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  const fault = new RecordingError('unsupported', 'The recorder faulted mid-take: boom');
  h.engine.setTakes([fakeTake('trk-a', 1, 3, fault)]);
  rs().stopRecording();
  await flush();

  assert.equal(es().clips.length, 1, 'the audio it did gather is still delivered');
  assert.equal(rs().lastError, fault, 'and the fault is flagged beside it');
  assert.equal(rs().status, 'idle');
}

/* ---------------------- the transport stops the recording ------------------ */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  assert.equal(rs().status, 'recording');

  h.engine.setTakes([fakeTake('trk-a', 0, 2)]);
  // What liveMixer's `pause` / `stop` publish.
  usePlayerStore.setState({ isPlaying: false });
  await flush();

  assert.equal(rs().status, 'idle', 'a take cannot outlive the clock it is anchored to');
  assert.equal(h.engine.calls.filter((c) => c === 'stop').length, 1);
  assert.equal(es().clips.length, 1, 'and the pass is still laid down');
}

/* ------------------------------- busy / failure ---------------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });

  rs().recordPress();
  await flush();
  h.engine.rejectStart(new RecordingError('busy'));
  await flush();

  assert.equal(rs().status, 'idle', 'a refused start leaves nothing latched');
  assert.equal(rs().lastError?.code, 'busy');
  assert.deepEqual(h.events, ['engine.start'], 'and never releases the transport');

  // A non-RecordingError is wrapped, not re-thrown.
  rs().recordPress();
  await flush();
  h.engine.rejectStart(new TypeError('something else entirely'));
  await flush();
  assert.equal(rs().status, 'idle');
  assert.ok(rs().lastError instanceof RecordingError);
  assert.match(rs().lastError!.message, /something else entirely/);
}

/* --------------------- a stop that lands while starting -------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });

  rs().recordPress();
  await flush();
  // The inputs are still opening.
  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'stopping');
  assert.equal(h.engine.calls.includes('stop'), false, 'an engine with nothing in it is not stopped');

  h.engine.setTakes([fakeTake('trk-a', 0, 1)]);
  h.engine.resolveStart();
  await flush();

  assert.equal(rs().status, 'idle');
  assert.equal(h.engine.calls.filter((c) => c === 'stop').length, 1, 'the stop runs once the recorders are live');
  assert.equal(
    h.events.includes('transport'),
    false,
    'a pass stopped before it ran never releases the transport',
  );
  assert.equal(es().clips.length, 1);
}

/* ------------------------------- level throttle ---------------------------- */

{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  let writes = 0;
  const off = useRecordingStore.subscribe(() => { writes += 1; });

  h.setWallMs(1000);
  h.engine.emitLevel('trk-a', { peak: 0.5, rms: 0.25 });
  assert.equal(writes, 1, 'the first frame of a window is written through');
  assert.deepEqual(rs().levels['trk-a'], { peak: 0.5, rms: 0.25 });

  // Inside the window every further frame is coalesced away.
  h.setWallMs(1000 + LEVEL_WRITE_MS - 1);
  h.engine.emitLevel('trk-a', { peak: 0.9, rms: 0.4 });
  assert.equal(writes, 1, `no more than one write per ${LEVEL_WRITE_MS}ms`);
  assert.deepEqual(rs().levels['trk-a'], { peak: 0.5, rms: 0.25 });

  // The window closes and the latest frame lands.
  h.setWallMs(1000 + LEVEL_WRITE_MS);
  h.engine.emitLevel('trk-a', { peak: 0.8, rms: 0.3 });
  assert.equal(writes, 2);
  assert.deepEqual(rs().levels['trk-a'], { peak: 0.8, rms: 0.3 });

  off();
  h.engine.setTakes([]);
  rs().stopRecording();
  await flush();
  assert.deepEqual(rs().levels, {});
}

/* --------------------------- punch in / punch out -------------------------- */

/** One whole pass: press, let the recorders open, hand back `takes`, stop, and
 *  let the decode that follows the placement settle. */
async function pass(h: Harness, takes: Take[]): Promise<void> {
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  h.engine.setTakes(takes);
  rs().stopRecording();
  await flush();
  await flush();
}

/** The editor's loop region IS the punch region — there is no second owner. */
function setLoop(start: number, end: number): void {
  es().setLoopRegion(start, end);
  assert.equal(es().loopEnabled, true, 'the fixture loop is long enough to enable');
}

// The default, and the only value a bad one falls back to.
{
  const h = harness([]);
  void h;
  assert.equal(rp().punch, 'off', 'punch is off until asked for');
  rp().setPunch('in-out');
  assert.equal(rp().punch, 'in-out');
  rp().setPunch('nonsense' as never);
  assert.equal(rp().punch, 'off', 'an unknown mode is not a mode');
}

// `in-out`: the take is cropped to BOTH edges of the loop region. The bytes are
// untouched — the clip keeps the whole take as its source and slides its window
// in with `offsetIntoSource`.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  const clip = es().clips[0];
  assert.ok(clip, 'a take that overlaps the window still lands');
  assert.equal(clip.startSec, 4, 'the clip starts at loopStart');
  assert.equal(clip.durationSec, 6, 'and ends at loopEnd');
  assert.equal(clip.offsetIntoSource, 2, 'the head outside the window is trimmed, not discarded');
  assert.equal(clip.sourceDuration, 10, 'the SOURCE is still the whole pass');
  assert.equal(clip.audioBlob.size > 0, true);
}

// `in`: the lower edge only — recording starts at loopStart and runs on past
// loopEnd to wherever the pass was stopped.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in');

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  const clip = es().clips[0];
  assert.equal(clip.startSec, 4);
  assert.equal(clip.durationSec, 8, 'punch in does not punch out');
  assert.equal(clip.offsetIntoSource, 2);
  assert.equal(clip.sourceDuration, 10);
}

// `out`: the upper edge only — the take keeps its own anchor and is cut at
// loopEnd.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('out');

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  const clip = es().clips[0];
  assert.equal(clip.startSec, 2, 'punch out does not punch in');
  assert.equal(clip.durationSec, 8);
  assert.equal(clip.offsetIntoSource, 0, 'nothing is trimmed off the front');
  assert.equal(clip.sourceDuration, 10);
}

// A take wholly INSIDE the window is passed through untouched.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 5, 8)]);

  const clip = es().clips[0];
  assert.equal(clip.startSec, 5);
  assert.equal(clip.durationSec, 3);
  assert.equal(clip.offsetIntoSource, 0);
}

// A take wholly OUTSIDE it is dropped, and takes no take number with it.
{
  const h = harness(['trk-a', 'trk-b']);
  es().updateTrack('trk-a', { armed: true });
  es().updateTrack('trk-b', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 12, 14), fakeTake('trk-b', 6, 9)]);

  const clips = es().clips;
  assert.equal(clips.length, 1, 'the take outside the window never becomes a clip');
  assert.equal(clips[0].trackId, 'trk-b');
  assert.equal(clips[0].label, 'Take 1', 'a dropped take does not burn a take number');
}

// Punch armed with NO loop region: the press records normally and says so. The
// pass is not refused and the status never leaves its ordinary path.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  es().clearLoop();
  rp().setPunch('in-out');
  // Two presses over the same stretch, so this block says outright that it is
  // about the NOTICE and not about placement: in the default `takes` mode the
  // second press lands on the first press's clip as a take. That rule has a
  // section of its own at the end of this file.
  rp().setTakeMode('clips');

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  assert.match(
    rs().lastNotice?.text ?? '',
    /punch ignored: no loop region/i,
    'the press explains why the punch did nothing',
  );
  assert.equal(rs().lastError, null, 'nothing FAILED — the notice is informational');
  assert.equal(rs().status, 'idle');
  const clip = es().clips[0];
  assert.ok(clip, 'and the pass is recorded whole');
  assert.equal(clip.startSec, 2);
  assert.equal(clip.durationSec, 10);
  assert.equal(clip.offsetIntoSource, 0);

  // Give it a region and the notice goes away on the next press — it describes
  // THAT press, like `lastError`, not a setting that is stuck wrong.
  setLoop(4, 10);
  await pass(h, [fakeTake('trk-a', 2, 12)]);
  assert.equal(rs().lastNotice, null, 'the notice is cleared by the press that no longer needs it');
  assert.equal(es().clips[1].durationSec, 6, 'and that press punched');
}

// THE WRAP RULE. One press is one take per armed track — the engine records the
// whole pass as a single blob however many times the transport rewound at
// `loopEnd` — so a pass that wraps yields ONE clip, never one per lap. Its
// CLOCK is the wrapped one T12b-a repairs (`endSec` lands earlier than
// `startSec`), and a clock that rewound cannot bound a window: the take is
// repaired from the decode and left UNCROPPED, exactly as with punch off.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');
  h.setDecodedDuration(7.5);

  await pass(h, [fakeTake('trk-a', 9, 1)]);

  const clips = es().clips;
  assert.equal(clips.length, 1, 'one pass, one take, one clip');
  assert.equal(clips[0].startSec, 9, 'the anchor was never in doubt');
  assert.equal(clips[0].durationSec, 7.5, 'the T12b-a repair still owns the length');
  assert.equal(clips[0].sourceDuration, 7.5);
  assert.equal(clips[0].offsetIntoSource, 0, 'an unmeasured take is never cropped');
}

// Two presses are two takes, and each pass is still exactly one undo step.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');
  // `clips` mode: this block is about the UNDO STEP a punched pass leaves, and
  // two presses into one window are what pins it. The default `takes` mode
  // would fold the second press into the first clip — pinned at the end of
  // this file, undo step included.
  rp().setTakeMode('clips');
  const undoDepth = () => (useEditorStore.getState() as unknown as { _undo: unknown[] })._undo.length;

  const before = undoDepth();
  await pass(h, [fakeTake('trk-a', 2, 12)]);
  assert.equal(undoDepth(), before + 1, 'a punched pass is one undo step');
  await pass(h, [fakeTake('trk-a', 3, 11)]);
  assert.equal(es().clips.length, 2, 'two passes, two takes');
  assert.equal(undoDepth(), before + 2);

  es().undo();
  assert.equal(es().clips.length, 1, 'one undo takes the LAST pass off, and only it');
  assert.equal(es().clips[0].label, 'Take 1');
}

// Punch OFF with a loop region up: nothing is cropped.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);

  await pass(h, [fakeTake('trk-a', 2, 12)]);

  const clip = es().clips[0];
  assert.equal(clip.startSec, 2, 'punch off is punch off, loop region or not');
  assert.equal(clip.durationSec, 10);
  assert.equal(clip.offsetIntoSource, 0);
  assert.equal(rs().lastError, null, 'and there is nothing to say about it');
  assert.equal(rs().lastNotice, null);
}

// THE WINDOW IS THE PRESS'S. Dragging the loop region — or changing the mode —
// while the recorders are rolling must not reach back and re-cut a take that
// was recorded under the old window.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  // Mid-pass: the user drags the loop somewhere else and switches the mode off.
  setLoop(20, 30);
  rp().setPunch('off');
  h.engine.setTakes([fakeTake('trk-a', 2, 12)]);
  rs().stopRecording();
  await flush();
  await flush();

  const clip = es().clips[0];
  assert.equal(clip.startSec, 4, 'the crop is the window the press was made with');
  assert.equal(clip.durationSec, 6);
  assert.equal(clip.offsetIntoSource, 2);
}

// A pass the window kept NOTHING of does not vanish in silence.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 12, 14)]);

  assert.equal(es().clips.length, 0, 'nothing lands');
  assert.match(rs().lastNotice?.text ?? '', /punch window empty/i, 'and the store says why');
  assert.equal(rs().lastError, null, 'still not a failure');
}

// The SAME notice twice is two notices: a value-keyed consumer (the footer's
// effect) must re-post, so the text alone is not the identity.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  es().clearLoop();
  rp().setPunch('in-out');

  await pass(h, [fakeTake('trk-a', 0, 1)]);
  const first = rs().lastNotice;
  await pass(h, [fakeTake('trk-a', 2, 3)]);
  const second = rs().lastNotice;

  assert.equal(first?.text, second?.text, 'the same thing happened twice');
  assert.notEqual(first?.seq, second?.seq, 'and it is reported twice');
  assert.notEqual(first, second, 'a fresh object, so an identity-keyed effect refires');
}

// A press with nothing armed clears a notice the previous press left behind —
// it describes THAT press, and this one did not even open an input.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  es().clearLoop();
  rp().setPunch('in-out');
  await pass(h, [fakeTake('trk-a', 0, 1)]);
  assert.ok(rs().lastNotice, 'the notice is up');

  es().updateTrack('trk-a', { armed: false });
  rs().recordPress();
  await flush();
  assert.equal(rs().lastError?.code, 'nothing-armed');
  assert.equal(rs().lastNotice, null, 'and the stale notice went with it');
}

/* ------------------------- the window, on its own -------------------------- */

// `punchWindowFrom` is the ONE gate: the take crop reads it through
// `punchWindow()` and the timeline's punch band reads it directly, so a band
// that promises a crop the store would refuse cannot exist. Four modes against
// a loop that is enabled, disabled, degenerate or absent.
{
  const loop = { enabled: true, start: 4, end: 10 };

  assert.equal(punchWindowFrom('off', loop), null, 'punch off is no window, loop region or not');
  assert.deepEqual(punchWindowFrom('in', loop), { from: 4, to: Infinity }, 'in opens at loopStart and never closes');
  assert.deepEqual(punchWindowFrom('out', loop), { from: -Infinity, to: 10 }, 'out closes at loopEnd and never opens');
  assert.deepEqual(punchWindowFrom('in-out', loop), { from: 4, to: 10 }, 'in-out is both edges');

  for (const mode of PUNCH_CHOICES) {
    // A region that is SET but switched off is no window — `loopEnabled` is the
    // user saying the region is not in force, and the crop honours that.
    assert.equal(punchWindowFrom(mode, { enabled: false, start: 4, end: 10 }), null, `${mode}: a disabled loop is no window`);
    assert.equal(punchWindowFrom(mode, null), null, `${mode}: no loop region at all is no window`);
    assert.equal(punchWindowFrom(mode, { enabled: true, start: 4, end: 4 }), null, `${mode}: a zero-length region is no region`);
    assert.equal(punchWindowFrom(mode, { enabled: true, start: 10, end: 4 }), null, `${mode}: an inverted region is no region`);
    assert.equal(punchWindowFrom(mode, { enabled: true, start: NaN, end: 10 }), null, `${mode}: a non-finite start is no region`);
    assert.equal(punchWindowFrom(mode, { enabled: true, start: 0, end: Infinity }), null, `${mode}: a non-finite end is no region`);
  }
}

// And the store's own reader IS that helper applied to the editor's region.
{
  const h = harness(['trk-a']);
  void h;
  rp().setPunch('in-out');
  es().clearLoop();
  assert.equal(punchWindow(), null, 'no region, no window');

  setLoop(4, 10);
  assert.deepEqual(punchWindow(), { from: 4, to: 10 });
  assert.deepEqual(
    punchWindow(),
    punchWindowFrom('in-out', { enabled: es().loopEnabled, start: es().loopStart, end: es().loopEnd }),
    'one derivation, two callers',
  );

  es().setLoopEnabled(false);
  assert.equal(punchWindow(), null, 'a region switched off is no window');
  rp().setPunch('off');
}

// The PASS window is readable from outside, so `lib/midiCapture` crops with the
// very window the take crop uses instead of restating the derivation and
// reading it a count-in later.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  setLoop(4, 10);
  rp().setPunch('in-out');
  assert.equal(currentPassPunchWindow(), null, 'nothing is frozen before a press');

  rs().recordPress();
  await flush();
  assert.deepEqual(currentPassPunchWindow(), { from: 4, to: 10 }, 'the press froze it');

  setLoop(20, 30);
  rp().setPunch('off');
  assert.deepEqual(currentPassPunchWindow(), { from: 4, to: 10 }, 'and a mid-pass change cannot reach it');

  h.engine.resolveStart();
  await flush();
  h.engine.setTakes([]);
  rs().stopRecording();
  await flush();
  await flush();

  assert.equal(
    currentPassPunchWindow(),
    null,
    'and the pass over, there is no pass window — not the last one, still standing',
  );
  rp().setPunch('off');
}

/* -------------------- the MIDI hand-off: one press, one take --------------- */

// `lib/midiCapture` records every armed track its `capturesMidi` accepts, and
// the engine opens a recorder per armed track — so an armed instrument track
// used to come out of ONE press with a mic take AND a MIDI take stacked on it.
// The arm mirror is where that is settled: the STORE still reports every armed
// track (the capture reads that list, and the key still counts them), and only
// the tracks that do NOT capture MIDI reach the engine.
{
  const h = harness(['trk-audio', 'trk-inst']);
  es().updateTrack('trk-inst', { instrumentProgram: 0 });
  es().updateTrack('trk-audio', { armed: true });
  es().updateTrack('trk-inst', { armed: true });

  assert.deepEqual(rs().armedTrackIds, ['trk-audio', 'trk-inst'], 'both are armed, and the store says both');
  assert.deepEqual(h.engine.armed(), ['trk-audio'], 'one mic recorder — the instrument track is the capture\'s');

  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'recording');
  assert.deepEqual(h.events, ['engine.start'], 'the mic pass still runs, for the audio track');

  h.engine.resolveStart();
  await flush();
  h.engine.setTakes([fakeTake('trk-audio', 0, 4)]);
  rs().stopRecording();
  await flush();
  await flush();

  assert.equal(rs().status, 'idle');
  assert.deepEqual(es().clips.map((c) => c.trackId), ['trk-audio'], 'and only the audio track gets a mic take');
}

// EVERY armed track captures MIDI: no recorder is opened at all — the real
// engine rejects an empty `start()` with `nothing-armed` — but the PRESS
// contract is untouched. `midiCapture` opens its captures on the flip INTO
// `recording` and closes them on the flip out, so the pass still has to run:
// status cycles, the transport still rolls, and nothing is said about it.
{
  const h = harness(['trk-inst']);
  es().updateTrack('trk-inst', { instrumentProgram: 24, armed: true });

  assert.deepEqual(rs().armedTrackIds, ['trk-inst'], 'armed, and visible as armed');
  assert.deepEqual(h.engine.armed(), [], 'and with no mic recorder behind it');

  const seen: string[] = [];
  const off = useRecordingStore.subscribe((s, prev) => {
    if (s.status !== prev.status) seen.push(s.status);
  });

  rs().recordPress();
  await flush();
  assert.equal(rs().status, 'recording', 'the press still starts a pass');
  assert.equal(h.engine.calls.includes('start'), false, 'with no input opened');
  assert.deepEqual(h.events, ['transport'], 'and the transport still rolls, so the clock the capture stamps with moves');
  assert.equal(rs().lastError, null, 'nothing failed');
  assert.equal(rs().lastNotice, null, 'and there is nothing new to say');

  rs().stopRecording();
  await flush();
  await flush();
  off();

  assert.equal(rs().status, 'idle');
  assert.equal(h.engine.calls.includes('stop'), false, 'nothing was opened, so there is nothing to stop');
  assert.equal(es().clips.length, 0, 'the mic side lands nothing — the take is the capture\'s');
  assert.deepEqual(seen, ['recording', 'stopping', 'idle'], 'the exact flips the capture opens and closes on');
}

// A track becomes the capture's the moment its LATEST clip is a MIDI clip, and
// the mirror follows without a re-arm.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  assert.deepEqual(h.engine.armed(), ['trk-a'], 'a bare armed track is the mic\'s');

  es().addClipToTrack({
    trackId: 'trk-a',
    label: 'Roll',
    audioBlob: new Blob(['x'], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 1,
    offsetIntoSource: 0,
    durationSec: 1,
    startSec: 0,
    color: '#fff',
    sourceKind: 'piano-roll',
    sourcePianoRoll: [{ id: 'n1', note: 60, velocity: 100, step: 0, length: 4 }],
  });
  // The clip alone does not re-run the mirror (only `tracks` identity does), so
  // the next arm-flag write is what re-reads it — as a real re-arm would.
  es().updateTrack('trk-a', { armed: false });
  es().updateTrack('trk-a', { armed: true });
  assert.deepEqual(rs().armedTrackIds, ['trk-a'], 'still armed');
  assert.deepEqual(h.engine.armed(), [], 'and now the capture\'s, not the mic\'s');
}

// An armed id with no track behind it — `armedTrackIds` is a seam, and a host
// may name a track this store cannot see. There is nothing to judge, so the
// recorder is armed for it exactly as it was before the hand-off existed.
{
  const h = harness([]);
  setRecordingDeps({ armedTrackIds: () => ['ghost'] });
  resetRecording();
  initRecording();

  assert.deepEqual(rs().armedTrackIds, ['ghost'], 'the store reports what the seam gave it');
  assert.deepEqual(h.engine.armed(), ['ghost'], 'an id nothing can judge keeps its recorder');
  // Back to the real reach, or every block after this one presses with nothing.
  setRecordingDeps({
    armedTrackIds: () => es().tracks.filter((t) => t.armed === true).map((t) => t.id),
  });
}

// A pass that DID open recorders and was then disarmed mid-pass still stops the
// engine it opened: the decision is frozen at `beginPass`, not re-read at the
// stop, so the recorders can never be left rolling with nothing able to close
// them.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  assert.equal(h.engine.calls.includes('start'), true, 'the recorders opened');

  es().updateTrack('trk-a', { armed: false });
  assert.deepEqual(h.engine.armed(), [], 'the mirror dropped it mid-pass');

  h.engine.setTakes([fakeTake('trk-a', 0, 3)]);
  rs().stopRecording();
  await flush();
  await flush();

  assert.equal(h.engine.calls.includes('stop'), true, 'and the pass it opened is still stopped');
  assert.equal(rs().status, 'idle');
  assert.equal(es().clips.length, 1, 'the take it was already holding still lands');
}

/* ---------------- the preference is NOT on the hot store ------------------- */

// `persist` replaces `setState`, so persisting the hot store would serialise it
// and hit storage on every meter frame — 20 writes a second per pass — and a
// storage that throws would throw out of `recordPress`. The preference lives in
// its own store; this pins that the hot one never reaches storage.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();

  const before = storageKeys.length;
  for (let i = 0; i < 40; i += 1) {
    h.setWallMs(10_000 + i * LEVEL_WRITE_MS);
    h.engine.emitLevel('trk-a', { peak: i / 40, rms: i / 80 });
  }
  assert.ok(rs().levels['trk-a'], 'the frames really did reach the store');
  rs().stopRecording();
  await flush();
  assert.equal(
    storageKeys.length,
    before,
    'a pass — meters, status flips, the placement and all — writes no storage',
  );

  // The preference itself still persists, which is what proves the counter works.
  rp().setPunch('in-out');
  assert.equal(storageKeys.length, before + 1, 'picking a mode is the only thing that does');
  assert.equal(storageKeys[storageKeys.length - 1], 'thedaw-recording-prefs');
  rp().setPunch('off');
}

/* ------------------ the round trip reaches take placement ------------------ */

// The whole point of #69: a measured loop, persisted per device, has to come
// back out at the one place a take becomes a clip. `takeClipPlacement` is not
// spied on — the CLIP is checked instead, which proves the number went through
// the real arithmetic rather than merely reaching a call.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });

  // In node there is no device list, so `resolveGlobal('audio_input')` reports
  // the OS default — the `''` key, which is the one an uncalibrated install
  // uses too. Saving under it is what a calibrator run does.
  assert.equal(recordingDeviceKey(), '', 'with nothing enumerated, the key is the OS default');
  assert.equal(latencyCompSec(), 0, 'and an unmeasured device compensates by nothing');

  rp().setRoundTrip(recordingDeviceKey(), { ms: 250, measuredAt: '2026-09-17T10:00:00.000Z', confidence: 0.9 });
  assert.equal(latencyCompSec(), 0.25, 'the saved ms is read back as seconds');

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  h.engine.setTakes([fakeTake('trk-a', 4, 6.5)]);
  rs().stopRecording();
  await flush();

  const clip = es().clips[0];
  assert.equal(clip.startSec, 3.75, 'the clip slides EARLIER by the measured round trip');
  assert.equal(clip.durationSec, 2.5, 'the take keeps its length — only the anchor moves');
  assert.equal(clip.offsetIntoSource, 0, 'and nothing is trimmed off its front');
}

// A comp larger than the anchor clamps at 0 rather than going negative: the
// timeline has no time before zero. (`takeClipPlacement`'s own rule — this pins
// that the store's hand-off does not defeat it.)
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rp().setRoundTrip('', { ms: 900, measuredAt: '2026-09-17T10:00:00.000Z', confidence: 0.8 });

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  h.engine.setTakes([fakeTake('trk-a', 0.2, 1.2)]);
  rs().stopRecording();
  await flush();

  assert.equal(es().clips[0].startSec, 0, 'clamped at the start of the timeline');
  assert.equal(es().clips[0].durationSec, 1, 'and the take is not trimmed to pay for it');
}

// Device PARITY: the take is captured on the same device the calibration was
// measured on. Without this the engine opened the OS default while the
// compensation came from whatever the user had chosen — one microphone's
// latency applied to another's recording.
{
  const h = harness(['trk-a']);
  // A resolved global input, as `ioDevicesStore` would report after the user
  // picks one in Settings.
  useFeatureToggleStore.setState((s) => ({
    settings: { ...s.settings, io: { ...s.settings.io, audio_input: { id: 'usb-mic-3', label: 'Scarlett 2i2' } } },
  }));
  useIoDevicesStore.setState({ audioIn: [{ id: 'usb-mic-3', label: 'Scarlett 2i2' }], labelsKnown: true });
  assert.equal(recordingDeviceKey(), 'usb-mic-3', 'the key follows the resolved global input');

  es().updateTrack('trk-a', { armed: true });
  assert.deepEqual(
    h.engine.armedSource('trk-a'),
    { kind: 'mic', deviceId: 'usb-mic-3' },
    'the ARM carries that device, so the take is recorded on it',
  );

  // And the compensation is read from that same device's entry.
  rp().setRoundTrip('usb-mic-3', { ms: 40, measuredAt: '2026-09-17T10:00:00.000Z', confidence: 0.95 });
  rp().setRoundTrip('', { ms: 400, measuredAt: '2026-09-17T10:00:00.000Z', confidence: 0.95 });
  assert.equal(latencyCompSec(), 0.04, 'the chosen device, not the OS default entry');

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  h.engine.setTakes([fakeTake('trk-a', 4, 6.5)]);
  rs().stopRecording();
  await flush();
  assert.equal(es().clips[0].startSec, 3.96, 'the clip is placed by the device it was recorded on');

  // Back to the OS default for every block after this one.
  useFeatureToggleStore.setState((s) => ({
    settings: { ...s.settings, io: { ...s.settings.io, audio_input: { id: '', label: '' } } },
  }));
  useIoDevicesStore.setState({ audioIn: [], labelsKnown: false });
  assert.equal(recordingDeviceKey(), '');
}

// With nothing chosen the arm still says "the default", exactly as before —
// `micConstraints` drops an empty device id, so the open is byte-for-byte the
// call every pass made before device parity existed.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  assert.deepEqual(h.engine.armedSource('trk-a'), { kind: 'mic', deviceId: '' });
  const audio = musicalConstraints(micConstraints('')).audio as Record<string, unknown>;
  assert.equal('deviceId' in audio, false, 'an empty id names no device at all');
}

// A measurement for ANOTHER device does not compensate this one.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rp().setRoundTrip('some-other-mic', { ms: 250, measuredAt: '2026-09-17T10:00:00.000Z', confidence: 1 });
  assert.equal(latencyCompSec(), 0, 'the map is keyed by device, and this is not that device');

  rs().recordPress();
  await flush();
  h.engine.resolveStart();
  await flush();
  h.engine.setTakes([fakeTake('trk-a', 4, 6.5)]);
  rs().stopRecording();
  await flush();
  assert.equal(es().clips[0].startSec, 4, 'so the take lands on its own anchor');
}

// Nothing unusable is ever stored, so nothing unusable can reach placement.
{
  harness([]);
  const key = 'validation-probe';
  for (const bad of [Number.NaN, Infinity, -1, ROUND_TRIP_MAX_MS + 1]) {
    rp().setRoundTrip(key, { ms: bad, measuredAt: 'now', confidence: 1 });
    assert.equal(rp().roundTrip[key], undefined, `ms ${bad} is not a measurement`);
    assert.equal(latencyCompSec(key), 0);
  }
  // A good one goes in, and clearing takes it out again.
  rp().setRoundTrip(key, { ms: 12.5, measuredAt: 'now', confidence: 2 });
  assert.equal(rp().roundTrip[key].ms, 12.5);
  assert.equal(rp().roundTrip[key].confidence, 1, 'confidence is clamped into 0..1');
  // A saved entry REPLACES a worse one — a re-run is the fix for a bad reading.
  rp().setRoundTrip(key, { ms: 30, measuredAt: 'later', confidence: 0.6 });
  assert.equal(rp().roundTrip[key].ms, 30);
  rp().clearRoundTrip(key);
  assert.equal(rp().roundTrip[key], undefined);
  rp().clearRoundTrip(key); // idempotent
  assert.equal(rp().roundTrip[key], undefined);
}

// Hydrating the map: only usable entries survive, and a corrupt one never
// reaches `latencyCompSec`.
{
  const base: Parameters<typeof mergeRecordingPrefs>[1] = {
    punch: 'off',
    roundTrip: { stale: { ms: 5, measuredAt: 'x', confidence: 1 } },
    takeMode: 'takes',
    setPunch: rp().setPunch,
    setTakeMode: rp().setTakeMode,
    setRoundTrip: rp().setRoundTrip,
    clearRoundTrip: rp().clearRoundTrip,
  };
  const merged = mergeRecordingPrefs(
    {
      punch: 'in',
      roundTrip: {
        good: { ms: 21.5, measuredAt: '2026-01-01T00:00:00.000Z', confidence: 0.77 },
        nan: { ms: Number.NaN, measuredAt: 'x', confidence: 1 },
        negative: { ms: -4, measuredAt: 'x', confidence: 1 },
        absurd: { ms: 60_000, measuredAt: 'x', confidence: 1 },
        notAnObject: 7,
        noMs: { measuredAt: 'x', confidence: 1 },
      },
    },
    base,
  );
  assert.deepEqual(Object.keys(merged.roundTrip), ['good'], 'only the usable entry hydrates');
  assert.equal(merged.roundTrip.good.ms, 21.5);
  assert.equal(merged.roundTrip.good.confidence, 0.77);
  assert.equal(merged.punch, 'in', 'the punch mode still hydrates alongside it');
  // Nothing persisted at all is an empty map, not undefined — `placeTakes`
  // indexes it on every pass.
  assert.deepEqual(mergeRecordingPrefs(null, base).roundTrip, {});
  assert.deepEqual(mergeRecordingPrefs({ roundTrip: [] }, base).roundTrip, {}, 'an array is not a map');
  assert.deepEqual(mergeRecordingPrefs({ roundTrip: 'nope' }, base).roundTrip, {});
  assert.equal(typeof mergeRecordingPrefs(null, base).setRoundTrip, 'function', 'hydrating keeps the actions');
}

// A persisted value this build does not know hydrates to `off` — never to a
// window nothing can compute.
// `mergeRecordingPrefs` IS the hydrate — it is the store's `merge` option — so
// it is pinned directly. zustand 5.0.15 attaches no `persist` api to the store
// (only setState / getState / getInitialState / subscribe), so its own hydrate
// cannot be re-run from out here.
{
  const base: Parameters<typeof mergeRecordingPrefs>[1] = {
    punch: 'in-out',
    roundTrip: {},
    takeMode: 'takes',
    setPunch: rp().setPunch,
    setTakeMode: rp().setTakeMode,
    setRoundTrip: rp().setRoundTrip,
    clearRoundTrip: rp().clearRoundTrip,
  };
  assert.equal(mergeRecordingPrefs({ punch: 'sideways' }, base).punch, 'off', 'an unknown persisted mode is not a mode');
  assert.equal(mergeRecordingPrefs({ punch: 42 }, base).punch, 'off');
  assert.equal(mergeRecordingPrefs(null, base).punch, 'off', 'nothing persisted is off, not undefined');
  assert.equal(mergeRecordingPrefs({}, base).punch, 'off');
  // A good one survives, and the actions on `current` are kept.
  const good = mergeRecordingPrefs({ punch: 'out' }, base);
  assert.equal(good.punch, 'out');
  assert.equal(typeof good.setPunch, 'function', 'hydrating does not drop the actions');

  // The take mode hydrates the same way, and defaults to `takes` — a build that
  // has never seen the preference records takes, not stacked clips.
  assert.equal(mergeRecordingPrefs({}, base).takeMode, 'takes');
  assert.equal(mergeRecordingPrefs(null, base).takeMode, 'takes');
  assert.equal(mergeRecordingPrefs({ takeMode: 'clips' }, base).takeMode, 'clips');
  assert.equal(mergeRecordingPrefs({ takeMode: 'stack' }, base).takeMode, 'takes', 'an unknown mode is not a mode');
  assert.equal(mergeRecordingPrefs({ takeMode: 7 }, base).takeMode, 'takes');
}

/* ------------- a second pass over a clip is a TAKE of it (#45) -------------- */

// The subject: `placeTakes` matching a pass onto the clip it lands on, through
// `lib/takePlacement`. The RULE itself is pinned in that file's own suite — what
// is pinned here is the store's application of it: which clip a pass reaches,
// what the clip looks like afterwards, and that a pass is still one undo step.

/** The clip a pass produced, with the takes fields read out. */
const takeShape = (clipId: string) => {
  const c = es().clips.find((x) => x.id === clipId)!;
  return {
    labels: (c.takes ?? []).map((t) => t.label),
    active: c.activeTakeIndex,
    startSec: c.startSec,
    durationSec: c.durationSec,
    blob: c.audioBlob,
  };
};

// First pass over an empty bar: a clip of its own, with no takes on it. Second
// pass over the same bar: appended to that clip, active, and called `Take 2`.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  assert.equal(rp().takeMode, 'takes', 'takes is the default mode');

  const first = fakeTake('trk-a', 4, 8);
  await pass(h, [first]);
  assert.equal(es().clips.length, 1, 'the first pass over an empty bar is a clip');
  const clipId = es().clips[0].id;
  assert.equal(es().clips[0].takes, undefined, 'and carries no takes until a second pass arrives');
  assert.equal(es().clips[0].label, 'Take 1');

  // Pressed from the same playhead, so the anchors agree exactly — the common
  // case, and the one with nothing to rebase.
  const second = fakeTake('trk-a', 4, 8.5);
  await pass(h, [second]);
  assert.equal(es().clips.length, 1, 'the second pass over it is a TAKE, not a second clip');
  const after = takeShape(clipId);
  assert.deepEqual(after.labels, ['Take 1', 'Take 2'], 'the clip\'s own media became take 1');
  assert.equal(after.active, 1, 'and the new pass is what the clip plays');
  assert.equal(after.blob, second.blob, 'the clip mirrors the active take\'s bytes');
  assert.equal(after.startSec, 4, 'a take does not move the clip');
  assert.equal(after.durationSec, 4, 'nor re-length it');
  assert.equal(es().clips[0].offsetIntoSource, 0, 'and reads the take from its head when the anchors agree');

  // A pass that started EARLIER than the clip: the clip keeps its own start, so
  // the take is read from half a second in. Reading it from its own head would
  // play the clip half a second early and run out half a second short.
  const third = fakeTake('trk-a', 3.5, 9);
  await pass(h, [third]);
  assert.deepEqual(takeShape(clipId).labels, ['Take 1', 'Take 2', 'Take 3'], 'the label counts THIS clip\'s takes');
  assert.equal(takeShape(clipId).active, 2);

  // The take carries the same field set a clip gets: it IS its source, read
  // from the moment the clip begins.
  const t = es().clips[0].takes![2];
  assert.equal(t.sourceDuration, 5.5, 'the take keeps its own recorded length');
  assert.equal(t.offsetIntoSource, 0.5, 'rebased onto the clip\'s head: 4 s clip, 3.5 s take');
  assert.equal(t.mimeType, 'audio/webm');
  assert.equal(t.id, third.meta.id, 'and the engine\'s take id is the take\'s id');
  // The mirror is what every path that knows nothing about takes reads.
  const mirrored = es().clips[0];
  assert.equal(mirrored.offsetIntoSource, 0.5, 'the clip plays the take from the right second');
  assert.equal(mirrored.sourceDuration, 5.5);
  assert.equal(mirrored.startSec + mirrored.durationSec, 8, 'over the clip\'s own 4 s, ending where it always did');
}

// THE OTHER DIRECTION: a pass that starts AFTER the clip does. There are no
// bytes from before the recording started, so it cannot be read as this clip —
// it lands as its own clip rather than playing the clip's head from nowhere.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  await pass(h, [fakeTake('trk-a', 4, 12)]);       // the clip: 4 → 12
  const clipId = es().clips[0].id;

  await pass(h, [fakeTake('trk-a', 6, 12)]);       // a pass starting two bars in
  assert.equal(es().clips.length, 2, 'a take that cannot cover the clip\'s head is a clip of its own');
  assert.equal(es().clips.find((c) => c.id === clipId)!.takes, undefined, 'and the clip is untouched');

  // Nor does a pass that stops short of the clip's end become a take: the tail
  // would fall silent the moment it was activated.
  await pass(h, [fakeTake('trk-a', 4, 9)]);
  assert.equal(es().clips.length, 3, 'a fragment is not a take');
  assert.equal(es().clips.find((c) => c.id === clipId)!.takes, undefined);
}

// The peaks decoded after the placement still land — on the clip, which is
// mirroring the take that was just appended.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  await pass(h, [fakeTake('trk-a', 0, 4)]);
  await pass(h, [fakeTake('trk-a', 0, 4)]);
  await flush();
  assert.equal(es().clips.length, 1);
  assert.equal(es().clips[0].peaks?.length, 2, 'the decode reaches the clip it was appended to');
}

// A pass that lands nowhere near the clip is a clip of its own — the rule is a
// match, not a magnet.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  await pass(h, [fakeTake('trk-a', 0, 4)]);
  await pass(h, [fakeTake('trk-a', 30, 34)]);
  assert.equal(es().clips.length, 2, 'two passes, two bars, two clips');
  assert.deepEqual(es().clips.map((c) => c.label), ['Take 1', 'Take 2'], 'and the session numbering still numbers them');
}

// `clips` mode is the old behaviour, exactly: every pass is its own clip.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rp().setTakeMode('clips');

  await pass(h, [fakeTake('trk-a', 4, 8)]);
  await pass(h, [fakeTake('trk-a', 4, 8)]);
  assert.equal(es().clips.length, 2, 'clips mode stacks, as every pass did before takes existed');
  assert.equal(es().clips[0].takes, undefined);
  assert.equal(es().clips[1].takes, undefined);

  rp().setTakeMode('sideways' as never);
  assert.equal(rp().takeMode, 'takes', 'an unknown mode falls back to the default');
}

// THE PUNCH CROP RUNS FIRST. The raw take spans both bars and would match the
// clip at bar 20 on its own; cropped to the window it does not come near it, so
// it lands as its own clip. Matching the uncropped span would have buried a
// punched pass inside a clip it never reached.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rp().setTakeMode('clips');
  await pass(h, [fakeTake('trk-a', 20, 24)]);   // the clip at bar 20
  assert.equal(es().clips.length, 1);
  rp().setTakeMode('takes');

  setLoop(0, 8);
  rp().setPunch('in-out');
  await pass(h, [fakeTake('trk-a', 2, 30)]);    // raw: 2 → 30; cropped: 2 → 8

  assert.equal(es().clips.length, 2, 'the cropped span is what is matched');
  const fresh = es().clips.find((c) => c.startSec === 2)!;
  assert.equal(fresh.durationSec, 6, 'and it is the cropped clip that landed');
  assert.equal(es().clips.find((c) => c.startSec === 20)!.takes, undefined, 'the far clip was never touched');
}

// A punched pass that DOES land on the clip is a take of it, cropped span and
// all — the crop decides the match, then the take carries the crop.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  rp().setTakeMode('clips');
  await pass(h, [fakeTake('trk-a', 4, 10)]);
  rp().setTakeMode('takes');
  const clipId = es().clips[0].id;

  setLoop(4, 10);
  rp().setPunch('in-out');
  await pass(h, [fakeTake('trk-a', 2, 12)]);    // cropped to 4 → 10

  assert.equal(es().clips.length, 1, 'the punched pass is a take of the clip it punched into');
  const t = es().clips[0].takes![1];
  assert.equal(t.offsetIntoSource, 2, 'the take carries the crop as an offset, keeping its bytes');
  assert.equal(t.sourceDuration, 10, 'and the whole pass as its source');
  assert.equal(takeShape(clipId).durationSec, 6, 'the clip itself is untouched');
}

// A MIDI clip is never a take target: the pass lands beside it.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  const midiId = es().addClipToTrack({
    trackId: 'trk-a',
    label: 'Roll',
    audioBlob: new Blob(['midi'], { type: 'audio/wav' }),
    mimeType: 'audio/wav',
    sourceDuration: 8,
    offsetIntoSource: 0,
    durationSec: 8,
    startSec: 0,
    color: '#000000',
    sourceKind: 'piano-roll',
  });
  // The track has no instrument and its LATEST clip decides — so a pass onto it
  // is still the mic engine's. (`capturesMidi` would hand the track to the MIDI
  // capture otherwise, and no mic take would exist to place.)
  await pass(h, [fakeTake('trk-a', 0, 8)]);

  assert.equal(es().clips.length, 2, 'the audio pass does not become a take of a rendered roll');
  assert.equal(es().clips.find((c) => c.id === midiId)!.takes, undefined);
}

// A FROZEN track's clips are one printed stem, and unfreezing replaces it with
// the originals it was printed from — a take hung off the stem would go with it.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  es().freezeTrack('trk-a', { audioBlob: new Blob(['stem'], { type: 'audio/wav' }), durationSec: 8 });
  assert.equal(es().clips.length, 1, 'the stem is the track\'s one clip');
  const stemId = es().clips[0].id;

  await pass(h, [fakeTake('trk-a', 0, 8)]);

  assert.equal(es().clips.length, 2, 'the pass lands beside the stem, not inside it');
  assert.equal(es().clips.find((c) => c.id === stemId)!.takes, undefined, 'the stem is untouched');
  // (`unfreezeTrack` replaces every clip on the track with the originals it
  // printed, so a pass recorded while frozen is dropped either way — that is
  // the freeze contract and it predates takes. What this pins is that the take
  // model is not what loses it: the stem never becomes a take list.)
}

// A COMPED clip does not play its active take — it plays its comp — so an
// append that only activated would file the pass away inaudibly. The comp's
// LAST region is retargeted onto the new take, and the user's own boundary
// stays where they put it.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  await pass(h, [fakeTake('trk-a', 0, 8)]);
  const clipId = es().clips[0].id;
  await pass(h, [fakeTake('trk-a', 0, 8)]);        // take 2
  assert.equal(es().clips[0].takes?.length, 2);

  // A comp of two regions: the head plays the active take, and from 4 s it
  // plays take 1.
  es().setCompRegionAt(clipId, 4, 0);
  const comp = es().clips[0].comp!;
  assert.equal(comp.length, 2, 'the fixture is a real comp');
  assert.equal(comp[1].startSec, 4);

  const undoDepth = () => (useEditorStore.getState() as unknown as { _undo: unknown[] })._undo.length;
  const before = undoDepth();
  await pass(h, [fakeTake('trk-a', 0, 8)]);        // take 3

  const after = es().clips[0];
  assert.equal(after.takes?.length, 3, 'the pass is still a take of the clip');
  assert.equal(after.comp?.length, 2, 'the comp survives, boundary and all');
  assert.equal(after.comp![1].startSec, 4, 'at the second the user put it');
  assert.equal(after.comp![1].takeIndex, 2, 'and its last region plays the pass that just landed');
  // `addTakeToClip` and `setCompRegionAt` each open an undo step of their own
  // (T46H): `placeTakes` wraps the whole pass in `editorStore.undoGroup` so a
  // pass onto a COMPED clip is still one undo — it takes the append and the
  // comp retarget off together, never leaving the comp on the old take.
  assert.equal(undoDepth(), before + 1, 'the take append and comp retarget are one undo step');
}

// A STRETCHED clip reads more source seconds than its timeline span, so a pass
// that covers its span does not cover what it reads: it lands as its own clip.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  await pass(h, [fakeTake('trk-a', 0, 8)]);
  const clipId = es().clips[0].id;
  es().updateClip(clipId, { timeStretchRate: 2 });
  await pass(h, [fakeTake('trk-a', 0, 8)]);
  assert.equal(es().clips.length, 2, 'a stretched clip is never a take target');
  assert.equal(es().clips[0].takes?.length ?? 0, 0, 'and gained no take');
}

// THE DECODE RACE. The peaks of a pass arrive after the placement, and by then
// a LATER pass may have appended and activated a take of its own: the write
// would hang this pass's peaks on that pass's take, and the length repair would
// re-length a clip it no longer measured.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  await pass(h, [fakeTake('trk-a', 0, 8)]);
  const clipId = es().clips[0].id;
  const settled = es().clips[0].peaks;
  assert.equal(settled?.length, 2, 'the first pass decoded normally');

  // The second pass's decode is held open.
  let release: ((v: { peaks: Float32Array; duration: number }) => void) | null = null;
  setRecordingDeps({
    computePeaks: () => new Promise((res) => { release = res; }),
  });
  await pass(h, [fakeTake('trk-a', 0, 8)]);        // take 2, decode pending
  assert.equal(es().clips[0].takes?.length, 2);

  // A THIRD pass lands and activates its own take while that decode is open.
  setRecordingDeps({ computePeaks: async () => ({ peaks: new Float32Array([0.9]), duration: 8 }) });
  await pass(h, [fakeTake('trk-a', 0, 8)]);        // take 3
  assert.equal(es().clips[0].takes?.length, 3);
  assert.equal(es().clips[0].activeTakeIndex, 2);
  const takeThreePeaks = es().clips[0].takes![2].peaks;

  // Now let the second pass's decode finish. It must write nothing.
  release!({ peaks: new Float32Array([0.1, 0.2, 0.3]), duration: 99 });
  await flush();
  await flush();
  const clip = es().clips.find((c) => c.id === clipId)!;
  assert.equal(clip.durationSec, 8, 'the stale decode does not re-length the clip');
  assert.equal(clip.takes![2].peaks, takeThreePeaks, 'nor overwrite the active take\'s peaks');
  assert.equal(clip.takes!.length, 3);
}

// ONE UNDO STEP, and it restores the clip as it was before the pass: the takes
// are gone and the clip is playing its own media again.
{
  const h = harness(['trk-a']);
  es().updateTrack('trk-a', { armed: true });
  const undoDepth = () => (useEditorStore.getState() as unknown as { _undo: unknown[] })._undo.length;

  const first = fakeTake('trk-a', 4, 8);
  await pass(h, [first]);
  const clipId = es().clips[0].id;
  const beforeSecondPass = undoDepth();

  await pass(h, [fakeTake('trk-a', 4, 8)]);
  assert.equal(undoDepth(), beforeSecondPass + 1, 'a pass that becomes a take is one undo step');
  assert.equal(es().clips[0].takes?.length, 2);

  es().undo();
  const back = es().clips.find((c) => c.id === clipId)!;
  assert.equal(es().clips.length, 1, 'the clip is still there — it was never replaced');
  assert.equal(back.takes, undefined, 'and the take the pass added is gone');
  assert.equal(back.audioBlob, first.blob, 'the clip plays its own media again');
  assert.equal(back.startSec, 4);
  assert.equal(back.durationSec, 4);
  assert.equal(es().tracks.find((t) => t.id === 'trk-a')?.armed, true, 'and the arm is left alone');
}

// TWO tracks, one press, both landing on clips that are already there.
//
// `addTakeToClip` opens an undo step of its own (`editorStore.ts`, the takes
// actions all do), so without a group a pass that appends to TWO clips would
// leave two steps where a pass that lands two new CLIPS leaves one (T46H).
// `placeTakes` wraps the pass in `editorStore.undoGroup`, so it is one step
// here too — one undo restores both clips together.
{
  const h = harness(['trk-a', 'trk-b']);
  es().updateTrack('trk-a', { armed: true });
  es().updateTrack('trk-b', { armed: true });
  const undoDepth = () => (useEditorStore.getState() as unknown as { _undo: unknown[] })._undo.length;

  await pass(h, [fakeTake('trk-a', 4, 8), fakeTake('trk-b', 4, 8)]);
  assert.equal(es().clips.length, 2, 'the first press is two clips');
  const before = undoDepth();

  await pass(h, [fakeTake('trk-a', 4, 8), fakeTake('trk-b', 4, 8)]);
  assert.equal(es().clips.length, 2, 'the second press adds no clips');
  assert.deepEqual(es().clips.map((c) => c.takes?.length), [2, 2], 'a take on each');
  assert.equal(undoDepth(), before + 1, 'both appended takes are one undo step');

  es().undo();
  assert.deepEqual(es().clips.map((c) => c.takes), [undefined, undefined], 'and one undo restores every clip');
  assert.equal(es().clips.length, 2, 'without losing the clips they were appended to');
}

resetRecording();
console.log('recordingStore: ok');
