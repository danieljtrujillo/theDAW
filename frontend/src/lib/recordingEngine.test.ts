/**
 * recordingEngine — the take engine driven entirely by fakes: a hand-advanced
 * transport clock, fake `MediaRecorder`s whose `onstart` / `ondataavailable` /
 * `onstop` the test fires by hand, a fake `getUserMedia` that counts its calls,
 * and a fake repeating timer for the level feed. No microphone is opened and no
 * DOM is required.
 *
 * The load-bearing assertion is the D13 one: the clock is advanced BETWEEN
 * `start()` and the recorder's `onstart`, and the take's `startSec` has to be
 * the later value. A take stamped when `start()` was called drifts by the whole
 * device-open latency, which is exactly the bug the engine exists to fix.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RECORDING_MIME,
  DEFAULT_START_TIMEOUT_MS,
  RECORDING_LEVEL_INTERVAL_MS,
  RECORDING_MIME_CANDIDATES,
  RECORDING_TIMESLICE_MS,
  RecordingError,
  chooseMime,
  createRecordingEngine,
  levelFrame,
  mergeChunks,
  micConstraints,
  takeClipPlacement,
  type LevelFrame,
  type MediaRecorderLike,
  type RecordingDeps,
  type Take,
} from './recordingEngine.ts';

const near = (a: number, b: number, msg: string): void => {
  assert.ok(Math.abs(a - b) < 1e-12, `${msg}: ${a} !== ${b}`);
};

/* ------------------------------- pure helpers ------------------------------ */

// chooseMime walks the candidates in order and returns the first the UA admits.
{
  assert.equal(chooseMime(() => true), RECORDING_MIME_CANDIDATES[0]);
  assert.equal(chooseMime((m) => m === 'audio/ogg'), 'audio/ogg');
  assert.equal(chooseMime((m) => m === 'audio/mp4'), 'audio/mp4');
  assert.equal(chooseMime(() => false), '', 'no supported type is an empty string, not a guess');
  assert.equal(
    chooseMime(() => { throw new Error('isTypeSupported blew up'); }),
    '',
    'a throwing predicate is survived, as MicRecorder survives it',
  );
  // A predicate that throws for one candidate still reaches the next.
  assert.equal(
    chooseMime((m) => {
      if (m.includes('webm')) throw new Error('nope');
      return m === 'audio/ogg;codecs=opus';
    }),
    'audio/ogg;codecs=opus',
  );
}

// The preference list IS MicRecorder's. Read out of the component rather than
// imported from it, so the two cannot drift apart silently: a recorder that
// negotiates a different container than the mic panel would hand the backend
// bytes it was not asked to decode.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'components', 'audio', 'MicRecorder.tsx'), 'utf8');
  const block = src.match(/const candidates = \[([\s\S]*?)\];/);
  assert.ok(block, 'MicRecorder.tsx no longer declares a `candidates` mime list');
  const micList = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(micList.length >= 5, `parsed too few mimes out of MicRecorder: ${micList.length}`);
  assert.deepEqual(
    [...RECORDING_MIME_CANDIDATES],
    micList,
    'the engine\'s mime preference order must equal MicRecorder\'s, in order',
  );
}

// micConstraints: the memo profile by default (MicRecorder's), the MUSICAL one
// on request. A host recording a performance has to be able to turn the three
// speech processors OFF — AGC alone rides a crescendo flat — and the device id
// stays a SOFT constraint in both profiles.
{
  const audioOf = (c: MediaStreamConstraints): Record<string, unknown> =>
    c.audio as unknown as Record<string, unknown>;

  const memo = audioOf(micConstraints());
  assert.equal(memo.echoCancellation, true);
  assert.equal(memo.noiseSuppression, true);
  assert.equal(memo.autoGainControl, true);
  assert.equal('deviceId' in memo, false, 'no device id asked for is no deviceId key');

  // The bare-string form is the device id, which is what openGroup passes.
  const memoDev = audioOf(micConstraints('mic-7'));
  assert.equal(memoDev.deviceId, 'mic-7');
  assert.equal(memoDev.autoGainControl, true, 'the default profile is unchanged by the options form');

  const musical = audioOf(micConstraints({ musical: true }));
  assert.equal(musical.echoCancellation, false);
  assert.equal(musical.noiseSuppression, false);
  assert.equal(musical.autoGainControl, false);

  const musicalDev = audioOf(micConstraints({ deviceId: 'mic-7', musical: true }));
  assert.equal(musicalDev.deviceId, 'mic-7', 'the device id survives the musical profile');
  assert.equal(musicalDev.noiseSuppression, false);

  // `{ musical: false }` is the memo profile spelled out, not a third thing.
  assert.deepEqual(audioOf(micConstraints({ musical: false })), memo);
}

