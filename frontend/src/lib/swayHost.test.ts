/**
 * swayHost holds the data half of the SWAY tab's cockpit protocol: what a frame
 * from the cockpit asks for, the scene rows with the Gantasmo scenes first and then the saves,
 * the lists "Open scene" and the cockpit both read, the sway/host-scenes body
 * and the hardware line.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/lib/swayHost.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import type { PlaceItem } from './placesClient';
import {
  HOST_CAP_PLUGIN_FILE,
  HOST_CAPS,
  cockpitAction,
  hardwareStatus,
  hostScenesFrame,
  loadSceneLists,
  orderSceneRows,
  pluginFileFrame,
  recentOutsideSceneFolder,
  sceneRowsFrom,
  type SwaySceneRow,
} from './swayHost';

// ── sway/ready carries the cockpit's caps; a cockpit without them has none ───
assert.deepEqual(cockpitAction({ type: 'sway/ready', v: 1, caps: ['host-header', 'host-scenes'] }), {
  kind: 'ready',
  caps: ['host-header', 'host-scenes'],
});
assert.deepEqual(cockpitAction({ type: 'sway/ready', v: 1, app: 'swaycommand' }), { kind: 'ready', caps: [] });
assert.deepEqual(cockpitAction({ type: 'sway/ready', caps: 'host-header' }), { kind: 'ready', caps: [] });
assert.deepEqual(cockpitAction({ type: 'sway/ready', caps: ['host-header', 7, null] }), {
  kind: 'ready',
  caps: ['host-header'],
});

// ── sway/set-audio-source maps the cockpit's 'host' to theDAW's master ───────
assert.deepEqual(cockpitAction({ type: 'sway/set-audio-source', source: 'host' }), {
  kind: 'set-audio-source',
  source: 'thedaw',
});
assert.deepEqual(cockpitAction({ type: 'sway/set-audio-source', source: 'input' }), {
  kind: 'set-audio-source',
  source: 'input',
});
assert.equal(cockpitAction({ type: 'sway/set-audio-source', source: 'thedaw' }), null);
assert.equal(cockpitAction({ type: 'sway/set-audio-source' }), null);

// ── scene requests ───────────────────────────────────────────────────────────
assert.deepEqual(cockpitAction({ type: 'sway/request-scenes' }), { kind: 'request-scenes' });
assert.deepEqual(cockpitAction({ type: 'sway/choose-scene-file' }), { kind: 'choose-scene-file' });

// ── the cockpit's LOAD .gan chooser asks this host for a file ────────────────
assert.deepEqual(cockpitAction({ type: 'sway/choose-plugin-file', v: 1 }), { kind: 'choose-plugin-file' });
assert.ok(HOST_CAPS.includes(HOST_CAP_PLUGIN_FILE), 'sway/host-ready announces that the request is answered');
// A pick answers with the path and its name; a cancel with no path and no failure.
assert.deepEqual(pluginFileFrame({ path: 'D:\\gan\\the-owl.gan', cancelled: false }), {
  type: 'sway/plugin-file',
  path: 'D:\\gan\\the-owl.gan',
  name: 'the-owl.gan',
});
assert.deepEqual(pluginFileFrame({ path: null, cancelled: true }), { type: 'sway/plugin-file', path: null });
assert.deepEqual(pluginFileFrame({ path: '  ', cancelled: false }), { type: 'sway/plugin-file', path: null });
// A file of another kind is a failure, so theDAW is never asked to open it as a .gan.
assert.deepEqual(pluginFileFrame({ path: '/home/u/song.wav', cancelled: false }), {
  type: 'sway/plugin-file',
  path: null,
  failure: 'Choose a file that ends in .gan.',
});
// A failure the host names wins over whatever was picked.
assert.deepEqual(pluginFileFrame({ path: 'D:\\gan\\ares.gan' }, 'A .gan file can be chosen only on the computer theDAW runs on.'), {
  type: 'sway/plugin-file',
  path: null,
  failure: 'A .gan file can be chosen only on the computer theDAW runs on.',
});
assert.deepEqual(pluginFileFrame(null), { type: 'sway/plugin-file', path: null });

// ── a track's right-click ────────────────────────────────────────────────────
assert.deepEqual(cockpitAction({ type: 'sway/track-menu', trackId: 't1', name: 'Drums', empty: true, x: 40, y: 200 }), {
  kind: 'track-menu',
  trackId: 't1',
  name: 'Drums',
  empty: true,
  x: 40,
  y: 200,
});
// A blank name gets a stand-in; a missing point or track is no request.
assert.equal(cockpitAction({ type: 'sway/track-menu', trackId: 't1', name: ' ', x: 1, y: 2 })?.kind, 'track-menu');
assert.equal((cockpitAction({ type: 'sway/track-menu', trackId: 't1', name: ' ', x: 1, y: 2 }) as { name: string }).name, 'this track');
assert.equal(cockpitAction({ type: 'sway/track-menu', trackId: 't1', x: '1', y: 2 }), null);
assert.equal(cockpitAction({ type: 'sway/track-menu', name: 'Drums', x: 1, y: 2 }), null);
assert.deepEqual(cockpitAction({ type: 'sway/open-scene', name: 'Club' }), {
  kind: 'open-scene',
  name: 'Club',
  path: null,
});
assert.deepEqual(cockpitAction({ type: 'sway/open-scene', path: 'C:\\x\\a.sway' }), {
  kind: 'open-scene',
  name: null,
  path: 'C:\\x\\a.sway',
});
assert.deepEqual(cockpitAction({ type: 'sway/open-scene', name: 'Club', path: 'D:\\s\\Club.sway' }), {
  kind: 'open-scene',
  name: 'Club',
  path: 'D:\\s\\Club.sway',
});
assert.equal(cockpitAction({ type: 'sway/open-scene' }), null, 'an open with nothing to open is ignored');
assert.equal(cockpitAction({ type: 'sway/open-scene', name: '   ', path: 4 }), null);

// ── anything else is not a request ───────────────────────────────────────────
for (const frame of [null, undefined, 'sway/ready', 42, {}, { type: 'sway/midi', data: [176, 1, 2] }, { type: 7 }]) {
  assert.equal(cockpitAction(frame), null, JSON.stringify(frame));
}

// ── scene rows: the Gantasmo scenes first, then saves, each newest first ─────
const row = (name: string, builtin: boolean, mtime: number): SwaySceneRow => ({
  name,
  path: `D:\\data\\sway-projects\\${name}.sway`,
  builtin,
  mtime,
});
const mixed = [
  row('will-i-dream', true, 50),
  row('Old Set', false, 10),
  row('miracle-mile', true, 90),
  row('New Set', false, 70),
  row('natures-tomb', true, 20),
];
assert.deepEqual(
  orderSceneRows(mixed).map((r) => r.name),
  ['miracle-mile', 'will-i-dream', 'natures-tomb', 'New Set', 'Old Set'],
);
assert.equal(mixed[0].name, 'will-i-dream', 'the input is left as it was');

// ── the listing body: a row without builtin is a save, bad rows are dropped ──
assert.deepEqual(
  sceneRowsFrom([
    { name: 'Legacy', path: 'D:\\s\\Legacy.sway', mtime: 5 },
    { name: 'Shipped', path: 'D:\\s\\Shipped.sway', mtime: 6, builtin: true },
    { name: 'No Path', mtime: 1 },
    null,
    { name: 'Odd', path: 'D:\\s\\Odd.sway', mtime: 'soon', builtin: 'yes' },
  ]),
  [
    { name: 'Legacy', path: 'D:\\s\\Legacy.sway', builtin: false, mtime: 5 },
    { name: 'Shipped', path: 'D:\\s\\Shipped.sway', builtin: true, mtime: 6 },
    { name: 'Odd', path: 'D:\\s\\Odd.sway', builtin: false, mtime: 0 },
  ],
);
assert.deepEqual(sceneRowsFrom(undefined), []);

// ── recent files: servable ones outside the scene folder ─────────────────────
const place = (path: string, servable = true): PlaceItem => ({
  path,
  name: '',
  kind: 'sway',
  source: 'download',
  at: 1,
  servable,
});
assert.deepEqual(
  recentOutsideSceneFolder(
    [place('d:/data/sway-projects/New Set.sway'), place('C:\\Downloads\\Gift.sway'), place('C:\\x\\Gone.sway', false)],
    [row('New Set', false, 70)],
  ).map((p) => p.path),
  ['C:\\Downloads\\Gift.sway'],
);

// ── the sway/host-scenes body ────────────────────────────────────────────────
const lists = { rows: orderSceneRows(mixed), recent: [place('C:\\Downloads\\Gift.sway')], error: null };
const frame = hostScenesFrame(lists);
assert.deepEqual(frame.rows[0], row('miracle-mile', true, 90));
assert.deepEqual(frame.recent, [{ name: 'Gift.sway', path: 'C:\\Downloads\\Gift.sway' }]);
assert.equal('error' in frame, false, 'no error key when nothing failed');
assert.equal(
  hostScenesFrame({ ...lists, error: 'HTTP 500' }).error,
  'Could not read the saved scenes: HTTP 500',
);
assert.equal(
  hostScenesFrame({ ...lists, error: 'HTTP 500' }, 'That scene file is gone or was never opened in theDAW.').error,
  'That scene file is gone or was never opened in theDAW.',
  'the failure the cockpit asked about wins',
);

// ── the hardware line and its tone ───────────────────────────────────────────
assert.deepEqual(hardwareStatus(false, ['Audima Labs The Sway']), { hardware: 'MIDI off', tone: 'off' });
assert.deepEqual(hardwareStatus(true, []), { hardware: 'no MIDI device', tone: 'none' });
// The port is "Audima Labs The Sway"; the label names the hardware without "The".
assert.deepEqual(hardwareStatus(true, ['nanoKONTROL2', 'Audima Labs The Sway']), {
  hardware: 'Audima Labs Sway',
  tone: 'ok',
});
assert.deepEqual(hardwareStatus(true, ['nanoKONTROL2', 'LPD8']), { hardware: 'nanoKONTROL2, LPD8', tone: 'ok' });

// ── loadSceneLists reads both lists and orders them ──────────────────────────
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let projects: () => Response = () => json({ projects: mixed });
const recentItems = [place('D:\\data\\sway-projects\\Old Set.sway'), place('C:\\Downloads\\Gift.sway')];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : String(input);
  if (url === '/api/sway/projects') return projects();
  if (url.startsWith('/api/places/recent')) return json({ items: recentItems });
  return new Response('', { status: 404 });
}) as typeof fetch;

const read = await loadSceneLists();
assert.deepEqual(
  read.rows.map((r) => r.name),
  ['miracle-mile', 'will-i-dream', 'natures-tomb', 'New Set', 'Old Set'],
);
assert.deepEqual(
  read.recent.map((p) => p.path),
  ['C:\\Downloads\\Gift.sway'],
);
assert.equal(read.error, null);

// A listing that fails still hands back the recent files, and says why.
projects = () => json({ detail: 'listing broke' }, 500);
const broken = await loadSceneLists();
assert.deepEqual(broken.rows, []);
assert.equal(broken.error, 'listing broke');
assert.equal(broken.recent.length, 2);

console.log('swayHost tests passed');
