import assert from 'node:assert/strict';
import { WHEEL_PROFILES, type WheelAction } from '../../lib/timeline/viewport';
import { GRID_PRESETS } from '../../state/timelinePrefsStore';
import {
  CLICK_PROFILE_OPTIONS,
  GRID_OPACITY_FIELDS,
  GRID_PRESET_OPTIONS,
  WHEEL_ACTION_TEXT,
  WHEEL_GESTURES,
  WHEEL_PROFILE_OPTIONS,
  describeWheelProfile,
  gridPresetLabel,
  gridPreviewLines,
  opacityPercent,
  speedPercent,
} from './timelinePrefsPanelModel';

// --- Wheel profiles ------------------------------------------------------------

// One option per profile, labelled from WHEEL_PROFILES so the two never drift.
assert.deepEqual(
  WHEEL_PROFILE_OPTIONS.map((o) => o.id),
  ['thedaw', 'reaper'],
);
for (const o of WHEEL_PROFILE_OPTIONS) {
  assert.equal(o.label, WHEEL_PROFILES[o.id].label);
  assert.ok(o.description.length > 0);
}

// Every action has plain-language text.
const actions: WheelAction[] = ['zoom-time', 'zoom-time-fine', 'resize-lanes', 'pan-time', 'pan-lanes', 'none'];
for (const a of actions) assert.ok(WHEEL_ACTION_TEXT[a].length > 0, a);
assert.equal(new Set(actions.map((a) => WHEEL_ACTION_TEXT[a])).size, actions.length);

// The six gestures, in the order the table shows them.
assert.deepEqual(
  WHEEL_GESTURES.map((g) => g.key),
  ['plain', 'ctrl', 'shift', 'alt', 'ctrlShift', 'ctrlAlt'],
);
assert.deepEqual(
  WHEEL_GESTURES.map((g) => g.gesture),
  ['Wheel', 'Ctrl + wheel', 'Shift + wheel', 'Alt + wheel', 'Ctrl + Shift + wheel', 'Ctrl + Alt + wheel'],
);

// describeWheelProfile reads the bindings straight from WHEEL_PROFILES.
assert.deepEqual(describeWheelProfile('thedaw'), [
  { gesture: 'Wheel', action: WHEEL_ACTION_TEXT['zoom-time'] },
  { gesture: 'Ctrl + wheel', action: WHEEL_ACTION_TEXT['zoom-time-fine'] },
  { gesture: 'Shift + wheel', action: WHEEL_ACTION_TEXT['pan-time'] },
  { gesture: 'Alt + wheel', action: WHEEL_ACTION_TEXT['pan-lanes'] },
  { gesture: 'Ctrl + Shift + wheel', action: WHEEL_ACTION_TEXT['resize-lanes'] },
  { gesture: 'Ctrl + Alt + wheel', action: WHEEL_ACTION_TEXT['pan-lanes'] },
]);
assert.deepEqual(describeWheelProfile('reaper'), [
  { gesture: 'Wheel', action: WHEEL_ACTION_TEXT['zoom-time'] },
  { gesture: 'Ctrl + wheel', action: WHEEL_ACTION_TEXT['resize-lanes'] },
  { gesture: 'Shift + wheel', action: WHEEL_ACTION_TEXT['pan-time'] },
  { gesture: 'Alt + wheel', action: WHEEL_ACTION_TEXT['pan-time'] },
  { gesture: 'Ctrl + Shift + wheel', action: WHEEL_ACTION_TEXT['zoom-time-fine'] },
  { gesture: 'Ctrl + Alt + wheel', action: WHEEL_ACTION_TEXT['pan-lanes'] },
]);
// An unknown id (a stale persisted value reaching the panel) is a RangeError, not a blank table.
assert.throws(() => describeWheelProfile('cubase' as never), RangeError);

// --- Click profiles -------------------------------------------------------------

