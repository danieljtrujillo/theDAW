/**
 * vstLive/jitterBuffer — prime, steady drain, underrun, resync.
 *
 * This is the algorithm `public/vst-bridge.worklet.js` runs on the audio
 * thread, kept here so it can be tested without a browser. The property that
 * matters most is the one the PDC number depends on: ONCE PRIMED THE DELAY IS
 * FIXED. If the buffer could quietly drift, every latency figure the mixer
 * compensates with would be a lie.
 *
 * Run: npx tsx src/lib/vstLive/jitterBuffer.test.ts
 */
import assert from 'node:assert/strict';

import { JitterBuffer, fixedDelayFrames } from './jitterBuffer.ts';

/** A block whose every sample is `v`, so "which block came out" is readable. */
const block = (v: number, frames: number, channels = 2): Float32Array[] =>
  Array.from({ length: channels }, () => new Float32Array(frames).fill(v));

const out = (frames: number, channels = 2): Float32Array[] =>
  Array.from({ length: channels }, () => new Float32Array(frames).fill(-99));

/* ── the declared delay ────────────────────────────────────────────────────── */
{
  // block_size * (buffer_blocks + 1): one block of input accumulation before
  // anything is sent, plus the blocks held back to absorb jitter.
  assert.equal(fixedDelayFrames(512, 2), 512 * 3);
  assert.equal(fixedDelayFrames(512, 0), 512, 'no jitter blocks still costs the accumulator');
  assert.equal(fixedDelayFrames(128, 4), 128 * 5);
  assert.throws(() => fixedDelayFrames(0, 2), RangeError, 'a zero block size is not a configuration');
  assert.throws(() => fixedDelayFrames(512, -1), RangeError);
  assert.throws(() => fixedDelayFrames(512, 1.5), RangeError);
}

/* ── construction is validated ─────────────────────────────────────────────── */
{
  assert.throws(() => new JitterBuffer({ blockSize: 0, channels: 2, bufferBlocks: 2 }), RangeError);
  assert.throws(() => new JitterBuffer({ blockSize: 512, channels: 0, bufferBlocks: 2 }), RangeError);
  assert.throws(() => new JitterBuffer({ blockSize: 512, channels: 2, bufferBlocks: -1 }), RangeError);
  assert.throws(() => new JitterBuffer({ blockSize: 512, channels: 2, bufferBlocks: Number.NaN }), RangeError);
}

/* ── priming: the block being played PLUS `bufferBlocks` of reserve ────────── */
{
  // Why `bufferBlocks + 1` and not `bufferBlocks`: block i only exists once its
  // last input frame has been accumulated, at time (i+1)*blockSize. Starting to
  // play it when `bufferBlocks` further blocks are already queued puts its first
  // sample out at (i + bufferBlocks + 1) * blockSize — which is the delay this
  // buffer DECLARES. Priming a block earlier would make the number PDC
  // compensates with larger than the delay the audio actually has.
  const jb = new JitterBuffer({ blockSize: 4, channels: 2, bufferBlocks: 2 });
  assert.equal(jb.primed, false);
  assert.equal(jb.delayFrames, 4 * 3, 'the delay it will hold once primed');

  const o = out(4);
  assert.equal(jb.pull(o, 4), false, 'unprimed pulls deliver silence');
  assert.deepEqual(Array.from(o[0]), [0, 0, 0, 0], 'and the output is ZEROED, not left dirty');
  assert.equal(jb.underruns, 0, 'priming is not an underrun — nothing was dropped');

  jb.push(1, block(0.5, 4));
  assert.equal(jb.primed, false, 'one block is not a buffer');
  assert.equal(jb.pull(out(4), 4), false);

  jb.push(2, block(0.75, 4));
  assert.equal(jb.primed, false, 'nor is exactly `bufferBlocks` — that is the RESERVE');

  jb.push(3, block(0.25, 4));
  assert.equal(jb.primed, true, 'the block to play, plus the reserve, primes it');
  assert.equal(jb.underruns, 0);

  const first = out(4);
  assert.equal(jb.pull(first, 4), true);
  assert.deepEqual(Array.from(first[0]), [0.5, 0.5, 0.5, 0.5], 'blocks come out in order, oldest first');
  assert.deepEqual(Array.from(first[1]), [0.5, 0.5, 0.5, 0.5], 'every channel, planar');
}

