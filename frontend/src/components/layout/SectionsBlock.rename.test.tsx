/**
 * SectionsBlock: a section renamed in DETAILS is saved with the entry.
 *
 * The block reads the stored sections (GET /api/sections/{entry}), the user
 * types a name into a section's field and presses Enter, the block PATCHes
 * that section (/sections/{index} with `{name}`) and shows the document the
 * server answers with, so the name is what the entry now stores. Escape puts
 * the stored name back without a request.
 *
 * Client-rendered (createRoot) like RhythmBlock.b12.test.tsx: state set after
 * mount needs a live subscription to be visible.
 *
 * Run: cd frontend && npx tsx src/components/layout/SectionsBlock.rename.test.tsx
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { SongSection, SongSectionsDoc } from '../../lib/songSections';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
const win = dom.window;

const globals: Record<string, unknown> = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  HTMLInputElement: win.HTMLInputElement,
  HTMLButtonElement: win.HTMLButtonElement,
  HTMLDivElement: win.HTMLDivElement,
  Node: win.Node,
  KeyboardEvent: win.KeyboardEvent,
  localStorage: win.localStorage,
  sessionStorage: win.sessionStorage,
  getComputedStyle: win.getComputedStyle.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const sectionRow = (index: number, start_sec: number, end_sec: number, letter: string, name: string, role: string): SongSection => ({
  index,
  start_sec,
  end_sec,
  start_bar: start_sec / 2,
  bars: (end_sec - start_sec) / 2,
  letter,
  role,
  name,
  confidence: index === 0 ? 1 : 0.8,
  repeat_of: null,
  similarity: 0,
  energy: 0.5,
  stems: {},
});

let stored: SongSectionsDoc & { sections: SongSection[] } = {
  status: 'ready',
  entry_id: 'track-1',
  duration_sec: 48,
  grid: { source: 'rhythm', bars: 24 },
  sections: [sectionRow(0, 0, 16, 'A', 'Intro', 'intro'), sectionRow(1, 16, 32, 'B', 'B', 'verse'), sectionRow(2, 32, 48, 'C', 'C', 'chorus')],
};
const requests: Array<{ url: string; method: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  requests.push({ url, method, body });
  if (method === 'PATCH') {
    const index = Number(url.split('/').pop());
    stored = {
      ...stored,
      sections: stored.sections.map((s) => (s.index === index ? { ...s, ...(body.name ? { name: body.name, named_by_user: true } : {}), ...(body.role ? { role: body.role, role_by_user: true } : {}) } : s)),
    };
  }
  return { ok: true, json: async () => stored };
}) as unknown as typeof fetch;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { SectionsBlock } = await import('./SectionsBlock.tsx');

const document = win.document;
const step = (fn: () => void) => act(async () => { fn(); });

async function waitFor(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return;
    await step(() => {});
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await step(() => root.render(React.createElement(SectionsBlock, { entryId: 'track-1', title: 'Test Track' })));

await waitFor(() => host.querySelectorAll('[data-section-row]').length === 3, 'the three stored sections to list');
assert.equal(requests[0].url, '/api/sections/track-1', 'the block reads the stored sections first');
assert.equal(host.querySelector('[role="status"]')?.textContent?.trim(), 'Found');

// Every name field is a labelled native input; every role picker a labelled select.
host.querySelectorAll('[data-section-row]').forEach((row) => {
  const input = row.querySelector('input') as HTMLInputElement;
  const select = row.querySelector('select') as HTMLSelectElement;
  assert.ok(input.id && host.querySelector(`label[for="${input.id}"]`), 'the name field has a label');
  assert.ok(select.id && host.querySelector(`label[for="${select.id}"]`), 'the role picker has a label');
});

// Type "Hook" into section 2's name and press Enter.
const row = host.querySelector('[data-section-row="1"]') as HTMLElement;
const input = row.querySelector('input') as HTMLInputElement;
assert.equal(input.value, 'B');
const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
await step(() => {
  input.focus();
  setValue.call(input, 'Hook');
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
});
assert.equal(input.value, 'Hook', 'the draft shows as typed');
await step(() => input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
await step(() => input.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true })));
await waitFor(() => requests.some((r) => r.method === 'PATCH'), 'the rename to be saved');
const patch = requests.find((r) => r.method === 'PATCH')!;
assert.equal(patch.url, '/api/sections/track-1/sections/1', 'the rename goes to that section');
assert.deepEqual(patch.body, { name: 'Hook' });
await waitFor(() => stored.sections[1].name === 'Hook' && input.value === 'Hook', 'the stored document to carry the new name');
assert.equal(stored.sections[1].named_by_user, true);

// Escape puts the stored name back and sends nothing.
const before = requests.length;
await step(() => {
  setValue.call(input, 'typo');
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
});
await step(() => input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
await waitFor(() => input.value === 'Hook', 'Escape to restore the stored name');
await step(() => input.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true })));
await step(() => {});
assert.equal(requests.length, before, 'no request for an unchanged name');

// A role change is saved the same way.
const select = row.querySelector('select') as HTMLSelectElement;
const setSelect = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!;
await step(() => {
  setSelect.call(select, 'chorus');
  select.dispatchEvent(new win.Event('change', { bubbles: true }));
});
await waitFor(() => stored.sections[1].role === 'chorus', 'the role to be saved');
assert.deepEqual(requests[requests.length - 1].body, { role: 'chorus' });

await step(() => root.unmount());
host.remove();
globalThis.fetch = realFetch;

console.log('SectionsBlock: a renamed section is PATCHed to the entry and shown from the stored document; Escape restores the stored name; a role change is saved');
