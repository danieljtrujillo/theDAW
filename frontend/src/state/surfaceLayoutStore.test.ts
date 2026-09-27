/**
 * A mirrored surface panel is a left/right flip. A row shows its widgets right
 * to left; a column keeps its top-to-bottom order, so deck A's EQ reads HI to
 * LO like deck B's. Layouts saved before that rule (no `rev`) were drawn with
 * every mirrored column bottom to top. The rev-1 upgrade keeps what the user
 * saw in each such column, except EQ A and Ch A, which take deck B's order.
 *
 * The store half replays what the app does: a layout the old renderer saved
 * sits in localStorage, the DJ surface store is created over it, the app is
 * launched again, a saved default is restored with reset, and Ch A is synced
 * onto Ch B.
 *
 * Run: npx tsx src/state/surfaceLayoutStore.test.ts
 */
import assert from 'node:assert/strict';

import { LAYOUT_REV, createLayoutStore, displayOrder, upgradeLayout } from './surfaceLayoutStore.ts';
import type { ColumnOrderFix, PanelNode, SurfaceLayout } from './surfaceLayoutStore.ts';

const saved = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => (saved.has(k) ? (saved.get(k) as string) : null),
  setItem: (k: string, v: string) => void saved.set(k, String(v)),
  removeItem: (k: string) => void saved.delete(k),
};
const g = globalThis as unknown as Record<string, unknown>;
g.window = { localStorage };
g.localStorage = localStorage;

/** The DJ mixer and deck panels as the v24 default stored them before rev 1:
 *  Ch A held [volA, gainA] so the reversed column showed gain on top. */
