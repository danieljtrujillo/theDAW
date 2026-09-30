/**
 * vstLive/frames — the binary audio frame is the ONE thing the native host, the
 * backend and this app all have to agree on byte for byte, so this suite asserts
 * the layout against the numbers written in docs/design/vst-live-protocol.md
 * rather than against the implementation's own constants.
 *
 * Run: npx tsx src/lib/vstLive/frames.test.ts
 */
import assert from 'node:assert/strict';

import {
  FLAG_DISCONTINUITY,
  FLAG_PLAYING,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_TYPE_AUDIO_IN,
  FRAME_TYPE_AUDIO_OUT,
  headerFromBlock,
  packFrame,
  readFrameHeader,
  unpackFrame,
  type VstFrameHeader,
} from './frames.ts';

const header = (over: Partial<VstFrameHeader> = {}): VstFrameHeader => ({
  type: FRAME_TYPE_AUDIO_IN,
  channels: 2,
  flags: 0,
  seq: 0,
  frames: 4,
  positionSamples: 0,
  tempoBpm: 0,
  ...over,
});

/* ── the constants ARE the protocol ────────────────────────────────────────── */
{
  assert.equal(FRAME_MAGIC, 0x4c545356, 'magic is "VSTL" little-endian');
  assert.equal(FRAME_HEADER_BYTES, 32, 'the payload starts at byte 32');
  assert.equal(FRAME_TYPE_AUDIO_IN, 0);
  assert.equal(FRAME_TYPE_AUDIO_OUT, 1);
  assert.equal(FLAG_PLAYING, 1, 'bit0 = transport playing');
  assert.equal(FLAG_DISCONTINUITY, 2, 'bit1 = discontinuity');
}

/* ── the byte layout, field by field, read WITHOUT the packer's help ───────── */
{
  const ch0 = Float32Array.from([0.25, -0.5, 1, -1]);
  const ch1 = Float32Array.from([0, 0.125, -0.125, 0.75]);
  const buf = packFrame(
    header({
      type: FRAME_TYPE_AUDIO_IN,
      channels: 2,
      flags: FLAG_PLAYING | FLAG_DISCONTINUITY,
      seq: 0xdeadbeef,
      frames: 4,
      positionSamples: 123456789.5,
      tempoBpm: 128.5,
    }),
    [ch0, ch1],
  );

  assert.equal(buf.byteLength, 32 + 2 * 4 * 4, 'header + planar float32 payload');
  const dv = new DataView(buf);
  assert.equal(dv.getUint32(0, true), 0x4c545356, 'off 0 u32 magic, little-endian');
  assert.equal(dv.getUint8(4), 0, 'off 4 u8 type');
  assert.equal(dv.getUint8(5), 2, 'off 5 u8 channels');
  assert.equal(dv.getUint16(6, true), 3, 'off 6 u16 flags');
  assert.equal(dv.getUint32(8, true), 0xdeadbeef, 'off 8 u32 seq (full unsigned range)');
  assert.equal(dv.getUint32(12, true), 4, 'off 12 u32 frames');
  assert.equal(dv.getFloat64(16, true), 123456789.5, 'off 16 f64 position_samples');
  assert.equal(dv.getFloat64(24, true), 128.5, 'off 24 f64 tempo_bpm');
  assert.equal(dv.getFloat32(32, true), 0.25, 'off 32 ch0[0]');
  assert.equal(dv.getFloat32(32 + 3 * 4, true), -1, 'ch0 runs to completion before ch1');
  assert.equal(dv.getFloat32(32 + 4 * 4, true), 0, 'ch1 starts right after ch0 (planar)');
  assert.equal(dv.getFloat32(32 + 7 * 4, true), 0.75, 'ch1[3]');

  // The magic is the first thing a reader checks, so a header read must not
  // need the payload at all.
  const h = readFrameHeader(buf);
  assert.deepEqual(h, {
    type: FRAME_TYPE_AUDIO_IN,
    channels: 2,
    flags: 3,
    seq: 0xdeadbeef,
    frames: 4,
    positionSamples: 123456789.5,
    tempoBpm: 128.5,
  });
}

/* ── round trip, including the f64 fields ──────────────────────────────────── */
{
  const ch0 = new Float32Array(512);
  const ch1 = new Float32Array(512);
  for (let i = 0; i < 512; i += 1) {
    ch0[i] = Math.sin(i / 10);
    ch1[i] = Math.cos(i / 10);
  }
  const src = header({
    type: FRAME_TYPE_AUDIO_OUT,
    channels: 2,
    flags: FLAG_PLAYING,
    seq: 7,
    frames: 512,
    // A sample position an f32 could not hold exactly: 2^24 + 1 rounds to 2^24
    // in float32, which is why the field is an f64 in the contract.
    positionSamples: 16777217,
    tempoBpm: 174.333,
  });
  const round = unpackFrame(packFrame(src, [ch0, ch1]));
  assert.deepEqual(round.header, src, 'every header field survives the round trip');
  assert.equal(round.header.positionSamples, 16777217, 'f64 position keeps sample accuracy');
  assert.equal(round.channels.length, 2);
  assert.deepEqual(Array.from(round.channels[0]), Array.from(ch0));
  assert.deepEqual(Array.from(round.channels[1]), Array.from(ch1));
}