/* ── a late prime is trimmed back to the nominal depth ─────────────────────── */
{
  // A host that is slow to start can deliver several blocks in a burst before
  // anything has ever been pulled. If the extras stayed queued, the buffer
  // would prime `bufferBlocks + 1` deep as usual but with more already behind
  // it — and since steady-state push/pull never shrinks the depth back (see
  // above), that excess would be a permanent extra delay never reported to PDC.
  // Fixture values are exactly representable in float32 (see the steady-state
  // block above for why: the buffer stores Float32Array, and 0.1-style values
  // would come back rounded, making the assertion about IEEE-754 rather than
  // about the buffer).
  const jb = new JitterBuffer({ blockSize: 4, channels: 1, bufferBlocks: 2 });
  jb.push(1, block(0.125, 4, 1));
  jb.push(2, block(0.25, 4, 1));
  jb.push(3, block(0.375, 4, 1)); // primes here: exactly bufferBlocks + 1 = 3
  jb.push(4, block(0.5, 4, 1)); // burst continues after priming, before any pull
  jb.push(5, block(0.625, 4, 1));
  assert.equal(jb.primed, true, 'the burst still primes it');
  assert.equal(jb.queuedBlocks, 3, 'trimmed back to exactly bufferBlocks + 1 blocks');
  assert.equal(jb.queuedFrames, 12, 'the declared depth in frames: 4 * 3');
  assert.equal(jb.overflows, 2, 'the 2 excess blocks are counted as dropped');

  const first = out(4, 1);
  assert.equal(jb.pull(first, 4), true);
  assert.deepEqual(Array.from(first[0]), [0.375, 0.375, 0.375, 0.375], 'the oldest RETAINED block plays first, not seq 1 or 2');
}

/* ── steady state: a quantum smaller than a block, and the delay never drifts  */
{
  // 8-frame blocks drained 2 frames at a time, the way a 128-frame render
  // quantum drains a 512-frame block.
  const jb = new JitterBuffer({ blockSize: 8, channels: 1, bufferBlocks: 2 });
  jb.push(1, block(0.125, 8, 1));
  jb.push(2, block(0.25, 8, 1));
  jb.push(3, block(0.5, 8, 1));
  assert.equal(jb.primed, true);

  const got: number[] = [];
  for (let q = 0; q < 4; q += 1) {
    const o = out(2, 1);
    assert.equal(jb.pull(o, 2), true, `quantum ${q} delivers audio`);
    got.push(...Array.from(o[0]));
  }
  // Every fixture value here is exactly representable in float32 (0.125, 0.25,
  // 0.375, 0.5, 0.875): the buffer stores Float32Array, so a value like 0.1
  // would come back as 0.10000000149011612 and the assertion would be about
  // IEEE-754 rather than about the buffer.
  assert.deepEqual(got, [0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125], 'the first block drains across four quanta');
  assert.equal(jb.queuedBlocks, 2, 'the consumed block is released; the reserve stays');

  // Feed one block per block consumed: the queue depth — and therefore the
  // delay — is a constant. This is the invariant the PDC number rests on.
  for (let round = 0; round < 20; round += 1) {
    jb.push(10 + round, block(0.375, 8, 1));
    for (let q = 0; q < 4; q += 1) assert.equal(jb.pull(out(2, 1), 2), true);
    assert.equal(jb.queuedFrames, 16, `depth is constant at round ${round}, not drifting`);
  }
  assert.equal(jb.underruns, 0, 'a producer that keeps up never underruns');
}

