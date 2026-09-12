/**
 * Output routing: capability tiers and the element registry.
 *
 * The tier check decides whether the main-output control is a dropdown or a
 * disabled row with a reason, so "does this runtime have setSinkId" has to be
 * answered per API, not once. The registry is what lets the loose <audio>
 * elements (mic take preview, inpaint preview, Nodefi) follow a device change
 * they never subscribed to — including one that mounts after the change.
 *
 * Run: npx tsx src/lib/audioSink.test.ts
 */
import assert from 'node:assert/strict';

const g = globalThis as unknown as Record<string, unknown>;

class NoSinkContext {}
class SinkContext {
  setSinkId(): Promise<void> {
    return Promise.resolve();
  }
}
class NoSinkMedia {}
class SinkMedia {
  setSinkId(): Promise<void> {
    return Promise.resolve();
  }
}

g.AudioContext = SinkContext;
g.HTMLMediaElement = SinkMedia;

const {
  applyElementSink,
  refreshSinkElements,
  registerSinkElement,
  registeredSinkCount,
  setSinkResolver,
  supportsContextSink,
  supportsElementSink,
} = await import('./audioSink.ts');

/* ── tier detection, per API, read at call time ──────────────────────────── */

assert.equal(supportsContextSink(), true);
assert.equal(supportsElementSink(), true);

// Chromium before 110 / Firefox: an element can move, the whole graph cannot.
// This is the case where the main-output select must be disabled with a reason
// while the DJ cue select keeps working.
g.AudioContext = NoSinkContext;
assert.equal(supportsContextSink(), false, 'no context sink → main output is not offered');
assert.equal(supportsElementSink(), true, 'the cue bus still routes');

// Neither.
g.HTMLMediaElement = NoSinkMedia;
assert.equal(supportsElementSink(), false);

// Nothing at all (the tsx/node runs these suites in).
g.AudioContext = undefined;
g.HTMLMediaElement = undefined;
assert.equal(supportsContextSink(), false, 'an absent global is not a crash');
assert.equal(supportsElementSink(), false);

g.AudioContext = SinkContext;
g.HTMLMediaElement = SinkMedia;

/* ── applying to one element ─────────────────────────────────────────────── */

interface FakeEl {
  sinkId: string;
  calls: string[];
  setSinkId(id: string): Promise<void>;
}

const makeEl = (opts: { fail?: boolean } = {}): FakeEl => ({
  sinkId: '',
  calls: [],
  async setSinkId(id: string) {
    this.calls.push(id);
    if (opts.fail) throw new Error('NotAllowedError');
    this.sinkId = id;
  },
});

{
  const el = makeEl();
  assert.equal(await applyElementSink(el as unknown as HTMLMediaElement, 'spk-1'), true);
  assert.deepEqual(el.calls, ['spk-1']);
  // Already there: no redundant call (setSinkId on a playing element glitches).
  assert.equal(await applyElementSink(el as unknown as HTMLMediaElement, 'spk-1'), true);
  assert.deepEqual(el.calls, ['spk-1']);
}

{
  // A rejected device must not throw out of the apply layer — the element keeps
  // playing where it was.
  const el = makeEl({ fail: true });
  assert.equal(await applyElementSink(el as unknown as HTMLMediaElement, 'gone'), false);
}

{
  // An element on a runtime with no setSinkId at all.
  const plain = { sinkId: '' } as unknown as HTMLMediaElement;
  assert.equal(await applyElementSink(plain, 'spk-1'), false);
}

/* ── the registry ────────────────────────────────────────────────────────── */

let current: Record<string, string> = { preview: 'spk-1', inpaint: '' };
setSinkResolver((surface) => current[surface] ?? '');

const preview = makeEl();
const dispose = registerSinkElement('preview', preview as unknown as HTMLMediaElement);
await Promise.resolve();
assert.deepEqual(preview.calls, ['spk-1'], 'registering applies the current setting at once');
assert.equal(registeredSinkCount(), 1);

// The user picks a different output. Every registered element follows without
// having subscribed to anything.
current = { preview: 'spk-2', inpaint: 'spk-2' };
refreshSinkElements();
await Promise.resolve();
assert.deepEqual(preview.calls, ['spk-1', 'spk-2']);

// An element that mounts AFTER the change still lands on the right device.
const late = makeEl();
const disposeLate = registerSinkElement('preview', late as unknown as HTMLMediaElement);
await Promise.resolve();
assert.deepEqual(late.calls, ['spk-2'], 'a late element is not stuck on the default');
assert.equal(registeredSinkCount(), 2);

// A surface with no override resolves to '' — the OS default, explicitly.
const mod = makeEl();
current = { preview: 'spk-2', inpaint: '' };
const disposeMod = registerSinkElement('inpaint', mod as unknown as HTMLMediaElement);
await Promise.resolve();
assert.deepEqual(mod.calls, [], 'already on the default, so nothing is called');

// Unmounting stops the element following (and drops the reference).
dispose();
assert.equal(registeredSinkCount(), 2);
current = { preview: 'spk-3', inpaint: 'spk-3' };
refreshSinkElements();
await Promise.resolve();
assert.deepEqual(preview.calls, ['spk-1', 'spk-2'], 'a disposed element is never touched again');
assert.deepEqual(late.calls, ['spk-2', 'spk-3']);

disposeLate();
disposeMod();
assert.equal(registeredSinkCount(), 0);

// A null ref (the element has not mounted yet) is a no-op, not a crash.
const noop = registerSinkElement('preview', null);
noop();
assert.equal(registeredSinkCount(), 0);

// Installing a new resolver re-applies immediately.
const fresh = makeEl();
registerSinkElement('preview', fresh as unknown as HTMLMediaElement);
await Promise.resolve();
setSinkResolver(() => 'spk-9');
await Promise.resolve();
assert.equal(fresh.calls.at(-1), 'spk-9');

console.log('audioSink tiers + element registry passed');
