import assert from 'node:assert/strict';

import {
  GRID_PRESETS,
  sanitizeTimelinePrefs,
  useTimelinePrefs,
  type ClickProfile,
  type GridPreset,
  type WheelProfileId,
} from './timelinePrefsStore.ts';

// Runs under plain node (no DOM, no localStorage): the store must construct
// with its defaults, work without storage, and never throw on persistence.

const tp = () => useTimelinePrefs.getState();

/* -------------------------------- defaults -------------------------------- */
{
  const s = tp();
  assert.equal(s.wheelProfile, 'thedaw');
  assert.equal(s.fineZoomSpeed, 0.0006);
  assert.equal(s.coarseZoomSpeed, 0.002);
  assert.equal(s.clickProfile, 'default');
  assert.equal(s.gridPreset, 'normal');
  assert.deepEqual(s.grid, { visible: true, ...GRID_PRESETS.normal });
  assert.deepEqual(GRID_PRESETS.normal, {
    barOpacity: 0.24, beatOpacity: 0.11, subdivOpacity: 0.045, laneDividerOpacity: 0.1, barWidthPx: 1,
  });
  assert.deepEqual(GRID_PRESETS.subtle, {
    barOpacity: 0.14, beatOpacity: 0.06, subdivOpacity: 0.025, laneDividerOpacity: 0.06, barWidthPx: 1,
  });
  assert.deepEqual(GRID_PRESETS['high-contrast'], {
    barOpacity: 0.45, beatOpacity: 0.22, subdivOpacity: 0.1, laneDividerOpacity: 0.2, barWidthPx: 2,
  });
  // No snap field: grid visibility and snapping are independent.
  assert.equal('snap' in s, false);
}

/* ---------------------------- enum setters -------------------------------- */
{
  tp().reset();
  tp().setWheelProfile('reaper');
  assert.equal(tp().wheelProfile, 'reaper');
  tp().setWheelProfile('cubase' as WheelProfileId);
  assert.equal(tp().wheelProfile, 'reaper', 'unknown wheel profile is ignored');

  tp().setClickProfile('clip-seeks');
  assert.equal(tp().clickProfile, 'clip-seeks');
  tp().setClickProfile('ruler-only');
  assert.equal(tp().clickProfile, 'ruler-only');
  tp().setClickProfile('bogus' as ClickProfile);
  assert.equal(tp().clickProfile, 'ruler-only', 'unknown click profile is ignored');
}

/* --------------------------- zoom speed clamps ---------------------------- */
{
  tp().reset();
  tp().setFineZoomSpeed(0.001);
  assert.equal(tp().fineZoomSpeed, 0.001);
  tp().setFineZoomSpeed(1);
  assert.equal(tp().fineZoomSpeed, 0.003, 'fine clamps high');
  tp().setFineZoomSpeed(0);
  assert.equal(tp().fineZoomSpeed, 0.0001, 'fine clamps low');
  tp().setFineZoomSpeed(Number.NaN);
  assert.equal(tp().fineZoomSpeed, 0.0001, 'NaN is ignored');
  tp().setFineZoomSpeed(Number.POSITIVE_INFINITY);
  assert.equal(tp().fineZoomSpeed, 0.0001, 'Infinity is ignored');

  tp().setCoarseZoomSpeed(0.004);
  assert.equal(tp().coarseZoomSpeed, 0.004);
  tp().setCoarseZoomSpeed(99);
  assert.equal(tp().coarseZoomSpeed, 0.006, 'coarse clamps high');
  tp().setCoarseZoomSpeed(-1);
  assert.equal(tp().coarseZoomSpeed, 0.0005, 'coarse clamps low');
  tp().setCoarseZoomSpeed(Number.NaN);
  assert.equal(tp().coarseZoomSpeed, 0.0005, 'NaN is ignored');
}

/* ---------------------------- grid presets -------------------------------- */
{
  tp().reset();
  tp().setGridVisible(false);
  tp().applyGridPreset('high-contrast');
  assert.equal(tp().gridPreset, 'high-contrast');
  assert.deepEqual(tp().grid, { visible: false, ...GRID_PRESETS['high-contrast'] }, 'preset keeps visible');
  tp().applyGridPreset('subtle');
  assert.deepEqual(tp().grid, { visible: false, ...GRID_PRESETS.subtle });
  tp().applyGridPreset('custom' as Exclude<GridPreset, 'custom'>);
  assert.equal(tp().gridPreset, 'subtle', 'custom / unknown preset is ignored');
  assert.deepEqual(tp().grid, { visible: false, ...GRID_PRESETS.subtle });
}