/* ── a quantum that straddles a block boundary ─────────────────────────────── */
{
  const jb = new JitterBuffer({ blockSize: 4, channels: 1, bufferBlocks: 1 });
  jb.push(1, block(1, 4, 1));
  jb.push(2, block(2, 4, 1));
  const o = out(6, 1);
  assert.equal(jb.pull(o, 6), true);
  assert.deepEqual(Array.from(o[0]), [1, 1, 1, 1, 2, 2], 'a pull spans as many blocks as it needs');
  assert.equal(jb.queuedFrames, 2, 'and leaves the remainder of the partial block');
}

/* ── underrun: silence, counted, and a resync back to the nominal delay ────── */
{
  const jb = new JitterBuffer({ blockSize: 4, channels: 2, bufferBlocks: 1 });
  jb.push(1, block(0.5, 4));
  jb.push(2, block(0.25, 4));
  assert.equal(jb.primed, true);
  assert.equal(jb.pull(out(4), 4), true);
  assert.equal(jb.pull(out(4), 4), true, 'the reserve carries one more quantum');

  // The host missed its deadline: nothing queued for this quantum.
  const starved = out(4);
  assert.equal(jb.pull(starved, 4), false, 'an underrun delivers silence');
  assert.deepEqual(Array.from(starved[0]), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(starved[1]), [0, 0, 0, 0], 'on every channel');
  assert.equal(jb.underruns, 1, 'and is counted exactly once');
  assert.equal(jb.primed, false, 'an underrun drops the buffer back to priming');

  // Late blocks arriving after the resync do NOT play immediately: the buffer
  // refills to its nominal depth first, which is what restores the fixed delay
  // instead of letting it creep shorter with every glitch.
  jb.push(3, block(0.875, 4));
  assert.equal(jb.primed, false, 'one block does not re-prime it');
  assert.equal(jb.pull(out(4), 4), false, 'and it keeps playing silence while it refills');
  assert.equal(jb.underruns, 1, 'refilling is not a second underrun');
  jb.push(4, block(0.5, 4));
  assert.equal(jb.primed, true, 'the reserve is back, so the nominal delay is back');
  const after = out(4);
  assert.equal(jb.pull(after, 4), true);
  assert.deepEqual(Array.from(after[0]), [0.875, 0.875, 0.875, 0.875]);
  assert.equal(jb.underruns, 1, 'recovery does not inflate the count');
}

/* ── a re-prime burst is also trimmed back to the nominal depth ────────────── */
{
  // Same drift risk as a late prime, but triggered by a resync after an
  // underrun: a host catching back up can dump more than the reserve before
  // the buffer ever resumes draining.
  const jb = new JitterBuffer({ blockSize: 4, channels: 1, bufferBlocks: 1 });
  jb.push(1, block(1, 4, 1));
  jb.push(2, block(2, 4, 1));
  assert.equal(jb.primed, true);
  assert.equal(jb.pull(out(4, 1), 4), true, 'drains block 1, the reserve (block 2) carries the queue');
  assert.equal(jb.pull(out(4, 1), 4), true, 'drains block 2; queue now empty');

  const starved = out(4, 1);
  assert.equal(jb.pull(starved, 4), false, 'nothing queued: an underrun');
  assert.equal(jb.underruns, 1);
  assert.equal(jb.primed, false);

  // Catch-up burst: 3 blocks arrive before the buffer ever drains again.
  jb.push(3, block(3, 4, 1));
  jb.push(4, block(4, 4, 1)); // re-primes here: exactly bufferBlocks + 1 = 2
  jb.push(5, block(5, 4, 1)); // burst continues after re-priming, before any pull
  assert.equal(jb.primed, true, 'the reserve is back');
  assert.equal(jb.queuedBlocks, 2, 'trimmed to bufferBlocks + 1, not left at 3');
  assert.equal(jb.overflows, 1, 'the one excess block from the re-prime burst is counted');

  const played = out(4, 1);
  assert.equal(jb.pull(played, 4), true);
  assert.deepEqual(Array.from(played[0]), [4, 4, 4, 4], 'the oldest RETAINED block plays; seq 3 was dropped');
}

