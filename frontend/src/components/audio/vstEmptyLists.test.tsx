/**
 * What an empty VST3 list tells the user to do.
 *
 * Seen live on 2026-09-29: 41 plugins installed, and EDIT's instrument slot
 * listed none of the synths, saying "Set your plugin folders in Settings, then
 * rescan." Settings has no plugin folder setting. The scan reads the standard
 * VST3 folder (a folder linked into it included), so every empty list names
 * that folder and the rescan key.
 *
 * Replays the user's slot as it was (plugins found, none of them classified an
 * instrument yet), EDIT's effect rack VST browser with nothing scanned, and
 * MIX's browser text, rendering the real components with react-dom in jsdom.
 *
 *   cd frontend && npx tsx src/components/audio/vstEmptyLists.test.tsx
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
  Element: win.Element,
  Node: win.Node,
  Event: win.Event,
  MouseEvent: win.MouseEvent,
  MutationObserver: win.MutationObserver,
  localStorage: win.localStorage,
  requestAnimationFrame: win.requestAnimationFrame?.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame?.bind(win),
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { TrackVstInstrument } = await import('./TrackVstInstrument.tsx');
const { FxChainList } = await import('./EffectWindows.tsx');
const { vstBrowserEmptyText } = await import('../../state/vstStore.ts');
const { useEditorStore } = await import('../../state/editorStore.ts');
type Vst3PluginInfo = import('../../lib/vstClient.ts').Vst3PluginInfo;

const FOLDER = 'C:\\Program Files\\Common Files\\VST3';

/** The text is true: it names the folder the scan reads and the rescan key,
 *  and no setting that does not exist. */
const assertTrueHint = (text: string, where: string): void => {
  assert.ok(text.includes(FOLDER), `${where} names the VST3 folder the scan reads: ${text}`);
  assert.match(text, /link/i, `${where} says a folder linked into it counts: ${text}`);
  assert.match(text, /Rescan/, `${where} names the rescan key: ${text}`);
  assert.doesNotMatch(text, /Settings/, `${where} names no Settings control: ${text}`);
};

const click = (el: Element | null) =>
  act(async () => {
    assert.ok(el, 'the control is there');
    (el as HTMLElement).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });

const ed = () => useEditorStore.getState();
ed().loadProject({ tracks: [], clips: [] });
const trackId = ed().addTrack({ name: 'Lead' });
const track = () => ed().tracks.find((t) => t.id === trackId)!;

// ── EDIT's instrument slot, as the user saw it ──────────────────────────────
// Plugins were found; the synths had not been classified, so none is an
// instrument and the slot's list is empty.
{
  const scanned = (name: string, category: string): Vst3PluginInfo => ({
    name,
    path: `${FOLDER}\\${name}.vst3`,
    manufacturer: '',
    version: '',
    category,
    file_size_mb: 1,
    last_modified: 0,
  });
  const plugins = [scanned('Surge XT', 'unknown'), scanned('Zebralette3', 'unknown'), scanned('OTT', 'effect')];
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host);
  const show = () =>
    act(async () =>
      root.render(<TrackVstInstrument track={track()} plugins={plugins} scanning={false} onRescan={() => undefined} onOpenEditor={() => undefined} />),
    );
  await show();
  await click(host.querySelector('[aria-label="Choose a VST3 instrument for track Lead"]'));
  await show();
  assert.match(host.textContent ?? '', /Instruments \(0\)/);
  const empty = host.querySelector('p');
  assertTrueHint(empty?.textContent ?? '', 'the empty instrument slot');
  assert.ok(host.querySelector('[aria-label="Rescan VST3 folders"]'), 'the rescan key the text names is beside it');
  await act(async () => root.unmount());
}

// ── EDIT's effect rack VST browser, nothing scanned ─────────────────────────
{
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <FxChainList
        scope={{ kind: 'track', trackId }}
        onOpenEntry={() => undefined}
        onAddVst={() => undefined}
        vstPlugins={[]}
        vstScanning={false}
        onRescanVst={() => undefined}
      />,
    ),
  );
  const vstKey = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'VST') ?? null;
  await click(vstKey);
  assert.match(host.textContent ?? '', /Plugins \(0\)/, 'the VST browser is open');
  const empty = [...host.querySelectorAll('p')].find((p) => /No VST3 plugins found/.test(p.textContent ?? ''));
  assertTrueHint(empty?.textContent ?? '', "the effect rack's empty VST browser");
  await act(async () => root.unmount());
}

// ── MIX's VST browser ───────────────────────────────────────────────────────
assertTrueHint(vstBrowserEmptyText(false, null), "MIX's empty VST browser");
assert.equal(vstBrowserEmptyText(true, null), 'Scanning…');

console.log('vstEmptyLists: all assertions passed');
