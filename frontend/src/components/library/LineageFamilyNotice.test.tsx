/**
 * INFO, the asset inspector and the catalogue, on a family larger than the
 * lineage route's cap.
 *
 * The sequence that misled: the panel reads `/lineage`, the backend cuts the
 * family at 600 and says so, and the panel shows "599 after" as if that were
 * the family. These tests mount each panel for real (jsdom, React), let the
 * capped answer land, check the cut is said with a key to load the whole
 * family, press it, and check the whole family replaces the cut one. A read
 * that lands after the panel moved to another song is dropped. A list of
 * relatives draws its first 200 rows and offers the rest, and a new family
 * folds a list the user opened on the old one.
 *
 * Run: `npx tsx src/components/library/LineageFamilyNotice.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { LibraryEntry } from '../../state/libraryEntry';

const ROOT = 'song-root';
const OTHER = 'song-other';
const CAP = 600;
/** The one relative that is a library song, so reading themes fetches it. */
const SONG_CHILD = { id: 'child-0', kind: 'entry', title: 'Child' };

const capped = () => ({
  root: ROOT,
  nodes: [
    { id: ROOT, kind: 'entry', title: 'Root', source: 'generate', duration_sec: 10 },
    SONG_CHILD,
    ...Array.from({ length: CAP - 2 }, (_, i) => ({ id: `child-${i + 1}`, kind: 'external' })),
  ],
  edges: Array.from({ length: CAP - 1 }, (_, i) => ({ from_id: ROOT, to_id: `child-${i}`, kind: 'derived_from' })),
  truncated: true,
  capped: true,
  node_cap: CAP,
});

const whole = (depth: number) => {
  const nodes = [
    { id: ROOT, kind: 'entry', title: 'Root', source: 'generate', duration_sec: 10 },
    SONG_CHILD,
    ...Array.from({ length: 699 }, (_, i) => ({ id: `child-${i + 1}`, kind: 'external' })),
  ];
  const edges = Array.from({ length: 700 }, (_, i) => ({ from_id: ROOT, to_id: `child-${i}`, kind: 'derived_from' }));
  return {
    root: ROOT, depth, nodes, edges, truncated: false, capped: false, node_cap: null,
    node_count: nodes.length, edge_count: edges.length,
  };
};

