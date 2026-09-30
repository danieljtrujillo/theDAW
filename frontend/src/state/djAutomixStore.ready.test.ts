// Run with: npx tsx src/state/djAutomixStore.ready.test.ts
//
// Every way of starting automix registers the active bundled set first, and
// every register caller shares one in-flight guard.
//
// A bundled set lists its tracks with `entryId: null` until it is registered
// (GET /setlists is read-only), and the automix effect sequences entry ids
// only. Only the DJ header's START registered first; the Automix chip, the
// assistant's dj_automix and a set made active on first run started automix
// on the empty list, which stopped at once with "Automix needs an active set
// with ≥2 tracks". The header and the Sets rows each kept their own register
// flag, so one of each pressed together POSTed twice.
import assert from 'node:assert/strict';
import {
  firstPlayableOfActiveSet,
  readyActiveSetForAutomix,
  sendToDjAutomix,
  useDjAutomix,
} from './djAutomixStore.ts';
import { useSetlistStore, type SetlistEntry } from './setlistStore.ts';
import { useLogStore } from './logStore.ts';

const BUNDLED = 'zad-night-ride-9e9e9e9e';
const OTHER = 'zad-sunrise-1a1a1a1a';

const requests: string[] = [];
let gate: Promise<void> | null = null;
let replyStatus = 200;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  requests.push(`${init?.method ?? 'GET'} ${url}`);
  const reg = url.match(/^\/api\/library\/setlists\/([^/]+)\/register$/);
  if (reg) {
    if (gate) await gate;
    if (replyStatus !== 200) return new Response('{}', { status: replyStatus });
    const set = useSetlistStore.getState().setlists[decodeURIComponent(reg[1])];
    return new Response(
      JSON.stringify({
        setlist: { entries: (set?.entries ?? []).map((e, i) => ({ ...e, entryId: `reg-${i}` })) },
      }),
      { status: 200 },
    );
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const pendingRow = (label: string, file: string): SetlistEntry => ({ entryId: null, label, file, kind: 'audio' });
const seed = (entries: SetlistEntry[], id = BUNDLED) => {
  useSetlistStore.setState({
    setlists: {
      [id]: { id, name: 'NIGHT RIDE', entries, createdAt: 1, updatedAt: 1 },
      [OTHER]: { id: OTHER, name: 'SUNRISE', entries: [pendingRow('S1', 's1.wav'), pendingRow('S2', 's2.wav')], createdAt: 1, updatedAt: 1 },
    },
    activeId: id,
  });
};
const registerCalls = () => requests.filter((r) => r.endsWith('/register'));
const reset = () => {
  requests.length = 0;
  gate = null;
  replyStatus = 200;
  useLogStore.setState({ entries: [] });
  useDjAutomix.setState({ pendingStart: null, pendingStop: false, pendingTransition: false });
};
const three = () => [pendingRow('A', 'a.wav'), pendingRow('B', 'b.wav'), pendingRow('C', 'c.wav')];

const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

test('an unregistered bundled set is registered before automix may start', async () => {
  reset();
  seed(three());
  const ready = await readyActiveSetForAutomix();
  assert.deepEqual(registerCalls(), [`POST /api/library/setlists/${BUNDLED}/register`]);
  assert.equal(ready.ok, true, ready.message);
  assert.equal(ready.playable, 3, 'THE BUG: automix found 0 sequenceable tracks in a 3-track set');
});

test('two start paths at once (the header and the Automix chip) share one POST', async () => {
  reset();
  seed(three());
  let open!: () => void;
  gate = new Promise<void>((resolve) => { open = resolve; });
  const header = readyActiveSetForAutomix();
  const chip = readyActiveSetForAutomix();
  const row = useSetlistStore.getState().registerBundled(BUNDLED);
  assert.equal(useSetlistStore.getState().registeringId, BUNDLED, 'the one guard is up while the POST is out');
  open();
  const [a, b, entries] = await Promise.all([header, chip, row]);
  assert.equal(registerCalls().length, 1, 'THE BUG: separate guards let each caller POST');
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(entries?.map((e) => e.entryId), ['reg-0', 'reg-1', 'reg-2']);
  assert.equal(useSetlistStore.getState().registeringId, null, 'and down once it lands');
});

test('the active set changes while the register is out: nothing starts', async () => {
  reset();
  seed(three());
  let open!: () => void;
  gate = new Promise<void>((resolve) => { open = resolve; });
  const pending = readyActiveSetForAutomix();
  useSetlistStore.getState().setActive(OTHER);
  open();
  const ready = await pending;
  assert.equal(ready.ok, false);
  assert.equal(ready.reason, 'changed');
});

test('a failed register does not start, and the log says why once', async () => {
  reset();
  seed(three());
  replyStatus = 500;
  const ready = await readyActiveSetForAutomix();
  assert.equal(ready.ok, false);
  assert.equal(ready.reason, 'failed');
  assert.equal(useLogStore.getState().entries.length, 1);
  assert.equal(useSetlistStore.getState().registeringId, null);
});

test('a set with one playable track is refused with a sentence', async () => {
  reset();
  seed([pendingRow('Only', 'only.wav')]);
  const ready = await readyActiveSetForAutomix();
  assert.equal(ready.ok, false);
  assert.equal(ready.reason, 'too-few');
  assert.match(ready.message, /1 playable track — Auto-DJ needs 2/);
});

test('a registered or local set needs no request', async () => {
  reset();
  seed([{ entryId: 'l1', label: 'x', kind: 'audio' }, { entryId: 'l2', label: 'y', kind: 'audio' }], 'set-1730000000000-1');
  const ready = await readyActiveSetForAutomix();
  assert.equal(ready.ok, true);
  assert.deepEqual(registerCalls(), []);
});

test('master play on an unregistered set registers it and starts from its first track', async () => {
  reset();
  seed(three());
  const first = await firstPlayableOfActiveSet();
  assert.deepEqual(registerCalls(), [`POST /api/library/setlists/${BUNDLED}/register`]);
  assert.equal(first, 'reg-0', 'THE BUG: play found no entry id and did nothing');
});

test('Send to DJ asks for a fresh start; the assistant and the header ask to continue', async () => {
  reset();
  const staged = sendToDjAutomix([{ entryId: 'e1', label: 'one' }, { entryId: 'e2', label: 'two' }]);
  assert.equal(staged, 2);
  assert.equal(useDjAutomix.getState().pendingStart, 'fresh');
  useDjAutomix.getState().consumeStart();
  assert.equal(useDjAutomix.getState().pendingStart, null);
  useDjAutomix.getState().requestStart('continue');
  assert.equal(useDjAutomix.getState().pendingStart, 'continue');
  useDjAutomix.getState().requestStop();
  assert.equal(useDjAutomix.getState().pendingStart, null, 'a stop cancels a start not yet consumed');
});

let failed = 0;
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
