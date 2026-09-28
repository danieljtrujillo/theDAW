/**
 * A downloaded sound bank in the Banks dialog: it is marked Downloaded, its
 * button says Delete, and deleting it asks first. Keep leaves it; Delete sends
 * the DELETE (the backend deletes the downloaded file) and the bank leaves
 * every list. A bank the user added keeps its one-click Remove.
 *
 *   cd frontend && npx tsx src/components/audio/soundBanks.download.ui.test.tsx
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
  HTMLInputElement: win.HTMLInputElement,
  Node: win.Node,
  Event: win.Event,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

const orchestra = {
  id: 'dl-thedaw-orchestra-thedaw-orchestra-1a2b3c4d',
  name: 'theDAW Orchestra',
  format: 'sf3',
  offset: 32,
  span: 12,
  size: 80 << 20,
  path: 'C:/data/soundbanks/thedaw-orchestra/theDAW-Orchestra.sf3',
  presets: [{ bank: 1, bank_lsb: 0, program: 73, name: 'Flute Staccato', drum: false }],
  download_id: 'thedaw-orchestra',
};
const added = {
  id: 'sb-0123456789ab',
  name: 'Chamber Strings',
  format: 'sf2',
  offset: 44,
  span: 1,
  presets: [{ bank: 0, bank_lsb: 0, program: 40, name: 'Solo Violin', drum: false }],
};
let listed: unknown[] = [orchestra, added];
const calls: string[] = [];
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${u}`);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u === '/api/soundfonts' && method === 'GET') return json({ banks: listed, offset_range: [32, 119] });
  if (u.startsWith('/api/soundfonts/') && method === 'DELETE') {
    const id = decodeURIComponent(u.split('/')[3]);
    listed = listed.filter((b) => (b as { id: string }).id !== id);
    return json({ removed: id });
  }
  if (u.endsWith('/manifest')) return json({ playback_gain: {} });
  if (u.startsWith('/api/places/recent')) return json({ items: [] });
  return json({});
}) as typeof fetch;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { SoundBanksDialog } = await import('./SoundBanksDialog.tsx');
const { useSoundBankStore } = await import('../../state/soundBankStore.ts');

const host = win.document.createElement('div');
win.document.body.appendChild(host);
const root = createRoot(host);
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const q = (sel: string) => win.document.querySelector(sel) as HTMLButtonElement | null;

await act(async () => root.render(<SoundBanksDialog onClose={() => undefined} />));
await flush();

assert.match(win.document.body.textContent ?? '', /Downloaded · SF3/, 'the downloaded bank says so');
assert.ok(q('button[aria-label="Remove sound bank Chamber Strings"]'), 'a bank the user added keeps Remove');
const del = q('button[aria-label="Delete downloaded sound bank theDAW Orchestra"]');
assert.ok(del, 'the downloaded bank has Delete');
assert.equal(del!.textContent?.trim(), 'Delete');

// Delete asks first; Keep leaves it.
await act(async () => del!.click());
assert.ok(win.document.querySelector('[role="group"][aria-label="Delete theDAW Orchestra from disk?"]'), 'the confirm is shown');
assert.ok(!calls.some((c) => c.startsWith('DELETE')), 'nothing is deleted before the confirm');
await act(async () => q('button[aria-label="Keep theDAW Orchestra"]')!.click());
assert.equal(win.document.querySelector('[role="group"]'), null, 'Keep closes the confirm');
assert.ok(!calls.some((c) => c.startsWith('DELETE')));

// Delete, confirmed.
await act(async () => q('button[aria-label="Delete downloaded sound bank theDAW Orchestra"]')!.click());
await act(async () => q('button[aria-label="Delete theDAW Orchestra from disk"]')!.click());
await flush();
assert.ok(calls.includes(`DELETE /api/soundfonts/${orchestra.id}`), 'the confirmed Delete reaches the backend');
assert.deepEqual(
  useSoundBankStore.getState().banks.filter((b) => b.kind === 'user').map((b) => b.id),
  [added.id],
  'the downloaded bank leaves the list',
);

await act(async () => root.unmount());
console.log('soundBanks.download.ui: ok');
