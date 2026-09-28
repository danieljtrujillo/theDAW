/**
 * The OWL-Pad and the Spatializer pad: each axis is a real slider (role
 * slider, aria-valuenow, keyboard operable), and the pad keeps its drag. Up to
 * afd27bea each pad was one role="application" surface with no value for
 * either axis and no keyboard route to it. (EffectXYPad is covered by
 * effects/EffectKnob.gesture.test.ts.)
 *
 *   cd frontend && npx tsx src/components/audio/PadAxisSlider.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { padAxisNext } from './PadAxisSlider.tsx';

// The keys the ARIA slider pattern lists.
assert.equal(padAxisNext('ArrowRight', false, 0.5, 0, 1, 0.01), 0.51);
assert.equal(padAxisNext('ArrowUp', false, 0.5, 0, 1, 0.01), 0.51);
assert.equal(padAxisNext('ArrowLeft', true, 0.5, 0, 1, 0.01), 0.4);
assert.equal(padAxisNext('PageDown', false, 0.05, 0, 1, 0.01), 0, 'clamped to the minimum');
assert.equal(padAxisNext('Home', false, 0.5, -8, 8, 0.1), -8);
assert.equal(padAxisNext('End', false, 0.5, -8, 8, 0.1), 8);
assert.equal(padAxisNext('a', false, 0.5, 0, 1, 0.01), null);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of ['window', 'document', 'HTMLElement', 'SVGElement', 'Node', 'Event', 'getComputedStyle']) {
  Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
}
g.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const { OwlPad } = await import('./OwlPad.tsx');
const { SpatializerPad } = await import('./SpatializerPad.tsx');
const doc = dom.window.document;
const key = (el: Element, type: 'keydown' | 'keyup', k: string) =>
  act(() => { el.dispatchEvent(new dom.window.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true })); });
const press = async (el: Element, k: string) => { await key(el, 'keydown', k); await key(el, 'keyup', k); };
const slider = (host: Element, name: string) => {
  const el = host.querySelector(`[role="slider"][aria-label="${name}"]`);
  assert.ok(el, `a "${name}" slider`);
  return el;
};

// OWL-Pad: X and Y sliders; a key engages the effect and, with HOLD off, its release gates back to dry.
{
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const root = createRoot(host);
  const log: string[] = [];
  let params: Record<string, number> = { x: 0.5, y: 0.3, program: 0, hold: 0, active: 0, mix: 1 };
  const render = () => root.render(React.createElement(OwlPad, {
    params,
    onChange: (p: Record<string, number>) => { params = p; log.push(`x=${p.x} y=${p.y} active=${p.active}`); render(); },
    idPrefix: 'fx1',
    onGestureStart: () => log.push('start'),
    onGestureEnd: () => log.push('end'),
  }));
  await act(async () => { render(); });
  const surface = host.querySelector('svg[role="group"]');
  assert.ok(surface, 'the pad is a labelled group');
  assert.match(surface.getAttribute('aria-label') ?? '', /OWL-Pad XY pad/);
  const sx = slider(host, 'OWL-Pad Freq (X)');
  const sy = slider(host, 'OWL-Pad Reso (Y)');
  assert.deepEqual([sx.getAttribute('aria-valuemin'), sx.getAttribute('aria-valuemax'), sx.getAttribute('aria-valuenow')], ['0', '1', '0.5']);
  assert.equal(sy.getAttribute('aria-valuetext'), 'Reso 30%');
  assert.equal(sx.getAttribute('tabindex'), '0');
  await press(sx, 'ArrowRight');
  assert.deepEqual(log, ['start', 'x=0.51 y=0.3 active=1', 'x=0.51 y=0.3 active=0', 'end'], 'engage, move, gate back to dry, one gesture');
  assert.equal(slider(host, 'OWL-Pad Freq (X)').getAttribute('aria-valuenow'), '0.51');
  log.length = 0;
  params = { ...params, hold: 1 };
  await act(async () => { render(); });
  await press(slider(host, 'OWL-Pad Reso (Y)'), 'PageUp');
  assert.deepEqual(log, ['start', 'x=0.51 y=0.4 active=1', 'end'], 'HOLD on keeps the effect engaged after the key');
  await act(async () => { root.unmount(); });
}

// Spatializer: left-right and front-back sliders through the source.
{
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const root = createRoot(host);
  let params: Record<string, number> = { azimuth: 0, elevation: 0, distance: 2, motion: 0 };
  const log: string[] = [];
  const render = () => root.render(React.createElement(SpatializerPad, {
    params,
    onChange: (p: Record<string, number>) => { params = p; log.push(`az=${p.azimuth} d=${p.distance}`); render(); },
    idPrefix: 'fx2',
    onGestureStart: () => log.push('start'),
    onGestureEnd: () => log.push('end'),
  }));
  await act(async () => { render(); });
  assert.ok(host.querySelector('svg[role="group"]'), 'the pad is a labelled group');
  const sx = slider(host, 'Source left-right (X)');
  const sz = slider(host, 'Source front-back (Z)');
  assert.deepEqual([sx.getAttribute('aria-valuenow'), sx.getAttribute('aria-valuetext')], ['0', 'centre']);
  assert.deepEqual([sz.getAttribute('aria-valuenow'), sz.getAttribute('aria-valuetext')], ['2', '2.0 in front']);
  // The axes span the distance param's range (0.5-10), so a source at 10 reads inside its slider.
  assert.deepEqual([sx.getAttribute('aria-valuemin'), sx.getAttribute('aria-valuemax')], ['-10', '10']);
  // End on X: the source goes to the right end, still 2 in front, and its distance holds at the param's 10.
  await press(sx, 'End');
  assert.deepEqual(log, ['start', `az=${Math.round((Math.atan2(10, 2) * 180) / Math.PI)} d=10`, 'end']);
  // Home on Z from straight ahead: the source goes behind.
  log.length = 0;
  params = { ...params, azimuth: 0, distance: 2 };
  await act(async () => { render(); });
  await press(slider(host, 'Source front-back (Z)'), 'Home');
  assert.deepEqual(log, ['start', 'az=180 d=10', 'end']);
  assert.equal(slider(host, 'Source front-back (Z)').getAttribute('aria-valuetext'), '10.0 behind');
  // A source at 10 on the far right: its X slider's value is inside its range.
  params = { ...params, azimuth: 90, distance: 10 };
  await act(async () => { render(); });
  const far = slider(host, 'Source left-right (X)');
  assert.ok(Number(far.getAttribute('aria-valuenow')) <= Number(far.getAttribute('aria-valuemax')), 'aria-valuenow <= aria-valuemax');
  // From the default place (1.5 in front), ArrowDown on Z walks the source through the listener to behind.
  // It used to stop at 0.5 in front: each step inside the 0.5 floor was pushed back out to it.
  params = { ...params, azimuth: 0, distance: 1.5 };
  await act(async () => { render(); });
  for (let i = 0; i < 12; i++) await press(slider(host, 'Source front-back (Z)'), 'ArrowDown');
  assert.deepEqual([params.azimuth, params.distance], [180, 0.6], 'behind the listener, 0.6 back');
  // At 0.5 on the right, ArrowLeft on X crosses to 0.5 on the left.
  params = { ...params, azimuth: 90, distance: 0.5 };
  await act(async () => { render(); });
  await press(slider(host, 'Source left-right (X)'), 'ArrowLeft');
  assert.deepEqual([params.azimuth, params.distance], [-90, 0.5]);
  await act(async () => { root.unmount(); });
}

console.log('PadAxisSlider: ok');