// mergeChunks is the blob assembly MicRecorder does in its own onstop.
{
  const blob = mergeChunks(['ab', 'c'], 'audio/webm');
  assert.equal(blob.size, 3);
  assert.equal(blob.type, 'audio/webm');
  assert.equal(mergeChunks([], 'audio/webm').size, 0);
  assert.equal(mergeChunks(['x'], '').type, '', 'an unknown mime is left unset, not invented');
}

// levelFrame: peak is the largest magnitude, rms the root mean square.
{
  assert.deepEqual(levelFrame(new Float32Array([])), { peak: 0, rms: 0 });
  const f = levelFrame(new Float32Array([0, 0.5, -1, 0.5]));
  near(f.peak, 1, 'peak is the magnitude, so the -1 wins');
  near(f.rms, Math.sqrt(0.375), 'rms of [0, .5, -1, .5]');
  // A non-finite sample (a glitching input) counts as silence rather than
  // poisoning the whole frame with NaN.
  const g = levelFrame(new Float32Array([Number.NaN, 0.5]));
  near(g.peak, 0.5, 'NaN does not become the peak');
  near(g.rms, Math.sqrt(0.125), 'NaN counts as zero in the mean');
}

// takeClipPlacement turns a transport-anchored take into clip coordinates.
{
  const take: Take = {
    meta: { id: 't', trackId: 'trk-1', startSec: 12, endSec: 20, sampleRate: 48000, mime: 'audio/webm' },
    blob: new Blob(['x']),
  };
  assert.deepEqual(takeClipPlacement(take), {
    trackId: 'trk-1',
    startSec: 12,
    durationSec: 8,
    offsetIntoSource: 0,
  });
  assert.deepEqual(takeClipPlacement(take, { latencyCompSec: 0.25 }), {
    trackId: 'trk-1',
    startSec: 11.75,
    durationSec: 8,
    offsetIntoSource: 0,
  }, 'latency comp slides the clip EARLIER by the round trip');
  assert.deepEqual(takeClipPlacement(take, { latencyCompSec: 30 }), {
    trackId: 'trk-1',
    startSec: 0,
    durationSec: 8,
    offsetIntoSource: 0,
  }, 'the timeline has no negative time, so the shift clamps at zero');
  const open: Take = { meta: { ...take.meta, endSec: undefined }, blob: take.blob };
  assert.equal(takeClipPlacement(open).durationSec, 0, 'a take with no end has no length yet');
}

/* --------------------------------- the fakes -------------------------------- */

class FakeTrack {
  stopped = 0;
  stop(): void { this.stopped += 1; }
  getSettings(): { sampleRate: number } { return { sampleRate: 48000 }; }
}

class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] { return this.tracks; }
  getAudioTracks(): FakeTrack[] { return this.tracks; }
}

class FakeRecorder implements MediaRecorderLike {
  state = 'inactive';
  mimeType: string;
  onstart: ((ev?: unknown) => void) | null = null;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  timeslice: number | undefined = undefined;
  stopCalls = 0;
  readonly stream: unknown;

  constructor(stream: unknown, mime: string) {
    this.stream = stream;
    this.mimeType = mime;
  }

  start(timesliceMs?: number): void {
    this.state = 'recording';
    this.timeslice = timesliceMs;
  }

  stop(): void {
    this.stopCalls += 1;
    this.state = 'inactive';
  }

