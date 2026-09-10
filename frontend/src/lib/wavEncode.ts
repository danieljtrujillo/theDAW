/**
 * encodeWav — interleave an AudioBuffer to a WAV Blob.
 *
 * The one encoder every bounce path shares: the editor mixdown/bounce, clip
 * extraction, track freeze, the Metamorph "send to editor" render, and the
 * MIDI/step-sequencer bounces.
 *
 * 16-bit stays the default, because what these produce normally is a clip that
 * lands on the timeline or in the library, at half the size and with nothing
 * audible lost. `float32` is for the hops where the samples are not being
 * stored but handed straight to another processor — the freeze chain posts the
 * same audio to a VST3 once per plugin, and a 16-bit round trip at every stage
 * requantizes it every time, which is exactly what /api/vst/process-file
 * answers in float to avoid. Float mode also carries peaks above 0 dBFS that
 * the 16-bit path has to clamp away.
 */
export interface WavEncodeOptions {
  /** Emit 32-bit IEEE float samples instead of 16-bit PCM. */
  float32?: boolean;
}

export function encodeWav(audioBuf: AudioBuffer, opts?: WavEncodeOptions): Blob {
  return opts?.float32 ? encodeFloat32(audioBuf) : encodePcm16(audioBuf);
}

const writeStr = (view: DataView, off: number, s: string) => {
  for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
};

const channelsOf = (audioBuf: AudioBuffer): Float32Array[] => {
  const out: Float32Array[] = [];
  for (let c = 0; c < audioBuf.numberOfChannels; c += 1) out.push(audioBuf.getChannelData(c));
  return out;
};

function encodePcm16(audioBuf: AudioBuffer): Blob {
  const numCh = audioBuf.numberOfChannels;
  const sr = audioBuf.sampleRate;
  const len = audioBuf.length;
  const buffer = new ArrayBuffer(44 + len * numCh * 2);
  const view = new DataView(buffer);
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + len * numCh * 2, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // WAVE_FORMAT_PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, len * numCh * 2, true);
  const channels = channelsOf(audioBuf);
  let offset = 44;
  for (let i = 0; i < len; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * A bare 16-byte fmt chunk with format tag 3 plays in Chromium and ffmpeg, but
 * some DAWs reject it, so this writes the full form the spec asks for: an
 * 18-byte fmt chunk with an explicit cbSize, plus the `fact` chunk that every
 * non-PCM format is required to carry. Header is 58 bytes rather than 44.
 */
function encodeFloat32(audioBuf: AudioBuffer): Blob {
  const numCh = audioBuf.numberOfChannels;
  const sr = audioBuf.sampleRate;
  const len = audioBuf.length;
  const dataBytes = len * numCh * 4;
  const buffer = new ArrayBuffer(58 + dataBytes);
  const view = new DataView(buffer);
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 50 + dataBytes, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 18, true);
  view.setUint16(20, 3, true);          // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * numCh * 4, true);
  view.setUint16(32, numCh * 4, true);
  view.setUint16(34, 32, true);
  view.setUint16(36, 0, true);          // cbSize — no extension follows
  writeStr(view, 38, 'fact');
  view.setUint32(42, 4, true);
  view.setUint32(46, len, true);        // sample frames
  writeStr(view, 50, 'data');
  view.setUint32(54, dataBytes, true);
  const channels = channelsOf(audioBuf);
  let offset = 58;
  for (let i = 0; i < len; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      // No clamp: carrying the over is the reason to be here.
      view.setFloat32(offset, channels[c][i], true);
      offset += 4;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
