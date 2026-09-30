/**
 * EDIT's track template picker, mounted: the list is labelled, the key names
 * the template it adds, and adding one writes the template to the store.
 *
 *   cd frontend && npx tsx src/components/audio/TrackTemplatePicker.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

async function main(): Promise<void> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLSelectElement', 'Node', 'Event', 'getComputedStyle']) {
    Object.defineProperty(g, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true, writable: true });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const { TrackTemplatePicker, TRACK_TEMPLATES } = await import('./TrackTemplatePicker.tsx');
  const { useEditorStore } = await import('../../state/editorStore.ts');
  const ed = () => useEditorStore.getState();
  ed().loadProject({ tracks: [], clips: [] });

  const doc = dom.window.document;
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(TrackTemplatePicker, { idBase: 'ed' })); });

  const select = doc.getElementById('ed-track-template') as HTMLSelectElement;
  assert.ok(select, 'the template list is a native select');
  assert.equal(select.getAttribute('name'), 'ed-track-template');
  assert.equal(doc.querySelector('label[for="ed-track-template"]')?.textContent, 'Track template', 'with a real label');
  assert.deepEqual(
    [...select.options].map((o) => o.textContent),
    ['Symphony orchestra, American seating', 'Symphony orchestra, European seating'],
  );
  assert.equal(TRACK_TEMPLATES.length, select.options.length);

  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(select, 'symphony-european');
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const add = host.querySelector('button') as HTMLButtonElement;
  assert.equal(add.getAttribute('aria-label'), 'Add template: Symphony orchestra, European seating', 'the key names what it adds');
  await act(async () => { add.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  assert.ok(ed().buses.some((b) => b.name === 'Hall'), 'the hall bus is added');
  const v2 = ed().tracks.find((t) => t.name === 'Violin II');
  assert.ok(v2 && v2.pan > 0, 'in the seating chosen');
  assert.equal(host.querySelector('[role="alert"]'), null, 'no error');
  await act(async () => { root.unmount(); });
  console.log('TrackTemplatePicker: ok');
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
