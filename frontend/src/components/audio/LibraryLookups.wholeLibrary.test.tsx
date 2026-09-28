/**
 * The other library pickers — the MIDI panel's song box, the Metamorph A/B
 * lists, the lyric studio's song picker, the Nodefi library field and the
 * Nodefi live sets — rendered, against a library larger than the pages the
 * LIBRARY tab holds.
 *
 * At 8039b45 each of them read `libraryStore.entries`, the loaded pages of the
 * LIBRARY tab's own query. Every block replays the order a real session
 * produces: the LIBRARY tab loads its first page (200 of 1,000 songs), then
 * the other surface is opened and asked about a song on no loaded page.
 *
 * Run: `npx tsx src/components/audio/LibraryLookups.wholeLibrary.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const TOTAL = 1000;
const FAR = 777;
/** The Nodefi set "Will I Dream" names this entry id. */
const DREAM_ID = '22fd324b5f404689a196529454925777';

const rec = (i: number): Record<string, unknown> => ({
  id: i === FAR + 1 ? DREAM_ID : `e${i}`,
  title: i === FAR ? 'Zephyr Harbor' : i === FAR + 1 ? 'Will I Dream (final)' : `Track ${i}`,
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
  favorite: false,
  rating: null,
  tags: [],
  notes: '',
  source: 'generate',
});

