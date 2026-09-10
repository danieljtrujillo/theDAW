/**
 * The WAV encoder's two modes, byte by byte.
 *
 * `encodeWav` only ever reads numberOfChannels / sampleRate / length /
 * getChannelData off an AudioBuffer, so a plain object stands in for one and
 * no Web Audio context is needed. What is worth pinning down is the header:
 * the default is still the 44-byte 16-bit PCM file every existing caller
 * expects, and float mode writes the full IEEE form — an 18-byte fmt chunk
 * with a cbSize, the `fact` chunk non-PCM formats are required to carry, and
 * samples that keep a peak above 0 dBFS instead of clamping it away.
 *
 * Run: `npx tsx src/lib/wavEncode.test.ts`
 */
import assert from 'node:assert/strict';
import { encodeWav } from './wavEncode';

const PEAK = 1.5;

/** A ramp from -1.5 to +1.5, so a mode that clamps says so. */
const buf = (numberOfChannels = 2, length = 8, sampleRate = 44100): AudioBuffer => {
  const data: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c += 1) {
    const ch = new Float32Array(length);
    for (let i = 0; i < length; i += 1) ch[i] = -PEAK + (2 * PEAK * i) / (length - 1);
    data.push(ch);
  }
  return {
    numberOfChannels,
    sampleRate,
    length,
    getChannelData: (c: number) => data[c],
  } as unknown as AudioBuffer;
};

const read = async (blob: Blob) => new DataView(await blob.arrayBuffer());
const tag = (v: DataView, off: number) =>
  String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));

const run = async () => {
  const source = buf();

  // --- default mode is unchanged 16-bit PCM ------------------------------
  const pcm = await read(encodeWav(source));
  assert.equal(tag(pcm, 0), 'RIFF');
  assert.equal(tag(pcm, 8), 'WAVE');
  assert.equal(tag(pcm, 12), 'fmt ');
  assert.equal(pcm.getUint32(16, true), 16, 'fmt chunk stays 16 bytes');
  assert.equal(pcm.getUint16(20, true), 1, 'WAVE_FORMAT_PCM');
  assert.equal(pcm.getUint16(34, true), 16, '16 bits per sample');
  assert.equal(tag(pcm, 36), 'data');
  assert.equal(pcm.byteLength, 44 + 8 * 2 * 2, '44-byte header, 2 bytes a sample');
  // +1.5 has nowhere to go in an int16 and comes back pinned at full scale.
  assert.equal(pcm.getInt16(pcm.byteLength - 2, true), 0x7fff);
  assert.equal(pcm.getInt16(44, true), -0x8000);

  // --- float mode ---------------------------------------------------------
  const flt = await read(encodeWav(source, { float32: true }));
  assert.equal(tag(flt, 0), 'RIFF');
  assert.equal(tag(flt, 8), 'WAVE');
  assert.equal(tag(flt, 12), 'fmt ');
  assert.equal(flt.getUint32(16, true), 18, 'fmt chunk carries an explicit cbSize');
  assert.equal(flt.getUint16(20, true), 3, 'WAVE_FORMAT_IEEE_FLOAT');
  assert.equal(flt.getUint16(22, true), 2, 'channel count survives');
  assert.equal(flt.getUint32(24, true), 44100);
  assert.equal(flt.getUint32(28, true), 44100 * 2 * 4, 'byte rate is 4 bytes a sample');
  assert.equal(flt.getUint16(32, true), 8, 'block align');
  assert.equal(flt.getUint16(34, true), 32, '32 bits per sample');
  assert.equal(flt.getUint16(36, true), 0, 'cbSize: no extension follows');
  assert.equal(tag(flt, 38), 'fact', 'non-PCM formats must carry a fact chunk');
  assert.equal(flt.getUint32(42, true), 4);
  assert.equal(flt.getUint32(46, true), 8, 'fact counts sample frames, not bytes');
  assert.equal(tag(flt, 50), 'data');
  assert.equal(flt.getUint32(54, true), 8 * 2 * 4);
  assert.equal(flt.byteLength, 58 + 8 * 2 * 4, '58-byte header');

  // The whole point: the over survives.
  assert.equal(flt.getFloat32(58, true), -PEAK);
  assert.equal(flt.getFloat32(flt.byteLength - 4, true), PEAK);

  // --- both modes declare their own size correctly ------------------------
  for (const [name, v] of [['pcm16', pcm], ['float32', flt]] as const) {
    assert.equal(v.getUint32(4, true), v.byteLength - 8, `${name}: RIFF size field`);
  }

  // --- mono works too, and the interleave is per frame ---------------------
  const mono = await read(encodeWav(buf(1, 4), { float32: true }));
  assert.equal(mono.getUint16(22, true), 1);
  assert.equal(mono.getUint32(54, true), 4 * 4);
  assert.equal(mono.getFloat32(58, true), -PEAK);

  console.log('wavEncode: ok');
};

void run();
