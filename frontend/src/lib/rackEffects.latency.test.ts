/**
 * Declared effect latency: the chain accumulator and the summing-delay rule.
 *
 * These are the two pure pieces plugin delay compensation is built on. The
 * accumulator answers "how far behind is this chain's output?" and the summing
 * rule answers "given several inputs about to be summed, how much does each one
 * have to wait?". Neither touches Web Audio, so both run under plain tsx: the
 * registry comes in through `chainLatencySec`'s `resolve` seam, the same seam
 * `rackEffects.chain.test.ts` uses.
 *
 * What is pinned here:
 *
 *  - Only an entry that is BOTH enabled and resolvable counts. A bypassed
 *    effect is out of the audio path, so it delays nothing; an unknown id (every
 *    hosted `vst3` entry) is an inert passthrough live, so it delays nothing
 *    either — but it is reported, not silently dropped, so the UI can say the
 *    number excludes it.
 *  - A declaration may be a function of the entry's params (merged onto catalog
 *    defaults) and the sample rate, for effects whose latency is not constant.
 *  - `summingDelaysSec` aligns inputs by delaying each to the slowest one, and
 *    is a no-op when they already agree.
 *
 * Run: npx tsx src/lib/rackEffects.latency.test.ts
 */
import assert from 'node:assert/strict';

import {
  chainLatencyReport,
  chainLatencySec,
  getRackEffect,
  RACK_EFFECTS,
  summingDelaysSec,
  type RackEffectDef,
} from './rackEffects.ts';
import type { ChainEntry } from '../state/effectChainStore.ts';

/* ── fake registry (the resolve seam) ──────────────────────────────────────── */

const def = (
  id: string,
  latencySec: RackEffectDef['latencySec'],
  params: RackEffectDef['params'] = [],
): RackEffectDef => ({
  id,
  label: id,
  group: 'Test',
  description: id,
  params,
  latencySec,
  make: () => { throw new Error('the accumulator must never build a graph'); },
});

const seen: { params: Record<string, number>; sampleRate: number | undefined }[] = [];

const FAKE_DEFS = new Map<string, RackEffectDef>([
  ['fixed', def('fixed', 0.006)],
  ['free', def('free', undefined)],
  ['zero', def('zero', 0)],
  ['nan', def('nan', () => NaN)],
  ['negative', def('negative', -0.01)],
  [
    'varies',
    def(
      'varies',
      (params, sampleRate) => {
        seen.push({ params: { ...params }, sampleRate });
        return (params.window ?? 0) / (sampleRate ?? 48000);
      },
      [{ key: 'window', label: 'Window', min: 0, max: 4096, step: 1, default: 64 }],
    ),
  ],
]);

const resolve = (id: string) => FAKE_DEFS.get(id);

const entry = (
  id: string,
  effect: string,
  enabled = true,
  params: Record<string, number> = {},
): ChainEntry => ({ id, effect, enabled, params });

const near = (a: number, b: number, msg: string) =>
  assert.ok(Math.abs(a - b) < 1e-12, `${msg} (got ${a}, want ${b})`);

/* ── chainLatencySec ───────────────────────────────────────────────────────── */

assert.equal(chainLatencySec([], { resolve }), 0, 'an empty chain adds no latency');
assert.deepEqual(chainLatencyReport([], { resolve }), { totalSec: 0, perEntry: [] });

assert.equal(
  chainLatencySec([entry('a', 'fixed')], { resolve }),
  0.006,
  'one declared effect contributes exactly its declared value',
);

assert.equal(
  chainLatencySec([entry('a', 'free'), entry('b', 'zero')], { resolve }),
  0,
  'an undeclared latency and an explicit 0 both mean 0',
);

near(
  chainLatencySec([entry('a', 'fixed'), entry('b', 'fixed'), entry('c', 'free')], { resolve }),
  0.012,
  'series latency accumulates across the chain',
);

/* ── a nonsense declaration is neutralised, not propagated ─────────────────── */

{
  const entries = [entry('n', 'nan'), entry('m', 'negative')];
  assert.equal(
    chainLatencySec(entries, { resolve }),
    0,
    'NaN and a negative declaration both contribute exactly 0',
  );
  const rep = chainLatencyReport(entries, { resolve });
  assert.deepEqual(
    rep.perEntry,
    [
      { id: 'n', effect: 'nan', latencySec: 0, counted: true },
      { id: 'm', effect: 'negative', latencySec: 0, counted: true },
    ],
    'they still count — the entry IS in the live path, its declaration is just unusable',
  );
  assert.equal(rep.totalSec, 0);
}