const all = Array.from({ length: TOTAL }, (_, i) => rec(i));

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
    return jsonResponse({ count: TOTAL, favorites: 0, size_bytes: TOTAL * 1000, duration_sec: TOTAL * 60, revision: 3 });
  }
  if (u.pathname === '/api/library/entries') {
    const q = (u.searchParams.get('q') ?? '').toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const rows = all.filter((r) => words.every((w) => String(r.title).toLowerCase().includes(w)));
    const offset = Number(u.searchParams.get('offset') ?? '0');
    const limit = Number(u.searchParams.get('limit') ?? '200');
    return jsonResponse({ entries: rows.slice(offset, offset + limit), total: rows.length, offset, limit, revision: 3 });
  }
  const one = u.pathname.match(/^\/api\/library\/entries\/([^/]+)$/);
  if (one) {
    const hit = all.find((r) => r.id === decodeURIComponent(one[1]));
    return hit ? jsonResponse(hit) : jsonResponse({ detail: 'not found' }, 404);
  }
  return jsonResponse({}, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  // Imported BEFORE the jsdom globals go in (see LibraryPicker.wholeLibrary.test.tsx).
  const { useLibraryStore } = await import('../../state/libraryStore.ts');
  const { MetamorphPanel } = await import('./MetamorphPanel.tsx');
  const { DocumentRail } = await import('../layout/lyricstudio/DocumentRail.tsx');
  const { NodefiInspector } = await import('../nodefi/NodefiInspector.tsx');
  const { useNodefiStore } = await import('../../state/nodefiStore.ts');
  const { NODEFI_TEMPLATES, resolveTemplateSource } = await import('../../data/nodefiTemplates.ts');
  const { findTemplateSource } = await import('../../lib/nodefiTemplateSource.ts');

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element', 'Node', 'getComputedStyle', 'Event', 'KeyboardEvent', 'PointerEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  // jsdom has no layout observer; the MIDI panel's strip watches its width.
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
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
  const mount = async (el: React.ReactElement) => {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(el);
    });
    await settle(50);
    return { host, unmount: () => act(async () => root.unmount()) };
  };
  const optionTexts = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent ?? '');

  // The LIBRARY tab has loaded its first page, as the shell does on boot.
  await useLibraryStore.getState().load();
  const held = useLibraryStore.getState().entries;
  assert.equal(held.length, 200);
  assert.ok(!held.some((e) => e.id === `e${FAR}` || e.id === DREAM_ID), 'both songs are on no loaded page');

  // ── Metamorph: the A/B lists search the whole library ──────────────────────
  {
    const { host, unmount } = await mount(React.createElement(MetamorphPanel));
    await type(host.querySelector<HTMLInputElement>('#morph-find')!, 'zephyr');
    await settle(400);
    const donor = host.querySelector<HTMLSelectElement>('#morph-donor')!;
    assert.ok(optionTexts(donor).includes('Zephyr Harbor'), `A offers the far song: ${JSON.stringify(optionTexts(donor))}`);
    assert.ok(optionTexts(host.querySelector<HTMLSelectElement>('#morph-host')!).includes('Zephyr Harbor'));
    await unmount();
  }

  // ── Lyric studio: the song picker searches the whole library ───────────────
  {
    const { host, unmount } = await mount(React.createElement(DocumentRail));
    const fileKey = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('File'))!;
    await act(async () => fileKey.click());
    await settle(50);
    const find = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    assert.ok(find, 'the File panel has a song search');
    const label = host.querySelector(`label[for="${find.id}"]`);
    assert.equal(label?.textContent, 'Find a song');
    await type(find, 'zephyr');
    await settle(400);
    const song = [...host.querySelectorAll('select')].find((s) => s.id.startsWith('lyric-studio-song-'))!;
    assert.deepEqual(optionTexts(song), ['Zephyr Harbor']);
    assert.equal(song.value, `e${FAR}`, 'and the song moves act on it');
    await unmount();
  }

  // ── Nodefi: the Library node's field searches the whole library ────────────
  {
    const store = useNodefiStore.getState();
    const nodeId = store.addNode('input', 0, 0);
    useNodefiStore.getState().select(nodeId);
    const { host, unmount } = await mount(React.createElement(NodefiInspector));
    const find = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    assert.ok(find, 'the Library node has a song search');
    await type(find, 'zephyr');
    await settle(400);
    const select = host.querySelector<HTMLSelectElement>(`select[id="${find.id.replace(/-find$/, '')}"]`)!;
    assert.ok(optionTexts(select).includes('Zephyr Harbor'), JSON.stringify(optionTexts(select)));
    // A song already picked keeps its title when the search moves on.
    await act(async () => useNodefiStore.getState().updateParam(nodeId, 'libraryId', `e${FAR}`));
    await type(find, 'track 1');
    await settle(400);
    assert.equal(select.value, `e${FAR}`);
    assert.ok(optionTexts(select).includes('Zephyr Harbor'), 'the picked song is still offered');
    await unmount();
  }

  // ── Nodefi live sets: the source song resolves over the whole library ──────
  {
    const dream = NODEFI_TEMPLATES.find((t) => t.id === 'set-will-i-dream')!;
    // What 8039b45 did: look through the loaded rows only.
    assert.equal(resolveTemplateSource(dream, useLibraryStore.getState().entries), null);
    const found = await findTemplateSource(dream);
    assert.equal(found?.id, DREAM_ID, 'found by its id');
    // By title when the id is not in this library.
    const byTitle = await findTemplateSource({ ...dream, source: { titleQuery: 'zephyr harbor' } });
    assert.equal(byTitle?.id, `e${FAR}`);
    assert.equal(await findTemplateSource({ ...dream, source: { titleQuery: 'not a song here' } }), null);
  }

  // ── MIDI panel: the song box searches the whole library ────────────────────
  {
    const { MidiPanel } = await import('../layout/MidiPanel.tsx');
    const { host, unmount } = await mount(React.createElement(MidiPanel));
    const box = host.querySelector<HTMLInputElement>('#midi-asset-id')!;
    assert.ok(box, 'the song box renders');
    await act(async () => {
      box.dispatchEvent(new dom.window.Event('focus', { bubbles: true }));
      box.focus();
    });
    await type(box, 'zephyr');
    await settle(400);
    const options = [...host.querySelectorAll('#midi-asset-listbox [role="option"]')].map((o) => o.textContent ?? '');
    assert.equal(options.length, 1, JSON.stringify(options));
    assert.ok(options[0].includes('Zephyr Harbor'));
    await unmount();
  }

  console.log('LibraryLookups.wholeLibrary: ok');
}

await main();
