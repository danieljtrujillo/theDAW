/**
 * EffectGuiStage: output routing for the edit-module windows (T19).
 *
 * Each edit-module page builds its own preview AudioContext outside the
 * shared engine graph (`public/edit-modules/module-kit.js`'s
 * `moduleKitOutputDevice.b12.test.ts` is that file's own coverage), so it
 * never followed Settings -> Inputs & outputs on its own. This is the host
 * half: once the iframe loads, and again whenever the app's resolved main
 * output changes, EffectGuiStage posts
 * `{ type: 'thedaw-output-device', deviceId }` into it.
 *
 * `state/ioDevicesStore` reaches `state/playerStore` (`setEngineSink`), which
 * reads `import.meta.env.DEV` at module scope — Vite-only, the same wall
 * `MixerStrips.b12.test.tsx` documents. Imported before this file installs
 * the jsdom globals, for the same reason.
 *
 * Run: `npx tsx src/components/audio/EffectGuiStage.b12.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main(): Promise<void> {
  const { EffectGuiStage } = await import('./EffectGuiStage.tsx');
  const { useFeatureToggleStore } = await import('../../state/featureToggleStore.ts');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'window', 'document', 'HTMLElement', 'HTMLIFrameElement', 'Node', 'Event', 'MessageEvent', 'getComputedStyle',
  ]) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const doc = dom.window.document;

  const host = doc.getElementById('root')!;
  const root = createRoot(host);
  const module = { id: 'eq', name: 'EQ', file: 'eq.html', color: '#4dd0e1', category: 'EQ', desc: '', preview: 'eq-bars' };

  await act(async () => {
    root.render(React.createElement(EffectGuiStage, { module, sourceFile: null }));
  });

  const iframe = host.querySelector('iframe') as HTMLIFrameElement;
  assert.ok(iframe, 'the module iframe renders');
  const win = iframe.contentWindow!;
  assert.ok(win, 'jsdom gives a same-origin iframe a contentWindow');

  interface Posted {
    data: { type?: string; deviceId?: unknown };
    targetOrigin: unknown;
  }
  const posted: Posted[] = [];
  win.postMessage = ((data: unknown, targetOrigin: unknown) => {
    posted.push({ data: data as Posted['data'], targetOrigin });
  }) as typeof win.postMessage;

  await act(async () => {
    iframe.dispatchEvent(new dom.window.Event('load'));
  });

  const deviceMsgs = () => posted.filter((m) => m.data.type === 'thedaw-output-device');
  assert.ok(deviceMsgs().length >= 1, 'a thedaw-output-device message is posted once the iframe loads');
  assert.equal(deviceMsgs().at(-1)!.data.deviceId, '', 'with no device chosen yet, it posts the empty (OS default) id');
  // Audit round 3, minor #6: nothing previously pinned targetOrigin, so a
  // regression back to '*' would pass silently. window.location.origin in
  // jsdom's constructed URL ('http://localhost/') is 'http://localhost'.
  assert.equal(deviceMsgs().at(-1)!.targetOrigin, 'http://localhost', 'the device post targets the real origin, not \'*\'');

  // Changing the app's saved main-output device re-posts to the ALREADY
  // loaded iframe — a device swapped mid-session is followed live, not only
  // picked up on the next module open.
  posted.length = 0;
  await act(async () => {
    const s = useFeatureToggleStore.getState();
    useFeatureToggleStore.setState({ settings: { ...s.settings, io: { ...s.settings.io, audio_output: { id: 'dev-xyz', label: 'Interface Out' } } } });
  });
  assert.ok(deviceMsgs().length >= 1, 'a device change while the stage stays mounted is re-posted');
  assert.equal(deviceMsgs().at(-1)!.data.deviceId, 'dev-xyz', 'the re-post carries the newly chosen device id');
  assert.equal(deviceMsgs().at(-1)!.targetOrigin, 'http://localhost', 'the re-post still targets the real origin, not \'*\'');

  await act(async () => root.unmount());
  console.log('EffectGuiStage output-device follow: all assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
