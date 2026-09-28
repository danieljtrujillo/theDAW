// The measured concert-hall responses (lib/hallIrs) and the Reverb that plays
// them (rackEffects makeReverb).
//
// There is no Web Audio under tsx, so the context is fake. The Reverb is the
// real registry's `make`: what is pinned is what the shipped device builds.
//
// Run: npx tsx src/lib/hallIrs.test.ts
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HALL_IR_HALLS,
  HALL_IR_POSITIONS,
  HALL_OPTION_LABELS,
  POSITION_OPTION_LABELS,
  cachedHallIr,
  ensureHallIrsForChains,
  hallIrLabel,
  hallIrUrl,
  hallIrUrlsInChains,
  loadHallIr,
  resetHallIrCacheForTests,
} from './hallIrs.ts';
import { getRackEffect, rackEffectDefaults } from './rackEffects.ts';
import type { ChainEntry } from '../state/effectChainStore.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

/* ── a fake context: enough for the real Reverb factory ─────────────────── */

interface FakeBuffer { tag: string; sampleRate: number }

const param = () => ({
  value: 0,
  setValueAtTime(v: number) { this.value = v; },
  setTargetAtTime(v: number) { this.value = v; },
});

const node = (kind: string) => ({
  kind,
  gain: param(),
  frequency: param(),
  delayTime: param(),
  type: '',
  buffer: null as FakeBuffer | null,
  channelCount: 2,
  channelCountMode: 'max' as string,
  connect(n: unknown) { return n; },
  disconnect() {},
});

const fakeCtx = (sampleRate: number, decode?: (bytes: ArrayBuffer) => Promise<FakeBuffer>) => {
  const convolvers: ReturnType<typeof node>[] = [];
  let synthesized = 0;
  const ctx = {
    sampleRate,
    currentTime: 0,
    convolvers,
    get synthesized() { return synthesized; },
    decodes: 0,
    createGain: () => node('gain'),
    createDelay: () => node('delay'),
    createBiquadFilter: () => node('filter'),
    createConvolver: () => {
      const c = node('convolver');
      convolvers.push(c);
      return c;
    },
    createBuffer: (channels: number, length: number, rate: number) => {
      synthesized += 1;
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { tag: `synth-${synthesized}`, sampleRate: rate, getChannelData: (c: number) => data[c] };
    },
    decodeAudioData: async (bytes: ArrayBuffer): Promise<FakeBuffer> => {
      ctx.decodes += 1;
      if (decode) return decode(bytes);
      return { tag: new TextDecoder().decode(bytes), sampleRate };
    },
  };
  return ctx;
};

type Ctx = ReturnType<typeof fakeCtx>;
const asCtx = (c: Ctx) => c as unknown as BaseAudioContext;

/** A fetcher that answers each URL with its own text, counting calls. */
const textFetcher = () => {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    return new TextEncoder().encode(url).buffer as ArrayBuffer;
  };
  return { calls, fetcher };
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const reverb = getRackEffect('reverb')!;
const make = (ctx: Ctx, params: Record<string, number>) => reverb.make(asCtx(ctx), { ...rackEffectDefaults('reverb'), ...params });

