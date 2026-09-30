/**
 * vstLive/frames — the binary audio frame shared by the AudioWorklet bridge, the
 * bridge client and the native VST host.
 *
 * The layout is fixed by docs/design/vst-live-protocol.md ("Binary frames
 * (audio)") and is little-endian throughout:
 *
 * ```
 * off  size  field
 * 0    u32   magic  0x4C545356  ("VSTL")
 * 4    u8    type   0 = audio_in (client -> host)   1 = audio_out (host -> client)
 * 5    u8    channels (1..8)
 * 6    u16   flags  bit0 = transport playing, bit1 = discontinuity
 * 8    u32   seq    block counter chosen by the client; audio_out echoes it
 * 12   u32   frames per channel in this message (<= block size)
 * 16   f64   position_samples  timeline position of the first frame
 * 24   f64   tempo_bpm         0 = unknown
 * 32   ...   float32 planar: ch0[frames], ch1[frames], ...
 * ```
 *
 * `position_samples` and `tempo_bpm` are f64 and not f32 on purpose: a project
 * played for four minutes at 48 kHz is already past 2^23 samples, where float32
 * can no longer represent consecutive integers, and the host builds its
 * `AudioPlayHead` from this number.
 *
 * PURE: no DOM, no audio context, no store — so both sides of the bridge and a
 * test can use it. `public/vst-bridge.worklet.js` mirrors this layout by hand
 * (a worklet module cannot import app source); any change here must be made
 * there in the same edit.
 *
 * Units: `frames` and `positionSamples` are SAMPLE FRAMES; `tempoBpm` is beats
 * per minute; nothing here is in seconds.
 */

/** `"VSTL"` read as a little-endian u32. */
export const FRAME_MAGIC = 0x4c545356;
/** Bytes before the planar payload. */
export const FRAME_HEADER_BYTES = 32;
/** Client -> host. */
export const FRAME_TYPE_AUDIO_IN = 0;
/** Host -> client. */
export const FRAME_TYPE_AUDIO_OUT = 1;
/** flags bit0 — the transport is rolling. */
export const FLAG_PLAYING = 1;
/** flags bit1 — start / seek / loop wrap: the host calls `reset()`. */
export const FLAG_DISCONTINUITY = 2;
/** The contract's channel ceiling (`channels` is a u8 but the host negotiates
 *  1..8 buses). */
export const MAX_FRAME_CHANNELS = 8;

/** One frame's header, in the units named in the module doc. */
export interface VstFrameHeader {
  /** `FRAME_TYPE_AUDIO_IN` or `FRAME_TYPE_AUDIO_OUT`. */
  type: number;
  /** 1..8. */
  channels: number;
  /** `FLAG_PLAYING | FLAG_DISCONTINUITY`. */
  flags: number;
  /** u32 block counter chosen by the client; `audio_out` echoes it. */
  seq: number;
  /** Sample frames per channel carried by this message. */
  frames: number;
  /** Timeline position of the first frame, in sample frames. */
  positionSamples: number;
  /** Beats per minute; 0 = unknown. */
  tempoBpm: number;
}

/** One decoded frame: its header plus one `Float32Array` per channel. */
export interface VstFrame {
  header: VstFrameHeader;
  channels: Float32Array[];
}

/**
 * One accumulated block as `public/vst-bridge.worklet.js` posts it (`type:
 * 'block'`), minus the tag itself.
 */
export interface VstBlockMessage {
  seq: number;
  frames: number;
  playing: boolean;
  discontinuity: boolean;
  positionSamples: number;
  tempoBpm: number;
  channels: Float32Array[];
}

/**
 * Build the `audio_in` header for one block the worklet posted.
 *
 * It lives here rather than next to a caller because there are two callers now:
 * the bridge WORKER, which is where a live block goes, and `vstLiveNode`'s
 * main-thread fallback for a runtime with no `Worker`. The two paths must put
 * the same bytes on the wire or a plugin would behave differently depending on
 * which one carried it, so the mapping is written once.
 */
export function headerFromBlock(block: VstBlockMessage): VstFrameHeader {
  return {
    type: FRAME_TYPE_AUDIO_IN,
    // The buffers are the truth about how many channels this block has; the
    // message carries no count of its own.
    channels: block.channels.length,
    flags: (block.playing ? FLAG_PLAYING : 0) | (block.discontinuity ? FLAG_DISCONTINUITY : 0),
    seq: block.seq,
    frames: block.frames,
    positionSamples: block.positionSamples,
    tempoBpm: block.tempoBpm,
  };
}

const u32 = (v: number, field: string): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new RangeError(`vstLive/frames: ${field} must be a u32, got ${v}`);
  }
  return v;
};

const f64 = (v: number, field: string): number => {
  if (!Number.isFinite(v)) {
    throw new RangeError(`vstLive/frames: ${field} must be finite, got ${v}`);
  }
  return v;
};

