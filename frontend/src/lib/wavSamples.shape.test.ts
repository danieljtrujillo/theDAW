// A WAV file's rate, channels and length from its header alone
// (lib/wavSamples readWavShape): how an insert print learns how long a
// plugin's answer is, including the tail the host rang out past its input,
// without reading every sample of a file that can run to tens of megabytes.
//
// Run: npx tsx src/lib/wavSamples.shape.test.ts
import assert from 'node:assert/strict';

import { encodeWav } from './wavEncode.ts';
import { readWavShape, writeFloatWav } from './wavSamples.ts';

const buffer = (frames: number, channels: number, sampleRate: number): AudioBuffer => {
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  return {
    duration: frames / sampleRate, length: frames, sampleRate, numberOfChannels: channels,
    getChannelData: (c: number) => data[c],
  } as unknown as AudioBuffer;
};

async function main(): Promise<void> {
  const float = writeFloatWav({ sampleRate: 44100, channels: [new Float32Array(1234), new Float32Array(1234)], frames: 1234 });
  assert.deepEqual(
    readWavShape(await float.slice(0, 64 * 1024).arrayBuffer(), float.size),
    { sampleRate: 44100, channels: 2, frames: 1234 },
    'a float WAV, from its first bytes',
  );

  const pcm = encodeWav(buffer(500, 1, 48000));
  assert.deepEqual(
    readWavShape(await pcm.arrayBuffer()),
    { sampleRate: 48000, channels: 1, frames: 500 },
    'a 16-bit WAV, from the whole file',
  );

  // A header that declares more data than the file holds: what is there counts.
  const bytes = new Uint8Array(await float.arrayBuffer());
  const cut = bytes.slice(0, bytes.length - 8 * 100);
  assert.equal(readWavShape(cut.buffer, cut.length).frames, 1134, 'a short file is as long as what it holds');

  assert.throws(() => readWavShape(new TextEncoder().encode('not audio at all').buffer), /not a RIFF\/WAVE file/);
  assert.throws(
    () => readWavShape(bytes.slice(0, 20).buffer),
    /ends before its data chunk/,
    'a head too short to reach the data chunk says so',
  );
  console.log('wavSamples.shape: ok');
}

await main();
