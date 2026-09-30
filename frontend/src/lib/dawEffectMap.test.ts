/**
 * dawEffectMap — a parsed DAW device as a LIVE chain entry.
 *
 * Perform's per-track chains used to filter every plugin out before building,
 * because `buildEffectChain` knew only the rack effects. That reason is gone:
 * the builder has a hosted-plugin branch. But it only recognises ONE shape —
 * `effect: 'vst3'` with a `vst` node carrying the plugin path — and the
 * persisted interchange node deliberately does not use it (a plugin keeps its
 * own device name there, which is what the loader shows the user, and that
 * shape is the backend's model). Built from the interchange node, as the
 * Perform views used to be, a plugin resolves to no rack effect AND no plugin
 * path, so it can only ever be inert.
 *
 * `dawDeviceToChainEntry` is that second, additive conversion. This file pins
 * both halves: the live entry is hostable, and the persisted node is unchanged.
 *
 * Run: npx tsx src/lib/dawEffectMap.test.ts
 */
import assert from 'node:assert/strict';

import {
  dawDeviceToChainEntry,
  dawDeviceToEffectNode,
  isHostedPluginDevice,
} from './dawEffectMap.ts';
import type { DawDevice } from './dawImportClient.ts';

const device = (over: Partial<DawDevice> = {}): DawDevice =>
  ({ name: 'Device', parameters: {}, ...over }) as DawDevice;

const OZONE = device({
  name: 'Ozone 11',
  plugin_type: 'vst3',
  plugin_path: 'C:/Program Files/Common Files/VST3/Ozone 11.vst3',
});

/* ── a hosted plugin becomes an entry the chain builder can host ───────────── */
{
  const e = dawDeviceToChainEntry(OZONE, 'perform-0-2');
  assert.equal(e.id, 'perform-0-2', 'the caller owns the id — it is the session registry key');
  assert.equal(e.effect, 'vst3', 'the live vocabulary, not the device name');
  assert.equal(e.vst?.plugin_path, 'C:/Program Files/Common Files/VST3/Ozone 11.vst3');
  assert.equal(e.vst?.plugin_name, 'Ozone 11');
  assert.equal(e.enabled, true);
  assert.equal(e.label, 'Ozone 11');
  assert.equal(
    e.vst?.raw_state,
    undefined,
    'an imported project has no state either host can read, so the plugin starts clean',
  );
  assert.equal(e.vst?.state_host, undefined, 'and therefore names no host');
  assert.equal(isHostedPluginDevice(OZONE), true);
}

/* ── an AudioUnit is a plugin too ──────────────────────────────────────────── */
{
  const au = device({ name: 'AUCompressor', plugin_type: 'audiounit', plugin_path: '/Library/x.component' });
  assert.equal(dawDeviceToChainEntry(au, 'x').effect, 'vst3', 'both formats host through the same branch');
  assert.equal(isHostedPluginDevice(au), true);
}

/* ── a plugin with no resolvable path is NOT hostable ──────────────────────── */
{
  const ghost = device({ name: 'Missing Plugin', plugin_type: 'vst3' });
  const e = dawDeviceToChainEntry(ghost, 'g');
  assert.notEqual(e.effect, 'vst3', 'nothing to host: it stays a preserved-but-named device');
  assert.equal(e.vst, undefined);
  assert.equal(isHostedPluginDevice(ghost), false);
}

/* ── a path with no plugin_type is NOT hostable either ─────────────────────── *
 * This is the seam the two KEPT exclusion sites sit on. `performRouting`'s
 * `deviceFxRoute` refuses any device with a `plugin_path` at all — wider than
 * the test above — and that stays correct only while a path-without-type device
 * is unhostable here too. If this ever became hostable, that resolver would be
 * silently dropping a routable device. Pinned so the two cannot drift apart. */
{
  const typeless = device({ name: 'Mystery', plugin_path: 'C:/x/Mystery.vst3' });
  assert.equal(isHostedPluginDevice(typeless), false, 'a path alone does not identify a host format');
  assert.equal(dawDeviceToChainEntry(typeless, 't').vst, undefined);
}

/* ── a stock device still maps onto the rack, bypass and all ───────────────── */
{
  const e = dawDeviceToChainEntry(device({ name: 'Auto Pan', parameters: { Depth: 0.5 }, bypass: true }), 'p-1');
  assert.equal(e.effect, 'gater', 'the rack approximation is unchanged');
  assert.equal(e.enabled, false, 'a source-bypassed device arrives bypassed');
  assert.equal(e.vst, undefined);
  assert.equal(isHostedPluginDevice(device({ name: 'Auto Pan' })), false);
}

/* ── an unmapped device keeps its own name, so the user still sees it ──────── */
{
  const e = dawDeviceToChainEntry(device({ name: 'Weird Thing' }), 'w');
  assert.equal(e.effect, 'Weird Thing');
  assert.equal(e.vst, undefined);
}

/* ── the PERSISTED node is untouched: this conversion is additive ──────────── */
{
  const node = dawDeviceToEffectNode(OZONE);
  assert.equal(node.node_type, 'vst3');
  assert.equal(node.effect_name, 'Ozone 11', 'the file still carries the device name, not "vst3"');
  assert.equal(node.vst_state?.plugin_path, OZONE.plugin_path);
  const stock = dawDeviceToEffectNode(device({ name: 'Auto Pan', parameters: { Depth: 0.5 } }));
  assert.equal(stock.node_type, 'builtin');
  assert.equal(stock.effect_name, 'gater');
}

console.log('dawEffectMap: ok');