const OLD: SurfaceLayout = {
  version: 24,
  root: 'root',
  nodes: {
    root: {
      id: 'root',
      type: 'container',
      axis: 'row',
      children: ['pdA-mode', 'pchAP', 'eqAP', 'chAP', 'chBP', 'eqBP', 'pdB-mode', 'pdA-trans', 'pdB-trans', 'waveAOverview'],
      fr: {},
    },
    'pdA-mode': { id: 'pdA-mode', type: 'panel', title: 'A · Mode', flow: 'column', widgets: ['syncLockA', 'headCueA'], mirror: true, uniform: true },
    pchAP: { id: 'pchAP', type: 'panel', title: 'Pitch A', flow: 'column', widgets: ['pitchA'], widgetMargins: { pitchA: { t: 3, r: 4, b: 3, l: 4 } }, mirror: true },
    eqAP: { id: 'eqAP', type: 'panel', title: 'EQ A', flow: 'column', widgets: ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'], mirror: true },
    chAP: { id: 'chAP', type: 'panel', title: 'Ch A', flow: 'column', widgets: ['volA', 'gainA'], widgetFr: { gainA: 1, volA: 3 }, widgetMargins: { volA: { t: 8, r: 0, b: 8, l: 24 } }, mirror: true },
    chBP: { id: 'chBP', type: 'panel', title: 'Ch B', flow: 'column', widgets: ['gainB', 'volB'], widgetFr: { gainB: 1, volB: 3 }, widgetMargins: { volB: { t: 8, r: 24, b: 8, l: 0 } } },
    eqBP: { id: 'eqBP', type: 'panel', title: 'EQ B', flow: 'column', widgets: ['eqB.hi', 'eqB.mid', 'eqB.lo', 'fltB'] },
    'pdB-mode': { id: 'pdB-mode', type: 'panel', title: 'B · Mode', flow: 'column', widgets: ['syncLockB', 'headCueB'], uniform: true },
    'pdA-trans': { id: 'pdA-trans', type: 'panel', title: 'A · Transport', flow: 'row', widgets: ['cueA', 'playA', 'stopA', 'ejectA', 'syncA'], uniform: true, mirror: true },
    'pdB-trans': { id: 'pdB-trans', type: 'panel', title: 'B · Transport', flow: 'row', widgets: ['cueB', 'playB', 'stopB', 'ejectB', 'syncB'], uniform: true },
    waveAOverview: { id: 'waveAOverview', type: 'panel', title: 'A · Overview', flow: 'row', widgets: [], pinned: 'waveAOverview', mirror: true },
  },
};

/** The same panels as DJView's default now ships them (Ch A as [gainA, volA]). */
const NEW_DEFAULT: SurfaceLayout = JSON.parse(JSON.stringify(OLD));
(NEW_DEFAULT.nodes.chAP as PanelNode).widgets = ['gainA', 'volA'];

/** DJView's DJ_COLUMN_ORDER_FIX. */
const FIX: ColumnOrderFix = {
  eqAP: ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'],
  chAP: ['gainA', 'volA'],
};

const panel = (l: SurfaceLayout, id: string) => l.nodes[id] as PanelNode;
/** What the renderer drew before rev 1: every mirrored panel reversed. */
const oldDisplay = (p: PanelNode) => (p.mirror ? [...p.widgets].reverse() : p.widgets);
/** Deck A ids spelled as their deck B companions. */
const asB = (ids: string[]) => ids.map((w) => w.replace('A', 'B'));
/** A layout as it round-trips through storage (undefined keys dropped). */
const stored = (l: SurfaceLayout) => JSON.parse(JSON.stringify(l)) as SurfaceLayout;

/* ── the renderer order rule ─────────────────────────────────────────────── */

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
assert.deepEqual(asB(displayOrder(panel(NEW_DEFAULT, 'eqAP'))), displayOrder(panel(NEW_DEFAULT, 'eqBP')), 'EQ A reads like EQ B');
assert.deepEqual(asB(displayOrder(panel(NEW_DEFAULT, 'chAP'))), displayOrder(panel(NEW_DEFAULT, 'chBP')), 'Ch A reads like Ch B, gain above the fader');
assert.deepEqual(asB(displayOrder(panel(NEW_DEFAULT, 'pdA-mode'))), displayOrder(panel(NEW_DEFAULT, 'pdB-mode')), 'A · Mode reads like B · Mode');
assert.deepEqual(displayOrder(panel(NEW_DEFAULT, 'eqBP')), ['eqB.hi', 'eqB.mid', 'eqB.lo', 'fltB'], 'a plain column reads top to bottom');

/* ── the rev-1 upgrade: old layout in, expected layout out ───────────────── */

const before = JSON.stringify(OLD);
const up = upgradeLayout(OLD, FIX);
assert.equal(JSON.stringify(OLD), before, 'the upgrade leaves its input alone');
assert.equal(LAYOUT_REV, 1);

const expected: SurfaceLayout = JSON.parse(before);
expected.rev = 1;
(expected.nodes.eqAP as PanelNode).widgets = ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'];
(expected.nodes.chAP as PanelNode).widgets = ['gainA', 'volA'];
(expected.nodes['pdA-mode'] as PanelNode).widgets = ['headCueA', 'syncLockA'];
assert.deepEqual(stored(up), expected, 'EQ A and Ch A take the corrected order, A · Mode keeps what it showed, the rest is untouched');

assert.deepEqual(displayOrder(panel(up, 'eqAP')), ['eqA.hi', 'eqA.mid', 'eqA.lo', 'fltA'], 'an upgraded EQ A reads HI to LO');
assert.deepEqual(displayOrder(panel(up, 'chAP')), oldDisplay(panel(OLD, 'chAP')), 'Ch A shows gain above the fader, as before');
for (const id of ['pdA-mode', 'pchAP', 'pdA-trans', 'chBP', 'eqBP', 'pdB-mode', 'pdB-trans']) {
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
const DEFAULT_KEY = 'thedaw.surface.dj.default.v24';
saved.set(LIVE_KEY, JSON.stringify({ state: { layout: OLD }, version: 24 }));

const first = createLayoutStore('dj', NEW_DEFAULT, FIX);
assert.deepEqual(stored(first.getState().layout), expected, 'the saved layout loads upgraded');
const written = JSON.parse(saved.get(LIVE_KEY) as string) as { state: { layout: SurfaceLayout }; version: number };
assert.equal(written.version, 24, 'the layout version is unchanged, so nothing is discarded');
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

console.log('surfaceLayoutStore: mirror order and rev-1 upgrade ok');