/* ── bypass: in the chain, out of the path ─────────────────────────────────── */

{
  const entries = [entry('a', 'fixed', false), entry('b', 'fixed')];
  assert.equal(
    chainLatencySec(entries, { resolve }),
    0.006,
    'a bypassed effect is routed around, so it delays nothing',
  );
  const rep = chainLatencyReport(entries, { resolve });
  assert.deepEqual(rep.perEntry, [
    { id: 'a', effect: 'fixed', latencySec: 0, counted: false },
    { id: 'b', effect: 'fixed', latencySec: 0.006, counted: true },
  ]);
  near(rep.totalSec, 0.006, 'the report total matches the accumulator');
}

/* ── an unknown id counts 0 but stays visible ──────────────────────────────── */

{
  const entries = [entry('v', 'vst3'), entry('b', 'fixed')];
  assert.equal(
    chainLatencySec(entries, { resolve }),
    0.006,
    'an inert unknown effect contributes nothing to the live number',
  );
  const rep = chainLatencyReport(entries, { resolve });
  assert.deepEqual(rep.perEntry, [
    { id: 'v', effect: 'vst3', latencySec: 0, counted: false },
    { id: 'b', effect: 'fixed', latencySec: 0.006, counted: true },
  ]);
  assert.deepEqual(
    rep.perEntry.filter((e) => !e.counted).map((e) => e.effect),
    ['vst3'],
    'so the UI can name what the total excludes',
  );
}

/* ── a function-valued declaration sees params and the sample rate ─────────── */

{
  seen.length = 0;
  const got = chainLatencySec([entry('w', 'varies', true, { window: 256 })], {
    resolve,
    sampleRate: 44100,
  });
  near(got, 256 / 44100, 'the function result is used as the declared latency');
  assert.equal(seen.length, 1, 'the declaration was evaluated exactly once');
  assert.equal(seen[0].sampleRate, 44100, 'it receives the accumulator sample rate');
  assert.deepEqual(seen[0].params, { window: 256 }, 'and the entry params');
}

{
  seen.length = 0;
  const got = chainLatencySec([entry('w', 'varies')], { resolve, sampleRate: 48000 });
  near(got, 64 / 48000, 'an unauthored param falls back to the catalog default');
  assert.deepEqual(seen[0].params, { window: 64 }, 'defaults are merged in before evaluation');
}

{
  seen.length = 0;
  chainLatencySec([entry('w', 'varies', true, { window: 128 })], { resolve });
  assert.equal(seen[0].sampleRate, undefined, 'no sample rate is invented when none is supplied');
}

{
  seen.length = 0;
  const rep = chainLatencyReport([entry('w', 'varies', false, { window: 256 })], {
    resolve,
    sampleRate: 44100,
  });
  assert.equal(rep.totalSec, 0, 'a bypassed function-valued effect contributes nothing');
  assert.equal(seen.length, 0, 'and its declaration is never evaluated');
}

/* ── the real registry declares the compressor and nothing else ────────────── */

{
  const compressor = getRackEffect('compressor');
  assert.ok(compressor, 'the compressor is in the rack');
  assert.equal(
    compressor.latencySec,
    0.006,
    "the native DynamicsCompressor's spec look-ahead is declared, in seconds",
  );
  assert.equal(
    chainLatencySec([entry('c', 'compressor')]),
    0.006,
    'and the accumulator reads the real registry when no resolve seam is given',
  );

  // Asserted over the WHOLE registry, not an allowlist, so an effect added later
  // cannot quietly declare a latency without this test being updated with it.
  assert.deepEqual(
    RACK_EFFECTS.filter((d) => d.latencySec !== undefined).map((d) => d.id),
    ['compressor'],
    'every other effect is undelayed-dry, sample-aligned, or has no honest constant',
  );
}

/* ── summingDelaysSec ──────────────────────────────────────────────────────── */

