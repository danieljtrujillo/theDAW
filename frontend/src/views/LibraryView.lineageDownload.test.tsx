/**
 * The library toolbar's DOWNLOAD > Lineage report, on a family larger than
 * the lineage route's cap.
 *
 * The sequence that lost data: DOWNLOAD, Lineage report, and each file on disk
 * holding the first 600 relatives of its song. This mounts the real toolbar
 * (jsdom, React), opens its menu, picks the row, lets the real `saveFile` run
 * against a fake backend, and reads back the bytes the save route was handed.
 *
 * Run: `npx tsx src/views/LibraryView.lineageDownload.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { LibraryEntry } from '../state/libraryEntry';

const ROOT = 'song-root';
const CAP = 600;

const capped = () => ({
  root: ROOT,
  nodes: [{ id: ROOT, kind: 'entry', title: 'Root' }, ...Array.from({ length: CAP - 1 }, (_, i) => ({ id: `c-${i}`, kind: 'external' }))],
  edges: Array.from({ length: CAP - 1 }, (_, i) => ({ from_id: ROOT, to_id: `c-${i}`, kind: 'derived_from' })),
  truncated: true,
  capped: true,
  node_cap: CAP,
});

const whole = () => {
  const nodes = [{ id: ROOT, kind: 'entry', title: 'Root' }, ...Array.from({ length: 900 }, (_, i) => ({ id: `c-${i}`, kind: 'external' }))];
  const edges = Array.from({ length: 900 }, (_, i) => ({ from_id: ROOT, to_id: `c-${i}`, kind: 'derived_from' }));
  return { root: ROOT, depth: 8, nodes, edges, truncated: false, capped: false, node_cap: null, node_count: nodes.length, edge_count: edges.length };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const entry: LibraryEntry = {
  id: ROOT, title: 'Root', prompt: '', negativePrompt: '', model: 'sa3', duration: 10, steps: 8, cfg: 1, seed: 1,
  audioUrl: `/api/library/audio/${ROOT}`, audioFilename: 'root.wav', fileSizeBytes: 1, mimeType: 'audio/wav',
  timestamp: '2026-01-01T00:00:00Z', favorite: false, rating: null, tags: [], notes: '', lyrics: '', source: 'generate',
};

async function main(): Promise<void> {
  // Imported before the jsdom globals exist, so `state/playerStore`'s
  // Vite-only `import.meta.env.DEV` read stays behind its `window` check.
  const { LibraryActionsToolbar } = await import('./LibraryView.tsx');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'window', 'document', 'HTMLElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent',
    'getComputedStyle', 'localStorage', 'navigator',
  ]) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const asked: string[] = [];
  const saved: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    asked.push(url);
    if (url.startsWith(`/api/library/${ROOT}/lineage/full`)) return new Response(JSON.stringify(whole()), { status: 200 });
    if (url.startsWith(`/api/library/${ROOT}/lineage`)) return json(capped());
    if (url === '/api/storage/pick-save') return json({ path: 'C:/exports/Root-lineage.json', cancelled: false, grant: 'g' });
    if (url === '/api/places/save') {
      saved.push(await ((init?.body as FormData).get('file') as Blob).text());
      return json({ path: 'C:/exports/Root-lineage.json' });
    }
    return json({ detail: 'Not Found' }, 404);
  }) as typeof fetch;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  // The global the jsdom window was installed as, typed as the DOM it is.
  const doc = document;
  const root = createRoot(doc.getElementById('root')!);
  const noop = () => {};
  await act(async () =>
    root.render(
      <LibraryActionsToolbar
        selectedEntries={[]}
        selectedCount={0}
        totalCount={1}
        loadedEntries={[entry]}
        maintenanceCounts={null}
        onOptionsOpen={noop}
        onToggleSelectAll={noop}
        onDeleteSelected={noop}
        onFuseSelected={noop}
        onInpaintSelected={noop}
        onFetchMissingCovers={noop}
        onClearNonFavorites={noop}
        onClearAll={noop}
      />,
    ),
  );

  const menuKey = doc.querySelector<HTMLButtonElement>('button[aria-label="Download menu"]');
  assert.ok(menuKey, 'the DOWNLOAD key renders');
  await act(async () => {
    menuKey!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
  });
  const row = Array.from(doc.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) =>
    (el.textContent ?? '').includes('Lineage report'),
  );
  assert.ok(row, `the menu offers Lineage report: ${doc.body.textContent}`);
  await act(async () => {
    row!.click();
  });
  for (let i = 0; i < 10 && saved.length === 0; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  assert.equal(saved.length, 1, `one file was written: ${asked.join(' | ')}`);
  const written = JSON.parse(saved[0]) as { nodes: unknown[]; truncated: boolean };
  assert.equal(written.nodes.length, 901, 'the file holds the whole family, not the first 600');
  assert.equal(written.truncated, false);
  assert.ok(asked.includes(`/api/library/${ROOT}/lineage/full?depth=8`), 'read from the uncapped walk');
  assert.ok(!asked.some((u) => u.startsWith(`/api/library/${ROOT}/lineage?`)), 'never from the capped route');

  await act(async () => root.unmount());
  console.log('LibraryView.lineageDownload: all assertions passed');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
