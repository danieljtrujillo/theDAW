/**
 * vstLive/frames — `readFrameHeader` header validation (RVT-4).
 *
 * `packFrame` enforces `channels` in 1..MAX_FRAME_CHANNELS on the way out, but
 * `readFrameHeader` used to hand the raw byte back unchecked. A frame
 * claiming 0 channels (or anything above the ceiling) passed every length
 * check — `unpackFrame`'s `need` collapses to just the header size when
 * `channels` or `frames` is 0 — and came back as a frame with an EMPTY
 * channel list instead of being refused. This suite pins the fix: a header
 * outside the encoder's own range is rejected before it ever reaches a
 * caller.
 *
 * Run: npx tsx src/lib/vstLive/frames.header.test.ts
 */
import assert from 'node:assert/strict';

import {
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_TYPE_AUDIO_IN,
  FRAME_TYPE_AUDIO_OUT,
  MAX_FRAME_CHANNELS,
  packFrame,
  readFrameHeader,
  unpackFrame,
  type VstFrameHeader,
} from './frames.ts';
import { VstBridgeClient, type BridgeSocketLike } from './bridgeClient.ts';

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

/** Build a 32-byte header by hand, bypassing `packFrame`'s own checks so an
 *  out-of-contract `channels` byte can be put on the wire. */
const rawHeader = (channels: number, over: { type?: number; frames?: number } = {}): ArrayBuffer => {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES);
  const dv = new DataView(buf);
  dv.setUint32(0, FRAME_MAGIC, true);
  dv.setUint8(4, over.type ?? FRAME_TYPE_AUDIO_OUT);
  dv.setUint8(5, channels);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, 0, true);
  dv.setUint32(12, over.frames ?? 0, true);
  dv.setFloat64(16, 0, true);
  dv.setFloat64(24, 0, true);
  return buf;
};

const throwsRangeError = (fn: () => unknown, re: RegExp, msg: string) =>
  assert.throws(fn, (e: unknown) => e instanceof RangeError && re.test(e.message), msg);

/* ── a header declaring 0 channels is rejected ─────────────────────────────── */
{
  throwsRangeError(() => readFrameHeader(rawHeader(0)), /channels/i, 'a header declaring 0 channels is rejected');
}

/* ── a header declaring 9 channels is rejected ─────────────────────────────── */
{
  throwsRangeError(() => readFrameHeader(rawHeader(9)), /channels/i, 'a header declaring 9 channels is rejected');
}

/* ── a valid 1-channel and a valid 8-channel header still decode ──────────── */
{
  const low = readFrameHeader(rawHeader(1));
  assert.equal(low.channels, 1, 'the floor of the encoder range still decodes');
  const high = readFrameHeader(rawHeader(MAX_FRAME_CHANNELS));
  assert.equal(high.channels, MAX_FRAME_CHANNELS, 'the ceiling of the encoder range still decodes');

  const mono = unpackFrame(packFrame(header({ channels: 1, frames: 2 }), [Float32Array.from([1, -1])]));
  assert.equal(mono.channels.length, 1);
  assert.deepEqual(Array.from(mono.channels[0]), [1, -1]);

  const wide = unpackFrame(
    packFrame(
      header({ channels: MAX_FRAME_CHANNELS, frames: 1 }),
      Array.from({ length: MAX_FRAME_CHANNELS }, (_, c) => Float32Array.from([c])),
    ),
  );
  assert.equal(wide.channels.length, MAX_FRAME_CHANNELS);
  assert.equal(wide.channels[MAX_FRAME_CHANNELS - 1][0], MAX_FRAME_CHANNELS - 1);
}

/* ── unpackFrame no longer yields a zero-channel frame ─────────────────────── */
{
  throwsRangeError(
    () => unpackFrame(rawHeader(0)),
    /channels/i,
    'a 0-channel buffer must throw, not hand back { channels: [] }',
  );
}

/* ── a bad channel count is counted as a bad frame, not a fatal error ─────── */
{
  class FakeSocket implements BridgeSocketLike {
    binaryType = 'blob';
    readyState = 0;
    sent: (string | ArrayBuffer)[] = [];
    onopen: (() => void) | null = null;
    onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    send(data: string | ArrayBuffer): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = 3;
    }
    open(): void {
      this.readyState = 1;
      this.onopen?.();
    }
  }

  const socket = new FakeSocket();
  let audioCalls = 0;
  const client = new VstBridgeClient({
    url: 'ws://127.0.0.1:0',
    socketFactory: () => socket,
    handlers: {
      onAudio: () => {
        audioCalls += 1;
      },
    },
  });
  client.connect();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ ev: 'ready' }) });
  assert.equal(client.ready, true, 'the fake host has said ready');

  socket.onmessage?.({ data: rawHeader(0) });

  assert.equal(client.stats.badFrames, 1, 'the malformed frame is counted');
  assert.equal(audioCalls, 0, 'onAudio never fires for it');
  assert.equal(client.ready, true, 'one bad frame does not take the session down');
  client.close();
}

console.log('vstLive/frames.header: ok');