assert.deepEqual(summingDelaysSec([]), [], 'nothing to align');
assert.deepEqual(summingDelaysSec([0.006]), [0], 'a single input is already the slowest');
assert.deepEqual(summingDelaysSec([0.006, 0]), [0, 0.006], 'the early input waits for the late one');
assert.deepEqual(summingDelaysSec([0, 0.006]), [0.006, 0], 'in either order');
assert.deepEqual(
  summingDelaysSec([0.006, 0.006, 0.006]),
  [0, 0, 0],
  'inputs that already agree are not delayed at all',
);
assert.deepEqual(summingDelaysSec([0, 0, 0]), [0, 0, 0], 'nor are inputs with no latency');
assert.deepEqual(
  summingDelaysSec([0.01, 0.004, 0]),
  [0, 0.006, 0.01],
  'each input is delayed to the slowest one',
);
assert.ok(
  summingDelaysSec([0.01, 0.004, 0]).every((d) => d >= 0),
  'no input is ever asked to move earlier',
);
assert.deepEqual(
  summingDelaysSec([0.006, NaN, -1]),
  [0, 0.006, 0.006],
  'a NaN or negative input is read as 0 latency and can never skew or reach the result',
);
assert.ok(
  summingDelaysSec([NaN, Infinity, -1]).every((d) => Number.isFinite(d) && d >= 0),
  'every delay is finite and non-negative — setTargetAtTime throws otherwise',
);

/* ── a LIVE hosted VST3 counts, because it really is in the path ────────────
   The block above pins the other half: a `vst3` entry with no live session
   contributes 0 and stays `counted: false`. Once a session is live the plugin
   IS processing, and its latency — the plugin's own plus the bridge's fixed
   play-out buffer — delays everything behind it. If it did not count here, the
   mixer would compensate every other track by the wrong amount, which is
   exactly what "inert" used to mean and no longer does.

   `liveLatencySec` is the seam `vstLiveStore.vstLiveLatencySec` fills in
   production; it answers 0 for every entry that is not live, which is why the
   inert cases above need no store at all. */
{
  const live = { v1: 0.032 }; // 1024 plugin samples + 1536 bridge, at 48 kHz
  const liveLatencySec = (id: string) => live[id as keyof typeof live] ?? 0;
  const entries = [entry('v1', 'vst3'), entry('b', 'fixed'), entry('v2', 'vst3')];

  const rep = chainLatencyReport(entries, { resolve, liveLatencySec });
  assert.deepEqual(rep.perEntry, [
    { id: 'v1', effect: 'vst3', latencySec: 0.032, counted: true },
    { id: 'b', effect: 'fixed', latencySec: 0.006, counted: true },
    { id: 'v2', effect: 'vst3', latencySec: 0, counted: false },
  ], 'the live plugin counts; the one that never opened does not');
  near(rep.totalSec, 0.038, 'and the total is the sum of what is actually in the path');
  assert.equal(chainLatencySec(entries, { resolve, liveLatencySec }), rep.totalSec);

  // Bypass still wins over liveness: a bypassed entry is routed AROUND, so
  // whatever its session reports, it delays nothing.
  const bypassed = chainLatencyReport([entry('v1', 'vst3', false)], { resolve, liveLatencySec });
  assert.deepEqual(bypassed.perEntry, [{ id: 'v1', effect: 'vst3', latencySec: 0, counted: false }]);
  assert.equal(bypassed.totalSec, 0, 'a bypassed plugin is not in the path, live session or not');

  // Only `vst3` entries consult the seam: an imported DAW effect has no live
  // host to ask, and must not pick up a latency because its id collided.
  const imported = chainLatencyReport([entry('v1', 'imported-x')], {
    resolve,
    liveLatencySec: () => 0.5,
  });
  assert.deepEqual(imported.perEntry, [{ id: 'v1', effect: 'imported-x', latencySec: 0, counted: false }]);

  // A negative or non-finite answer cannot reach the accumulator: these numbers
  // end up on a DelayNode, which throws on a non-finite target.
  const hostile = chainLatencyReport([entry('v1', 'vst3')], { resolve, liveLatencySec: () => -1 });
  assert.deepEqual(hostile.perEntry, [{ id: 'v1', effect: 'vst3', latencySec: 0, counted: false }]);
}

console.log('rackEffects latency: chain accumulator counts only live effects, summing aligns to the slowest — passed');
