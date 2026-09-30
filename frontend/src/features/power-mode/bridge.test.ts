import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { registerPowerModeBridge } from '../../lib/powerModeBridge';

const listeners = new Set<(event: MessageEvent) => void>();
const frames = new Map<number, FrameRequestCallback>();
const pluginWindow = {} as Window;
let nextFrame = 0;
const hostWindow = {
  addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
  removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
  document: { querySelectorAll: () => [{ contentWindow: pluginWindow }] },
};
Object.assign(globalThis, {
  window: hostWindow,
  document: hostWindow.document,
  requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; },
  cancelAnimationFrame: (frameId: number) => frames.delete(frameId),
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); frames.clear(); });

function harness() {
  let entry: { id: string; params: Record<string, number> } | null = { id: 'ares-entry', params: { untouched: 0.7 } };
  const updates: Array<{ id: string; params: Record<string, number> }> = [];
  const detach = registerPowerModeBridge({
    findEntry: () => entry,
    updateParams: (id, params) => updates.push({ id, params }),
  });
  cleanups.push(detach);
  return { updates, detach, setEntry: (next: typeof entry) => { entry = next; } };
}

function send(data: unknown, source: MessageEventSource | null = pluginWindow) {
  for (const listener of listeners) listener({ data, source } as MessageEvent);
}

function flush() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

test('coalesces runtime relay values, clamps and preserves current params', () => {
  const { updates, setEntry } = harness();
  send({ type: 'updateValue', id: 'lp4uxdj', value: 2 });
  send({ type: 'updateValue', id: 'pz6r4wt', value: -1 });
  send({ type: 'updateValue', id: 'lp4uxdj', value: 0.4 }, hostWindow as unknown as Window);
  assert.equal(frames.size, 1);
  setEntry({ id: 'ares-entry', params: { untouched: 0.9 } });
  flush();
  assert.deepEqual(updates, [{ id: 'ares-entry', params: { untouched: 0.9, grainsMix: 0.4, reverbMix: 0 } }]);
});

test('rejects malformed, nonfinite and inherited control ids', () => {
  const { updates } = harness();
  for (const data of [null, [], 'invalid', { type: 'updateValue', id: 'unknown', value: 1 },
    { type: 'updateValue', id: 'toString', value: 1 }, { type: 'updateValue', id: ['lp4uxdj'], value: 1 },
    ...[NaN, Infinity, -Infinity, '0.5', true].map(value => ({ type: 'updateValue', id: 'lp4uxdj', value }))]) send(data);
  flush();
  assert.deepEqual(updates, []);
});

test('ignores messages from unrelated windows and missing sources', () => {
  const { updates } = harness();
  send({ type: 'updateValue', id: 'lp4uxdj', value: 1 }, {} as Window);
  send({ type: 'updateValue', id: 'lp4uxdj', value: 1 }, null);
  flush();
  assert.deepEqual(updates, []);
});

test('replacement registration cancels pending work without stale cleanup detaching new owner', () => {
  const first = harness();
  send({ type: 'updateValue', id: 'lp4uxdj', value: 1 });
  const second = harness();
  first.detach();
  send({ type: 'updateValue', id: 'pgw6scm-activated', value: 1 });
  flush();
  assert.deepEqual(first.updates, []);
  assert.deepEqual(second.updates, [{ id: 'ares-entry', params: { untouched: 0.7, freeze: 1 } }]);
  second.detach();
  assert.equal(listeners.size, 0);
});

test('removed entries receive no queued updates', () => {
  const { updates, setEntry } = harness();
  send({ type: 'updateValue', id: 'lp4uxdj', value: 1 });
  setEntry(null);
  flush();
  assert.deepEqual(updates, []);
});