/* ------------------------------- setGrid ---------------------------------- */
{
  tp().reset();
  tp().setGrid({ visible: false });
  assert.equal(tp().grid.visible, false);
  assert.equal(tp().gridPreset, 'normal', 'visible alone does not make the preset custom');
  tp().setGridVisible(true);
  assert.equal(tp().grid.visible, true);
  assert.equal(tp().gridPreset, 'normal');

  tp().setGrid({ barOpacity: GRID_PRESETS.normal.barOpacity });
  assert.equal(tp().gridPreset, 'normal', 'an unchanged style value does not make the preset custom');

  tp().setGrid({ beatOpacity: 0.3 });
  assert.equal(tp().grid.beatOpacity, 0.3);
  assert.equal(tp().gridPreset, 'custom', 'a style change makes the preset custom');

  tp().setGrid({ barOpacity: 2, subdivOpacity: -1, laneDividerOpacity: Number.NaN });
  assert.equal(tp().grid.barOpacity, 1, 'opacity clamps to 1');
  assert.equal(tp().grid.subdivOpacity, 0, 'opacity clamps to 0');
  assert.equal(tp().grid.laneDividerOpacity, GRID_PRESETS.normal.laneDividerOpacity, 'NaN opacity ignored');

  tp().setGrid({ barWidthPx: 7 as 1 | 2 });
  assert.equal(tp().grid.barWidthPx, 2, 'bar width clamps to 2');
  tp().setGrid({ barWidthPx: 0 as 1 | 2 });
  assert.equal(tp().grid.barWidthPx, 1, 'bar width clamps to 1');
  tp().setGrid({ barWidthPx: Number.NaN as 1 | 2 });
  assert.equal(tp().grid.barWidthPx, 1, 'NaN bar width ignored');

  tp().reset();
  tp().setGrid({ barOpacity: 'x' as unknown as number, visible: 'yes' as unknown as boolean });
  assert.deepEqual(tp().grid, { visible: true, ...GRID_PRESETS.normal }, 'wrong types are ignored');
  assert.equal(tp().gridPreset, 'normal');
  tp().setGridVisible('no' as unknown as boolean);
  assert.equal(tp().grid.visible, true, 'non-boolean visible ignored');
}

/* -------------------------------- reset ----------------------------------- */
{
  tp().setWheelProfile('reaper');
  tp().setFineZoomSpeed(0.002);
  tp().setCoarseZoomSpeed(0.005);
  tp().setClickProfile('ruler-only');
  tp().applyGridPreset('high-contrast');
  tp().setGridVisible(false);
  tp().reset();
  const s = tp();
  assert.equal(s.wheelProfile, 'thedaw');
  assert.equal(s.fineZoomSpeed, 0.0006);
  assert.equal(s.coarseZoomSpeed, 0.002);
  assert.equal(s.clickProfile, 'default');
  assert.equal(s.gridPreset, 'normal');
  assert.deepEqual(s.grid, { visible: true, ...GRID_PRESETS.normal });
  // reset hands out a fresh grid object, never the shared preset constant.
  assert.notEqual(s.grid as object, GRID_PRESETS.normal as object);
}

/* ---------------------- corrupted persisted blob -------------------------- */
// sanitizeTimelinePrefs IS the store's merge and migrate: zustand's persist
// hydrate cannot be driven from node, so it is pinned directly.
{
  const current = tp();
  const bad = sanitizeTimelinePrefs(
    {
      wheelProfile: 42,
      fineZoomSpeed: 'fast',
      coarseZoomSpeed: null,
      clickProfile: 'everything',
      gridPreset: ['normal'],
      grid: { visible: 'yes', barOpacity: 'a', beatOpacity: 5, subdivOpacity: -3, laneDividerOpacity: {}, barWidthPx: 9 },
    },
    current,
  );
  assert.equal(bad.wheelProfile, 'thedaw');
  assert.equal(bad.fineZoomSpeed, 0.0006);
  assert.equal(bad.coarseZoomSpeed, 0.002);
  assert.equal(bad.clickProfile, 'default');
  assert.equal(bad.gridPreset, 'normal');
  assert.equal(bad.grid.visible, true);
  assert.equal(bad.grid.barOpacity, GRID_PRESETS.normal.barOpacity);
  assert.equal(bad.grid.beatOpacity, 1, 'out-of-range persisted opacity is clamped');
  assert.equal(bad.grid.subdivOpacity, 0);
  assert.equal(bad.grid.laneDividerOpacity, GRID_PRESETS.normal.laneDividerOpacity);
  assert.equal(bad.grid.barWidthPx, 2);
  assert.equal(typeof bad.setGrid, 'function', 'actions survive hydrate');
  assert.equal(typeof bad.reset, 'function');

  for (const junk of [null, undefined, 'str', 7, [], { grid: 'nope' }, { grid: [] }]) {
    const out = sanitizeTimelinePrefs(junk, current);
    assert.equal(out.wheelProfile, 'thedaw');
    assert.equal(out.gridPreset, 'normal');
    assert.deepEqual(out.grid, { visible: true, ...GRID_PRESETS.normal });
  }

  const good = sanitizeTimelinePrefs(
    {
      wheelProfile: 'reaper',
      fineZoomSpeed: 0.001,
      coarseZoomSpeed: 0.004,
      clickProfile: 'clip-seeks',
      gridPreset: 'custom',
      grid: { visible: false, barOpacity: 0.3, beatOpacity: 0.2, subdivOpacity: 0.05, laneDividerOpacity: 0.15, barWidthPx: 2 },
    },
    current,
  );
  assert.equal(good.wheelProfile, 'reaper');
  assert.equal(good.fineZoomSpeed, 0.001);
  assert.equal(good.coarseZoomSpeed, 0.004);
  assert.equal(good.clickProfile, 'clip-seeks');
  assert.equal(good.gridPreset, 'custom');
  assert.deepEqual(good.grid, {
    visible: false, barOpacity: 0.3, beatOpacity: 0.2, subdivOpacity: 0.05, laneDividerOpacity: 0.15, barWidthPx: 2,
  });

  const clamped = sanitizeTimelinePrefs({ fineZoomSpeed: 1, coarseZoomSpeed: 0 }, current);
  assert.equal(clamped.fineZoomSpeed, 0.003, 'persisted zoom speeds are clamped');
  assert.equal(clamped.coarseZoomSpeed, 0.0005);
}

console.log('timelinePrefsStore: ok');
