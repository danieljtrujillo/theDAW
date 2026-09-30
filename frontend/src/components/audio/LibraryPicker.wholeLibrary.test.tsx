/**
 * The EDIT library picker, the phone's library tab and the LIBRARY tab's
 * chips, rendered, against a library larger than the pages the LIBRARY tab
 * holds.
 *
 * At 8039b45 the picker and the phone tab filtered `libraryStore.entries` —
 * the loaded pages of the LIBRARY tab's own query — and the favourites / size
 * / duration chips summed those same rows. Each block replays the order a
 * real session produces: the LIBRARY tab loads its first page, then the other
 * surface is opened and asked about a song on no loaded page, or the chips
 * are read while most of the library is still unloaded.
 *
 * Run: `npx tsx src/components/audio/LibraryPicker.wholeLibrary.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const TOTAL = 1000;
const FAR = 777;

const rec = (i: number): Record<string, unknown> => ({
  id: `e${i}`,
  title: i === FAR ? 'Zephyr Harbor' : `Track ${i}`,
  prompt: '',
  negative_prompt: '',
  model: 'sa3',
  duration: 60,
  steps: 8,
  cfg: 1,
  seed: i,
  audio_url: `/api/library/audio/e${i}`,
  audio_filename: `${i}.wav`,
  file_size_bytes: 1000,
  mime_type: 'audio/wav',
  timestamp: '2026-01-01T00:00:00Z',
  favorite: i % 10 === 0,
  rating: null,
  tags: [],
  notes: '',
  source: 'generate',
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
  calls.push(url);
  const u = new URL(url, 'http://local');
  if (u.pathname === '/api/library/summary') {
    return jsonResponse({ revision: 3, counts: { tracks: TOTAL, stems: 0, midi: 0, video: 0, score: 0 } });
  }
  if (u.pathname === '/api/library/entries/stats') {
    // The whole library: 100 favourites, 1000 x 1000 bytes, 1000 x 60 s.
    return jsonResponse({ count: TOTAL, favorites: 100, size_bytes: TOTAL * 1000, duration_sec: TOTAL * 60, revision: 3 });
  }
  if (u.pathname === '/api/library/entries') {
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < TOTAL; i += 1) {
      const r = rec(i);
      if (q && !String(r.title).toLowerCase().includes(q)) continue;
      rows.push(r);
    }
    const offset = Number(u.searchParams.get('offset') ?? '0');
    const limit = Number(u.searchParams.get('limit') ?? '200');
    return jsonResponse({ entries: rows.slice(offset, offset + limit), total: rows.length, offset, limit, revision: 3 });
  }
  return jsonResponse({}, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  // Imported BEFORE the jsdom globals go in: playerStore (reached through the
  // picker's InstrumentPicker) reads `import.meta.env.DEV` behind a
  // `typeof window !== 'undefined'` guard, which must still be false here --
  // the wall MetronomeVolumeControl.test.tsx documents.
  const { useLibraryStore } = await import('../../state/libraryStore.ts');
  const { LibraryPicker } = await import('./LibraryPicker.tsx');
  const { MobileLibrary } = await import('../../mobile/tabs/MobileLibrary.tsx');
  const { LibraryStatsStrip } = await import('../library/LibraryStatsStrip.tsx');
  const { formatDuration, formatSize } = await import('../../lib/libraryFormat.ts');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'getComputedStyle', 'Event', 'KeyboardEvent']) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  const win = dom.window as unknown as { CSS?: { escape?: (s: string) => string }; Element: { prototype: Record<string, unknown> } };
  // jsdom has neither; the picker calls both while it keeps the active row in view.
  g.CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
  win.Element.prototype.scrollIntoView = () => undefined;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;
  const doc = dom.window.document;

  const settle = async (ms: number) => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  // The LIBRARY tab has loaded its first page, as the shell does on boot.
  await useLibraryStore.getState().load();
  assert.equal(useLibraryStore.getState().entries.length, 200);
  assert.ok(!useLibraryStore.getState().entries.some((e) => e.id === `e${FAR}`));

  // ── The EDIT picker finds a song on no loaded page ─────────────────────────
  {
    const host = doc.getElementById('root')!;
    const root = createRoot(host);
    const picks: string[] = [];
    await act(async () => {
      root.render(
        React.createElement(LibraryPicker, {
          open: true,
          tabs: ['audio'],
          onClose: () => undefined,
          onPick: (p) => {
            if (p.kind === 'audio') picks.push(p.entry.id);
          },
        }),
      );
    });
    await settle(50);
    const search = doc.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    assert.ok(search, 'the picker renders its search box');
    calls.length = 0;
    await type(search, 'zephyr');
    await settle(400);
    const options = [...doc.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');
    assert.equal(options.length, 1, `one match over the whole library, got ${JSON.stringify(options)}`);
    assert.ok(options[0].includes('Zephyr Harbor'));
    const asked = calls.map((c) => new URL(c, 'http://local')).find((u) => u.pathname === '/api/library/entries');
    assert.equal(asked?.searchParams.get('q'), 'zephyr', 'the picker asked the backend with its own query');
    assert.equal(asked?.searchParams.get('sort'), 'favorites_first', 'in its own order');
    await act(async () => {
      (doc.querySelector('[role="option"]') as HTMLElement).click();
    });
    await settle(10);
    assert.deepEqual(picks, [`e${FAR}`], 'and picking it hands over that entry');
    // With no query it pages through the whole library, not the 200 rows held.
    await type(search, '');
    await settle(400);
    const footer = doc.body.textContent ?? '';
    assert.ok(footer.includes('of 1,000 tracks'), 'the footer counts the whole library');
    assert.ok(footer.includes('Show more'), 'and offers the rest');
    await act(async () => root.unmount());
  }

  // ── Reopening after a library write asks for the first page once ──────────
  {
    const { useLibraryCounts } = await import('../../state/libraryCountsStore.ts');
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host);
    const render = (open: boolean) =>
      act(async () => {
        root.render(
          React.createElement(LibraryPicker, { open, tabs: ['audio'], onClose: () => undefined, onPick: () => undefined }),
        );
      });
    await render(true);
    await settle(50);
    await render(false);
    await settle(10);
    // A track is generated while the picker is closed.
    await act(async () => {
      useLibraryCounts.setState({ revision: useLibraryCounts.getState().revision + 1 });
    });
    calls.length = 0;
    await render(true);
    await settle(100);
    const lists = calls.filter((c) => new URL(c, 'http://local').pathname === '/api/library/entries');
    assert.equal(lists.length, 1, `one first-page request on reopen, got ${lists.length}`);
    await act(async () => root.unmount());
  }

  // ── The phone's library tab finds it too ───────────────────────────────────
  {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(MobileLibrary));
    });
    await settle(50);
    const search = host.querySelector<HTMLInputElement>('#m-lib-search')!;
    await type(search, 'zephyr');
    await settle(400);
    const titles = [...host.querySelectorAll('.m-row-title')].map((t) => t.textContent);
    assert.deepEqual(titles, ['Zephyr Harbor'], 'the phone searches the whole library');
    await act(async () => root.unmount());
  }

  // ── The chips total the whole query, not the loaded page ──────────────────
  {
    // The strip LibraryView renders, fed the way LibraryView feeds it.
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host);
    const held = useLibraryStore.getState();
    await act(async () => {
      root.render(
        React.createElement(LibraryStatsStrip, {
          total: held.total,
          searchQuery: held.searchQuery,
          loadedRows: held.entries.length,
        }),
      );
    });
    await settle(400);
    const chip = (name: string) => host.querySelector(`[data-stat="${name}"]`)?.textContent;
    // The 200 loaded rows would say 20 favourites, 195 KB and 200:00.
    assert.equal(chip('count'), '1,000');
    assert.equal(chip('favorites'), '100');
    assert.equal(chip('size'), formatSize(TOTAL * 1000));
    assert.equal(chip('size'), '977 KB');
    assert.equal(chip('duration'), formatDuration(TOTAL * 60));
    assert.equal(chip('duration'), '1000:00');
    const favTitle = host.querySelector('[data-stat="favorites"]')?.parentElement?.getAttribute('title');
    assert.equal(favTitle, 'Favorites among every entry in this view');
    await act(async () => root.unmount());
  }

  console.log('LibraryPicker.wholeLibrary: ok');
}

await main();