  /* --- drivers the test uses to play the UA's part --- */
  fireStart(): void { this.onstart?.(); }
  push(text: string): void { this.ondataavailable?.({ data: new Blob([text]) }); }
  fireStop(): void { this.onstop?.(); }
  fireError(err: unknown): void { this.onerror?.({ error: err }); }
}

interface HarnessOpts {
  getUserMedia?: (c: unknown) => Promise<MediaStream>;
  makeRecorder?: (stream: MediaStream, mime: string) => MediaRecorderLike;
  levels?: () => LevelFrame;
  /** Container the fake recorders claim to have negotiated. */
  recorderMime?: string;
  startTimeoutMs?: number;
}

function harness(opts: HarnessOpts = {}) {
  const clock = { t: 0 };
  const recs: FakeRecorder[] = [];
  const streams: FakeStream[] = [];
  const gumCalls: unknown[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const analysers: { disposed: number }[] = [];
  let nextTimerId = 1;

  const deps: RecordingDeps = {
    now: () => clock.t,
    getUserMedia: opts.getUserMedia ?? (async (constraints: unknown) => {
      gumCalls.push(constraints);
      const s = new FakeStream();
      streams.push(s);
      return s as unknown as MediaStream;
    }),
    makeRecorder: opts.makeRecorder ?? ((stream: MediaStream, mime: string) => {
      const r = new FakeRecorder(stream, opts.recorderMime ?? mime);
      recs.push(r);
      return r;
    }),
    startTimeoutMs: opts.startTimeoutMs,
    makeAnalyser: () => {
      const a = { disposed: 0 };
      analysers.push(a);
      return {
        levels: opts.levels ?? (() => ({ peak: 0.5, rms: 0.25 })),
        dispose: () => { a.disposed += 1; },
      };
    },
    setTimer: (fn: () => void, ms: number) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id: number) => { timers.delete(id); },
  };

  /** Only the level poll — `start()` also registers a one-shot deadline timer
   *  on the same seam, and the two are told apart by their period. */
  const levelTimers = (): { fn: () => void; ms: number }[] =>
    [...timers.values()].filter((t) => t.ms === RECORDING_LEVEL_INTERVAL_MS);
  /** The `onstart` deadline, while `start()` is in flight. */
  const deadlineTimers = (): { fn: () => void; ms: number }[] =>
    [...timers.values()].filter((t) => t.ms !== RECORDING_LEVEL_INTERVAL_MS);

  return {
    clock, recs, streams, gumCalls, timers, analysers, deps,
    levelTimers, deadlineTimers,
    engine: createRecordingEngine(deps),
  };
}

/** One macrotask, long enough for the engine's awaited getUserMedia to land. */
const flush = (): Promise<void> => new Promise((r) => { setTimeout(r, 0); });

/* --------------------------------- arming ---------------------------------- */

{
  const h = harness();
  assert.deepEqual(h.engine.armed(), []);
  assert.equal(h.engine.isRecording(), false);
  h.engine.arm('trk-a', { kind: 'mic' });
  h.engine.arm('trk-b', { kind: 'mic', deviceId: 'usb-1' });
  assert.deepEqual(h.engine.armed(), ['trk-a', 'trk-b'], 'armed() keeps arming order');
  h.engine.arm('trk-a', { kind: 'mic', deviceId: 'usb-2' });
  assert.deepEqual(h.engine.armed(), ['trk-a', 'trk-b'], 're-arming a track replaces its source');
  h.engine.disarm('trk-a');
  assert.deepEqual(h.engine.armed(), ['trk-b']);
  h.engine.disarm('nobody');
  assert.deepEqual(h.engine.armed(), ['trk-b'], 'disarming an unarmed track is a no-op');
}