const small = () => ({
  root: OTHER,
  nodes: [{ id: OTHER, kind: 'entry', title: 'Other' }, { id: 'kid', kind: 'external' }],
  edges: [{ from_id: OTHER, to_id: 'kid', kind: 'derived_from' }],
  truncated: false,
  capped: false,
  node_cap: CAP,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const entryOf = (id: string, title: string): LibraryEntry => ({
  id, title, prompt: '', negativePrompt: '', model: 'sa3', duration: 10, steps: 8, cfg: 1, seed: 1,
  audioUrl: `/api/library/audio/${id}`, audioFilename: `${id}.wav`, fileSizeBytes: 1, mimeType: 'audio/wav',
  timestamp: '2026-01-01T00:00:00Z', favorite: false, rating: null, tags: [], notes: '', lyrics: '',
  source: 'generate',
});

async function main(): Promise<void> {
  // Imported before the jsdom globals exist: `state/playerStore` (reached
  // through the library store) reads the Vite-only `import.meta.env.DEV` only
  // when `window` is defined at import time, the order MixerStrips.b12.test.tsx
  // documents.
  const { useLibraryStore } = await import('../../state/libraryStore.ts');
  const { TrackInfo } = await import('./TrackInfo.tsx');
  const { AssetInspectorModal } = await import('./AssetInspectorModal.tsx');
  const { CatalogueLineage } = await import('../../catalog/CatalogueLineage.tsx');

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const key of [
    'window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'Event',
    'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'localStorage', 'navigator',
  ]) {
    Object.defineProperty(g, key, {
      value: (dom.window as unknown as Record<string, unknown>)[key],
      configurable: true,
      writable: true,
    });
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;

  /** Resolvers for whole-family reads, so a test decides when one lands. */
  const heldWhole: Array<() => void> = [];
  let holdWhole = false;
  /** Resolvers for the entry reads a themes read makes. */
  const heldEntries: Array<() => void> = [];
  let holdEntries = false;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    asked.push(url);
    const full = /^\/api\/library\/([^/]+)\/lineage\/full\?depth=(\d+)$/.exec(url);
    if (full) {
      const reply = () => new Response(JSON.stringify(whole(Number(full[2]))), { status: 200 });
      if (!holdWhole) return reply();
      return new Promise<Response>((resolve) => heldWhole.push(() => resolve(reply())));
    }
    if (url.startsWith('/api/library/entries/')) {
      const reply = () => json({ detail: 'Not Found' }, 404);
      if (!holdEntries) return reply();
      return new Promise<Response>((resolve) => heldEntries.push(() => resolve(reply())));
    }
    if (url.startsWith(`/api/library/${ROOT}/lineage?`)) return json(capped());
    if (url.startsWith(`/api/library/${OTHER}/lineage?`)) return json(small());
    return json({ detail: 'Not Found' }, 404);
  }) as typeof fetch;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;

  useLibraryStore.setState({ entries: [entryOf(ROOT, 'Root'), entryOf(OTHER, 'Other')], loaded: true });

  // The global the jsdom window was installed as, typed as the DOM it is.
  const doc = document;
  const host = doc.getElementById('root')!;
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  const text = () => doc.body.textContent ?? '';
  const loadKey = (): HTMLButtonElement | undefined =>
    Array.from(doc.querySelectorAll('button')).find((b) => /Load the whole family|Loading the whole family/.test(b.textContent ?? ''));
  /** The "Show all N" / "Show the first 200" key of a relatives list. */
  const moreKey = (): HTMLButtonElement | undefined =>
    Array.from(doc.querySelectorAll('button')).find((b) => /^Show (all [\d,]+|the first 200)$/.test(b.textContent ?? ''));
  /** The rows the list a "Show all" key controls draws right now. */
  const rowsOf = (keyEl: HTMLButtonElement): number => {
    const list = doc.getElementById(keyEl.getAttribute('aria-controls') ?? '');
    assert.ok(list, 'the key names the list it opens');
    return list!.children.length;
  };

  // ── INFO: the cut is said, and the whole family replaces it ──────────────
  {
    const root = createRoot(host);
    const props = { stems: [], midis: [], scores: [], onOpenDetails: () => {}, onOpenLineage: () => {}, onSelectEntry: () => {} };
    await act(async () => root.render(<TrackInfo entryId={ROOT} {...props} />));
    await settle();
    assert.ok(text().includes('Showing the nearest 600 of a larger family.'), `INFO says the family was cut: ${text()}`);
    assert.ok(text().includes('0 before · 599 after'), 'the capped counts are what is shown until asked');
    const key = loadKey();
    assert.ok(key, 'with a key to load the whole family');
    assert.equal(key!.getAttribute('type'), 'button');
    assert.ok(!(key!.className.match(/text-\[\d+px\]/)), 'the key reads at 12px or more');

    // Themes read from the capped family first.
    const themesKey = () =>
      Array.from(doc.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes("Read the family's themes"));
    await act(async () => themesKey()!.click());
    await settle();
    assert.ok(text().includes('No prompts or tags across the family yet.'), 'the capped family’s themes were read');

    // The 599 direct relatives draw 200 rows and offer the rest.
    const more = moreKey();
    assert.ok(more, 'a long list offers the rest');
    assert.equal(more!.textContent, 'Show all 599');
    assert.equal(more!.getAttribute('aria-expanded'), 'false');
    assert.equal(rowsOf(more!), 200, 'only the first 200 rows are drawn');
    await act(async () => more!.click());
    await settle();
    assert.equal(rowsOf(moreKey()!), 599, 'the press draws every row');
    assert.equal(moreKey()!.getAttribute('aria-expanded'), 'true');
    assert.equal(moreKey()!.textContent, 'Show the first 200');

    await act(async () => key!.click());
    await settle();
    assert.ok(asked.includes(`/api/library/${ROOT}/lineage/full?depth=4`), 'the whole family is read at the depth INFO shows');
    assert.ok(text().includes('0 before · 700 after'), `the whole family replaces the cut one: ${text()}`);
    assert.ok(text().includes('The whole family is loaded: 701 in all.'));
    assert.ok(!loadKey(), 'and the key has done its job');
    assert.ok(themesKey(), 'themes read from the replaced family are dropped, to be read again from the whole one');
    // The whole family folds the list the user opened on the capped one, so
    // loading it never draws 700 rows at once.
    assert.equal(moreKey()!.textContent, 'Show all 700', 'the whole family’s list is folded');
    assert.equal(rowsOf(moreKey()!), 200);

    // A whole-family read that lands after INFO moved to another song is
    // dropped: the other song's answer stays on screen.
    await act(async () => root.render(<TrackInfo entryId={OTHER} {...props} />));
    await settle();
    await act(async () => root.render(<TrackInfo entryId={ROOT} {...props} />));
    await settle();
    holdWhole = true;
    await act(async () => loadKey()!.click());
    assert.ok(text().includes('Loading the whole family…'), 'the key says it is working');
    await act(async () => root.render(<TrackInfo entryId={OTHER} {...props} />));
    await settle();
    heldWhole.splice(0).forEach((f) => f());
    await settle();
    assert.ok(text().includes('0 before · 1 after'), `the late answer is not shown on another song: ${text()}`);
    assert.ok(!text().includes('The whole family is loaded'), 'nothing about it leaks onto the other song');
    holdWhole = false;

    // Back on the first song, the dropped answer has still ended its press:
    // the key is ready, not stuck on "Loading…", and it works.
    await act(async () => root.render(<TrackInfo entryId={ROOT} {...props} />));
    await settle();
    assert.ok(text().includes('Showing the nearest 600 of a larger family.'), 'the capped family is read again');
    const back = loadKey();
    assert.ok(back, 'the key is offered again');
    assert.equal(back!.textContent, 'Load the whole family', `the key is not stuck working: ${back!.textContent}`);
    assert.equal(back!.disabled, false, 'and it can be pressed');
    await act(async () => back!.click());
    await settle();
    assert.ok(text().includes('The whole family is loaded: 701 in all.'), 'pressing it loads the whole family');
    await act(async () => root.unmount());
  }

  // ── INFO: a themes read still running when the whole family lands ───────
  // Themes pressed on the capped family, the whole family loaded before the
  // entry reads come back: the late themes describe the replaced family and
  // are dropped, so the key to read them from the whole family stays.
  {
    const root = createRoot(host);
    const props = { stems: [], midis: [], scores: [], onOpenDetails: () => {}, onOpenLineage: () => {}, onSelectEntry: () => {} };
    await act(async () => root.render(<TrackInfo entryId={ROOT} {...props} />));
    await settle();
    const themesKey = () =>
      Array.from(doc.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes("Read the family's themes"));
    holdEntries = true;
    await act(async () => themesKey()!.click());
    await settle();
    assert.equal(heldEntries.length, 1, 'the themes read is waiting on the family’s one song');
    await act(async () => loadKey()!.click());
    await settle();
    assert.ok(text().includes('The whole family is loaded: 701 in all.'), 'the whole family landed first');
    heldEntries.splice(0).forEach((f) => f());
    await settle();
    holdEntries = false;
    assert.ok(!text().includes('No prompts or tags across the family yet.'), `the late themes are dropped: ${text().slice(-300)}`);
    assert.ok(themesKey(), 'and the key reads them again from the whole family');
    await act(async () => root.unmount());
  }

  // ── the asset inspector ───────────────────────────────────────────────────
  {
    const root = createRoot(host);
    await act(async () => root.render(<AssetInspectorModal entryId={ROOT} onClose={() => {}} initialTab="lineage" />));
    await settle();
    assert.ok(text().includes('Showing the nearest 600 of a larger family.'), `the inspector says it: ${text().slice(0, 400)}`);
    assert.ok(text().includes('0 before · 599 after'));
    await act(async () => loadKey()!.click());
    await settle();
    assert.ok(text().includes('0 before · 700 after'), 'and loads the whole family on request');
    assert.ok(text().includes('Led to (700)'), 'every direct relative is counted');
    assert.equal(rowsOf(moreKey()!), 200, 'the first 200 are drawn');
    await act(async () => moreKey()!.click());
    await settle();
    assert.equal(rowsOf(moreKey()!), 700, 'and all 700 on request');
    await act(async () => root.unmount());
  }

  // ── the catalogue's lineage block ────────────────────────────────────────
  {
    const root = createRoot(host);
    await act(async () => root.render(<CatalogueLineage entry={entryOf(ROOT, 'Root')} />));
    await settle();
    assert.ok(text().includes('Showing the nearest 600 of a larger family.'), `the catalogue says it: ${text().slice(0, 300)}`);
    assert.ok(text().includes('599 descendants'));
    await act(async () => loadKey()!.click());
    await settle();
    assert.ok(asked.includes(`/api/library/${ROOT}/lineage/full?depth=3`), 'at the depth the catalogue shows');
    assert.ok(text().includes('700 descendants'), `and the whole family replaces it: ${text().slice(0, 300)}`);
    assert.equal(moreKey()!.textContent, 'Show all 700');
    assert.equal(rowsOf(moreKey()!), 200, 'the catalogue draws the first 200 descendants');
    await act(async () => root.unmount());
  }

  // ── a family that fits says nothing ──────────────────────────────────────
  {
    const root = createRoot(host);
    const props = { stems: [], midis: [], scores: [], onOpenDetails: () => {}, onOpenLineage: () => {}, onSelectEntry: () => {} };
    await act(async () => root.render(<TrackInfo entryId={OTHER} {...props} />));
    await settle();
    assert.ok(!text().includes('larger family'), 'no notice for a family that is whole');
    assert.ok(!loadKey());
    await act(async () => root.unmount());
  }

  console.log('LineageFamilyNotice: all assertions passed');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
