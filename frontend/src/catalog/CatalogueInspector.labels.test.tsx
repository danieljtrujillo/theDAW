/**
 * The catalogue inspector's type and labels, on a track that fills every
 * section.
 *
 * The inspector titled each section (PROMPT, LINEAGE, TAGS, NOTES, ...) with
 * a 9px mono label, set its fields and keys at 8-9px mono, left its tag and
 * notes fields without a label, and its star/like/dislike keys without a
 * name. This test mounts it for real (jsdom, React) on a Suno track with a
 * prompt, lyrics, analysis, embedded tags and a lineage, lets the lineage
 * land, makes the spectrogram fail so its error shows, and then checks every
 * element: nothing under 12px or in the small mono styles, every field
 * labelled, every key named, and the view keys report which one is pressed.
 *
 * Run: `npx tsx src/catalog/CatalogueInspector.labels.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { LibraryEntry } from '../state/libraryEntry';

const ID = 'song-suno';

const entry = {
  id: ID, title: 'Glass Tide', prompt: 'slow tide, glass bells', negativePrompt: 'distortion',
  model: 'suno', duration: 10, steps: 8, cfg: 1, seed: 1,
  audioUrl: `/api/library/audio/${ID}`, audioFilename: `${ID}.wav`, fileSizeBytes: 1, mimeType: 'audio/wav',
  timestamp: '2026-01-01T00:00:00Z', favorite: false, rating: null, tags: ['ambient'], notes: 'keep',
  lyrics: 'the tide comes in', source: 'suno',
  analysis: { bpm: 90, key: 'D minor' },
  embeddedTags: { artist: 'Nobody' },
} as unknown as LibraryEntry;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Font sizes below 12px that an element may not carry. */
const SMALL = /(^|\s)(text-\[(?:[0-9]|1[01])px\]!?|mono-label|mono-tag|font-mono)(\s|$)/;

async function main(): Promise<void> {
  // Imported before the jsdom globals exist, the order
  // LineageFamilyNotice.test.tsx documents (`state/playerStore` reads the
  // Vite-only `import.meta.env.DEV` only when `window` exists at import).
  const { useLibraryStore } = await import('../state/libraryStore.ts');
  const { CatalogueInspector } = await import('./CatalogueInspector.tsx');

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

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    if (url.startsWith(`/api/library/${ID}/lineage?`)) {
      return json({
        root: ID,
        nodes: [{ id: ID, kind: 'entry', title: 'Glass Tide' }, { id: 'kid', kind: 'external' }],
        edges: [{ from_id: ID, to_id: 'kid', kind: 'derived_from' }],
        truncated: false, capped: false, node_cap: 600,
      });
    }
    return json({ detail: 'Not Found' }, 404);
  }) as typeof fetch;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;

  useLibraryStore.setState({
    entries: [entry],
    loaded: true,
    fetchAudioBlob: async () => {
      throw new Error('audio unavailable');
    },
  });

  const doc = document;
  const host = doc.getElementById('root')!;
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  const buttons = () => Array.from(doc.querySelectorAll('button'));
  const named = (b: Element) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();

  const root = createRoot(host);
  await act(async () => root.render(<CatalogueInspector entry={entry} />));
  await settle();
  const generate = buttons().find((b) => named(b) === 'GENERATE');
  assert.ok(generate, 'the spectrogram key is shown');
  await act(async () => generate!.click());
  await settle();
  assert.ok((doc.body.textContent ?? '').includes('audio unavailable'), 'the spectrogram error shows');

  // Every section title is there, at 12px bold sans.
  for (const title of ['PROMPT', 'NEGATIVE', 'SUNO', 'ANALYSIS', 'EMBEDDED TAGS', 'SPECTROGRAM', 'LINEAGE', 'TAGS', 'NOTES']) {
    const el = Array.from(doc.querySelectorAll('span, label')).find((s) => s.textContent === title);
    assert.ok(el, `the ${title} section is titled`);
    assert.match(el!.className, /(^|\s)text-xs(\s|$)/, `${title} reads at 12px: ${el!.className}`);
    assert.match(el!.className, /(^|\s)font-bold(\s|$)/, `${title} is bold`);
  }

  // Nothing anywhere in the inspector is under 12px or in the small mono styles.
  const small = Array.from(host.querySelectorAll('*'))
    .map((el) => el.getAttribute('class') ?? '')
    .filter((c) => SMALL.test(c));
  assert.deepEqual(small, [], `small or mono type left in the inspector: ${small.join(' | ')}`);

  // Every native field has an id, a name and a label that points at it.
  for (const field of Array.from(host.querySelectorAll('input, textarea, select'))) {
    const id = field.getAttribute('id');
    assert.ok(id, `a ${field.tagName} has an id`);
    assert.ok(field.getAttribute('name'), `#${id} has a name`);
    assert.ok(host.querySelector(`label[for="${id}"]`), `#${id} has a label`);
  }

  // Every key has a name, and the icon keys say whether they are on.
  for (const b of buttons()) assert.ok(named(b), `a key has no name: ${b.outerHTML.slice(0, 120)}`);
  for (const name of ['Favorite', 'Like', 'Dislike']) {
    const b = buttons().find((x) => x.getAttribute('aria-label') === name);
    assert.ok(b, `the ${name} key is named`);
    assert.equal(b!.getAttribute('aria-pressed'), 'false', `${name} says it is off`);
  }
  assert.ok(buttons().find((b) => b.getAttribute('aria-label') === 'Remove tag ambient'), 'a tag key names its tag');

  await act(async () => root.unmount());
  console.log('CatalogueInspector.labels: all assertions passed');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
