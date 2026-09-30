/**
 * EffectsVizPanel: a bypassed `parametric_eq` draws a flat 0 dB line, not its
 * real (but currently inert) curve.
 *
 * `EffectsVizPanel.tsx`'s own module graph never reaches `state/playerStore`
 * (unlike `MixerStrips.tsx`/`EffectGuiStage.tsx` — see those files' own
 * `.b12.test.tsx` header comments), so this renders normally: jsdom globals
 * installed up front, then the real component.
 *
 * Run: `npx tsx src/views/EffectsVizPanel.render.b12.test.ts`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'getComputedStyle']) {
  Object.defineProperty(g, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
g.IS_REACT_ACT_ENVIRONMENT = true;

async function main(): Promise<void> {
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { EffectsVizPanel } = await import('./EffectsVizPanel.tsx');
  const { act } = React;
  const doc = dom.window.document;

  const host = doc.getElementById('root')!;
  const root = createRoot(host);
  const params = { low: 12, midFreq: 1000, mid: 0, high: 0 }; // a real, non-flat boost

  await act(async () => {
    root.render(React.createElement(EffectsVizPanel, { effect: 'parametric_eq', params, enabled: true }));
  });
  const enabledPath = host.querySelector('svg path')?.getAttribute('d') ?? '';
  assert.ok(enabledPath.length > 0, 'an enabled parametric_eq draws a curve');
  assert.ok(enabledPath.split(' ').length > 2, 'the enabled curve is a real multi-point sweep, not a flat line');

  await act(async () => {
    root.render(React.createElement(EffectsVizPanel, { effect: 'parametric_eq', params, enabled: false }));
  });
  const disabledPath = host.querySelector('svg path')?.getAttribute('d') ?? '';
  assert.ok(disabledPath.length > 0, 'a disabled parametric_eq still draws A curve (a flat one), not nothing');
  assert.equal(disabledPath.split(' ').length, 2, 'the disabled curve is exactly two points — a flat line');
  assert.notEqual(disabledPath, enabledPath, 'disabling the effect actually changes what is drawn');

  await act(async () => root.unmount());
  console.log('EffectsVizPanel: a bypassed parametric_eq draws a flat 0 dB line — all assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