assert.deepEqual(
  CLICK_PROFILE_OPTIONS.map((o) => o.id),
  ['default', 'clip-seeks', 'ruler-only'],
);
for (const o of CLICK_PROFILE_OPTIONS) {
  assert.ok(o.label.length > 0);
  assert.ok(o.description.length > 0);
  assert.ok(!o.description.includes('\n'), 'descriptions are one line');
}

// --- Grid -------------------------------------------------------------------------

assert.deepEqual(
  GRID_PRESET_OPTIONS.map((o) => [o.id, o.label]),
  [
    ['subtle', 'Subtle'],
    ['normal', 'Normal'],
    ['high-contrast', 'High contrast'],
  ],
);
assert.equal(gridPresetLabel('custom'), 'Custom');
assert.equal(gridPresetLabel('high-contrast'), 'High contrast');

assert.deepEqual(
  GRID_OPACITY_FIELDS.map((f) => f.key),
  ['barOpacity', 'beatOpacity', 'subdivOpacity', 'laneDividerOpacity'],
);
// Field ids are unique and usable as DOM ids / names.
const ids = GRID_OPACITY_FIELDS.map((f) => f.id);
assert.equal(new Set(ids).size, ids.length);
for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/);

// --- Number formatting --------------------------------------------------------------

assert.equal(opacityPercent(0), '0%');
assert.equal(opacityPercent(0.245), '25%');
assert.equal(opacityPercent(1), '100%');
assert.throws(() => opacityPercent(Number.NaN), RangeError);

assert.equal(speedPercent(1, 1, 3), 0);
assert.equal(speedPercent(2, 1, 3), 50);
assert.equal(speedPercent(3, 1, 3), 100);
assert.equal(speedPercent(9, 1, 3), 100, 'clamped high');
assert.equal(speedPercent(-9, 1, 3), 0, 'clamped low');
assert.throws(() => speedPercent(Number.POSITIVE_INFINITY, 1, 3), RangeError);
assert.throws(() => speedPercent(2, 3, 1), RangeError);

// --- Preview strip ---------------------------------------------------------------

const normal = { visible: true, ...GRID_PRESETS.normal };
const lines = gridPreviewLines(normal, 4, 4);
// 1 bar of 4 beats x 4 subdivisions: bar lines at both ends, 3 inner beats, 12 subdivisions.
assert.equal(lines.filter((l) => l.kind === 'bar').length, 2);
assert.equal(lines.filter((l) => l.kind === 'beat').length, 3);
assert.equal(lines.filter((l) => l.kind === 'subdiv').length, 12);
assert.deepEqual(
  lines.filter((l) => l.kind === 'bar').map((l) => l.at),
  [0, 1],
);
assert.deepEqual(
  lines.filter((l) => l.kind === 'beat').map((l) => l.at),
  [0.25, 0.5, 0.75],
);
for (const l of lines) {
  const want = l.kind === 'bar' ? normal.barOpacity : l.kind === 'beat' ? normal.beatOpacity : normal.subdivOpacity;
  assert.equal(l.opacity, want);
  assert.equal(l.widthPx, l.kind === 'bar' ? normal.barWidthPx : 1);
  assert.ok(l.at >= 0 && l.at <= 1);
}
// Sorted left to right.
for (let i = 1; i < lines.length; i++) assert.ok(lines[i].at >= lines[i - 1].at);

const high = gridPreviewLines({ visible: true, ...GRID_PRESETS['high-contrast'] }, 4, 4);
assert.ok(high.filter((l) => l.kind === 'bar').every((l) => l.widthPx === 2));

// A hidden grid previews as nothing.
assert.deepEqual(gridPreviewLines({ ...normal, visible: false }, 4, 4), []);
// Bad counts are RangeErrors.
assert.throws(() => gridPreviewLines(normal, 0, 4), RangeError);
assert.throws(() => gridPreviewLines(normal, 4, Number.NaN), RangeError);

console.log('timelinePrefsPanelModel: ok');
