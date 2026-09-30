/**
 * Import-cycle guard for the T18 startup-load gate.
 *
 * `rackEffects.ts` imports `vstLiveNode.ts`, and `effectChainStore.ts` imports
 * `rackEffects.ts` (it derives MIX_RACK_IDS from RACK_EFFECTS at module scope).
 * If `vstLiveNode.ts` imports `effectChainStore.ts` at runtime, loading
 * rackEffects FIRST evaluates effectChainStore before RACK_EFFECTS exists:
 * `ReferenceError: Cannot access 'RACK_EFFECTS' before initialization`. The
 * gate therefore reads the loaded signal from `lib/vstStateStorage.ts`, which
 * has no runtime imports. This runs in its own process (the test runner gives
 * every file one), so rackEffects really is the first module loaded.
 *
 * Run: npx tsx src/lib/vstLive/vstLiveNode.importCycle.test.ts
 */
import assert from 'node:assert/strict';

const rack = await import('../rackEffects.ts');
assert.ok(Array.isArray(rack.RACK_EFFECTS) && rack.RACK_EFFECTS.length > 0, 'rackEffects initialized');

const chain = await import('../../state/effectChainStore.ts');
assert.ok(chain.MIX_RACK_IDS instanceof Set && chain.MIX_RACK_IDS.size > 0, 'effectChainStore initialized after it');

const node = await import('./vstLiveNode.ts');
assert.equal(typeof node.createVstLiveNode, 'function');

console.log('vstLiveNode.importCycle: ok');