/**
 * Encode one frame. `channels.length` must equal `header.channels` and every
 * channel must hold exactly `header.frames` samples — a mismatch is a caller
 * bug that would desynchronise the planar payload, so it throws rather than
 * padding.
 *
 * Non-finite SAMPLES are written as 0. They are the one malformed input that is
 * repaired instead of refused: a NaN that reaches a plugin's `process` call can
 * poison a filter's internal state for the rest of the session, and a frame is
 * the last cheap place to stop one. Header fields still throw, because a bad
 * header means the caller has lost track of its own stream.
 */
export function packFrame(header: VstFrameHeader, channels: readonly Float32Array[]): ArrayBuffer {
  const chCount = header.channels;
  if (!Number.isInteger(chCount) || chCount < 1 || chCount > MAX_FRAME_CHANNELS) {
    throw new RangeError(
      `vstLive/frames: channels must be 1..${MAX_FRAME_CHANNELS}, got ${chCount}`,
    );
  }
  if (channels.length !== chCount) {
    throw new RangeError(
      `vstLive/frames: header declares ${chCount} channels but ${channels.length} were given`,
    );
  }
  const frames = u32(header.frames, 'frames');
  for (let c = 0; c < chCount; c += 1) {
    if (channels[c].length !== frames) {
      throw new RangeError(
        `vstLive/frames: channel ${c} holds ${channels[c].length} samples, frames says ${frames}`,
      );
    }
  }
  u32(header.seq, 'seq');
  u32(header.flags, 'flags');
  f64(header.positionSamples, 'positionSamples');
  f64(header.tempoBpm, 'tempoBpm');

  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + chCount * frames * 4);
  const dv = new DataView(buf);
  dv.setUint32(0, FRAME_MAGIC, true);
  dv.setUint8(4, header.type & 0xff);
  dv.setUint8(5, chCount);
  dv.setUint16(6, header.flags & 0xffff, true);
  dv.setUint32(8, header.seq, true);
  dv.setUint32(12, frames, true);
  dv.setFloat64(16, header.positionSamples, true);
  dv.setFloat64(24, header.tempoBpm, true);

  const pcm = new Float32Array(buf, FRAME_HEADER_BYTES, chCount * frames);
  for (let c = 0; c < chCount; c += 1) {
    const src = channels[c];
    const base = c * frames;
    for (let i = 0; i < frames; i += 1) {
      const v = src[i];
      pcm[base + i] = Number.isFinite(v) ? v : 0;
    }
  }
  return buf;
}

/**
 * Read and VALIDATE a frame's header, without touching (or requiring) its
 * payload. This is not a bare decode: `channels` is range-checked against the
 * same 1..MAX_FRAME_CHANNELS contract `packFrame` enforces on the way out,
 * because a channel count outside that range desyncs the planar payload for
 * every reader downstream (`unpackFrame`'s length check cannot catch it —
 * with `channels === 0` its `need` collapses to just the header size). Order
 * matters: length, then magic, then channel range.
 *
 * Callers treat a throw as "bad frame, drop it" — see
 * `bridgeClient.onBinary`, which already counts it via `stats.badFrames`
 * rather than tearing the session down.
 */
export function readFrameHeader(buf: ArrayBuffer): VstFrameHeader {
  if (buf.byteLength < FRAME_HEADER_BYTES) {
    throw new RangeError(
      `vstLive/frames: message truncated — ${buf.byteLength} bytes is short of the ${FRAME_HEADER_BYTES}-byte header`,
    );
  }
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== FRAME_MAGIC) {
    throw new Error(
      `vstLive/frames: bad magic 0x${magic.toString(16)} (expected 0x${FRAME_MAGIC.toString(16)})`,
    );
  }
  const channels = dv.getUint8(5);
  if (channels < 1 || channels > MAX_FRAME_CHANNELS) {
    throw new RangeError(`vstLive/frames: channels must be 1..${MAX_FRAME_CHANNELS}, got ${channels}`);
  }
  return {
    type: dv.getUint8(4),
    channels,
    flags: dv.getUint16(6, true),
    seq: dv.getUint32(8, true),
    frames: dv.getUint32(12, true),
    positionSamples: dv.getFloat64(16, true),
    tempoBpm: dv.getFloat64(24, true),
  };
}

/** Decode one frame. The returned channels are copies, so the caller may keep
 *  them after the transport buffer is recycled. */
export function unpackFrame(buf: ArrayBuffer): VstFrame {
  const header = readFrameHeader(buf);
  const need = FRAME_HEADER_BYTES + header.channels * header.frames * 4;
  if (buf.byteLength < need) {
    throw new RangeError(
      `vstLive/frames: message truncated — ${buf.byteLength} bytes for a frame that declares ${need}`,
    );
  }
  const pcm = new Float32Array(buf, FRAME_HEADER_BYTES, header.channels * header.frames);
  const channels: Float32Array[] = [];
  for (let c = 0; c < header.channels; c += 1) {
    channels.push(pcm.slice(c * header.frames, (c + 1) * header.frames));
  }
  return { header, channels };
}