/* ── 1. The catalog: every option names a file that ships ─────────────── */
{
  assert.equal(HALL_OPTION_LABELS.length, HALL_IR_HALLS.length + 1, 'the synthesized room plus each hall');
  assert.equal(HALL_OPTION_LABELS[0], 'Synthetic room');
  HALL_IR_HALLS.forEach((h, i) => assert.equal(h.value, i + 1, 'option i of the select is value i'));
  HALL_IR_POSITIONS.forEach((p, i) => assert.equal(p.value, i, 'option i of the select is value i'));
  assert.equal(POSITION_OPTION_LABELS.length, 9, 'the whole stage and eight positions');

  let total = 0;
  for (const h of HALL_IR_HALLS) {
    for (const p of HALL_IR_POSITIONS) {
      const url = hallIrUrl(h.value, p.value)!;
      const file = join(PUBLIC, ...url.split('/').filter(Boolean));
      assert.ok(existsSync(file), `${url} ships`);
      const bytes = readFileSync(file);
      assert.equal(bytes.subarray(0, 4).toString('latin1'), 'fLaC', `${url} is a FLAC file`);
      total += statSync(file).size;
    }
  }
  assert.ok(total < 2 * 1024 * 1024, `the bundled responses stay under 2 MB (${total} bytes)`);
  const attribution = readFileSync(join(PUBLIC, 'irs', 'ATTRIBUTION.txt'), 'utf8');
  assert.match(attribution, /CC BY 4\.0/, 'the licence is recorded');
  assert.match(attribution, /zenodo\.4116247/, 'with the source record');
  // Nothing under irs/ that the attribution file does not cover.
  const dirs = readdirSync(join(PUBLIC, 'irs'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  assert.deepEqual(dirs, ['detmold-konzerthaus']);

  assert.equal(hallIrUrl(0, 3), null, 'hall 0 is the synthesized room');
  assert.equal(hallIrUrl(undefined, undefined), null, 'an entry saved before halls existed plays the room');
  assert.equal(hallIrUrl(1, 6), '/irs/detmold-konzerthaus/seat-211/s6.flac');
  assert.equal(hallIrUrl(2, 99), '/irs/detmold-konzerthaus/seat-372/stage.flac', 'an unknown position is the whole stage');
  assert.equal(hallIrUrl(7, 1), null, 'an unknown hall is the room');
  assert.equal(hallIrLabel(1, 1), 'Detmold Konzerthaus, front stalls · Front far left');
  assert.equal(hallIrLabel(0, 1), 'Synthetic room');
}

/* ── 2. The device's params: a select for each, labelled ─────────────── */
{
  const hall = reverb.params.find((p) => p.key === 'hall')!;
  const pos = reverb.params.find((p) => p.key === 'position')!;
  assert.equal(hall.kind, 'select');
  assert.equal(pos.kind, 'select');
  assert.equal(hall.label, 'Hall');
  assert.equal(pos.label, 'Stage position');
  assert.deepEqual(hall.options, HALL_OPTION_LABELS);
  assert.equal(hall.max, HALL_OPTION_LABELS.length - 1);
  assert.equal(pos.max, POSITION_OPTION_LABELS.length - 1);
  assert.equal(rackEffectDefaults('reverb').hall, 0, 'the synthesized room stays the default');
  const synthPresets = reverb.presets!.filter((p) => ['Room', 'Plate', 'Hall', 'Cathedral'].includes(p.label));
  assert.ok(synthPresets.every((p) => p.values.hall === 0), 'a room preset leaves a measured hall');
  assert.ok(reverb.presets!.some((p) => p.values.hall === 1), 'a preset reaches the hall');
}

/* ── 3. Loading: one fetch per file, one decode per file and rate ────── */
{
  const { calls, fetcher } = textFetcher();
  resetHallIrCacheForTests(fetcher);
  const url = hallIrUrl(1, 2)!;
  const a = fakeCtx(48000);
  const [x, y] = await Promise.all([loadHallIr(asCtx(a), url), loadHallIr(asCtx(a), url)]);
  assert.equal(x, y, 'two loads at once share one decode');
  assert.equal(a.decodes, 1);
  assert.equal(calls.length, 1);
  assert.equal(cachedHallIr(url, 48000), x, 'the decode is cached for its rate');
  assert.equal(cachedHallIr(url, 44100), undefined, 'and only for its rate');
  const b = fakeCtx(44100);
  await loadHallIr(asCtx(b), url);
  assert.equal(calls.length, 1, 'another rate decodes the bytes already fetched');
  assert.equal(b.decodes, 1);
}

/* ── 4. A file that fails resolves null and is tried again ───────────── */
{
  let fail = true;
  resetHallIrCacheForTests(async (url) => {
    if (fail) throw new Error('offline');
    return new TextEncoder().encode(url).buffer as ArrayBuffer;
  });
  const ctx = fakeCtx(48000);
  const url = hallIrUrl(1, 1)!;
  assert.equal(await loadHallIr(asCtx(ctx), url), null);
  fail = false;
  assert.ok(await loadHallIr(asCtx(ctx), url), 'the next load fetches again');
}

/* ── 5. What a bounce preloads: enabled Reverbs on a hall ───────────── */
{
  const entry = (id: string, params: Record<string, number>, enabled = true, effect = 'reverb'): ChainEntry => ({ id, effect, params, enabled });
  const chains = [
    [entry('a', { hall: 1, position: 1 }), entry('b', { hall: 0 })],
    undefined,
    [entry('c', { hall: 1, position: 1 }), entry('d', { hall: 2, position: 5 }, false), entry('e', { hall: 2 }, true, 'delay')],
    [entry('f', { hall: 2, position: 8 })],
  ];
  assert.deepEqual(hallIrUrlsInChains(chains), [
    '/irs/detmold-konzerthaus/seat-211/s1.flac',
    '/irs/detmold-konzerthaus/seat-372/s8.flac',
  ]);
  const { calls, fetcher } = textFetcher();
  resetHallIrCacheForTests(fetcher);
  const ctx = fakeCtx(44100);
  await ensureHallIrsForChains(asCtx(ctx), chains);
  assert.equal(calls.length, 2);
  assert.ok(cachedHallIr('/irs/detmold-konzerthaus/seat-372/s8.flac', 44100));
}

/* ── 6. The Reverb: the synthesized room by default ──────────────────── */
{
  resetHallIrCacheForTests(textFetcher().fetcher);
  const ctx = fakeCtx(48000);
  make(ctx, {});
  assert.equal(ctx.synthesized, 1);
  assert.match(ctx.convolvers[0].buffer!.tag, /^synth/);
  assert.equal(ctx.decodes, 0, 'the room loads no file');
}

/* ── 7. An offline bounce: loaded first, the hall from the first sample ─ */
{
  resetHallIrCacheForTests(textFetcher().fetcher);
  const ctx = fakeCtx(48000);
  const entry: ChainEntry = { id: 'r', effect: 'reverb', enabled: true, params: { hall: 1, position: 6 } };
  await ensureHallIrsForChains(asCtx(ctx), [[entry]]);
  make(ctx, entry.params);
  assert.equal(ctx.convolvers[0].buffer!.tag, '/irs/detmold-konzerthaus/seat-211/s6.flac');
  assert.equal(ctx.synthesized, 0, 'no room was synthesized on the way');
}

/* ── 8. Live: the room until the file lands, then the hall ───────────── */
{
  resetHallIrCacheForTests(textFetcher().fetcher);
  const ctx = fakeCtx(48000);
  const inst = make(ctx, { hall: 2, position: 3 });
  const conv = ctx.convolvers[0];
  assert.match(conv.buffer!.tag, /^synth/, 'never silence while the file loads');
  assert.deepEqual([conv.channelCount, conv.channelCountMode], [2, 'clamped-max'], 'the room takes stereo in');
  await flush();
  assert.equal(conv.buffer!.tag, '/irs/detmold-konzerthaus/seat-372/s3.flac');
  assert.deepEqual([conv.channelCount, conv.channelCountMode], [1, 'explicit'], 'a measured hall takes one source in, as it was measured');

  // Back to the room, then to a cached hall: each lands at once.
  inst.setParams({ ...rackEffectDefaults('reverb'), hall: 0, decay: 3 });
  assert.match(conv.buffer!.tag, /^synth/);
  assert.equal(conv.channelCount, 2, 'back to stereo in for the room');
  inst.setParams({ ...rackEffectDefaults('reverb'), hall: 2, position: 3 });
  assert.equal(conv.buffer!.tag, '/irs/detmold-konzerthaus/seat-372/s3.flac');
}

/* ── 9. A load that lands after the params moved on is dropped ───────── */
{
  resetHallIrCacheForTests(textFetcher().fetcher);
  const ctx = fakeCtx(48000);
  const inst = make(ctx, { hall: 1, position: 1 });
  inst.setParams({ ...rackEffectDefaults('reverb'), hall: 1, position: 2 });
  await flush();
  assert.equal(ctx.convolvers[0].buffer!.tag, '/irs/detmold-konzerthaus/seat-211/s2.flac', 'the position asked for last wins');

  const gone = fakeCtx(48000);
  resetHallIrCacheForTests(textFetcher().fetcher);
  const dead = make(gone, { hall: 1, position: 4 });
  dead.dispose();
  await flush();
  assert.match(gone.convolvers[0].buffer!.tag, /^synth/, 'a disposed Reverb takes no late file');
}

resetHallIrCacheForTests();
console.log('hallIrs: ok');
