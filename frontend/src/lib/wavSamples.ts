/**
 * wavSamples — read a RIFF/WAVE file's samples into planar Float32Arrays, and
 * write planar samples back as a 32-bit float WAV (through lib/wavEncode).
 *
 * For audio this app wrote or asked a backend for (the instrument prints of
 * POST /api/vst/render-midi), where the samples have to be shaped before the
 * bounce reads them and no AudioContext is at hand. Reads PCM 16, 24 and 32
 * bit, 32-bit IEEE float, and WAVE_FORMAT_EXTENSIBLE carrying either; walks
 * the chunk list, so `fact`, `PEAK` and any other chunk before `data` are
 * skipped. Pure, so node tests run it.
 */
import { encodeWav } from './wavEncode';

export interface WavSamples {
  sampleRate: number;
  /** One array per channel, `frames` long. */
  channels: Float32Array[];
  frames: number;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

const tag = (view: DataView, off: number): string =>
  String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));

/** The samples of a WAV file. Throws, saying why, for anything else. */
export function readWavSamples(buffer: ArrayBuffer): WavSamples {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let format = 0;
  let numCh = 0;
  let sampleRate = 0;
  let bits = 0;
  let off = 12;
  while (off + 8 <= buffer.byteLength) {
    const id = tag(view, off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      numCh = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      if (!numCh || !sampleRate) throw new Error('the WAV data chunk comes before its format');
      const bytes = bits / 8;
      const dataBytes = Math.min(size, buffer.byteLength - body);
      const frames = Math.floor(dataBytes / (bytes * numCh));
      const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
      const read = sampleReader(view, format, bits);
      let p = body;
      for (let i = 0; i < frames; i += 1) {
        for (let c = 0; c < numCh; c += 1) {
          channels[c][i] = read(p);
          p += bytes;
        }
      }
      return { sampleRate, channels, frames };
    }
    off = body + size + (size & 1);
  }
  throw new Error('the WAV file has no data chunk');
}

function sampleReader(view: DataView, format: number, bits: number): (p: number) => number {
  if (format === FORMAT_FLOAT && bits === 32) return (p) => view.getFloat32(p, true);
  if (format === FORMAT_PCM && bits === 16) return (p) => view.getInt16(p, true) / 0x8000;
  if (format === FORMAT_PCM && bits === 24) {
    return (p) => {
      const v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16);
      return v / 0x800000;
    };
  }
  if (format === FORMAT_PCM && bits === 32) return (p) => view.getInt32(p, true) / 0x80000000;
  throw new Error(`WAV format ${format} at ${bits} bits is not read here`);
}

/** Planar samples as a 32-bit float WAV. */
export function writeFloatWav(samples: WavSamples): Blob {
  const like = {
    numberOfChannels: samples.channels.length,
    sampleRate: samples.sampleRate,
    length: samples.frames,
    duration: samples.sampleRate > 0 ? samples.frames / samples.sampleRate : 0,
    getChannelData: (c: number) => samples.channels[c],
  };
  return encodeWav(like as unknown as AudioBuffer, { float32: true });
}
