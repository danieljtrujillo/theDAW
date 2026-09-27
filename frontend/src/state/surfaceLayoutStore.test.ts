/**
 * A mirrored surface panel is a left/right flip. A row shows its widgets right
 * to left; a column keeps its top-to-bottom order, so deck A's EQ reads HI to
 * LO like deck B's. Layouts saved before that rule (no `rev`) were drawn with
 * every mirrored column bottom to top. The rev-1 upgrade keeps what the user
 * saw in each such column, except EQ A and Ch A, which take deck B's order.
 *
 * Everything runs on the DJ default and the column-order fix the app ships
 * (views/djLayout.ts), and SurfacePanel is checked to draw through
 * displayOrder. The store half replays what the app does: a layout the old
 * renderer saved sits in localStorage, the DJ surface store is created over it
 * (once with storage full), the app is launched again, a saved default is
 * restored with reset, and Ch A is synced onto Ch B.
 *
 * Run: npx tsx src/state/surfaceLayoutStore.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAYOUT_REV, createLayoutStore, displayOrder, upgradeLayout } from './surfaceLayoutStore.ts';
import type { PanelNode, SurfaceLayout } from './surfaceLayoutStore.ts';
import { DJ_COLUMN_ORDER_FIX, DJ_LAYOUT_VERSION, defaultDjLayout } from '../views/djLayout.ts';

const saved = new Map<string, string>();
/** When set, every write throws the way a full localStorage does. */
let storageFull = false;
const localStorage = {
  getItem: (k: string) => (saved.has(k) ? (saved.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    if (storageFull) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    saved.set(k, String(v));
  },
  removeItem: (k: string) => void saved.delete(k),
};
const g = globalThis as unknown as Record<string, unknown>;
g.window = { localStorage };
g.localStorage = localStorage;

const panel = (l: SurfaceLayout, id: string) => l.nodes[id] as PanelNode;
const panelIds = (l: SurfaceLayout) => Object.keys(l.nodes).filter((id) => l.nodes[id].type === 'panel');
/** What the renderer drew before rev 1: every mirrored panel reversed. */
const oldDisplay = (p: PanelNode) => (p.mirror ? [...p.widgets].reverse() : p.widgets);
/** Deck A ids spelled as their deck B companions. */
const asB = (ids: string[]) => ids.map((w) => w.replace('A', 'B'));
/** A layout as it round-trips through storage (undefined keys dropped). */
const stored = (l: SurfaceLayout) => JSON.parse(JSON.stringify(l)) as SurfaceLayout;

/** The DJ default as the app ships it, and its fix map. */
const NEW_DEFAULT = defaultDjLayout;
const FIX = DJ_COLUMN_ORDER_FIX;

/** The same default as the old renderer stored it before rev 1: Ch A held
 *  [volA, gainA] so the reversed column showed gain on top. */
const OLD: SurfaceLayout = stored(NEW_DEFAULT);
panel(OLD, 'chAP').widgets = ['volA', 'gainA'];

/* ── the renderer order rule ─────────────────────────────────────────────── */

// SurfacePanel draws a panel's widgets in displayOrder, and nowhere reverses
// them itself.
const surfacePanel = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'surface', 'SurfacePanel.tsx'), 'utf8');
assert.match(surfacePanel, /const displayIds = displayOrder\(node\);/, 'SurfacePanel orders its widgets with displayOrder');
assert.match(surfacePanel, /<FrGrid[^>]*?\bids=\{displayIds\}/, "SurfacePanel's FrGrid draws that order");
assert.doesNotMatch(surfacePanel, /\.reverse\(\)/, 'SurfacePanel reverses nothing on its own');

