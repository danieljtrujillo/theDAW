/**
 * Cross-origin isolation probe — and the fact that live VST hosting no longer
 * sits behind it (see the `liveVstStatus` section at the bottom).
 *
 * Every assertion here drives `globalThis` directly, because that is the only
 * input these helpers have: a page is isolated or it is not, and the answer has
 * to be read at CALL time, not at module load. A cached answer is the bug this
 * file exists to prevent — the module is imported during boot, and in Electron
 * the renderer's first document can be swapped for one served with different
 * headers, so a value frozen at import would be stale and a worklet would be
 * handed a SharedArrayBuffer that cannot exist.
 *
 * Run: `npx tsx src/lib/sabSupport.test.ts`
 */
import assert from 'node:assert/strict';

const g = globalThis as unknown as {
  crossOriginIsolated?: unknown;
  SharedArrayBuffer?: unknown;
};

const realSab = g.SharedArrayBuffer;

/** Put `globalThis` in a known state: isolation flag + SharedArrayBuffer. */
function stub(isolated: unknown, sab: unknown): void {
  if (isolated === undefined) delete g.crossOriginIsolated;
  else Object.defineProperty(g, 'crossOriginIsolated', { value: isolated, configurable: true, writable: true });
  if (sab === undefined) delete g.SharedArrayBuffer;
  else Object.defineProperty(g, 'SharedArrayBuffer', { value: sab, configurable: true, writable: true });
}

const { isCrossOriginIsolated, sabAvailable, liveVstStatus } = await import('./sabSupport.ts');

// --- isCrossOriginIsolated ------------------------------------------------
// The flag is absent in Node and in any browser context that never got the
// headers; absent must read as "not isolated", never as a crash.
stub(undefined, realSab);
assert.equal(isCrossOriginIsolated(), false, 'an absent crossOriginIsolated flag is not isolation');

stub(false, realSab);
assert.equal(isCrossOriginIsolated(), false, 'a false flag is not isolation');

stub(true, realSab);
assert.equal(isCrossOriginIsolated(), true, 'a true flag is isolation');

// Only the boolean true counts. A truthy string ("yes", or a stray polyfill)
// must not open the gate, because SharedArrayBuffer would still be missing.
stub('yes', realSab);
assert.equal(isCrossOriginIsolated(), false, 'only boolean true counts as isolation');

// The answer is re-read every call, so flipping the flag flips the answer
// without re-importing the module.
stub(true, realSab);
assert.equal(isCrossOriginIsolated(), true);
stub(false, realSab);
assert.equal(isCrossOriginIsolated(), false, 'the flag is read per call, not cached at import');

// --- sabAvailable ---------------------------------------------------------
// Both halves are required: the constructor exists in plenty of non-isolated
// pages (it is only the *shared* memory that is gated), and isolation without
// the constructor happens in stripped-down runtimes.
stub(true, realSab);
assert.equal(sabAvailable(), true, 'isolated + constructor present');

stub(false, realSab);
assert.equal(sabAvailable(), false, 'the constructor alone is not enough');

stub(true, undefined);
assert.equal(sabAvailable(), false, 'isolation alone is not enough');

stub(undefined, undefined);
assert.equal(sabAvailable(), false, 'neither half present');

// --- liveVstStatus --------------------------------------------------------
// This no longer reports isolation AT ALL. The live host that was actually
// built moves audio over a MessagePort and a loopback WebSocket, neither of
// which is gated on cross-origin isolation — so the old answer sent users to
// fix headers that were never the problem. What it reports now is whether the
// backend found a host BINARY, which lives in vstLiveStore.
const { useVstLiveStore } = await import('../state/vstLiveStore.ts');

// Un-isolated is deliberately exercised throughout: isolation must not change
// a single one of these answers.
stub(false, realSab);

useVstLiveStore.setState({ host: { available: null } });
const unknown = liveVstStatus();
assert.equal(unknown.available, null, 'not probed yet is NOT "no" — a node opens optimistically');
assert.match(unknown.reason, /check/i, 'and the row says it is still looking');

useVstLiveStore.setState({ host: { available: true, path: 'C:/x/thedaw-vst-host.exe' } });
const on = liveVstStatus();
assert.equal(on.available, true);
assert.ok(on.reason.length > 0);

useVstLiveStore.setState({ host: { available: false, reason: 'thedaw-vst-host.exe not built' } });
const off = liveVstStatus();
assert.equal(off.available, false);
assert.equal(off.reason, 'thedaw-vst-host.exe not built', 'the backend’s own sentence is shown verbatim');

// An unavailable host with no explanation still gets one: the reason is
// rendered into a title attribute, and an empty title is an invisible tooltip.
useVstLiveStore.setState({ host: { available: false } });
assert.ok(liveVstStatus().reason.length > 0, 'every branch yields a reason to show');

// Isolation is irrelevant now, and this is the assertion that keeps it that
// way: the same host state must read identically in both worlds.
useVstLiveStore.setState({ host: { available: true } });
stub(true, realSab);
const isolated = liveVstStatus();
stub(false, realSab);
const plain = liveVstStatus();
assert.deepEqual(isolated, plain, 'cross-origin isolation does not change live VST availability');
for (const s of [isolated, plain]) {
  assert.ok(!s.reason.includes('theDAW_ISOLATE'), 'and no branch sends the user after the headers');
  assert.ok(!/isolat/i.test(s.reason), 'nor mentions isolation at all');
}

stub(undefined, realSab);
console.log('sabSupport: all assertions passed');