// Disarming the last track on a caller-supplied stream drops the engine's
// reference to it — and re-arming the same stream still groups correctly, so
// the prune cannot cost a shared input its shared recorder.
{
  const shared = new FakeStream() as unknown as MediaStream;
  const h = harness();
  h.engine.arm('trk-a', { kind: 'stream', stream: shared });
  h.engine.arm('trk-b', { kind: 'stream', stream: shared });
  h.engine.disarm('trk-a');
  h.engine.disarm('trk-b'); // the last one: the key is dropped here
  h.engine.arm('trk-c', { kind: 'stream', stream: shared });
  h.engine.arm('trk-d', { kind: 'stream', stream: shared });

  const started = h.engine.start();
  await flush();
  assert.equal(h.recs.length, 2, 'a recorder each');
  assert.equal(h.recs[0].stream, h.recs[1].stream, 'still ONE group for the one stream');
  h.recs.forEach((r) => { r.fireStart(); });
  await started;
  const stopping = h.engine.stop();
  h.recs.forEach((r) => { r.fireStop(); });
  assert.equal((await stopping).length, 2);
}

/* ------------------- D13: startSec is stamped at onstart ------------------- */

{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  h.engine.arm('trk-b', { kind: 'mic' });

  h.clock.t = 10;
  const started = h.engine.start();
  await flush();

  assert.equal(h.gumCalls.length, 1, 'two tracks on the same mic open the device ONCE');
  assert.equal(h.recs.length, 2, 'but get a recorder each');
  assert.equal(h.recs[0].stream, h.recs[1].stream, 'both recorders share the one stream');
  assert.equal(h.recs[0].timeslice, RECORDING_TIMESLICE_MS, 'chunked, as MicRecorder chunks');

  // The recorders are built and `start()`ed, but their `start` events are
  // queued tasks that have not run yet — and the transport moved two seconds
  // in the meantime. A take stamped at the call site would claim 10; the take
  // must claim 12.
  h.clock.t = 12;
  h.recs.forEach((r) => { r.fireStart(); });
  await started;

  assert.equal(h.engine.isRecording(), true);

  h.recs[0].push('aaa');
  h.recs[1].push('bb');

  h.clock.t = 20;
  const stopping = h.engine.stop();
  h.clock.t = 21; // ... and the stop costs a second too
  h.recs.forEach((r) => { r.push('!'); r.fireStop(); });
  const takes = await stopping;

  assert.equal(takes.length, 2);
  assert.deepEqual(takes.map((t) => t.meta.trackId), ['trk-a', 'trk-b']);
  assert.deepEqual(
    takes.map((t) => t.meta.startSec),
    [12, 12],
    'startSec is deps.now() AT onstart — not when start() was called',
  );
  assert.deepEqual(
    takes.map((t) => t.meta.endSec),
    [21, 21],
    'endSec is deps.now() at onstop, for the same reason',
  );
  assert.deepEqual(takes.map((t) => t.blob.size), [4, 3], 'every chunk lands in the take');
  assert.equal(await takes[0].blob.text(), 'aaa!');
  assert.deepEqual(takes.map((t) => t.meta.sampleRate), [48000, 48000]);
  assert.deepEqual(
    takes.map((t) => t.meta.mime),
    [DEFAULT_RECORDING_MIME, DEFAULT_RECORDING_MIME],
    'with no mime negotiated the take still names a container',
  );
  assert.notEqual(takes[0].meta.id, takes[1].meta.id, 'take ids are distinct');
  assert.equal(h.engine.isRecording(), false);
  assert.equal(h.streams[0].tracks[0].stopped, 1, 'the mic we opened is released on stop');
  assert.equal(h.analysers[0].disposed, 1, 'and its analyser with it');
}

/* ------------- distinct mic sources DO open the device twice --------------- */

{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic', deviceId: 'usb-1' });
  h.engine.arm('trk-b', { kind: 'mic', deviceId: 'usb-2' });
  const started = h.engine.start();
  await flush();
  assert.equal(h.gumCalls.length, 2, 'two different devices are two opens');
  assert.equal(h.recs.length, 2);
  assert.notEqual(h.recs[0].stream, h.recs[1].stream);
  h.recs.forEach((r) => { r.fireStart(); });
  await started;
  const stopping = h.engine.stop();
  h.recs.forEach((r) => { r.fireStop(); });
  await stopping;
  assert.deepEqual(h.streams.map((s) => s.tracks[0].stopped), [1, 1]);
}

/* -------------------- a caller-owned stream is not ours -------------------- */

