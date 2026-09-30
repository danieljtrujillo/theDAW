/**
 * Web-Audio clip operations, without Web Audio.
 *
 * Node has no `OfflineAudioContext`, so every op here takes a factory for one
 * and this suite injects a fake. The fake supplies exactly the two things the
 * ops need — decode a `Blob`'s bytes into channel data, and allocate an output
 * buffer — which is the whole reason the ops do their DSP over `Float32Array`
 * instead of wiring up a node graph: reversing, normalizing and concatenating
 * samples is arithmetic, and arithmetic can be proven at this desk rather than
 * listened to in a browser.
 *
 * The bytes are real: inputs are built with the app's own `encodeWav`, and the
 * fake decoder parses that WAV back. So the round trip that runs here is the
 * round trip that runs in the app, minus the browser's decoder — which means
 * every assertion carries the 16-bit encoder's quantization, hence QUANT below.
 *
 * Run: `npx tsx src/lib/clipOps/audioOps.test.ts`
 */
import assert from 'node:assert/strict';
import type { AudioClip } from '../../state/editorStore';
import { encodeWav } from '../wavEncode';
import {
  applyFadesToBlob,
  bounceMidiClip,
  concatBlobs,
  normalizeBlob,
  reverseBlob,
  stretchMidiClip,
} from './audioOps';
import type { OfflineCtxFactory, StepNoteRenderer } from './audioOps';

/** Worst-case round-trip error through `encodeWav`'s 16-bit PCM mode. */
const QUANT = 1e-4;
const SR = 8000;

const close = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= QUANT, `${what}: got ${actual}, want ${expected}`);

const closeAll = (actual: Float32Array, expected: number[], what: string) => {
  assert.equal(actual.length, expected.length, `${what}: length`);
  for (let i = 0; i < expected.length; i += 1) close(actual[i], expected[i], `${what}[${i}]`);
};

/* ── the fake context ────────────────────────────────────────────────────── */

const bufferOf = (channels: Float32Array[], sampleRate: number): AudioBuffer =>
  ({
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0]?.length ?? 0,
    duration: (channels[0]?.length ?? 0) / sampleRate,
    getChannelData: (c: number) => channels[c],
  }) as unknown as AudioBuffer;

/** Minimal RIFF reader for what `encodeWav` writes in its default 16-bit mode. */
const decodeWav = (data: ArrayBuffer): AudioBuffer => {
  const view = new DataView(data);
  const tag = (off: number) =>
    String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  const numCh = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  assert.equal(view.getUint16(34, true), 16, 'the ops encode 16-bit PCM');
  assert.equal(tag(36), 'data');
  const bytes = view.getUint32(40, true);
  const frames = bytes / (numCh * 2);
  const channels = Array.from({ length: numCh }, () => new Float32Array(frames));
  let off = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < numCh; c += 1) {
      const v = view.getInt16(off, true);
      channels[c][i] = v < 0 ? v / 0x8000 : v / 0x7fff;
      off += 2;
    }
  }
  return bufferOf(channels, sampleRate);
};

let factoryCalls = 0;
const fakeFactory: OfflineCtxFactory = () => {
  factoryCalls += 1;
  return {
    decodeAudioData: async (data: ArrayBuffer) => decodeWav(data),
    createBuffer: (numberOfChannels: number, length: number, sampleRate: number) =>
      bufferOf(
        Array.from({ length: numberOfChannels }, () => new Float32Array(length)),
        sampleRate,
      ),
  };
};

/** A WAV Blob carrying exactly these samples, one array per channel, at `rate`.
 *  The fake decoder reads the rate back out of the header, so building a part
 *  at a second rate is all it takes to make the factory hand back two. */
const wavAt = (rate: number, ...channels: number[][]): Blob =>
  encodeWav(bufferOf(channels.map((c) => Float32Array.from(c)), rate));

/** A WAV Blob at the suite's working rate. */
const wavOf = (...channels: number[][]): Blob => wavAt(SR, ...channels);

