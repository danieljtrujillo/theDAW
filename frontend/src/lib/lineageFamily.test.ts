/**
 * Save lineage and the whole-family reader.
 *
 * The sequence that lost data: a song with a family larger than the lineage
 * window's cap, Save lineage chosen from its track menu, and the file on disk
 * holding the first 600 relatives with nothing said. These tests replay it
 * through the real track-menu row and the real `saveFile`, against a fake
 * backend that answers the capped route with 600 and the whole-family route
 * with every relative, and read back the bytes the save route was handed.
 *
 * Run: `npx tsx src/lib/lineageFamily.test.ts`
 */
import assert from 'node:assert/strict';

import {
  EXPORT_LINEAGE_DEPTH,
  WholeWalkMissing,
  describeFamilySize,
  familyFromAnswer,
  readWholeFamily,
  saveWholeLineage,
} from './lineageFamily.ts';
import { runTrackMenuRow, type TrackMenuSubject, type TrackMenuActionContext } from '../components/audio/trackMenuActions.ts';
import type { TrackMenuRow } from '../components/audio/trackMenuModel.ts';
import type { LibraryEntry } from '../state/libraryEntry.ts';
import { useLogStore } from '../state/logStore.ts';

const ROOT = 'song-root';
const CAP = 600;
const FAMILY = 702; // the root, 700 children, one grandchild

const capped = () => ({
  root: ROOT,
  nodes: [
    { id: ROOT, kind: 'entry', title: 'Root', source: 'generate', duration_sec: 10 },
    ...Array.from({ length: CAP - 1 }, (_, i) => ({ id: `child-${i}`, kind: 'external' })),
  ],
  edges: Array.from({ length: CAP - 1 }, (_, i) => ({ from_id: ROOT, to_id: `child-${i}`, kind: 'derived_from' })),
  truncated: true,
  capped: true,
  node_cap: CAP,
});