{
  const mine = new FakeStream();
  const h = harness();
  h.engine.arm('trk-a', { kind: 'stream', stream: mine as unknown as MediaStream });
  const started = h.engine.start();
  await flush();
  assert.equal(h.gumCalls.length, 0, 'a supplied stream is never re-opened');
  h.recs[0].fireStart();
  await started;
  const stopping = h.engine.stop();
  h.recs[0].fireStop();
  const takes = await stopping;
  assert.equal(takes.length, 1);
  assert.equal(mine.tracks[0].stopped, 0, 'the engine must not stop a stream it did not open');
}

/* ------------------- stop() waits for EVERY recorder ----------------------- */

{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  h.engine.arm('trk-b', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs.forEach((r) => { r.fireStart(); });
  await started;

  let settled = false;
  const stopping = h.engine.stop().then((t) => { settled = true; return t; });
  assert.deepEqual(h.recs.map((r) => r.stopCalls), [1, 1], 'stop() stops them all at once');
  h.recs[0].fireStop();
  await flush();
  assert.equal(settled, false, 'one recorder still running means stop() has not resolved');
  h.recs[1].fireStop();
  const takes = await stopping;
  assert.equal(settled, true);
  assert.equal(takes.length, 2);
}

/* ------------- start() is not re-entrant: the second press is 'busy' ------- */

{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  const first = h.engine.start();
  // The press lands while the first start is still awaiting getUserMedia — the
  // window in which `recording` was still false and both opens used to go
  // through, orphaning the loser's stream with the mic left lit.
  await assert.rejects(
    () => h.engine.start(),
    (e: unknown) => {
      assert.ok(e instanceof RecordingError);
      assert.equal(e.code, 'busy');
      return true;
    },
    'an overlapping start() must be refused, not doubled',
  );
  await flush();
  assert.equal(h.gumCalls.length, 1, 'and it must not have opened the device again');
  assert.equal(h.recs.length, 1);
  h.recs[0].fireStart();
  await first;

  // Still refused once it is actually running.
  await assert.rejects(
    () => h.engine.start(),
    (e: unknown) => (e as RecordingError).code === 'busy',
  );
  assert.equal(h.gumCalls.length, 1);

  const stopping = h.engine.stop();
  h.recs[0].fireStop();
  await stopping;
  // ... and allowed again afterwards.
  const again = h.engine.start();
  await flush();
  h.recs[1].fireStart();
  await again;
  assert.equal(h.gumCalls.length, 2);
  const last = h.engine.stop();
  h.recs[1].fireStop();
  await last;
}

// A failed start clears the flag too, or the engine would be wedged at 'busy'.
{
  const h = harness({ makeRecorder: () => { throw new Error('no codec'); } });
  h.engine.arm('trk-a', { kind: 'mic' });
  await assert.rejects(() => h.engine.start(), (e: unknown) => (e as RecordingError).code === 'unsupported');
  await assert.rejects(
    () => h.engine.start(),
    (e: unknown) => (e as RecordingError).code === 'unsupported',
    'the second attempt fails on its own merits, not on a stuck busy flag',
  );
}

/* --------------- the onstart wait is bounded, not forever ----------------- */

{
  assert.equal(DEFAULT_START_TIMEOUT_MS, 5000);

  const h = harness({ startTimeoutMs: 250 });
  h.engine.arm('trk-a', { kind: 'mic' });
  h.engine.arm('trk-b', { kind: 'mic' });
  const started = h.engine.start();
  await flush();

  const deadlines = h.deadlineTimers();
  assert.equal(deadlines.length, 1, 'one deadline covers the whole start');
  assert.equal(deadlines[0].ms, 250, 'the dep sets the period');

  h.recs[0].fireStart(); // one comes up, the other never does
  deadlines[0].fn();

  await assert.rejects(
    () => started,
    (e: unknown) => {
      assert.ok(e instanceof RecordingError);
      assert.equal(e.code, 'unsupported');
      assert.ok(e.message.includes('trk-b'), `the stalled track is named: ${e.message}`);
      assert.ok(!e.message.includes('trk-a'), 'the one that started is not blamed');
      return true;
    },
    'a start event that never lands must not leave start() pending forever',
  );
  assert.equal(h.engine.isRecording(), false);
  assert.equal(h.streams[0].tracks[0].stopped, 1, 'and the mic is released');
  assert.equal(h.timers.size, 0, 'the deadline is cleared behind itself');
}

// When the recorders do start, the deadline is cleared rather than left armed.
{
  const h = harness({ startTimeoutMs: 250 });
  h.engine.arm('trk-a', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  assert.equal(h.deadlineTimers().length, 1);
  h.recs[0].fireStart();
  await started;
  assert.equal(h.deadlineTimers().length, 0, 'a won race disarms the deadline');
  const stopping = h.engine.stop();
  h.recs[0].fireStop();
  await stopping;
}

/* ------- stop() is safe when a recorder has already gone inactive ---------- */

{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs[0].fireStart();
  await started;
  // The UA ended the stream by itself: onstop already fired, state inactive.
  h.recs[0].push('done');
  h.recs[0].fireStop();
  const takes = await h.engine.stop();
  assert.equal(h.recs[0].stopCalls, 0, 'an inactive recorder is not stopped again');
  assert.equal(takes.length, 1);
  assert.equal(await takes[0].blob.text(), 'done');
  assert.equal(h.engine.isRecording(), false);
}

// stop() with nothing running is an empty list, not a throw.
{
  const h = harness();
  assert.deepEqual(await h.engine.stop(), []);
}

// Inactive but NEVER settled — capture ended without a `stop` event, so no
// further event is coming. stop() has to end the take itself or it hangs.
{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs[0].fireStart();
  await started;
  h.recs[0].push('partial');
  h.recs[0].state = 'inactive'; // the UA gave up; no onstop will follow

  h.clock.t = 9;
  const takes = await Promise.race([
    h.engine.stop(),
    new Promise<never>((_r, rej) => { setTimeout(() => rej(new Error('stop() hung')), 250); }),
  ]);
  assert.equal(h.recs[0].stopCalls, 0, 'an inactive recorder is not stopped again');
  assert.equal(takes.length, 1);
  assert.equal(await takes[0].blob.text(), 'partial', 'whatever was gathered is kept');
  assert.equal(takes[0].meta.endSec, 9);
  assert.equal(h.engine.isRecording(), false);
}

// stop() throwing (InvalidStateError) settles the take the same way.
{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  const rec = h.recs[0];
  rec.fireStart();
  await started;
  rec.push('half');
  rec.stop = () => { throw Object.assign(new Error('already stopped'), { name: 'InvalidStateError' }); };

  const takes = await Promise.race([
    h.engine.stop(),
    new Promise<never>((_r, rej) => { setTimeout(() => rej(new Error('stop() hung')), 250); }),
  ]);
  assert.equal(takes.length, 1);
  assert.equal(await takes[0].blob.text(), 'half');
}

/* ------------- a self-terminated recording stops being a recording --------- */

{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  h.engine.arm('trk-b', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs.forEach((r) => { r.fireStart(); });
  await started;
  assert.equal(h.levelTimers().length, 1);

  h.recs[0].fireStop();
  assert.equal(h.engine.isRecording(), true, 'one track ending is not the end of the recording');
  assert.equal(h.levelTimers().length, 1, 'the other track is still being metered');

  h.recs[1].fireStop(); // the stream vanished; nobody called stop()
  assert.equal(h.engine.isRecording(), false, 'with every take settled, it is not recording');
  assert.equal(h.levelTimers().length, 0, 'and nothing is left polling a dead input');

  // stop() after the fact still hands back both takes.
  const takes = await h.engine.stop();
  assert.equal(takes.length, 2);
}

/* ---------- a fault after onstart rides on the take, undropped ------------- */

{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs[0].fireStart();
  await started;

  h.recs[0].push('before');
  const fault = Object.assign(new Error('track count changed'), { name: 'InvalidModificationError' });
  h.recs[0].fireError(fault); // mid-take: the spec still flushes and stops
  const stopping = h.engine.stop();
  h.recs[0].push('after');
  h.recs[0].fireStop();
  const takes = await stopping;

  assert.equal(takes.length, 1, 'a faulted take is still delivered');
  assert.equal(await takes[0].blob.text(), 'beforeafter', 'with everything that was gathered');
  const err = takes[0].meta.error;
  assert.ok(err instanceof RecordingError, 'the fault is on the take, not dropped');
  assert.equal(err.code, 'unsupported');
  assert.equal(
    (err.cause as { error?: unknown }).error,
    fault,
    'the originating DOMException is reachable from the take',
  );
  assert.ok(err.message.includes('mid-take'), `message says when: ${err.message}`);
}

// A clean take carries no error field at all.
{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs[0].fireStart();
  await started;
  const stopping = h.engine.stop();
  h.recs[0].fireStop();
  const takes = await stopping;
  assert.equal('error' in takes[0].meta, false, 'no fault, no field');
}

/* ------- the negotiated container reaches the take's meta ----------------- */

{
  const h = harness({ recorderMime: 'audio/ogg;codecs=opus' });
  h.engine.arm('trk-a', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs[0].fireStart();
  await started;
  const stopping = h.engine.stop();
  h.recs[0].push('x');
  h.recs[0].fireStop();
  const takes = await stopping;
  assert.equal(takes[0].meta.mime, 'audio/ogg;codecs=opus', 'the UA\'s own mimeType wins');
  assert.equal(takes[0].blob.type, 'audio/ogg;codecs=opus', 'and is what the blob is tagged with');
  assert.notEqual(takes[0].meta.mime, DEFAULT_RECORDING_MIME);
}

/* --------------------------- the three typed errors ------------------------ */

{
  const h = harness();
  await assert.rejects(
    () => h.engine.start(),
    (e: unknown) => {
      assert.ok(e instanceof RecordingError);
      assert.equal(e.code, 'nothing-armed');
      return true;
    },
    'starting with no armed track is an error, never a silent no-op',
  );
  assert.equal(h.engine.isRecording(), false);
}

{
  const denial = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
  const h = harness({ getUserMedia: () => Promise.reject(denial) });
  h.engine.arm('trk-a', { kind: 'mic' });
  await assert.rejects(
    () => h.engine.start(),
    (e: unknown) => {
      assert.ok(e instanceof RecordingError);
      assert.equal(e.code, 'permission');
      assert.equal((e as RecordingError).cause, denial, 'the original failure is not swallowed');
      assert.ok(e.message.includes('NotAllowedError'), `message names the cause: ${e.message}`);
      return true;
    },
  );
  assert.equal(h.engine.isRecording(), false);
}

// A machine with no microphone is not a user who said no. Telling that user to
// grant permission is a dead end, so it is `unsupported` — the same reading
// `micErrors.describeMicFailure` takes when it marks the case benign.
{
  const missing = Object.assign(new Error('Requested device not found'), { name: 'NotFoundError' });
  const h = harness({ getUserMedia: () => Promise.reject(missing) });
  h.engine.arm('trk-a', { kind: 'mic' });
  await assert.rejects(
    () => h.engine.start(),
    (e: unknown) => {
      assert.ok(e instanceof RecordingError);
      assert.equal(e.code, 'unsupported', 'no mic at all is not a denial');
      assert.equal((e as RecordingError).cause, missing);
      assert.ok(e.message.includes('NotFoundError'), `message names the cause: ${e.message}`);
      return true;
    },
  );
}

// Likewise the OS holding the device, and a device filter nothing matches.
{
  for (const name of ['NotReadableError', 'OverconstrainedError']) {
    const err = Object.assign(new Error(name), { name });
    const h = harness({ getUserMedia: () => Promise.reject(err) });
    h.engine.arm('trk-a', { kind: 'mic' });
    await assert.rejects(
      () => h.engine.start(),
      (e: unknown) => {
        assert.equal((e as RecordingError).code, 'unsupported', `${name} is not a denial`);
        return true;
      },
    );
  }
}

{
  const boom = new Error('MediaRecorder: mime not supported');
  const h = harness({ makeRecorder: () => { throw boom; } });
  h.engine.arm('trk-a', { kind: 'mic' });
  await assert.rejects(
    () => h.engine.start(),
    (e: unknown) => {
      assert.ok(e instanceof RecordingError);
      assert.equal(e.code, 'unsupported');
      assert.equal((e as RecordingError).cause, boom);
      return true;
    },
  );
  assert.equal(h.engine.isRecording(), false);
  assert.equal(h.streams[0].tracks[0].stopped, 1, 'a failed start still releases the mic');
}

// An error event before the recorder ever starts rejects start() rather than
// hanging on an onstart that will never come.
{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs[0].fireError(Object.assign(new Error('recording disallowed'), { name: 'SecurityError' }));
  await assert.rejects(
    () => started,
    (e: unknown) => {
      assert.ok(e instanceof RecordingError);
      assert.equal(e.code, 'permission', 'a SecurityError on the recorder is a permission failure');
      return true;
    },
  );
  assert.equal(h.engine.isRecording(), false);
}

{
  const h = harness();
  h.engine.arm('trk-a', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs[0].fireError(Object.assign(new Error('codec fell over'), { name: 'UnknownError' }));
  await assert.rejects(
    () => started,
    (e: unknown) => {
      assert.ok(e instanceof RecordingError);
      assert.equal(e.code, 'unsupported', 'any other pre-start recorder error is unsupported');
      return true;
    },
  );
}

/* ------------------------------- the level feed ---------------------------- */

{
  assert.ok(
    RECORDING_LEVEL_INTERVAL_MS > 0 && RECORDING_LEVEL_INTERVAL_MS <= 50,
    `the level feed must run at 20 Hz or better; interval is ${RECORDING_LEVEL_INTERVAL_MS}ms`,
  );

  let n = 0;
  const h = harness({ levels: () => { n += 1; return { peak: 0.1 * n, rms: 0.01 * n }; } });
  const seen: { trackId: string; peak: number }[] = [];
  const off = h.engine.onLevel((trackId, frame) => { seen.push({ trackId, peak: frame.peak }); });

  h.engine.arm('trk-a', { kind: 'mic' });
  h.engine.arm('trk-b', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  assert.equal(h.levelTimers().length, 0, 'nothing is polled before the recorders have started');
  h.recs.forEach((r) => { r.fireStart(); });
  await started;

  assert.equal(h.levelTimers().length, 1, 'one poll drives every armed track');
  const timer = h.levelTimers()[0];
  assert.ok(timer.ms <= 50, `poll period ${timer.ms}ms is slower than 20 Hz`);
  assert.equal(timer.ms, RECORDING_LEVEL_INTERVAL_MS);

  timer.fn();
  assert.deepEqual(seen.map((s) => s.trackId), ['trk-a', 'trk-b'], 'a frame per armed track');
  // One shared mic is one analyser, so both tracks report the same frame.
  assert.equal(h.analysers.length, 1);
  near(seen[0].peak, seen[1].peak, 'tracks sharing an input share its level');

  off();
  timer.fn();
  assert.equal(seen.length, 2, 'unsubscribing stops the frames');

  const stopping = h.engine.stop();
  h.recs.forEach((r) => { r.fireStop(); });
  await stopping;
  assert.equal(h.timers.size, 0, 'the poll — and the start deadline — are cleared');
}

/* --------------------------------- onTake ---------------------------------- */

{
  const h = harness();
  const got: Take[] = [];
  const off = h.engine.onTake((t) => { got.push(t); });
  h.engine.arm('trk-a', { kind: 'mic' });
  h.engine.arm('trk-b', { kind: 'mic' });
  const started = h.engine.start();
  await flush();
  h.recs.forEach((r) => { r.fireStart(); });
  await started;
  h.recs[0].fireStop();
  assert.equal(got.length, 1, 'a take is announced as it finishes, not only in the stop() batch');
  assert.equal(got[0].meta.trackId, 'trk-a');
  off();
  const stopping = h.engine.stop();
  h.recs[1].fireStop();
  const takes = await stopping;
  assert.equal(got.length, 1, 'unsubscribing stops the announcements');
  assert.equal(takes.length, 2, 'but stop() still returns every take');
}

console.log('recordingEngine: ok');