const run = async () => {
  /* ── reverse ───────────────────────────────────────────────────────────── */
  {
    const before = factoryCalls;
    const src = wavOf([0.1, 0.2, 0.3, 0.4], [-0.4, -0.3, -0.2, -0.1]);
    const out = await reverseBlob(src, fakeFactory);

    assert.ok(factoryCalls > before, 'the injected factory is what gets used');
    const buf = decodeWav(await out.blob.arrayBuffer());
    assert.equal(buf.numberOfChannels, 2, 'channel count survives');
    assert.equal(buf.sampleRate, SR);
    closeAll(buf.getChannelData(0), [0.4, 0.3, 0.2, 0.1], 'reversed L');
    closeAll(buf.getChannelData(1), [-0.1, -0.2, -0.3, -0.4], 'reversed R, independently');
    close(out.duration, 4 / SR, 'duration is unchanged by a reverse');

    // Reversing twice is the identity (within the encoder's quantization).
    const back = decodeWav(await (await reverseBlob(out.blob, fakeFactory)).blob.arrayBuffer());
    closeAll(back.getChannelData(0), [0.1, 0.2, 0.3, 0.4], 'reverse is its own inverse');

    // A single sample is its own reverse, and does not go out of bounds.
    const one = decodeWav(await (await reverseBlob(wavOf([0.5]), fakeFactory)).blob.arrayBuffer());
    closeAll(one.getChannelData(0), [0.5], 'single sample');
  }

  /* ── normalize ─────────────────────────────────────────────────────────── */
  {
    // Peak is 0.25; -6 dBFS is 0.501187..., so everything scales by ~2.0047.
    const src = wavOf([0.25, -0.125, 0, 0.0625]);
    const out = await normalizeBlob(src, { peakDb: -6 }, fakeFactory);
    const buf = decodeWav(await out.blob.arrayBuffer());
    const target = Math.pow(10, -6 / 20);
    const g = target / 0.25;
    closeAll(buf.getChannelData(0), [0.25 * g, -0.125 * g, 0, 0.0625 * g], 'scaled to -6 dBFS');
    close(Math.max(...Array.from(buf.getChannelData(0)).map(Math.abs)), target, 'peak lands on target');

    // The default target is -1 dBFS.
    const dflt = decodeWav(await (await normalizeBlob(src, {}, fakeFactory)).blob.arrayBuffer());
    close(
      Math.max(...Array.from(dflt.getChannelData(0)).map(Math.abs)),
      Math.pow(10, -1 / 20),
      'default peakDb is -1',
    );

    // Normalizing brings a HOT clip down as well as a quiet one up.
    const hot = decodeWav(
      await (await normalizeBlob(wavOf([0.98, -0.9]), { peakDb: -6 }, fakeFactory)).blob.arrayBuffer(),
    );
    close(Math.max(...Array.from(hot.getChannelData(0)).map(Math.abs)), target, 'loud source pulled down');

    // The peak is taken across ALL channels, so the stereo image is not shifted.
    const stereo = decodeWav(
      await (await normalizeBlob(wavOf([0.1, 0.1], [0.4, 0.2]), { peakDb: -6 }, fakeFactory)).blob.arrayBuffer(),
    );
    close(stereo.getChannelData(0)[0], 0.1 * (target / 0.4), 'L scaled by the same factor as R');
    close(stereo.getChannelData(1)[0], target, 'R holds the peak');

    // Digital silence has no peak to scale: it must come back silent, not NaN.
    const silent = decodeWav(await (await normalizeBlob(wavOf([0, 0, 0]), {}, fakeFactory)).blob.arrayBuffer());
    closeAll(silent.getChannelData(0), [0, 0, 0], 'silence stays silence');
  }

  /* ── concat ────────────────────────────────────────────────────────────── */
  {
    const a = wavOf([0.5, 0.5]);
    const b = wavOf([-0.5, -0.5]);
    // One sample of silence between them (1/SR seconds).
    const out = await concatBlobs([a, b], [1 / SR], fakeFactory);
    const buf = decodeWav(await out.blob.arrayBuffer());
    closeAll(buf.getChannelData(0), [0.5, 0.5, 0, -0.5, -0.5], 'joined with a gap');
    close(out.duration, 5 / SR, 'duration is the sum of the parts and the gaps');

    // No gaps given = butt-joined.
    const tight = decodeWav(await (await concatBlobs([a, b], [], fakeFactory)).blob.arrayBuffer());
    closeAll(tight.getChannelData(0), [0.5, 0.5, -0.5, -0.5], 'no gap');

    // A mono part inside a stereo concat is centred, not dropped.
    const mixed = decodeWav(
      await (await concatBlobs([wavOf([0.5], [0.25]), wavOf([-0.5])], [], fakeFactory)).blob.arrayBuffer(),
    );
    assert.equal(mixed.numberOfChannels, 2, 'widest input decides the output width');
    closeAll(mixed.getChannelData(0), [0.5, -0.5], 'L');
    closeAll(mixed.getChannelData(1), [0.25, -0.5], 'mono part copied to both sides');

    // One input is a pass-through, not an error.
    const single = decodeWav(await (await concatBlobs([a], [], fakeFactory)).blob.arrayBuffer());
    closeAll(single.getChannelData(0), [0.5, 0.5], 'single input');

    await assert.rejects(() => concatBlobs([], [], fakeFactory), /no input/i);

    // Parts at different rates must be refused, not silently written into one
    // buffer at whichever rate happened to come first: the mismatched part
    // would play at the wrong speed and pitch, and the joint would still sound
    // plausible enough to ship. A real OfflineAudioContext resamples on decode
    // so every part shares its rate — a factory that does not is a bug worth
    // hearing about at the call site rather than in the render.
    await assert.rejects(
      () => concatBlobs([wavOf([0.5, 0.5]), wavAt(SR * 2, [0.25, 0.25])], [], fakeFactory),
      /sample rate/i,
    );
    await assert.rejects(
      () => concatBlobs([wavAt(SR * 2, [0.25]), wavOf([0.5]), wavOf([0.5])], [], fakeFactory),
      /sample rate/i,
      'the mismatch is caught wherever in the list it sits',
    );
    // The message names both rates, so the caller knows what to resample.
    await assert.rejects(() => concatBlobs([wavOf([0.5]), wavAt(SR * 2, [0.25])], [], fakeFactory), (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, new RegExp(String(SR)), 'names the first rate');
      assert.match(msg, new RegExp(String(SR * 2)), 'names the offending rate');
      return true;
    });
    // Matching rates still join, so the guard is not just rejecting everything.
    const matched = decodeWav(
      await (await concatBlobs([wavAt(16000, [0.5]), wavAt(16000, [-0.5])], [], fakeFactory)).blob.arrayBuffer(),
    );
    assert.equal(matched.sampleRate, 16000, 'a shared non-default rate is carried through');
    closeAll(matched.getChannelData(0), [0.5, -0.5], 'matched rates concatenate normally');
  }

  /* ── fades ─────────────────────────────────────────────────────────────── */
  {
    // 5 samples at SR: a 2-sample fade in ramps 0 → 1 across indices 0 and 1.
    const src = wavOf([1, 1, 1, 1, 1]);
    const faded = decodeWav(
      await (
        await applyFadesToBlob(src, { fadeInSec: 2 / SR, fadeOutSec: 2 / SR }, fakeFactory)
      ).blob.arrayBuffer(),
    );
    closeAll(faded.getChannelData(0), [0, 0.5, 1, 0.5, 0], 'linear in and out');

    // Clip gain multiplies the envelope's peak, exactly as `clipPeakGain` does
    // in live playback and in every offline bounce.
    const halved = decodeWav(
      await (await applyFadesToBlob(src, { gain: 0.5 }, fakeFactory)).blob.arrayBuffer(),
    );
    closeAll(halved.getChannelData(0), [0.5, 0.5, 0.5, 0.5, 0.5], 'gain with no fades');

    // Nothing to do = the samples come back untouched.
    const noop = decodeWav(await (await applyFadesToBlob(src, {}, fakeFactory)).blob.arrayBuffer());
    closeAll(noop.getChannelData(0), [1, 1, 1, 1, 1], 'no fades, no gain');

    // A fade longer than the clip cannot make the tail negative or wrap around.
    const over = decodeWav(
      await (await applyFadesToBlob(src, { fadeInSec: 100 }, fakeFactory)).blob.arrayBuffer(),
    );
    for (const v of over.getChannelData(0)) assert.ok(v >= 0 && v <= 1, `over-long fade stayed in range: ${v}`);
  }

  /* ── MIDI bounce / stretch ─────────────────────────────────────────────── */
  {
    const calls: Array<{ notes: unknown[]; bpm: number; totalSteps: number; program?: number }> = [];
    const render: StepNoteRenderer = async (notes, bpm, totalSteps, opts) => {
      calls.push({ notes, bpm, totalSteps, program: opts?.program });
      return { blob: new Blob(['rendered'], { type: 'audio/wav' }), duration: (totalSteps * (60 / bpm)) / 4 };
    };

    const midi = {
      id: 'm1',
      trackId: 't1',
      label: 'lead',
      audioBlob: new Blob(['x'], { type: 'audio/wav' }),
      mimeType: 'audio/wav',
      sourceDuration: 8,
      offsetIntoSource: 0,
      durationSec: 8,
      startSec: 0,
      color: '#fff',
      sourceKind: 'piano-roll',
      sourceBpm: 99,
      sourceTotalSteps: 32,
      instrumentProgram: 42,
      sourcePianoRoll: [{ id: 'n1', note: 60, step: 0, length: 4, velocity: 100 }],
    } satisfies AudioClip;

    const bounced = await bounceMidiClip(midi, { render });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bpm, 99, 'bounces at the clip source tempo');
    assert.equal(calls[0].totalSteps, 32);
    assert.equal(calls[0].program, 42, "the clip's instrument, not the global one");
    assert.equal(calls[0].notes, midi.sourcePianoRoll, 'the clip notes go straight through');
    assert.ok(bounced.blob instanceof Blob);
    close(bounced.duration, (32 * (60 / 99)) / 4, 'duration comes back from the renderer');

    // An explicit program overrides the clip's.
    await bounceMidiClip(midi, { render, program: 7 });
    assert.equal(calls[1].program, 7);

    // No stored grid length: fall back to the last note end, floored at 16
    // steps — the same fallback the editor uses when it re-renders a clip.
    const { sourceTotalSteps: _drop, ...noSteps } = midi;
    await bounceMidiClip({ ...noSteps } as AudioClip, { render });
    assert.equal(calls[2].totalSteps, 16, 'short pattern floors at one bar of 16ths');
    await bounceMidiClip({ ...noSteps, sourcePianoRoll: [{ id: 'n', note: 60, step: 20, length: 4, velocity: 90 }] } as AudioClip, { render });
    assert.equal(calls[3].totalSteps, 24, 'longer pattern uses the last note end');
    // A roll clip of 130,000 notes with no stored grid length (an imported
    // symphony): the fallback used to spread every note into Math.max, which
    // throws "Maximum call stack size exceeded" past about 125,000 arguments.
    const big = Array.from({ length: 130_000 }, (_, i) => ({ id: `b${i}`, note: 60 + (i % 24), step: i * 0.5, length: 1, velocity: 90 }));
    await bounceMidiClip({ ...noSteps, sourcePianoRoll: big } as AudioClip, { render });
    assert.equal(calls[calls.length - 1].totalSteps, 130_000 * 0.5 - 0.5 + 1, 'a huge pattern runs to its last note end');
    calls.splice(4);

    // 99 → 120 BPM is ratio 0.825, and a stretch re-renders at sourceBpm/ratio.
    const stretched = await stretchMidiClip(midi, 99 / 120, { render });
    close(calls[4].bpm, 120, 'stretch re-renders at the target tempo');
    assert.equal(calls[4].totalSteps, 32, 'the pattern itself is unchanged');
    close(stretched.duration, (32 * (60 / 120)) / 4, 'shorter, because it is faster');

    // Slowing down is the same relationship inverted.
    await stretchMidiClip(midi, 99 / 60, { render });
    close(calls[5].bpm, 60, 'a ratio above 1 renders slower');

    await assert.rejects(() => stretchMidiClip(midi, 0, { render }), /ratio/i);
    await assert.rejects(() => stretchMidiClip(midi, Number.NaN, { render }), /ratio/i);
    await assert.rejects(() => stretchMidiClip(midi, 0.01, { render }), /bpm/i, 'a tempo nothing can render');

    // Audio clips have no notes to re-render, and must say so rather than
    // silently producing silence.
    const audio = { ...midi, sourceKind: undefined, sourcePianoRoll: undefined } as AudioClip;
    await assert.rejects(() => bounceMidiClip(audio, { render }), /piano roll|not a midi/i);
    await assert.rejects(() => stretchMidiClip(audio, 1.5, { render }), /piano roll|not a midi/i);

    // No tempo anywhere is a refusal, not a guess.
    const noBpm = { ...midi, sourceBpm: undefined } as AudioClip;
    await assert.rejects(() => bounceMidiClip(noBpm, { render }), /bpm/i);
    assert.equal((await bounceMidiClip(noBpm, { render, bpm: 128 })).blob instanceof Blob, true);
    assert.equal(calls[calls.length - 1].bpm, 128, 'an explicit fallback tempo is honoured');
  }

  console.log('clipOps/audioOps: ok');
};

void run();
