// Run with: npx tsx src/state/setlistStore.importBundled.test.ts
//
// Upgrading from main never shows a bundled set twice.
//
// Main hashed a bundled set's id over its entry dicts; this build hashes the
// timeline (file, label, cue points), so every Z-AutoDJ set main had saved in
// the browser comes back from GET /setlists under a new id. `importBundled`
// used to add every id it did not hold and never retire one, so each set
// showed twice: main's copy and the same set again. The listing now names the
// id main gave the folder (`legacyIds`), and the import retires it, carrying
// the active-set choice and the user's edits over to the new id.
//
// The browser storage is seeded in main's persisted shape BEFORE the store is
// imported, so the store hydrates exactly what main wrote.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const STORAGE_KEY = 'thedaw.setlists.v1';
const OLD = 'zad-night-ride-0ld0ld00';
const NEW = 'zad-night-ride-9e9e9e9e';
const MTIME = 1_758_000_000_000;

type Entry = { entryId: string | null; label: string; kind: 'audio'; file?: string; perf?: Record<string, number> };

/** What main's listing handed its importBundled for the folder: every track
 *  registered, no file names. */
const mainEntries: Entry[] = [
  { entryId: 'lib-1', label: 'Intro', kind: 'audio', perf: { cueIn: 0, mixOut: 30 } },
  { entryId: 'lib-2', label: 'Drop', kind: 'audio', perf: { cueIn: 1, mixOut: 31 } },
  { entryId: 'lib-3', label: 'Outro', kind: 'audio' },
];
const mainSet = (overrides: Record<string, unknown> = {}) => ({
  id: OLD,
  name: 'NIGHT RIDE',
  entries: mainEntries,
  createdAt: MTIME,
  updatedAt: MTIME,
  notes: 'Imported performance set (Z-AutoDJ)',
  ...overrides,
});

// ── main wrote this ──────────────────────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.localStorage = dom.window.localStorage;
dom.window.localStorage.setItem(
  STORAGE_KEY,
  JSON.stringify({ state: { setlists: { [OLD]: mainSet() }, activeId: OLD }, version: 0 }),
);

const { useSetlistStore } = await import('./setlistStore.ts');
const { useLogStore } = await import('./logStore.ts');

/** This build's listing for the same folder: the new id, the id main gave
 *  it, and file names on every row. */
const listing = (entries: Entry[] = mainEntries.map((e, i) => ({ ...e, file: `t${i + 1}.wav` }))) => ({
  setlists: [
    {
      id: NEW,
      legacyIds: [OLD],
      name: 'NIGHT RIDE',
      entries,
      createdAt: MTIME,
      updatedAt: MTIME,
      notes: 'Imported performance set (Z-AutoDJ)',
    },
  ],
});

let answer: () => unknown = () => listing();
const requests: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  requests.push(`${init?.method ?? 'GET'} ${url}`);
  if (url === '/api/library/setlists') return new Response(JSON.stringify(answer()), { status: 200 });
  const reg = url.match(/^\/api\/library\/setlists\/([^/]+)\/register$/);
  if (reg) {
    const setlist = listing().setlists[0];
    return new Response(
      JSON.stringify({ setlist: { ...setlist, entries: setlist.entries.map((e, i) => ({ ...e, entryId: `reg-${i}` })) } }),
      { status: 200 },
    );
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const ids = () => Object.keys(useSetlistStore.getState().setlists).sort();
const stored = () => JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY) ?? '{}') as {
  state: { setlists: Record<string, unknown>; activeId: string | null } & Record<string, unknown>;
};
const registerCalls = () => requests.filter((r) => r.startsWith('POST') && r.endsWith('/register'));

/** Main's importBundled, transcribed from upstream/main
 *  frontend/src/state/setlistStore.ts: adds every id it lacks, never
 *  retires one. Run on the same storage, it is "main again". */
const mainImportBundled = (incoming: Array<ReturnType<typeof mainSet>>) => {
  useSetlistStore.setState((s) => {
    const next = { ...s.setlists };
    let added = false;
    for (const raw of incoming) {
      if (!raw?.id || next[raw.id]) continue;
      next[raw.id] = {
        id: raw.id,
        name: raw.name || 'Imported Set',
        entries: Array.isArray(raw.entries) ? raw.entries : [],
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        notes: raw.notes || '',
      };
      added = true;
    }
    if (!added) return s;
    return { setlists: next, activeId: s.activeId ?? incoming[0]?.id ?? null };
  });
};

let failed = 0;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