assert.deepEqual(
  displayOrder(panel(NEW_DEFAULT, 'pdA-trans')),
  ['syncA', 'ejectA', 'stopA', 'playA', 'cueA'],
  'a mirrored row reads right to left',
);
assert.deepEqual(displayOrder(panel(NEW_DEFAULT, 'pdB-trans')), ['cueB', 'playB', 'stopB', 'ejectB', 'syncB'], 'a plain row reads left to right');
assert.deepEqual(
  displayOrder(panel(NEW_DEFAULT, 'eqAP')),
  ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'],
  'a mirrored column keeps its top-to-bottom order: EQ A reads HI to LO, then FLT',
);
assert.deepEqual(displayOrder(panel(NEW_DEFAULT, 'eqBP')), ['eqB.hi', 'eqB.mid', 'eqB.lo', 'fltB'], 'a plain column reads top to bottom');
for (const [a, b] of [['eqAP', 'eqBP'], ['chAP', 'chBP'], ['pdA-mode', 'pdB-mode']]) {
  assert.deepEqual(asB(displayOrder(panel(NEW_DEFAULT, a))), displayOrder(panel(NEW_DEFAULT, b)), `the default ${a} reads like ${b}`);
}
assert.equal(panel(NEW_DEFAULT, 'chAP').widgets[0], 'gainA', 'the default Ch A lists gain first, like Ch B, so Sync pairs gain with gain');
for (const id of panelIds(NEW_DEFAULT)) {
  const p = panel(NEW_DEFAULT, id);
  if (p.mirror && p.flow === 'column') assert.deepEqual(displayOrder(p), p.widgets, `the mirrored column ${id} shows its stored order`);
}

/* ── the rev-1 upgrade: old layout in, expected layout out ───────────────── */

const before = JSON.stringify(OLD);
const up = upgradeLayout(OLD, FIX);
assert.equal(JSON.stringify(OLD), before, 'the upgrade leaves its input alone');
assert.equal(LAYOUT_REV, 1);

const expected: SurfaceLayout = JSON.parse(before);
expected.rev = 1;
panel(expected, 'eqAP').widgets = ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'];
panel(expected, 'chAP').widgets = ['gainA', 'volA'];
panel(expected, 'pdA-mode').widgets = ['headCueA', 'syncLockA'];
assert.deepEqual(stored(up), expected, 'EQ A and Ch A take the corrected order, A · Mode keeps what it showed, the rest is untouched');

// An old saved default comes out as the shipped default, except A · Mode,
// which keeps HP Cue on top as the user saw it.
const shipped = stored({ ...NEW_DEFAULT, rev: LAYOUT_REV });
panel(shipped, 'pdA-mode').widgets = ['headCueA', 'syncLockA'];
assert.deepEqual(stored(up), shipped, 'an untouched old default upgrades to the shipped default but for A · Mode');

