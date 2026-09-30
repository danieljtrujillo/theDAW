/**
 * The Reverb device's hall picker, mounted through the generic panel every
 * rack effect is edited in (EffectControls): a labelled select for the hall
 * and one for the stage position, each writing its numeric param.
 *
 *   cd frontend && npx tsx src/components/audio/effects/reverbHallControls.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLSelectElement', 'Node', 'Event', 'getComputedStyle', 'navigator']) {
    Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { EffectControls } = await import('./EffectControls.tsx');
  const { schemaForRackEffect } = await import('./effectSchema.ts');
  const { getRackEffect, rackEffectDefaults } = await import('../../../lib/rackEffects.ts');
  const { HALL_OPTION_LABELS, POSITION_OPTION_LABELS } = await import('../../../lib/hallIrs.ts');

  const schema = schemaForRackEffect(getRackEffect('reverb')!);
  const writes: Record<string, number>[] = [];
  const doc = dom.window.document;
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(EffectControls, {
      schema,
      params: rackEffectDefaults('reverb'),
      onChange: (next: Record<string, number>) => writes.push(next),
      idPrefix: 'rv',
      layout: 'expanded',
    }));
  });

  const labelled = (text: string): HTMLSelectElement => {
    const label = [...doc.querySelectorAll('label')].find((l) => l.textContent === text);
    assert.ok(label, `a "${text}" label`);
    const el = doc.getElementById(label.getAttribute('for') ?? '') as HTMLSelectElement | null;
    assert.ok(el && el.tagName === 'SELECT', `"${text}" labels a select`);
    return el;
  };
  const hall = labelled('Hall');
  const position = labelled('Stage position');
  assert.deepEqual([...hall.options].map((o) => o.textContent), [...HALL_OPTION_LABELS]);
  assert.deepEqual([...position.options].map((o) => o.textContent), [...POSITION_OPTION_LABELS]);
  assert.equal(hall.options[hall.selectedIndex].textContent, 'Synthetic room', 'the synthesized room by default');

  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!;
  const pick = async (el: HTMLSelectElement, index: number) => {
    await act(async () => {
      setter.call(el, String(index));
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  };
  await pick(hall, 1);
  assert.equal(writes.at(-1)?.hall, 1, 'the front stalls');
  await pick(position, 6);
  assert.equal(writes.at(-1)?.position, 6, 'back left');
  await act(async () => { root.unmount(); });
  console.log('reverbHallControls: ok');
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