/* ── a PARTIAL underrun is still silence for the whole quantum ─────────────── */
{
  // Splicing half a quantum of audio onto half a quantum of silence is a click.
  // The whole quantum goes silent instead, and the partial block is dropped.
  const jb = new JitterBuffer({ blockSize: 2, channels: 1, bufferBlocks: 1 });
  jb.push(1, block(0.375, 2, 1));
  jb.push(2, block(0.5, 2, 1));
  assert.equal(jb.primed, true);
  const o = out(6, 1);
  assert.equal(jb.pull(o, 6), false, '4 frames queued cannot satisfy a 6-frame quantum');
  assert.deepEqual(Array.from(o[0]), [0, 0, 0, 0, 0, 0], 'so none of it is used');
  assert.equal(jb.underruns, 1);
  assert.equal(jb.queuedFrames, 0, 'the resync clears the queue so blocks stay aligned');
}

/* ── overflow: a bursty producer is bounded, oldest first ──────────────────── */
{
  const jb = new JitterBuffer({ blockSize: 2, channels: 1, bufferBlocks: 2 });
  // Prime and drain once first: this test is about the `maxBlocks` safety net
  // during ACTIVE draining. A still-priming buffer now enforces the tighter
  // nominal-depth cap instead (see "a late prime" below), so get past priming
  // before the burst.
  jb.push(-3, block(-3, 2, 1));
  jb.push(-2, block(-2, 2, 1));
  jb.push(-1, block(-1, 2, 1));
  assert.equal(jb.pull(out(2, 1), 2), true);
  for (let i = 0; i < 100; i += 1) jb.push(i, block(i, 2, 1));
  assert.ok(jb.queuedBlocks <= jb.maxBlocks, `queue is bounded, held ${jb.queuedBlocks}`);
  assert.ok(jb.overflows > 0, 'and says so rather than growing without limit');
  const o = out(2, 1);
  jb.pull(o, 2);
  assert.equal(o[0][0], 100 - jb.maxBlocks, 'the OLDEST blocks are the ones dropped');
}

/* ── duplicate / stale sequence numbers are dropped ────────────────────────── */
{
  const jb = new JitterBuffer({ blockSize: 2, channels: 1, bufferBlocks: 1 });
  jb.push(5, block(0.5, 2, 1));
  jb.push(5, block(0.625, 2, 1));
  jb.push(4, block(0.75, 2, 1));
  assert.equal(jb.queuedBlocks, 1, 'a repeat and a straggler are both ignored');
  assert.equal(jb.stale, 2, 'and counted, so the client can see a host misbehaving');
  jb.push(6, block(0.25, 2, 1)); // enough to prime
  const o = out(2, 1);
  assert.equal(jb.pull(o, 2), true);
  assert.equal(o[0][0], 0.5, 'the first arrival is the one that plays');
}

/* ── a block with the wrong shape is refused, not spliced in ───────────────── */
{
  const jb = new JitterBuffer({ blockSize: 4, channels: 2, bufferBlocks: 1 });
  assert.throws(() => jb.push(1, block(0.5, 4, 1)), RangeError, 'channel count must match');
  assert.throws(() => jb.push(1, block(0.5, 5, 2)), RangeError, 'over-long blocks are refused');
  // A SHORT block is legal — the contract allows a frame smaller than the block
  // size, because the host processes what it is given.
  jb.push(1, block(0.5, 3, 2));
  assert.equal(jb.queuedFrames, 3);
}

/* ── reset() returns it to the state it was constructed in ─────────────────── */
{
  const jb = new JitterBuffer({ blockSize: 2, channels: 1, bufferBlocks: 1 });
  jb.push(1, block(1, 2, 1));
  jb.push(2, block(1, 2, 1));
  jb.pull(out(2, 1), 2);
  jb.pull(out(2, 1), 2);
  jb.pull(out(2, 1), 2); // underrun
  assert.equal(jb.underruns, 1);
  jb.reset();
  assert.equal(jb.primed, false);
  assert.equal(jb.queuedFrames, 0);
  assert.equal(jb.underruns, 0, 'reset clears the stats too — a new session starts clean');
  assert.equal(jb.overflows, 0);
  assert.equal(jb.stale, 0);
}

console.log('vstLive/jitterBuffer: ok');