assert.deepEqual(displayOrder(panel(up, 'eqAP')), ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'], 'an upgraded EQ A reads HI to LO');
assert.deepEqual(asB(displayOrder(panel(up, 'eqAP'))), displayOrder(panel(up, 'eqBP')), 'an upgraded EQ A reads like EQ B');
assert.deepEqual(asB(displayOrder(panel(up, 'chAP'))), displayOrder(panel(up, 'chBP')), 'an upgraded Ch A reads like Ch B');
for (const id of panelIds(OLD)) {
  if (id === 'eqAP') continue;
  assert.deepEqual(displayOrder(panel(up, id)), oldDisplay(panel(OLD, id)), `${id} shows what it showed before the upgrade`);
}
assert.equal(upgradeLayout(up, FIX), up, 'a rev-1 layout is not upgraded again');

// What a user built around EQ A: a custom knob they put on top, a spacer at
// the bottom. The bands take deck B's order in the slots they held; the knob
// and the spacer stay where the user put them.
const custom: SurfaceLayout = stored(OLD);
panel(custom, 'eqAP').widgets = ['spacer:s-9-aa', 'eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA', 'custom-3-bb'];
assert.deepEqual(oldDisplay(panel(custom, 'eqAP')), ['custom-3-bb', 'fltA', 'eqA.lo', 'eqA.mid', 'eqA.hi', 'spacer:s-9-aa']);
assert.deepEqual(
  displayOrder(panel(upgradeLayout(custom, FIX), 'eqAP')),
  ['custom-3-bb', 'eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA', 'spacer:s-9-aa'],
  'EQ A reads HI to LO around the controls the user added',
);

// A mirrored column the user built keeps its look; so does an EQ A the user
// un-mirrored, and an A · Mode the user turned into a row.
panel(custom, 'eqAP').mirror = false;
panel(custom, 'pdA-mode').flow = 'row';
custom.nodes['panel-7-cc'] = { id: 'panel-7-cc', type: 'panel', title: 'Panel', flow: 'column', widgets: ['hcA1', 'hcA2', 'hcA3'], mirror: true };
const customUp = upgradeLayout(custom, FIX);
for (const id of ['eqAP', 'pdA-mode', 'panel-7-cc']) {
  assert.deepEqual(displayOrder(panel(customUp, id)), oldDisplay(panel(custom, id)), `${id} shows what the user built`);
}

/* ── the store: load, relaunch, reset, sync ──────────────────────────────── */

const LIVE_KEY = 'thedaw.surface.dj.v1';
const DEFAULT_KEY = `thedaw.surface.dj.default.v${DJ_LAYOUT_VERSION}`;
saved.set(LIVE_KEY, JSON.stringify({ state: { layout: OLD }, version: DJ_LAYOUT_VERSION }));

// With storage full the DJ surface still opens (this runs during render), with
// the layout upgraded in memory. Nothing is written, so the next load upgrades
// it again.
storageFull = true;
const onFullStorage = createLayoutStore('dj', NEW_DEFAULT, FIX);
storageFull = false;
assert.deepEqual(stored(onFullStorage.getState().layout), expected, 'a full storage still loads the layout upgraded');
assert.deepEqual(JSON.parse(saved.get(LIVE_KEY) as string).state.layout, OLD, 'a full storage keeps the old layout on disk');

const first = createLayoutStore('dj', NEW_DEFAULT, FIX);
assert.deepEqual(stored(first.getState().layout), expected, 'the saved layout loads upgraded');
const written = JSON.parse(saved.get(LIVE_KEY) as string) as { state: { layout: SurfaceLayout }; version: number };
assert.equal(written.version, DJ_LAYOUT_VERSION, 'the layout version is unchanged, so nothing is discarded');
assert.deepEqual(written.state.layout, expected, 'the upgrade is written back at load');

const relaunch = createLayoutStore('dj', NEW_DEFAULT, FIX);
assert.deepEqual(stored(relaunch.getState().layout), expected, 'the next launch loads the same layout; nothing reverses twice');

// Sync to companion copies per-widget sizes by position: gain onto gain and
// volume onto volume now that both channels list gain first.
relaunch.getState().mirrorToCompanion('chAP');
const chB = panel(relaunch.getState().layout, 'chBP');
assert.deepEqual(chB.widgetFr, { gainB: 1, volB: 3 }, 'Ch B takes Ch A gain size on its gain and fader size on its fader');
assert.deepEqual(chB.widgetMargins, { volB: { t: 8, r: 24, b: 8, l: 0 } }, 'the fader margin lands on the fader, mirrored');
assert.deepEqual(displayOrder(chB), ['gainB', 'volB']);

// A default saved before rev 1 (Ctrl+S) is upgraded when reset restores it.
saved.set(DEFAULT_KEY, JSON.stringify(OLD));
relaunch.getState().reset();
assert.deepEqual(stored(relaunch.getState().layout), expected, 'reset restores the saved default upgraded');
assert.deepEqual(JSON.parse(saved.get(DEFAULT_KEY) as string), expected, 'the upgraded default is written back');
relaunch.getState().reset();
assert.deepEqual(stored(relaunch.getState().layout), expected, 'a second reset does not upgrade it again');

// A first launch with nothing saved gets the default, already current.
saved.clear();
const fresh = createLayoutStore('dj', NEW_DEFAULT, FIX);
assert.equal(fresh.getState().layout.rev, LAYOUT_REV);
assert.deepEqual(displayOrder(panel(fresh.getState().layout, 'eqAP')), ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA']);
assert.deepEqual(displayOrder(panel(fresh.getState().layout, 'pdA-mode')), ['syncLockA', 'headCueA'], 'a fresh A · Mode reads like B · Mode');

// Sync on a fresh install pairs gain with gain too.
fresh.getState().mirrorToCompanion('chAP');
assert.deepEqual(panel(fresh.getState().layout, 'chBP').widgetFr, { gainB: 1, volB: 3 }, 'a fresh Sync keeps the fader size on the fader');

console.log('surfaceLayoutStore: mirror order and rev-1 upgrade ok');