test("main's untouched copy is retired: one set, under the new id, still active", async () => {
  assert.deepEqual(ids(), [OLD], 'hydrated exactly what main stored');
  await useSetlistStore.getState().importBundled();
  assert.deepEqual(ids(), [NEW], 'THE BUG: the upgrade showed the set twice');
  assert.equal(useSetlistStore.getState().activeId, NEW, 'the active choice followed the set');
  const set = useSetlistStore.getState().setlists[NEW];
  assert.deepEqual(set.entries.map((e) => e.file), ['t1.wav', 't2.wav', 't3.wav']);
  assert.deepEqual(set.entries.map((e) => e.entryId), ['lib-1', 'lib-2', 'lib-3']);
  // What goes back to storage: the same two keys every build has written.
  assert.deepEqual(Object.keys(stored().state).sort(), ['activeId', 'setlists']);
  assert.deepEqual(Object.keys(stored().state.setlists), [NEW]);
  assert.deepEqual(registerCalls(), [], 'every row already had its id; nothing to register');
});

test('main again, then this build again: this build still shows the set once', async () => {
  // Main lists the folder under its own id and adds it back, because its
  // import adds every id it lacks. Main then shows two rows: its code, which
  // this build cannot change.
  mainImportBundled([mainSet()]);
  assert.deepEqual(ids(), [OLD, NEW].sort());
  // Back on this build: main's re-added copy is untouched, so it retires.
  await useSetlistStore.getState().importBundled();
  assert.deepEqual(ids(), [NEW]);
  assert.equal(useSetlistStore.getState().activeId, NEW);
});

test('a copy the user edited on main keeps every edit under the new id', async () => {
  // Main's user renamed the set, moved Outro to the top, dropped Drop, and
  // dragged one of their own tracks in.
  useSetlistStore.setState({
    setlists: {
      [OLD]: mainSet({
        name: 'NIGHT RIDE (my cut)',
        entries: [mainEntries[2], { entryId: 'mine-9', label: 'My track', kind: 'audio' }, mainEntries[0]],
        updatedAt: MTIME + 5_000,
        notes: 'warehouse',
      }) as never,
    },
    activeId: OLD,
  });
  await useSetlistStore.getState().importBundled();
  assert.deepEqual(ids(), [NEW]);
  const set = useSetlistStore.getState().setlists[NEW];
  assert.equal(set.name, 'NIGHT RIDE (my cut)');
  assert.equal(set.notes, 'warehouse');
  assert.equal(set.updatedAt, MTIME + 5_000, 'the edit time is the user\'s, not the import\'s');
  assert.deepEqual(
    set.entries.map((e) => [e.label, e.entryId, e.file ?? null]),
    [
      ['Outro', 'lib-3', 't3.wav'],
      ['My track', 'mine-9', null],
      ['Intro', 'lib-1', 't1.wav'],
    ],
    'order, removal and own track kept; bundled rows got their file names',
  );
  assert.equal(useSetlistStore.getState().activeId, NEW);
});

test('both copies edited: neither is dropped', async () => {
  useSetlistStore.setState({
    setlists: {
      [OLD]: mainSet({ name: 'edited on main', updatedAt: MTIME + 1 }) as never,
      [NEW]: { ...listing().setlists[0], name: 'edited here', updatedAt: MTIME + 2 } as never,
    },
    activeId: NEW,
  });
  await useSetlistStore.getState().importBundled();
  assert.deepEqual(ids(), [OLD, NEW].sort());
  assert.equal(useSetlistStore.getState().setlists[OLD].name, 'edited on main');
  assert.equal(useSetlistStore.getState().setlists[NEW].name, 'edited here');
});

test('a browser that already ran the unfixed build: the untouched old copy goes', async () => {
  useSetlistStore.setState({
    setlists: { [OLD]: mainSet() as never, [NEW]: listing().setlists[0] as never },
    activeId: OLD,
  });
  await useSetlistStore.getState().importBundled();
  assert.deepEqual(ids(), [NEW]);
  assert.equal(useSetlistStore.getState().activeId, NEW);
});

test('first run: the bundled set made active is registered once, and never twice', async () => {
  requests.length = 0;
  useSetlistStore.setState({ setlists: {}, activeId: null });
  useLogStore.setState({ entries: [] });
  // A fresh install: nothing registered, every row entryId null.
  answer = () => ({ setlists: [{ ...listing().setlists[0], legacyIds: [], entries: listing().setlists[0].entries.map((e) => ({ ...e, entryId: null })) }] });
  await useSetlistStore.getState().importBundled();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(useSetlistStore.getState().activeId, NEW);
  assert.deepEqual(registerCalls(), [`POST /api/library/setlists/${NEW}/register`],
    'THE BUG: the first-run active set stayed unregistered, so the Automix chip and the assistant stopped at once');
  assert.deepEqual(useSetlistStore.getState().setlists[NEW].entries.map((e) => e.entryId), ['reg-0', 'reg-1', 'reg-2']);
  assert.equal(useSetlistStore.getState().registeringId, null, 'the guard clears when the register lands');
  // The DJ tab mounts again: nothing new, nothing re-registered.
  await useSetlistStore.getState().importBundled();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(registerCalls().length, 1);
  assert.deepEqual(ids(), [NEW]);
});

for (const [name, run] of cases) {
  try {
    await run();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(err);
  }
}
console.log(`${cases.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