const wholeBody = () => {
  const nodes = [
    { id: ROOT, kind: 'entry', title: 'Root', source: 'generate', duration_sec: 10 },
    ...Array.from({ length: 700 }, (_, i) => ({ id: `child-${i}`, kind: 'external' })),
    { id: 'grandchild', kind: 'external' },
  ];
  const edges = [
    ...Array.from({ length: 700 }, (_, i) => ({ from_id: ROOT, to_id: `child-${i}`, kind: 'derived_from' })),
    { from_id: 'child-0', to_id: 'grandchild', kind: 'derived_from' },
  ];
  return {
    root: ROOT, depth: EXPORT_LINEAGE_DEPTH, nodes, edges,
    truncated: false, capped: false, node_cap: null,
    node_count: nodes.length, edge_count: edges.length,
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Backend {
  asked: string[];
  saved: Array<{ path: string; text: string }>;
  hasWholeRoute: boolean;
  wholeText?: string;
}

/** A backend with both lineage routes, the Save dialog and the save route. */
const backend = (): Backend & { fetch: typeof fetch } => {
  const state: Backend = { asked: [], saved: [], hasWholeRoute: true };
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    state.asked.push(url);
    if (url.startsWith(`/api/library/${ROOT}/lineage/full`)) {
      if (!state.hasWholeRoute) return json({ detail: 'Not Found' }, 404);
      return new Response(state.wholeText ?? JSON.stringify(wholeBody()), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith(`/api/library/${ROOT}/lineage`)) return json(capped());
    if (url.startsWith('/api/library/nope/lineage/full')) return json({ detail: "entry 'nope' not found" }, 404);
    if (url === '/api/storage/pick-save') return json({ path: 'C:/exports/Root-lineage.json', cancelled: false, grant: 'g1' });
    if (url === '/api/places/save') {
      const form = init?.body as FormData;
      const file = form.get('file') as Blob;
      state.saved.push({ path: String(form.get('path')), text: await file.text() });
      return json({ path: String(form.get('path')) });
    }
    return json({ detail: 'Not Found' }, 404);
  }) as typeof fetch;
  return Object.assign(state, { fetch: impl });
};

// The track menu runs in a browser on the backend's own machine.
(globalThis as { window?: unknown }).window = {
  location: { hostname: 'localhost' },
  confirm: () => true,
  setTimeout,
  clearTimeout,
};

const entry = { id: ROOT, title: 'Root' } as LibraryEntry;
const row: TrackMenuRow = {
  id: 'save-lineage', label: 'Save lineage (.json)', icon: 'network', enabled: true,
  does: 'Save its generation lineage graph as JSON', reason: null, title: '', longJob: false,
  goes: null, danger: false, chip: false, line: null,
};
const subject: TrackMenuSubject = { kind: 'library', label: 'Root', entry, loadedUrl: null } as TrackMenuSubject;
const ctx = {
  audioPath: null, stems: [], lyricsText: '', runningJob: null,
  openLineage: () => {}, openMetaEditor: () => {},
} as unknown as TrackMenuActionContext;

const lastLog = (): string => useLogStore.getState().entries.at(-1)?.msg ?? '';

async function main(): Promise<void> {
  // ── Save lineage from the track menu writes the WHOLE family ─────────────
  {
    const be = backend();
    globalThis.fetch = be.fetch;
    useLogStore.getState().clear();
    await runTrackMenuRow(row, subject, ctx);

    assert.equal(be.saved.length, 1, `one file was written: ${be.asked.join(' | ')}`);
    const written = JSON.parse(be.saved[0].text) as { nodes: unknown[]; edges: unknown[]; truncated: boolean };
    assert.equal(written.nodes.length, FAMILY, 'the saved file holds every relative, not the first 600');
    assert.equal(written.edges.length, FAMILY - 1);
    assert.equal(written.truncated, false);
    assert.ok(
      be.asked.includes(`/api/library/${ROOT}/lineage/full?depth=${EXPORT_LINEAGE_DEPTH}`),
      'the export asked for the uncapped walk at the depth Save lineage always used',
    );
    assert.ok(
      !be.asked.some((u) => u.startsWith(`/api/library/${ROOT}/lineage?`)),
      'and never the capped route',
    );
    const told = useLogStore.getState().entries.map((e) => e.msg).join('\n');
    assert.ok(/LINEAGE: "Root", 1 song, 701 other sources, 701 links, [\d.]+ KB/.test(told), `the size was said: ${told}`);
    assert.ok(
      be.asked.indexOf('/api/storage/pick-save') > be.asked.findIndex((u) => u.includes('/lineage/full')),
      'before the Save dialog opened',
    );
  }

  // ── a backend started before the whole-family route: saved, and said ─────
  {
    const be = backend();
    be.hasWholeRoute = false;
    globalThis.fetch = be.fetch;
    useLogStore.getState().clear();
    const result = await saveWholeLineage(entry, 'Root-lineage.json', { fetchImpl: be.fetch });
    assert.equal(result.cancelled, false);
    assert.equal(be.saved.length, 1, 'the capped answer is still saved');
    assert.equal((JSON.parse(be.saved[0].text) as { nodes: unknown[] }).nodes.length, CAP);
    const told = useLogStore.getState().entries.map((e) => `${e.level} ${e.msg}`).join('\n');
    assert.ok(told.includes('the nearest 600 of a larger family'), `and it says what it holds: ${told}`);
    assert.ok(told.includes('restart theDAW'), 'and how to get the whole family');
    assert.ok(/^warn /m.test(told), 'as a warning');
  }

  // ── a stream that ended early is never saved ─────────────────────────────
  {
    const be = backend();
    const text = JSON.stringify(wholeBody());
    be.wholeText = text.slice(0, Math.floor(text.length / 2));
    globalThis.fetch = be.fetch;
    useLogStore.getState().clear();
    const result = await saveWholeLineage(entry, 'Root-lineage.json', { fetchImpl: be.fetch });
    assert.deepEqual(result, { path: null, cancelled: false, downloaded: false });
    assert.equal(be.saved.length, 0, 'half a family is not written as if it were the file');
    assert.ok(lastLog().includes('cut off before it finished'), lastLog());
    assert.ok(!be.asked.includes('/api/storage/pick-save'), 'and no dialog opened for it');
  }

  // ── the reader on its own ───────────────────────────────────────────────
  {
    const be = backend();
    const read = await readWholeFamily(ROOT, 4, be.fetch);
    assert.equal(read.family.nodes.length, FAMILY);
    assert.equal(read.family.whole, true);
    assert.equal(read.family.capped, false);
    assert.equal(read.family.depth, 4);
    assert.equal(read.bytes, read.blob.size);

    // Counts that disagree with what arrived: not whole, not used.
    const body = wholeBody();
    be.wholeText = JSON.stringify({ ...body, node_count: body.node_count + 1 });
    await assert.rejects(readWholeFamily(ROOT, 4, be.fetch), /does not hold the family it counted/);

    // FastAPI's bare 404 is the missing route; the route's own 404 is a
    // missing song, reported as itself.
    be.hasWholeRoute = false;
    await assert.rejects(readWholeFamily(ROOT, 4, be.fetch), (e: unknown) => e instanceof WholeWalkMissing);
    await assert.rejects(readWholeFamily('nope', 4, be.fetch), /entry 'nope' not found/);
  }

  // ── reading an answer ───────────────────────────────────────────────────
  {
    const c = familyFromAnswer(capped(), 4, false);
    assert.equal(c.capped, true);
    assert.equal(c.truncated, true);
    // Only the depth ran out: truncated, not capped.
    const deep = familyFromAnswer({ nodes: [], edges: [], truncated: true, capped: false }, 4, false);
    assert.equal(deep.capped, false);
    assert.equal(deep.truncated, true);
    // main's backend has no cap and sends neither flag: whole to the depth.
    const main = familyFromAnswer({ root: ROOT, nodes: [{ id: ROOT }], edges: [] }, 4, false);
    assert.equal(main.truncated, false);
    assert.equal(main.capped, false);
    // A build that says truncated without the cause: the whole family is offered.
    assert.equal(familyFromAnswer({ nodes: [], edges: [], truncated: true }, 4, false).capped, true);
    assert.deepEqual(familyFromAnswer(null, 2, false).nodes, []);

    assert.equal(
      describeFamilySize(familyFromAnswer(wholeBody(), 8, true), 2048),
      '1 song, 701 other sources, 701 links, 2.0 KB',
    );
  }

  console.log('lineageFamily: all assertions passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
