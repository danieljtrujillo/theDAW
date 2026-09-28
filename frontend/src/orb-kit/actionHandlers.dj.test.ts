// Run with: npx tsx src/orb-kit/actionHandlers.dj.test.ts
//
// The assistant's DJ actions register a bundled set before anything tries to
// mix it.
//
// dj_load_set made a set active and said "Say dj_automix on to run it";
// dj_automix then asked the DJ tab to start and answered "requested". For a
// bundled set nobody had opened, every row still had `entryId: null`, so the
// DJ tab's automix found nothing to sequence and stopped at once, while the
// model had already been told the set was running.
import assert from 'node:assert/strict';
import { handletheDAWActionResult } from './actionHandlers.ts';
import { useSetlistStore, type SetlistEntry } from '../state/setlistStore.ts';
import { useDjAutomix } from '../state/djAutomixStore.ts';

const BUNDLED = 'zad-night-ride-9e9e9e9e';

const requests: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  requests.push(`${init?.method ?? 'GET'} ${url}`);
  // What the start request saw at the moment the register went out.
  if (url.endsWith('/register')) {
    startAtRegister.push(useDjAutomix.getState().pendingStart);
    const set = useSetlistStore.getState().setlists[BUNDLED];
    return new Response(
      JSON.stringify({ setlist: { entries: set.entries.map((e, i) => ({ ...e, entryId: `reg-${i}` })) } }),
      { status: 200 },
    );
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;
const startAtRegister: Array<string | null> = [];

const row = (label: string): SetlistEntry => ({ entryId: null, label, file: `${label}.wav`, kind: 'audio' });
const seed = (entries: SetlistEntry[], activeId: string | null) => {
  requests.length = 0;
  startAtRegister.length = 0;
  useDjAutomix.setState({ pendingStart: null, pendingStop: false });
  useSetlistStore.setState({
    setlists: { [BUNDLED]: { id: BUNDLED, name: 'Night Ride', entries, createdAt: 1, updatedAt: 1 } },
    activeId,
  });
};
const registerCalls = () => requests.filter((r) => r.endsWith('/register'));

// dj_load_set opens the set: its tracks are registered on the spot.
seed([row('a'), row('b'), row('c')], null);
const loaded = await handletheDAWActionResult({ type: 'dj_load_set', payload: { name: 'night ride' } });
assert.equal(loaded.ok, true, loaded.message);
assert.equal(useSetlistStore.getState().activeId, BUNDLED);
assert.deepEqual(registerCalls(), [`POST /api/library/setlists/${BUNDLED}/register`],
  'THE BUG: dj_load_set never registered the set it made active');
assert.deepEqual(useSetlistStore.getState().setlists[BUNDLED].entries.map((e) => e.entryId), ['reg-0', 'reg-1', 'reg-2']);

// dj_automix on an unregistered active set: register first, THEN request.
seed([row('a'), row('b'), row('c')], BUNDLED);
const started = await handletheDAWActionResult({ type: 'dj_automix', payload: { on: true } });
assert.equal(started.ok, true, started.message);
assert.deepEqual(registerCalls(), [`POST /api/library/setlists/${BUNDLED}/register`],
  'THE BUG: dj_automix started automix on a set with no entry ids');
assert.deepEqual(startAtRegister, [null], 'the start request went out only after the register');
assert.equal(useDjAutomix.getState().pendingStart, 'continue', 'a playing deck keeps playing');
assert.match(started.message, /3 playable tracks/);

// A bundled set with one playable file: the register runs (library entries
// written, the set's ids patched) and then automix cannot start. The app DID
// change, so the answer is not ok:false ("the app is UNCHANGED"), and it says
// both what was registered and why nothing is playing.
seed([row('only')], BUNDLED);
const refused = await handletheDAWActionResult({ type: 'dj_automix', payload: { on: true } });
assert.deepEqual(registerCalls(), [`POST /api/library/setlists/${BUNDLED}/register`], 'setup: the register ran');
assert.deepEqual(useSetlistStore.getState().setlists[BUNDLED].entries.map((e) => e.entryId), ['reg-0']);
assert.equal(refused.ok, true, 'THE BUG: a register that wrote entries was reported as no change');
assert.match(refused.message, /Registered the tracks of "Night Ride", but automix did not start/);
assert.match(refused.message, /Auto-DJ needs 2/);
assert.equal(useDjAutomix.getState().pendingStart, null, 'nothing was requested');

// The same set once registered: nothing is written this time, so ok:false
// really does mean unchanged.
const again = await handletheDAWActionResult({ type: 'dj_automix', payload: { on: true } });
assert.equal(registerCalls().length, 1, 'no second register');
assert.equal(again.ok, false);
assert.match(again.message, /^Automix not started: .*Auto-DJ needs 2/);
assert.equal(useDjAutomix.getState().pendingStart, null);

// The user switches sets while the register is out: the register still wrote
// (ok:true), and automix does not start the set they left.
seed([row('a'), row('b')], BUNDLED);
const OTHER = 'my-own-set';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  useSetlistStore.setState((s) => ({
    setlists: { ...s.setlists, [OTHER]: { id: OTHER, name: 'Mine', entries: [], createdAt: 1, updatedAt: 1 } },
    activeId: OTHER,
  }));
  return realFetch(input, init);
}) as typeof fetch;
const switched = await handletheDAWActionResult({ type: 'dj_automix', payload: { on: true } });
globalThis.fetch = realFetch;
assert.equal(switched.ok, true, switched.message);
assert.match(switched.message, /Registered the tracks of "Night Ride", but automix did not start: The active set changed/);
assert.equal(useDjAutomix.getState().pendingStart, null);

// Stop is unchanged and synchronous.
const stopped = handletheDAWActionResult({ type: 'dj_automix', payload: { on: false } });
assert.equal((stopped as { ok: boolean }).ok, true);
assert.equal(useDjAutomix.getState().pendingStop, true);

console.log('actionHandlers.dj: ok');