/* ── mono, and the 8-channel ceiling ───────────────────────────────────────── */
{
  const mono = unpackFrame(packFrame(header({ channels: 1, frames: 2 }), [Float32Array.from([1, -1])]));
  assert.equal(mono.channels.length, 1);
  assert.deepEqual(Array.from(mono.channels[0]), [1, -1]);

  const eight = Array.from({ length: 8 }, (_, c) => Float32Array.from([c]));
  const wide = unpackFrame(packFrame(header({ channels: 8, frames: 1 }), eight));
  assert.equal(wide.channels.length, 8);
  assert.equal(wide.channels[7][0], 7);
}

/* ── a frame shorter than block size is legal (the host processes what it gets) */
{
  const short = unpackFrame(packFrame(header({ frames: 3 }), [new Float32Array(3), new Float32Array(3)]));
  assert.equal(short.header.frames, 3);
  assert.equal(short.channels[0].length, 3);
}

/* ── refusals: a malformed frame must never reach the audio path ───────────── */
{
  const throws = (fn: () => unknown, re: RegExp, msg: string) =>
    assert.throws(fn, (e: unknown) => e instanceof Error && re.test(e.message), msg);

  throws(
    () => packFrame(header({ channels: 2, frames: 4 }), [new Float32Array(4)]),
    /channel/i,
    'the channel array count must match the declared channel count',
  );
  throws(
    () => packFrame(header({ channels: 1, frames: 4 }), [new Float32Array(3)]),
    /frames/i,
    'each channel must hold exactly `frames` samples',
  );
  throws(
    () => packFrame(header({ channels: 0, frames: 1 }), []),
    /channel/i,
    'zero channels is not a frame',
  );
  throws(
    () => packFrame(header({ channels: 9, frames: 1 }), Array.from({ length: 9 }, () => new Float32Array(1))),
    /channel/i,
    'the contract caps channels at 8',
  );
  throws(
    () => packFrame(header({ positionSamples: Number.NaN }), [new Float32Array(4), new Float32Array(4)]),
    /position/i,
    'a non-finite position would poison the host play head',
  );
  throws(
    () => packFrame(header({ tempoBpm: Number.POSITIVE_INFINITY }), [new Float32Array(4), new Float32Array(4)]),
    /tempo/i,
    'a non-finite tempo likewise',
  );
  throws(
    () => packFrame(header({ seq: -1 }), [new Float32Array(4), new Float32Array(4)]),
    /seq/i,
    'seq is a u32',
  );

  const bad = new ArrayBuffer(FRAME_HEADER_BYTES + 8);
  new DataView(bad).setUint32(0, 0x11223344, true);
  throws(() => unpackFrame(bad), /magic/i, 'a foreign message is rejected by its magic');

  const truncated = packFrame(header({ frames: 4 }), [new Float32Array(4), new Float32Array(4)]).slice(0, 40);
  throws(() => unpackFrame(truncated), /truncat|short|length/i, 'a truncated payload is rejected');

  throws(() => readFrameHeader(new ArrayBuffer(8)), /truncat|short|length/i, 'a stub too small to hold a header');
}

/* ── NaN in the audio payload is silenced, not forwarded ───────────────────── */
{
  // A NaN reaching a plugin's process call is a denormal-grade hazard that can
  // poison a filter's state for the rest of the session. Frames are the last
  // place it can be caught cheaply, and silence is the only safe substitute.
  const dirty = Float32Array.from([Number.NaN, Number.POSITIVE_INFINITY, 0.5, -0.5]);
  const out = unpackFrame(packFrame(header({ channels: 1, frames: 4 }), [dirty]));
  assert.deepEqual(Array.from(out.channels[0]), [0, 0, 0.5, -0.5], 'NaN and Inf are written as 0');
}

/* ── headerFromBlock: the worklet's block message becomes an audio_in header ─ */
{
  // The mapping used to live inside vstLiveNode, on the MAIN thread. It is here
  // now because the dedicated bridge worker builds the same header from the
  // same message without main ever seeing the block, and the two must agree
  // byte for byte — one function, used by both.
  const block = {
    seq: 7,
    frames: 4,
    playing: true,
    discontinuity: true,
    positionSamples: 96000.5,
    tempoBpm: 128,
    channels: [Float32Array.from([1, 2, 3, 4]), Float32Array.from([5, 6, 7, 8])],
  };

  const h = headerFromBlock(block);
  assert.equal(h.type, FRAME_TYPE_AUDIO_IN, 'a block from the worklet is always client -> host');
  assert.equal(h.channels, 2, 'the channel count is the buffers themselves, not a field of the message');
  assert.equal(h.flags, FLAG_PLAYING | FLAG_DISCONTINUITY);
  assert.equal(h.seq, 7);
  assert.equal(h.frames, 4);
  assert.equal(h.positionSamples, 96000.5);
  assert.equal(h.tempoBpm, 128);

  assert.equal(headerFromBlock({ ...block, playing: false, discontinuity: false }).flags, 0, 'no flag when neither holds');
  assert.equal(headerFromBlock({ ...block, playing: true, discontinuity: false }).flags, FLAG_PLAYING);
  assert.equal(headerFromBlock({ ...block, playing: false, discontinuity: true }).flags, FLAG_DISCONTINUITY);
  assert.equal(headerFromBlock({ ...block, channels: [Float32Array.from([1, 2, 3, 4])] }).channels, 1, 'a mono block declares one channel');

  // The header it builds has to be one `packFrame` accepts and the wire
  // preserves: it is fed straight to the client's sendAudio.
  const round = readFrameHeader(packFrame(h, block.channels));
  assert.deepEqual(round, { ...h, seq: 7 }, 'it survives the wire format unchanged');
}

console.log('vstLive/frames: ok');
