import assert from 'node:assert/strict';

import {
  sanitizeVstEditorPrefs,
  useVstEditorPrefs,
  type VstEditorMode,
} from './vstEditorPrefsStore.ts';

// Runs under plain node (no DOM, no localStorage): the store must construct
// with its defaults, work without storage, and never throw on persistence.

const vp = () => useVstEditorPrefs.getState();
const PQ = 'C:\\Program Files\\Common Files\\VST3\\FabFilter Pro-Q 4.vst3';
const VALHALLA = '/usr/lib/vst3/ValhallaRoom.vst3';

/* -------------------------------- defaults -------------------------------- */
{
  vp().reset();
  const s = vp();
  assert.equal(s.defaultMode, 'embedded', 'embedding in the panel is the default');
  assert.deepEqual(s.byPluginPath, {});
  assert.equal(s.modeFor(PQ), 'embedded', 'an unknown path follows the default');
  assert.equal(s.modeFor(''), 'embedded', 'an empty path still answers the default');
}

/* ------------------------------ default mode ------------------------------ */
{
  vp().reset();
  vp().setDefaultMode('floating');
  assert.equal(vp().defaultMode, 'floating');
  assert.equal(vp().modeFor(PQ), 'floating', 'the default moves every un-overridden plugin');
  vp().setDefaultMode('windowed' as VstEditorMode);
  assert.equal(vp().defaultMode, 'floating', 'an unknown mode is ignored');
  vp().setDefaultMode('embedded');
  assert.equal(vp().defaultMode, 'embedded');
}

/* --------------------------- per-path overrides --------------------------- */
{
  vp().reset();
  vp().setModeForPlugin(PQ, 'floating');
  assert.equal(vp().modeFor(PQ), 'floating');
  assert.equal(vp().modeFor(VALHALLA), 'embedded', 'an override is per path, not global');
  assert.deepEqual(vp().byPluginPath, { [PQ]: 'floating' });

  // The override wins over the default in BOTH directions, so a plugin pinned
  // to the panel stays embedded even after the default flips to floating.
  vp().setModeForPlugin(VALHALLA, 'embedded');
  vp().setDefaultMode('floating');
  assert.equal(vp().modeFor(VALHALLA), 'embedded');
  assert.equal(vp().modeFor(PQ), 'floating');
  assert.equal(vp().modeFor('/plugins/Unknown.vst3'), 'floating');

  vp().setModeForPlugin(PQ, 'embedded');
  assert.equal(vp().modeFor(PQ), 'embedded', 'an override is replaced, not merged');

  vp().clearModeForPlugin(PQ);
  assert.equal(PQ in vp().byPluginPath, false);
  assert.equal(vp().modeFor(PQ), 'floating', 'a cleared path follows the default again');
  // Clearing a path that has no override is a no-op, not a crash.
  const before = vp().byPluginPath;
  vp().clearModeForPlugin('/nothing/here.vst3');
  assert.equal(vp().byPluginPath, before, 'a no-op clear keeps the same object');
}

/* ------------------------------ bad arguments ----------------------------- */
{
  vp().reset();
  vp().setModeForPlugin(PQ, 'popup' as VstEditorMode);
  assert.deepEqual(vp().byPluginPath, {}, 'an unknown mode is not recorded');
  vp().setModeForPlugin('', 'floating');
  assert.deepEqual(vp().byPluginPath, {}, 'an empty path is not recorded');
  vp().setModeForPlugin(7 as unknown as string, 'floating');
  assert.deepEqual(vp().byPluginPath, {}, 'a non-string path is not recorded');
  assert.equal(vp().modeFor(null as unknown as string), 'embedded', 'a junk path answers the default');
}

/* -------------------------------- reset ----------------------------------- */
{
  vp().setDefaultMode('floating');
  vp().setModeForPlugin(PQ, 'embedded');
  vp().setModeForPlugin(VALHALLA, 'floating');
  vp().reset();
  const s = vp();
  assert.equal(s.defaultMode, 'embedded');
  assert.deepEqual(s.byPluginPath, {});
  // reset hands out a fresh map, so a later write cannot reach a previous one.
  vp().setModeForPlugin(PQ, 'floating');
  vp().reset();
  assert.deepEqual(vp().byPluginPath, {});
}

/* ---------------------- corrupted persisted blob -------------------------- */
// sanitizeVstEditorPrefs IS the store's merge and migrate: zustand's persist
// hydrate cannot be driven from node, so it is pinned directly.
{
  vp().reset();
  const current = vp();

  const bad = sanitizeVstEditorPrefs(
    {
      defaultMode: 'detached',
      byPluginPath: { [PQ]: 'floating', [VALHALLA]: 'popup', '': 'floating', ok: 'embedded' },
    },
    current,
  );
  assert.equal(bad.defaultMode, 'embedded', 'an unknown default falls back');
  assert.deepEqual(bad.byPluginPath, { [PQ]: 'floating', ok: 'embedded' }, 'bad entries are dropped, good ones kept');
  assert.equal(typeof bad.setModeForPlugin, 'function', 'actions survive hydrate');
  assert.equal(typeof bad.reset, 'function');
  assert.equal(bad.modeFor(VALHALLA), 'embedded');

  for (const junk of [null, undefined, 'str', 7, [], { byPluginPath: 'nope' }, { byPluginPath: [] }]) {
    const out = sanitizeVstEditorPrefs(junk, current);
    assert.equal(out.defaultMode, 'embedded');
    assert.deepEqual(out.byPluginPath, {});
  }

  const good = sanitizeVstEditorPrefs(
    { defaultMode: 'floating', byPluginPath: { [VALHALLA]: 'embedded' } },
    current,
  );
  assert.equal(good.defaultMode, 'floating');
  assert.deepEqual(good.byPluginPath, { [VALHALLA]: 'embedded' });

  // A hydrated map is the store's own, never the persisted object: mutating
  // what came off disk must not reach the live state.
  const blob = { defaultMode: 'floating', byPluginPath: { [PQ]: 'floating' } };
  const hydrated = sanitizeVstEditorPrefs(blob, current);
  blob.byPluginPath[PQ] = 'embedded';
  assert.equal(hydrated.byPluginPath[PQ], 'floating');
}

console.log('vstEditorPrefsStore: ok');
