/**
 * The instrument slot in an EDIT track header (TrackVstInstrument).
 *
 * The sequence: a MIDI track with no instrument shows one VST key; opening it
 * lists the scanned instruments and only those (an effect cannot play MIDI).
 * Picking one fills the slot; its name opens the plugin's own window; the power
 * key switches it off and on; the X empties it. Every control has a real name
 * and the list is a listbox the key controls.
 *
 *   cd frontend && npx tsx src/components/audio/TrackVstInstrument.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;
const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { TrackVstInstrument, instrumentPlugins } = await import('./TrackVstInstrument.tsx');
const { useEditorStore } = await import('../../state/editorStore.ts');
const { useVstLiveStore } = await import('../../state/vstLiveStore.ts');
type ChainEntry = import('../../state/effectChainStore.ts').ChainEntry;
type Vst3PluginInfo = import('../../lib/vstClient.ts').Vst3PluginInfo;

const plugin = (name: string, category: string, extra: Partial<Vst3PluginInfo> = {}): Vst3PluginInfo => ({
  name,
  path: `C:/Program Files/Common Files/VST3/${name}.vst3`,
  manufacturer: 'Vendor',
  version: '1',
  category,
  file_size_mb: 1,
  last_modified: 0,
  ...extra,
});
const plugins = [
  plugin('BBCSO', 'instrument', { display_name: 'BBC Symphony Orchestra', manufacturer: 'Spitfire Audio' }),
  plugin('Pro-Q 4', 'effect'),
  plugin('Opus', 'instrument'),
];
assert.deepEqual(instrumentPlugins(plugins).map((p) => p.name), ['BBCSO', 'Opus'], 'only instruments are offered');

const ed = () => useEditorStore.getState();
ed().loadProject({ tracks: [], clips: [] });
const trackId = ed().addTrack({ name: 'Violins I' });
const track = () => ed().tracks.find((t) => t.id === trackId)!;

const opened: ChainEntry[] = [];
let rescans = 0;
const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
const show = () =>
  act(async () =>
    root.render(
      <TrackVstInstrument track={track()} plugins={plugins} scanning={false} onRescan={() => { rescans += 1; }} onOpenEditor={(e) => opened.push(e)} />,
    ),
  );
const click = (el: Element | null) =>
  act(async () => {
    assert.ok(el, 'the control is there');
    (el as HTMLElement).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`);

await show();
const key = byLabel('Choose a VST3 instrument for track Violins I');
assert.ok(key, 'an empty slot is one VST key with its name');
assert.equal(key.getAttribute('aria-expanded'), 'false');
assert.equal(key.getAttribute('aria-haspopup'), 'listbox');
assert.match(host.textContent ?? '', /No VST instrument/);

await click(key);
await show();
const list = host.querySelector('[role="listbox"]');
assert.ok(list, 'the key opens the list');
assert.equal(key.getAttribute('aria-controls'), list.id, 'the key names the list it controls');
assert.equal(key.getAttribute('aria-expanded'), 'true');
const options = [...host.querySelectorAll('[role="option"]')];
assert.deepEqual(options.map((o) => o.textContent), ['BBC Symphony OrchestraSpitfire Audio', 'OpusVendor'], "the plugins' own names, vendor beside");
assert.ok(options.every((o) => o.getAttribute('aria-selected') === 'false'));
await click(byLabel('Rescan VST3 folders'));
assert.equal(rescans, 1);

// Pick BBC SO: the slot fills and the list closes.
await click(options[0]);
await show();
assert.equal(track().instrument?.vst?.plugin_path, plugins[0].path);
assert.equal(track().instrument?.vst?.plugin_name, 'BBC Symphony Orchestra');
assert.equal(host.querySelector('[role="listbox"]'), null, 'the list closes on a pick');
assert.ok(byLabel('Change the VST3 instrument of track Violins I'), 'the key now changes the instrument');
assert.match(host.textContent ?? '', /Print/, 'no live session yet: the slot prints on bounce');

// Its name opens the plugin's own window, on the slot's own entry.
await click(byLabel('Open BBC Symphony Orchestra, the instrument of track Violins I'));
assert.equal(opened.length, 1);
assert.equal(opened[0].id, track().instrument?.id);

// The live host reports it sounding: the dot says Live.
await act(async () => {
  useVstLiveStore.setState((s) => ({ entries: { ...s.entries, [track().instrument!.id]: { ...(s.entries[track().instrument!.id] ?? {}), status: 'live' } } }) as never);
});
await show();
assert.match(host.textContent ?? '', /Live/);

// Off and on again.
const power = byLabel('Track Violins I instrument on');
assert.equal(power?.getAttribute('aria-pressed'), 'true');
await click(power);
await show();
assert.equal(track().instrument?.enabled, false);
assert.equal(byLabel('Track Violins I instrument on')?.getAttribute('aria-pressed'), 'false');
await click(byLabel('Track Violins I instrument on'));
assert.equal(track().instrument?.enabled, true);

// Articulations: a labelled select, keyswitch until the user picks UACC.
await show();
const switchSelect = host.querySelector('select') as HTMLSelectElement | null;
assert.ok(switchSelect, 'the filled slot offers how articulations are sent');
assert.ok(switchSelect.id && switchSelect.name, 'the select has an id and a name');
const switchLabel = host.querySelector(`label[for="${switchSelect.id}"]`);
assert.equal(switchLabel?.textContent?.trim(), 'Articulations', 'a real label names it');
assert.equal(switchSelect.value, 'keyswitch');
await act(async () => {
  switchSelect.value = 'uacc';
  switchSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
});
assert.equal(track().articulationSwitch, 'uacc');
await show();
assert.equal((host.querySelector('select') as HTMLSelectElement).value, 'uacc');

// Remove empties the slot.
await show();
await click(byLabel('Remove the instrument from track Violins I'));
await show();
assert.equal(track().instrument, undefined);
assert.ok(byLabel('Choose a VST3 instrument for track Violins I'));
assert.equal(host.querySelector('select'), null, 'an empty slot has no articulation select');

// No text under 12px: every class names text-xs (12px) or larger.
assert.ok(!/text-\[(?:[0-9]|1[01])px\]/.test(host.innerHTML), 'no text under 12px');

await act(async () => root.unmount());
console.log('TrackVstInstrument: all assertions passed');
